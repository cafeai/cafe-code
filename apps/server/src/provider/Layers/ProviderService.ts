/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  EventId,
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSessionForkDiscardInput,
  ProviderSessionForkInput,
  ProviderSessionForkResult,
  ProviderSnoozeUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderThreadGoalClearInput,
  ProviderThreadGoalGetInput,
  ProviderThreadGoalSetInput,
  PROVIDER_THREAD_GOAL_MAX_OBJECTIVE_CODE_POINTS,
  ServerProviderRuntimeRestartInput,
  ProviderSteerTurnInput,
  ProviderStopSessionInput,
  TurnId,
  type ProviderSessionRuntimeStatus,
  type ProviderInstanceId,
  ProviderDriverKind,
  OrchestrationThreadTurnSubagentDetailBody,
  THREAD_TURN_SUBAGENT_ID_MAX_LENGTH,
  TrimmedNonEmptyString,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@cafecode/contracts";
import { randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  ProviderAdapterProcessError,
  type ProviderAdapterError,
  ProviderValidationError,
  makeProviderSubagentDetailReadError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  makeProviderRuntimeOwnerPayload,
  PROVIDER_RUNTIME_OWNER_HEARTBEAT_INTERVAL_MS,
  type ProviderRuntimeOwnerEvidence,
} from "../providerRuntimeOwnerEvidence.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { ProviderEventLoggers } from "./ProviderEventLoggers.ts";
const isModelSelection = Schema.is(ModelSelection);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
// Codex historically rejected missing native threads with "no rollout found".
// As of rust-v0.149.1, thread-store can instead reject the same stale cursor
// while resolving its persisted JSONL path. Both errors prove that this known
// resume cursor is unusable; they do not justify retrying unrelated process
// failures. The caller additionally requires a persisted cursor and retries
// exactly once without it, preserving a bounded and fail-closed recovery path.
const CODEX_REJECTED_RESUME_CURSOR_PATTERN =
  /\b(?:no rollout found for thread id|failed to resolve rollout path)\b/i;
const CLAUDE_REJECTED_RESUME_CURSOR_PATTERN =
  /\b(?:no conversation found with session id|no message found with message\.uuid|invalid resume|resume session .*not found|conversation .*not found)\b/i;
const CLAUDE_PROCESS_EXITED_PATTERN = /\bClaude Code process exited with code\b/i;

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

const ProviderReadThreadInput = Schema.Struct({
  threadId: ThreadId,
});

const ProviderReadSubagentDetailInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  subagentId: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_TURN_SUBAGENT_ID_MAX_LENGTH)),
  historyId: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_TURN_SUBAGENT_ID_MAX_LENGTH)),
  ),
});

const ProviderRuntimeRestartInput = ServerProviderRuntimeRestartInput;
const ProviderForkSessionInput = ProviderSessionForkInput;
const ProviderDiscardSessionForkInput = ProviderSessionForkDiscardInput;
const PROVIDER_ADAPTER_EVENT_STREAM_RESTART_DELAY = Duration.millis(500);
const PROVIDER_SUBAGENT_HISTORY_CURSOR_MAX_UTF8_BYTES = 64 * 1024;
const PROVIDER_SUBAGENT_HISTORY_CWD_MAX_CODE_UNITS = 32 * 1024;
const THREAD_LIFECYCLE_LOCK_STRIPE_COUNT = 256;

/**
 * Freeze a finite JSON-only copy before the provider root scope is retained
 * beyond the mutable live session. This prevents adapter-owned prototypes,
 * accessors, or an adversarially large cursor from entering the durable
 * history-binding table.
 */
function freezeSubagentHistoryResumeCursor(value: unknown | null | undefined): unknown | null {
  if (value === null || value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (
      encoded === undefined ||
      new TextEncoder().encode(encoded).byteLength > PROVIDER_SUBAGENT_HISTORY_CURSOR_MAX_UTF8_BYTES
    ) {
      return null;
    }
    return JSON.parse(encoded) as unknown;
  } catch {
    return null;
  }
}

function boundedSubagentHistoryCwd(value: string | undefined): string | null {
  return value !== undefined &&
    value.length <= PROVIDER_SUBAGENT_HISTORY_CWD_MAX_CODE_UNITS &&
    !value.includes("\0")
    ? value
    : null;
}

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

const decodeProviderSubagentDetailBody = Schema.decodeUnknownEffect(
  OrchestrationThreadTurnSubagentDetailBody,
);

/**
 * Decode provider-owned detail through the public schema and then construct a
 * fresh field-by-field value. The second step is intentional even though
 * Effect Schema currently reconstructs structs: it keeps this security
 * boundary independent of decoder implementation details and ensures custom
 * prototypes, accessors, extra private fields, and `toJSON` hooks cannot cross
 * into daemon or renderer serialization.
 */
