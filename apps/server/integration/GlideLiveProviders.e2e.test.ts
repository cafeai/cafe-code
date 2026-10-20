// @effect-diagnostics nodeBuiltinImport:off
/** Explicit paid qualification only. Uses normal provider authentication and
 * new native conversations; never edits user MCP configuration or resumes a
 * user session. The fixture admits one fixed metadata-only Glide program. */
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parse } from "acorn";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import { expect, it, onTestFinished } from "vitest";
import { ServerConfig, type ServerConfigShape } from "../src/config.ts";
import { handleGlideMcpRequest } from "../src/glide/http.ts";
import { createGlideNativePeer, GlideNativeHost } from "../src/glide/nativeHost.ts";
import {
  installGlideSessionRuntime,
  makeGlideSessionRuntime,
  resolveGlideHelper,
  type GlideSessionBinding,
} from "../src/glide/sessionRuntime.ts";
import { buildCodexAppServerArgs } from "../src/provider/Layers/CodexSessionRuntime.ts";
import * as AcpSessionRuntime from "../src/provider/acp/AcpSessionRuntime.ts";
import {
  buildGrokAcpSpawnInput,
  GrokSandboxProfile,
  grokPermissionModeForRuntimeMode,
  resolveGrokAuthMethodId,
} from "../src/provider/acp/GrokAcpSupport.ts";
import { makeXAiPromptCompletionRuntime } from "../src/provider/acp/XAiAcpExtension.ts";
import { makeClaudeQueryProcessObserver } from "../src/provider/claudeQueryProcess.ts";

const providers = ["codex", "claudeAgent", "grok"] as const;
const enabled = process.env.CAFE_CODE_GLIDE_LIVE_PROVIDERS_E2E === "1";
const selected = process.env.CAFE_CODE_GLIDE_LIVE_PROVIDER;
if (selected && !providers.some((provider) => provider === selected))
  throw new Error("Select codex, claudeAgent or grok for the live Glide fixture.");

interface LiveReceipt {
  nonce: string;
  ok: true;
  challenge: string;
}
function readReceipt(value: unknown, nonce: string, depth = 0): LiveReceipt | undefined {
  if (depth > 12) return undefined;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value.trim());
      return readReceipt(parsed, nonce, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = readReceipt(item, nonce, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  if ("isError" in value && value.isError === true) return undefined;
  if (
    "nonce" in value &&
    value.nonce === nonce &&
    "ok" in value &&
    value.ok === true &&
    "challenge" in value &&
    typeof value.challenge === "string" &&
    value.challenge.length > 0 &&
    value.challenge.length <= 64
  )
    return { nonce, ok: true, challenge: value.challenge };
  // Inspect protocol text/content fields only, never arbitrary provider state.
  for (const [key, item] of Object.entries(value)) {
    if (!["text", "content", "output", "result", "structuredContent"].includes(key)) continue;
    const found = readReceipt(item, nonce, depth + 1);
    if (found) return found;
  }
  return undefined;
}
function receipt(value: unknown, nonce: string, expected: string | undefined): boolean {
  return expected !== undefined && readReceipt(value, nonce)?.challenge === expected;
}

/** Observe only this fixture's real native HTTP output. Preserve native write
 * return values, callbacks, backpressure and the Effect route's own leases. */
function observeResponse(response: ServerResponse, finished: (value: unknown) => void) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const capture = (chunk: unknown, encoding: unknown) => {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return;
    const data =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8")
        : Buffer.from(chunk);
    bytes += data.byteLength;
    if (bytes <= 128 * 1024) chunks.push(data);
  };
  for (const method of ["write", "end"] as const) {
    const original = response[method];
    Object.defineProperty(response, method, {
      configurable: true,
      writable: true,
      value: function (...args: unknown[]) {
        capture(args[0], args[1]);
        return Reflect.apply(original, response, args);
      },
    });
  }
  response.once("finish", () => {
    if (!bytes || bytes > 128 * 1024) return;
    try {
      finished(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      /* No raw response diagnostics. */
    }
  });
}

function shape(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value !== "object" || depth > 2) return typeof value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 16)
      .map(([key, item]) => [key, shape(item, depth + 1)]),
  );
}

