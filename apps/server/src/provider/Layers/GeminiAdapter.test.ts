// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url";

import {
  ApprovalRequestId,
  GeminiSettings,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type UsageAccountingSnapshot,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import * as ManagementMcp from "../../mcp/sessionConnection.ts";
import { makeGeminiAdapter } from "./GeminiAdapter.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cafecode-gemini-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const fixtureFile = fileURLToPath(new URL("../testUtils/geminiAcpFixture.cjs", import.meta.url));

const makeFixtureAdapter = Effect.fnUntraced(function* (environment: NodeJS.ProcessEnv = {}) {
  const config = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // Exercise the real stdio transport even on Windows, without relying on
  // shell launchers or adding a test-only adapter injection.
  const fixtureSpawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand" || command.command !== process.execPath) {
      return spawner.spawn(command);
    }
    return spawner.spawn(
      ChildProcess.make(process.execPath, [fixtureFile, ...command.args], {
        ...command.options,
        env: {
          ...command.options.env,
          ...environment,
          CAFE_GEMINI_FIXTURE_NATIVE_VERSION: "1.5.13",
        },
      }),
    );
  });
  const instanceId = ProviderInstanceId.make("gemini-fixture");
  const threadId = ThreadId.make("gemini-thread");
  const modelSelection = {
    instanceId,
    model: "gemini-4-neon",
    options: [{ id: "reasoningEffort", value: "low" }],
  };
  const adapter = yield* makeGeminiAdapter(
    Schema.decodeUnknownSync(GeminiSettings)({ enabled: true, binaryPath: process.execPath }),
    { instanceId },
  ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fixtureSpawner));
  return {
    adapter,
    instanceId,
    modelSelection,
    threadId,
    start: { threadId, cwd: config.cwd, runtimeMode: "full-access", modelSelection } as const,
  };
});

it.live(
  "mounts a distinct Cafe MCP bridge on Gemini open and resume and retires both bindings",
  () =>
    Effect.gen(function* () {
      const retired: string[] = [];
      let nextBinding = 1;
      const bind = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(ManagementMcp, "makeManagementMcpSession").mockImplementation(() => {
            const generation = nextBinding++;
            const name = `cafe-code-fixture-${generation}`;
            return Effect.succeed({
              name,
              launch: {
                command: process.execPath,
                args: [`fixture-bridge-${generation}`, `fixture-connection-${generation}`],
                env: { ELECTRON_RUN_AS_NODE: "1" },
              },
              dispose: Effect.sync(() => {
                retired.push(name);
              }),
            });
          }),
        ),
        (spy) => Effect.sync(() => void spy.mockRestore()),
      );
      const { adapter, threadId, instanceId, start } = yield* makeFixtureAdapter({
        CAFE_GEMINI_FIXTURE_EXPECT_MANAGEMENT_MCP: "true",
      });
      const opened = yield* adapter.startSession(start);
      assert.isDefined(opened.resumeCursor);
      assert.deepEqual(retired, []);
      yield* adapter.stopSession(threadId);
      assert.deepEqual(retired, ["cafe-code-fixture-1"]);

      yield* adapter.startSession({ ...start, resumeCursor: opened.resumeCursor });
      assert.deepEqual(bind.mock.calls, [
        [{ threadId, providerInstanceId: instanceId }],
        [{ threadId, providerInstanceId: instanceId }],
      ]);
      assert.deepEqual(retired, ["cafe-code-fixture-1"]);
      yield* adapter.stopSession(threadId);
      assert.deepEqual(retired, ["cafe-code-fixture-1", "cafe-code-fixture-2"]);
    }).pipe(Effect.provide(configLayer)),
);

