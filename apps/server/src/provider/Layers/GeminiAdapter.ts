import {
  ApprovalRequestId,
  EventId,
  type GeminiSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderSession,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { acpPermissionOutcome, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest, type AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
} from "../acp/AcpSessionRuntime.ts";
import { GEMINI_ACP_ARGS, GEMINI_DEFAULT_AUTH_METHOD, GEMINI_PROVIDER } from "./GeminiProvider.ts";

type GeminiAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

interface PendingApproval {
  readonly permissionRequest: ReturnType<typeof parsePermissionRequest>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface GeminiSessionContext {
  session: ProviderSession;
  readonly runtime: AcpSessionRuntimeShape;
  readonly scope: Scope.Closeable;
  eventFiber?: Fiber.Fiber<void, never>;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }>;
  activeTurnId?: TurnId;
  stopped: boolean;
  promptActive: boolean;
}

export interface GeminiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (
    input: AcpSessionRuntimeOptions,
  ) => Effect.Effect<AcpSessionRuntimeShape, ProviderAdapterError, Scope.Scope>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readGeminiResumeSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = value.acpSessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0
    ? sessionId.trim()
    : undefined;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
const asRuntimeRequestId = (requestId: ApprovalRequestId) =>
  RuntimeRequestId.make(`gemini:${requestId}`);

function modeForTurn(input: {
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly interactionMode?: ProviderSendTurnInput["interactionMode"];
}): string {
  if (input.interactionMode === "plan") return "plan";
  switch (input.runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "auto_edit";
    default:
      return "default";
  }
}

function summarizeAcpRequest(value: ReturnType<typeof parsePermissionRequest>): string {
  return value.detail ?? value.toolCall?.title ?? value.kind;
}

const makeGeminiRuntime = (
  threadId: ThreadId,
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntimeShape,
  ProviderAdapterError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Layer.build(AcpSessionRuntime.layer(options)).pipe(
    Effect.flatMap((context) => Effect.service(AcpSessionRuntime).pipe(Effect.provide(context))),
    Effect.mapError((cause) => mapAcpToAdapterError(GEMINI_PROVIDER, threadId, "acp/spawn", cause)),
  );

export const makeGeminiAdapter = Effect.fn("makeGeminiAdapter")(function* (
  geminiSettings: GeminiSettings,
  options?: GeminiAdapterOptions,
): Effect.fn.Return<
  GeminiAdapterShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | ServerConfig | Scope.Scope
> {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("gemini");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, GeminiSessionContext>();

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const requireSession = Effect.fn("GeminiAdapter.requireSession")(function* (threadId: ThreadId) {
    const context = sessions.get(threadId);
    if (!context || context.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: GEMINI_PROVIDER,
        threadId,
      });
    }
    return context;
  });

  const mapAcpError = (threadId: ThreadId, method: string) => (cause: unknown) =>
    mapAcpToAdapterError(
      GEMINI_PROVIDER,
      threadId,
      method,
      cause as Parameters<typeof mapAcpToAdapterError>[3],
    );

  const emitSessionEvent = Effect.fn("GeminiAdapter.emitSessionEvent")(function* (
    context: GeminiSessionContext,
    type: Extract<ProviderRuntimeEvent["type"], "session.state.changed" | "session.exited">,
    payload: ProviderRuntimeEvent["payload"],
  ) {
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type,
      ...stamp,
      provider: GEMINI_PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId: context.session.threadId,
      payload,
    } as ProviderRuntimeEvent);
  });

  const mapParsedAcpEvent = Effect.fn("GeminiAdapter.mapParsedAcpEvent")(function* (
    context: GeminiSessionContext,
    event: AcpParsedSessionEvent,
  ) {
    const turnId = context.activeTurnId;
    const stamp = yield* makeEventStamp();
    switch (event._tag) {
      case "AssistantItemStarted":
        yield* offerRuntimeEvent(
          makeAcpAssistantItemEvent({
            stamp,
            provider: GEMINI_PROVIDER,
            threadId: context.session.threadId,
            turnId,
            itemId: event.itemId,
            lifecycle: "item.started",
          }),
        );
        break;
      case "AssistantItemCompleted":
        yield* offerRuntimeEvent(
          makeAcpAssistantItemEvent({
            stamp,
            provider: GEMINI_PROVIDER,
            threadId: context.session.threadId,
            turnId,
            itemId: event.itemId,
            lifecycle: "item.completed",
          }),
        );
        break;
      case "ContentDelta":
        yield* offerRuntimeEvent(
          makeAcpContentDeltaEvent({
            stamp,
            provider: GEMINI_PROVIDER,
            threadId: context.session.threadId,
            turnId,
            text: event.text,
            rawPayload: event.rawPayload,
            ...(event.itemId ? { itemId: event.itemId } : {}),
          }),
        );
        break;
      case "PlanUpdated":
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: GEMINI_PROVIDER,
            threadId: context.session.threadId,
            turnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: event.rawPayload,
          }),
        );
        break;
      case "ToolCallUpdated":
        yield* offerRuntimeEvent(
          makeAcpToolCallEvent({
            stamp,
            provider: GEMINI_PROVIDER,
            threadId: context.session.threadId,
            turnId,
            toolCall: event.toolCall,
            rawPayload: event.rawPayload,
          }),
        );
        break;
      case "ModeChanged":
        yield* offerRuntimeEvent({
          type: "session.configured",
          ...stamp,
          provider: GEMINI_PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          payload: { config: { mode: event.modeId } },
          raw: {
            source: "acp.jsonrpc",
            method: "session/update",
            payload: event,
          },
        });
        break;
    }
  });

  const installPermissionHandler = Effect.fn("GeminiAdapter.installPermissionHandler")(function* (
    context: GeminiSessionContext,
  ) {
    yield* context.runtime.handleRequestPermission((request) =>
      Effect.gen(function* () {
        const permissionRequest = parsePermissionRequest(request);
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();
        context.pendingApprovals.set(requestId, {
          permissionRequest,
          decision,
        });

        const openedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(
          makeAcpRequestOpenedEvent({
            stamp: openedStamp,
            provider: GEMINI_PROVIDER,
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            requestId: asRuntimeRequestId(requestId),
            permissionRequest,
            detail: summarizeAcpRequest(permissionRequest),
            args: request.toolCall.rawInput ?? {},
            source: "acp.jsonrpc",
            method: "session/request_permission",
            rawPayload: request,
          }),
        );

        const resolvedDecision = yield* Deferred.await(decision);
        context.pendingApprovals.delete(requestId);
        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(
          makeAcpRequestResolvedEvent({
            stamp: resolvedStamp,
            provider: GEMINI_PROVIDER,
            threadId: context.session.threadId,
            turnId: context.activeTurnId,
            requestId: asRuntimeRequestId(requestId),
            permissionRequest,
            decision: resolvedDecision,
          }),
        );

        if (resolvedDecision === "cancel") {
          return {
            outcome: { outcome: "cancelled" },
          } satisfies EffectAcpSchema.RequestPermissionResponse;
        }
        return {
          outcome: {
            outcome: "selected",
            optionId: acpPermissionOutcome(resolvedDecision),
          },
        } satisfies EffectAcpSchema.RequestPermissionResponse;
      }),
    );
  });

  const stopSessionInternal = Effect.fn("GeminiAdapter.stopSessionInternal")(function* (
    context: GeminiSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;
    context.stopped = true;
    sessions.delete(context.session.threadId);
    yield* Effect.ignore(Scope.close(context.scope, Exit.void));
    if (context.eventFiber) {
      yield* Fiber.interrupt(context.eventFiber).pipe(Effect.ignore);
    }
    if (options?.emitExitEvent !== false) {
      yield* emitSessionEvent(context, "session.exited", {
        reason: "stopSession",
        exitKind: "graceful",
      });
    }
  });

  const buildPromptBlocks = Effect.fn("GeminiAdapter.buildPromptBlocks")(function* (
    input: ProviderSendTurnInput,
  ) {
    const prompt: EffectAcpSchema.ContentBlock[] = [];
    const text = input.input?.trim();
    if (text) {
      prompt.push({ type: "text", text });
    }

    for (const attachment of input.attachments ?? []) {
      if (!attachment.mimeType.startsWith("image/")) {
        return yield* new ProviderAdapterValidationError({
          provider: GEMINI_PROVIDER,
          operation: "turn/start",
          issue: `Gemini v0 only supports image attachments. Unsupported MIME type: ${attachment.mimeType}.`,
        });
      }
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: GEMINI_PROVIDER,
          method: "turn/start",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }
      const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: GEMINI_PROVIDER,
              method: "turn/start",
              detail: `Failed to read attachment file: ${cause.message}.`,
              cause,
            }),
        ),
      );
      prompt.push({
        type: "image",
        mimeType: attachment.mimeType,
        data: Buffer.from(bytes).toString("base64"),
      });
    }

    if (prompt.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: GEMINI_PROVIDER,
        operation: "turn/start",
        issue: "Gemini prompt requires text or at least one supported attachment.",
      });
    }
    return prompt;
  });

  const startSession: GeminiAdapterShape["startSession"] = Effect.fn("GeminiAdapter.startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== GEMINI_PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: GEMINI_PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${GEMINI_PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existing = sessions.get(input.threadId);
      if (existing && !existing.stopped) {
        yield* stopSessionInternal(existing, { emitExitEvent: false });
      }

      const sessionScope = yield* Scope.make("sequential");
      const resumeSessionId = readGeminiResumeSessionId(input.resumeCursor);
      const runtimeOptions: AcpSessionRuntimeOptions = {
        spawn: {
          command: geminiSettings.binaryPath,
          args: [...GEMINI_ACP_ARGS],
          cwd: input.cwd ?? process.cwd(),
          ...(options?.environment ? { env: options.environment } : {}),
        },
        cwd: input.cwd ?? process.cwd(),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: "Cafe Code",
          version: "0.0.0",
        },
        authMethodId: geminiSettings.authMethod.trim() || GEMINI_DEFAULT_AUTH_METHOD,
      };

      const runtime = yield* (
        options?.makeRuntime ??
        ((runtimeOptions) => makeGeminiRuntime(input.threadId, runtimeOptions))
      )(runtimeOptions).pipe(
        Effect.provideService(Scope.Scope, sessionScope),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const started = yield* runtime.start().pipe(
        Effect.mapError(mapAcpError(input.threadId, "session/start")),
        Effect.onError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)),
      );

      const startedAt = yield* nowIso;
      const resumeCursor = { acpSessionId: started.sessionId };
      const model =
        input.modelSelection?.instanceId === boundInstanceId
          ? input.modelSelection.model
          : undefined;
      const session: ProviderSession = {
        provider: GEMINI_PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.additionalDirectories !== undefined
          ? { additionalDirectories: input.additionalDirectories }
          : {}),
        ...(model ? { model } : {}),
        resumeCursor,
        createdAt: startedAt,
        updatedAt: startedAt,
      };
      const context: GeminiSessionContext = {
        session,
        runtime,
        scope: sessionScope,
        pendingApprovals: new Map(),
        turns: [],
        stopped: false,
        promptActive: false,
      };
      sessions.set(input.threadId, context);
      yield* installPermissionHandler(context);

      const eventFiber = yield* Stream.runForEach(runtime.getEvents(), (event) =>
        mapParsedAcpEvent(context, event),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("gemini.acp.event-stream.failed", {
            threadId: input.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.forkIn(sessionScope),
      );
      context.eventFiber = eventFiber;

      const sessionStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        ...sessionStartedStamp,
        provider: GEMINI_PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: input.threadId,
        payload: { resume: resumeCursor },
      });
      yield* emitSessionEvent(context, "session.state.changed", { state: "ready" });

      if (model) {
        yield* runtime.setModel(model).pipe(
          Effect.mapError(mapAcpError(input.threadId, "session/set_model")),
          Effect.catch((error) =>
            Effect.logWarning("gemini.acp.set-model.failed", {
              threadId: input.threadId,
              detail: error.message,
            }),
          ),
        );
      }

      return { ...session };
    },
  );

  const sendTurn: GeminiAdapterShape["sendTurn"] = Effect.fn("GeminiAdapter.sendTurn")(
    function* (input) {
      const context = yield* requireSession(input.threadId);
      if (context.promptActive) {
        return yield* new ProviderAdapterRequestError({
          provider: GEMINI_PROVIDER,
          method: "turn/start",
          detail:
            "Gemini v0 already has an active prompt. Send the follow-up after the current turn completes.",
        });
      }

      const prompt = yield* buildPromptBlocks(input);
      const turnId = TurnId.make(yield* Random.nextUUIDv4);
      const modelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      if (modelSelection?.model && context.session.model !== modelSelection.model) {
        yield* context.runtime
          .setModel(modelSelection.model)
          .pipe(Effect.mapError(mapAcpError(input.threadId, "session/set_model")));
      }

      const desiredMode = modeForTurn({
        runtimeMode: context.session.runtimeMode,
        interactionMode: input.interactionMode,
      });
      yield* context.runtime
        .request("session/set_mode", {
          sessionId: readGeminiResumeSessionId(context.session.resumeCursor),
          modeId: desiredMode,
        })
        .pipe(
          Effect.mapError(mapAcpError(input.threadId, "session/set_mode")),
          Effect.catch((error) =>
            Effect.logWarning("gemini.acp.set-mode.failed", {
              threadId: input.threadId,
              mode: desiredMode,
              detail: error.message,
            }),
          ),
        );

      context.promptActive = true;
      context.activeTurnId = turnId;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        updatedAt: yield* nowIso,
      };

      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.started",
        ...turnStartedStamp,
        provider: GEMINI_PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId,
        payload: modelSelection?.model ? { model: modelSelection.model } : {},
        providerRefs: {
          providerTurnId: turnId,
        },
      });

      const promptResult = yield* context.runtime
        .prompt({
          messageId: String(turnId),
          prompt,
        })
        .pipe(Effect.mapError(mapAcpError(input.threadId, "session/prompt")), Effect.exit);

      const completedAt = yield* nowIso;
      context.promptActive = false;
      delete context.activeTurnId;
      context.session = {
        ...context.session,
        status: Exit.isSuccess(promptResult) ? "ready" : "error",
        updatedAt: completedAt,
        ...(Exit.isFailure(promptResult) ? { lastError: Cause.pretty(promptResult.cause) } : {}),
      };

      const terminalStamp = yield* makeEventStamp();
      if (Exit.isSuccess(promptResult)) {
        const interrupted = promptResult.value.stopReason === "cancelled";
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...terminalStamp,
          provider: GEMINI_PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId,
          payload: {
            state: interrupted ? "interrupted" : "completed",
            stopReason: promptResult.value.stopReason ?? null,
            ...(promptResult.value.usage ? { usage: promptResult.value.usage } : {}),
          },
          providerRefs: {
            providerTurnId: turnId,
          },
          raw: {
            source: "acp.jsonrpc",
            method: "session/prompt",
            payload: {
              stopReason: promptResult.value.stopReason,
              usage: promptResult.value.usage ?? null,
              userMessageId: promptResult.value.userMessageId ?? null,
            },
          },
        });
      } else {
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...terminalStamp,
          provider: GEMINI_PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          turnId,
          payload: {
            state: "failed",
            errorMessage: Cause.pretty(promptResult.cause),
          },
          providerRefs: {
            providerTurnId: turnId,
          },
        });
      }
      context.turns.push({ id: turnId, items: [] });
      yield* emitSessionEvent(context, "session.state.changed", {
        state: Exit.isSuccess(promptResult) ? "ready" : "error",
      });

      if (Exit.isFailure(promptResult)) {
        return yield* new ProviderAdapterRequestError({
          provider: GEMINI_PROVIDER,
          method: "session/prompt",
          detail: Cause.pretty(promptResult.cause),
        });
      }

      return {
        threadId: context.session.threadId,
        turnId,
        resumeCursor: context.session.resumeCursor,
      };
    },
  );

  const steerTurn: GeminiAdapterShape["steerTurn"] = Effect.fn("GeminiAdapter.steerTurn")(
    function* (input) {
      return yield* new ProviderAdapterRequestError({
        provider: GEMINI_PROVIDER,
        method: "turn/steer",
        detail: `Gemini v0 does not support live steering. Active turn '${input.expectedTurnId}' must complete before another prompt is sent.`,
      });
    },
  );

  const interruptTurn: GeminiAdapterShape["interruptTurn"] = Effect.fn(
    "GeminiAdapter.interruptTurn",
  )(function* (threadId) {
    const context = yield* requireSession(threadId);
    yield* context.runtime.cancel.pipe(Effect.mapError(mapAcpError(threadId, "session/cancel")));
  });

  const respondToRequest: GeminiAdapterShape["respondToRequest"] = Effect.fn(
    "GeminiAdapter.respondToRequest",
  )(function* (threadId, requestId, decision) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingApprovals.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: GEMINI_PROVIDER,
        method: "session/request_permission",
        detail: `Unknown pending Gemini approval request: ${requestId}`,
      });
    }
    context.pendingApprovals.delete(requestId);
    yield* Deferred.succeed(pending.decision, decision);
  });

  const respondToUserInput: GeminiAdapterShape["respondToUserInput"] = Effect.fn(
    "GeminiAdapter.respondToUserInput",
  )(function* (threadId, requestId) {
    yield* requireSession(threadId);
    return yield* new ProviderAdapterRequestError({
      provider: GEMINI_PROVIDER,
      method: "session/user_input",
      detail: `Gemini v0 does not support structured user-input callbacks: ${requestId}`,
    });
  });

  const readThread: GeminiAdapterShape["readThread"] = Effect.fn("GeminiAdapter.readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return {
        threadId,
        turns: [...context.turns],
      };
    },
  );

  const rollbackThread: GeminiAdapterShape["rollbackThread"] = Effect.fn(
    "GeminiAdapter.rollbackThread",
  )(function* (threadId, numTurns) {
    const context = yield* requireSession(threadId);
    context.turns.splice(Math.max(0, context.turns.length - numTurns));
    return {
      threadId,
      turns: [...context.turns],
    };
  });

  const stopSession: GeminiAdapterShape["stopSession"] = Effect.fn("GeminiAdapter.stopSession")(
    function* (threadId) {
      const context = sessions.get(threadId);
      if (context) {
        yield* stopSessionInternal(context);
      }
    },
  );

  const stopAll: GeminiAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), (context) => stopSessionInternal(context), {
      concurrency: 1,
      discard: true,
    });

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.andThen(Queue.shutdown(runtimeEventQueue)), Effect.ignore),
  );

  return {
    provider: GEMINI_PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      liveSteer: "unsupported",
    },
    startSession,
    sendTurn,
    steerTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () => Effect.sync(() => Array.from(sessions.values(), ({ session }) => session)),
    hasSession: (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      }),
    readThread,
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies GeminiAdapterShape;
});
