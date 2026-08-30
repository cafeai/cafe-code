import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationThreadActivity,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ModelSelection,
  type ProviderDriverKind,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import { type ChatMessage, type SessionPhase, type Thread, type ThreadSession } from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { selectThreadByRef, useStore } from "../store";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "cafe-code:last-invoked-script-by-project";
export const LEGACY_LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "cafecode:last-invoked-script-by-project";
const INLINE_CONTEXT_PLACEHOLDER = "\uFFFC";

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function shouldPinTimelineToEndForLocalMessage(): true {
  return true;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function mergePendingSteerSnapshotsForInterruptedTurn(
  snapshots: readonly {
    readonly promptText: string;
    readonly images: readonly ComposerImageAttachment[];
  }[],
): { readonly promptText: string; readonly images: ComposerImageAttachment[] } | null {
  if (snapshots.length === 0) {
    return null;
  }

  return {
    // Codex TUI drains pending steers after an interrupt and submits them as a
    // single merged user turn. Empty text snapshots can still carry images, so
    // omit blank text from the newline join while preserving every attachment.
    promptText: snapshots
      .map((snapshot) => snapshot.promptText)
      .filter((promptText) => promptText.length > 0)
      .join("\n"),
    images: snapshots.flatMap((snapshot) =>
      snapshot.images.map((image) => cloneComposerImageForRetry(image)),
    ),
  };
}

export function shouldResolvePendingSteerDispatch(input: {
  readonly provider: string | null | undefined;
  readonly terminalTurnAfterSteer: boolean;
  readonly steerProcessingStarted: boolean;
  readonly steerFailureRecorded: boolean;
  readonly steerRecoveryRecorded: boolean;
  readonly assistantResponseAfterSteer: boolean;
}): boolean {
  if (input.steerFailureRecorded || input.steerRecoveryRecorded) {
    return true;
  }

  if (input.provider === "codex") {
    // Upstream Codex owns the active-turn race inside one UserTurn command:
    // `turn/steer` falls through to exactly one `turn/start` only after
    // app-server reports that the cached active turn is gone. A terminal
    // projection by itself is therefore not permission for the renderer to
    // replay the same input. Wait for provider processing or the backend's
    // explicit recovery/failure activity instead.
    return input.steerProcessingStarted;
  }

  return (
    input.steerProcessingStarted ||
    input.assistantResponseAfterSteer ||
    input.terminalTurnAfterSteer
  );
}

function readUnknownRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Read the exact message identity from the backend-authored terminal recovery
 * receipt. The caller must first require the allowlisted activity kind; unlike
 * a generic runtime warning, this durable receipt is written only after the
 * recovered provider request succeeds. Keeping the kind check outside the
 * payload prevents an arbitrary provider payload with a `messageId` field from
 * settling the renderer's pending steer state.
 */
export function readRecoveredSteerMessageId(input: {
  readonly activityKind: string;
  readonly payload: unknown;
}): string | null {
  if (input.activityKind !== "provider.turn.steer.recovered") {
    return null;
  }
  const payload = readUnknownRecord(input.payload);
  if (payload === null || payload.provider !== "codex") {
    return null;
  }
  const messageId = readNonEmptyString(payload.messageId);
  const acceptedTurnId = readNonEmptyString(payload.acceptedTurnId);
  const recoveredTurnId = readNonEmptyString(payload.recoveredTurnId);
  return messageId !== null && acceptedTurnId !== null && recoveredTurnId !== null
    ? messageId
    : null;
}

/**
 * Read the exact identity from the successful server-authored next-turn
 * receipt. Provider warnings are deliberately excluded: a pre-I/O warning can
 * describe a retry without proving that the user's input reached Codex.
 */
export function readDeliveredSteerMessageId(input: {
  readonly activityKind: string;
  readonly payload: unknown;
}): string | null {
  if (input.activityKind !== "provider.turn.steer.delivered") {
    return null;
  }
  const payload = readUnknownRecord(input.payload);
  if (payload === null || payload.provider !== "codex" || payload.delivery !== "next-turn") {
    return null;
  }
  const messageId = readNonEmptyString(payload.messageId);
  const deliveredTurnId = readNonEmptyString(payload.deliveredTurnId);
  return messageId !== null && deliveredTurnId !== null ? messageId : null;
}

export type RetryableCodexSteerTurnKind = "review" | "compact";

export interface RetryableSteerFailure {
  readonly messageId: MessageId;
  readonly intentSequence: number | null;
  readonly turnKind: RetryableCodexSteerTurnKind | null;
}

function readIntentSequence(payload: Readonly<Record<string, unknown>> | null): number | null {
  const value = payload?.intentSequence;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function doesSteerFailureActivityMatchPending(input: {
  readonly activity: OrchestrationThreadActivity;
  readonly pendingMessageId: MessageId;
  readonly pendingIntentSequence: number | null;
  readonly dispatchedAt: string;
}): boolean {
  if (input.activity.kind !== "provider.turn.steer.failed") {
    return false;
  }
  const payload = readUnknownRecord(input.activity.payload);
  if (readNonEmptyString(payload?.messageId) !== String(input.pendingMessageId)) {
    return false;
  }
  const failureIntentSequence = readIntentSequence(payload);
  if (input.pendingIntentSequence !== null && failureIntentSequence !== null) {
    return input.pendingIntentSequence === failureIntentSequence;
  }
  // Legacy failures and the narrow interval before dispatchCommand returns do
  // not have both durable sequences available. Time still keeps an older
  // same-message generation from settling the newly submitted retry.
  return input.activity.createdAt >= input.dispatchedAt;
}

export function readRetryableSteerFailure(
  activity: OrchestrationThreadActivity,
): RetryableSteerFailure | null {
  if (activity.kind !== "provider.turn.steer.failed") {
    return null;
  }
  const payload = readUnknownRecord(activity.payload);
  if (payload?.retryableFollowUp !== true) {
    return null;
  }
  const messageId = readNonEmptyString(payload.messageId);
  const turnKind = readNonEmptyString(payload.codexNonSteerableTurnKind);
  if (messageId === null) {
    return null;
  }
  return {
    messageId: messageId as MessageId,
    intentSequence: readIntentSequence(payload),
    turnKind: turnKind === "review" || turnKind === "compact" ? turnKind : null,
  };
}

function readTrustedSteerDeliveryMessageId(activity: OrchestrationThreadActivity): string | null {
  const recovered = readRecoveredSteerMessageId({
    activityKind: activity.kind,
    payload: activity.payload,
  });
  if (recovered !== null) {
    return recovered;
  }
  const delivered = readDeliveredSteerMessageId({
    activityKind: activity.kind,
    payload: activity.payload,
  });
  if (delivered !== null) {
    return delivered;
  }
  if (activity.kind !== "provider.turn.steer.accepted") {
    return null;
  }
  const payload = readUnknownRecord(activity.payload);
  if (payload?.provider !== "codex") {
    return null;
  }
  const messageId = readNonEmptyString(payload.messageId);
  const acceptedTurnId = readNonEmptyString(payload.acceptedTurnId);
  return messageId !== null && acceptedTurnId !== null ? messageId : null;
}

export interface RetryableSteerReplayCandidate {
  readonly failure: RetryableSteerFailure;
  readonly failedAt: string;
  readonly message: ChatMessage & { readonly role: "user" };
}

/**
 * Rebuild the volatile retry shelf from durable, same-thread facts. The
 * failure activity supplies retry authority; the canonical user message is
 * the sole source of prompt/attachment metadata. A later trusted delivery
 * receipt, or the message being retargeted onto a different turn, proves that
 * the old failure has already been handled and suppresses reconstruction.
 */
export function deriveRetryableSteerReplayCandidates(input: {
  readonly thread: Pick<Thread, "messages" | "activities">;
  readonly existingSourceMessageIds?: ReadonlySet<string>;
}): RetryableSteerReplayCandidate[] {
  const excluded = input.existingSourceMessageIds ?? new Set<string>();
  const messagesById = new Map(
    input.thread.messages.map((message) => [String(message.id), message]),
  );
  const candidatesByMessageId = new Map<string, RetryableSteerReplayCandidate>();
  const deliveredMessageIds = new Set<string>();

  // Scan backward once rather than searching the tail for every failure. A
  // long-running provider can accumulate many thousands of activities, so an
  // O(n²) reconnect path would turn durable recovery itself into UI lag.
  for (let index = input.thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = input.thread.activities[index];
    if (activity === undefined) {
      continue;
    }
    const deliveredMessageId = readTrustedSteerDeliveryMessageId(activity);
    if (deliveredMessageId !== null) {
      deliveredMessageIds.add(deliveredMessageId);
      continue;
    }
    const failure = readRetryableSteerFailure(activity);
    const failureMessageId = failure === null ? null : String(failure.messageId);
    if (
      failure === null ||
      failureMessageId === null ||
      excluded.has(failureMessageId) ||
      deliveredMessageIds.has(failureMessageId) ||
      candidatesByMessageId.has(failureMessageId)
    ) {
      continue;
    }
    const message = messagesById.get(failureMessageId);
    if (message?.role !== "user") {
      continue;
    }

    // A same-id retry updates the canonical message row. An older failure is
    // therefore evidence for the previous generation, not authority to
    // recreate or immediately settle the newer retry after reload.
    const canonicalGenerationAt = message.completedAt ?? message.createdAt;
    if (activity.createdAt < canonicalGenerationAt) {
      continue;
    }

    // Retrying the same durable message id intentionally retargets the
    // canonical row. A different turn association therefore acts as a durable
    // consumed marker even if the app restarted before the provider receipt.
    if (
      activity.turnId !== null &&
      message.turnId !== null &&
      message.turnId !== undefined &&
      message.turnId !== activity.turnId
    ) {
      continue;
    }

    candidatesByMessageId.set(failureMessageId, {
      failure,
      failedAt: activity.createdAt,
      message: message as ChatMessage & { readonly role: "user" },
    });
  }

  // The reverse scan inserts newest rows first. Restore chronological shelf
  // order so automatic retries retain the provider's original queue order.
  return [...candidatesByMessageId.values()].toReversed();
}

export const MAX_PENDING_STEER_DISPATCHES = 64;

export function shouldBackpressurePendingSteerDispatch(
  pendingCount: number,
  capacity = MAX_PENDING_STEER_DISPATCHES,
): boolean {
  return pendingCount >= capacity;
}

export interface RestoredCanonicalRetryImages {
  readonly images: ComposerImageAttachment[];
  readonly unavailableCount: number;
}

/**
 * Best-effort reconstruction for reload recovery. Canonical messages retain
 * immutable attachment metadata and an authenticated preview URL, but not a
 * renderer File object. Fetch each available preview back into a File so an
 * automatic retry can preserve images; fail individual entries closed rather
 * than silently sending a materially different prompt.
 */
export async function restoreCanonicalRetryImages(
  attachments: ChatMessage["attachments"],
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<RestoredCanonicalRetryImages> {
  if (!attachments || attachments.length === 0) {
    return { images: [], unavailableCount: 0 };
  }
  if (typeof fetcher !== "function" || typeof File === "undefined") {
    return { images: [], unavailableCount: attachments.length };
  }

  const results = await Promise.all(
    attachments.map(async (attachment): Promise<ComposerImageAttachment | null> => {
      if (
        attachment.type !== "image" ||
        !attachment.previewUrl ||
        !attachment.mimeType.startsWith("image/")
      ) {
        return null;
      }
      try {
        const response = await fetcher(attachment.previewUrl, { credentials: "same-origin" });
        if (!response.ok) {
          return null;
        }
        const blob = await response.blob();
        if (blob.size === 0 || blob.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
          return null;
        }
        return {
          type: "image",
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: blob.size,
          previewUrl: attachment.previewUrl,
          file: new File([blob], attachment.name, { type: attachment.mimeType }),
        };
      } catch {
        return null;
      }
    }),
  );
  return {
    images: results.filter((image): image is ComposerImageAttachment => image !== null),
    unavailableCount: results.filter((image) => image === null).length,
  };
}

export function readSteerProcessingMessageId(payloadValue: unknown): string | null {
  const payload = readUnknownRecord(payloadValue);
  if (payload === null) {
    return null;
  }

  const directMessageId = readNonEmptyString(payload.messageId);
  if (directMessageId !== null) {
    return directMessageId;
  }

  // Runtime task activities historically preserve provider-specific metadata
  // under `usage`. Accept that transport shape during the protocol migration,
  // while preferring the explicit top-level correlation used by new events.
  return readNonEmptyString(readUnknownRecord(payload.usage)?.messageId);
}

export function doesSteerProcessingActivityMatchPending(input: {
  readonly pendingMessageId: string;
  readonly processingMessageId: string | null;
  readonly legacyTurnMatches: boolean;
}): boolean {
  // New provider activities carry the durable Cafe message id. Once that
  // correlation exists it is authoritative, including when multiple steers
  // target the same active turn. Falling back to the turn-wide marker in that
  // case would allow one steer to clear every sibling pending row.
  if (input.processingMessageId !== null) {
    return input.processingMessageId === input.pendingMessageId;
  }

  // Older persisted activities predate message correlation. Preserve their
  // established turn-based settlement behavior so historical threads remain
  // readable while all new events use the exact message identity above.
  return input.legacyTurnMatches;
}

/**
 * Exact server-correlated processing is identity proof and must not depend on
 * browser/provider wall-clock agreement. Keep the timestamp guard only for
 * legacy rows that lack a MessageId and therefore still need an ordering hint.
 */
export function isSteerProcessingActivityTimely(input: {
  readonly processingMessageId: string | null;
  readonly activityCreatedAt: string;
  readonly dispatchedAt: string;
}): boolean {
  return input.processingMessageId !== null || input.activityCreatedAt >= input.dispatchedAt;
}

export function deriveComposerSendState(options: { prompt: string; imageCount: number }): {
  trimmedPrompt: string;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = options.prompt.replaceAll(INLINE_CONTEXT_PLACEHOLDER, "").trim();
  return {
    trimmedPrompt,
    hasSendableContent: trimmedPrompt.length > 0 || options.imageCount > 0,
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// Existing threads used to lock the picker to the provider driver that created
// the current session. Cafe's durable thread history is provider-agnostic,
// while live provider sessions are not; the backend now handles that boundary
// by starting a fresh provider session whenever the user selects an
// incompatible provider/instance. Keep the composer unlocked so users can move
// a thread to any configured provider without rewriting historical context.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  void input;
  return null;
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => selectThreadByRef(useStore.getState(), threadRef);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(selectThreadByRef(state, threadRef))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

function completedTurnAcknowledgesLocalDispatch(
  localDispatch: LocalDispatchSnapshot,
  latestTurn: Thread["latestTurn"] | null,
): boolean {
  if (!latestTurn?.completedAt) {
    return false;
  }

  const dispatchStartedAt = Date.parse(localDispatch.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (!Number.isFinite(dispatchStartedAt) || !Number.isFinite(turnCompletedAt)) {
    return false;
  }

  return turnCompletedAt >= dispatchStartedAt;
}

export function resolveFollowUpQueuePhase(input: {
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  activeTurnId: TurnId | null | undefined;
  sessionUpdatedAt?: string | null | undefined;
}): SessionPhase {
  if (input.phase !== "running") {
    return input.phase;
  }
  if (!input.latestTurn?.completedAt) {
    return input.phase;
  }
  // Claude can report a fresh `running` session snapshot with no active turn id
  // while the next SDK prompt is being queued. If that snapshot is newer than
  // the last completed turn, starting another turn immediately would race the
  // backend's one-active-turn invariant; keep the follow-up in the queue until
  // the provider reports either a real active turn id or a settled session.
  if (
    input.activeTurnId == null &&
    input.sessionUpdatedAt !== undefined &&
    input.sessionUpdatedAt !== null
  ) {
    const sessionUpdatedAtMs = Date.parse(input.sessionUpdatedAt);
    const latestTurnCompletedAtMs = Date.parse(input.latestTurn.completedAt);
    if (
      Number.isFinite(sessionUpdatedAtMs) &&
      Number.isFinite(latestTurnCompletedAtMs) &&
      sessionUpdatedAtMs > latestTurnCompletedAtMs
    ) {
      return input.phase;
    }
  }
  return "ready";
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  if (completedTurnAcknowledgesLocalDispatch(input.localDispatch, input.latestTurn)) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== undefined &&
      session.activeTurnId !== null &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