it.live(
  "delivers a qualified Gemini prompt, permits only its one-time approval, and stops the resumed owner",
  () =>
    Effect.gen(function* () {
      const { adapter, threadId, instanceId, modelSelection, start } = yield* makeFixtureAdapter();

      const approval = yield* Deferred.make<ApprovalRequestId>();
      const completed = yield* Deferred.make<void>();
      const resumedText = yield* Deferred.make<void>();
      const deltas: string[] = [];
      const usage: number[] = [];
      const accounting: UsageAccountingSnapshot[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          assert.equal(event.threadId, threadId);
          assert.equal(event.providerInstanceId, instanceId);
          if (event.type === "request.opened") {
            assert.equal(event.payload.detail, "ls");
            if (!event.requestId) throw new Error("Expected the native approval request identity.");
            yield* Deferred.succeed(approval, ApprovalRequestId.make(event.requestId));
          }
          if (event.type === "content.delta") {
            deltas.push(event.payload.delta);
            if (event.payload.delta === "Resumed foreground turn is running.") {
              yield* Deferred.succeed(resumedText, undefined);
            }
          }
          if (event.type === "thread.token-usage.updated") {
            usage.push(event.payload.usage.usedTokens ?? -1);
          }
          if (event.type === "thread.usage-accounting.updated") accounting.push(event.payload);
          if (event.type === "turn.completed" && event.payload.state === "completed") {
            yield* Deferred.succeed(completed, undefined);
          }
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));

      const opened = yield* adapter.startSession(start);
      assert.isDefined(opened.resumeCursor);
      const first = yield* adapter.sendTurn({ threadId, input: "Hello Gemini", modelSelection });
      assert.deepEqual(first.resolvedGeminiConfiguration, {
        model: "gemini-4-neon",
        effort: "low",
      });
      const requestId = yield* Deferred.await(approval);
      yield* adapter.respondToRequest(threadId, requestId, "acceptForSession").pipe(Effect.flip);
      yield* adapter.respondToRequest(threadId, requestId, "accept");
      yield* Deferred.await(completed);
      assert.deepEqual(deltas, ["Using low effort and one-time approval."]);
      assert.deepEqual(usage, [23]);
      assert.deepEqual(
        accounting.map(({ scopeId: _, ...sample }) => sample),
        [
          {
            revision: 1,
            completeness: "complete",
            models: [
              {
                model: "gemini-4-neon",
                inputTokens: 9_230,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 509,
                reasoningOutputTokens: 393,
              },
            ],
          },
        ],
      );
      yield* adapter.stopSession(threadId);

      yield* adapter
        .startSession({
          ...start,
          threadId: ThreadId.make("foreign-thread"),
          resumeCursor: opened.resumeCursor,
        })
        .pipe(Effect.flip);
      yield* adapter.startSession({ ...start, resumeCursor: opened.resumeCursor });
      const resumed = yield* adapter.sendTurn({ threadId, input: "Continue" });
      yield* Deferred.await(resumedText);
      yield* adapter.interruptTurn(threadId, TurnId.make("stale-turn"));
      assert.isTrue(yield* adapter.hasSession(threadId));
      yield* adapter.interruptTurn(threadId, resumed.turnId);
      assert.isFalse(yield* adapter.hasSession(threadId));
    }).pipe(Effect.provide(configLayer)),
);

it.live(
  "keeps a Gemini turn active until its admitted follow-up and separates background output",
  () =>
    Effect.gen(function* () {
      const { adapter, threadId, modelSelection, start } = yield* makeFixtureAdapter();
      const initialOutput = yield* Deferred.make<void>();
      const approval = yield* Deferred.make<ApprovalRequestId>();
      const terminal = yield* Deferred.make<void>();
      const nextTerminal = yield* Deferred.make<void>();
      const background = yield* Deferred.make<ProviderRuntimeEvent>();
      const events: ProviderRuntimeEvent[] = [];
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (
            event.type === "content.delta" &&
            event.payload.delta === "Initial foreground output."
          ) {
            yield* Deferred.succeed(initialOutput, undefined);
          }
          if (event.type === "request.opened" && event.requestId) {
            yield* Deferred.succeed(approval, ApprovalRequestId.make(event.requestId));
          }
          if (event.type === "turn.completed") {
            const target = (yield* Deferred.isDone(terminal)) ? nextTerminal : terminal;
            yield* Deferred.succeed(target, undefined);
          }
          if (
            event.type === "item.updated" &&
            event.payload.detail === "Background task finished."
          ) {
            yield* Deferred.succeed(background, event);
          }
        }),
      ).pipe(Effect.forkScoped({ startImmediately: true }));

      yield* adapter.startSession(start);
      const root = yield* adapter.sendTurn({ threadId, input: "Start the steering fixture" });
      yield* Deferred.await(initialOutput);
      const followUp = yield* adapter.steerTurn({
        threadId,
        expectedTurnId: root.turnId,
        input: "Deliver this follow-up",
      });
      assert.equal(followUp.turnId, root.turnId);

      // The follow-up's actual native callback holds its RPC open after the
      // first RPC has ended. No clock or mock of the adapter decides ordering.
      const request = yield* Deferred.await(approval);
      assert.isFalse(yield* Deferred.isDone(terminal));
      yield* adapter.respondToRequest(threadId, request, "accept");
      yield* Deferred.await(terminal);

      const next = yield* adapter.sendTurn({
        threadId,
        input: "Start the next foreground",
        modelSelection: { ...modelSelection, options: [{ id: "reasoningEffort", value: "high" }] },
      });
      const detached = yield* Deferred.await(background);
      yield* Deferred.await(nextTerminal);
      assert.equal(detached.turnId, root.turnId);
      assert.notEqual(next.turnId, root.turnId);

      const transcript = events.flatMap((event) => {
        if (event.turnId !== root.turnId) return [];
        if (event.type === "content.delta") return [event.payload.delta];
        if (event.type === "turn.completed") return [`terminal:${event.payload.state}`];
        return [];
      });
      assert.deepEqual(transcript, [
        "Initial foreground output.",
        "Follow-up reached the agent.",
        "terminal:completed",
      ]);
      const accounting = events.filter((event) => event.type === "thread.usage-accounting.updated");
      assert.deepEqual(
        accounting.map(({ turnId, payload: { scopeId: _, ...sample } }) => ({ turnId, ...sample })),
        [
          {
            turnId: root.turnId,
            revision: 1,
            completeness: "partial",
            models: [
              {
                model: "gemini-4-neon",
                inputTokens: 9_839,
                cachedInputTokens: 7_173,
                cacheWriteInputTokens: 0,
                outputTokens: 29,
                reasoningOutputTokens: 27,
              },
            ],
          },
        ],
      );
    }).pipe(Effect.provide(configLayer)),
);