function programSignature(code: string): string {
  return JSON.stringify(
    parse(code, { ecmaVersion: "latest", sourceType: "module" }),
    (key, value: unknown) => (["start", "end", "raw"].includes(key) ? undefined : value),
  );
}

function containsProbeProgram(value: unknown, expected: string, depth = 0): boolean {
  if (depth > 5) return false;
  if (typeof value === "string") {
    try {
      if (programSignature(value) === expected) return true;
    } catch {
      // ACP can wrap tool arguments in a JSON string instead of an object.
    }
    try {
      return containsProbeProgram(JSON.parse(value), expected, depth + 1);
    } catch {
      return false;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      ["code", "input", "arguments", "args", "parameters", "params"].includes(key) &&
      containsProbeProgram(item, expected, depth + 1),
  );
}

interface Probe {
  binding: GlideSessionBinding;
  directory: string;
  nonce: string;
  program: string;
  challenge(): string | undefined;
  prompt: string;
  signal: AbortSignal;
  phase(value: string): void;
}
interface ProviderReceipt {
  catalog: boolean;
  toolCompleted: boolean;
  finalReceipt: boolean;
  unexpectedTools: number;
  toolCalls?: number;
  termination?: string;
  errorCode?: string;
  responseClass?: string;
  permissionShapes?: unknown[];
  unclassifiedToolIds?: number;
}

async function codexProbe(probe: Probe): Promise<ProviderReceipt> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      const completed = yield* Deferred.make<void>();
      const result: ProviderReceipt = {
        catalog: false,
        toolCompleted: false,
        finalReceipt: false,
        unexpectedTools: 0,
      };
      yield* client.handleUnknownServerRequest(() => Effect.succeed({ decision: "decline" }));
      yield* client.handleServerNotification("item/completed", ({ item }) =>
        Effect.sync(() => {
          if (item.type === "mcpToolCall") {
            result.toolCalls = (result.toolCalls ?? 0) + 1;
            if (item.server !== probe.binding.name || item.tool !== "js") {
              result.unexpectedTools++;
              return;
            }
            result.toolCompleted =
              item.status === "completed" && receipt(item.result, probe.nonce, probe.challenge());
          } else if (item.type === "agentMessage") {
            result.finalReceipt ||= receipt(item.text, probe.nonce, probe.challenge());
            result.responseClass =
              /(?:unavailable|not available|not exposed|no access|don't have|do not have|cannot access|can't access)/i.test(
                item.text,
              )
                ? "reported-unavailable-tool"
                : /(?:permission|not authorized|forbidden|declin|denied)/i.test(item.text)
                  ? "reported-permission-refusal"
                  : /(?:error|failed|failure)/i.test(item.text)
                    ? "reported-tool-error"
                    : result.finalReceipt
                      ? "nonce-receipt"
                      : "other-own-probe-response";
          } else if (
            [
              "commandExecution",
              "fileChange",
              "webSearch",
              "dynamicToolCall",
              "collabAgentToolCall",
            ].includes(item.type)
          ) {
            result.unexpectedTools++;
          }
        }),
      );
      yield* client.handleServerNotification("turn/completed", ({ turn }) =>
        Effect.sync(() => {
          result.termination = turn.status;
          const info = turn.error?.codexErrorInfo;
          if (info)
            result.errorCode =
              typeof info === "string"
                ? info
                : "type" in info && typeof info.type === "string"
                  ? info.type
                  : (Object.keys(info)[0] ?? "structuredProviderError");
        }).pipe(Effect.andThen(Deferred.succeed(completed, undefined)), Effect.asVoid),
      );
      probe.phase("Codex initialize and MCP discovery");
      yield* client.request("initialize", {
        clientInfo: { name: "cafe-glide-live-e2e", version: "1" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: null },
      });
      yield* client.notify("initialized", undefined);
      const started = yield* client.request("thread/start", {
        cwd: probe.directory,
        model: process.env.CAFE_CODE_GLIDE_CODEX_MODEL ?? "gpt-6.1-sol",
        approvalPolicy: "never",
        // Glide is admitted only under Full access in production. Exact cell
        // and native metadata guards continue to constrain this fixture.
        sandbox: "danger-full-access",
        ephemeral: true,
        developerInstructions:
          "Perform only the user's fixed cafe-glide acceptance probe. No other tools.",
      });
      const catalog = yield* client.request("mcpServerStatus/list", {
        threadId: started.thread.id,
        cursor: null,
        limit: 100,
      });
      result.catalog = catalog.data.some(
        (server) => server.name === probe.binding.name && Object.keys(server.tools).includes("js"),
      );
      if (!result.catalog) return result;
      probe.phase("Codex paid metadata turn");
      yield* client.request("turn/start", {
        threadId: started.thread.id,
        effort: "low",
        input: [{ type: "text", text: probe.prompt }],
      });
      yield* Deferred.await(completed);
      yield* client.request("thread/unsubscribe", { threadId: started.thread.id });
      return result;
    }).pipe(
      Effect.provide(
        CodexClient.layerCommand({
          command: process.env.CAFE_CODE_GLIDE_CODEX_BINARY ?? "codex",
          args: [
            ...buildCodexAppServerArgs({ glideMcp: probe.binding }),
            "-c",
            "features.shell_tool=false",
            "-c",
            'web_search="disabled"',
            "-c",
            "tools.update_plan.enabled=false",
          ],
          cwd: probe.directory,
          maxIncomingBytes: 8 * 1024 * 1024,
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.timeout("120 seconds"),
    ),
    { signal: probe.signal },
  );
}

async function claudeProbe(probe: Probe): Promise<ProviderReceipt> {
  const result: ProviderReceipt = {
    catalog: false,
    toolCompleted: false,
    finalReceipt: false,
    unexpectedTools: 0,
  };
  const toolIds = new Set<string>();
  const observer = makeClaudeQueryProcessObserver(undefined);
  let ownedChild: ReturnType<typeof observer.spawnClaudeCodeProcess> | undefined;
  const abortController = new AbortController();
  const allowedName = `mcp__${probe.binding.name}__js`;
  const runtime = query({
    prompt: probe.prompt,
    options: {
      cwd: probe.directory,
      pathToClaudeCodeExecutable: process.env.CAFE_CODE_GLIDE_CLAUDE_BINARY ?? "claude",
      model: process.env.CAFE_CODE_GLIDE_CLAUDE_MODEL ?? "claude-haiku-4-5",
      effort: "low",
      maxTurns: 3,
      maxBudgetUsd: 0.25,
      tools: [],
      allowedTools: [allowedName],
      strictMcpConfig: true,
      settingSources: [],
      persistSession: false,
      title: "Glide live metadata acceptance",
      abortController,
      mcpServers: {
        [probe.binding.name]: {
          type: "stdio",
          command: probe.binding.launch.command,
          args: [...probe.binding.launch.args],
          env: { ...probe.binding.launch.env },
          alwaysLoad: true,
        },
      },
      canUseTool: async (name, input) =>
        name === allowedName
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: "Only the fixed Glide metadata probe is authorized." },
      spawnClaudeCodeProcess: (input) => {
        ownedChild = observer.spawnClaudeCodeProcess(input);
        return ownedChild;
      },
    },
  });
  const abort = () => {
    abortController.abort();
    runtime.close();
  };
  probe.signal.addEventListener("abort", abort, { once: true });
  probe.phase("Claude SDK MCP discovery and paid metadata turn");
  try {
    for await (const message of runtime) {
      if (message.type === "system" && message.subtype === "init") {
        result.catalog =
          message.mcp_servers.some(
            (server) => server.name === probe.binding.name && server.status === "connected",
          ) && message.tools.includes(allowedName);
      } else if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            result.toolCalls = (result.toolCalls ?? 0) + 1;
            if (block.name === allowedName) toolIds.add(block.id);
            else result.unexpectedTools++;
          }
        }
      } else if (message.type === "user" && Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (block.type === "tool_result" && toolIds.has(block.tool_use_id))
            result.toolCompleted ||=
              !block.is_error && receipt(block.content, probe.nonce, probe.challenge());
        }
      } else if (message.type === "result" && message.subtype === "success") {
        result.finalReceipt = receipt(message.result, probe.nonce, probe.challenge());
        result.termination = "success";
      }
    }
    return result;
  } finally {
    probe.signal.removeEventListener("abort", abort);
    runtime.close();
    if (ownedChild) {
      // Only the exact child obtained from the supported SDK spawn hook.
      const child = ownedChild;
      if (child.exitCode === null && !child.signalCode) child.kill("SIGTERM");
      // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
      // @effect-diagnostics-next-line globalTimers:off
      const force = setTimeout(() => {
        if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      }, 1500);
      try {
        await observer.waitForExit();
      } finally {
        clearTimeout(force);
      }
    }
  }
}

