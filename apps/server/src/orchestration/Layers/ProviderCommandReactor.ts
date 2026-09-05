import {
  type ChatAttachment,
  CommandId,
  EventId,
  type MessageId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProviderInteractionMode,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TurnId,
} from "@cafecode/contracts";
import {
  isTemporaryWorktreeBranch,
  LEGACY_WORKTREE_BRANCH_PREFIX,
  WORKTREE_BRANCH_PREFIX,
} from "@cafecode/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@cafecode/shared/DrainableWorker";

import {
  resolveThreadWorkspaceCwd,
  resolveThreadWorkspaceDirectories,
} from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { hasLiveProviderRuntimeOwner } from "../../provider/providerRuntimeOwnerEvidence.ts";
import { makeProviderSessionTitle } from "../../provider/providerSessionTitle.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ServerConfig } from "../../config.ts";
import {
  composeSystemPromptProviderInput,
  readSystemPromptFileForInjection,
} from "../../systemPromptFile.ts";
import { makeProviderTurnRecoveryEvidenceReader } from "../providerTurnRecoveryEvidence.ts";
import {
  buildCodexSteerAcceptedActivityCommand,
  buildCodexSteerDeliveredActivityCommand,
  buildCodexSteerDeliveryAttemptedActivityCommand,
  buildCodexSteerNextTurnQueuedCommand,
  buildCodexSteerRecoveredActivityCommand,
  buildCodexSteerRecoveryQueuedCommand,
  buildTerminalCodexSteerRecoveryCommands,
  codexSteerAcceptanceEvidenceFromProjection,
  type CodexSteerAcceptanceEvidence,
  type CodexSteerNextTurnReason,
  decideCodexSteerRecovery,
} from "../codexSteerRecovery.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const RAW_PROVIDER_PROCESS_FAILURE_PATTERN =
  /\b(?:ProviderAdapterProcessError|Provider adapter process error|process exited with code|Claude Code process exited|Codex CLI .*failed to run)\b/i;

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.turn-steer-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.user-input-snooze-requested"
      | "thread.session-stop-requested"
      | "thread.goal-set-requested"
      | "thread.goal-clear-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

function activeTurnIdFromDurableBinding(
  binding: Pick<ProviderRuntimeBinding, "runtimePayload">,
  observedAtMs: number,
): TurnId | undefined {
  const payload = binding.runtimePayload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  if (!hasLiveProviderRuntimeOwner(payload, observedAtMs)) {
    return undefined;
  }
  const activeTurnId = (payload as Readonly<Record<string, unknown>>).activeTurnId;
  return typeof activeTurnId === "string" && activeTurnId.trim().length > 0
    ? TurnId.make(activeTurnId)
    : undefined;
}

type CodexSteerRecoveryLiveness =
  | {
      readonly _tag: "active";
      readonly activeTurnId: TurnId;
      readonly localSession: ProviderSession | undefined;
      readonly durableBinding: ProviderRuntimeBinding | undefined;
    }
  | {
      readonly _tag: "inactive";
      readonly localSession: ProviderSession | undefined;
      readonly durableBinding: ProviderRuntimeBinding | undefined;
    }
  | {
      readonly _tag: "unknown";
      readonly reason:
        | "local-session-read-failed"
        | "durable-binding-read-failed"
        | "durable-owner-unverified"
        | "provider-ownership-conflict"
        | "active-turn-unresolved"
        | "active-turn-conflict";
    };

function areStringArraysEqual(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((entry, index) => entry === normalizedRight[index])
  );
}

function providerDriverDisplayName(value: string | undefined): string {
  switch (value) {
    case "claudeAgent":
      return "Claude";
    case "codex":
      return "Codex";
    case "grok":
      return "Grok Build";
    case "opencode":
      return "OpenCode";
    default:
      return providerErrorLabel(value);
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
const PROVIDER_CONTINUATION_BOOTSTRAP_TRANSCRIPT_MAX_CHARS = 40_000;
const PROVIDER_CONTINUATION_BOOTSTRAP_MIN_TRANSCRIPT_CHARS = 500;
const ORPHANED_TURN_START_RESTART_DETAIL =
  "Turn start was interrupted by application restart before a provider turn started. The prompt was not resent automatically to avoid duplicate provider work; resend the message to continue.";
const ORPHANED_ACTIVE_TURN_RESTART_DETAIL =
  "The provider process ended during an active turn. Cafe Code closed the stale running state after restart; send a follow-up to continue from the retained transcript.";
const INTERRUPT_RETRY_RESTART_DETAIL =
  "Cafe Code restored a pending Stop after backend restart and cancelled the same provider-owned turn.";

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function formatProviderBootstrapMessage(message: OrchestrationMessage): string | undefined {
  if (message.role === "assistant" && message.streaming) {
    return undefined;
  }
  const text = message.text.trim();
  const attachments = message.attachments ?? [];
  if (text.length === 0 && attachments.length === 0) {
    return undefined;
  }
  const role =
    message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User";
  const attachmentLine =
    attachments.length > 0
      ? `\n[attachments: ${attachments.map((attachment) => attachment.name).join(", ")}]`
      : "";
  return `${role}:\n${text.length > 0 ? text : "[no text]"}${attachmentLine}`;
}

function buildBoundedProviderBootstrapTranscript(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly currentMessageId: MessageId | undefined;
  readonly maxChars: number;
}): string | undefined {
  const formattedMessages = input.messages.flatMap((message) => {
    if (input.currentMessageId !== undefined && message.id === input.currentMessageId) {
      return [];
    }
    const formatted = formatProviderBootstrapMessage(message);
    return formatted === undefined ? [] : [formatted];
  });
  if (
    formattedMessages.length === 0 ||
    input.maxChars < PROVIDER_CONTINUATION_BOOTSTRAP_MIN_TRANSCRIPT_CHARS
  ) {
    return undefined;
  }

  const selected: string[] = [];
  let usedChars = 0;
  let omittedEarlierMessages = false;
  for (let index = formattedMessages.length - 1; index >= 0; index -= 1) {
    const block = formattedMessages[index] as string;
    const separatorChars = selected.length === 0 ? 0 : 2;
    const remaining = input.maxChars - usedChars - separatorChars;
    if (remaining <= 0) {
      omittedEarlierMessages = true;
      break;
    }
    if (block.length > remaining) {
      if (remaining >= PROVIDER_CONTINUATION_BOOTSTRAP_MIN_TRANSCRIPT_CHARS) {
        selected.unshift(`${block.slice(0, remaining - 32)}\n[message truncated]`);
      }
      omittedEarlierMessages = true;
      break;
    }
    selected.unshift(block);
    usedChars += block.length + separatorChars;
  }

  if (selected.length === 0) {
    return undefined;
  }
  if (omittedEarlierMessages) {
    selected.unshift("[Earlier Cafe-visible messages omitted due to length.]");
  }
  return selected.join("\n\n");
}

function composeProviderContinuationBootstrapInput(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly currentMessageId: MessageId | undefined;
  readonly currentUserInput: string | undefined;
}): string | undefined {
  const currentUserInput =
    input.currentUserInput ??
    "[No text was provided with this request. Use the attached input, if any, with the prior chat context.]";
  const prefix =
    "You are taking over an existing Cafe Code chat in a new provider session.\n" +
    "The previous provider session cannot be resumed by this provider, so Cafe is providing the visible prior chat transcript below. Use it as context for the current request; do not repeat or re-answer earlier messages unless asked.\n\n" +
    "Prior Cafe-visible chat transcript:\n";
  const suffix = `\n\nCurrent user request:\n${currentUserInput}`;
  const transcriptBudget = Math.min(
    PROVIDER_CONTINUATION_BOOTSTRAP_TRANSCRIPT_MAX_CHARS,
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS - prefix.length - suffix.length,
  );
  const transcript = buildBoundedProviderBootstrapTranscript({
    messages: input.messages,
    currentMessageId: input.currentMessageId,
    maxChars: transcriptBudget,
  });
  if (transcript === undefined) {
    return input.currentUserInput;
  }
  return `${prefix}${transcript}${suffix}`;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<unknown>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

/**
 * A provider instance is absent only when the local registry or remote daemon
 * says so explicitly. Transport errors such as `ECONNREFUSED` are operational
 * outages and must remain retryable failures instead of being rewritten as a
 * configuration problem.
 */
export function isProviderInstanceMissingError(error: ProviderServiceError): boolean {
  if (error._tag === "ProviderUnsupportedError" || error._tag === "ProviderInstanceNotFoundError") {
    return true;
  }
  return (
    error._tag === "ProviderAdapterRequestError" &&
    (error.remoteErrorTag === "ProviderUnsupportedError" ||
      error.remoteErrorTag === "ProviderInstanceNotFoundError")
  );
}

type CodexNonSteerableTurnKind = "review" | "compact";

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCodexNonSteerableTurnKindFromData(
  value: unknown,
): CodexNonSteerableTurnKind | undefined {
  const data = readRecord(value);
  const codexErrorInfo = readRecord(data?.codexErrorInfo ?? data?.codex_error_info);
  const activeTurnNotSteerable = readRecord(
    codexErrorInfo?.activeTurnNotSteerable ?? codexErrorInfo?.active_turn_not_steerable,
  );
  const turnKind = activeTurnNotSteerable?.turnKind ?? activeTurnNotSteerable?.turn_kind;
  return turnKind === "review" || turnKind === "compact" ? turnKind : undefined;
}

function readNestedCodexNonSteerableTurnKind(
  value: unknown,
  seen = new WeakSet<object>(),
): CodexNonSteerableTurnKind | undefined {
  const structured = readCodexNonSteerableTurnKindFromData(value);
  if (structured !== undefined) {
    return structured;
  }

  const record = readRecord(value);
  if (record === undefined) {
    return undefined;
  }
  if (seen.has(record)) {
    return undefined;
  }
  seen.add(record);

  return (
    readNestedCodexNonSteerableTurnKind(record.data, seen) ??
    readNestedCodexNonSteerableTurnKind(record.cause, seen)
  );
}

function detectCodexNonSteerableTurnKind(
  cause: Cause.Cause<unknown>,
): CodexNonSteerableTurnKind | undefined {
  const providerError = findProviderAdapterRequestError(cause);
  const structured = readNestedCodexNonSteerableTurnKind(providerError?.cause);
  if (structured !== undefined) {
    return structured;
  }

  const detail = `${providerError?.detail ?? ""}\n${Cause.pretty(cause)}`.toLowerCase();
  if (detail.includes("cannot steer a review turn")) {
    return "review";
  }
  if (detail.includes("cannot steer a compact turn")) {
    return "compact";
  }
  return undefined;
}

function findProviderAdapterProcessError(
  cause: Cause.Cause<unknown>,
): ProviderAdapterProcessError | undefined {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const error = reason.error;
    if (isProviderAdapterProcessError(error)) {
      return error;
    }
  }
  return undefined;
}

function sanitizeProviderFailureDetail(detail: string): string {
  return RAW_PROVIDER_PROCESS_FAILURE_PATTERN.test(detail)
    ? "Provider runtime exited while starting. Cafe Code attempted automatic fresh-session recovery; if this repeats, check the selected provider account, model access, and local CLI install."
    : detail;
}

function isUnsupportedLiveSteerFailure(cause: Cause.Cause<unknown>): boolean {
  const providerError = findProviderAdapterRequestError(cause);
  const detail = `${providerError?.detail ?? ""}\n${Cause.pretty(cause)}`.toLowerCase();
  return detail.includes("does not support live steering");
}

function isRejectedGrokInterjectFailure(cause: Cause.Cause<unknown>): boolean {
  const providerError = findProviderAdapterRequestError(cause);
  const detail = `${providerError?.detail ?? ""}\n${Cause.pretty(cause)}`.toLowerCase();
  return (
    (String(providerError?.provider ?? "") === "grok" &&
      providerError?.method === "x.ai/interject") ||
    (detail.includes("(grok)") && detail.includes("x.ai/interject"))
  );
}

function isCodexNoActiveTurnToSteerFailure(cause: Cause.Cause<unknown>): boolean {
  const providerError = findProviderAdapterRequestError(cause);
  const detail = `${providerError?.detail ?? ""}\n${Cause.pretty(cause)}`.toLowerCase();
  return detail.includes("turn/steer") && detail.includes("no active turn to steer");
}

function detectCodexActiveTurnRunningStartFailure(cause: Cause.Cause<unknown>): TurnId | undefined {
  const providerError = findProviderAdapterRequestError(cause);
  const detail = `${providerError?.detail ?? ""}\n${Cause.pretty(cause)}`;
  if (!detail.toLowerCase().includes("cannot start a new codex turn while active turn")) {
    return undefined;
  }
  const match = /active turn '([^']+)' is running/.exec(detail);
  return match?.[1] ? TurnId.make(match[1]) : undefined;
}

function codexNonSteerableDetail(turnKind: CodexNonSteerableTurnKind): string {
  return `Codex reported a ${turnKind} active turn. Cafe Code preserved this follow-up for automatic delivery after the active turn is ready.`;
}

