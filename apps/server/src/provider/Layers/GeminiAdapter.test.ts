// @effect-diagnostics nodeBuiltinImport:off
import { fileURLToPath } from "node:url";

import {
  ApprovalRequestId,
  GeminiSettings,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { makeGeminiAdapter } from "./GeminiAdapter.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "cafecode-gemini-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));
const fixtureFile = fileURLToPath(new URL("../testUtils/geminiAcpFixture.cjs", import.meta.url));

it.live(
  "delivers a qualified Gemini prompt, permits only its one-time approval, and stops the resumed owner",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Exercise the real stdio transport even on Windows, without relying on
      // shell launchers or adding a test-only adapter injection.
      const fixtureSpawner = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand" || command.command !== process.execPath) {
          return spawner.spawn(command);
        }
        return spawner.spawn(
          ChildProcess.make(process.execPath, [fixtureFile, ...command.args], command.options),
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
      const start = {
        threadId,
        cwd: config.cwd,
        runtimeMode: "full-access",
        modelSelection,
      } as const;

      const approval = yield* Deferred.make<ApprovalRequestId>();
      const completed = yield* Deferred.make<void>();
      const resumedText = yield* Deferred.make<void>();
      const deltas: string[] = [];
      const usage: number[] = [];
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