async function grokProbe(probe: Probe): Promise<ProviderReceipt> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawn = buildGrokAcpSpawnInput(
        { binaryPath: process.env.CAFE_CODE_GLIDE_GROK_BINARY ?? "grok" },
        probe.directory,
        process.env,
        GrokSandboxProfile.Off,
        grokPermissionModeForRuntimeMode("full-access"),
        "low",
      );
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          // Existing production launch/auth/session machinery, with the CLI's
          // supported per-invocation empty builtin allowlist. No profile edits.
          spawn: {
            ...spawn,
            args: [
              "--tools=",
              "--disable-web-search",
              "--no-subagents",
              "--max-turns",
              "3",
              ...spawn.args,
            ],
          },
          cwd: probe.directory,
          clientInfo: { name: "cafe-glide-live-e2e", version: "1" },
          authMethodId: (initialized) => resolveGrokAuthMethodId(initialized, process.env),
          cancelPromptLocally: false,
          mcpServers: [
            {
              name: probe.binding.name,
              command: probe.binding.launch.command,
              args: [...probe.binding.launch.args],
              env: Object.entries(probe.binding.launch.env).map(([name, value]) => ({
                name,
                value,
              })),
            },
          ],
        }).pipe(
          Layer.provide(
            Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          ),
        ),
      );
      const base = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
      const runtime = yield* makeXAiPromptCompletionRuntime(base);
      const result: ProviderReceipt = {
        catalog: false,
        toolCompleted: false,
        finalReceipt: false,
        unexpectedTools: 0,
      };
      const toolIds = new Set<string>();
      const unknownIds = new Set<string>();
      let finalText = "";
      yield* runtime.handleRequestPermission((request) => {
        result.permissionShapes ??= [];
        if (result.permissionShapes.length < 4) result.permissionShapes.push(shape(request));
        const allowed = containsProbeProgram(request.toolCall.rawInput, probe.program);
        const option = allowed
          ? request.options.find((item) => item.kind === "allow_once")
          : undefined;
        return Effect.succeed({
          outcome: option
            ? { outcome: "selected", optionId: option.optionId }
            : { outcome: "cancelled" },
        });
      });
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) => {
          if (event._tag === "EventStreamBarrier")
            return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
          return Effect.sync(() => {
            if (event._tag === "AssistantItemStarted") finalText = "";
            if (event._tag === "ContentDelta" && event.streamKind === "assistant_text")
              finalText = (finalText + event.text).slice(-8192);
            if (event._tag !== "ToolCallUpdated") return;
            const call = event.toolCall;
            const outputReceipt =
              receipt(call.data.content, probe.nonce, probe.challenge()) ||
              receipt(call.data.rawOutput, probe.nonce, probe.challenge());
            if (!toolIds.has(call.toolCallId)) {
              if (containsProbeProgram(call.data.rawInput, probe.program) || outputReceipt) {
                toolIds.add(call.toolCallId);
                unknownIds.delete(call.toolCallId);
                result.toolCalls = toolIds.size;
                result.catalog = true;
              } else {
                unknownIds.add(call.toolCallId);
                result.unclassifiedToolIds = unknownIds.size;
                return;
              }
            }
            result.unclassifiedToolIds = unknownIds.size;
            if (call.status === "completed") result.toolCompleted ||= outputReceipt;
          });
        }),
        Effect.forkScoped,
      );
      probe.phase("Grok ACP initialize/authenticate/MCP discovery");
      yield* runtime.start();
      yield* runtime.setSessionModel(
        process.env.CAFE_CODE_GLIDE_GROK_MODEL ?? "grok-4.7-build-fast",
      );
      probe.phase("Grok paid metadata turn");
      const completed = yield* runtime.prompt({ prompt: [{ type: "text", text: probe.prompt }] });
      yield* runtime.finishPromptEvents;
      result.termination = completed.stopReason;
      result.finalReceipt =
        completed.stopReason !== "cancelled" && receipt(finalText, probe.nonce, probe.challenge());
      return result;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("120 seconds")),
    { signal: probe.signal },
  );
}