function retryableFollowUpDetail(): string {
  return "Cafe Code preserved this follow-up for automatic delivery after the active turn is ready.";
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = [WORKTREE_BRANCH_PREFIX, LEGACY_WORKTREE_BRANCH_PREFIX].reduce(
    (value, prefix) => (value.startsWith(`${prefix}/`) ? value.slice(`${prefix}/`.length) : value),
    normalized,
  );

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const readProviderTurnRecoveryEvidence = yield* makeProviderTurnRecoveryEvidenceReader;
  const serverConfig = yield* ServerConfig;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });
  const handledStaleSteerRecoveryKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });
  const enqueuedProviderIntentEventIds = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });
  const providerIntentAdmissionSemaphore = yield* Semaphore.make(1);

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const hasHandledStaleSteerRecoveryRecently = (key: string) =>
    Cache.getOption(handledStaleSteerRecoveryKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledStaleSteerRecoveryKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const claimProviderIntentEvent = (eventId: EventId) =>
    providerIntentAdmissionSemaphore.withPermit(
      Cache.getOption(enqueuedProviderIntentEventIds, eventId).pipe(
        Effect.flatMap((cached) =>
          Cache.set(enqueuedProviderIntentEventIds, eventId, true).pipe(
            Effect.as(Option.isNone(cached)),
          ),
        ),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  const getProviderSessionForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* providerService.listSessions().pipe(
      Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor could not list provider sessions", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(undefined)),
      ),
    );
  });

  /**
   * Recovery needs a stronger answer than the ordinary best-effort local
   * session lookup. A detached provider daemon may be the only process that
   * owns the live Codex turn, while a persistence failure means absence cannot
   * be proven at all. Resolve both sources on every recovery boundary and keep
   * `unknown` distinct from a verified lack of active work.
   */
  const resolveCodexSteerRecoveryLiveness: (
    threadId: ThreadId,
  ) => Effect.Effect<CodexSteerRecoveryLiveness> = Effect.fn("resolveCodexSteerRecoveryLiveness")(
    function* (threadId: ThreadId) {
      const [localRead, durableRead] = yield* Effect.all([
        providerService.listSessions().pipe(
          Effect.map((sessions) => ({ _tag: "success" as const, sessions })),
          Effect.catchCause((cause) => Effect.succeed({ _tag: "failure" as const, cause })),
        ),
        providerSessionDirectory.getBinding(threadId).pipe(
          Effect.map((binding) => ({ _tag: "success" as const, binding })),
          Effect.catchCause((cause) => Effect.succeed({ _tag: "failure" as const, cause })),
        ),
      ]);

      if (localRead._tag === "failure") {
        yield* Effect.logWarning(
          "provider command reactor could not prove Codex recovery liveness from local sessions",
          { threadId, cause: Cause.pretty(localRead.cause) },
        );
        return { _tag: "unknown", reason: "local-session-read-failed" };
      }
      if (durableRead._tag === "failure") {
        yield* Effect.logWarning(
          "provider command reactor could not prove Codex recovery liveness from durable ownership",
          { threadId, cause: Cause.pretty(durableRead.cause) },
        );
        return { _tag: "unknown", reason: "durable-binding-read-failed" };
      }

      const localSession = localRead.sessions.find((session) => session.threadId === threadId);
      const durableBinding = Option.getOrUndefined(durableRead.binding);
      if (
        (localSession !== undefined && String(localSession.provider) !== "codex") ||
        (durableBinding !== undefined && String(durableBinding.provider) !== "codex") ||
        (localSession?.providerInstanceId !== undefined &&
          durableBinding?.providerInstanceId !== undefined &&
          localSession.providerInstanceId !== durableBinding.providerInstanceId)
      ) {
        yield* Effect.logWarning(
          "provider command reactor found conflicting Codex recovery ownership",
          { threadId },
        );
        return { _tag: "unknown", reason: "provider-ownership-conflict" };
      }

      const localActiveTurnId =
        localSession?.status === "running" &&
        typeof localSession.activeTurnId === "string" &&
        localSession.activeTurnId.trim().length > 0
          ? TurnId.make(localSession.activeTurnId)
          : undefined;
      const durableActiveTurnId =
        durableBinding === undefined
          ? undefined
          : activeTurnIdFromDurableBinding(durableBinding, Date.now());
      const durablePayload =
        typeof durableBinding?.runtimePayload === "object" &&
        durableBinding.runtimePayload !== null &&
        !Array.isArray(durableBinding.runtimePayload)
          ? (durableBinding.runtimePayload as Readonly<Record<string, unknown>>)
          : undefined;
      const durableClaimedTurnId = durablePayload?.activeTurnId;

      // A freshly listed local runtime in `running` state is affirmative
      // liveness evidence even when a partially materialized session has not
      // exposed its turn id yet. Likewise, a live durable owner can persist a
      // running lifecycle event before the following `turn.started` event adds
      // `activeTurnId`. Neither state proves inactivity: starting recovery in
      // that window could create a second provider turn. An explicit durable
      // `activeTurnId: null` is different; terminal lifecycle persistence uses
      // that value to state that the live session owns no active turn.
      const localRunningTurnUnresolved =
        localSession?.status === "running" && localActiveTurnId === undefined;
      const durableOwnerIsLive =
        durablePayload !== undefined && hasLiveProviderRuntimeOwner(durablePayload, Date.now());
      const durableHasExplicitActiveTurn =
        durablePayload !== undefined &&
        Object.prototype.hasOwnProperty.call(durablePayload, "activeTurnId");
      const durableRunningTurnUnresolved =
        durableBinding?.status === "running" &&
        durableOwnerIsLive &&
        (!durableHasExplicitActiveTurn ||
          (durableClaimedTurnId !== null && durableActiveTurnId === undefined));
      if (localRunningTurnUnresolved || durableRunningTurnUnresolved) {
        yield* Effect.logWarning(
          "provider command reactor found live Codex ownership without an exact active turn",
          { threadId },
        );
        return { _tag: "unknown", reason: "active-turn-unresolved" };
      }
      if (
        localActiveTurnId === undefined &&
        typeof durableClaimedTurnId === "string" &&
        durableClaimedTurnId.trim().length > 0 &&
        durableActiveTurnId === undefined
      ) {
        yield* Effect.logWarning(
          "provider command reactor could not authenticate the durable Codex runtime owner",
          { threadId },
        );
        return { _tag: "unknown", reason: "durable-owner-unverified" };
      }
      if (
        localActiveTurnId !== undefined &&
        durableActiveTurnId !== undefined &&
        localActiveTurnId !== durableActiveTurnId
      ) {
        yield* Effect.logWarning(
          "provider command reactor found conflicting live Codex turns during recovery",
          { threadId },
        );
        return { _tag: "unknown", reason: "active-turn-conflict" };
      }

      const activeTurnId = localActiveTurnId ?? durableActiveTurnId;
      return activeTurnId === undefined
        ? { _tag: "inactive", localSession, durableBinding }
        : { _tag: "active", activeTurnId, localSession, durableBinding };
    },
  );

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.steer.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed"
      | "provider.goal.set.failed"
      | "provider.goal.clear.failed"
      | "provider.goal.replace.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly messageId?: MessageId;
    readonly intentSequence?: number;
    readonly retryableFollowUp?: boolean;
    readonly retryAfter?: "active-turn";
    readonly codexNonSteerableTurnKind?: CodexNonSteerableTurnKind;
    readonly recoveryBarrier?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.messageId ? { messageId: input.messageId } : {}),
          ...(input.intentSequence !== undefined ? { intentSequence: input.intentSequence } : {}),
          ...(input.retryableFollowUp !== undefined
            ? { retryableFollowUp: input.retryableFollowUp }
            : {}),
          ...(input.retryAfter ? { retryAfter: input.retryAfter } : {}),
          ...(input.codexNonSteerableTurnKind
            ? { codexNonSteerableTurnKind: input.codexNonSteerableTurnKind }
            : {}),
          ...(input.recoveryBarrier !== undefined
            ? { recoveryBarrier: input.recoveryBarrier }
            : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendProviderDiagnosticActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly tone?: "info" | "tool" | "approval" | "error";
    readonly payload?: Record<string, unknown>;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-diagnostic-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: input.tone ?? "info",
        kind: input.kind,
        summary: input.summary,
        payload: {
          message: input.summary,
          detail: input.detail,
          ...input.payload,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const queueGuardedTerminalSteerRecovery = (input: {
    readonly threadId: ThreadId;
    readonly staleTurnId: TurnId;
    readonly messageId: MessageId;
    readonly intentSequence: number;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch(
      buildCodexSteerRecoveryQueuedCommand({
        threadId: input.threadId,
        acceptedTurnId: input.staleTurnId,
        messageId: input.messageId,
        intentSequence: input.intentSequence,
        createdAt: input.createdAt,
        reason: "newer-turn-active",
      }),
    );

  const queueCodexSteerIntentRecovery = (input: {
    readonly threadId: ThreadId;
    readonly expectedTurnId: TurnId | null;
    readonly messageId: MessageId;
    readonly intentSequence: number;
    readonly createdAt: string;
    readonly reason:
      | "intent-tuple-unverified"
      | "unbound-expected-turn"
      | "newer-turn-requested"
      | "turn-interrupt-requested"
      | "session-stop-requested"
      | "provider-liveness-unknown"
      | "newer-turn-active";
  }) =>
    appendProviderFailureActivity({
      threadId: input.threadId,
      kind: "provider.turn.steer.failed",
      summary: "Provider steer queued",
      detail:
        "Cafe Code kept this saved steer queued because its original provider-turn target could not be revalidated safely.",
      turnId: input.expectedTurnId,
      createdAt: input.createdAt,
      messageId: input.messageId,
      intentSequence: input.intentSequence,
      retryableFollowUp: true,
      retryAfter: "active-turn",
      recoveryBarrier: input.reason,
    });

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return sanitizeProviderFailureDetail(providerError.detail);
    }
    const processError = findProviderAdapterProcessError(cause);
    if (processError) {
      return sanitizeProviderFailureDetail(processError.detail);
    }
    return sanitizeProviderFailureDetail(Cause.pretty(cause));
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly terminalTurnRecovery?: "live-provider-continuation";
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      ...(input.terminalTurnRecovery !== undefined
        ? { terminalTurnRecovery: input.terminalTurnRecovery }
        : {}),
      createdAt: input.createdAt,
    });

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        status: session.status === "stopped" ? "stopped" : "ready",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  /**
   * Record acceptance at the trusted command boundary, then reconcile the
   * ACK-after-terminal ordering immediately from durable projection state.
   * The same stable recovery commands are also built when terminal ingestion
   * or startup reconciliation wins the race, so receipts collapse every path.
   */
  const recordAcceptedCodexSteer = Effect.fn("recordAcceptedCodexSteer")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly messageId: MessageId;
    readonly intentSequence: number;
    readonly clientCorrelationId?: string;
    /** Immutable timestamp carried by the original turn-start/steer intent. */
    readonly intentCreatedAt: string;
    /** Local observation time after the provider accepted the request. */
    readonly acceptedAt: string;
  }) {
    const acceptedCommand = buildCodexSteerAcceptedActivityCommand({
      ...input,
      createdAt: input.acceptedAt,
    });
    const acceptedReceipt = yield* orchestrationEngine.dispatch(acceptedCommand);
    const [projectionEvidence, recoveryLiveness] = yield* Effect.all([
      projectionSnapshotQuery.getCodexSteerAcceptanceEvidence({
        exactAcceptedBarrier: {
          _tag: "accepted",
          threadId: input.threadId,
          eventSequence: acceptedReceipt.sequence,
          intentSequence: input.intentSequence,
          intentCreatedAt: input.intentCreatedAt,
          activityId: acceptedCommand.activity.id,
          acceptedTurnId: input.turnId,
          clientCorrelationId: input.clientCorrelationId ?? null,
          messageId: input.messageId,
          acceptedAt: input.acceptedAt,
        },
      }),
      resolveCodexSteerRecoveryLiveness(input.threadId),
    ]);
    const providerActiveTurnId =
      recoveryLiveness._tag === "active" ? recoveryLiveness.activeTurnId : null;
    const durableEvidence = projectionEvidence.map(codexSteerAcceptanceEvidenceFromProjection);
    const recoveryCommands =
      recoveryLiveness._tag === "unknown"
        ? []
        : buildTerminalCodexSteerRecoveryCommands({
            evidence: durableEvidence,
            providerActiveTurnId,
            createdAt: input.acceptedAt,
          });
    yield* Effect.forEach(recoveryCommands, orchestrationEngine.dispatch, {
      concurrency: 1,
      discard: true,
    });
    const acceptedEvidence = durableEvidence.find(
      (evidence) =>
        evidence.intentSequence === input.intentSequence &&
        evidence.acceptedTurnId === input.turnId &&
        evidence.message.id === input.messageId,
    );
    const acceptedTurnIsTerminal =
      acceptedEvidence !== undefined &&
      (acceptedEvidence.turnCompletedAt !== null || acceptedEvidence.turnState !== "running");
    return {
      mayMarkAcceptedTurnRunning:
        !acceptedTurnIsTerminal &&
        recoveryLiveness._tag === "active" &&
        recoveryLiveness.activeTurnId === input.turnId,
      recoveryDispatched: recoveryCommands.length > 0,
    } as const;
  });

  /**
   * Re-read every durable boundary immediately before an automatic terminal
   * recovery can touch the provider. The recovery command may have waited in
   * the worker while Codex emitted the original user item, the user pressed
   * Stop, or another turn started. Those facts must win over the earlier
   * decision; a stale command is never permission to duplicate or redirect
   * the saved prompt.
   */
  const revalidateTerminalCodexSteerRecovery = Effect.fn("revalidateTerminalCodexSteerRecovery")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly staleTurnId: TurnId;
      readonly messageId: MessageId;
      readonly intentSequence: number;
      readonly createdAt: string;
    }) {
      const [projectionEvidence, recoveryLiveness, currentThread] = yield* Effect.all([
        projectionSnapshotQuery.getCodexSteerAcceptanceEvidence({
          threadId: input.threadId,
          acceptedTurnId: input.staleTurnId,
          messageId: input.messageId,
        }),
        resolveCodexSteerRecoveryLiveness(input.threadId),
        resolveThread(input.threadId),
      ]);
      const evidence = projectionEvidence
        .map(codexSteerAcceptanceEvidenceFromProjection)
        .find(
          (candidate) =>
            candidate.acceptedTurnId === input.staleTurnId &&
            candidate.intentSequence === input.intentSequence &&
            candidate.message.id === input.messageId,
        );
      if (evidence === undefined) {
        yield* Effect.logWarning(
          "provider command reactor rejected terminal steer recovery without trusted evidence",
          {
            threadId: input.threadId,
            staleTurnId: input.staleTurnId,
            messageId: input.messageId,
          },
        );
        return { shouldDeliver: false } as const;
      }

      if (recoveryLiveness._tag === "unknown") {
        return { shouldDeliver: false } as const;
      }

      const projectedNewerTurnId = [
        currentThread?.session?.activeTurnId ?? null,
        currentThread?.latestTurn?.turnId ?? null,
      ].find((turnId): turnId is TurnId => turnId !== null && turnId !== input.staleTurnId);
      const providerActiveTurnId =
        projectedNewerTurnId ??
        (recoveryLiveness._tag === "active" ? recoveryLiveness.activeTurnId : null);
      const decision = decideCodexSteerRecovery({
        evidence,
        providerActiveTurnId,
        createdAt: input.createdAt,
      });
      if (decision.disposition === "recover-as-next-turn") {
        return { shouldDeliver: true, evidence } as const;
      }
      yield* Effect.forEach(decision.commands, orchestrationEngine.dispatch, {
        concurrency: 1,
        discard: true,
      });
      return { shouldDeliver: false } as const;
    },
  );

  const recordTerminalCodexSteerRecoveryDelivered = Effect.fn(
    "recordTerminalCodexSteerRecoveryDelivered",
  )(function* (input: {
    readonly evidence: CodexSteerAcceptanceEvidence;
    readonly recoveredTurnId: TurnId;
    readonly createdAt: string;
  }) {
    yield* orchestrationEngine.dispatch(
      buildCodexSteerRecoveredActivityCommand({
        threadId: input.evidence.threadId,
        acceptedTurnId: input.evidence.acceptedTurnId,
        messageId: input.evidence.message.id,
        intentSequence: input.evidence.intentSequence,
        recoveredTurnId: input.recoveredTurnId,
        ...(input.evidence.clientCorrelationId !== undefined
          ? { clientCorrelationId: input.evidence.clientCorrelationId }
          : {}),
        createdAt: input.createdAt,
      }),
    );
  });

  const recoverInterruptedProviderWorkOnStartup = Effect.fn(
    "recoverInterruptedProviderWorkOnStartup",
  )(function* () {
    // This startup repair only needs thread shell/session state. Do not use
    // the full orchestration snapshot here: large long-running workspaces can
    // contain millions of persisted message/activity rows, and hydrating all
    // of them during backend boot can push Electron's Node runtime into OOM.
    const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const activeProviderSessions = yield* providerService.listSessions();
    const durableProviderBindings = yield* providerSessionDirectory.listBindings();
    // ProviderService can be process-local (for example, a web/dev backend),
    // while a detached desktop daemon owns the real turn. Upstream Codex treats
    // an active buffered turn as positive liveness evidence; merge the durable
    // directory with local sessions so an auxiliary backend cannot terminate
    // another runtime's turn merely because its own session map is empty. A
    // durable `running` flag is not sufficient by itself: the owner lease must
    // also have a fresh heartbeat and a live PID, otherwise a crashed daemon
    // could preserve a phantom turn forever.
    const liveProviderTurnByThreadId = new Map<string, TurnId>();
    const recoveryObservedAtMs = Date.now();
    for (const binding of durableProviderBindings) {
      const activeTurnId = activeTurnIdFromDurableBinding(binding, recoveryObservedAtMs);
      if (activeTurnId !== undefined) {
        liveProviderTurnByThreadId.set(String(binding.threadId), activeTurnId);
      }
    }
    for (const session of activeProviderSessions) {
      if (session.status === "running" && session.activeTurnId !== undefined) {
        liveProviderTurnByThreadId.set(String(session.threadId), session.activeTurnId);
      }
    }
    const runningProviderThreadIds = new Set(liveProviderTurnByThreadId.keys());
    const interruptedThreads = shellSnapshot.threads.filter(
      (thread) =>
        thread.session?.status === "starting" &&
        thread.session.activeTurnId === null &&
        !runningProviderThreadIds.has(thread.id),
    );
    const orphanedActiveThreads = shellSnapshot.threads.filter((thread) => {
      const projectedTurnId = thread.session?.activeTurnId;
      if (
        thread.session?.status !== "running" ||
        projectedTurnId === null ||
        projectedTurnId === undefined
      ) {
        return false;
      }
      const liveTurnId = liveProviderTurnByThreadId.get(thread.id);
      return liveTurnId === undefined || String(liveTurnId) !== String(projectedTurnId);
    });
    const terminalThreadsWithLiveTurns = shellSnapshot.threads.flatMap((thread) => {
      const runtimeTurnId = liveProviderTurnByThreadId.get(thread.id);
      return thread.session?.status === "interrupted" &&
        thread.latestTurn?.state === "interrupted" &&
        runtimeTurnId !== undefined &&
        String(thread.latestTurn.turnId) === String(runtimeTurnId)
        ? [{ thread, runtimeTurnId }]
        : [];
    });
    const classifiedTerminalTurns = yield* Effect.forEach(
      terminalThreadsWithLiveTurns,
      ({ thread, runtimeTurnId }) =>
        readProviderTurnRecoveryEvidence({ threadId: thread.id, turnId: runtimeTurnId }).pipe(
          Effect.map((evidence) => ({ thread, runtimeTurnId, evidence })),
          // On an unreadable event ledger, preserve provider work. Retrying an
          // interrupt without durable proof is destructive and diverges from
          // upstream's positive-liveness rule.
          Effect.catchCause((cause) =>
            Effect.logWarning("provider turn recovery evidence lookup failed", {
              threadId: thread.id,
              turnId: runtimeTurnId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as({ thread, runtimeTurnId, evidence: "none" as const })),
          ),
        ),
      { concurrency: 4 },
    );
    const falselyInterruptedProviderTurns = classifiedTerminalTurns.filter(
      (entry) => entry.evidence === "orphaned-active-turn",
    );
    const interruptedProviderTurns = classifiedTerminalTurns.filter(
      (entry) => entry.evidence === "interrupt-requested",
    );
    if (
      interruptedThreads.length === 0 &&
      orphanedActiveThreads.length === 0 &&
      falselyInterruptedProviderTurns.length === 0 &&
      interruptedProviderTurns.length === 0
    ) {
      return;
    }
    const recoveredAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    yield* Effect.forEach(
      interruptedThreads,
      (thread) =>
        Effect.gen(function* () {
          const session = thread.session;
          if (session === null) {
            return;
          }
          yield* setThreadSession({
            threadId: thread.id,
            session: {
              ...session,
              status: "ready",
              activeTurnId: null,
              lastError: ORPHANED_TURN_START_RESTART_DETAIL,
              updatedAt: recoveredAt,
            },
            createdAt: recoveredAt,
          });
          yield* appendProviderFailureActivity({
            threadId: thread.id,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start interrupted",
            detail: ORPHANED_TURN_START_RESTART_DETAIL,
            turnId: null,
            createdAt: recoveredAt,
          });
        }),
      { concurrency: 1 },
    );
    yield* Effect.forEach(
      orphanedActiveThreads,
      (thread) =>
        Effect.gen(function* () {
          const session = thread.session;
          if (session === null) {
            return;
          }
          const activeTurnId = session.activeTurnId;
          yield* setThreadSession({
            threadId: thread.id,
            session: {
              ...session,
              status: "interrupted",
              activeTurnId: null,
              lastError: ORPHANED_ACTIVE_TURN_RESTART_DETAIL,
              updatedAt: recoveredAt,
            },
            createdAt: recoveredAt,
          });
          yield* appendProviderDiagnosticActivity({
            threadId: thread.id,
            kind: "runtime.warning",
            summary: "Provider turn interrupted by restart",
            detail: ORPHANED_ACTIVE_TURN_RESTART_DETAIL,
            turnId: activeTurnId,
            createdAt: recoveredAt,
            tone: "error",
            payload: { recovery: "orphaned-active-turn" },
          });
        }),
      { concurrency: 1 },
    );
    yield* Effect.forEach(
      falselyInterruptedProviderTurns,
      ({ thread, runtimeTurnId }) =>
        Effect.gen(function* () {
          const session = thread.session;
          if (session === null) {
            return;
          }
          yield* setThreadSession({
            threadId: thread.id,
            session: {
              ...session,
              status: "running",
              activeTurnId: runtimeTurnId,
              lastError: null,
              updatedAt: recoveredAt,
            },
            terminalTurnRecovery: "live-provider-continuation",
            createdAt: recoveredAt,
          });
          yield* appendProviderDiagnosticActivity({
            threadId: thread.id,
            kind: "runtime.warning",
            summary: "Live provider turn restored after restart reconciliation",
            detail:
              "Cafe Code found durable provider ownership for a turn that another backend had incorrectly closed. The live turn was restored without resending input.",
            turnId: runtimeTurnId,
            createdAt: recoveredAt,
            tone: "info",
            payload: { recovery: "false-orphan-terminal-restored" },
          });
        }),
      { concurrency: 1 },
    );
    yield* Effect.forEach(
      interruptedProviderTurns,
      ({ thread, runtimeTurnId }) =>
        providerService.interruptTurn({ threadId: thread.id, turnId: runtimeTurnId }).pipe(
          Effect.flatMap(() =>
            appendProviderDiagnosticActivity({
              threadId: thread.id,
              kind: "provider.turn.interrupt.completed",
              summary: "Provider turn interrupt restored after restart",
              detail: INTERRUPT_RETRY_RESTART_DETAIL,
              turnId: runtimeTurnId,
              createdAt: recoveredAt,
              payload: { recovery: "pending-interrupt" },
            }),
          ),
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: thread.id,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt recovery failed",
              detail: formatFailureDetail(cause),
              turnId: runtimeTurnId,
              createdAt: recoveredAt,
            }),
          ),
        ),
      { concurrency: 1 },
    );
    yield* Effect.logWarning(
      "provider command reactor reconciled interrupted provider work after restart",
      {
        interruptedStartCount: interruptedThreads.length,
        orphanedActiveTurnCount: orphanedActiveThreads.length,
        restoredFalseTerminalCount: falselyInterruptedProviderTurns.length,
        retriedInterruptCount: interruptedProviderTurns.length,
      },
    );
  });

  const resumeActiveCodexGoalsOnStartup = Effect.fn("resumeActiveCodexGoalsOnStartup")(
    function* () {
      const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
      const activeGoalThreads = readModel.threads.filter(
        (thread) =>
          thread.deletedAt === null &&
          thread.archivedAt === null &&
          thread.goal?.status === "active",
      );
      yield* Effect.forEach(
        activeGoalThreads,
        (thread) =>
          Effect.gen(function* () {
            const instanceId =
              thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
            const capabilities = yield* providerService.getCapabilities(instanceId);
            if (capabilities.threadGoals !== "supported") {
              return;
            }
            // Codex app-server owns automatic continuation. Materializing or
            // adopting the session is sufficient; Cafe must never manufacture
            // a hidden continuation prompt from the goal objective.
            yield* ensureSessionForThread(thread.id, thread.goal!.updatedAt, { thread });
          }).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("provider goal resume failed during startup", {
                threadId: thread.id,
                providerInstanceId:
                  thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
                // Goal objectives are user content and are deliberately absent.
              }),
            ),
          ),
        { concurrency: 2, discard: true },
      );
    },
  );

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly thread?: OrchestrationThread;
      readonly project?: OrchestrationProjectShell;
      readonly activeSession?: ProviderSession | undefined;
      readonly activeSessionResolved?: boolean;
      readonly interactionMode?: ProviderInteractionMode;
    },
  ) {
    const thread = options?.thread ?? (yield* resolveThread(threadId));
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const desiredInteractionMode = options?.interactionMode ?? thread.interactionMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession =
      options?.activeSessionResolved === true
        ? options.activeSession
        : yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.session?.providerInstanceId !== undefined
          ? thread.session.providerInstanceId
          : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError((error) =>
        isProviderInstanceMissingError(error)
          ? new ProviderAdapterRequestError({
              provider: providerErrorLabelFromInstanceHint({
                instanceId: String(desiredModelSelection.instanceId),
              }),
              method: "thread.turn.start",
              detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
              remoteErrorTag:
                error._tag === "ProviderAdapterRequestError" ? error.remoteErrorTag : error._tag,
              cause: error,
            })
          : error,
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    const requestedInstanceChange = desiredInstanceId !== currentInstanceId;
    const currentInfo = requestedInstanceChange
      ? activeSession === undefined
        ? Option.none()
        : yield* providerService.getInstanceInfo(currentInstanceId).pipe(
            Effect.tapError(() =>
              Effect.logWarning(
                "provider command reactor could not resolve current provider instance while switching sessions",
                {
                  threadId,
                  currentInstanceId,
                  desiredInstanceId,
                  currentProvider: thread.session?.providerName ?? null,
                },
              ),
            ),
            Effect.option,
          )
      : Option.some(desiredInfo);
    const providerResumeIdentityChanged =
      requestedInstanceChange &&
      (Option.isNone(currentInfo) ||
        currentInfo.value.driverKind !== desiredInfo.driverKind ||
        currentInfo.value.continuationIdentity.continuationKey !==
          desiredInfo.continuationIdentity.continuationKey);
    const project = options?.project ?? (yield* resolveProject(thread.projectId));
    const workspaceDirectories = resolveThreadWorkspaceDirectories({
      thread,
      projects: project ? [project] : [],
    });
    const effectiveCwd = workspaceDirectories.cwd;
    const effectiveAdditionalDirectories = workspaceDirectories.additionalDirectories;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(preferredProvider === "claudeAgent"
          ? { title: makeProviderSessionTitle(thread.title) }
          : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(effectiveAdditionalDirectories.length > 0
          ? { additionalDirectories: effectiveAdditionalDirectories }
          : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        interactionMode: desiredInteractionMode,
        runtimeMode: desiredRuntimeMode,
      });

    const syncGoalAfterSessionMaterialization = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined || providerService.getGoal === undefined) {
          return;
        }
        const capabilities = yield* providerService.getCapabilities(session.providerInstanceId);
        if (capabilities.threadGoals !== "supported") {
          return;
        }

        // Keep the startup read and any immediately following goal mutation on
        // the reactor's serial command path. Sending a synthetic snapshot
        // through the independent provider-event bridge can let a delayed
        // pre-mutation "no goal" observation erase a newer RPC response.
        const goal = yield* providerService.getGoal({ threadId });
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestrationEngine.dispatch({
          type: "thread.goal.sync",
          commandId: CommandId.make(`provider-goal-session-sync:${crypto.randomUUID()}`),
          threadId,
          goal,
          createdAt: observedAt,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider goal session materialization sync failed", {
            threadId,
            provider: session.provider,
            providerInstanceId: session.providerInstanceId,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              thread.session?.status === "starting" && thread.session.activeTurnId === null
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
        yield* syncGoalAfterSessionMaterialization(session);
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId && activeSession !== undefined) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const grokInteractionModeChanged =
        activeSession.provider === ProviderDriverKind.make("grok") &&
        (activeSession.interactionMode ?? "default") !== desiredInteractionMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const additionalDirectoriesChanged = !areStringArraysEqual(
        effectiveAdditionalDirectories,
        activeSession?.additionalDirectories,
      );
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const restartResumeModelSelectionChanged =
        sessionModelSwitch === "restart-resume" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(activeSession.modelSelection, requestedModelSelection);
      const shouldRestartForModelSelectionChange =
        restartResumeModelSelectionChanged ||
        (preferredProvider === "claudeAgent" &&
          requestedModelSelection !== undefined &&
          !Equal.equals(previousModelSelection, requestedModelSelection));

      if (
        !runtimeModeChanged &&
        !grokInteractionModeChanged &&
        !cwdChanged &&
        !additionalDirectoriesChanged &&
        !instanceChanged &&
        !providerResumeIdentityChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return activeSession;
      }

      // Provider resume state is only meaningful inside the same provider
      // continuation identity. A cross-driver switch such as Claude -> Codex,
      // or a custom instance switch with a different continuation key, keeps
      // Cafe's durable thread history but must start a fresh provider session.
      const resumeCursor =
        shouldRestartForModelChange || providerResumeIdentityChanged
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        grokInteractionModeChanged,
        currentInteractionMode: activeSession.interactionMode ?? "default",
        desiredInteractionMode,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        previousAdditionalDirectories: activeSession?.additionalDirectories ?? [],
        desiredAdditionalDirectories: effectiveAdditionalDirectories,
        additionalDirectoriesChanged,
        modelChanged,
        instanceChanged,
        providerResumeIdentityChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        restartResumeModelSelectionChanged,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
        additionalDirectories: restartedSession.additionalDirectories,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession;
  });

  const shouldBootstrapProviderContinuationContext = Effect.fn(
    "shouldBootstrapProviderContinuationContext",
  )(function* (input: {
    readonly thread: OrchestrationThread;
    readonly desiredModelSelection: ModelSelection;
    readonly activeSession?: ProviderSession | undefined;
  }) {
    const currentInstanceId =
      input.activeSession?.providerInstanceId ?? input.thread.session?.providerInstanceId;
    if (
      currentInstanceId === undefined ||
      currentInstanceId === input.desiredModelSelection.instanceId
    ) {
      return false;
    }

    const desiredInfo = yield* providerService
      .getInstanceInfo(input.desiredModelSelection.instanceId)
      .pipe(Effect.option);
    if (Option.isNone(desiredInfo)) {
      return false;
    }
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.tapError(() =>
        Effect.logWarning(
          "provider command reactor could not resolve current provider instance for context bootstrap",
          {
            threadId: input.thread.id,
            currentInstanceId,
            desiredInstanceId: input.desiredModelSelection.instanceId,
          },
        ),
      ),
      Effect.option,
    );
    if (Option.isNone(currentInfo)) {
      return true;
    }
    return (
      currentInfo.value.driverKind !== desiredInfo.value.driverKind ||
      currentInfo.value.continuationIdentity.continuationKey !==
        desiredInfo.value.continuationIdentity.continuationKey
    );
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId?: MessageId;
    readonly allowActiveTurnSteerFallback?: boolean;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: ProviderInteractionMode;
    readonly createdAt: string;
    readonly thread?: OrchestrationThread;
    readonly project?: OrchestrationProjectShell;
  }) {
    const thread = input.thread ?? (yield* resolveThread(input.threadId));
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const shouldBootstrapProviderContext =
      input.modelSelection !== undefined
        ? yield* shouldBootstrapProviderContinuationContext({
            thread,
            desiredModelSelection: input.modelSelection,
            activeSession,
          })
        : false;
    const ensuredSession = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      thread,
      ...(input.project !== undefined ? { project: input.project } : {}),
      activeSession,
      activeSessionResolved: true,
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const isFirstUserMessageTurn =
      input.messageId !== undefined &&
      thread.messages.filter((entry) => entry.role === "user" && entry.id !== input.messageId)
        .length === 0;
    const systemPrompt = isFirstUserMessageTurn
      ? yield* readSystemPromptFileForInjection(serverConfig.systemPromptPath)
      : undefined;
    const providerInput =
      systemPrompt !== undefined
        ? composeSystemPromptProviderInput({ systemPrompt, userMessage: normalizedInput })
        : shouldBootstrapProviderContext
          ? yield* resolveThread(input.threadId).pipe(
              Effect.map((latestThread) =>
                composeProviderContinuationBootstrapInput({
                  messages: (latestThread ?? thread).messages,
                  currentMessageId: input.messageId,
                  currentUserInput: normalizedInput,
                }),
              ),
            )
          : normalizedInput;
    const normalizedAttachments = input.attachments ?? [];
    const sessionModelSwitch =
      ensuredSession.providerInstanceId === undefined
        ? yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(ensuredSession.provider),
            method: "thread.turn.start",
            detail: `Active provider session '${ensuredSession.threadId}' is missing a provider instance id.`,
          })
        : (yield* providerService.getCapabilities(ensuredSession.providerInstanceId))
            .sessionModelSwitch;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? ensuredSession.model !== undefined
          ? {
              ...requestedModelSelection,
              model: ensuredSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      ...(input.allowActiveTurnSteerFallback !== undefined
        ? { allowActiveTurnSteerFallback: input.allowActiveTurnSteerFallback }
        : {}),
      ...(providerInput ? { input: providerInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const markThreadRunningFromSendTurnResult = Effect.fn("markThreadRunningFromSendTurnResult")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly createdAt?: string;
    }) {
      const thread = yield* resolveThread(input.threadId);
      const providerSessions = yield* providerService
        .listSessions()
        .pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<ProviderSession>>([])));
      const activeProviderSession = providerSessions.find(
        (session) => session.threadId === input.threadId,
      );
      const currentSession = thread?.session ?? null;

      if (
        activeProviderSession?.status === "running" &&
        activeProviderSession.activeTurnId !== undefined &&
        activeProviderSession.activeTurnId !== input.turnId
      ) {
        // Provider state is fresher than the projection during reconnect and
        // late-ACK races. Never let an older send/steer acknowledgement
        // overwrite a different turn the provider already owns, even when the
        // projection has not caught up to that newer runtime turn yet.
        yield* Effect.logWarning(
          "provider command reactor skipped stale sendTurn marker behind provider state",
          {
            threadId: input.threadId,
            providerActiveTurnId: activeProviderSession.activeTurnId,
            sendTurnActiveTurnId: input.turnId,
          },
        );
        return;
      }

      if (
        currentSession?.status === "running" &&
        currentSession.activeTurnId !== null &&
        currentSession.activeTurnId !== input.turnId
      ) {
        yield* Effect.logWarning("provider command reactor skipped stale sendTurn running marker", {
          threadId: input.threadId,
          currentActiveTurnId: currentSession.activeTurnId,
          sendTurnActiveTurnId: input.turnId,
        });
        return;
      }

      const providerName = activeProviderSession?.provider ?? currentSession?.providerName;
      if (providerName === undefined) {
        yield* Effect.logWarning(
          "provider command reactor could not mark sendTurn result running",
          {
            threadId: input.threadId,
            turnId: input.turnId,
            reason: "missing-provider-session",
          },
        );
        return;
      }

      const providerInstanceId =
        activeProviderSession?.providerInstanceId ?? currentSession?.providerInstanceId;
      const runtimeMode =
        activeProviderSession?.runtimeMode ??
        currentSession?.runtimeMode ??
        thread?.runtimeMode ??
        DEFAULT_RUNTIME_MODE;
      // `sendTurn` returns an ACK from the provider boundary. For Codex this
      // can be a provisional turn id, while the later runtime notification is
      // the authoritative provider-owned turn. Stamp this local marker at the
      // original request/recovery time so projection monotonicity prefers the
      // concrete runtime event when it arrives with its provider timestamp.
      const updatedAt = input.createdAt ?? DateTime.formatIso(yield* DateTime.now);

      yield* setThreadSession({
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: "running",
          providerName,
          ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
          runtimeMode,
          activeTurnId: input.turnId,
          lastError: null,
          updatedAt,
        },
        createdAt: updatedAt,
      });
    },
  );

  /**
   * ProviderService may reconcile an apparently idle send through an active
   * Codex steer when provider state is fresher than the projection. Preserve
   * the returned opaque correlation before marking the turn running so that
   * this race has the same durable acceptance evidence as an explicit steer.
   */
  const reconcileAcceptedSendTurnResult = Effect.fn("reconcileAcceptedSendTurnResult")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly intentSequence: number;
      readonly turn: ProviderTurnStartResult;
      readonly intentCreatedAt: string;
    }) {
      if (input.turn.clientCorrelationId !== undefined) {
        const acceptedAt = DateTime.formatIso(yield* DateTime.now);
        const acceptance = yield* recordAcceptedCodexSteer({
          threadId: input.threadId,
          turnId: input.turn.turnId,
          messageId: input.messageId,
          intentSequence: input.intentSequence,
          clientCorrelationId: input.turn.clientCorrelationId,
          intentCreatedAt: input.intentCreatedAt,
          acceptedAt,
        });
        if (!acceptance.mayMarkAcceptedTurnRunning) {
          return false;
        }
      }
      yield* markThreadRunningFromSendTurnResult({
        threadId: input.threadId,
        turnId: input.turn.turnId,
        createdAt: input.intentCreatedAt,
      });
      return true;
    },
  );

  const recoverPostTerminalStaleSteerMessagesOnStartup = Effect.fn(
    "recoverPostTerminalStaleSteerMessagesOnStartup",
  )(function* () {
    // Match Codex CLI/TUI stale-steer recovery without bootstrapping every
    // historical message and work-log row. A terminal Codex thread is not by
    // itself a recovery candidate: mature workspaces can have dozens of those,
    // including multi-gigabyte transcripts. The shell snapshot first proves a
    // newest user message exists after the latest terminal turn; only those
    // exact thread ids may cross the bounded thread-detail boundary below.
    const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const terminalStates = new Set(["completed", "error", "interrupted"]);
    const activeCodexThreads = shellSnapshot.threads.filter(
      (thread) => thread.session?.providerName === "codex",
    );
    const activeCodexThreadIds = activeCodexThreads.map((thread) => thread.id);
    // The shell projection already maintains the timestamp of the newest user
    // message. Use that O(thread-count) fact to admit the legacy repair path;
    // the bounded detail read below remains the exact validator. This avoids a
    // synchronous SQLite history scan for every mature Codex thread at boot.
    const legacyCandidateThreadIds = activeCodexThreads.flatMap((thread) => {
      const latestTurn = thread.latestTurn;
      return latestTurn !== null &&
        latestTurn.completedAt !== null &&
        terminalStates.has(latestTurn.state) &&
        thread.latestUserMessageAt !== null &&
        thread.latestUserMessageAt > latestTurn.completedAt
        ? [thread.id]
        : [];
    });
    const staleSteerCandidates = yield* projectionSnapshotQuery.getPostTerminalStaleSteerCandidates(
      activeCodexThreadIds,
      legacyCandidateThreadIds,
    );
    const staleSteerCandidateThreadIds = new Set(
      staleSteerCandidates.map((candidate) => candidate.threadId),
    );
    if (staleSteerCandidateThreadIds.size === 0) {
      return;
    }
    const recoveredAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    let recoveredCount = 0;

    const candidateThreads = shellSnapshot.threads.filter(
      (thread) =>
        staleSteerCandidateThreadIds.has(thread.id) && thread.session?.providerName === "codex",
    );

    yield* Effect.forEach(
      candidateThreads,
      (threadShell) =>
        Effect.gen(function* () {
          const recoveryLiveness = yield* resolveCodexSteerRecoveryLiveness(threadShell.id);
          if (recoveryLiveness._tag === "unknown") {
            return;
          }
          const providerActiveTurnId =
            recoveryLiveness._tag === "active" ? recoveryLiveness.activeTurnId : null;
          const acceptedCandidates = staleSteerCandidates.flatMap((candidate) =>
            candidate._tag === "accepted" && candidate.threadId === threadShell.id
              ? [candidate]
              : [],
          );
          const projectionEvidence = (yield* Effect.forEach(
            acceptedCandidates,
            (candidate) =>
              projectionSnapshotQuery.getCodexSteerAcceptanceEvidence({
                exactAcceptedBarrier: candidate,
              }),
            // Compact pending acceptances are normally zero or one per
            // thread. Keep the exact primary-key reads serialized so a
            // manually corrupted ledger cannot amplify SQLite contention.
            { concurrency: 1 },
          )).flat();
          if (projectionEvidence.length > 0) {
            const trustedAcceptedSteerRecoveryCommands = buildTerminalCodexSteerRecoveryCommands({
              evidence: projectionEvidence.map(codexSteerAcceptanceEvidenceFromProjection),
              providerActiveTurnId,
              createdAt: recoveredAt,
            });
            yield* Effect.forEach(
              trustedAcceptedSteerRecoveryCommands,
              dispatchStartupRecoveryCommand,
              { concurrency: 1, discard: true },
            );
            recoveredCount += trustedAcceptedSteerRecoveryCommands.filter(
              (command) => command.type === "thread.turn.steer",
            ).length;
            return;
          }

          if (
            !staleSteerCandidates.some(
              (candidate) => candidate._tag === "legacy" && candidate.threadId === threadShell.id,
            )
          ) {
            return;
          }

          // Legacy pre-acceptance repair remains bounded to the latest
          // terminal turn and never runs while provider-owned work is live.
          if (providerActiveTurnId !== null) {
            return;
          }
          const thread = yield* projectionSnapshotQuery
            .getThreadDetailById(threadShell.id)
            .pipe(Effect.map(Option.getOrUndefined));
          if (thread === undefined) {
            return;
          }

          const latestTurn = thread.latestTurn;
          if (
            latestTurn === null ||
            latestTurn.completedAt === null ||
            !terminalStates.has(latestTurn.state) ||
            thread.session?.providerName !== "codex"
          ) {
            return;
          }

          const staleSteerMessage = thread.messages
            .filter(
              (message) =>
                message.role === "user" &&
                message.turnId === latestTurn.turnId &&
                message.createdAt > latestTurn.completedAt!,
            )
            .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
          if (staleSteerMessage === undefined) {
            return;
          }

          const hasStaleSteerRecoveryDiagnostic = thread.activities.some(
            (activity) =>
              activity.kind === "runtime.warning" &&
              activity.summary === "Steer submitted as next turn" &&
              readRecord(activity.payload)?.messageId === staleSteerMessage.id,
          );
          if (!hasStaleSteerRecoveryDiagnostic) {
            return;
          }

          const recoveryKey = [
            "startup-post-terminal-stale-steer",
            thread.id,
            staleSteerMessage.id,
            latestTurn.turnId,
          ].join(":");
          if (yield* hasHandledStaleSteerRecoveryRecently(recoveryKey)) {
            return;
          }

          yield* appendProviderDiagnosticActivity({
            threadId: thread.id,
            kind: "runtime.warning",
            summary: "Stranded steer recovered as next turn",
            detail:
              "Cafe Code found a user steer that was recorded after the previous provider turn had already become terminal. It is submitting that message as the next turn on startup, matching upstream Codex CLI/TUI stale-active-turn recovery.",
            turnId: latestTurn.turnId,
            createdAt: recoveredAt,
            payload: {
              method: "startup/reconcile-stale-steer",
              recovery: "turn-start-after-post-terminal-steer",
              messageId: staleSteerMessage.id,
              staleTurnId: latestTurn.turnId,
              previousTurnState: latestTurn.state,
              previousTurnCompletedAt: latestTurn.completedAt,
            },
          });

          yield* setThreadSession({
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "ready",
              providerName: thread.session?.providerName ?? null,
              ...(thread.session?.providerInstanceId !== undefined
                ? { providerInstanceId: thread.session.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
              activeTurnId: null,
              lastError: null,
              updatedAt: recoveredAt,
            },
            createdAt: recoveredAt,
          });

          yield* dispatchStartupRecoveryCommand({
            type: "thread.turn.start",
            commandId: CommandId.make(
              [
                "server:startup-post-terminal-stale-steer",
                thread.id,
                staleSteerMessage.id,
                latestTurn.turnId,
              ].join(":"),
            ),
            threadId: thread.id,
            message: {
              messageId: staleSteerMessage.id,
              role: "user",
              text: staleSteerMessage.text,
              attachments: staleSteerMessage.attachments ?? [],
            },
            modelSelection: thread.modelSelection,
            runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode,
            createdAt: recoveredAt,
          });
          recoveredCount += 1;
        }).pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: threadShell.id,
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              detail: `Automatic post-terminal steer recovery failed: ${Cause.pretty(cause)}`,
              turnId: threadShell.latestTurn?.turnId ?? null,
              createdAt: recoveredAt,
            }),
          ),
        ),
      { concurrency: 1 },
    );

    if (recoveredCount > 0) {
      yield* Effect.logWarning("provider command reactor recovered post-terminal stale steers", {
        threadCount: recoveredCount,
      });
    }
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly generatedBranch?: string;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const generated =
        input.generatedBranch !== undefined
          ? { branch: input.generatedBranch }
          : yield* Effect.gen(function* () {
              const { textGenerationModelSelection: modelSelection } =
                yield* serverSettingsService.getSettings;
              return yield* textGeneration.generateBranchName({
                cwd,
                message: input.messageText,
                ...(attachments.length > 0 ? { attachments } : {}),
                modelSelection,
              });
            });

      // A slow helper must not rename a branch or worktree the user has changed
      // since submission. This check is independent of title replacement because
      // either metadata field can legitimately change while generation runs.
      const thread = yield* resolveThread(input.threadId);
      if (!thread || thread.branch !== oldBranch || thread.worktreePath !== cwd) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
      readonly generatedTitle?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const generated =
          input.generatedTitle !== undefined
            ? { title: input.generatedTitle }
            : yield* Effect.gen(function* () {
                const { textGenerationModelSelection: modelSelection } =
                  yield* serverSettingsService.getSettings;
                return yield* textGeneration.generateThreadTitle({
                  cwd: input.cwd,
                  message: input.messageText,
                  ...(attachments.length > 0 ? { attachments } : {}),
                  modelSelection,
                });
              });

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      const shouldGenerateBranch =
        thread.branch !== null &&
        thread.worktreePath !== null &&
        isTemporaryWorktreeBranch(thread.branch);
      const shouldGenerateTitle = canReplaceThreadTitle(thread.title, event.payload.titleSeed);
      if (shouldGenerateBranch && shouldGenerateTitle) {
        // Both labels describe this same first message. One bounded structured
        // generation avoids paying twice for its prompt, images, and provider
        // setup context. Applications still catch failures independently, so a
        // Git failure cannot discard a valid title (or the reverse). Never retry
        // a failed combined inference as two new paid requests.
        yield* Effect.gen(function* () {
          const { textGenerationModelSelection: modelSelection } =
            yield* serverSettingsService.getSettings;
          const generated = yield* textGeneration.generateThreadMetadata({
            cwd: generationCwd,
            message: message.text,
            ...(message.attachments?.length ? { attachments: message.attachments } : {}),
            modelSelection,
          });
          yield* Effect.all(
            [
              maybeGenerateAndRenameWorktreeBranchForFirstTurn({
                threadId: event.payload.threadId,
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                ...generationInput,
                generatedBranch: generated.branch,
              }),
              maybeGenerateThreadTitleForFirstTurn({
                threadId: event.payload.threadId,
                cwd: generationCwd,
                ...generationInput,
                generatedTitle: generated.title,
              }),
            ],
            { concurrency: "unbounded" },
          );
        }).pipe(
          Effect.catchCause(() =>
            Effect.logWarning("provider command reactor failed to generate first-turn metadata", {
              threadId: event.payload.threadId,
            }),
          ),
          Effect.forkScoped,
        );
      } else if (shouldGenerateBranch) {
        yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
          threadId: event.payload.threadId,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      } else if (shouldGenerateTitle) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const terminalSteerRecovery = event.payload.terminalSteerRecovery;
    let terminalRecoveryValidation =
      terminalSteerRecovery !== undefined
        ? yield* revalidateTerminalCodexSteerRecovery({
            threadId: event.payload.threadId,
            staleTurnId: terminalSteerRecovery.staleTurnId,
            messageId: event.payload.messageId,
            intentSequence: terminalSteerRecovery.intentSequence,
            createdAt: event.payload.createdAt,
          })
        : undefined;
    if (terminalSteerRecovery !== undefined && terminalRecoveryValidation?.shouldDeliver !== true) {
      return;
    }

    let runtimeActiveSession: ProviderSession | undefined;
    if (terminalSteerRecovery === undefined) {
      runtimeActiveSession = yield* getProviderSessionForThread(event.payload.threadId);
    } else {
      const freshLiveness = yield* resolveCodexSteerRecoveryLiveness(event.payload.threadId);
      if (freshLiveness._tag === "unknown") {
        return;
      }
      if (freshLiveness._tag === "active") {
        // This command was authorized only to continue after one exact
        // terminal turn. Any live owner observed immediately before
        // `sendTurn` is a transaction boundary, not a recovery target.
        yield* queueGuardedTerminalSteerRecovery({
          threadId: event.payload.threadId,
          staleTurnId: terminalSteerRecovery.staleTurnId,
          messageId: event.payload.messageId,
          intentSequence: event.sequence,
          createdAt: event.payload.createdAt,
        });
        return;
      }
      runtimeActiveSession = freshLiveness.localSession;
    }
    const desiredModelSelection = event.payload.modelSelection ?? thread.modelSelection;
    const previousProviderInstanceId =
      runtimeActiveSession?.providerInstanceId ?? thread.session?.providerInstanceId;
    const providerSwitch =
      previousProviderInstanceId !== undefined &&
      previousProviderInstanceId !== desiredModelSelection.instanceId
        ? yield* Effect.gen(function* () {
            const [previousInfo, desiredInfo] = yield* Effect.all([
              providerService.getInstanceInfo(previousProviderInstanceId).pipe(Effect.option),
              providerService.getInstanceInfo(desiredModelSelection.instanceId).pipe(Effect.option),
            ]);
            const previousProvider = Option.isSome(previousInfo)
              ? previousInfo.value.driverKind
              : (runtimeActiveSession?.provider ?? thread.session?.providerName ?? undefined);
            const desiredProvider = Option.isSome(desiredInfo)
              ? desiredInfo.value.driverKind
              : String(desiredModelSelection.instanceId);
            const previousLabel =
              Option.isSome(previousInfo) && previousInfo.value.displayName
                ? previousInfo.value.displayName
                : providerDriverDisplayName(previousProvider);
            const desiredLabel =
              Option.isSome(desiredInfo) && desiredInfo.value.displayName
                ? desiredInfo.value.displayName
                : providerDriverDisplayName(desiredProvider);
            const modelSuffix = desiredModelSelection.model
              ? ` · ${desiredModelSelection.model}`
              : "";
            return {
              summary:
                previousLabel === desiredLabel
                  ? `Switched ${desiredLabel} provider${modelSuffix}`
                  : `Switched from ${previousLabel} to ${desiredLabel}${modelSuffix}`,
              detail: `Cafe Code started this turn with ${desiredLabel}${
                desiredModelSelection.model ? ` using ${desiredModelSelection.model}` : ""
              }.`,
              payload: {
                fromProvider: previousProvider,
                fromProviderInstanceId: previousProviderInstanceId,
                ...(runtimeActiveSession?.model !== undefined
                  ? { fromModel: runtimeActiveSession.model }
                  : {}),
                toProvider: desiredProvider,
                toProviderInstanceId: desiredModelSelection.instanceId,
                ...(desiredModelSelection.model !== undefined
                  ? { toModel: desiredModelSelection.model }
                  : {}),
              },
            };
          })
        : null;
    const appendProviderSwitchActivity = (turnId: TurnId) =>
      providerSwitch === null
        ? Effect.void
        : Effect.gen(function* () {
            const switchedAt = DateTime.formatIso(yield* DateTime.now);
            yield* appendProviderDiagnosticActivity({
              threadId: event.payload.threadId,
              kind: "provider.switched",
              summary: providerSwitch.summary,
              detail: providerSwitch.detail,
              turnId,
              createdAt: switchedAt,
              payload: providerSwitch.payload,
            });
          }).pipe(
            // The provider turn is already accepted at this point. A work-log
            // write failure must not turn that successful send into a second
            // provider submission or a false turn-start error.
            Effect.catchCause((cause) =>
              Effect.logWarning("provider switch activity append failed", {
                threadId: event.payload.threadId,
                fromProviderInstanceId: previousProviderInstanceId,
                toProviderInstanceId: desiredModelSelection.instanceId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
    if (
      runtimeActiveSession?.status === "running" &&
      runtimeActiveSession.activeTurnId !== undefined &&
      runtimeActiveSession.providerInstanceId === desiredModelSelection.instanceId
    ) {
      const activeTurnId = runtimeActiveSession.activeTurnId;
      const normalizedInput = toNonEmptyProviderInput(message.text);
      const normalizedAttachments = message.attachments ?? [];

      if (!normalizedInput && normalizedAttachments.length === 0) {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: "Either input text or at least one attachment is required.",
          turnId: activeTurnId,
          createdAt: event.payload.createdAt,
        });
        return;
      }

      if (runtimeActiveSession.providerInstanceId === undefined) {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: `Active provider session '${runtimeActiveSession.threadId}' is missing a provider instance id.`,
          turnId: activeTurnId,
          createdAt: event.payload.createdAt,
        });
        return;
      }

      const capabilities = yield* providerService
        .getCapabilities(runtimeActiveSession.providerInstanceId)
        .pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            handleTurnStartFailure(cause).pipe(Effect.as(Option.none())),
          ),
        );
      if (Option.isNone(capabilities)) {
        return;
      }

      if (capabilities.value.liveSteer !== "supported") {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.steer.failed",
          summary: "Provider steer queued",
          detail: retryableFollowUpDetail(),
          turnId: activeTurnId,
          createdAt: event.payload.createdAt,
          messageId: event.payload.messageId,
          intentSequence: event.sequence,
          retryableFollowUp: true,
          retryAfter: "active-turn",
        });
        return;
      }

      const recoverNoActiveTurnSteerAsStart = (cause: Cause.Cause<unknown>) =>
        Effect.gen(function* () {
          const observedAt = DateTime.formatIso(yield* DateTime.now);

          yield* appendProviderDiagnosticActivity({
            threadId: event.payload.threadId,
            kind: "runtime.warning",
            summary: "Active steer retried as next turn",
            detail:
              "Codex reported that the runtime active turn had already ended. Cafe Code cleared the active-turn pointer and submitted this message as the next turn, matching upstream Codex CLI/TUI active-turn race handling.",
            turnId: activeTurnId,
            createdAt: observedAt,
            payload: {
              provider: runtimeActiveSession.provider,
              method: "turn/steer",
              recovery: "turn-start-after-no-active-turn",
              messageId: event.payload.messageId,
              staleTurnId: activeTurnId,
            },
          });

          yield* setThreadSession({
            threadId: event.payload.threadId,
            session: {
              threadId: event.payload.threadId,
              status: "ready",
              providerName: runtimeActiveSession.provider,
              providerInstanceId: runtimeActiveSession.providerInstanceId,
              runtimeMode: runtimeActiveSession.runtimeMode ?? thread.runtimeMode,
              activeTurnId: null,
              lastError: null,
              updatedAt: observedAt,
            },
            createdAt: observedAt,
          });

          const sendTurnRequest = yield* buildSendTurnRequestForThread({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            messageText: message.text,
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            interactionMode: event.payload.interactionMode,
            createdAt: observedAt,
            ...(project !== undefined ? { project } : {}),
          });

          yield* providerService.sendTurn(sendTurnRequest).pipe(
            Effect.tap((turn) =>
              reconcileAcceptedSendTurnResult({
                threadId: event.payload.threadId,
                messageId: event.payload.messageId,
                intentSequence: event.sequence,
                turn,
                intentCreatedAt: event.payload.createdAt,
              }),
            ),
          );
        }).pipe(
          Effect.catchCause((recoveryCause) =>
            Effect.logWarning("provider command reactor failed to recover no-active Codex steer", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(recoveryCause),
              originalCause: Cause.pretty(cause),
            }).pipe(Effect.andThen(handleTurnStartFailure(cause))),
          ),
        );

      yield* appendProviderDiagnosticActivity({
        threadId: event.payload.threadId,
        kind: "runtime.warning",
        summary: "Turn start routed to active steer",
        detail:
          "Provider runtime still had an active turn while the projection accepted a new turn start. Cafe Code routed this message through the active turn's steering path instead of starting a second Codex turn, matching upstream Codex CLI/TUI pending-input behavior.",
        turnId: activeTurnId,
        createdAt: event.payload.createdAt,
        payload: {
          provider: runtimeActiveSession.provider,
          providerInstanceId: runtimeActiveSession.providerInstanceId,
          recovery: "turn-start-routed-to-active-steer",
          messageId: event.payload.messageId,
          activeTurnId,
        },
      });

      yield* providerService
        .steerTurn({
          threadId: event.payload.threadId,
          expectedTurnId: activeTurnId,
          messageId: event.payload.messageId,
          ...(normalizedInput ? { input: normalizedInput } : {}),
          ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        })
        .pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => {
              if (isCodexNoActiveTurnToSteerFailure(cause)) {
                return recoverNoActiveTurnSteerAsStart(cause);
              }
              const codexNonSteerableTurnKind = detectCodexNonSteerableTurnKind(cause);
              const unsupportedLiveSteer = isUnsupportedLiveSteerFailure(cause);
              const rejectedGrokInterject = isRejectedGrokInterjectFailure(cause);
              const retryableFollowUp =
                codexNonSteerableTurnKind !== undefined ||
                unsupportedLiveSteer ||
                rejectedGrokInterject;
              if (retryableFollowUp) {
                return appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.turn.steer.failed",
                  summary: "Provider steer queued",
                  detail:
                    codexNonSteerableTurnKind !== undefined
                      ? codexNonSteerableDetail(codexNonSteerableTurnKind)
                      : retryableFollowUpDetail(),
                  turnId: activeTurnId,
                  createdAt: event.payload.createdAt,
                  messageId: event.payload.messageId,
                  intentSequence: event.sequence,
                  retryableFollowUp: true,
                  retryAfter: "active-turn",
                  ...(codexNonSteerableTurnKind !== undefined ? { codexNonSteerableTurnKind } : {}),
                });
              }
              return recoverTurnStartFailure(cause);
            },
            onSuccess: (turn) =>
              Effect.gen(function* () {
                const updatedAt = DateTime.formatIso(yield* DateTime.now);
                const steerAcceptance =
                  runtimeActiveSession.provider === "codex"
                    ? yield* recordAcceptedCodexSteer({
                        threadId: event.payload.threadId,
                        turnId: turn.turnId,
                        messageId: event.payload.messageId,
                        intentSequence: event.sequence,
                        ...(turn.clientCorrelationId !== undefined
                          ? { clientCorrelationId: turn.clientCorrelationId }
                          : {}),
                        intentCreatedAt: event.payload.createdAt,
                        acceptedAt: updatedAt,
                      })
                    : ({ mayMarkAcceptedTurnRunning: true } as const);
                if (!steerAcceptance.mayMarkAcceptedTurnRunning) {
                  return;
                }
                yield* markThreadRunningFromSendTurnResult({
                  threadId: event.payload.threadId,
                  turnId: turn.turnId,
                  createdAt: event.payload.createdAt,
                });
              }),
          }),
          Effect.forkScoped,
        );
      return;
    }

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      ...(terminalSteerRecovery !== undefined ? { allowActiveTurnSteerFallback: false } : {}),
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
      thread,
      ...(project !== undefined ? { project } : {}),
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    const recoverActiveCodexStartAsSteer = (activeTurnId: TurnId, cause: Cause.Cause<unknown>) => {
      if (event.payload.terminalSteerRecovery !== undefined) {
        return queueGuardedTerminalSteerRecovery({
          threadId: event.payload.threadId,
          staleTurnId: event.payload.terminalSteerRecovery.staleTurnId,
          messageId: event.payload.messageId,
          intentSequence: event.sequence,
          createdAt: event.payload.createdAt,
        }).pipe(Effect.asVoid);
      }
      const normalizedInput = toNonEmptyProviderInput(message.text);
      const normalizedAttachments = message.attachments ?? [];
      if (!normalizedInput && normalizedAttachments.length === 0) {
        return recoverTurnStartFailure(cause);
      }

      return providerService
        .steerTurn({
          threadId: event.payload.threadId,
          expectedTurnId: activeTurnId,
          messageId: event.payload.messageId,
          ...(normalizedInput ? { input: normalizedInput } : {}),
          ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        })
        .pipe(
          Effect.matchCauseEffect({
            onFailure: (steerCause) => {
              if (isCodexNoActiveTurnToSteerFailure(steerCause)) {
                return recoverTurnStartFailure(cause);
              }
              const codexNonSteerableTurnKind = detectCodexNonSteerableTurnKind(steerCause);
              const unsupportedLiveSteer = isUnsupportedLiveSteerFailure(steerCause);
              const rejectedGrokInterject = isRejectedGrokInterjectFailure(steerCause);
              const retryableFollowUp =
                codexNonSteerableTurnKind !== undefined ||
                unsupportedLiveSteer ||
                rejectedGrokInterject;
              if (retryableFollowUp) {
                return appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.turn.steer.failed",
                  summary: "Provider steer queued",
                  detail:
                    codexNonSteerableTurnKind !== undefined
                      ? codexNonSteerableDetail(codexNonSteerableTurnKind)
                      : retryableFollowUpDetail(),
                  turnId: activeTurnId,
                  createdAt: event.payload.createdAt,
                  messageId: event.payload.messageId,
                  intentSequence: event.sequence,
                  retryableFollowUp: true,
                  retryAfter: "active-turn",
                  ...(codexNonSteerableTurnKind !== undefined ? { codexNonSteerableTurnKind } : {}),
                }).pipe(Effect.asVoid);
              }
              return recoverTurnStartFailure(steerCause);
            },
            onSuccess: (turn) =>
              Effect.gen(function* () {
                const observedAt = DateTime.formatIso(yield* DateTime.now);
                const steerAcceptance = yield* recordAcceptedCodexSteer({
                  threadId: event.payload.threadId,
                  turnId: turn.turnId,
                  messageId: event.payload.messageId,
                  intentSequence: event.sequence,
                  ...(turn.clientCorrelationId !== undefined
                    ? { clientCorrelationId: turn.clientCorrelationId }
                    : {}),
                  intentCreatedAt: event.payload.createdAt,
                  acceptedAt: observedAt,
                });
                if (steerAcceptance.mayMarkAcceptedTurnRunning) {
                  yield* markThreadRunningFromSendTurnResult({
                    threadId: event.payload.threadId,
                    turnId: turn.turnId,
                    createdAt: event.payload.createdAt,
                  });
                }

                yield* appendProviderDiagnosticActivity({
                  threadId: event.payload.threadId,
                  kind: "runtime.warning",
                  summary: "Turn start retried as active steer",
                  detail:
                    "Codex rejected a new turn because the provider daemon still had an active turn. Cafe Code retried the same message through the active turn's steering path, matching upstream Codex CLI/TUI pending-input behavior.",
                  turnId: turn.turnId,
                  createdAt: observedAt,
                  payload: {
                    provider: "codex",
                    method: "turn/start",
                    recovery: "turn-start-validation-routed-to-active-steer",
                    messageId: event.payload.messageId,
                    activeTurnId,
                  },
                }).pipe(
                  Effect.catchCause((diagnosticCause) =>
                    Effect.logWarning(
                      "provider command reactor could not append active-steer recovery",
                      {
                        threadId: event.payload.threadId,
                        activeTurnId,
                        cause: Cause.pretty(diagnosticCause),
                      },
                    ),
                  ),
                );
              }),
          }),
        );
    };

    if (terminalSteerRecovery !== undefined) {
      // Session preparation can take long enough for a newer turn to appear.
      // Revalidate at the final provider-I/O boundary, then commit the stable
      // ambiguity marker before the guarded turn/start call.
      terminalRecoveryValidation = yield* revalidateTerminalCodexSteerRecovery({
        threadId: event.payload.threadId,
        staleTurnId: terminalSteerRecovery.staleTurnId,
        messageId: event.payload.messageId,
        intentSequence: terminalSteerRecovery.intentSequence,
        createdAt: event.payload.createdAt,
      });
      if (terminalRecoveryValidation.shouldDeliver !== true) {
        return;
      }
      const finalLiveness = yield* resolveCodexSteerRecoveryLiveness(event.payload.threadId);
      if (finalLiveness._tag === "unknown") {
        return;
      }
      if (finalLiveness._tag === "active") {
        return yield* queueGuardedTerminalSteerRecovery({
          threadId: event.payload.threadId,
          staleTurnId: terminalSteerRecovery.staleTurnId,
          messageId: event.payload.messageId,
          intentSequence: event.sequence,
          createdAt: event.payload.createdAt,
        });
      }
      yield* orchestrationEngine
        .dispatch(
          buildCodexSteerDeliveryAttemptedActivityCommand({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            intentSequence: event.sequence,
            delivery: "next-turn",
            reason: "turn-start-after-terminal-unprocessed-steer",
            staleTurnId: terminalSteerRecovery.staleTurnId,
            createdAt: event.payload.createdAt,
          }),
        )
        .pipe(Effect.retry({ times: 2 }));

      // A Stop or newer-turn intent can commit while SQLite persists the
      // outbox marker. Fence the provider side effect with one final durable
      // re-read; anything observed here is newer than this delivery attempt
      // and therefore wins without risking a silently redirected prompt.
      terminalRecoveryValidation = yield* revalidateTerminalCodexSteerRecovery({
        threadId: event.payload.threadId,
        staleTurnId: terminalSteerRecovery.staleTurnId,
        messageId: event.payload.messageId,
        intentSequence: terminalSteerRecovery.intentSequence,
        createdAt: event.payload.createdAt,
      });
      if (terminalRecoveryValidation.shouldDeliver !== true) {
        return;
      }
      const postAttemptLiveness = yield* resolveCodexSteerRecoveryLiveness(event.payload.threadId);
      if (postAttemptLiveness._tag !== "inactive") {
        if (postAttemptLiveness._tag === "active") {
          return yield* queueGuardedTerminalSteerRecovery({
            threadId: event.payload.threadId,
            staleTurnId: terminalSteerRecovery.staleTurnId,
            messageId: event.payload.messageId,
            intentSequence: event.sequence,
            createdAt: event.payload.createdAt,
          });
        }
        return;
      }
    }

    yield* providerService.sendTurn(sendTurnRequest.value).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) => {
          const activeTurnId = detectCodexActiveTurnRunningStartFailure(cause);
          if (activeTurnId !== undefined) {
            return recoverActiveCodexStartAsSteer(activeTurnId, cause);
          }
          if (terminalSteerRecovery !== undefined) {
            return orchestrationEngine
              .dispatch(
                buildCodexSteerNextTurnQueuedCommand({
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  intentSequence: event.sequence,
                  staleTurnId: terminalSteerRecovery.staleTurnId,
                  reason: "turn-start-after-terminal-unprocessed-steer",
                  createdAt: event.payload.createdAt,
                }),
              )
              .pipe(Effect.retry({ times: 2 }));
          }
          return recoverTurnStartFailure(cause);
        },
        onSuccess: (turn) =>
          Effect.gen(function* () {
            const deliveredAt = DateTime.formatIso(yield* DateTime.now);
            const mayContinue = yield* reconcileAcceptedSendTurnResult({
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
              intentSequence: event.sequence,
              turn,
              intentCreatedAt: event.payload.createdAt,
            });
            if (!mayContinue) {
              return;
            }
            if (
              terminalRecoveryValidation?.shouldDeliver === true &&
              terminalRecoveryValidation.evidence !== undefined
            ) {
              yield* recordTerminalCodexSteerRecoveryDelivered({
                evidence: terminalRecoveryValidation.evidence,
                recoveredTurnId: turn.turnId,
                createdAt: deliveredAt,
              });
            }
            yield* appendProviderSwitchActivity(turn.turnId);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(
                "provider command reactor could not persist accepted turn bookkeeping",
                {
                  threadId: event.payload.threadId,
                  turnId: turn.turnId,
                  terminalRecovery: terminalSteerRecovery !== undefined,
                  outcome: Cause.hasInterruptsOnly(cause) ? "interrupted" : "failed",
                },
              ),
            ),
          ),
      }),
      Effect.forkScoped,
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const runtimeSession = yield* getProviderSessionForThread(event.payload.threadId);
    const hasSession =
      (thread.session && thread.session.status !== "stopped") ||
      (runtimeSession !== undefined && runtimeSession.status !== "closed");
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Cafe persists the provider runtime turn id on the thread session once the
    // provider accepts a turn. Keep passing it through the interrupt boundary:
    // upstream Codex requires `turn/interrupt` to name the exact active turn id
    // and rejects session-only interrupts.
    const projectedTurnId = event.payload.turnId ?? thread.session?.activeTurnId ?? undefined;
    const runtimeActiveTurnId =
      runtimeSession?.status === "running" ? runtimeSession.activeTurnId : undefined;
    const activeTurnId = runtimeActiveTurnId ?? projectedTurnId;
    if (
      runtimeActiveTurnId !== undefined &&
      projectedTurnId !== undefined &&
      runtimeActiveTurnId !== projectedTurnId
    ) {
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      yield* appendProviderDiagnosticActivity({
        threadId: event.payload.threadId,
        kind: "runtime.warning",
        summary: "Interrupt retargeted to provider active turn",
        detail:
          "Provider runtime reported a different active turn than the projection. Cafe Code used the provider-runtime turn id for the interrupt so Codex app-server receives the same target the upstream CLI/TUI would interrupt.",
        turnId: runtimeActiveTurnId,
        createdAt: observedAt,
        payload: {
          provider: runtimeSession?.provider,
          projectedTurnId,
          runtimeActiveTurnId,
          requestedAt: event.payload.createdAt,
        },
      });
    }

    const pauseAndSynchronizeProviderGoal = Effect.gen(function* () {
      const instanceId =
        runtimeSession?.providerInstanceId ??
        thread.session?.providerInstanceId ??
        thread.modelSelection.instanceId;
      const capabilities = yield* providerService.getCapabilities(instanceId);
      if (
        capabilities.threadGoals !== "supported" ||
        providerService.getGoal === undefined ||
        providerService.setGoal === undefined
      ) {
        return;
      }

      // Goal-capable providers pause an active goal when the user interrupts.
      // A provider's final accounting notification can race the pause event and
      // leave Cafe's durable projection showing the older active state. Read
      // the authoritative goal after the interrupt, retry the pause once when
      // necessary, and bind the result back to the Cafe thread aggregate.
      const observedGoal = yield* providerService.getGoal({
        threadId: event.payload.threadId,
      });
      const synchronizedGoal =
        observedGoal?.status === "active"
          ? yield* providerService.setGoal({
              threadId: event.payload.threadId,
              status: "paused",
            })
          : observedGoal;
      const synchronizedAt = synchronizedGoal?.updatedAt ?? DateTime.formatIso(yield* DateTime.now);
      yield* orchestrationEngine.dispatch({
        type: "thread.goal.sync",
        commandId: CommandId.make(`provider-goal-interrupt-sync:${crypto.randomUUID()}`),
        threadId: event.payload.threadId,
        goal: synchronizedGoal,
        createdAt: synchronizedAt,
      });
    }).pipe(
      // Goal reconciliation must never turn an already-successful Stop into a
      // failed interrupt. Keep the terminal interruption barrier in force,
      // report only metadata in the work log, and retry from provider state on
      // the next session materialization.
      Effect.timeout("5 seconds"),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const observedAt = DateTime.formatIso(yield* DateTime.now);
          yield* Effect.logWarning("provider goal pause synchronization after interrupt failed", {
            threadId: event.payload.threadId,
            providerInstanceId:
              runtimeSession?.providerInstanceId ?? thread.session?.providerInstanceId ?? null,
            cause: Cause.pretty(cause),
          });
          yield* appendProviderDiagnosticActivity({
            threadId: event.payload.threadId,
            kind: "runtime.warning",
            summary: "Goal pause synchronization deferred",
            detail:
              "Codex accepted the turn interrupt, but Cafe Code could not immediately confirm the provider goal pause. The interrupted lifecycle barrier remains active, and provider goal state will be synchronized again when the session materializes.",
            turnId: activeTurnId ?? null,
            createdAt: observedAt,
            payload: {
              operation: "pause-goal-after-user-interrupt",
              retryOnSessionMaterialization: true,
            },
          });
        }),
      ),
    );

    yield* providerService
      .interruptTurn({
        threadId: event.payload.threadId,
        ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
      })
      .pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const interruptedAt = DateTime.formatIso(yield* DateTime.now);
            yield* pauseAndSynchronizeProviderGoal;
            yield* appendProviderDiagnosticActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.interrupt.completed",
              summary: "Provider turn interrupt completed",
              detail:
                "Provider accepted the active turn interrupt. Cafe Code retained any uncommitted input without starting another turn; only an explicit send or interrupt-and-send action may release it.",
              turnId: activeTurnId ?? null,
              createdAt: interruptedAt,
              payload: {
                requestedAt: event.payload.createdAt,
              },
            });
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const failedAt = DateTime.formatIso(yield* DateTime.now);
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt failed",
              detail: formatFailureDetail(cause),
              turnId: activeTurnId ?? null,
              createdAt: failedAt,
            });
          }),
        ),
      );
  });

  const processTurnSteerRequested = Effect.fn("processTurnSteerRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-steer-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);
    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: `User message '${event.payload.messageId}' was not found for steer request.`,
        turnId: thread.session?.activeTurnId ?? null,
        createdAt: event.payload.createdAt,
        messageId: event.payload.messageId,
        intentSequence: event.sequence,
      });
    }
    const normalizedInput = toNonEmptyProviderInput(message.text);
    const normalizedAttachments = message.attachments ?? [];
    if (!normalizedInput && normalizedAttachments.length === 0) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: "Either input text or at least one attachment is required.",
        turnId: thread.session?.activeTurnId ?? null,
        createdAt: event.payload.createdAt,
        messageId: event.payload.messageId,
        intentSequence: event.sequence,
      });
    }

    const expectedTurnId = event.payload.expectedTurnId;
    const isCodexSteerIntent =
      event.payload.terminalSteerRecovery !== undefined ||
      thread.session?.providerName === "codex" ||
      String(thread.modelSelection.instanceId).startsWith("codex");

    /**
     * Re-read the exact event tuple and cancellation barriers immediately
     * before recovery I/O. `undefined` means the message was durably queued;
     * callers must not substitute whatever provider turn is current now.
     */
    const revalidateSteerIntentForProviderIo = Effect.fnUntraced(function* (input?: {
      readonly requireInactiveTurn?: boolean;
    }) {
      const barriers = yield* projectionSnapshotQuery.getCodexSteerIntentRecoveryBarriers({
        sequence: event.sequence,
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        expectedTurnId,
      });
      const queue = (reason: Parameters<typeof queueCodexSteerIntentRecovery>[0]["reason"]) =>
        queueCodexSteerIntentRecovery({
          threadId: event.payload.threadId,
          expectedTurnId,
          messageId: event.payload.messageId,
          intentSequence: event.sequence,
          createdAt: event.payload.createdAt,
          reason,
        }).pipe(Effect.as(undefined));

      if (!barriers.intentVerified) {
        return yield* queue("intent-tuple-unverified");
      }
      if (expectedTurnId === null) {
        return yield* queue("unbound-expected-turn");
      }
      if (barriers.sessionStopRequested) {
        return yield* queue("session-stop-requested");
      }
      if (barriers.interruptRequested) {
        return yield* queue("turn-interrupt-requested");
      }
      if (barriers.newerTurnRequested) {
        return yield* queue("newer-turn-requested");
      }

      const currentThread = yield* resolveThread(event.payload.threadId);
      if (currentThread === undefined) {
        return yield* queue("intent-tuple-unverified");
      }
      const projectedNewerTurnId = [
        currentThread.session?.activeTurnId ?? null,
        currentThread.latestTurn?.turnId ?? null,
      ].find((turnId): turnId is TurnId => turnId !== null && turnId !== expectedTurnId);
      if (projectedNewerTurnId !== undefined) {
        return yield* queue("newer-turn-active");
      }

      if (!isCodexSteerIntent) {
        return { currentThread, recoveryLiveness: undefined } as const;
      }
      const recoveryLiveness = yield* resolveCodexSteerRecoveryLiveness(event.payload.threadId);
      if (recoveryLiveness._tag === "unknown") {
        return yield* queue("provider-liveness-unknown");
      }
      if (
        recoveryLiveness._tag === "active" &&
        (recoveryLiveness.activeTurnId !== expectedTurnId || input?.requireInactiveTurn === true)
      ) {
        return yield* queue("newer-turn-active");
      }
      return { currentThread, recoveryLiveness } as const;
    });

    const initialIntentValidation = yield* revalidateSteerIntentForProviderIo();
    if (initialIntentValidation === undefined || expectedTurnId === null) {
      return;
    }

    /**
     * Complete a persisted steer through an ordinary turn start without
     * leaving startup recovery ambiguous. A successful Codex turn/start gets
     * a post-I/O, server-authored delivery receipt after the accepted turn is
     * materialized; the pre-I/O attempt marker protects that narrow ordering
     * gap. If ProviderService discovers a newly active Codex turn and routes
     * through steer instead, its opaque correlation produces the existing
     * accepted-steer receipt instead of a false next-turn receipt.
     */
    const deliverPersistedSteerAsNextTurn = Effect.fn("deliverPersistedSteerAsNextTurn")(
      function* (input: {
        readonly request: ProviderSendTurnInput;
        readonly staleTurnId: TurnId | null;
        readonly reason: CodexSteerNextTurnReason;
        readonly providerHint?: string;
        readonly createdAt: string;
      }) {
        const validation = yield* revalidateSteerIntentForProviderIo({
          requireInactiveTurn: true,
        });
        if (validation === undefined) {
          return;
        }
        const preparedSession =
          validation.recoveryLiveness?.localSession ??
          (!isCodexSteerIntent
            ? yield* getProviderSessionForThread(event.payload.threadId)
            : undefined);
        const providerName =
          preparedSession?.provider ?? input.providerHint ?? thread.session?.providerName;
        const isCodex = providerName === "codex";

        if (isCodex) {
          // This content-free outbox marker closes the provider-success / SQLite-
          // receipt crash window. Startup recovery treats an unresolved attempt
          // as ambiguous and keeps it queued rather than risking a duplicate
          // delivery of the same immutable message id.
          yield* orchestrationEngine
            .dispatch(
              buildCodexSteerDeliveryAttemptedActivityCommand({
                threadId: event.payload.threadId,
                messageId: event.payload.messageId,
                intentSequence: event.sequence,
                delivery: "next-turn",
                reason: input.reason,
                staleTurnId: input.staleTurnId,
                createdAt: input.createdAt,
              }),
            )
            .pipe(Effect.retry({ times: 2 }));

          // The marker write is intentionally not treated as a lock. Re-read
          // Stop/newer-turn barriers after it commits and before provider I/O.
          if (
            (yield* revalidateSteerIntentForProviderIo({ requireInactiveTurn: true })) === undefined
          ) {
            return;
          }
        }

        yield* providerService.sendTurn(input.request).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) =>
              isCodex
                ? orchestrationEngine
                    .dispatch(
                      buildCodexSteerNextTurnQueuedCommand({
                        threadId: event.payload.threadId,
                        messageId: event.payload.messageId,
                        intentSequence: event.sequence,
                        staleTurnId: input.staleTurnId,
                        reason: input.reason,
                        createdAt: input.createdAt,
                      }),
                    )
                    .pipe(Effect.retry({ times: 2 }))
                : appendProviderFailureActivity({
                    threadId: event.payload.threadId,
                    kind: "provider.turn.steer.failed",
                    summary: "Provider steer queued",
                    detail: `Automatic steer delivery failed: ${formatFailureDetail(cause)}`,
                    turnId: input.staleTurnId,
                    createdAt: input.createdAt,
                    messageId: event.payload.messageId,
                    intentSequence: event.sequence,
                    retryableFollowUp: true,
                  }),
            onSuccess: (turn) =>
              Effect.gen(function* () {
                // Materialize the provider-accepted turn before attaching the
                // receipt to it. The pre-I/O attempt marker already closes the
                // crash window, so this ordering avoids an invalid activity
                // reference without permitting startup redelivery.
                yield* reconcileAcceptedSendTurnResult({
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  intentSequence: event.sequence,
                  turn,
                  intentCreatedAt: event.payload.createdAt,
                });
                if (isCodex && turn.clientCorrelationId === undefined) {
                  // This activity is the durable commit point for the external
                  // provider side effect. Retry the stable command locally so a
                  // transient SQLite contention does not reopen the intent on
                  // the next backend start.
                  yield* orchestrationEngine
                    .dispatch(
                      buildCodexSteerDeliveredActivityCommand({
                        threadId: event.payload.threadId,
                        messageId: event.payload.messageId,
                        intentSequence: event.sequence,
                        deliveredTurnId: turn.turnId,
                        reason: input.reason,
                        createdAt: input.createdAt,
                      }),
                    )
                    .pipe(Effect.retry({ times: 2 }));
                }
              }),
          }),
        );
      },
    );

    const retrySteerAsNextTurn = (input: {
      readonly summary: string;
      readonly detail: string;
      readonly staleTurnId: TurnId | null;
      readonly recovery: CodexSteerNextTurnReason;
      readonly provider?: string | undefined;
      readonly providerInstanceId?: OrchestrationSession["providerInstanceId"] | undefined;
      readonly runtimeMode?: RuntimeMode | undefined;
    }) =>
      Effect.gen(function* () {
        if (
          (yield* revalidateSteerIntentForProviderIo({ requireInactiveTurn: true })) === undefined
        ) {
          return;
        }
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        const recoveryKey = [
          "stale-steer",
          event.payload.threadId,
          event.payload.messageId,
          input.recovery,
        ].join(":");
        if (yield* hasHandledStaleSteerRecoveryRecently(recoveryKey)) {
          return;
        }
        const recoveredProviderInstanceId =
          input.providerInstanceId ?? thread.session?.providerInstanceId;

        // `thread.turn-steer-requested` can be emitted while the projection
        // still believes a Codex turn is running, then restart/reconciliation
        // can clear that active turn before this reactor handles the command.
        // Upstream Codex TUI treats that as local active-turn reconciliation:
        // the typed input is still accepted and falls through to `turn/start`.
        // Keep that recovery here so a race between the renderer, projection,
        // and provider runtime never becomes a user-visible failed send.
        yield* appendProviderDiagnosticActivity({
          threadId: event.payload.threadId,
          kind: "runtime.warning",
          summary: input.summary,
          detail: input.detail,
          turnId: input.staleTurnId,
          createdAt: observedAt,
          payload: {
            ...(input.provider !== undefined ? { provider: input.provider } : {}),
            ...(input.providerInstanceId !== undefined
              ? { providerInstanceId: input.providerInstanceId }
              : {}),
            method: "turn/steer",
            recovery: input.recovery,
            messageId: event.payload.messageId,
            ...(input.staleTurnId !== null ? { staleTurnId: input.staleTurnId } : {}),
          },
        });

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            threadId: event.payload.threadId,
            status: "ready",
            providerName: input.provider ?? thread.session?.providerName ?? null,
            ...(recoveredProviderInstanceId !== undefined
              ? { providerInstanceId: recoveredProviderInstanceId }
              : {}),
            runtimeMode: input.runtimeMode ?? thread.session?.runtimeMode ?? thread.runtimeMode,
            activeTurnId: null,
            lastError: null,
            updatedAt: observedAt,
          },
          createdAt: observedAt,
        });

        const sendTurnRequest = yield* buildSendTurnRequestForThread({
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          messageText: message.text,
          attachments: normalizedAttachments,
          ...(thread.modelSelection !== undefined ? { modelSelection: thread.modelSelection } : {}),
          interactionMode: thread.interactionMode,
          createdAt: observedAt,
          thread,
          ...(project !== undefined ? { project } : {}),
        });

        yield* deliverPersistedSteerAsNextTurn({
          request: sendTurnRequest,
          staleTurnId: input.staleTurnId,
          reason: input.recovery,
          ...(input.provider !== undefined ? { providerHint: input.provider } : {}),
          createdAt: observedAt,
        });
      }).pipe(
        Effect.catchCause((recoveryCause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.steer.failed",
            summary: "Provider steer queued",
            detail: `Automatic steer recovery failed: ${Cause.pretty(recoveryCause)}`,
            turnId: input.staleTurnId,
            createdAt: event.payload.createdAt,
            messageId: event.payload.messageId,
            intentSequence: event.sequence,
            retryableFollowUp: true,
          }),
        ),
      );

    const terminalSteerRecovery = event.payload.terminalSteerRecovery;
    const terminalRecoveryValidation =
      terminalSteerRecovery !== undefined
        ? yield* revalidateTerminalCodexSteerRecovery({
            threadId: event.payload.threadId,
            staleTurnId: terminalSteerRecovery.staleTurnId,
            messageId: event.payload.messageId,
            intentSequence: terminalSteerRecovery.intentSequence,
            createdAt: event.payload.createdAt,
          })
        : undefined;
    if (terminalSteerRecovery !== undefined && terminalRecoveryValidation?.shouldDeliver !== true) {
      return;
    }

    let runtimeActiveSession: ProviderSession | undefined;
    const projectedSession = thread.session;
    if (terminalSteerRecovery !== undefined) {
      const freshIntentValidation = yield* revalidateSteerIntentForProviderIo({
        requireInactiveTurn: true,
      });
      if (freshIntentValidation === undefined) {
        return;
      }
      runtimeActiveSession = freshIntentValidation.recoveryLiveness?.localSession;
      const projectionHasActiveTurn =
        freshIntentValidation.currentThread.session?.status === "running" &&
        freshIntentValidation.currentThread.session.activeTurnId !== null;
      if (projectionHasActiveTurn) {
        return yield* queueGuardedTerminalSteerRecovery({
          threadId: event.payload.threadId,
          staleTurnId: terminalSteerRecovery.staleTurnId,
          messageId: event.payload.messageId,
          intentSequence: event.sequence,
          createdAt: event.payload.createdAt,
        });
      }
      return yield* Effect.gen(function* () {
        const sendTurnRequest = yield* buildSendTurnRequestForThread({
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          allowActiveTurnSteerFallback: false,
          messageText: message.text,
          attachments: normalizedAttachments,
          ...(thread.modelSelection !== undefined ? { modelSelection: thread.modelSelection } : {}),
          interactionMode: thread.interactionMode,
          createdAt: event.payload.createdAt,
          thread,
          ...(project !== undefined ? { project } : {}),
        });
        yield* orchestrationEngine
          .dispatch(
            buildCodexSteerDeliveryAttemptedActivityCommand({
              threadId: event.payload.threadId,
              messageId: event.payload.messageId,
              intentSequence: event.sequence,
              delivery: "next-turn",
              reason: "turn-start-after-terminal-unprocessed-steer",
              staleTurnId: terminalSteerRecovery.staleTurnId,
              createdAt: event.payload.createdAt,
            }),
          )
          .pipe(Effect.retry({ times: 2 }));

        // Close the read/marker race before the terminal recovery provider
        // call. A Stop committed while the marker was being written must win.
        const postAttemptValidation = yield* revalidateSteerIntentForProviderIo({
          requireInactiveTurn: true,
        });
        if (postAttemptValidation === undefined) {
          return;
        }
        yield* providerService.sendTurn(sendTurnRequest).pipe(
          Effect.matchCauseEffect({
            onFailure: (cause) => {
              const newerTurnId = detectCodexActiveTurnRunningStartFailure(cause);
              if (newerTurnId !== undefined) {
                return queueGuardedTerminalSteerRecovery({
                  threadId: event.payload.threadId,
                  staleTurnId: terminalSteerRecovery.staleTurnId,
                  messageId: event.payload.messageId,
                  intentSequence: event.sequence,
                  createdAt: event.payload.createdAt,
                });
              }
              return orchestrationEngine
                .dispatch(
                  buildCodexSteerNextTurnQueuedCommand({
                    threadId: event.payload.threadId,
                    messageId: event.payload.messageId,
                    intentSequence: event.sequence,
                    staleTurnId: terminalSteerRecovery.staleTurnId,
                    reason: "turn-start-after-terminal-unprocessed-steer",
                    createdAt: event.payload.createdAt,
                  }),
                )
                .pipe(Effect.retry({ times: 2 }));
            },
            onSuccess: (turn) =>
              Effect.gen(function* () {
                const deliveredAt = DateTime.formatIso(yield* DateTime.now);
                yield* markThreadRunningFromSendTurnResult({
                  threadId: event.payload.threadId,
                  turnId: turn.turnId,
                  createdAt: event.payload.createdAt,
                });
                if (terminalRecoveryValidation?.evidence !== undefined) {
                  yield* recordTerminalCodexSteerRecoveryDelivered({
                    evidence: terminalRecoveryValidation.evidence,
                    recoveredTurnId: turn.turnId,
                    createdAt: deliveredAt,
                  });
                }
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(
                    "provider command reactor could not persist terminal steer recovery",
                    {
                      threadId: event.payload.threadId,
                      recoveredTurnId: turn.turnId,
                      outcome: Cause.hasInterruptsOnly(cause) ? "interrupted" : "failed",
                    },
                  ),
                ),
              ),
          }),
        );
      });
    }
    runtimeActiveSession =
      initialIntentValidation.recoveryLiveness?.localSession ??
      (isCodexSteerIntent ? undefined : yield* getProviderSessionForThread(event.payload.threadId));
    const activeSession =
      initialIntentValidation.recoveryLiveness?._tag === "active"
        ? ({
            threadId: event.payload.threadId,
            status: "running" as const,
            providerName:
              initialIntentValidation.recoveryLiveness.localSession?.provider ??
              initialIntentValidation.recoveryLiveness.durableBinding?.provider ??
              projectedSession?.providerName ??
              null,
            ...((initialIntentValidation.recoveryLiveness.localSession?.providerInstanceId ??
            initialIntentValidation.recoveryLiveness.durableBinding?.providerInstanceId ??
            projectedSession?.providerInstanceId)
              ? {
                  providerInstanceId:
                    initialIntentValidation.recoveryLiveness.localSession?.providerInstanceId ??
                    initialIntentValidation.recoveryLiveness.durableBinding?.providerInstanceId ??
                    projectedSession?.providerInstanceId,
                }
              : {}),
            runtimeMode:
              initialIntentValidation.recoveryLiveness.localSession?.runtimeMode ??
              initialIntentValidation.recoveryLiveness.durableBinding?.runtimeMode ??
              projectedSession?.runtimeMode ??
              thread.runtimeMode,
            activeTurnId: initialIntentValidation.recoveryLiveness.activeTurnId,
            lastError: null,
            updatedAt: event.payload.createdAt,
          } satisfies OrchestrationSession)
        : runtimeActiveSession?.status === "running" &&
            runtimeActiveSession.activeTurnId !== undefined
          ? ({
              threadId: event.payload.threadId,
              status: "running" as const,
              providerName: runtimeActiveSession.provider,
              providerInstanceId: runtimeActiveSession.providerInstanceId,
              runtimeMode: runtimeActiveSession.runtimeMode ?? thread.runtimeMode,
              activeTurnId: runtimeActiveSession.activeTurnId,
              lastError: null,
              updatedAt: event.payload.createdAt,
            } satisfies OrchestrationSession)
          : projectedSession?.status === "running"
            ? projectedSession
            : undefined;

    if (activeSession === undefined) {
      return yield* retrySteerAsNextTurn({
        summary: "Steer submitted as next turn",
        detail:
          "No active provider turn remained by the time Cafe Code processed this steer. Cafe Code submitted the same message as the next turn, matching upstream Codex CLI/TUI active-turn reconciliation.",
        staleTurnId: projectedSession?.activeTurnId ?? null,
        recovery: "turn-start-after-no-local-active-turn",
        provider: projectedSession?.providerName ?? undefined,
        providerInstanceId: projectedSession?.providerInstanceId ?? undefined,
        runtimeMode: projectedSession?.runtimeMode ?? undefined,
      });
    }

    if (!activeSession.activeTurnId) {
      return yield* retrySteerAsNextTurn({
        summary: "Steer submitted as next turn",
        detail:
          "The active provider session no longer had an active turn id. Cafe Code submitted the same message as the next turn, matching upstream Codex CLI/TUI active-turn reconciliation.",
        staleTurnId: null,
        recovery: "turn-start-after-missing-active-turn-id",
        provider: activeSession.providerName ?? undefined,
        providerInstanceId: activeSession.providerInstanceId ?? undefined,
        runtimeMode: activeSession.runtimeMode,
      });
    }
    const providerInstanceId = activeSession.providerInstanceId;
    if (providerInstanceId === undefined) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: "The active provider session is missing a provider instance id.",
        turnId: activeSession.activeTurnId,
        createdAt: event.payload.createdAt,
        messageId: event.payload.messageId,
        intentSequence: event.sequence,
      });
    }
    const capabilities = yield* providerService.getCapabilities(providerInstanceId);
    if (capabilities.liveSteer !== "supported") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: retryableFollowUpDetail(),
        turnId: activeSession.activeTurnId,
        createdAt: event.payload.createdAt,
        messageId: event.payload.messageId,
        intentSequence: event.sequence,
        retryableFollowUp: true,
        retryAfter: "active-turn",
      });
    }

    const recoverStaleCodexSteerAsTurnStart = (_cause: Cause.Cause<ProviderServiceError>) =>
      Effect.gen(function* () {
        if (
          (yield* revalidateSteerIntentForProviderIo({ requireInactiveTurn: true })) === undefined
        ) {
          return;
        }
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        const staleTurnId = activeSession.activeTurnId;
        const recoveryKey = [
          "codex-no-active-turn",
          event.payload.threadId,
          event.payload.messageId,
          staleTurnId,
        ].join(":");
        if (yield* hasHandledStaleSteerRecoveryRecently(recoveryKey)) {
          return;
        }

        // Upstream Codex TUI handles this exact app-server race in
        // `active_turn_steer_race`: if `turn/steer` says there is no active
        // turn, it clears the cached active turn and immediately falls through
        // to `turn/start` with the same user input. Cafe must do the same at the
        // server boundary so the renderer never has to surface a recoverable
        // provider race as a failed send.
        yield* appendProviderDiagnosticActivity({
          threadId: event.payload.threadId,
          kind: "runtime.warning",
          summary: "Steer retried as next turn",
          detail:
            "Codex reported that the cached active turn had already ended. Cafe Code cleared the stale active-turn pointer and submitted this message as the next turn, matching upstream Codex CLI/TUI active-turn race handling.",
          turnId: staleTurnId,
          createdAt: observedAt,
          payload: {
            provider: "codex",
            method: "turn/steer",
            recovery: "turn-start-after-no-active-turn",
            messageId: event.payload.messageId,
            staleTurnId,
          },
        });

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...activeSession,
            status: "ready",
            activeTurnId: null,
            lastError: null,
            updatedAt: observedAt,
          },
          createdAt: observedAt,
        });

        const sendTurnRequest = yield* buildSendTurnRequestForThread({
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          messageText: message.text,
          attachments: normalizedAttachments,
          ...(thread.modelSelection !== undefined ? { modelSelection: thread.modelSelection } : {}),
          interactionMode: thread.interactionMode,
          createdAt: observedAt,
          thread,
          ...(project !== undefined ? { project } : {}),
        });

        yield* deliverPersistedSteerAsNextTurn({
          request: sendTurnRequest,
          staleTurnId,
          reason: "turn-start-after-provider-no-active-turn",
          providerHint: "codex",
          createdAt: observedAt,
        });
      }).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor could not queue stale steer recovery", {
            threadId: event.payload.threadId,
            staleTurnId: activeSession.activeTurnId,
            outcome: Cause.hasInterruptsOnly(recoveryCause) ? "interrupted" : "failed",
          }).pipe(
            Effect.andThen(
              orchestrationEngine.dispatch(
                buildCodexSteerNextTurnQueuedCommand({
                  threadId: event.payload.threadId,
                  messageId: event.payload.messageId,
                  intentSequence: event.sequence,
                  staleTurnId: activeSession.activeTurnId,
                  reason: "turn-start-after-provider-no-active-turn",
                  createdAt: event.payload.createdAt,
                }),
              ),
            ),
          ),
        ),
      );

    // Codex app-server's `turn/steer` is intentionally not a second
    // `turn/start`: upstream requires the expected active turn id, rejects
    // mismatches, does not accept turn-level overrides, and does not emit a new
    // `turn/started` notification. Keep this operation separate so a follow-up
    // typed during an active turn cannot violate Codex's one-active-turn
    // invariant by starting another turn.
    if ((yield* revalidateSteerIntentForProviderIo()) === undefined) {
      return;
    }
    if (isCodexSteerIntent) {
      yield* orchestrationEngine
        .dispatch(
          buildCodexSteerDeliveryAttemptedActivityCommand({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            intentSequence: event.sequence,
            delivery: "live-steer",
            reason: "live-steer",
            expectedTurnId,
            createdAt: event.payload.createdAt,
          }),
        )
        .pipe(Effect.retry({ times: 2 }));

      // The durable attempt append can yield long enough for Stop or another
      // turn intent to commit. Revalidate after the append so that later user
      // control state wins before the provider mutation begins.
      if ((yield* revalidateSteerIntentForProviderIo()) === undefined) {
        return;
      }
    }
    yield* providerService
      .steerTurn({
        threadId: event.payload.threadId,
        expectedTurnId,
        messageId: event.payload.messageId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      })
      .pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => {
            if (isCodexNoActiveTurnToSteerFailure(cause)) {
              return recoverStaleCodexSteerAsTurnStart(cause);
            }
            const codexNonSteerableTurnKind = detectCodexNonSteerableTurnKind(cause);
            const unsupportedLiveSteer = isUnsupportedLiveSteerFailure(cause);
            // Grok's own TUI puts every rejected interjection back into its
            // follow-up queue. Match that lossless behavior through Cafe's
            // existing queue surface; a private extension rejection must never
            // strand a durably recorded user message in an error-only state.
            const rejectedGrokInterject = isRejectedGrokInterjectFailure(cause);
            const retryableFollowUp =
              codexNonSteerableTurnKind !== undefined ||
              unsupportedLiveSteer ||
              rejectedGrokInterject;
            return appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.steer.failed",
              summary: retryableFollowUp ? "Provider steer queued" : "Provider steer failed",
              detail:
                codexNonSteerableTurnKind !== undefined
                  ? codexNonSteerableDetail(codexNonSteerableTurnKind)
                  : unsupportedLiveSteer || rejectedGrokInterject
                    ? retryableFollowUpDetail()
                    : formatFailureDetail(cause),
              turnId: thread.session?.activeTurnId ?? null,
              createdAt: event.payload.createdAt,
              messageId: event.payload.messageId,
              intentSequence: event.sequence,
              ...(retryableFollowUp
                ? {
                    retryableFollowUp: true,
                    retryAfter: "active-turn" as const,
                    ...(codexNonSteerableTurnKind !== undefined
                      ? { codexNonSteerableTurnKind }
                      : {}),
                  }
                : {}),
            });
          },
          onSuccess: (turn) => {
            if (activeSession.providerName !== "codex") {
              return Effect.void;
            }
            return Effect.gen(function* () {
              const acceptedAt = DateTime.formatIso(yield* DateTime.now);
              yield* recordAcceptedCodexSteer({
                threadId: event.payload.threadId,
                turnId: turn.turnId,
                messageId: event.payload.messageId,
                intentSequence: event.sequence,
                ...(turn.clientCorrelationId !== undefined
                  ? { clientCorrelationId: turn.clientCorrelationId }
                  : {}),
                intentCreatedAt: event.payload.createdAt,
                acceptedAt,
              });
            });
          },
        }),
        Effect.forkScoped,
      );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processUserInputSnoozeRequested = Effect.fn("processUserInputSnoozeRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-snooze-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread?.session || thread.session.status === "stopped") {
      return;
    }

    yield* providerService
      .snoozeUserInput({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          // A request may auto-resolve in the narrow interval between the
          // renderer's first interaction and this command. That race is
          // harmless and should not become a toast or stale pending card.
          Effect.logWarning("provider user-input auto-resolution snooze was not applied", {
            threadId: event.payload.threadId,
            requestId: event.payload.requestId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
  });

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const appendGoalOperationFailure = (input: {
    readonly threadId: ThreadId;
    readonly operation: "set" | "clear" | "replace";
    readonly createdAt: string;
    readonly unsupported?: boolean;
  }) =>
    appendProviderFailureActivity({
      threadId: input.threadId,
      kind: `provider.goal.${input.operation}.failed`,
      summary:
        input.operation === "clear"
          ? "Goal was not cleared"
          : input.operation === "replace"
            ? "Goal replacement was not completed"
            : "Goal update was not applied",
      detail:
        input.unsupported === true
          ? "This provider does not expose Codex-compatible durable goal controls."
          : input.operation === "replace"
            ? "The provider did not complete the ordered clear-and-create replacement. The synchronized goal state will follow the provider's authoritative notifications."
            : "The provider did not apply the goal operation. The previously synchronized goal state was left unchanged.",
      turnId: null,
      createdAt: input.createdAt,
    });

  const requireGoalServiceForThread = Effect.fn("requireGoalServiceForThread")(function* (
    thread: OrchestrationThread,
    createdAt: string,
  ) {
    const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
    const capabilities = yield* providerService.getCapabilities(instanceId);
    if (
      capabilities.threadGoals !== "supported" ||
      providerService.getGoal === undefined ||
      providerService.setGoal === undefined ||
      providerService.clearGoal === undefined
    ) {
      return null;
    }
    yield* ensureSessionForThread(thread.id, createdAt, { thread });
    return {
      getGoal: providerService.getGoal,
      setGoal: providerService.setGoal,
      clearGoal: providerService.clearGoal,
    };
  });

  const processGoalSetRequested = Effect.fn("processGoalSetRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-set-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const goalService = yield* requireGoalServiceForThread(thread, event.payload.createdAt);
    if (goalService === null) {
      yield* appendGoalOperationFailure({
        threadId: thread.id,
        operation: "set",
        createdAt: event.payload.createdAt,
        unsupported: true,
      });
      return;
    }
    const replaceExisting = event.payload.replaceExisting === true;
    const applyGoalUpdate = Effect.gen(function* () {
      const goalSetInput = replaceExisting
        ? yield* goalService.clearGoal({ threadId: thread.id }).pipe(
            Effect.as({
              threadId: thread.id,
              objective: event.payload.objective!,
              status: "active" as const,
              tokenBudget: null,
            }),
          )
        : {
            threadId: thread.id,
            ...(event.payload.objective !== undefined
              ? { objective: event.payload.objective }
              : {}),
            ...(event.payload.status !== undefined ? { status: event.payload.status } : {}),
            ...(event.payload.tokenBudget !== undefined
              ? { tokenBudget: event.payload.tokenBudget }
              : {}),
          };
      return yield* goalService.setGoal(goalSetInput);
    });
    yield* applyGoalUpdate.pipe(
      Effect.flatMap((goal) =>
        orchestrationEngine.dispatch({
          type: "thread.goal.sync",
          commandId: CommandId.make(`provider-goal-set:${event.eventId}`),
          threadId: thread.id,
          goal,
          createdAt: goal.updatedAt,
        }),
      ),
      Effect.catchCause(() =>
        appendGoalOperationFailure({
          threadId: thread.id,
          operation: replaceExisting ? "replace" : "set",
          createdAt: event.payload.createdAt,
        }),
      ),
    );
  });

  const processGoalClearRequested = Effect.fn("processGoalClearRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.goal-clear-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const goalService = yield* requireGoalServiceForThread(thread, event.payload.createdAt);
    if (goalService === null) {
      yield* appendGoalOperationFailure({
        threadId: thread.id,
        operation: "clear",
        createdAt: event.payload.createdAt,
        unsupported: true,
      });
      return;
    }
    yield* goalService.clearGoal({ threadId: thread.id }).pipe(
      Effect.flatMap(() =>
        orchestrationEngine.dispatch({
          type: "thread.goal.sync",
          commandId: CommandId.make(`provider-goal-clear:${event.eventId}`),
          threadId: thread.id,
          goal: null,
          createdAt: event.payload.createdAt,
        }),
      ),
      Effect.catchCause(() =>
        appendGoalOperationFailure({
          threadId: thread.id,
          operation: "clear",
          createdAt: event.payload.createdAt,
        }),
      ),
    );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const project = yield* resolveProject(thread.projectId);
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
          ...(cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {}),
          thread,
          ...(project !== undefined ? { project } : {}),
        });
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.turn-steer-requested":
        yield* processTurnSteerRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.user-input-snooze-requested":
        yield* processUserInputSnoozeRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
      case "thread.goal-set-requested":
        yield* processGoalSetRequested(event);
        return;
      case "thread.goal-clear-requested":
        yield* processGoalClearRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const enqueueProviderIntentEvent = Effect.fn("enqueueProviderIntentEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    if (!(yield* claimProviderIntentEvent(event.eventId))) {
      return;
    }
    yield* worker.enqueue(event);
  });

  const dispatchStartupRecoveryCommand = Effect.fn("dispatchStartupRecoveryCommand")(function* (
    command: Parameters<typeof orchestrationEngine.dispatch>[0],
  ) {
    const before = yield* orchestrationEngine.diagnosticsSnapshot;
    const receipt = yield* orchestrationEngine.dispatch(command);
    if (
      (command.type !== "thread.turn.start" && command.type !== "thread.turn.steer") ||
      receipt.sequence > before.commandReadModelSequence
    ) {
      return;
    }

    // A command receipt can survive a crash that happened before the old
    // reactor performed the provider side effect. Redispatch correctly
    // returns the original sequence without republishing on the hot stream;
    // replay that one persisted intent into this process-local worker.
    const persistedIntent = yield* orchestrationEngine
      .readEvents(Math.max(0, receipt.sequence - 1))
      .pipe(Stream.take(1), Stream.runHead);
    if (
      Option.isSome(persistedIntent) &&
      (persistedIntent.value.type === "thread.turn-start-requested" ||
        persistedIntent.value.type === "thread.turn-steer-requested")
    ) {
      yield* enqueueProviderIntentEvent(persistedIntent.value);
    }
  });

  const recoverUnsettledCodexSteerIntentsOnStartup = Effect.fn(
    "recoverUnsettledCodexSteerIntentsOnStartup",
  )(function* () {
    const candidates = yield* projectionSnapshotQuery.getUnsettledCodexSteerIntentEvents();
    let replayedCount = 0;
    yield* Effect.forEach(
      candidates,
      (candidate) =>
        Effect.gen(function* () {
          const persistedIntent = yield* orchestrationEngine
            .readEvents(Math.max(0, candidate.sequence - 1))
            .pipe(Stream.take(1), Stream.runHead);
          if (
            Option.isNone(persistedIntent) ||
            persistedIntent.value.sequence !== candidate.sequence ||
            persistedIntent.value.type !== "thread.turn-steer-requested" ||
            persistedIntent.value.payload.threadId !== candidate.threadId ||
            persistedIntent.value.payload.messageId !== candidate.messageId ||
            persistedIntent.value.payload.expectedTurnId !== candidate.expectedTurnId
          ) {
            return;
          }
          yield* enqueueProviderIntentEvent(persistedIntent.value);
          replayedCount += 1;
        }),
      { concurrency: 1, discard: true },
    );
    if (replayedCount > 0) {
      yield* Effect.logWarning("provider command reactor replayed unsettled Codex steer intents", {
        intentCount: replayedCount,
      });
    }
  });

  const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
    if (
      event.type === "thread.runtime-mode-set" ||
      event.type === "thread.turn-start-requested" ||
      event.type === "thread.turn-interrupt-requested" ||
      event.type === "thread.turn-steer-requested" ||
      event.type === "thread.approval-response-requested" ||
      event.type === "thread.user-input-response-requested" ||
      event.type === "thread.user-input-snooze-requested" ||
      event.type === "thread.session-stop-requested" ||
      event.type === "thread.goal-set-requested" ||
      event.type === "thread.goal-clear-requested"
    ) {
      return yield* enqueueProviderIntentEvent(event);
    }
  });

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    // Start the live subscription before startup reconciliation can dispatch
    // provider commands. The cooperative yield lets Stream.fromPubSub acquire
    // its scoped subscription before the first recovery write without adding
    // wall-clock latency. Persisted command-receipt recovery below separately
    // replays an intent when a prior process already committed its event.
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
    yield* Effect.yieldNow;

    yield* recoverInterruptedProviderWorkOnStartup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "provider command reactor failed to reconcile interrupted provider work after restart",
          { cause: Cause.pretty(cause) },
        ),
      ),
    );
    yield* recoverUnsettledCodexSteerIntentsOnStartup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "provider command reactor failed to replay unsettled Codex steers after restart",
          {
            outcome: Cause.hasInterruptsOnly(cause) ? "interrupted" : "failed",
          },
        ),
      ),
    );
    yield* recoverPostTerminalStaleSteerMessagesOnStartup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "provider command reactor failed to recover post-terminal stale steers after restart",
          { cause: Cause.pretty(cause) },
        ),
      ),
    );
    yield* resumeActiveCodexGoalsOnStartup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to resume active goals", {
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
