// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  GrokSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@cafecode/contracts";
import { AuthSessionId } from "@cafecode/contracts/auth";

import { ServerConfig } from "../../config.ts";
import {
  didGrokContextCompact,
  grokPromptSettlementBelongsToContext,
  makeGrokAdapter,
  readGrokPromptTokenUsage,
  resolveGrokCafeMcpUrl,
  shouldAutoApproveGrokPermission,
  validateGrokImageAttachmentBytes,
} from "./GrokAdapter.ts";
import type { GrokAdapterShape } from "../Services/GrokAdapter.ts";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

async function makeMockGrokWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-grok.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const script = `#!/bin/sh
${envExports}
exec ${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function waitForSessionReady(
  adapter: Pick<GrokAdapterShape, "listSessions">,
  threadId: ThreadId,
  attempts = 100,
): Effect.Effect<ProviderSession> {
  const poll = (remainingAttempts: number): Effect.Effect<ProviderSession> =>
    Effect.gen(function* () {
      const session = (yield* adapter.listSessions()).find(
        (candidate) => String(candidate.threadId) === String(threadId),
      );
      if (session?.status === "ready" && session.activeTurnId === undefined) {
        return session;
      }
      if (remainingAttempts <= 0) {
        return yield* Effect.die(
          new Error(`Timed out waiting for Grok session '${threadId}' to become ready.`),
        );
      }
      yield* Effect.sleep("25 millis");
      return yield* poll(remainingAttempts - 1);
    });
  // ACP mock traffic uses real subprocess I/O, so polling must not wait on the
  // virtual test clock while that process is still producing its response.
  return poll(attempts).pipe(TestClock.withLive);
}

const grokAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cafecode-grok-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

let testMcpCredentialSequence = 0;
const testSessionCredentials = {
  issue: () =>
    DateTime.now.pipe(
      Effect.map((expiresAt) => ({
        sessionId: AuthSessionId.make(`grok-test-mcp-${++testMcpCredentialSequence}`),
        token: "grok-test-mcp-token",
        method: "bearer-session-token" as const,
        client: { deviceType: "bot" as const },
        expiresAt,
        role: "owner" as const,
      })),
    ),
  revoke: () => Effect.succeed(true),
};

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeGrokAdapter>[1]) =>
  makeGrokAdapter(decodeGrokSettings({ binaryPath }), {
    sessionCredentials: testSessionCredentials,
    ...options,
  }).pipe(Effect.orDie);

it("routes Cafe MCP through the main backend when Grok runs in the provider daemon", () => {
  assert.strictEqual(
    resolveGrokCafeMcpUrl({ port: 1, cafeMcpPort: 3773 }),
    "http://127.0.0.1:3773/mcp",
  );
  assert.strictEqual(resolveGrokCafeMcpUrl({ port: 3773 }), "http://127.0.0.1:3773/mcp");
});

it("requires a settlement to match the live Grok turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it("revalidates stored Grok attachment bytes before encoding ACP images", () => {
  assert.isUndefined(validateGrokImageAttachmentBytes({ mimeType: "image/png", sizeBytes: 4 }, 4));
  assert.match(
    validateGrokImageAttachmentBytes({ mimeType: "image/png", sizeBytes: 4 }, 3) ?? "",
    /size/i,
  );
  assert.match(
    validateGrokImageAttachmentBytes({ mimeType: "text/plain", sizeBytes: 4 }, 4) ?? "",
    /image/i,
  );
});

it("uses last-call totals for Grok context occupancy without double-counting reasoning", () => {
  assert.deepEqual(
    readGrokPromptTokenUsage({
      stopReason: "end_turn",
      _meta: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedReadTokens: 40,
        cacheCreationTokens: 5,
        reasoningTokens: 15,
      },
    }),
    {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 5,
      reasoningOutputTokens: 15,
    },
  );
});

it("infers Grok compaction only from a substantial current-context drop", () => {
  assert.isTrue(
    didGrokContextCompact({
      previousContextTokens: 82_000,
      currentContextTokens: 31_000,
      previousProcessedTokens: 120_000,
      currentProcessedTokens: 125_000,
    }),
  );
  assert.isFalse(
    didGrokContextCompact({
      previousContextTokens: 82_000,
      currentContextTokens: 80_000,
      previousProcessedTokens: 120_000,
      currentProcessedTokens: 125_000,
    }),
  );
  assert.isFalse(
    didGrokContextCompact({
      previousContextTokens: 82_000,
      currentContextTokens: 31_000,
      previousProcessedTokens: 125_000,
      currentProcessedTokens: 125_000,
    }),
  );
  assert.isFalse(
    didGrokContextCompact({
      previousContextTokens: undefined,
      currentContextTokens: 31_000,
      previousProcessedTokens: 0,
      currentProcessedTokens: 31_000,
    }),
  );
});

it("auto-approves only edit-like requests in Cafe's auto-accept mode", () => {
  assert.isTrue(shouldAutoApproveGrokPermission("auto-accept-edits", "edit"));
  assert.isTrue(shouldAutoApproveGrokPermission("auto-accept-edits", "move"));
  assert.isFalse(shouldAutoApproveGrokPermission("auto-accept-edits", "execute"));
  assert.isFalse(shouldAutoApproveGrokPermission("approval-required", "edit"));
  // A request that survives Grok's native bypass mode may represent an explicit
  // ask/deny rule or managed policy and must still reach Cafe's approval UI.
  assert.isFalse(shouldAutoApproveGrokPermission("full-access", "edit"));
  assert.isFalse(shouldAutoApproveGrokPermission("auto-accept-edits", "edit", "auto"));
  assert.isFalse(shouldAutoApproveGrokPermission("auto-accept-edits", "edit", "plan"));
});

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("fails a protected session when Grok reports sandbox enforcement failure", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ CAFE_CODE_ACP_SANDBOX_FAILURE_WARNING: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("grok-sandbox-fail-closed"),
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "default" },
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterRequestError");
    }),
  );

  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "grok");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepEqual(session.modelSelection, {
        instanceId: ProviderInstanceId.make("grok"),
        model: "grok-mock-alt",
        options: [{ id: "reasoningEffort", value: "medium" }],
      });
      assert.deepInclude(session.resumeCursor as Record<string, unknown>, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
        sandboxProfile: "off",
        model: "grok-mock-alt",
        reasoningEffort: "medium",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello grok",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("requires orchestration to restart before a changed reasoning turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-reasoning-change");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "use less reasoning",
          attachments: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("grok"),
            model: "grok-build",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterValidationError");
      assert.include(error.message, "restarted and resumed");
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("atomically replaces an idle resumed session for model and reasoning changes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-restart-resume-selection");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-restart-resume-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_REQUEST_LOG_PATH: requestLogPath,
          CAFE_CODE_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const initial = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      const replacement = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: initial.resumeCursor,
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-mock-alt",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });

      assert.deepEqual(replacement.modelSelection, {
        instanceId: ProviderInstanceId.make("grok"),
        model: "grok-mock-alt",
        options: [{ id: "reasoningEffort", value: "low" }],
      });
      assert.deepInclude(replacement.resumeCursor as Record<string, unknown>, {
        sessionId: "mock-session-1",
        model: "grok-mock-alt",
        reasoningEffort: "low",
      });
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "session/load"));
      const processArgs = requests.filter((entry) => entry.method === "process/argv");
      assert.lengthOf(processArgs, 2);
      assert.includeMembers(processArgs[1]?.params as Array<string>, ["--reasoning-effort", "low"]);
      assert.isTrue(
        requests.some(
          (entry) =>
            entry.method === "session/set_model" &&
            (entry.params as { modelId?: unknown } | undefined)?.modelId === "grok-mock-alt",
        ),
      );
      const exitLog = yield* waitForFileContent(exitLogPath, 80, "SIGTERM");
      assert.equal(exitLog.split("\n").filter((line) => line === "SIGTERM").length, 1);
      assert.isFalse(runtimeEvents.some((event) => event.type === "session.exited"));

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("keeps the prior Grok process when a replacement cannot load", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-restart-resume-failure");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ CAFE_CODE_ACP_FAIL_LOAD_SESSION: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const initial = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });

      const error = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: initial.resumeCursor,
          modelSelection: {
            instanceId: ProviderInstanceId.make("grok"),
            model: "grok-mock-alt",
            options: [{ id: "reasoningEffort", value: "low" }],
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.lengthOf(sessions, 1);
      assert.deepEqual(sessions[0]?.modelSelection, initial.modelSelection);
      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not call unadvertised session configuration methods", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-no-session-config-methods");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-no-config-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_EXIT_ON_SET_CONFIG_OPTION: "1",
          CAFE_CODE_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        interactionMode: "plan",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan safely",
        attachments: [],
        interactionMode: "plan",
      });

      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"').pipe(
        TestClock.withLive,
      );
      yield* waitForSessionReady(adapter, threadId);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isFalse(requests.some((entry) => entry.method === "session/set_config_option"));
      assert.isTrue(requests.some((entry) => entry.method === "session/prompt"));
      const processArgs = requests.find((entry) => entry.method === "process/argv")?.params;
      assert.includeMembers(processArgs as Array<string>, ["--permission-mode", "plan"]);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("settles an active turn before session teardown interrupts its prompt scope", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-session-active-turn");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ CAFE_CODE_ACP_HANG_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const sessionExited = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) return;
          runtimeEvents.push(event);
          if (event.type === "session.exited") {
            yield* Deferred.succeed(sessionExited, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const acknowledgement = yield* adapter.sendTurn({
        threadId,
        input: "stay active until teardown",
        attachments: [],
      });

      yield* adapter.stopSession(threadId);
      yield* Deferred.await(sessionExited);

      const terminalEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && event.turnId === acknowledgement.turnId,
      );
      assert.lengthOf(terminalEvents, 1);
      assert.equal(terminalEvents[0]?.payload.state, "cancelled");
      assert.isBelow(
        runtimeEvents.findIndex((event) => event === terminalEvents[0]),
        runtimeEvents.findIndex((event) => event.type === "session.exited"),
      );
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* Fiber.interrupt(runtimeEventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("reports a Grok session running only while the prompt is in flight", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-session-ready-after-prompt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : event.type === "turn.completed" && String(event.threadId) === String(threadId)
            ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "check lifecycle", attachments: [] })
        .pipe(Effect.forkChild);
      const requestOpenedEvent = yield* Deferred.await(requestOpened);

      const runningSessions = yield* adapter.listSessions();
      const runningSession = runningSessions.find((session) => session.threadId === threadId);
      assert.equal(runningSession?.status, "running");
      assert.isDefined(runningSession?.activeTurnId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(turnCompleted);

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("acknowledges a Grok turn without waiting for session/prompt to complete", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-prompt-ack-before-completion");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ CAFE_CODE_ACP_HANG_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const acknowledgement = yield* adapter
        .sendTurn({ threadId, input: "keep working for a long time", attachments: [] })
        .pipe(Effect.timeout("2 seconds"));
      const runningSession = (yield* adapter.listSessions()).find(
        (session) => String(session.threadId) === String(threadId),
      );

      assert.equal(acknowledgement.threadId, threadId);
      assert.equal(runningSession?.status, "running");
      assert.equal(String(runningSession?.activeTurnId), String(acknowledgement.turnId));

      const restartError = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          resumeCursor: runningSession?.resumeCursor,
          modelSelection: {
            instanceId: ProviderInstanceId.make("grok"),
            model: "grok-mock-alt",
          },
        })
        .pipe(Effect.flip);
      assert.equal(restartError._tag, "ProviderAdapterValidationError");
      assert.include(restartError.message, "active turn finishes");

      yield* adapter.interruptTurn(threadId, acknowledgement.turnId);
    }).pipe(TestClock.withLive),
  );

  it.effect("restores ready without completing an unstarted turn when preparation fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-preparation-failure-while-connecting");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "prepare invalid attachment",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.isUndefined(turnCompletedEvent);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("completes a Grok turn from xAI prompt completion when the prompt RPC hangs", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-prompt-complete-fallback");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
          CAFE_CODE_ACP_EMIT_FOREIGN_SESSION_UPDATES: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnResult = yield* adapter.sendTurn({
        threadId,
        input: "exercise fallback",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const eventTypes = runtimeEvents.map((event) => event.type);
      const content = runtimeEvents
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" && String(event.threadId) === String(threadId),
        )
        .map((event) => event.payload.delta)
        .join("");
      const terminalIndex = runtimeEvents.findIndex(
        (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterTerminal = runtimeEvents
        .slice(terminalIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );
      const toolTitles = runtimeEvents.flatMap((event) =>
        event.type === "item.updated" && event.payload.title ? [event.payload.title] : [],
      );

      assert.equal(sendTurnResult.threadId, threadId);
      assert.include(eventTypes, "turn.completed");
      assert.equal(content, "hello from mock");
      assert.isAtLeast(terminalIndex, 0);
      assert.deepEqual(outputAfterTerminal, []);
      assert.notInclude(toolTitles, "Child-only tool");
      assert.equal(turnCompletedEvent?.payload.stopReason, "end_turn");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "handles Grok 1.0.4 turn_completed updates and recovers only last-call context usage",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("grok-xai-session-update-completion");
        const grokHome = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-xai-session-update-")),
        );
        const wrapperPath = yield* Effect.promise(() =>
          makeMockGrokWrapper({
            CAFE_CODE_ACP_EMIT_XAI_TURN_COMPLETED_UPDATE_THEN_HANG: "1",
            GROK_HOME: grokHome,
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath, {
          environment: { ...process.env, GROK_HOME: grokHome },
        });

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const turnCompleted = yield* Deferred.make<void>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "exercise stable session update completion",
          attachments: [],
        });

        yield* Deferred.await(turnCompleted);
        yield* waitForSessionReady(adapter, threadId);
        const usage = runtimeEvents.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }> =>
            event.type === "thread.token-usage.updated",
        );
        const completed = runtimeEvents.find(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed",
        );

        assert.equal(completed?.payload.state, "completed");
        assert.equal(completed?.payload.stopReason, "end_turn");
        assert.deepInclude(usage?.payload.usage ?? {}, {
          usedTokens: 111_797,
          maxTokens: 500_000,
          inputTokens: 111_118,
          cachedInputTokens: 110_080,
          outputTokens: 679,
          reasoningOutputTokens: 149,
        });
        assert.notEqual(usage?.payload.usage.usedTokens, 2_541_568);

        yield* Fiber.interrupt(runtimeEventsFiber);
        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("retains turn transcript after the sendTurn acknowledgement returns", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-send-turn-interrupt-after-prompt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const contentDelta = yield* Deferred.make<void>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta"
          ? Deferred.succeed(contentDelta, undefined).pipe(Effect.ignore)
          : event.type === "turn.completed" && String(event.threadId) === String(threadId)
            ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "interrupt after prompt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(contentDelta);
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(turnCompleted);

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.items.length, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not report a synthetic stop reason when xAI omits one", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-prompt-complete-missing-stop-reason");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
          CAFE_CODE_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "exercise missing stop reason",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );

      assert.equal(turnCompletedEvent?.payload.state, "completed");
      assert.isNull(turnCompletedEvent?.payload.stopReason);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("retires the owned child after stopping a fully silent Grok prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-after-full-silence");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (event.type !== "turn.completed" || String(event.threadId) !== String(threadId)) {
            return;
          }
          yield* Deferred.succeed(firstTurnCompleted, undefined).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const interruptFiber = yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });
      yield* Deferred.await(firstTurnCompleted);
      yield* Fiber.join(interruptFiber).pipe(Effect.timeout("2 seconds"));

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* Fiber.interrupt(runtimeEventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("settles a cancelled prompt exactly once before retiring its session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-cancelled-settlement-before-follow-up");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-cancel-race-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          CAFE_CODE_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type !== "turn.completed") {
            return;
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel this prompt", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      assert.isFalse(yield* adapter.hasSession(threadId));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [[String(firstTurnId), "cancelled"]],
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("drops late ACP notifications after a turn is cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-drop-late-cancelled-notifications");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_HANG_PROMPT_FOREVER: "1",
          CAFE_CODE_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
        }),
      );
      const nativeLogRecords: unknown[] = [];
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-cancelled-native-events",
          write: (record: unknown) =>
            Effect.sync(() => {
              nativeLogRecords.push(record);
            }),
          close: () => Effect.void,
        },
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before the late update", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Effect.sleep("150 millis");
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "turn.completed" &&
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === "cancelled",
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterCancellation = runtimeEvents
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );

      assert.isAtLeast(cancelledIndex, 0);
      assert.deepEqual(outputAfterCancellation, []);
      assert.notInclude(JSON.stringify(nativeLogRecords), "late after cancel");
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* Fiber.interrupt(runtimeEventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("lets Stop cancel during the xAI completion drain window", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-during-completion-drain");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const activeTurnIdRef = yield* Ref.make<TurnId | undefined>(undefined);
      const trailingChunkTurnId = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started") {
            yield* Ref.set(activeTurnIdRef, event.turnId);
          }
          if (event.type !== "content.delta" || event.payload.delta !== "mock") {
            return;
          }
          const turnId = event.turnId ?? (yield* Ref.get(activeTurnIdRef));
          if (turnId === undefined) {
            return;
          }
          yield* Deferred.succeed(trailingChunkTurnId, turnId).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel during completion drain",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const turnId = yield* Deferred.await(trailingChunkTurnId).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.isFalse(yield* adapter.hasSession(threadId));

      yield* Fiber.interrupt(runtimeEventsFiber);
    }),
  );

  it.effect("settles the in-flight prompt before emitting completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-completion-before-next-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const completedCountRef = yield* Ref.make(0);
      const secondTurnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type !== "turn.completed" || String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }

        return Ref.modify(completedCountRef, (count) => {
          const nextCount = count + 1;
          return [nextCount, nextCount] as const;
        }).pipe(
          Effect.flatMap((count) => {
            if (count === 1) {
              return adapter
                .sendTurn({
                  threadId,
                  input: "second turn after completion",
                  attachments: [],
                })
                .pipe(Effect.forkChild, Effect.asVoid);
            }
            if (count === 2) {
              return Deferred.succeed(secondTurnCompleted, undefined).pipe(Effect.asVoid);
            }
            return Effect.void;
          }),
        );
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* Deferred.await(secondTurnCompleted);

      const completedCount = yield* Ref.get(completedCountRef);
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(completedCount, 2);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores a Grok session to ready when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-prompt-failure-ready");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_FAIL_PROMPT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const acknowledgement = yield* adapter.sendTurn({
        threadId,
        input: "fail prompt",
        attachments: [],
      });
      yield* Deferred.await(turnCompleted);
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(acknowledgement.threadId, threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      assert.equal(failedTurnCompleted?.type, "turn.completed");
      if (failedTurnCompleted?.type === "turn.completed") {
        assert.equal(failedTurnCompleted.payload.state, "failed");
        assert.isString(failedTurnCompleted.payload.errorMessage);
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores replayed session/load updates when resuming a Grok session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_EMIT_LOAD_REPLAY: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      assert.deepInclude(session.resumeCursor as Record<string, unknown>, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
        sandboxProfile: "off",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("grok-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-empty-turn");

      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-custom-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_REQUEST_LOG_PATH: requestLogPath,
          CAFE_CODE_ACP_EMIT_TOOL_CALLS: "1",
          CAFE_CODE_ACP_ALLOW_ONCE_OPTION_ID: "agent-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });
      yield* waitForSessionReady(adapter, threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "agent-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles xAI ask_user_question extension requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-ask-user-question");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ CAFE_CODE_ACP_EMIT_XAI_ASK_USER_QUESTION: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.equal(requestedEvent.payload.questions[0]?.id, "Which scope should Grok use?");
      assert.equal(requestedEvent.payload.questions[0]?.question, "Which scope should Grok use?");
      assert.equal(requestedEvent.raw?.method, "_x.ai/ask_user_question");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          "Which scope should Grok use?": "Workspace",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        "Which scope should Grok use?": "Workspace",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("continues streaming events when native notification logging fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-native-log-failure");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-native-events",
          write: (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            typeof record.event === "object" &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const contentDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* Deferred.await(contentDelta);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  // Production calls startSession from a request fiber that finishes as soon as
  // the session exists. `Effect.forkChild` made the notification consumer a
  // child of that fiber, and Effect interrupts a fiber's children when it
  // completes, so the consumer died on return and every later session/update
  // was dropped: the thread sat on "Working" forever while the provider
  // streamed its whole turn. Every other test here calls startSession directly
  // from the test fiber, which never completes, so the consumer survived and
  // the bug stayed invisible. Running it in a fiber that finishes is what
  // reproduces production.
  it.effect("keeps consuming notifications after the startSession fiber completes", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-consumer-outlives-start-session");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const startSessionFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Fiber.join(startSessionFiber).pipe(Effect.timeout("10 seconds"));

      // Forked, and the assertion waits on the projected event rather than on
      // sendTurn: with the consumer dead the turn never settles, so awaiting it
      // directly would hang until the suite timeout instead of failing here.
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello grok", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(turnCompleted).pipe(Effect.timeout("10 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("10 seconds"));

      const delta = runtimeEvents.find(
        (event) => event.type === "content.delta" && String(event.threadId) === String(threadId),
      );
      assert.isDefined(
        delta,
        "no content.delta was projected after the startSession fiber completed",
      );
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
      // Live clock so the timeouts above are real: under the default test clock
      // they wait on virtual time that never advances, and a regression would
      // hang until the suite timeout instead of failing here.
    }).pipe(TestClock.withLive),
  );

  it.effect("steers only the exact active Grok turn through x.ai/interject", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-live-steer");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-steer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_HANG_PROMPT_FOREVER: "1",
          CAFE_CODE_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const started = yield* Deferred.make<TurnId>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.started" && event.turnId
          ? Deferred.succeed(started, event.turnId).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const promptFiber = yield* adapter
        .sendTurn({ threadId, input: "keep working", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"));

      const stale = yield* adapter
        .steerTurn({
          threadId,
          expectedTurnId: TurnId.make("stale-turn"),
          input: "stale guidance",
          attachments: [],
        })
        .pipe(Effect.flip);
      assert.equal(stale._tag, "ProviderAdapterValidationError");

      const steered = yield* adapter.steerTurn({
        threadId,
        expectedTurnId: turnId,
        input: "use the safer implementation",
        attachments: [],
      });
      assert.equal(steered.turnId, turnId);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const interjectRequest = requests.find((entry) => entry.method === "x.ai/interject");
      assert.isDefined(interjectRequest);
      assert.deepEqual(interjectRequest?.params, {
        sessionId: "mock-session-1",
        text: "use the safer implementation",
        interjectionId: (interjectRequest?.params as { interjectionId?: unknown })?.interjectionId,
      });
      assert.isString((interjectRequest?.params as { interjectionId?: unknown })?.interjectionId);

      yield* adapter.interruptTurn(threadId, turnId);
      yield* Fiber.join(promptFiber).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("round-trips xAI plan approval and emits the proposed plan", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-plan-approval");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ CAFE_CODE_ACP_EMIT_XAI_EXIT_PLAN_MODE: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)).pipe(
          Effect.andThen(
            event.type === "request.opened" && event.requestId
              ? adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.make(String(event.requestId)),
                  "accept",
                )
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "make a plan",
        attachments: [],
        interactionMode: "plan",
      });
      yield* waitForSessionReady(adapter, threadId);

      assert.isTrue(events.some((event) => event.type === "turn.proposed.completed"));
      assert.isTrue(events.some((event) => event.type === "request.resolved"));
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("reports monotonic xAI usage and persists its resume baseline", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-usage");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-usage-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ CAFE_CODE_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const usageEvents: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (event.type === "thread.token-usage.updated") usageEvents.push(event);
        }),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      yield* waitForSessionReady(adapter, threadId);
      yield* adapter.sendTurn({ threadId, input: "second", attachments: [] });
      yield* waitForSessionReady(adapter, threadId);
      const used = usageEvents.flatMap((event) =>
        event.type === "thread.token-usage.updated" ? [event.payload.usage.usedTokens] : [],
      );
      assert.deepEqual(
        used,
        [...used].toSorted((left, right) => left - right),
      );
      assert.isAbove(used.at(-1) ?? 0, 0);
      const snapshots = usageEvents.flatMap((event) =>
        event.type === "thread.token-usage.updated" ? [event.payload.usage] : [],
      );
      assert.deepInclude(snapshots[0] ?? {}, {
        usedTokens: 15,
        maxTokens: 500_000,
        inputTokens: 10,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 2,
      });
      assert.deepInclude(snapshots[1] ?? {}, {
        usedTokens: 25,
        totalProcessedTokens: 30,
        maxTokens: 500_000,
        inputTokens: 20,
        outputTokens: 5,
        totalOutputTokens: 10,
        reasoningOutputTokens: 2,
      });
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "_x.ai/session/usage"));
      assert.isFalse(requests.some((entry) => entry.method === "x.ai/session/usage"));
      const session = (yield* adapter.listSessions())[0];
      assert.deepInclude(session?.resumeCursor as Record<string, unknown>, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("falls back to the unprefixed Grok usage method only on method-not-found", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-usage-method-fallback");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-usage-fallback-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          CAFE_CODE_ACP_DISABLE_UNDERSCORE_USAGE: "1",
          CAFE_CODE_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "measure this", attachments: [] });
      yield* waitForSessionReady(adapter, threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "_x.ai/session/usage"));
      assert.isTrue(requests.some((entry) => entry.method === "x.ai/session/usage"));
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rewinds only Grok conversation state through the native xAI extension", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-native-rewind");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-rewind-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ CAFE_CODE_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      yield* waitForSessionReady(adapter, threadId);
      yield* adapter.sendTurn({ threadId, input: "second", attachments: [] });
      yield* waitForSessionReady(adapter, threadId);

      const snapshot = yield* adapter.rollbackThread(threadId, 1);
      assert.strictEqual(snapshot.turns.length, 1);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(requests.some((entry) => entry.method === "_x.ai/rewind/points"));
      assert.isTrue(
        requests.some(
          (entry) =>
            entry.method === "_x.ai/rewind/execute" &&
            typeof entry.params === "object" &&
            entry.params !== null &&
            "mode" in entry.params &&
            entry.params.mode === "conversation_only" &&
            "targetPromptIndex" in entry.params &&
            entry.params.targetPromptIndex === 1,
        ),
      );
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("controls Grok goals through slash commands and structured provider state", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-goal-control");
      const grokHome = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-goal-home-")),
      );
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeGrokAdapter(
        decodeGrokSettings({ binaryPath: wrapperPath, homePath: grokHome }),
        { sessionCredentials: testSessionCredentials },
      ).pipe(Effect.orDie);
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });

      const started = yield* adapter.setGoal!({
        threadId,
        objective: "Finish the repository review",
        status: "active",
        tokenBudget: null,
      });
      assert.equal(started?.objective, "Finish the repository review");
      assert.equal(started?.status, "active");

      const paused = yield* adapter.setGoal!({ threadId, status: "paused" });
      assert.equal(paused?.status, "paused");
      const resumed = yield* adapter.setGoal!({ threadId, status: "active" });
      assert.equal(resumed?.status, "active");
      assert.equal((yield* adapter.getGoal!(threadId))?.objective, "Finish the repository review");

      const budgetError = yield* adapter.setGoal!({ threadId, tokenBudget: 10_000 }).pipe(
        Effect.flip,
      );
      assert.equal(budgetError?._tag, "ProviderAdapterValidationError");

      assert.deepEqual(yield* adapter.clearGoal!(threadId), { cleared: true });
      assert.isNull(yield* adapter.getGoal!(threadId));
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("revokes the scoped Cafe MCP credential without logging its bearer", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-mcp-credential");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const secretToken = "mcp-secret-token-that-must-not-be-logged";
      const authSessionId = AuthSessionId.make("grok-mcp-auth-session");
      const revoked = yield* Ref.make<ReadonlyArray<string>>([]);
      const nativeRecords: unknown[] = [];
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-mcp-redaction",
          write: (record: unknown) => Effect.sync(() => nativeRecords.push(record)),
          close: () => Effect.void,
        },
        sessionCredentials: {
          issue: () =>
            DateTime.now.pipe(
              Effect.map((expiresAt) => ({
                sessionId: authSessionId,
                token: secretToken,
                method: "bearer-session-token" as const,
                client: { deviceType: "bot" as const },
                expiresAt,
                role: "owner" as const,
              })),
            ),
          revoke: (sessionId) =>
            Ref.update(revoked, (ids) => [...ids, String(sessionId)]).pipe(Effect.as(true)),
        },
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.stopSession(threadId);

      assert.deepEqual(yield* Ref.get(revoked), [String(authSessionId)]);
      assert.notInclude(JSON.stringify(nativeRecords), secretToken);
    }),
  );
});
