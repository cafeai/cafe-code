import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";

import * as AcpClient from "./client.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpError from "./errors.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const InitializeRequest = jsonRpcRequest("initialize", AcpSchema.InitializeRequest);
const InitializeResponse = jsonRpcResponse(AcpSchema.InitializeResponse);
const ExtRequest = jsonRpcRequest("x/test", Schema.Struct({ hello: Schema.String }));
const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));
const PromptRequest = jsonRpcRequest("session/prompt", AcpSchema.PromptRequest);
const PromptResponse = jsonRpcResponse(AcpSchema.PromptResponse);
const decodePromptRequestLine = Schema.decodeEffect(Schema.fromJsonString(PromptRequest));
const XAiPromptCompleteNotification = jsonRpcNotification(
  "_x.ai/session/prompt_complete",
  Schema.Struct({
    sessionId: Schema.String,
    promptId: Schema.String,
    stopReason: Schema.String,
    agentResult: Schema.NullOr(Schema.Unknown),
  }),
);
const XAiQueueChangedNotification = jsonRpcNotification(
  "_x.ai/queue/changed",
  Schema.Struct({
    sessionId: Schema.String,
    entries: Schema.Array(Schema.Unknown),
  }),
);
const XAiSessionsChangedNotification = jsonRpcNotification(
  "_x.ai/sessions/changed",
  Schema.Struct({
    upserted: Schema.Array(Schema.Unknown),
    removed: Schema.Array(Schema.Unknown),
  }),
);
const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

// These integration tests start a fresh Node process that imports the TypeScript
// ACP fixture and Effect runtime. GitHub's fully parallel Turbo run can starve
// that startup past Vitest's 5-second default even though the protocol exchange
// itself remains fast. Keep the larger allowance local to process-backed tests;
// Windows receives extra headroom for its consistently slower process startup.
const CHILD_PROCESS_TEST_TIMEOUT_MS = process.platform === "win32" ? 30_000 : 15_000;

type NativeAcpFixturePhase =
  | "spawn"
  | "build-client"
  | "register-handlers"
  | "initialize"
  | "authenticate"
  | "create-session"
  | "prompt"
  | "collect-two-notifications"
  | "echo"
  | "close-client-scope"
  | "assert-echo"
  | "body-complete";

interface NativeAcpFixtureObservation {
  readonly event: "abort" | "failure";
  readonly observedPhase: NativeAcpFixturePhase;
  readonly firstFailurePhase: NativeAcpFixturePhase;
  readonly observationCount: number;
  readonly elapsedMs: number;
}

function logNativeAcpFixtureObservation(observation: NativeAcpFixtureObservation): void {
  // Public Vitest/AbortSignal callbacks are imperative native callbacks.
  // This synchronous boundary starts no asynchronous or scoped work.
  // Diagnostic defects are ignored without logging their opaque causes.
  Effect.runSync(
    Effect.logError("ACP native fixture diagnostic").pipe(
      Effect.annotateLogs({
        event: observation.event,
        observedPhase: observation.observedPhase,
        firstFailurePhase: observation.firstFailurePhase,
        observationCount: observation.observationCount,
        elapsedMs: observation.elapsedMs,
      }),
      Effect.catchCause(() => Effect.void),
    ),
  );
}

function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const batch = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    batch.set(chunk, offset);
    offset += chunk.length;
  }
  return batch;
}

