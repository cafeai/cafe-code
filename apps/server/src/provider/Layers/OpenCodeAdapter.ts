import { makeManagementMcpSession } from "../../mcp/sessionConnection.ts";
import {
  EventId,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type {
  OpencodeClient,
  Part,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
} from "@opencode-ai/sdk/v2";
import { getModelSelectionStringOptionValue } from "@cafecode/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  appendFileAttachmentPrompt,
  prepareFileAttachmentPrompt,
} from "../fileAttachmentPrompt.ts";
import { ServerConfig } from "../../config.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";
import * as Option from "effect/Option";

const PROVIDER = ProviderDriverKind.make("opencode");

const ResumeIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ResumeDirectory = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192));
const OpenCodeResume = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: ResumeIdentifier,
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  directory: ResumeDirectory,
  serverUrl: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192))),
});
const decodeOpenCodeResume = Schema.decodeUnknownEffect(OpenCodeResume);

function hasPermissionSuffix(actual: PermissionRuleset | undefined, expected: PermissionRuleset) {
  return (
    Array.isArray(actual) &&
    actual.length >= expected.length &&
    expected.every((rule, index) => {
      const received = actual[actual.length - expected.length + index];
      return (
        received?.permission === rule.permission &&
        received.pattern === rule.pattern &&
        received.action === rule.action
      );
    })
  );
}

// Resume failures must preserve the saved identity, never start a blank session
// or expose an external server's response/error (which may contain credentials).
const runOpenCodeResumeSdk = <A>(operation: string, request: (signal: AbortSignal) => Promise<A>) =>
  runOpenCodeSdk(operation, request).pipe(
    Effect.mapError(
      () =>
        new OpenCodeRuntimeError({
          operation,
          detail:
            "The saved OpenCode session could not be reopened. Check the original OpenCode server and data profile before retrying.",
        }),
    ),
  );

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

type OpenCodeSubscribedEvent =
  Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>> extends {
    readonly stream: AsyncIterable<infer TEvent>;
  }
    ? TEvent
    : never;

