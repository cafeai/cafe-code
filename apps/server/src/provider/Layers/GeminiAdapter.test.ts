import {
  ApprovalRequestId,
  GeminiSettings,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
} from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import type { AcpParsedSessionEvent, AcpSessionModeState } from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntimeOptions, AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeGeminiAdapter, readGeminiResumeSessionId } from "./GeminiAdapter.ts";

const decodeGeminiSettings = Schema.decodeSync(GeminiSettings);
const instanceId = ProviderInstanceId.make("gemini");

type PermissionHandler = Parameters<AcpSessionRuntimeShape["handleRequestPermission"]>[0];

class FakeGeminiRuntime {
  readonly promptCalls: EffectAcpSchema.PromptRequest[] = [];
  readonly requestCalls: Array<{ readonly method: string; readonly payload: unknown }> = [];
  readonly setModelCalls: string[] = [];
  readonly cancelCalls: void[] = [];
  permissionHandler: PermissionHandler | undefined;
  private readonly events: Queue.Queue<AcpParsedSessionEvent>;
  private promptRelease: Deferred.Deferred<void> | undefined;
  private promptStarted: Deferred.Deferred<void> | undefined;

  constructor(events: Queue.Queue<AcpParsedSessionEvent>) {
    this.events = events;
  }

  holdNextPrompt(input: {
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  }): void {
    this.promptStarted = input.started;
    this.promptRelease = input.release;
  }

  readonly shape: AcpSessionRuntimeShape = {
    handleRequestPermission: (handler) =>
      Effect.sync(() => {
        this.permissionHandler = handler;
      }),
    handleElicitation: () => Effect.void,
    handleReadTextFile: () => Effect.void,
    handleWriteTextFile: () => Effect.void,
    handleCreateTerminal: () => Effect.void,
    handleTerminalOutput: () => Effect.void,
    handleTerminalWaitForExit: () => Effect.void,
    handleTerminalKill: () => Effect.void,
    handleTerminalRelease: () => Effect.void,
    handleSessionUpdate: () => Effect.void,
    handleElicitationComplete: () => Effect.void,
    handleUnknownExtRequest: () => Effect.void,
    handleUnknownExtNotification: () => Effect.void,
    handleExtRequest: () => Effect.void,
    handleExtNotification: () => Effect.void,
    start: () =>
      Effect.succeed({
        sessionId: "gemini-session-1",
        initializeResult: {
          protocolVersion: 1,
        },
        sessionSetupResult: {
          sessionId: "gemini-session-1",
          configOptions: [],
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "plan", name: "Plan" },
            ],
          },
        },
        modelConfigId: undefined,
      }),
    getEvents: () => Stream.fromQueue(this.events),
    getModeState: Effect.sync((): AcpSessionModeState | undefined => undefined),
    getConfigOptions: Effect.succeed([]),
    prompt: (payload) =>
      Effect.sync(() => {
        this.promptCalls.push({ ...payload, sessionId: "gemini-session-1" });
        const started = this.promptStarted;
        const release = this.promptRelease;
        const events = this.events;
        this.promptStarted = undefined;
        this.promptRelease = undefined;
        return { events, started, release };
      }).pipe(
        Effect.flatMap(({ events, started, release }) =>
          Effect.gen(function* () {
            if (started) {
              yield* Deferred.succeed(started, undefined);
            }
            if (release) {
              yield* Deferred.await(release);
            }
            yield* Queue.offer(events, {
              _tag: "AssistantItemStarted",
              itemId: "assistant-1",
            });
            yield* Queue.offer(events, {
              _tag: "ContentDelta",
              itemId: "assistant-1",
              text: "Hello from Gemini",
              rawPayload: { text: "Hello from Gemini" },
            });
            yield* Queue.offer(events, {
              _tag: "AssistantItemCompleted",
              itemId: "assistant-1",
            });
            return {
              stopReason: "end_turn",
              ...(payload.messageId ? { userMessageId: payload.messageId } : {}),
            } satisfies EffectAcpSchema.PromptResponse;
          }),
        ),
      ),
    cancel: Effect.sync(() => {
      this.cancelCalls.push(undefined);
    }),
    setMode: () => Effect.succeed({}),
    setConfigOption: () => Effect.succeed({ configOptions: [] }),
    setModel: (model) =>
      Effect.sync(() => {
        this.setModelCalls.push(model);
      }),
    request: (method, payload) =>
      Effect.sync(() => {
        this.requestCalls.push({ method, payload });
        return {};
      }),
    notify: () => Effect.void,
  };

  invokePermission(
    request: EffectAcpSchema.RequestPermissionRequest,
  ): Effect.Effect<EffectAcpSchema.RequestPermissionResponse, EffectAcpErrors.AcpError> {
    if (!this.permissionHandler) {
      return Effect.die("permission handler was not registered");
    }
    return this.permissionHandler(request);
  }
}