const makePublicProviderSubagentDetailBody = (input: unknown) =>
  decodeProviderSubagentDetailBody(input).pipe(
    Effect.mapError(() => makeProviderSubagentDetailReadError("provider-response-invalid")),
    Effect.catchDefect(() =>
      Effect.fail(makeProviderSubagentDetailReadError("provider-response-invalid")),
    ),
    Effect.map((detail) => ({
      messages: detail.messages.map((message) => ({
        key: message.key,
        role: message.role,
        text: message.text,
        ...(message.omission === undefined
          ? {}
          : {
              omission: {
                tail: message.omission.tail,
                omittedUtf8Bytes: message.omission.omittedUtf8Bytes,
              },
            }),
      })),
      gaps: detail.gaps.map((gap) => ({
        afterMessageKey: gap.afterMessageKey,
        omittedMessages: gap.omittedMessages,
        omittedUtf8Bytes: gap.omittedUtf8Bytes,
      })),
      truncated: detail.truncated,
    })),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function errorMessageChain(error: unknown): string {
  if (error instanceof Error) {
    const cause = "cause" in error ? (error as { readonly cause?: unknown }).cause : undefined;
    return cause === undefined ? error.message : `${error.message}\n${errorMessageChain(cause)}`;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : String(error);
    return record.cause === undefined ? message : `${message}\n${errorMessageChain(record.cause)}`;
  }
  return String(error);
}

function isRejectedResumeCursorError(input: {
  readonly provider: ProviderDriverKind;
  readonly error: unknown;
}): boolean {
  if (!isProviderAdapterProcessError(input.error)) {
    return false;
  }

  const message = errorMessageChain(input.error);
  if (input.provider === ProviderDriverKind.make("codex")) {
    return CODEX_REJECTED_RESUME_CURSOR_PATTERN.test(message);
  }

  if (input.provider === ProviderDriverKind.make("claudeAgent")) {
    // Claude Code sometimes reports a stale resume cursor as a specific
    // "No conversation/message found" SDK error, and sometimes only as an
    // early process exit. This recovery is gated by the caller's known
    // resume-cursor attempt, so a model/auth error is retried only once and
    // still surfaces if the fresh start also fails.
    return (
      CLAUDE_REJECTED_RESUME_CURSOR_PATTERN.test(message) ||
      CLAUDE_PROCESS_EXITED_PATTERN.test(message)
    );
  }

  return false;
}

function rejectedResumeCursorRecoveryReason(provider: ProviderDriverKind): string {
  return provider === ProviderDriverKind.make("codex")
    ? "Provider rejected the persisted Codex rollout id; starting a fresh session."
    : "Provider rejected the persisted Claude resume session; starting a fresh session.";
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  runtimeOwner: Omit<ProviderRuntimeOwnerEvidence, "runtimeOwnerHeartbeatAt">,
  runtimeOwnerHeartbeatAt: string,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    additionalDirectories: session.additionalDirectories ?? [],
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
    ...makeProviderRuntimeOwnerPayload(runtimeOwner, runtimeOwnerHeartbeatAt),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPersistedAdditionalDirectories(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ReadonlyArray<string> | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawDirectories =
    "additionalDirectories" in runtimePayload ? runtimePayload.additionalDirectories : undefined;
  if (!Array.isArray(rawDirectories)) {
    return undefined;
  }
  const directories = rawDirectories.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return directories.length > 0 ? directories : [];
}

function readPersistedString(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
  key: string,
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const record = runtimePayload as Record<string, unknown>;
  const raw = key in record ? record[key] : undefined;
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimeStatusFromEvent(
  event: ProviderRuntimeEvent,
): ProviderSessionRuntimeStatus | undefined {
  const payload: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
  const state = typeof payload.state === "string" ? payload.state : undefined;

  switch (event.type) {
    case "session.state.changed":
      if (state === "starting") return "starting";
      if (state === "error") return "error";
      return "running";
    case "session.started":
    case "thread.started":
    case "turn.started":
      return "running";
    case "turn.completed":
      return state === "failed" ? "error" : "running";
    case "turn.aborted":
      return "running";
    case "session.exited":
      return "stopped";
    case "runtime.error":
      return "error";
    default:
      return undefined;
  }
}

function runtimeActiveTurnIdFromEvent(event: ProviderRuntimeEvent): TurnId | null | undefined {
  switch (event.type) {
    case "turn.started":
      return event.turnId ?? null;
    case "turn.completed":
    case "turn.aborted":
    case "session.exited":
      return null;
    case "runtime.error":
      return event.turnId ?? null;
    default:
      return undefined;
  }
}

function runtimeLastErrorFromEvent(event: ProviderRuntimeEvent): string | null | undefined {
  const payload: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
  switch (event.type) {
    case "session.state.changed":
      if (payload.state !== "error") return undefined;
      return typeof payload.reason === "string" && payload.reason.trim().length > 0
        ? payload.reason
        : "Provider session error";
    case "turn.completed":
      if (payload.state !== "failed") return null;
      return typeof payload.errorMessage === "string" && payload.errorMessage.trim().length > 0
        ? payload.errorMessage
        : "Turn failed";
    case "turn.aborted":
      return typeof payload.reason === "string" && payload.reason.trim().length > 0
        ? payload.reason
        : "Turn aborted";
    case "runtime.error":
      return typeof payload.message === "string" && payload.message.trim().length > 0
        ? payload.message
        : "Provider runtime error";
    case "session.exited":
      return null;
    default:
      return undefined;
  }
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const eventLoggers = yield* ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const runtimeOwnerStartedAt = yield* nowIso;
  const runtimeOwner = {
    runtimeOwnerId: randomUUID(),
    runtimeOwnerPid: process.pid,
    runtimeOwnerStartedAt,
  } satisfies Omit<ProviderRuntimeOwnerEvidence, "runtimeOwnerHeartbeatAt">;
  // The detached provider daemon and one or more web/backend processes can
  // share the same provider_session_runtime table. Persisting this process
  // incarnation lets startup reconciliation distinguish a live remote owner
  // from an old `running` row left by a crashed process.
  const runtimeOwnerHeartbeatWrittenAt = new Map<ThreadId, number>();
  const runtimeOwnerHeartbeatSemaphore = yield* Semaphore.make(1);
  // Provider fork APIs allocate a fresh native identity and do not accept
  // Cafe's idempotency key. Serialize the short, user-initiated mutation so
  // two transports cannot both observe an empty target binding and create two
  // native branches before one wins the durable upsert.
  const sessionForkMutationSemaphore = yield* Semaphore.make(1);

  // Hard deletion is a permanent lifecycle boundary, not merely another
  // session status. A per-thread semaphore serializes short provider mutation
  // acknowledgements and canonical event persistence with that boundary. Once
  // retired, the thread id remains fenced for this process incarnation; Cafe
  // thread ids are immutable and are never validly reused after hard delete.
  // The durable database foreign key on provider history roots is the second,
  // cross-process fence if a stale daemon record is replayed after restart.
  const hardDeleteRetiredThreadIds = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  // Fixed stripes bound memory even if a compromised provider emits events
  // carrying many adversarial thread ids. Hash collisions only serialize two
  // short control-plane operations; they cannot weaken the delete fence.
  const threadLifecycleSemaphores = yield* Effect.forEach(
    Array.from({ length: THREAD_LIFECYCLE_LOCK_STRIPE_COUNT }),
    () => Semaphore.make(1),
  );

  const threadLifecycleSemaphoreIndex = (threadId: ThreadId): number => {
    // FNV-1a via Math.imul keeps the index deterministic without retaining the
    // provider-controlled id in another process-lifetime map.
    let hash = 0x811c9dc5;
    const value = String(threadId);
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0) % THREAD_LIFECYCLE_LOCK_STRIPE_COUNT;
  };

  const withThreadLifecycleLocks = <A, E, R>(
    threadIds: ReadonlyArray<ThreadId>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    // Fork is the only provider mutation spanning two immutable Cafe thread
    // identities. Acquire the fixed lock stripes in one deterministic order
    // so opposite-direction forks cannot deadlock. Two distinct ids can hash
    // to the same stripe; de-duplicating indexes is therefore required rather
    // than an optimization, because a semaphore permit is not re-entrant.
    const stripeIndexes = Array.from(
      new Set(threadIds.map(threadLifecycleSemaphoreIndex)),
    ).toSorted((left, right) => left - right);
    return stripeIndexes.reduceRight<Effect.Effect<A, E, R>>((guarded, stripeIndex) => {
      const semaphore = threadLifecycleSemaphores[stripeIndex];
      // Every index was produced modulo the fixed non-zero stripe count, so a
      // missing entry is a construction defect rather than provider input.
      return semaphore === undefined
        ? Effect.die("Missing provider lifecycle lock stripe")
        : semaphore.withPermit(guarded);
    }, effect);
  };

  const withThreadLifecycleLock = <A, E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => withThreadLifecycleLocks([threadId], effect);

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.runtime.canonical-log-write-failed", {
                  provider: canonicalEvent.provider,
                  providerInstanceId: canonicalEvent.providerInstanceId,
                  threadId: canonicalEvent.threadId,
                  turnId: canonicalEvent.turnId,
                  eventId: canonicalEvent.eventId,
                  eventType: canonicalEvent.type,
                  cause: Cause.pretty(cause),
                }),
              ),
            )
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const emitRejectedResumeCursorRecoveryWarning = (input: {
    readonly provider: ProviderDriverKind;
    readonly providerInstanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly operation: string;
  }) =>
    nowIso.pipe(
      Effect.flatMap((createdAt) =>
        publishRuntimeEvent({
          type: "runtime.warning",
          eventId: EventId.make(randomUUID()),
          provider: input.provider,
          providerInstanceId: input.providerInstanceId,
          threadId: input.threadId,
          createdAt,
          payload: {
            message: "Provider resume state was stale; starting a fresh session.",
            detail: {
              operation: input.operation,
              recovery: "fresh-session-after-rejected-resume-cursor",
              reason: rejectedResumeCursorRecoveryReason(input.provider),
              willRetry: true,
            },
          },
          providerRefs: {},
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.resume-cursor-recovery-warning-failed", {
          threadId: input.threadId,
          provider: input.provider,
          providerInstanceId: input.providerInstanceId,
          operation: input.operation,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
      readonly resumeCursor?: unknown | null;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      const runtimeOwnerHeartbeatAt = yield* nowIso;
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(extra && "resumeCursor" in extra
          ? { resumeCursor: extra.resumeCursor }
          : session.resumeCursor !== undefined
            ? { resumeCursor: session.resumeCursor }
            : {}),
        runtimePayload: toRuntimePayloadFromSession(
          session,
          runtimeOwner,
          runtimeOwnerHeartbeatAt,
          extra,
        ),
      });
      runtimeOwnerHeartbeatWrittenAt.set(session.threadId, Date.parse(runtimeOwnerHeartbeatAt));
    });

  const upsertRunningTurnBinding = (input: {
    readonly threadId: ThreadId;
    readonly provider: ProviderDriverKind;
    readonly providerInstanceId: ProviderInstanceId;
    readonly turnId: TurnId;
    readonly resumeCursor?: unknown;
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent: "provider.sendTurn" | "provider.steerTurn";
  }) =>
    Effect.gen(function* () {
      const runtimeOwnerHeartbeatAt = yield* nowIso;
      yield* directory.upsert({
        threadId: input.threadId,
        provider: input.provider,
        providerInstanceId: input.providerInstanceId,
        status: "running",
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: input.turnId,
          lastRuntimeEvent: input.lastRuntimeEvent,
          lastRuntimeEventAt: runtimeOwnerHeartbeatAt,
          ...makeProviderRuntimeOwnerPayload(runtimeOwner, runtimeOwnerHeartbeatAt),
        },
      });
      runtimeOwnerHeartbeatWrittenAt.set(input.threadId, Date.parse(runtimeOwnerHeartbeatAt));
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        withThreadLifecycleLock(
          canonicalEvent.threadId,
          Effect.gen(function* () {
            const retiredThreadIds = yield* Ref.get(hardDeleteRetiredThreadIds);
            if (retiredThreadIds.has(canonicalEvent.threadId)) {
              return;
            }

            yield* persistSubagentHistoryBindingEvent(canonicalEvent);
            yield* persistRuntimeLifecycleEvent(canonicalEvent);
            yield* increment(providerRuntimeEventsTotal, {
              provider: canonicalEvent.provider,
              eventType: canonicalEvent.type,
            });
            yield* publishRuntimeEvent(canonicalEvent);
          }),
        ),
      ),
    );

  const processRuntimeEventSafely = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    processRuntimeEvent(source, event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider.runtime.event-fanout-failed", {
          sourceInstanceId: source.instanceId,
          sourceProvider: source.provider,
          provider: event.provider,
          providerInstanceId: event.providerInstanceId,
          threadId: event.threadId,
          turnId: event.turnId,
          eventId: event.eventId,
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const persistRuntimeLifecycleEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    const status = runtimeStatusFromEvent(event);
    const providerInstanceId = event.providerInstanceId;
    if (status === undefined || providerInstanceId === undefined) {
      return Effect.void;
    }
    // Preserve the narrowing across the deferred generator below. Runtime
    // events are immutable, but TypeScript cannot carry an optional-property
    // guard through a closure without this exact local capture.

    const activeTurnId = runtimeActiveTurnIdFromEvent(event);
    const lastError = runtimeLastErrorFromEvent(event);
    const resumeCursor =
      event.payload && typeof event.payload === "object" && "resumeCursor" in event.payload
        ? (event.payload as { readonly resumeCursor?: unknown }).resumeCursor
        : undefined;
    return Effect.gen(function* () {
      const runtimeOwnerHeartbeatAt = yield* nowIso;
      yield* directory.upsert({
        threadId: event.threadId,
        provider: event.provider,
        providerInstanceId,
        status,
        ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        runtimePayload: {
          ...(activeTurnId !== undefined ? { activeTurnId } : {}),
          ...(lastError !== undefined ? { lastError } : {}),
          lastRuntimeEvent: event.type,
          lastRuntimeEventAt: event.createdAt,
          ...makeProviderRuntimeOwnerPayload(runtimeOwner, runtimeOwnerHeartbeatAt),
        },
      });
      if (status === "running" && activeTurnId !== null && activeTurnId !== undefined) {
        runtimeOwnerHeartbeatWrittenAt.set(event.threadId, Date.parse(runtimeOwnerHeartbeatAt));
      } else {
        runtimeOwnerHeartbeatWrittenAt.delete(event.threadId);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.runtime.lifecycle-persist-failed", {
          threadId: event.threadId,
          provider: event.provider,
          providerInstanceId,
          eventType: event.type,
          cause,
        }),
      ),
    );
  };

  const persistSubagentHistoryBindingEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> => {
    const subagent =
      event.type === "task.started" ||
      event.type === "task.progress" ||
      event.type === "task.completed"
        ? event.payload.subagent
        : undefined;
    const providerInstanceId = event.providerInstanceId;
    if (subagent === undefined || event.turnId === undefined || providerInstanceId === undefined) {
      return Effect.void;
    }
    const turnId = event.turnId;

    return Effect.gen(function* () {
      const bindingOption = yield* directory.getBinding(event.threadId);
      const binding = Option.getOrUndefined(bindingOption);
      // Late events from a retired adapter must never overwrite or borrow the
      // new provider's root history scope. Correlation proves the emitting
      // instance; this exact comparison proves the still-current root binding.
      if (
        binding === undefined ||
        binding.provider !== event.provider ||
        binding.providerInstanceId !== providerInstanceId
      ) {
        return;
      }

      const cwd = boundedSubagentHistoryCwd(readPersistedCwd(binding.runtimePayload));
      const persistedAt = yield* nowIso;
      yield* directory.upsertSubagentHistoryBinding({
        threadId: event.threadId,
        turnId,
        subagentId: subagent.threadId,
        historyId: subagent.historyId ?? null,
        providerName: event.provider,
        providerInstanceId,
        resumeCursor: freezeSubagentHistoryResumeCursor(binding.resumeCursor),
        cwd,
        createdAt: persistedAt,
        updatedAt: persistedAt,
      });
    }).pipe(
      // Detail routing is supplemental history metadata. A storage failure
      // must not drop the lifecycle event itself, but it is logged without the
      // provider-native child/history ids or private resume/cwd values.
      Effect.catchCause(() =>
        Effect.logWarning("provider.subagent.history-binding-persist-failed", {
          threadId: event.threadId,
          turnId: event.turnId,
          provider: event.provider,
          providerInstanceId,
          eventType: event.type,
        }),
      ),
    );
  };

  const persistTurnSubagentHistoryRoot = (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly provider: ProviderDriverKind;
    readonly providerInstanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly resumeCursor?: unknown;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const persistedAt = yield* nowIso;
      const cwd = boundedSubagentHistoryCwd(readPersistedCwd(input.binding.runtimePayload));
      yield* directory.upsertSubagentHistoryBinding({
        threadId: input.threadId,
        turnId: input.turnId,
        // The empty child id is an internal write-only signal telling the
        // normalized repository to retain the immutable per-turn provider
        // root before an exact child lifecycle event arrives. Detail reads
        // never select this value and never fall back from an exact child.
        subagentId: "",
        historyId: null,
        providerName: input.provider,
        providerInstanceId: input.providerInstanceId,
        resumeCursor: freezeSubagentHistoryResumeCursor(
          input.resumeCursor !== undefined ? input.resumeCursor : input.binding.resumeCursor,
        ),
        cwd,
        createdAt: persistedAt,
        updatedAt: persistedAt,
      });
    }).pipe(
      // The provider turn may already be running when its acknowledgement
      // arrives. Failing the public send boundary here would invite a duplicate
      // retry, so degrade only the supplemental history surface and redact the
      // private binding/error values from logs.
      Effect.catchCause(() =>
        Effect.logWarning("provider.subagent.turn-history-binding-persist-failed", {
          threadId: input.threadId,
          turnId: input.turnId,
          provider: input.provider,
          providerInstanceId: input.providerInstanceId,
        }),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  const quiesceThreadForHardDelete: ProviderServiceShape["quiesceThreadForHardDelete"] = Effect.fn(
    "quiesceThreadForHardDelete",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.quiesceThreadForHardDelete",
      schema: ProviderStopSessionInput,
      payload: rawInput,
    });

    yield* withThreadLifecycleLock(
      input.threadId,
      Effect.gen(function* () {
        // Fence first. Adapter Stop is allowed to publish terminal events, and
        // those events intentionally wait behind this permit before observing
        // the fence and becoming no-ops. Therefore returning from this method
        // proves every event persistence operation that started before the
        // fence has drained, while later events cannot recreate deleted state.
        yield* Ref.update(hardDeleteRetiredThreadIds, (current) => {
          if (current.has(input.threadId)) {
            return current;
          }
          const next = new Set(current);
          next.add(input.threadId);
          return next;
        });

        const adapters = yield* getAdapterEntries;
        const stopExits = yield* Effect.forEach(
          adapters,
          ([, adapter]) =>
            Effect.gen(function* () {
              if (yield* adapter.hasSession(input.threadId)) {
                yield* adapter.stopSession(input.threadId);
              }
            }).pipe(Effect.exit),
          // A stale session on one provider must not prevent Cafe from trying
          // to retire the same immutable thread id on every other adapter.
          { concurrency: "unbounded" },
        );
        runtimeOwnerHeartbeatWrittenAt.delete(input.threadId);

        const failedStop = stopExits.find(Exit.isFailure);
        if (failedStop !== undefined && Exit.isFailure(failedStop)) {
          return yield* Effect.failCause(failedStop.cause);
        }
      }),
    );
  });

  const whileThreadAcceptsProviderWork = <A, E, R>(input: {
    readonly operation: string;
    readonly threadId: ThreadId;
    readonly effect: Effect.Effect<A, E, R>;
  }): Effect.Effect<A, E | ProviderValidationError, R> =>
    withThreadLifecycleLock(
      input.threadId,
      Effect.gen(function* () {
        const retiredThreadIds = yield* Ref.get(hardDeleteRetiredThreadIds);
        if (retiredThreadIds.has(input.threadId)) {
          return yield* Effect.fail(
            toValidationError(
              input.operation,
              `Thread '${input.threadId}' is permanently retired and cannot accept provider work.`,
            ),
          );
        }
        return yield* input.effect;
      }),
    );

  const whileThreadsAcceptProviderWork = <A, E, R>(input: {
    readonly operation: string;
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly effect: Effect.Effect<A, E, R>;
  }): Effect.Effect<A, E | ProviderValidationError, R> =>
    withThreadLifecycleLocks(
      input.threadIds,
      Effect.gen(function* () {
        const retiredThreadIds = yield* Ref.get(hardDeleteRetiredThreadIds);
        const retiredThreadId = input.threadIds.find((threadId) => retiredThreadIds.has(threadId));
        if (retiredThreadId !== undefined) {
          return yield* Effect.fail(
            toValidationError(
              input.operation,
              `Thread '${retiredThreadId}' is permanently retired and cannot accept provider work.`,
            ),
          );
        }
        return yield* input.effect;
      }),
    );

  const persistUnlessThreadRetired = <E, R>(
    threadId: ThreadId,
    effect: Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R> =>
    withThreadLifecycleLock(
      threadId,
      Effect.gen(function* () {
        const retiredThreadIds = yield* Ref.get(hardDeleteRetiredThreadIds);
        if (retiredThreadIds.has(threadId)) {
          return;
        }
        yield* effect;
      }),
    );

  const runAdapterEventSubscription = (
    id: ProviderInstanceId,
    adapter: ProviderAdapterShape<ProviderAdapterError>,
  ) =>
    Effect.gen(function* () {
      let restartCount = 0;
      while (true) {
        const result = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEventSafely(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.failCause(cause);
              }
              return Effect.succeed({
                kind: "failed" as const,
                cause: Cause.pretty(cause),
              });
            },
            onSuccess: () =>
              Effect.succeed({
                kind: "completed" as const,
              }),
          }),
        );

        const current = yield* Ref.get(subscribedAdapters);
        if (current.get(id) !== adapter) {
          yield* Effect.logDebug("provider.runtime.adapter-event-stream-retired", {
            providerInstanceId: id,
            provider: adapter.provider,
            reason: result.kind,
            restartCount,
          });
          return;
        }

        restartCount += 1;
        yield* Effect.logWarning("provider.runtime.adapter-event-stream-stopped", {
          providerInstanceId: id,
          provider: adapter.provider,
          reason: result.kind,
          restartCount,
          ...(result.kind === "failed" ? { cause: result.cause } : {}),
        });
        yield* Effect.sleep(PROVIDER_ADAPTER_EVENT_STREAM_RESTART_DELAY);
      }
    });

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* runAdapterEventSubscription(id, adapter).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedAdditionalDirectories = readPersistedAdditionalDirectories(
        input.binding.runtimePayload,
      );
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      const startInput = {
        threadId: input.binding.threadId,
        provider: input.binding.provider,
        providerInstanceId: bindingInstanceId,
        ...(persistedCwd ? { cwd: persistedCwd } : {}),
        ...(persistedAdditionalDirectories !== undefined
          ? { additionalDirectories: persistedAdditionalDirectories }
          : {}),
        ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
        ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
        runtimeMode: input.binding.runtimeMode ?? "full-access",
      } satisfies ProviderSessionStartInput;
      const recoveredFromRejectedResumeCursor = yield* Ref.make(false);
      const resumed = yield* adapter.startSession(startInput).pipe(
        Effect.catch((error) => {
          if (
            !hasResumeCursor ||
            !isRejectedResumeCursorError({ provider: input.binding.provider, error })
          ) {
            return Effect.fail(error);
          }

          const { resumeCursor: _staleResumeCursor, ...freshStartInput } = startInput;
          return Ref.set(recoveredFromRejectedResumeCursor, true).pipe(
            Effect.andThen(
              emitRejectedResumeCursorRecoveryWarning({
                provider: input.binding.provider,
                providerInstanceId: bindingInstanceId,
                threadId: input.binding.threadId,
                operation: input.operation,
              }),
            ),
            Effect.andThen(
              Effect.logWarning("provider.session.resume-cursor-rejected", {
                threadId: input.binding.threadId,
                provider: input.binding.provider,
                providerInstanceId: bindingInstanceId,
                operation: input.operation,
                reason: rejectedResumeCursorRecoveryReason(input.binding.provider),
              }),
            ),
            Effect.andThen(adapter.startSession(freshStartInput)),
          );
        }),
      );
      if (resumed.provider !== adapter.provider) {
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      const usedRejectedResumeCursorRecovery = yield* Ref.get(recoveredFromRejectedResumeCursor);
      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
        usedRejectedResumeCursorRecovery && resumed.resumeCursor === undefined
          ? { resumeCursor: null }
          : undefined,
      );
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
    readonly requiredProvider?: ProviderDriverKind;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    if (input.requiredProvider !== undefined && binding.provider !== input.requiredProvider) {
      return yield* toValidationError(
        input.operation,
        "The persisted thread binding does not use the provider required by this operation.",
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);
    if (adapter.provider !== binding.provider) {
      return yield* toValidationError(
        input.operation,
        "The configured provider instance does not match the persisted thread binding.",
      );
    }

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        binding,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        binding,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      binding,
      instanceId,
      threadId: input.threadId,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceShape["startSession"] = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in Cafe Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        const effectiveAdditionalDirectories =
          input.additionalDirectories ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedAdditionalDirectories(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
          "provider.additional_directories.count": effectiveAdditionalDirectories?.length ?? 0,
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        const startInput = {
          ...input,
          providerInstanceId: resolvedInstanceId,
          ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
          ...(effectiveAdditionalDirectories !== undefined
            ? { additionalDirectories: effectiveAdditionalDirectories }
            : {}),
          ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
        } satisfies ProviderSessionStartInput;
        const recoveredFromRejectedResumeCursor = yield* Ref.make(false);
        const session = yield* adapter.startSession(startInput).pipe(
          Effect.catch((error) => {
            if (
              effectiveResumeCursor === undefined ||
              !isRejectedResumeCursorError({ provider: resolvedProvider, error })
            ) {
              return Effect.fail(error);
            }

            const { resumeCursor: _staleResumeCursor, ...freshStartInput } = startInput;
            return Ref.set(recoveredFromRejectedResumeCursor, true).pipe(
              Effect.andThen(
                emitRejectedResumeCursorRecoveryWarning({
                  provider: resolvedProvider,
                  providerInstanceId: resolvedInstanceId,
                  threadId,
                  operation: "ProviderService.startSession",
                }),
              ),
              Effect.andThen(
                Effect.logWarning("provider.session.resume-cursor-rejected", {
                  threadId,
                  provider: resolvedProvider,
                  providerInstanceId: resolvedInstanceId,
                  operation: "ProviderService.startSession",
                  reason: rejectedResumeCursorRecoveryReason(resolvedProvider),
                }),
              ),
              Effect.andThen(adapter.startSession(freshStartInput)),
            );
          }),
        );

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
          ...(effectiveAdditionalDirectories !== undefined
            ? { additionalDirectories: effectiveAdditionalDirectories }
            : {}),
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        const usedRejectedResumeCursorRecovery = yield* Ref.get(recoveredFromRejectedResumeCursor);
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
          ...(usedRejectedResumeCursorRecovery && sessionWithInstance.resumeCursor === undefined
            ? { resumeCursor: null }
            : {}),
        });

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const forkSessionUnlocked: ProviderServiceShape["forkSession"] = Effect.fn("forkSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.forkSession",
        schema: ProviderForkSessionInput,
        payload: rawInput,
      });
      if (input.sourceThreadId === input.targetThreadId) {
        return yield* toValidationError(
          "ProviderService.forkSession",
          "A provider fork must use a new target thread id.",
        );
      }

      const existingTarget = Option.getOrUndefined(
        yield* directory.getBinding(input.targetThreadId),
      );
      if (existingTarget) {
        const forkedFromThreadId = readPersistedString(
          existingTarget.runtimePayload,
          "forkedFromThreadId",
        );
        const forkOperationId = readPersistedString(
          existingTarget.runtimePayload,
          "forkOperationId",
        );
        const providerInstanceId = yield* requireBindingInstanceId(
          "ProviderService.forkSession",
          existingTarget,
        );
        if (
          forkedFromThreadId !== input.sourceThreadId ||
          forkOperationId !== input.operationId ||
          existingTarget.resumeCursor === null ||
          existingTarget.resumeCursor === undefined
        ) {
          return yield* toValidationError(
            "ProviderService.forkSession",
            `Target thread '${input.targetThreadId}' already has an unrelated provider binding.`,
          );
        }

        // A client can retry after the provider fork succeeded but before the
        // Cafe domain commit/response became visible. The target binding is the
        // durable idempotency record, so never create a second native branch.
        return {
          operationId: input.operationId,
          sourceThreadId: input.sourceThreadId,
          targetThreadId: input.targetThreadId,
          provider: existingTarget.provider,
          providerInstanceId,
          runtimeMode: existingTarget.runtimeMode ?? "full-access",
          ...(readPersistedString(existingTarget.runtimePayload, "interactionMode")
            ? {
                interactionMode: readPersistedString(
                  existingTarget.runtimePayload,
                  "interactionMode",
                ) as NonNullable<ProviderSession["interactionMode"]>,
              }
            : {}),
          ...(readPersistedCwd(existingTarget.runtimePayload)
            ? { cwd: readPersistedCwd(existingTarget.runtimePayload) }
            : {}),
          ...(readPersistedAdditionalDirectories(existingTarget.runtimePayload) !== undefined
            ? {
                additionalDirectories: readPersistedAdditionalDirectories(
                  existingTarget.runtimePayload,
                ),
              }
            : {}),
          ...(readPersistedString(existingTarget.runtimePayload, "model")
            ? { model: readPersistedString(existingTarget.runtimePayload, "model") }
            : {}),
          ...(readPersistedModelSelection(existingTarget.runtimePayload)
            ? { modelSelection: readPersistedModelSelection(existingTarget.runtimePayload) }
            : {}),
          resumeCursor: existingTarget.resumeCursor,
        } satisfies ProviderSessionForkResult;
      }

      const routed = yield* resolveRoutableSession({
        threadId: input.sourceThreadId,
        operation: "ProviderService.forkSession",
        allowRecovery: true,
      });
      if (
        routed.adapter.capabilities.sessionFork !== "supported" ||
        routed.adapter.forkSession === undefined ||
        routed.adapter.discardSessionFork === undefined
      ) {
        return yield* toValidationError(
          "ProviderService.forkSession",
          `Provider '${routed.adapter.provider}' does not support native session forks.`,
        );
      }

      const liveSession = (yield* routed.adapter.listSessions()).find(
        (session) => session.threadId === input.sourceThreadId,
      );
      if (
        !liveSession ||
        liveSession.status === "connecting" ||
        liveSession.status === "running" ||
        liveSession.activeTurnId !== undefined
      ) {
        return yield* toValidationError(
          "ProviderService.forkSession",
          `Thread '${input.sourceThreadId}' must be idle before it can be forked.`,
        );
      }

      yield* Effect.annotateCurrentSpan({
        "provider.operation": "fork-session",
        "provider.kind": routed.adapter.provider,
        "provider.instance_id": routed.instanceId,
        "provider.thread_id": input.sourceThreadId,
        "provider.fork.target_thread_id": input.targetThreadId,
      });

      const adapterFork = yield* routed.adapter.forkSession(input);
      if (
        adapterFork.operationId !== input.operationId ||
        adapterFork.sourceThreadId !== input.sourceThreadId ||
        adapterFork.targetThreadId !== input.targetThreadId ||
        adapterFork.provider !== routed.adapter.provider ||
        adapterFork.resumeCursor === null ||
        adapterFork.resumeCursor === undefined
      ) {
        return yield* toValidationError(
          "ProviderService.forkSession",
          "Provider returned an invalid or mismatched native fork result.",
        );
      }

      const fork = {
        ...adapterFork,
        providerInstanceId: routed.instanceId,
      } satisfies ProviderSessionForkResult;
      const forkedAt = yield* nowIso;
      yield* directory.upsert({
        threadId: fork.targetThreadId,
        provider: fork.provider,
        providerInstanceId: routed.instanceId,
        runtimeMode: fork.runtimeMode,
        status: "stopped",
        resumeCursor: fork.resumeCursor,
        runtimePayload: {
          forkOperationId: fork.operationId,
          forkedFromThreadId: fork.sourceThreadId,
          cwd: fork.cwd ?? null,
          additionalDirectories: fork.additionalDirectories ?? null,
          model: fork.model ?? null,
          modelSelection: fork.modelSelection ?? null,
          interactionMode: fork.interactionMode ?? null,
          activeTurnId: null,
          lastError: null,
          lastRuntimeEvent: "provider.session.forked",
          lastRuntimeEventAt: forkedAt,
        },
      });
      return fork;
    },
  );

  const discardSessionForkUnlocked: ProviderServiceShape["discardSessionFork"] = Effect.fn(
    "discardSessionFork",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.discardSessionFork",
      schema: ProviderDiscardSessionForkInput,
      payload: rawInput,
    });
    const binding = Option.getOrUndefined(yield* directory.getBinding(input.fork.targetThreadId));
    if (!binding) {
      return;
    }
    const providerInstanceId = yield* requireBindingInstanceId(
      "ProviderService.discardSessionFork",
      binding,
    );
    if (
      providerInstanceId !== input.fork.providerInstanceId ||
      binding.provider !== input.fork.provider ||
      readPersistedString(binding.runtimePayload, "forkOperationId") !== input.fork.operationId ||
      readPersistedString(binding.runtimePayload, "forkedFromThreadId") !==
        input.fork.sourceThreadId
    ) {
      return yield* toValidationError(
        "ProviderService.discardSessionFork",
        `Target thread '${input.fork.targetThreadId}' is not the requested provider fork.`,
      );
    }

    const adapter = yield* registry.getByInstance(providerInstanceId);
    if (adapter.discardSessionFork === undefined) {
      return yield* toValidationError(
        "ProviderService.discardSessionFork",
        `Provider '${adapter.provider}' cannot discard native session forks.`,
      );
    }
    yield* adapter.discardSessionFork(input.fork);
    yield* directory.remove(input.fork.targetThreadId);
  });

  const forkSession: ProviderServiceShape["forkSession"] = (input) =>
    sessionForkMutationSemaphore.withPermit(forkSessionUnlocked(input));
  const discardSessionFork: ProviderServiceShape["discardSessionFork"] = (input) =>
    sessionForkMutationSemaphore.withPermit(discardSessionForkUnlocked(input));

  const sendTurn: ProviderServiceShape["sendTurn"] = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      if (
        routed.adapter.capabilities.liveSteer === "supported" &&
        input.allowActiveTurnSteerFallback !== false
      ) {
        // Projection state can lag the provider runtime during long streams or
        // reconnects. Ask the adapter for its live session before starting a
        // turn, and route additional input through its supported steer/queue
        // path whenever it still owns an active turn. This applies to Codex's
        // native steer RPC and Claude's non-interrupting SDK input queue. The
        // one opt-out is terminal-steer recovery: that durable message is
        // authorized only as a new turn, so its caller deliberately lets the
        // adapter reject a concurrently appearing active turn instead.
        const activeSessions = yield* routed.adapter.listSessions();
        const activeSession = activeSessions.find((session) => session.threadId === input.threadId);
        if (activeSession?.status === "running" && activeSession.activeTurnId !== undefined) {
          const turn = yield* routed.adapter.steerTurn({
            threadId: input.threadId,
            expectedTurnId: activeSession.activeTurnId,
            ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
            ...(input.input !== undefined ? { input: input.input } : {}),
            ...(input.attachments.length > 0 ? { attachments: input.attachments } : {}),
          });
          yield* persistTurnSubagentHistoryRoot({
            binding: routed.binding,
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            threadId: input.threadId,
            turnId: turn.turnId,
            ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          });
          yield* upsertRunningTurnBinding({
            threadId: input.threadId,
            provider: routed.adapter.provider,
            providerInstanceId: routed.instanceId,
            turnId: turn.turnId,
            ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
            lastRuntimeEvent: "provider.steerTurn",
          });
          return turn;
        }
      }
      const turn = yield* routed.adapter.sendTurn(input);
      yield* persistTurnSubagentHistoryRoot({
        binding: routed.binding,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        threadId: input.threadId,
        turnId: turn.turnId,
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
      });
      yield* upsertRunningTurnBinding({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        turnId: turn.turnId,
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        lastRuntimeEvent: "provider.sendTurn",
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const steerTurn: ProviderServiceShape["steerTurn"] = Effect.fn("steerTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.steerTurn",
      schema: ProviderSteerTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.steerTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "steer-turn",
      "provider.thread_id": input.threadId,
      "provider.expected_turn_id": input.expectedTurnId,
      "provider.attachment_count": input.attachments.length,
    });

    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.steerTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      if (routed.adapter.capabilities.liveSteer !== "supported") {
        return yield* toValidationError(
          "ProviderService.steerTurn",
          `Provider '${routed.adapter.provider}' does not support live steering`,
        );
      }
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
      });
      const turn = yield* routed.adapter.steerTurn(input);
      yield* persistTurnSubagentHistoryRoot({
        binding: routed.binding,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        threadId: input.threadId,
        turnId: turn.turnId,
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
      });
      yield* upsertRunningTurnBinding({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        turnId: turn.turnId,
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        lastRuntimeEvent: "provider.steerTurn",
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: undefined,
            extra: {
              operation: "steer",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const snoozeUserInput: ProviderServiceShape["snoozeUserInput"] = Effect.fn("snoozeUserInput")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.snoozeUserInput",
        schema: ProviderSnoozeUserInputInput,
        payload: rawInput,
      });
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.snoozeUserInput",
        allowRecovery: true,
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "snooze-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });

      // Blocking-only providers have nothing to snooze. Keeping this capability
      // optional avoids inventing a fake acknowledgement in Claude/OpenCode while
      // still routing Codex's explicit non-blocking contract through the daemon.
      if (routed.adapter.snoozeUserInput) {
        yield* routed.adapter.snoozeUserInput(routed.threadId, input.requestId);
      }
    },
  );

  const stopSession: ProviderServiceShape["stopSession"] = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const restartProviderRuntime: ProviderServiceShape["restartProviderRuntime"] = Effect.fn(
    "restartProviderRuntime",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.restartProviderRuntime",
      schema: ProviderRuntimeRestartInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const instanceInfo = yield* registry.getInstanceInfo(input.instanceId);
      const adapter = yield* registry.getByInstance(input.instanceId);
      metricProvider = adapter.provider;
      const restartedAt = yield* nowIso;
      const activeSessions = yield* adapter.listSessions();
      const activeThreadIds = new Set(activeSessions.map((session) => session.threadId));

      yield* Effect.annotateCurrentSpan({
        "provider.operation": "restart-runtime",
        "provider.kind": adapter.provider,
        "provider.instance_id": input.instanceId,
        "provider.session_count": activeSessions.length,
      });

      // Persist a stopped boundary before asking the adapter to tear down its
      // process tree. This matches shutdown semantics: after the restart,
      // future user input must reopen Codex/Claude through `startSession`
      // using durable resume state, rather than steering a runtime Cafe no
      // longer owns.
      yield* Effect.forEach(activeSessions, (session) =>
        persistUnlessThreadRetired(
          session.threadId,
          directory.upsert({
            threadId: session.threadId,
            provider: adapter.provider,
            providerInstanceId: input.instanceId,
            runtimeMode: session.runtimeMode,
            status: "stopped",
            ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
            runtimePayload: {
              cwd: session.cwd ?? null,
              additionalDirectories: session.additionalDirectories ?? [],
              model: session.model ?? null,
              activeTurnId: null,
              lastError: session.lastError ?? null,
              lastRuntimeEvent: "provider.runtime.restart",
              lastRuntimeEventAt: restartedAt,
            },
          }),
        ),
      ).pipe(Effect.asVoid);

      const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
      yield* Effect.forEach(bindings, (binding) => {
        const bindingInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.restartProviderRuntime",
          binding,
        );
        if (bindingInstanceId !== input.instanceId || activeThreadIds.has(binding.threadId)) {
          return Effect.void;
        }
        return persistUnlessThreadRetired(
          binding.threadId,
          directory.upsert({
            threadId: binding.threadId,
            provider: binding.provider,
            providerInstanceId: bindingInstanceId,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
              lastRuntimeEvent: "provider.runtime.restart",
              lastRuntimeEventAt: restartedAt,
            },
          }),
        );
      }).pipe(Effect.asVoid);

      yield* adapter.stopAll();

      return {
        instanceId: input.instanceId,
        provider: instanceInfo.driverKind,
        stoppedSessionCount: activeSessions.length,
      };
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "restart-runtime",
          }),
      }),
    );
  });

  const readAdapterSessions = Effect.gen(function* () {
    const currentAdapters = yield* getAdapterEntries;
    return yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByProvider) => sessionsByProvider.flatMap((sessions) => sessions)));
  });

  const refreshRuntimeOwnerHeartbeats = (sessions: ReadonlyArray<ProviderSession>) =>
    runtimeOwnerHeartbeatSemaphore.withPermit(
      Effect.gen(function* () {
        const observedAtMs = yield* Clock.currentTimeMillis;
        const dueSessions = sessions.filter((session) => {
          if (session.status !== "running" || session.activeTurnId === undefined) {
            return false;
          }
          const lastWrittenAt = runtimeOwnerHeartbeatWrittenAt.get(session.threadId);
          return (
            lastWrittenAt === undefined ||
            observedAtMs - lastWrittenAt >= PROVIDER_RUNTIME_OWNER_HEARTBEAT_INTERVAL_MS
          );
        });

        // Heartbeats update one bounded runtime row per live turn. They never
        // append orchestration events, provider text, or credentials, and they
        // are serialized to avoid creating SQLite write contention under a
        // large set of long-running sessions.
        yield* Effect.forEach(
          dueSessions,
          (session) =>
            persistUnlessThreadRetired(
              session.threadId,
              upsertSessionBinding(session, session.threadId),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.runtime.owner-heartbeat-write-failed", {
                  threadId: session.threadId,
                  provider: session.provider,
                  providerInstanceId: session.providerInstanceId,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          { concurrency: 1, discard: true },
        );
      }),
    );

  const listSessions: ProviderServiceShape["listSessions"] = Effect.fn("listSessions")(
    function* () {
      const activeSessions = yield* readAdapterSessions;
      const persistedBindings = yield* directory.listThreadIds().pipe(
        Effect.flatMap((threadIds) =>
          Effect.forEach(
            threadIds,
            (threadId) =>
              directory
                .getBinding(threadId)
                .pipe(Effect.orElseSucceed(() => Option.none<ProviderRuntimeBinding>())),
            { concurrency: "unbounded" },
          ),
        ),
        Effect.orElseSucceed(() => [] as Array<Option.Option<ProviderRuntimeBinding>>),
      );
      const bindingsByThreadId = new Map<ThreadId, ProviderRuntimeBinding>();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      yield* refreshRuntimeOwnerHeartbeats(sessions);
      return sessions;
    },
  );

  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.millis(PROVIDER_RUNTIME_OWNER_HEARTBEAT_INTERVAL_MS));
      yield* Effect.gen(function* () {
        const sessions = yield* readAdapterSessions;
        yield* refreshRuntimeOwnerHeartbeats(sessions);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.runtime.owner-heartbeat-cycle-failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  }).pipe(Effect.forkScoped);

  const getCapabilities: ProviderServiceShape["getCapabilities"] = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceShape["getInstanceInfo"] = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const requireGoalAdapter = Effect.fn("requireGoalAdapter")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
  }) {
    const routed = yield* resolveRoutableSession({
      threadId: input.threadId,
      operation: input.operation,
      allowRecovery: true,
    });
    if (
      routed.adapter.capabilities.threadGoals !== "supported" ||
      routed.adapter.getGoal === undefined ||
      routed.adapter.setGoal === undefined ||
      routed.adapter.clearGoal === undefined
    ) {
      return yield* toValidationError(
        input.operation,
        `Provider '${routed.adapter.provider}' does not support durable thread goals`,
      );
    }
    return {
      ...routed,
      getGoal: routed.adapter.getGoal,
      setGoal: routed.adapter.setGoal,
      clearGoal: routed.adapter.clearGoal,
    };
  });

  const getGoal: NonNullable<ProviderServiceShape["getGoal"]> = Effect.fn("getGoal")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.getGoal",
        schema: ProviderThreadGoalGetInput,
        payload: rawInput,
      });
      const routed = yield* requireGoalAdapter({
        threadId: input.threadId,
        operation: "ProviderService.getGoal",
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "get-goal",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      return yield* routed.getGoal(input.threadId);
    },
  );

  const setGoal: NonNullable<ProviderServiceShape["setGoal"]> = Effect.fn("setGoal")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.setGoal",
        schema: ProviderThreadGoalSetInput,
        payload: rawInput,
      });
      if (
        input.objective !== undefined &&
        input.objective !== null &&
        Array.from(input.objective).length > PROVIDER_THREAD_GOAL_MAX_OBJECTIVE_CODE_POINTS
      ) {
        return yield* toValidationError(
          "ProviderService.setGoal",
          `Goal objective exceeds ${PROVIDER_THREAD_GOAL_MAX_OBJECTIVE_CODE_POINTS} Unicode code points`,
        );
      }
      const routed = yield* requireGoalAdapter({
        threadId: input.threadId,
        operation: "ProviderService.setGoal",
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "set-goal",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        // Goal objectives are user content and must not enter traces.
        "provider.goal.objective_present": input.objective !== undefined,
        "provider.goal.status": input.status ?? "unchanged",
        "provider.goal.token_budget": input.tokenBudget ?? "unchanged",
      });
      return yield* routed.setGoal(input);
    },
  );

  const clearGoal: NonNullable<ProviderServiceShape["clearGoal"]> = Effect.fn("clearGoal")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.clearGoal",
        schema: ProviderThreadGoalClearInput,
        payload: rawInput,
      });
      const routed = yield* requireGoalAdapter({
        threadId: input.threadId,
        operation: "ProviderService.clearGoal",
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "clear-goal",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      return yield* routed.clearGoal(input.threadId);
    },
  );

  const readThread: NonNullable<ProviderServiceShape["readThread"]> = Effect.fn("readThread")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.readThread",
        schema: ProviderReadThreadInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.readThread",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "read-thread",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        const snapshot = yield* routed.adapter.readThread(routed.threadId);
        return {
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          snapshot,
        };
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "read-thread",
            }),
        }),
      );
    },
  );

  const readSubagentDetail: ProviderServiceShape["readSubagentDetail"] = Effect.fn(
    "readSubagentDetail",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.readSubagentDetail",
      schema: ProviderReadSubagentDetailInput,
      payload: rawInput,
    });
    const historyBindingOption = yield* directory.getSubagentHistoryBinding({
      threadId: input.threadId,
      turnId: input.turnId,
      subagentId: input.subagentId,
      historyId: input.historyId ?? null,
    });
    const historyBinding = Option.getOrUndefined(historyBindingOption);
    if (historyBinding === undefined) {
      return yield* toValidationError(
        "ProviderService.readSubagentDetail",
        "No immutable provider history binding exists for the selected subagent.",
      );
    }
    const adapter = yield* registry.getByInstance(historyBinding.providerInstanceId);
    if (adapter.provider !== historyBinding.providerName) {
      return yield* toValidationError(
        "ProviderService.readSubagentDetail",
        "The configured provider instance does not match the persisted subagent history binding.",
      );
    }
    if (adapter.readSubagentDetail === undefined) {
      return yield* toValidationError(
        "ProviderService.readSubagentDetail",
        "The selected provider does not expose verified subagent transcript history.",
      );
    }

    // Do not attach the provider child id or returned text to tracing. Both are
    // provider-owned user data; only stable Cafe identity and finite counts are
    // safe diagnostics for this operation.
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "read-subagent-detail",
      "provider.kind": historyBinding.providerName,
      "provider.thread_id": input.threadId,
    });
    const detail = yield* adapter.readSubagentDetail(input.threadId, input.subagentId, {
      resumeCursor: historyBinding.resumeCursor,
      ...(historyBinding.cwd ? { cwd: historyBinding.cwd } : {}),
      ...(input.historyId ? { historyId: input.historyId } : {}),
    });
    const publicDetail = yield* makePublicProviderSubagentDetailBody(detail);
    return {
      provider: historyBinding.providerName,
      providerInstanceId: historyBinding.providerInstanceId,
      messages: publicDetail.messages,
      gaps: publicDetail.gaps,
      truncated: publicDetail.truncated,
    };
  });

  const rollbackConversation: ProviderServiceShape["rollbackConversation"] = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const currentAdapters = yield* getAdapterEntries;
    const stopAllTimestamp = yield* nowIso;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));

    // Persist the stop boundary before asking adapters to tear down processes.
    // Finalizers can be interrupted by desktop shutdown, process death, or an
    // adapter-specific stop failure. Writing "stopped + no active turn" first
    // prevents the next backend from advertising a live steerable turn for a
    // Codex/Claude process Cafe no longer owns; the durable resume cursor still
    // lets the next user message reopen the provider thread in a fresh runtime.
    yield* Effect.forEach(activeSessions, (session) =>
      persistUnlessThreadRetired(
        session.threadId,
        directory.upsert({
          threadId: session.threadId,
          provider: session.provider,
          providerInstanceId: session.providerInstanceId,
          runtimeMode: session.runtimeMode,
          status: "stopped",
          ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
          runtimePayload: {
            cwd: session.cwd ?? null,
            additionalDirectories: session.additionalDirectories ?? [],
            model: session.model ?? null,
            activeTurnId: null,
            lastError: session.lastError ?? null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: stopAllTimestamp,
          },
        }),
      ),
    ).pipe(Effect.asVoid);
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* persistUnlessThreadRetired(
          binding.threadId,
          directory.upsert({
            threadId: binding.threadId,
            provider: binding.provider,
            providerInstanceId,
            status: "stopped",
            runtimePayload: {
              activeTurnId: null,
              lastRuntimeEvent: "provider.stopAll",
              lastRuntimeEventAt: stopAllTimestamp,
            },
          }),
        );
      }),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        adapter.stopAll().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.stop-all-failed", {
              provider: adapter.provider,
              providerInstanceId: instanceId,
              cause,
            }),
          ),
        ),
      { discard: true },
    );
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", { cause: Cause.pretty(cause) }),
      ),
    ),
  );

  return {
    startSession: (threadId, input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.startSession",
        threadId,
        effect: startSession(threadId, input),
      }),
    forkSession: (input) =>
      whileThreadsAcceptProviderWork({
        operation: "ProviderService.forkSession",
        threadIds: [input.sourceThreadId, input.targetThreadId],
        effect: forkSession(input),
      }),
    discardSessionFork: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.discardSessionFork",
        threadId: input.fork.targetThreadId,
        effect: discardSessionFork(input),
      }),
    sendTurn: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.sendTurn",
        threadId: input.threadId,
        effect: sendTurn(input),
      }),
    steerTurn: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.steerTurn",
        threadId: input.threadId,
        effect: steerTurn(input),
      }),
    interruptTurn: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.interruptTurn",
        threadId: input.threadId,
        effect: interruptTurn(input),
      }),
    respondToRequest: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.respondToRequest",
        threadId: input.threadId,
        effect: respondToRequest(input),
      }),
    respondToUserInput: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.respondToUserInput",
        threadId: input.threadId,
        effect: respondToUserInput(input),
      }),
    snoozeUserInput: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.snoozeUserInput",
        threadId: input.threadId,
        effect: snoozeUserInput(input),
      }),
    stopSession: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.stopSession",
        threadId: input.threadId,
        effect: stopSession(input),
      }),
    quiesceThreadForHardDelete,
    restartProviderRuntime,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    getGoal: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.getGoal",
        threadId: input.threadId,
        effect: getGoal(input),
      }),
    setGoal: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.setGoal",
        threadId: input.threadId,
        effect: setGoal(input),
      }),
    clearGoal: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.clearGoal",
        threadId: input.threadId,
        effect: clearGoal(input),
      }),
    readThread: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.readThread",
        threadId: input.threadId,
        effect: readThread(input),
      }),
    readSubagentDetail: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.readSubagentDetail",
        threadId: input.threadId,
        effect: readSubagentDetail(input),
      }),
    rollbackConversation: (input) =>
      whileThreadAcceptsProviderWork({
        operation: "ProviderService.rollbackConversation",
        threadId: input.threadId,
        effect: rollbackConversation(input),
      }),
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceShape["streamEvents"] {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderServiceShape;
});

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}
