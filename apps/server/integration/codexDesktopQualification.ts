// @effect-diagnostics nodeBuiltinImport:off
import { constants, promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Client from "effect-codex-app-server/client";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { makeDesktopMcpServer } from "../src/virtualDesktop/mcp.ts";
import { desktopMcpOverride } from "../src/virtualDesktop/codexConfiguration.ts";

/** Opt-in real-account test driver, imported only by native *.e2e.test.ts.
 * Uses the actual bridge and Cafe's bounded typed app-server client. All model
 * observations come from the synthetic native fixture, never the host desktop.
 * Provider output and authentication remain private and are never printed. */
export async function qualifyCodexDesktop(input: {
  root: string;
  bridge: string;
  code: string;
  call: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
}) {
  const home = path.join(input.root, "codex");
  await fs.mkdir(home, { mode: 0o700 });
  const auth = await fs.open(
    path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await auth.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("Invalid probe authentication file.");
    await fs.writeFile(path.join(home, "auth.json"), await auth.readFile(), {
      mode: 0o600,
      flag: "wx",
    });
  } finally {
    await auth.close();
  }
  const token = randomBytes(32).toString("hex");
  const calls: string[] = [];
  const http = createServer((req, res) => {
    if (req.url !== "/mcp/desktop" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = makeDesktopMcpServer(async (name, args, signal) => {
      calls.push(name);
      return input.call(name, args, signal);
    });
    void (async () => {
      // SDK's Node transport widens optional callback properties to undefined;
      // its runtime interface is the same Transport used by the Web adapter.
      try {
        await server.connect(transport as Transport);
        await transport.handleRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(503);
        res.end();
      } finally {
        await server.close();
        await transport.close();
      }
    })();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (typeof address !== "object" || !address) throw new Error("Probe listener failed.");
  const connection = path.join(input.root, "codex-desktop.json");
  await fs.writeFile(
    connection,
    JSON.stringify({
      audience: "cafe-desktop",
      url: `http://127.0.0.1:${address.port}/mcp/desktop`,
      token,
    }),
    { mode: 0o600 },
  );
  const makeClient = async (enabled: boolean) => {
    let complete: ((value: { answer: string; failed: boolean }) => void) | undefined;
    let answer = "";
    const runtime = ManagedRuntime.make(
      Client.layerCommand({
        command: process.env.CODEX_BIN ?? "codex",
        args: [
          "app-server",
          "--stdio",
          "-c",
          desktopMcpOverride({
            bridgePath: input.bridge,
            connectionPath: enabled ? connection : null,
          }),
        ],
        cwd: input.root,
        env: { CODEX_HOME: home },
        logIncoming: false,
        logOutgoing: false,
        onTermination: () => Effect.sync(() => complete?.({ answer: "", failed: true })),
      }).pipe(Layer.provide(NodeServices.layer)),
    );
    const client = await runtime
      .runPromise(
        Effect.gen(function* () {
          const client = yield* Client.CodexAppServerClient;
          yield* client.handleServerNotification("item/agentMessage/delta", (params) =>
            Effect.sync(() => {
              if (answer.length < 8192) answer += params.delta;
            }),
          );
          yield* client.handleServerNotification("turn/completed", (params) =>
            Effect.sync(() => complete?.({ answer, failed: params.turn.status === "failed" })),
          );
          yield* client.request("initialize", {
            clientInfo: { name: "cafe-desktop-qualification", version: "1" },
            capabilities: { experimentalApi: true },
          });
          yield* client.notify("initialized", undefined);
          return client;
        }),
      )
      .catch(async (error) => {
        await runtime.dispose();
        throw error;
      });
    return {
      request: (method: string, params: Record<string, unknown>) =>
        runtime.runPromise(client.raw.request(method, params)),
      async turn(threadId: string, prompt: string) {
        answer = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = new Promise<{ answer: string; failed: boolean }>((resolve, reject) => {
          complete = resolve;
          timer = setTimeout(
            () => reject(new Error("Codex desktop qualification timed out.")),
            90_000,
          );
        });
        try {
          await runtime.runPromise(
            client.raw.request("turn/start", { threadId, input: [{ type: "text", text: prompt }] }),
          );
          return await done;
        } finally {
          clearTimeout(timer);
          complete = undefined;
        }
      },
      stop: () => runtime.dispose(),
    };
  };
  let client: Awaited<ReturnType<typeof makeClient>> | undefined;
  try {
    client = await makeClient(false);
    const started = (await client.request("thread/start", {
      cwd: input.root,
      model: process.env.CAFE_CODE_DESKTOP_TEST_MODEL ?? "gpt-6-astra",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      developerInstructions:
        "This is a desktop MCP compatibility test. Only use cafe-desktop tools when requested. Inspect tool images; if using a code wrapper, display/emit its returned image. Do not use shell, browse, edit files, delegate, or ask for permission.",
    })) as { thread: { id: string } };
    const id = started.thread.id;
    const memory = randomBytes(4).toString("hex");
    await client.turn(id, `Remember the marker ${memory}. Reply READY. No tools.`);
    await client.stop();
    client = await makeClient(true);
    const resume = {
      threadId: id,
      excludeTurns: true,
      initialTurnsPage: { limit: 1, itemsView: "notLoaded", sortDirection: "desc" },
    };
    await client.request("thread/resume", resume);
    const observed = await client.turn(
      id,
      "Call cafe-desktop observe. Read the CODE text in the screenshot and state the left and right rectangle colors. Also repeat the marker from our earlier conversation. Reply only those facts. Do not guess if an image is unavailable.",
    );
    if (
      observed.failed ||
      !calls.includes("observe") ||
      !observed.answer.includes(input.code) ||
      !observed.answer.includes(memory) ||
      !/red/i.test(observed.answer) ||
      !/green/i.test(observed.answer)
    )
      throw new Error("Codex did not verify the MCP image and preserved conversation marker.");
    const action = await client.turn(
      id,
      "Observe again, click the red rectangle once, then type cafe42 with act kind text. Observe to verify the effect, then reply DONE. Only use cafe-desktop tools.",
    );
    if (action.failed || calls.filter((v) => v === "act").length < 2)
      throw new Error(
        "Codex desktop interaction did not complete: " +
          JSON.stringify({
            calls,
            failed: action.failed,
            unavailable: /unavailable|cannot|can.t|unable|missing/i.test(action.answer),
            permission: /approval|permission|confirm/i.test(action.answer),
          }),
      );
    await client.stop();
    client = await makeClient(false);
    await client.request("thread/resume", resume);
    const count = calls.length;
    const disabled = await client.turn(
      id,
      "Desktop Control is disabled for this run. Check whether cafe-desktop observe is available. Do not substitute any other tool. Reply AVAILABLE or MISSING.",
    );
    if (disabled.failed || !disabled.answer.includes("MISSING") || calls.length !== count)
      throw new Error("Codex retained Desktop Control after session disablement.");
    return {
      imageVisible: true,
      attachmentAfterResume: true,
      sameConversation: true,
      inputVerified: true,
      disabledAfterResume: true,
    };
  } finally {
    await client?.stop();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}
