/**
 * Explicit, real-account compatibility probe for Cafe desktop dynamic tools.
 *
 * Run with CAFE_RUN_CODEX_DESKTOP_PROBE=1 and the repository-pinned Node. This
 * intentionally stays off the default test path: it starts real Codex processes
 * and makes small paid model requests. Credentials are copied into a private
 * temporary home, never symlinked, printed, or passed through process arguments.
 * Only capability outcomes are printed; provider output remains in memory.
 */
import { execFileSync } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Client from "../../src/client.ts";
import * as CodexSchema from "../../src/schema.ts";
import * as CodexErrors from "../../src/errors.ts";
import type { V2ThreadStartParams__DynamicToolSpec } from "../../src/schema.ts";
const decodeToolResponse = Schema.decodeUnknownSync(CodexSchema.DynamicToolCallResponse);
const decodeThreadStart = Schema.decodeUnknownSync(CodexSchema.V2ThreadStartResponse);

type Message = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number };
};
let phase = "starting";

const chunk = (name: string, data: Buffer) => {
  const payload = Buffer.concat([Buffer.from(name), data]);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  payload.copy(result, 4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
};

const tool = (name: string) =>
  ({
    type: "function",
    name,
    description: "Read the Cafe compatibility-test observation.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }) satisfies V2ThreadStartParams__DynamicToolSpec;

function fixtureImage(): string {
  // Independently generated test pixels, never a screenshot of the user's host.
  const width = 160;
  const height = 100;
  const pixels = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    pixels[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const color =
        (x - 40) ** 2 + (y - 50) ** 2 < 28 ** 2
          ? [145, 35, 200]
          : x > 95 && x < 145 && y > 23 && y < 77
            ? [25, 190, 40]
            : [255, 255, 255];
      for (let c = 0; c < 3; c++) pixels[y * (width * 3 + 1) + 1 + x * 3 + c] = color[c]!;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return `data:image/png;base64,${Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64")}`;
}

function startClient(binary: string, probeHome: string, cwd: string) {
  const listeners = new Set<(message: Message) => void>();
  const responses = new Map<string | number, (message: Message) => void>();
  const dispatch = (message: Message) => {
    for (const listener of listeners) listener(message);
  };
  // Use Cafe's real typed client and finite 64 MiB protocol boundary. Only this
  // opt-in probe bridges its typed callbacks into a small in-memory test driver.
  const runtime = ManagedRuntime.make(
    Client.layerCommand({
      command: binary,
      args: [
        "app-server",
        "--stdio",
        ...(process.env.CAFE_PROBE_DISABLE_CODE_MODE_HOST === "1"
          ? ["-c", "features.code_mode_host=false"]
          : []),
      ],
      cwd,
      env: { CODEX_HOME: probeHome },
      logIncoming: false,
      logOutgoing: false,
      onTermination: () => Effect.sync(() => dispatch({ method: "probe/processExited" })),
    }).pipe(Layer.provide(NodeServices.layer)),
  );
  const ready = runtime.runPromise(
    Effect.gen(function* () {
      const client = yield* Client.CodexAppServerClient;
      yield* client.handleServerRequest("item/tool/call", (params, context) =>
        Effect.callback<CodexSchema.DynamicToolCallResponse, CodexErrors.CodexAppServerError>(
          (resume) => {
            const id = context?.requestId;
            if (id === undefined) {
              resume(
                Effect.fail(
                  new CodexErrors.CodexAppServerProtocolParseError({
                    detail: "Probe callback missing request identity",
                  }),
                ),
              );
              return;
            }
            responses.set(id, (message) => {
              responses.delete(id);
              try {
                resume(Effect.succeed(decodeToolResponse(message.result)));
              } catch {
                resume(
                  Effect.fail(
                    new CodexErrors.CodexAppServerProtocolParseError({
                      detail: "Invalid probe response",
                    }),
                  ),
                );
              }
            });
            dispatch({ id, method: "item/tool/call", params });
            return Effect.sync(() => {
              responses.delete(id);
            });
          },
        ),
      );
      for (const method of [
        "item/agentMessage/delta",
        "item/completed",
        "turn/completed",
      ] as const) {
        yield* client.handleServerNotification(method, (params) =>
          Effect.sync(() => dispatch({ method, params })),
        );
      }
      return client;
    }),
  );
  const request = async (method: string, params: Record<string, unknown>) => {
    phase = method;
    const client = await ready;
    return (await runtime.runPromise(client.raw.request(method, params))) as Record<
      string,
      unknown
    >;
  };
  const send = (message: Message) => {
    if (message.id !== undefined) responses.get(message.id)?.(message);
  };
  return {
    request,
    async initialize() {
      const client = await ready;
      await runtime.runPromise(
        client.request("initialize", {
          clientInfo: { name: "cafe-desktop-probe", version: "1" },
          capabilities: { experimentalApi: true },
        }),
      );
      await runtime.runPromise(client.notify("initialized", undefined));
    },
    async turn(threadId: string, tool: string, image: boolean, directImage = false) {
      const calls: string[] = [];
      let answer = "";
      let failed = false;
      const outputTypes: string[] = [];
      let finish: (() => void) | undefined;
      let fail: ((error: Error) => void) | undefined;
      const completed = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const listener = (message: Message) => {
        const params = message.params ?? {};
        if (message.method === "item/tool/call") {
          if (message.id === undefined) {
            fail?.(new Error("Probe callback omitted its request id"));
            return;
          }
          const requestId = message.id;
          if (params.threadId !== threadId || calls.length >= 8) {
            fail?.(new Error("Probe callback outside its bounded thread scope"));
            return;
          }
          const name = params.namespace
            ? `${String(params.namespace)}.${String(params.tool)}`
            : String(params.tool);
          calls.push(name);
          const reply = () =>
            send({
              id: requestId,
              result: {
                success: name === tool,
                contentItems: image
                  ? [
                      { type: "inputText", text: "The test observation is the attached image." },
                      { type: "inputImage", imageUrl: fixtureImage() },
                    ]
                  : [{ type: "inputText", text: "The observation code is apricot-482." }],
              },
            });
          if (image && process.env.CAFE_PROBE_IMAGE_VIA_STEER === "1") {
            void request("turn/steer", {
              threadId,
              expectedTurnId: params.turnId,
              input: [
                {
                  type: "text",
                  text: "This image is the requested tool observation. Describe it as requested.",
                },
                { type: "image", url: fixtureImage() },
              ],
            }).then(reply, () => {
              fail?.(new Error("Probe image steer failed"));
            });
          } else reply();
        } else if (message.id !== undefined && message.method !== undefined) {
          send({ id: message.id, error: { code: -32601 } });
        } else if (message.method === "item/agentMessage/delta") {
          if (params.threadId !== threadId) return;
          answer += String(params.delta ?? "");
          if (answer.length > 8192) {
            fail?.(new Error("Probe response exceeded its output budget"));
          }
        } else if (message.method === "item/completed") {
          const item = params.item as
            | { type?: string; contentItems?: { type?: string }[] }
            | undefined;
          if (item?.type === "dynamicToolCall") {
            for (const content of item.contentItems ?? [])
              outputTypes.push(content.type ?? "unknown");
          }
        } else if (message.method === "turn/completed") {
          if (params.threadId !== threadId) return;
          failed = (params.turn as { status?: string } | undefined)?.status === "failed";
          finish?.();
        } else if (message.method === "probe/processExited") {
          fail?.(new Error("Probe process exited"));
        }
      };
      listeners.add(listener);
      try {
        await request("turn/start", {
          threadId,
          input: directImage
            ? [
                {
                  type: "text",
                  text: "Do not call any tools. Describe the colors and shapes in this attached image, left to right.",
                },
                { type: "image", url: fixtureImage() },
              ]
            : [
                {
                  type: "text",
                  text: `Call ${tool} exactly once. Do not use other tools. ${image ? "Describe the colors and shapes in the returned image, left to right." : "Reply only with the observation code returned by that tool."} If the tool is unavailable, reply MISSING.`,
                },
              ],
        });
        await completed;
        return {
          called: calls.includes(tool),
          failed,
          outputTypes,
          ...(image
            ? {
                imageSignals: {
                  purple: /purple|violet|magenta/i.test(answer),
                  circle: /circle|disk|disc|round/i.test(answer),
                  green: /green/i.test(answer),
                  rectangle: /rectangle|square/i.test(answer),
                  unavailable: /cannot|can't|unable|unavailable|not.*(see|view|image)/i.test(
                    answer,
                  ),
                  noVisualAccess:
                    /visual access|don.t have|can.t access|no.*image|not.*render|not.*display|not.*inspect|only.*text/i.test(
                      answer,
                    ),
                  characters: answer.length,
                  repeatedTextCode: answer.includes("apricot-482"),
                  missingTool: /MISSING/.test(answer),
                  textInstead: /text|code|observation|image/i.test(answer),
                },
              }
            : {}),
          understood: image
            ? /purple|violet/i.test(answer) && /circle/i.test(answer) && /green/i.test(answer)
            : answer.includes("apricot-482"),
        };
      } finally {
        listeners.delete(listener);
      }
    },
    async stop() {
      dispatch({ method: "probe/processExited" });
      await runtime.dispose();
      responses.clear();
    },
  };
}

async function main() {
  if (process.platform !== "linux")
    throw new Error("This desktop compatibility probe targets Linux.");
  if (process.env.CAFE_RUN_CODEX_DESKTOP_PROBE !== "1") {
    throw new Error("Set CAFE_RUN_CODEX_DESKTOP_PROBE=1 to opt into real provider requests.");
  }
  const binary = process.env.CODEX_BIN ?? "codex";
  phase = "version";
  const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
  const root = await fs.mkdtemp(path.join(tmpdir(), "cafe-desktop-probe-"));
  try {
    phase = "private-home";
    await fs.chmod(root, 0o700);
    const probeHome = path.join(root, "codex");
    await fs.mkdir(probeHome, { mode: 0o700 });
    const auth = await fs.open(
      path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const authStat = await auth.stat();
      if (!authStat.isFile() || authStat.size > 1024 * 1024)
        throw new Error("Probe authentication must be a regular file");
      await fs.writeFile(path.join(probeHome, "auth.json"), await auth.readFile(), {
        mode: 0o600,
        flag: "wx",
      });
    } finally {
      await auth.close();
    }
    let client = startClient(binary, probeHome, root);
    const deadline = setTimeout(() => {
      void client.stop();
    }, 180000);

    try {
      await client.initialize();
      const started = await client.request("thread/start", {
        cwd: root,
        model: process.env.CAFE_PROBE_MODEL ?? "gpt-6-astra",
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        dynamicTools: [tool("cafe_probe_observe")],
        developerInstructions:
          "This is a tool-protocol test. Only call the explicitly requested Cafe probe tool. Do not execute shell commands, edit files, browse, or delegate.",
      });
      const id = decodeThreadStart(started).thread.id;
      const text = await client.turn(id, "cafe_probe_observe", false);
      console.log(
        JSON.stringify({
          phase: "text",
          version,
          model: process.env.CAFE_PROBE_MODEL ?? "gpt-6-astra",
          imageViaSteer: process.env.CAFE_PROBE_IMAGE_VIA_STEER === "1",
          ...text,
        }),
      );
      if (!text.called || !text.understood) throw new Error("Text tool compatibility failed");
      const namespaced = process.env.CAFE_PROBE_NAMESPACE === "1";
      const imageTool = namespaced ? "cafe_probe.observe_image" : "cafe_probe_image";
      const imageThread = await client.request("thread/start", {
        cwd: root,
        model: process.env.CAFE_PROBE_MODEL ?? "gpt-6-astra",
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        dynamicTools: namespaced
          ? [
              {
                type: "namespace",
                name: "cafe_probe",
                description: "Cafe desktop observation test.",
                tools: [tool("observe_image")],
              } satisfies V2ThreadStartParams__DynamicToolSpec,
            ]
          : [tool("cafe_probe_image")],
        developerInstructions:
          "This is an image tool-protocol test. Call the requested tool and inspect the returned image. If using a code execution wrapper, emit or display its returned image before describing it. Do not execute shell commands, edit files, browse, or delegate.",
      });
      const imageThreadId = decodeThreadStart(imageThread).thread.id;
      const image = await client.turn(imageThreadId, imageTool, true);
      console.log(JSON.stringify({ phase: "image", ...image }));
      if (!image.understood) {
        const control = await client.turn(imageThreadId, "", true, true);
        console.log(JSON.stringify({ phase: "direct-image-control", ...control }));
      }
      const emptyThread = await client.request("thread/start", {
        cwd: root,
        model: process.env.CAFE_PROBE_MODEL ?? "gpt-6-astra",
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: false,
        dynamicTools: [],
        developerInstructions:
          "This is a tool availability test. If the named tool is unavailable, reply MISSING. Do not execute commands, edit files, browse, or delegate.",
      });
      const emptyId = decodeThreadStart(emptyThread).thread.id;
      // Persist a real conversation before testing later attachment; an unused
      // thread may not have a resumable rollout on every supported CLI version.
      await client.turn(emptyId, "cafe_probe_unavailable", false);
      await client.stop();
      client = startClient(binary, probeHome, root);
      await client.initialize();
      await client.request("thread/resume", {
        threadId: id,
        excludeTurns: true,
        initialTurnsPage: { limit: 1, itemsView: "notLoaded", sortDirection: "desc" },
      });
      const resume = await client.turn(id, "cafe_probe_observe", false);
      console.log(JSON.stringify({ phase: "resume", ...resume }));
      await client.stop();
      client = startClient(binary, probeHome, root);
      await client.initialize();
      await client.request("thread/resume", {
        threadId: id,
        excludeTurns: true,
        dynamicTools: [tool("cafe_probe_replacement")],
      });
      const replace = await client.turn(id, "cafe_probe_replacement", false);
      console.log(JSON.stringify({ phase: "replace", ...replace }));
      await client.request("thread/resume", {
        threadId: emptyId,
        excludeTurns: true,
        dynamicTools: [tool("cafe_probe_added")],
      });
      const added = await client.turn(emptyId, "cafe_probe_added", false);
      console.log(JSON.stringify({ phase: "add-to-existing-thread", ...added }));
      if (!image.called || !image.understood || !resume.called)
        throw new Error("Image or resume compatibility failed");
    } finally {
      clearTimeout(deadline);
      await client.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "probe_failed";
  const protocolCode =
    error instanceof Error && /^Protocol error -?\d+$/.test(error.message) ? error.message : "";
  console.error(
    `Desktop tool probe failed at ${phase} (${code}, ${protocolCode}); provider content and credentials omitted.`,
  );
  process.exitCode = 1;
});