function makeHarness() {
  return Effect.gen(function* () {
    const events = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const runtime = new FakeGeminiRuntime(events);
    const runtimeOptions: AcpSessionRuntimeOptions[] = [];
    const adapter = yield* makeGeminiAdapter(
      decodeGeminiSettings({
        binaryPath: "/usr/local/bin/gemini",
        authMethod: "gemini-api-key",
      }),
      {
        instanceId,
        makeRuntime: (input) =>
          Effect.sync(() => {
            runtimeOptions.push(input);
            return runtime.shape;
          }),
      },
    );

    return { adapter, runtime, runtimeOptions };
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest("/tmp/gemini-adapter-test", "/tmp").pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
}

describe("GeminiAdapter", () => {
  it("reads ACP session ids from resume cursors", () => {
    assert.equal(
      readGeminiResumeSessionId({ acpSessionId: " gemini-session-1 " }),
      "gemini-session-1",
    );
    assert.equal(readGeminiResumeSessionId({ threadId: "codex-thread" }), undefined);
  });

  it.effect("starts Gemini over ACP and emits renderer-visible turn events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-gemini-adapter");
        const { adapter, runtime, runtimeOptions } = yield* makeHarness();
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        const session = yield* adapter.startSession({
          threadId,
          providerInstanceId: instanceId,
          runtimeMode: "approval-required",
          modelSelection: createModelSelection(instanceId, "gemini-3-pro-preview"),
          cwd: "/tmp/gemini-adapter-test",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "Hello Gemini",
          interactionMode: "plan",
          modelSelection: createModelSelection(instanceId, "gemini-3-flash-preview"),
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        const eventTypes = new Set(events.map((event) => event.type));

        assert.deepEqual(
          runtimeOptions.map((input) => input.spawn),
          [
            {
              command: "/usr/local/bin/gemini",
              args: ["--acp"],
              cwd: "/tmp/gemini-adapter-test",
            },
          ],
        );
        assert.equal(runtimeOptions[0]?.authMethodId, "gemini-api-key");
        assert.deepEqual(runtime.setModelCalls, ["gemini-3-pro-preview", "gemini-3-flash-preview"]);
        assert.deepEqual(runtime.requestCalls, [
          {
            method: "session/set_mode",
            payload: {
              sessionId: "gemini-session-1",
              modeId: "plan",
            },
          },
        ]);
        assert.deepEqual(runtime.promptCalls[0]?.prompt, [{ type: "text", text: "Hello Gemini" }]);
        assert.deepEqual(session.resumeCursor, { acpSessionId: "gemini-session-1" });
        assert.deepEqual(turn.resumeCursor, { acpSessionId: "gemini-session-1" });
        assert.equal(eventTypes.has("session.started"), true);
        assert.equal(eventTypes.has("turn.started"), true);
        assert.equal(eventTypes.has("item.started"), true);
        assert.equal(eventTypes.has("content.delta"), true);
        assert.equal(eventTypes.has("item.completed"), true);
        assert.equal(eventTypes.has("turn.completed"), true);

        const delta = events.find((event) => event.type === "content.delta");
        assert.deepEqual(delta?.payload, {
          streamKind: "assistant_text",
          delta: "Hello from Gemini",
        });
      }),
    ),
  );

  it.effect("resumes ACP sessions from the persisted Gemini cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-gemini-resume");
        const { adapter, runtimeOptions } = yield* makeHarness();

        yield* adapter.startSession({
          threadId,
          providerInstanceId: instanceId,
          runtimeMode: "approval-required",
          resumeCursor: { acpSessionId: "existing-gemini-session" },
        });

        assert.equal(runtimeOptions[0]?.resumeSessionId, "existing-gemini-session");
      }),
    ),
  );

  it.effect("blocks overlapping prompts and maps interrupt to ACP cancel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-gemini-active-prompt");
        const { adapter, runtime } = yield* makeHarness();
        const promptStarted = yield* Deferred.make<void>();
        const releasePrompt = yield* Deferred.make<void>();

        yield* adapter.startSession({
          threadId,
          providerInstanceId: instanceId,
          runtimeMode: "approval-required",
        });
        runtime.holdNextPrompt({ started: promptStarted, release: releasePrompt });

        const firstPrompt = yield* adapter
          .sendTurn({
            threadId,
            input: "First prompt",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(promptStarted);

        const secondPrompt = yield* adapter
          .sendTurn({
            threadId,
            input: "Second prompt",
          })
          .pipe(Effect.exit);
        assert.equal(Exit.isFailure(secondPrompt), true);

        yield* adapter.interruptTurn(threadId);
        assert.equal(runtime.cancelCalls.length, 1);

        yield* Deferred.succeed(releasePrompt, undefined);
        yield* Fiber.join(firstPrompt);
      }),
    ),
  );

  it.effect("bridges ACP permission requests into Cafe approval events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-gemini-approval");
        const { adapter, runtime } = yield* makeHarness();
        const openedEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId,
          providerInstanceId: instanceId,
          runtimeMode: "approval-required",
        });

        const permissionFiber = yield* runtime
          .invokePermission({
            sessionId: "gemini-session-1",
            options: [
              {
                optionId: "allow-once",
                name: "Allow once",
                kind: "allow_once",
              },
            ],
            toolCall: {
              toolCallId: "tool-1",
              kind: "execute",
              title: "Run `ls`",
              rawInput: { command: "ls" },
            },
          })
          .pipe(Effect.forkChild);

        const openedEvents = Array.from(yield* Fiber.join(openedEventsFiber));
        const opened = openedEvents.find((event) => event.type === "request.opened");
        assert.ok(opened);
        assert.equal(opened.payload.requestType, "exec_command_approval");
        assert.equal(opened.payload.detail, "ls");

        const resolvedEventsFiber = yield* Stream.take(adapter.streamEvents, 1).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const requestId = ApprovalRequestId.make(String(opened.requestId).replace(/^gemini:/, ""));
        yield* adapter.respondToRequest(threadId, requestId, "accept");

        const response = yield* Fiber.join(permissionFiber);
        const resolvedEvents = Array.from(yield* Fiber.join(resolvedEventsFiber));
        const resolved = resolvedEvents[0] as ProviderRuntimeEvent | undefined;

        assert.deepEqual(response, {
          outcome: {
            outcome: "selected",
            optionId: "allow-once",
          },
        });
        assert.equal(resolved?.type, "request.resolved");
        assert.deepEqual(resolved?.payload, {
          requestType: "exec_command_approval",
          decision: "accept",
        });
      }),
    ),
  );
});