it.layer(NodeServices.layer)("effect-acp client", (it) => {
  const childProcessTest = (name: string, self: Parameters<typeof it.effect>[1]): void =>
    it.effect(name, self, CHILD_PROCESS_TEST_TIMEOUT_MS);

  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: path.join(import.meta.dirname, ".."),
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  childProcessTest(
    "initializes, prompts, receives updates, and handles permission requests",
    (ctx) =>
      Effect.gen(function* () {
        // Passive failure-only observations cannot establish a timeout's cause.
        // These fixed fields never include protocol text, native output, process
        // identity, paths, environment, payloads, or the original exception.
        let phase: NativeAcpFixturePhase = "spawn";
        let firstFailurePhase: NativeAcpFixturePhase | undefined;
        let emitted = 0;
        const startedAt = performance.now();
        const freezeFirstFailurePhase = (): void => {
          firstFailurePhase ??= phase;
        };
        const report = (event: "abort" | "failure"): void => {
          if (emitted >= 2) return;
          freezeFirstFailurePhase();
          emitted += 1;
          logNativeAcpFixtureObservation({
            event,
            observedPhase: phase,
            firstFailurePhase: firstFailurePhase ?? phase,
            observationCount: emitted,
            elapsedMs: Math.min(60_000, Math.max(0, Math.floor(performance.now() - startedAt))),
          });
        };
        const onAbort = (): void => report("abort");
        // The pinned adapter already joins Effect's exact cancellation promise
        // and native child finalizers. This listener starts and owns no work.
        ctx.onTestFailed(() => report("failure"));
        ctx.onTestFinished(() => ctx.signal.removeEventListener("abort", onAbort));
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal.aborted) onAbort();
        const updates = yield* Ref.make<Array<unknown>>([]);
        const elicitationCompletions = yield* Ref.make<Array<unknown>>([]);
        const typedRequests = yield* Ref.make<Array<unknown>>([]);
        const typedNotifications = yield* Ref.make<Array<unknown>>([]);
        const handle = yield* makeHandle();
        const scope = yield* Scope.make();
        const acpLayer = AcpClient.layerChildProcess(handle);
        phase = "build-client";
        const context = yield* Layer.buildWithScope(acpLayer, scope);

        const ext = yield* Effect.gen(function* () {
          const acp = yield* AcpClient.AcpClient;

          phase = "register-handlers";
          yield* acp.handleRequestPermission(() =>
            Effect.succeed({
              outcome: {
                outcome: "selected",
                optionId: "allow",
              },
            }),
          );
          yield* acp.handleElicitation(() =>
            Effect.succeed({
              action: {
                action: "accept",
                content: {
                  approved: true,
                },
              },
            }),
          );
          yield* acp.handleSessionUpdate((notification) =>
            Ref.update(updates, (current) => [...current, notification]),
          );
          yield* acp.handleElicitationComplete((notification) =>
            Ref.update(elicitationCompletions, (current) => [...current, notification]),
          );
          yield* acp.handleExtRequest(
            "x/typed_request",
            Schema.Struct({ message: Schema.String }),
            (payload) =>
              Ref.update(typedRequests, (current) => [...current, payload]).pipe(
                Effect.as({
                  ok: true,
                  echoedMessage: payload.message,
                }),
              ),
          );
          yield* acp.handleExtNotification(
            "x/typed_notification",
            Schema.Struct({ count: Schema.Number }),
            (payload) => Ref.update(typedNotifications, (current) => [...current, payload]),
          );

          phase = "initialize";
          const init = yield* acp.agent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: {
              name: "effect-acp-test",
              version: "0.0.0",
            },
          });
          assert.equal(init.protocolVersion, 1);

          phase = "authenticate";
          yield* acp.agent.authenticate({ methodId: "cursor_login" });

          phase = "create-session";
          const session = yield* acp.agent.createSession({
            cwd: process.cwd(),
            mcpServers: [],
          });
          assert.equal(session.sessionId, "mock-session-1");

          phase = "prompt";
          const prompt = yield* acp.agent.prompt({
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "hello" }],
          });
          assert.equal(prompt.stopReason, "end_turn");

          phase = "collect-two-notifications";
          const streamed = yield* Stream.runCollect(Stream.take(acp.raw.notifications, 2));
          assert.equal(streamed.length, 2);
          assert.equal(streamed[0]?._tag, "SessionUpdate");
          assert.equal(streamed[1]?._tag, "ElicitationComplete");
          assert.equal((yield* Ref.get(updates)).length, 1);
          assert.equal((yield* Ref.get(elicitationCompletions)).length, 1);
          assert.deepEqual(yield* Ref.get(typedRequests), [
            { message: "hello from typed request" },
          ]);
          assert.deepEqual(yield* Ref.get(typedNotifications), [{ count: 2 }]);

          phase = "echo";
          return yield* acp.raw.request("x/echo", {
            hello: "world",
          });
        }).pipe(
          // Capture the original failed phase before the existing ensuring close
          // runs. Later observations report cleanup separately and cannot rewrite
          // this first failure's phase. Abort snapshots use the same one-use slot.
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) freezeFirstFailurePhase();
            }),
          ),
          Effect.provide(context),
          Effect.ensuring(
            Effect.sync(() => {
              phase = "close-client-scope";
            }).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
          ),
        );

        phase = "assert-echo";
        assert.deepEqual(ext, {
          echoedMethod: "x/echo",
          echoedParams: {
            hello: "world",
          },
        });
        phase = "body-complete";
      }),
  );

  childProcessTest(
    "returns structured invalid params without exposing values from typed extension request payloads",
    () =>
      Effect.gen(function* () {
        const handle = yield* makeHandle({ ACP_MOCK_BAD_TYPED_REQUEST: "1" });
        const scope = yield* Scope.make();
        const acpLayer = AcpClient.layerChildProcess(handle);
        const context = yield* Layer.buildWithScope(acpLayer, scope);

        const result = yield* Effect.gen(function* () {
          const acp = yield* AcpClient.AcpClient;

          yield* acp.handleRequestPermission(() =>
            Effect.succeed({
              outcome: {
                outcome: "selected",
                optionId: "allow",
              },
            }),
          );
          yield* acp.handleElicitation(() =>
            Effect.succeed({
              action: {
                action: "accept",
                content: {
                  approved: true,
                },
              },
            }),
          );
          yield* acp.handleExtRequest(
            "x/typed_request",
            Schema.Struct({ message: Schema.String }),
            () => Effect.succeed({ ok: true }),
          );

          yield* acp.agent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: {
              name: "effect-acp-test",
              version: "0.0.0",
            },
          });

          yield* acp.agent.authenticate({ methodId: "cursor_login" });

          const session = yield* acp.agent.createSession({
            cwd: process.cwd(),
            mcpServers: [],
          });

          return yield* Effect.exit(
            acp.agent.prompt({
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "hello" }],
            }),
          );
        }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

        if (result._tag !== "Failure") {
          assert.fail("Expected prompt to fail for invalid typed extension payload");
        }
        const rendered = Cause.pretty(result.cause);
        assert.include(rendered, "ACP method 'session/prompt' failed with code -32602.");
        assert.notInclude(rendered, "Invalid payload for ACP extension method");
        assert.notInclude(rendered, "Expected string, got 123");
      }),
  );

  childProcessTest("replays buffered notifications to handlers registered after they arrive", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<Array<unknown>>([]);
      const elicitationCompletions = yield* Ref.make<Array<unknown>>([]);
      const typedRequests = yield* Ref.make<Array<unknown>>([]);
      const typedNotifications = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const acpLayer = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(acpLayer, scope);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;

        yield* acp.handleRequestPermission(() =>
          Effect.succeed({
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          }),
        );
        yield* acp.handleElicitation(() =>
          Effect.succeed({
            action: {
              action: "accept",
              content: {
                approved: true,
              },
            },
          }),
        );
        yield* acp.handleExtRequest(
          "x/typed_request",
          Schema.Struct({ message: Schema.String }),
          (payload) =>
            Ref.update(typedRequests, (current) => [...current, payload]).pipe(
              Effect.as({
                ok: true,
                echoedMessage: payload.message,
              }),
            ),
        );
        yield* acp.handleExtNotification(
          "x/typed_notification",
          Schema.Struct({ count: Schema.Number }),
          (payload) => Ref.update(typedNotifications, (current) => [...current, payload]),
        );

        yield* acp.agent.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        });
        yield* acp.agent.authenticate({ methodId: "cursor_login" });

        const session = yield* acp.agent.createSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        });

        yield* acp.handleSessionUpdate((notification) =>
          Ref.update(updates, (current) => [...current, notification]),
        );
        yield* acp.handleElicitationComplete((notification) =>
          Ref.update(elicitationCompletions, (current) => [...current, notification]),
        );

        assert.equal((yield* Ref.get(updates)).length, 1);
        assert.equal((yield* Ref.get(elicitationCompletions)).length, 1);
        assert.deepEqual(yield* Ref.get(typedRequests), [{ message: "hello from typed request" }]);
        assert.deepEqual(yield* Ref.get(typedNotifications), [{ count: 2 }]);
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
  );

  it.effect("continues dispatching session updates after one handler fails", () =>
    Effect.gen(function* () {
      const failedHandlers = yield* Ref.make(0);
      const successfulHandlers = yield* Ref.make(0);
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const { stdio, input } = yield* makeInMemoryStdio();
      const acp = yield* AcpClient.make(stdio);
      yield* acp.handleSessionUpdate(() =>
        Ref.update(failedHandlers, (count) => count + 1).pipe(
          Effect.andThen(
            Effect.fail(AcpError.AcpRequestError.internalError("session update handler failed")),
          ),
        ),
      );
      yield* acp.handleSessionUpdate(() =>
        Ref.updateAndGet(successfulHandlers, (count) => count + 1).pipe(
          Effect.flatMap((count) => Deferred.succeed(count === 1 ? first : second, undefined)),
          Effect.asVoid,
        ),
      );
      const notification = yield* encodeJsonl(
        jsonRpcNotification("session/update", AcpSchema.SessionNotification),
        {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "handler-failure-fixture",
            update: { sessionUpdate: "plan", entries: [] },
          },
        },
      );
      // Exercise the real wire decoder and dispatcher, without making pure
      // handler-failure behavior depend on another native process starting.
      yield* Queue.offer(input, notification);
      yield* Deferred.await(first);
      assert.equal(yield* Ref.get(failedHandlers), 1);
      assert.equal(yield* Ref.get(successfulHandlers), 1);
      yield* Queue.offer(input, notification);
      yield* Deferred.await(second);
      assert.equal(yield* Ref.get(failedHandlers), 2);
      assert.equal(yield* Ref.get(successfulHandlers), 2);
    }),
  );

  it.effect(
    "ignores uncorrelatable response IDs while preserving live calls and textual callback identities",
    () =>
      Effect.gen(function* () {
        const encoder = new TextEncoder();
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const acp = yield* AcpClient.make(stdio);
        yield* acp.handleUnknownExtRequest(() => Effect.succeed({ ok: true }));
        const pending = yield* acp.agent
          .initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "response-id-fixture", version: "1" },
          })
          .pipe(Effect.forkScoped);
        const request = JSON.parse(yield* Queue.take(output));
        const valid = {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: { name: "fixture", version: "1" },
          },
        };
        yield* Queue.offer(
          input,
          encoder.encode(
            JSON.stringify([
              { jsonrpc: "2.0", id: "skills-reload", result: null },
              {
                jsonrpc: "2.0",
                id: "skills-reload",
                error: { code: -32601, message: "Unknown callback" },
              },
              { jsonrpc: "2.0", id: "1.5", result: null },
              { jsonrpc: "2.0", id: "9".repeat(1025), result: null },
              valid,
            ]) + "\n",
          ),
        );
        assert.deepEqual(yield* Fiber.join(pending), valid.result);
        yield* Queue.offer(
          input,
          encoder.encode(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "skills-reload",
              method: "x/id-check",
              params: {},
            }) + "\n",
          ),
        );
        assert.deepEqual(JSON.parse(yield* Queue.take(output)), {
          jsonrpc: "2.0",
          id: "skills-reload",
          result: { ok: true },
        });
      }),
  );

  it.effect("uses distinct ids for RPC calls and extension requests", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));

      const initializeFiber = yield* acp.agent
        .initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        })
        .pipe(Effect.forkScoped);
      const extFiber = yield* acp.raw.request("x/test", { hello: "world" }).pipe(Effect.forkScoped);

      const firstOutbound = yield* Queue.take(output);
      const secondOutbound = yield* Queue.take(output);

      const decodedInitialize = Schema.decodeEffect(Schema.fromJsonString(InitializeRequest));
      const decodedExt = Schema.decodeEffect(Schema.fromJsonString(ExtRequest));
      const firstIsInitialize = yield* decodedInitialize(firstOutbound).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: () => true,
        }),
      );

      const initializeRequest = firstIsInitialize
        ? yield* decodedInitialize(firstOutbound)
        : yield* decodedInitialize(secondOutbound);
      const extRequest = firstIsInitialize
        ? yield* decodedExt(secondOutbound)
        : yield* decodedExt(firstOutbound);

      assert.notEqual(initializeRequest.id, extRequest.id);

      yield* Queue.offer(
        input,
        yield* encodeJsonl(InitializeResponse, {
          jsonrpc: "2.0",
          id: initializeRequest.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: {
              name: "mock-agent",
              version: "0.0.0",
            },
          },
        }),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: extRequest.id,
          result: { ok: true },
        }),
      );

      yield* Fiber.join(initializeFiber);
      assert.deepEqual(yield* Fiber.join(extFiber), { ok: true });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "routes a standard prompt response after Grok extension notifications in the same batch",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const scope = yield* Scope.make();
        const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));

        const promptFiber = yield* acp.agent
          .prompt({
            sessionId: "grok-session-1",
            prompt: [{ type: "text", text: "run the ls command" }],
          })
          .pipe(Effect.forkScoped);

        const outbound = yield* Queue.take(output);
        const decodedPrompt = yield* decodePromptRequestLine(outbound);

        const responseBatch = concatBytes(
          yield* Effect.all([
            encodeJsonl(XAiQueueChangedNotification, {
              jsonrpc: "2.0",
              method: "_x.ai/queue/changed",
              params: { sessionId: "grok-session-1", entries: [] },
            }),
            encodeJsonl(XAiPromptCompleteNotification, {
              jsonrpc: "2.0",
              method: "_x.ai/session/prompt_complete",
              params: {
                sessionId: "grok-session-1",
                promptId: "prompt-1",
                stopReason: "end_turn",
                agentResult: null,
              },
            }),
            encodeJsonl(XAiSessionsChangedNotification, {
              jsonrpc: "2.0",
              method: "_x.ai/sessions/changed",
              params: {
                upserted: [
                  {
                    sessionId: "grok-session-1",
                    title: null,
                    cwd: process.cwd(),
                    isWorktree: false,
                    modelId: "grok-composer-2.5-fast",
                    yolo: false,
                    activity: "idle",
                    resident: true,
                    lastChangeUnixMs: 1_710_000_000_000,
                    origin: { kind: "local" },
                  },
                ],
                removed: [],
              },
            }),
            encodeJsonl(PromptResponse, {
              jsonrpc: "2.0",
              id: decodedPrompt.id,
              result: {
                stopReason: "end_turn",
                _meta: {
                  sessionId: "grok-session-1",
                  requestId: "prompt-1",
                  promptId: "prompt-1",
                  modelId: "grok-composer-2.5-fast",
                },
              },
            }),
          ]),
        );
        yield* Queue.offer(input, responseBatch);

        assert.deepEqual(yield* Fiber.join(promptFiber), {
          stopReason: "end_turn",
          _meta: {
            sessionId: "grok-session-1",
            requestId: "prompt-1",
            promptId: "prompt-1",
            modelId: "grok-composer-2.5-fast",
          },
        });
        yield* Scope.close(scope, Exit.void);
      }),
  );
});