it
  .skipIf(!enabled || process.platform !== "darwin")
  .each(providers.filter((provider) => !selected || selected === provider))(
  "real %s discovers cafe-glide and receives managed native metadata",
  async (provider) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "glide-live-provider-")));
    const scope = await Effect.runPromise(Scope.make());
    const controller = new AbortController();
    const nonce = randomUUID();
    const code = `const apps = await glide.listApps({emit:false}); nodeRepl.write(JSON.stringify({nonce:${JSON.stringify(nonce)},ok:Array.isArray(apps),challenge:Math.random().toString(36)}));`;
    const allowedProgram = programSignature(code);
    let phase = "fixture setup";
    let nativeLists = 0,
      blockedNative = 0,
      executed = 0,
      rejectedCells = 0,
      pipelineReceipt = false;
    let expectedChallenge: string | undefined;
    let catalogLists = 0,
      finishedJsResponses = 0,
      blockedControl = 0;
    let binding: GlideSessionBinding | undefined;
    let runtime: ReturnType<typeof makeGlideSessionRuntime> | undefined;
    let uninstall: (() => void) | undefined;
    let running: Promise<ProviderReceipt> | undefined;
    let received: ProviderReceipt | undefined;
    const handler = await Effect.runPromise(
      NodeHttpServer.makeHandler(
        handleGlideMcpRequest.pipe(Effect.provideService(ServerConfig, {} as ServerConfigShape)),
        { scope },
      ),
    );
    const server = createServer((incoming, outgoing) => {
      observeResponse(outgoing, (value) => {
        if (typeof value !== "object" || value === null || !("result" in value)) return;
        const result = value.result;
        if (
          typeof result === "object" &&
          result !== null &&
          "tools" in result &&
          Array.isArray(result.tools) &&
          result.tools.some(
            (tool: unknown) =>
              typeof tool === "object" && tool !== null && "name" in tool && tool.name === "js",
          )
        )
          catalogLists++;
        if (receipt(result, nonce, expectedChallenge)) finishedJsResponses++;
      });
      handler(incoming, outgoing);
    });
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupPromise ??= (async () => {
        controller.abort();
        await running?.catch(() => undefined);
        let failures = 0;
        const retire = async (operation: () => Promise<unknown>) => {
          try {
            await operation();
          } catch {
            failures++;
          }
        };
        await retire(async () => binding?.dispose());
        uninstall?.();
        await retire(async () => runtime?.close());
        server.closeAllConnections();
        await retire(() => new Promise<void>((resolve) => server.close(() => resolve())));
        await retire(() => Effect.runPromise(Scope.close(scope, Exit.void)));
        await retire(() => rm(directory, { recursive: true, force: true }));
        if (failures) throw new Error("Owned live-provider fixture cleanup did not complete.");
      })());
    onTestFinished(cleanup);
    // Native opt-in fixture retains its exact wall-clock deadline, callback and child cleanup.
    // @effect-diagnostics-next-line globalTimers:off
    const deadline = setTimeout(() => controller.abort(), 130_000);
    try {
      const helperPath = await resolveGlideHelper();
      if (!helperPath)
        throw new Error("Build the native Glide helper before opting into this fixture.");
      const host = new GlideNativeHost((apps) => {
        expect(apps).toEqual(["com.apple.TextEdit"]);
        const peer = createGlideNativePeer(helperPath, apps);
        return {
          request: async (frame) => {
            if (frame.method !== "list_apps" && frame.method !== "retire_session") {
              blockedNative++;
              throw new Error("Live provider fixture refuses input, app launch and capture.");
            }
            const value = await peer.request(frame);
            if (frame.method === "list_apps") {
              expect(Array.isArray(value)).toBe(true);
              nativeLists++;
            }
            return value;
          },
          close: () => peer.close(),
        };
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing live fixture endpoint.");
      runtime = makeGlideSessionRuntime({
        helperPath,
        bridgeSource: fileURLToPath(new URL("../dist/glide-mcp-bridge.mjs", import.meta.url)),
        nativeHost: host,
        mcpPort: address.port,
        readPolicy: async () => ({ enabled: true, apps: ["com.apple.TextEdit"], fullAccess: true }),
        writePolicy: async () => {
          throw new Error("Live fixture policy is immutable.");
        },
      });
      const ownedRuntime = runtime;
      uninstall = installGlideSessionRuntime({
        bind: ownedRuntime.bind,
        operation: async (operation, signal) => {
          if (operation.kind !== "catalog" && operation.kind !== "execute") {
            blockedControl++;
            throw new Error("Only metadata probe execution and catalog discovery are authorized.");
          }
          if (operation.kind === "execute") {
            if (programSignature(operation.input.code) !== allowedProgram || executed !== 0) {
              rejectedCells++;
              throw new Error(
                "Only one exact metadata probe is authorized; paid retries are disabled.",
              );
            }
            executed++;
          }
          const value = await ownedRuntime.operation(operation, signal);
          if (operation.kind === "execute") {
            const proof = readReceipt(value, nonce);
            expectedChallenge = proof?.challenge;
            pipelineReceipt = proof !== undefined;
          }
          return value;
        },
      });
      binding = await runtime.bind({
        threadId: ThreadId.make(`glide-live-${provider}-${nonce}`),
        providerInstanceId: ProviderInstanceId.make(provider),
        provider,
        runtimeMode: "full-access",
      });
      if (!binding) throw new Error("Managed Glide binding unavailable.");
      await binding.activate();
      const probe: Probe = {
        binding,
        directory,
        nonce,
        program: allowedProgram,
        challenge: () => expectedChallenge,
        signal: controller.signal,
        phase: (value) => {
          phase = value;
        },
        prompt: `Acceptance probe. Use only the cafe-glide MCP server's js tool. Call it exactly once with this code (do not add imports, other statements or markdown):\n${code}\nAfter receiving the actual tool output, reply with only that exact JSON object. Do not use js_reset, shell, files, web, other tools, app input or capture. Do not claim success if the tool fails.`,
      };
      running = { codex: codexProbe, claudeAgent: claudeProbe, grok: grokProbe }[provider](probe);
      received = await running;
      phase = "receipt validation";
      expect(
        catalogLists,
        "Provider must discover js through the actual HTTP catalog.",
      ).toBeGreaterThan(0);
      expect(executed, "Provider must execute exactly one managed probe.").toBe(1);
      expect(nativeLists, "The actual native helper must complete list_apps.").toBe(1);
      expect(blockedNative).toBe(0);
      expect(blockedControl).toBe(0);
      expect(rejectedCells).toBe(0);
      expect(
        finishedJsResponses,
        "The native HTTP response must finish with the actual worker challenge.",
      ).toBe(1);
      expect(
        pipelineReceipt,
        "Managed pipeline must produce the exact nonce and native array proof.",
      ).toBe(true);
      expect(
        received.finalReceipt,
        "Model must copy the unpredictable worker-generated challenge.",
      ).toBe(true);
      expect(received.termination, "Provider turn must reach its successful terminal state.").toBe(
        { codex: "completed", claudeAgent: "success", grok: "end_turn" }[provider],
      );
      if (provider !== "grok") {
        expect(received.catalog).toBe(true);
        expect(
          received.toolCompleted,
          "Provider must receive the actual completed MCP result.",
        ).toBe(true);
        expect(received.unexpectedTools).toBe(0);
        expect(received.toolCalls).toBe(1);
      }
      process.stdout.write(
        `Glide live acceptance: ${provider} HTTP catalog/native/pipeline/finished response/model challenge passed.\n`,
      );
    } catch {
      // Provider diagnostics can contain credential/profile material. Report
      // only the owned phase, never raw protocol payloads, stderr or causes.
      throw new Error(
        `Glide live ${provider} failed during ${phase}; no retry was attempted. ` +
          JSON.stringify({
            executed,
            rejectedCells,
            nativeLists,
            blockedNative,
            pipelineReceipt,
            catalogLists,
            finishedJsResponses,
            blockedControl,
            received,
          }),
      );
    } finally {
      clearTimeout(deadline);
      await cleanup();
    }
  },
  150_000,
);