interface OpenCodeManualCompaction {
  readonly turnId: TurnId;
  readonly controller: AbortController;
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly completedAssistantPartIds: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  manualCompaction?: OpenCodeManualCompaction;
  activeTurnId: TurnId | undefined;
  activeAgent: string | undefined;
  activeVariant: string | undefined;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  readonly retirementDone: Deferred.Deferred<void, ProviderAdapterProcessError>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` fetch),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

const buildEventBase = (input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Effect.Effect<
  Pick<
    ProviderRuntimeEvent,
    "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
  >
> =>
  Effect.gen(function* () {
    const uuid = yield* Random.nextUUIDv4;
    const createdAt = input.createdAt ?? (yield* nowIso);
    return {
      eventId: EventId.make(uuid),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
      ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
      ...(input.raw !== undefined
        ? {
            raw: {
              source: "opencode.sdk.event",
              payload: input.raw,
            },
          }
        : {}),
    };
  });

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  // `ensureSessionContext` is a sync gate used from both sync helpers and
  // Effect bodies. `Ref.getUnsafe` is an atomic read of the backing cell —
  // no fiber suspension required, which keeps this callable everywhere.
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  return {
    nextText: previousText + delta,
    deltaToEmit: delta,
  };
}

const isoFromEpochMs = (value: number) =>
  DateTime.make(value).pipe(
    Option.match({
      onNone: () => undefined,
      onSome: DateTime.formatIso,
    }),
  );

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  switch ("name" in error ? error.name : undefined) {
    case "ProviderAuthError":
      return "OpenCode provider authentication failed. Check the selected provider's credentials.";
    case "ContextOverflowError":
      return "OpenCode exceeded the model's context limit. Compact the conversation or select a model with a larger context window.";
    case "MessageOutputLengthError":
      return "OpenCode reached the model's output limit.";
    case "MessageAbortedError":
      return "OpenCode generation was interrupted.";
    case "StructuredOutputError":
      return "OpenCode could not produce the required output format.";
    case "ContentFilterError":
      return "OpenCode's provider declined the request under its content policy.";
    default:
      return "OpenCode session failed. Check the provider configuration and server availability.";
  }
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.gen(function* () {
    const updatedAt = yield* nowIso;
    const nextSession = {
      ...context.session,
      ...patch,
      updatedAt,
    } as ProviderSession & Record<string, unknown>;
    const mutableSession = nextSession as Record<string, unknown>;
    if (options?.clearActiveTurnId) {
      delete mutableSession.activeTurnId;
    }
    if (options?.clearLastError) {
      delete mutableSession.lastError;
    }
    context.session = nextSession;
    return nextSession;
  });
}

const closeOpenCodeContext = (context: OpenCodeSessionContext) =>
  Effect.gen(function* () {
    context.manualCompaction?.controller.abort();

    // Best-effort remote abort. The scope close below tears down the local
    // handles (event-pump fiber, server-exit fiber, event-subscribe fetch),
    // but we still want to tell OpenCode that this session is done.
    yield* runOpenCodeSdk("session.abort", () =>
      context.client.session.abort({ sessionID: context.openCodeSessionId }),
    ).pipe(Effect.ignore({ log: true }));

    // Closing the session scope interrupts every fiber forked into it and
    // runs each finalizer we registered — the `AbortController.abort()` call,
    // the child-process termination, etc.
    yield* Scope.close(context.sessionScope, Exit.void);
  }).pipe(
    Effect.catchCause(() =>
      Effect.fail(
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail:
            "OpenCode session cleanup could not be confirmed. Preserve its recovery state before retrying.",
        }),
      ),
    ),
    Effect.uninterruptible,
  );

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
  onClosed: Effect.Effect<void> = Effect.void,
) {
  // A second caller must join the original abort/close. Returning early would
  // let that old abort reach a newly resumed owner of the same native session.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    yield* Deferred.await(context.retirementDone);
    return false;
  }
  yield* updateProviderSession(context, { status: "closed" }, { clearActiveTurnId: true });
  yield* closeOpenCodeContext(context).pipe(
    Effect.andThen(onClosed),
    Effect.onExit((exit) => Deferred.done(context.retirementDone, exit).pipe(Effect.asVoid)),
    Effect.uninterruptible,
  );
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const adapterScope = yield* Scope.Scope;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const startingSessions = new Set<ThreadId>();

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        // `ignoreCause` swallows typed failures and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        for (const context of contexts) {
          if (sessions.get(context.session.threadId) === context)
            sessions.delete(context.session.threadId);
        }
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const finishManualCompaction = Effect.fn("finishManualCompaction")(function* (
      context: OpenCodeSessionContext,
      operation: OpenCodeManualCompaction,
      state: "completed" | "failed" | "interrupted",
    ) {
      // HTTP, SSE errors, and Stop can race. Only the owning operation may
      // settle this turn; an old response cannot finish a newer user turn.
      if (context.manualCompaction !== operation || (yield* Ref.get(context.stopped))) return;
      delete context.manualCompaction;
      context.activeTurnId = undefined;
      const message =
        state === "failed"
          ? "OpenCode compaction failed. Try again when the provider is available."
          : undefined;
      yield* updateProviderSession(
        context,
        { status: "ready", ...(message ? { lastError: message } : {}) },
        { clearActiveTurnId: true },
      );
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: operation.turnId,
          itemId: operation.turnId,
        })),
        type: "item.completed",
        payload: {
          itemType: "context_compaction",
          status:
            state === "completed" ? "completed" : state === "interrupted" ? "declined" : "failed",
          title:
            state === "completed"
              ? "Context compacted"
              : state === "interrupted"
                ? "Compaction interrupted"
                : "Compaction failed",
        },
      });
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: operation.turnId,
        })),
        type: "turn.completed",
        payload: { state, ...(message ? { errorMessage: message } : {}) },
      });
    });

    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: two fibers can race here (the event-pump on stream
      // failure and the server-exit watcher). `getAndSet` flips the flag in
      // a single step so the loser observes `true` and returns; a plain
      // `Ref.get` would let both racers slip past and emit duplicates.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId = context.activeTurnId;
      yield* updateProviderSession(context, { status: "closed" }, { clearActiveTurnId: true });
      // Emit lifecycle events BEFORE tearing down the scope. Both call sites
      // run this inside a fiber forked via `Effect.forkIn(context.sessionScope)`;
      // closing that scope triggers the fiber-interrupt finalizer, so any
      // subsequent yield point would unwind and silently drop these emits.
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      // Cleanup belongs to the adapter, outside the session scope whose
      // finalizers interrupt this watcher. Keep the retiring context findable
      // until native abort and close finish, so resume can join that exact work.
      yield* closeOpenCodeContext(context).pipe(
        Effect.onExit((exit) => Deferred.done(context.retirementDone, exit).pipe(Effect.asVoid)),
        Effect.tap(() =>
          Effect.sync(() => {
            if (sessions.get(context.session.threadId) === context)
              sessions.delete(context.session.threadId);
          }),
        ),
        Effect.forkIn(adapterScope),
      );
    });

    /** Emit content.delta and item.completed events for an assistant text part. */
    const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
      context: OpenCodeSessionContext,
      part: Part,
      turnId: TurnId | undefined,
      raw: unknown,
    ) {
      const text = textFromPart(part);
      if (text === undefined) {
        return;
      }
      const previousText = context.emittedTextByPartId.get(part.id);
      const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
      context.emittedTextByPartId.set(part.id, latestText);
      if (latestText !== text) {
        context.partById.set(
          part.id,
          (part.type === "text" || part.type === "reasoning"
            ? { ...part, text: latestText }
            : part) satisfies Part,
        );
      }
      if (deltaToEmit.length > 0) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt:
              (part.type === "text" || part.type === "reasoning") && part.time !== undefined
                ? isoFromEpochMs(part.time.start)
                : undefined,
            raw,
          })),
          type: "content.delta",
          payload: {
            streamKind: resolveTextStreamKind(part),
            delta: deltaToEmit,
          },
        });
      }

      if (
        part.type === "text" &&
        part.time?.end !== undefined &&
        !context.completedAssistantPartIds.has(part.id)
      ) {
        context.completedAssistantPartIds.add(part.id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: part.id,
            createdAt: isoFromEpochMs(part.time.end),
            raw,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(latestText.length > 0 ? { detail: latestText } : {}),
          },
        });
      }
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: OpenCodeSubscribedEvent,
    ) {
      const payloadSessionId =
        "properties" in event ? (event.properties as { sessionID?: unknown }).sessionID : undefined;
      if (payloadSessionId !== context.openCodeSessionId) {
        return;
      }

      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          payload:
            event.type === "session.error"
              ? {
                  type: event.type,
                  properties: {
                    sessionID: context.openCodeSessionId,
                    message: sessionErrorMessage(event.properties.error),
                  },
                }
              : event.type === "session.status" && event.properties.status.type === "retry"
                ? {
                    type: event.type,
                    properties: { sessionID: context.openCodeSessionId, status: "retry" },
                  }
                : event,
        },
      });

      switch (event.type) {
        case "message.updated": {
          context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
          if (event.properties.info.role === "assistant") {
            for (const part of context.partById.values()) {
              if (part.messageID !== event.properties.info.id) {
                continue;
              }
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          }
          break;
        }

        case "message.removed": {
          context.messageRoleById.delete(event.properties.messageID);
          break;
        }

        case "message.part.delta": {
          const existingPart = context.partById.get(event.properties.partID);
          if (!existingPart) {
            break;
          }
          const role = messageRoleForPart(context, existingPart);
          if (role !== "assistant") {
            break;
          }
          const streamKind = resolveTextStreamKind(existingPart);
          const delta = event.properties.delta;
          if (delta.length === 0) {
            break;
          }
          const previousText =
            context.emittedTextByPartId.get(event.properties.partID) ??
            textFromPart(existingPart) ??
            "";
          const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);
          if (deltaToEmit.length === 0) {
            break;
          }
          context.emittedTextByPartId.set(event.properties.partID, nextText);
          if (existingPart.type === "text" || existingPart.type === "reasoning") {
            context.partById.set(event.properties.partID, {
              ...existingPart,
              text: nextText,
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: event.properties.partID,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind,
              delta: deltaToEmit,
            },
          });
          break;
        }

        case "message.part.updated": {
          const part = event.properties.part;
          context.partById.set(part.id, part);
          const messageRole = messageRoleForPart(context, part);

          if (messageRole === "assistant") {
            yield* emitAssistantTextDelta(context, part, turnId, event);
          }

          if (part.type === "tool") {
            const itemType = toToolLifecycleItemType(part.tool);
            const title =
              part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
            const detail = detailFromToolPart(part);
            const payload = {
              itemType,
              ...(part.state.status === "error"
                ? { status: "failed" as const }
                : part.state.status === "completed"
                  ? { status: "completed" as const }
                  : { status: "inProgress" as const }),
              ...(title ? { title } : {}),
              ...(detail ? { detail } : {}),
              data: {
                tool: part.tool,
                state: part.state,
              },
            };
            const runtimeEvent: ProviderRuntimeEvent = {
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                itemId: part.callID,
                createdAt: toolStateCreatedAt(part),
                raw: event,
              })),
              type:
                part.state.status === "pending"
                  ? "item.started"
                  : part.state.status === "completed" || part.state.status === "error"
                    ? "item.completed"
                    : "item.updated",
              payload,
            };
            appendTurnItem(context, turnId, part);
            yield* emit(runtimeEvent);
          }
          break;
        }

        case "permission.asked": {
          context.pendingPermissions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(event.properties.permission),
              detail:
                event.properties.patterns.length > 0
                  ? event.properties.patterns.join("\n")
                  : event.properties.permission,
              args: event.properties.metadata,
            },
          });
          break;
        }

        case "permission.replied": {
          context.pendingPermissions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: "unknown",
              decision: mapPermissionDecision(event.properties.reply),
            },
          });
          break;
        }

        case "question.asked": {
          context.pendingQuestions.set(event.properties.id, event.properties);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.id,
              raw: event,
            })),
            type: "user-input.requested",
            payload: {
              questions: normalizeQuestionRequest(event.properties),
            },
          });
          break;
        }

        case "question.replied": {
          const request = context.pendingQuestions.get(event.properties.requestID);
          context.pendingQuestions.delete(event.properties.requestID);
          const answers = Object.fromEntries(
            (request?.questions ?? []).map((question, index) => [
              openCodeQuestionId(index, question),
              event.properties.answers[index]?.join(", ") ?? "",
            ]),
          );
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers },
          });
          break;
        }

        case "question.rejected": {
          context.pendingQuestions.delete(event.properties.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.properties.requestID,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers: {} },
          });
          break;
        }

        case "session.status": {
          if (event.properties.status.type === "busy") {
            yield* updateProviderSession(context, {
              status: "running",
              activeTurnId: turnId,
            });
          }

          if (event.properties.status.type === "retry") {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
              })),
              type: "runtime.warning",
              payload: {
                message: "OpenCode is retrying the current request.",
              },
            });
            break;
          }

          if (event.properties.status.type === "idle" && turnId && !context.manualCompaction) {
            context.activeTurnId = undefined;
            yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "turn.completed",
              payload: {
                state: "completed",
              },
            });
          }
          break;
        }

        case "session.error": {
          if (context.manualCompaction) {
            const operation = context.manualCompaction;
            operation.controller.abort();
            yield* finishManualCompaction(context, operation, "failed");
            break;
          }
          const message = sessionErrorMessage(event.properties.error);
          const activeTurnId = context.activeTurnId;
          context.activeTurnId = undefined;
          yield* updateProviderSession(
            context,
            {
              status: "error",
              lastError: message,
            },
            { clearActiveTurnId: true },
          );
          if (activeTurnId) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId: activeTurnId,
              })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: message,
              },
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      // One AbortController per session scope. The finalizer fires when
      // the scope closes (explicit stop, unexpected exit, or layer
      // shutdown) and cancels the in-flight `event.subscribe` fetch so
      // the async iterable unwinds cleanly.
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Effect.flatMap(
        runOpenCodeSdk("event.subscribe", () =>
          context.client.event.subscribe(undefined, {
            signal: eventsAbortController.signal,
          }),
        ),
        (subscription) =>
          Stream.fromAsyncIterable(
            subscription.stream,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: caller aborted the fetch or the session
            // has already been marked stopped. Treat as a clean exit.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            yield* emitUnexpectedExit(
              context,
              Exit.isFailure(exit)
                ? "OpenCode event stream failed. Reconnect to resume the saved conversation."
                : "OpenCode event stream ended unexpectedly. Reconnect to resume the saved conversation.",
            );
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`);
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSessionUnlocked: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resume =
          input.resumeCursor == null
            ? undefined
            : yield* decodeOpenCodeResume(input.resumeCursor).pipe(
                Effect.mapError(
                  () =>
                    new ProviderAdapterValidationError({
                      provider: PROVIDER,
                      operation: "startSession",
                      issue:
                        "The saved OpenCode session identity is invalid. No replacement session was created.",
                    }),
                ),
              );
        const resumeServerUrl = serverUrl?.trim() || null;
        if (
          resume &&
          (resume.threadId !== input.threadId ||
            resume.instanceId !== boundInstanceId ||
            resume.directory !== directory ||
            resume.serverUrl !== resumeServerUrl)
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue:
              "The saved OpenCode session belongs to a different chat, provider instance, server or working directory. No replacement session was created.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopOpenCodeContext(existing);
          sessions.delete(input.threadId);
        }

        const started = yield* Effect.acquireUseRelease(
          Scope.make(),
          (sessionScope) =>
            Effect.gen(function* () {
              // The runtime binds the server's lifetime to the Scope.Scope
              // we provide below — closing `sessionScope` kills the child
              // process automatically. No manual `server.close()` needed.
              const management = !serverUrl
                ? yield* Effect.acquireRelease(
                    makeManagementMcpSession({
                      threadId: input.threadId,
                      providerInstanceId: boundInstanceId,
                    }).pipe(
                      Effect.provideService(ServerConfig, serverConfig),
                      Effect.mapError((cause) => toProcessError(input.threadId, cause)),
                    ),
                    (binding) => binding?.dispose ?? Effect.void,
                  )
                : undefined;
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                ...(management ? { managementMcp: management } : {}),
                binaryPath,
                serverUrl,
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const client = openCodeRuntime.createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.external && serverPassword ? { serverPassword } : {}),
              });
              // OpenCode persists native messages independently of its serve
              // process. Reopen the exact id with the pinned v2 compatibility
              // API; a missing/unreachable session must not silently lose history.
              // Reviewed against SDK 1.18.3 and upstream 127bdb30784d508cc556c71a0f32b508a3061517.
              const permission = buildOpenCodePermissionRules(input.runtimeMode);
              let openCodeSession = resume
                ? yield* runOpenCodeResumeSdk("session.get", (signal) =>
                    client.session.get({ sessionID: resume.sessionId, directory }, { signal }),
                  )
                : yield* runOpenCodeSdk("session.create", (signal) =>
                    client.session.create(
                      {
                        title: `Cafe Code ${input.threadId}`,
                        permission,
                      },
                      { signal },
                    ),
                  );
              if (!openCodeSession.data) {
                return yield* new OpenCodeRuntimeError({
                  operation: resume ? "session.get" : "session.create",
                  detail: resume
                    ? "The saved OpenCode session is unavailable. No replacement session was created."
                    : "OpenCode session.create returned no session payload.",
                });
              }
              if (resume) {
                if (
                  openCodeSession.data.id !== resume.sessionId ||
                  openCodeSession.data.directory !== directory ||
                  openCodeSession.data.parentID !== undefined
                ) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.get",
                    detail:
                      "OpenCode returned a different session or working directory. No replacement session was created.",
                  });
                }
                const status = yield* runOpenCodeResumeSdk("session.status", (signal) =>
                  client.session.status({ directory }, { signal }),
                );
                // Native idle entries are removed from the status map. Busy or
                // retrying external sessions cannot admit another Cafe owner.
                const nativeStatus = status.data?.[resume.sessionId];
                if (!status.data || (nativeStatus !== undefined && nativeStatus?.type !== "idle")) {
                  return yield* new OpenCodeRuntimeError({
                    operation: "session.status",
                    detail:
                      "The saved OpenCode session is not idle. Wait for its current work before retrying.",
                  });
                }
                if (!hasPermissionSuffix(openCodeSession.data.permission, permission)) {
                  openCodeSession = yield* runOpenCodeResumeSdk("session.update", (signal) =>
                    client.session.update(
                      { sessionID: resume.sessionId, directory, permission },
                      { signal },
                    ),
                  );
                  // Native update appends rules and evaluates the last match.
                  // Verify the final policy, including after a more privileged
                  // prior session; never echo or replay the saved transcript.
                  if (
                    openCodeSession.data?.id !== resume.sessionId ||
                    openCodeSession.data.directory !== directory ||
                    !hasPermissionSuffix(openCodeSession.data.permission, permission)
                  ) {
                    return yield* new OpenCodeRuntimeError({
                      operation: "session.update",
                      detail:
                        "OpenCode could not confirm this session's current Cafe permission policy. No replacement session was created.",
                    });
                  }
                }
              }
              const resumeCursor = yield* decodeOpenCodeResume({
                schemaVersion: 1,
                sessionId: openCodeSession.data.id,
                threadId: input.threadId,
                instanceId: boundInstanceId,
                directory,
                serverUrl: resumeServerUrl,
              }).pipe(
                Effect.mapError(
                  () =>
                    new OpenCodeRuntimeError({
                      operation: resume ? "session.get" : "session.create",
                      detail: "OpenCode returned an invalid session identity.",
                    }),
                ),
              );
              return {
                sessionScope,
                server,
                client,
                openCodeSession: openCodeSession.data,
                resumeCursor,
              };
            }).pipe(
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError((cause) => toProcessError(input.threadId, cause)),
            ),
          (sessionScope, exit) =>
            Exit.isFailure(exit) ? Scope.close(sessionScope, Exit.void) : Effect.void,
        );

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          threadId: input.threadId,
          resumeCursor: started.resumeCursor,
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeSessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          partById: new Map(),
          emittedTextByPartId: new Map(),
          messageRoleById: new Map(),
          completedAssistantPartIds: new Set(),
          turns: [],
          activeTurnId: undefined,
          activeAgent: undefined,
          activeVariant: undefined,
          stopped: yield* Ref.make(false),
          retirementDone: yield* Deferred.make<void, ProviderAdapterProcessError>(),
          sessionScope: started.sessionScope,
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return session;
      },
    );

    const startSession: OpenCodeAdapterShape["startSession"] = (input) =>
      Effect.suspend(() => {
        // Concurrent resumes target the same native id. A losing startup must
        // never abort that id and thereby stop the winner's work.
        if (startingSessions.has(input.threadId)) {
          return Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue:
                "This OpenCode chat is already starting. Wait for its current startup before retrying.",
            }),
          );
        }
        startingSessions.add(input.threadId);
        return startSessionUnlocked(input).pipe(
          Effect.ensuring(Effect.sync(() => startingSessions.delete(input.threadId))),
        );
      });

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId);
      if (context.manualCompaction) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Wait for compaction to finish before sending a message.",
        });
      }
      const turnId = TurnId.make(`opencode-turn-${yield* Random.nextUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        context.session.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      // File manifests name this backend's local private files. An explicitly
      // hosted OpenCode endpoint has no proven shared filesystem, even when its
      // URL happens to resolve to loopback through a tunnel. Never claim that a
      // remote server received a local path or silently omit the attachment.
      if (
        openCodeSettings.serverUrl.trim().length > 0 &&
        input.attachments?.some((attachment) => attachment.type === "file")
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "File attachments require a locally managed OpenCode runtime.",
        });
      }
      if (
        openCodeSettings.serverUrl.trim().length > 0 &&
        input.attachments?.some((attachment) => attachment.type === "image")
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue:
            "Image attachments require a locally managed OpenCode runtime. The configured server cannot read this backend's private image files.",
        });
      }
      const fileManifest = yield* Effect.tryPromise({
        try: () =>
          prepareFileAttachmentPrompt({
            attachmentsDir: serverConfig.attachmentsDir,
            threadId: input.threadId,
            attachments: input.attachments,
          }),
        catch: () =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Failed to prepare a validated file attachment.",
          }),
      });
      const text = appendFileAttachmentPrompt(input.input?.trim(), fileManifest);
      const fileParts = toOpenCodeFileParts({
        attachments: input.attachments?.filter((attachment) => attachment.type === "image"),
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

      context.activeTurnId = turnId;
      context.activeAgent = agent ?? (input.interactionMode === "plan" ? "plan" : undefined);
      context.activeVariant = variant;
      yield* updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model: modelSelection?.model ?? context.session.model,
          ...(modelSelection ? { modelSelection } : {}),
        },
        { clearLastError: true },
      );

      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: {
          model: modelSelection?.model ?? context.session.model,
          ...(variant ? { effort: variant } : {}),
        },
      });

      yield* runOpenCodeSdk("session.promptAsync", (signal) =>
        context.client.session.promptAsync(
          {
            sessionID: context.openCodeSessionId,
            model: parsedModel,
            ...(context.activeAgent ? { agent: context.activeAgent } : {}),
            ...(context.activeVariant ? { variant: context.activeVariant } : {}),
            parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
          },
          { signal },
        ),
      ).pipe(
        Effect.mapError(toRequestError),
        // On failure: clear active-turn state, flip the session back to ready
        // with lastError set, emit turn.aborted, then let the typed error
        // propagate. We don't need to rebuild the error here — `toRequestError`
        // already produced the right shape.
        Effect.tapError((requestError) =>
          Effect.gen(function* () {
            context.activeTurnId = undefined;
            context.activeAgent = undefined;
            context.activeVariant = undefined;
            yield* updateProviderSession(
              context,
              {
                status: "ready",
                model: modelSelection?.model ?? context.session.model,
                lastError: requestError.detail,
              },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({
                threadId: input.threadId,
                turnId,
              })),
              type: "turn.aborted",
              payload: {
                reason: requestError.detail,
              },
            });
          }),
        ),
      );

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: context.session.resumeCursor,
      };
    });

    const steerTurn: OpenCodeAdapterShape["steerTurn"] = (input) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/steer",
          detail: `OpenCode session '${input.threadId}' does not support live steering.`,
        }),
      );

    const compactThread: NonNullable<OpenCodeAdapterShape["compactThread"]> = Effect.fn(
      "compactThread",
    )(function* (threadId) {
      const context = ensureSessionContext(sessions, threadId);
      const model = parseOpenCodeModelSlug(context.session.model);
      if (
        context.session.status !== "ready" ||
        context.activeTurnId ||
        context.manualCompaction ||
        context.pendingPermissions.size ||
        context.pendingQuestions.size ||
        !model
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "compactThread",
          issue:
            "Manual compaction requires an idle conversation with an existing provider/model selection.",
        });
      }
      const operation: OpenCodeManualCompaction = {
        turnId: TurnId.make("opencode-compact-" + (yield* Random.nextUUIDv4)),
        controller: new AbortController(),
      };
      context.manualCompaction = operation;
      context.activeTurnId = operation.turnId;
      yield* updateProviderSession(
        context,
        { status: "running", activeTurnId: operation.turnId },
        { clearLastError: true },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId, turnId: operation.turnId })),
        type: "turn.started",
        payload: { model: context.session.model },
      });
      yield* emit({
        ...(yield* buildEventBase({
          threadId,
          turnId: operation.turnId,
          itemId: operation.turnId,
        })),
        type: "item.started",
        payload: {
          itemType: "context_compaction",
          status: "inProgress",
          title: "Compacting context",
        },
      });
      // The installed v2 SDK's compatibility endpoint awaits SessionPrompt.loop.
      // Scope ownership keeps this long request cancellable without holding the
      // provider command lock. Native idle may precede the HTTP result; only
      // this operation's result (or an explicit error/Stop) settles it.
      // https://opencode.ai/docs/sdk/#sessions
      yield* runOpenCodeSdk("session.summarize", () =>
        context.client.session.summarize(
          {
            sessionID: context.openCodeSessionId,
            directory: context.directory,
            ...model,
            auto: false,
          },
          { signal: operation.controller.signal },
        ),
      ).pipe(
        Effect.flatMap((result) =>
          finishManualCompaction(context, operation, result.data === true ? "completed" : "failed"),
        ),
        Effect.catchCause(() => finishManualCompaction(context, operation, "failed")),
        Effect.ensuring(Effect.sync(() => operation.controller.abort())),
        Effect.forkIn(context.sessionScope),
      );
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId);
        const compaction = context.manualCompaction;
        const activeTurnId = context.activeTurnId;
        if (turnId !== undefined && turnId !== activeTurnId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "interruptTurn",
            issue: "This Stop request no longer belongs to the active OpenCode turn.",
          });
        }
        if (!activeTurnId && !compaction) return;
        yield* runOpenCodeSdk("session.abort", () =>
          context.client.session.abort({ sessionID: context.openCodeSessionId }),
        ).pipe(Effect.mapError(toRequestError));
        if (compaction) {
          yield* finishManualCompaction(context, compaction, "interrupted");
          compaction.controller.abort();
          return;
        }
        // Native idle or a replacement may have won while abort was awaited.
        // A late Stop receipt must not settle a subsequent turn's output.
        if (context.activeTurnId !== activeTurnId || sessions.get(threadId) !== context) return;
        if (activeTurnId) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId: activeTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = ensureSessionContext(sessions, threadId);
      if (!context.pendingPermissions.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("permission.reply", () =>
        context.client.permission.reply({
          requestID: requestId,
          reply: toOpenCodePermissionReply(decision),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = ensureSessionContext(sessions, threadId);
      const request = context.pendingQuestions.get(requestId);
      if (!request) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "question.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      yield* runOpenCodeSdk("question.reply", () =>
        context.client.question.reply({
          requestID: requestId,
          answers: toOpenCodeQuestionAnswers(request, answers),
        }),
      ).pipe(Effect.mapError(toRequestError));
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          throw new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        yield* stopOpenCodeContext(
          context,
          Effect.gen(function* () {
            yield* emit({
              ...(yield* buildEventBase({ threadId })),
              type: "session.exited",
              payload: {
                reason: "Session stopped.",
                recoverable: false,
                exitKind: "graceful",
              },
            });
          }),
        );
        if (sessions.get(threadId) === context) sessions.delete(threadId);
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const turns = (messages.data ?? [])
          .filter((entry) => entry.info.role === "assistant")
          .map((entry) => ({
            id: TurnId.make(entry.info.id),
            items: [entry.info, ...entry.parts],
          }));

        return {
          threadId,
          turns,
        };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = ensureSessionContext(sessions, threadId);
        const messages = yield* runOpenCodeSdk("session.messages", () =>
          context.client.session.messages({
            sessionID: context.openCodeSessionId,
          }),
        ).pipe(Effect.mapError(toRequestError));

        const assistantMessages = (messages.data ?? []).filter(
          (entry) => entry.info.role === "assistant",
        );
        const targetIndex = assistantMessages.length - numTurns - 1;
        const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
        yield* runOpenCodeSdk("session.revert", () =>
          context.client.session.revert({
            sessionID: context.openCodeSessionId,
            ...(target ? { messageID: target.info.id } : {}),
          }),
        ).pipe(Effect.mapError(toRequestError));

        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        // Retiring entries remain findable until native close finishes, so
        // a concurrent reopen joins them. `ignoreCause` also swallows
        // defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        for (const context of contexts) {
          if (sessions.get(context.session.threadId) === context)
            sessions.delete(context.session.threadId);
        }
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        liveSteer: "unsupported",
        manualCompaction: "supported",
      },
      startSession,
      compactThread,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
