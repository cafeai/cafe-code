import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import type { VisualizationTimelineEntry } from "@cafecode/contracts/visualizationApi";
import { getUiLocale, uiFormatNumber, uiText } from "@cafecode/shared/i18n";
import {
  providerStartupFailureDetail,
  readProviderStartupFailureCategoryFromPayload,
} from "@cafecode/shared/providerStartupFailure";
import {
  ApprovalRequestId,
  EventId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
  type OrchestrationThreadActivityCursor,
  type WorkLogOperationIdentity,
  THREAD_DETAIL_ACTIVITY_WINDOW_LIMIT,
  THREAD_TURN_ACTIVITY_PAGE_MAX_LIMIT,
  type ProviderTurnConfiguration,
  type OrchestrationProposedPlanId,
  ProviderDriverKind,
  ProviderInteraction,
  ProviderNetworkApproval,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import { summarizeToolArguments } from "@cafecode/shared/toolActivity";
import { deriveCurrentNativeAgentStarts } from "@cafecode/shared/liveWork";
import { codexRecoveryWorkLogLabel, nativeRetryWorkLogLabel } from "./codexRecovery";
import {
  deriveProviderDiagnosticWorkLogRecord,
  providerDiagnosticEchoKey,
  providerDiagnosticWorkLogLabel,
  type ProviderDiagnosticWorkLogRecord,
} from "./providerDiagnostic";
import {
  isRoutineProviderWorkLogActivity,
  readWorkLogOperationIdentity,
} from "@cafecode/shared/providerWorkLog";
import { visualizationEntryIdentity } from "./components/visualizations/visualizationEntryIdentity";
import { readTurnConfiguration, presentTurnConfiguration } from "./turnConfiguration";
import {
  readClaudeCommandInspection,
  readProviderPublicSummary,
  mergeClaudeCommandInspections,
  type ClaudeCommandInspection,
  type ProviderPublicSummary,
} from "./components/chat/providerOperationVisibility";

import {
  deriveSubagentActivities,
  subagentDisplayLabel,
  subagentDisplayDescription,
  isSubagentRuntimeCurrent,
  type DeriveSubagentActivityOptions,
  type DerivedSubagentActivity,
  type SubagentRunStatus,
  type SubagentRuntimeContext,
} from "./subagent-activity";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";
import { compareActivityWindowOrder } from "./activityOrder";
import {
  cafeWorkLogDisplayLabel,
  codexSteerDeliveryWorkLogLabel,
  contextCompactionDisplayLabel,
} from "./workLogPresentation";

export type ProviderPickerKind = ProviderDriverKind;
const isProviderInteraction = Schema.is(ProviderInteraction);
const isNetworkApproval = Schema.is(ProviderNetworkApproval);

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok Build",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export interface WorkLogEntry {
  id: string;
  turnId?: TurnId | null;
  createdAt: string;
  label: string;
  /** Cafe-authored display copy is separate from canonical lifecycle labels. */
  displayLabel?: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  displayToolTitle?: string;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  /** Explicit bounded public presentation, never arbitrary native payloads. */
  publicSummary?: ProviderPublicSummary;
  commandInspection?: ClaudeCommandInspection;
  /** Public occurrence metadata only; private JSON is read after expansion. */
  providerDiagnostic?: ProviderDiagnosticWorkLogRecord;
  /** Operation identity is for folding/deduplication, never task authority. */
  toolCallId?: string;
  /** Frozen accepted-turn settings; never reconstructed from today's catalog. */
  turnConfiguration?: ProviderTurnConfiguration;
  subagent?: {
    /** Stable provider child identity and deterministic avatar seed. */
    id: string;
    label: string;
    objective?: string;
    description?: string;
    status: SubagentRunStatus;
    startedAt: string;
    completedAt?: string;
    /** Latest durable lifecycle edge, used to invalidate an open detail view. */
    updatedAt?: string;
    /** Activity sequence/id revision; unlike timestamps this cannot collide. */
    lifecycleRevision?: string;
    /** Opaque provider history binding; never render or log this value. */
    historyId?: string;
    /** Native liveness evidence only, never a transcript authorization key. */
    runtimeId?: string;
    taskControl?: import("@cafecode/contracts").ProviderTaskControlCapability;
  };
}

/** Exact presentation identity only; it never grants native session authority. */
export function primaryClaudeSummaryKey(entry: WorkLogEntry): string | undefined {
  return entry.publicSummary?.provider === "claudeAgent" && entry.turnId && entry.toolCallId
    ? JSON.stringify([entry.turnId, entry.toolCallId])
    : undefined;
}

/** Render Cafe-owned copy without translating opaque provider/user labels or
 * the canonical strings consumed by legacy operation folding. */
export function workLogDisplayLabel(entry: WorkLogEntry): string {
  return entry.displayLabel ?? entry.label;
}

export function workLogDisplayToolTitle(entry: WorkLogEntry): string | undefined {
  // Resolve the current canonical lifecycle result after folding. Storing only
  // the start's display title would survive a later canonical completion.
  return (
    (entry.itemType === "context_compaction" && entry.toolTitle
      ? contextCompactionDisplayLabel(entry.toolTitle)
      : undefined) ??
    entry.displayToolTitle ??
    entry.toolTitle
  );
}

export interface HistoricalWorkLogSummary {
  turnId: TurnId;
  /** Unknown latest identity permits reading, not inferred legacy completion. */
  isHistoricalTurn?: boolean;
  previewEntries: ReadonlyArray<WorkLogEntry>;
  snapshotEntryCount: number;
  /** Subagents are conversation history, not command/tool Work Log rows. */
  subagentEntries?: ReadonlyArray<WorkLogEntry>;
  /** Immutable exclusive range for the earlier part of the current turn. */
  before?: OrchestrationThreadActivityCursor;
  /** Retention exceptions before the raw floor are already shown inline. */
  excludeActivityIds?: ReadonlyArray<OrchestrationThreadActivity["id"]>;
  /** Older snapshots of these same operations are already represented inline. */
  excludeOperations?: ReadonlyArray<WorkLogOperationIdentity>;
  /** Valid same-turn Codex settings already replace the native start receipt. */
  excludeTurnStartAck?: boolean;
  /** Current received snapshots win over separately fetched older versions. */
  liveActivities?: ReadonlyArray<OrchestrationThreadActivity>;
  /** Changes only when relevant work leaves the ordinary tail, not per token. */
  presenceRevision?: string;
}

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  operationStatus?: ClaudeCommandInspection["status"];
  operationCompletedAt?: string;
  collapseKey?: string;
  toolCallId?: string;
  /** Content-free duplicate-occurrence witness; stripped before rendering. */
  diagnosticEchoKey?: string;
}

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: "command" | "terminal-input" | "file-read" | "file-change";
  createdAt: string;
  detail?: string;
  networkApproval?: ProviderNetworkApproval;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
}

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
  isBlocking: boolean;
  /** Presentation hint only; the live native callback rechecks authority. */
  supportsUnanswered?: boolean;
  interaction?: ProviderInteraction;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type McpQuestionResolutionItem = {
  readonly question: {
    readonly id: string;
    readonly header: string;
    readonly question: string;
  };
} & (
  | { readonly answer: string | readonly string[] }
  | { readonly disposition: "skipped" | "dismissed" }
);

export type TimelineEntry =
  | {
      id: string;
      kind: "question-resolution";
      createdAt: string;
      turnId: TurnId | null;
      action: "answered" | "skipped" | "cleared";
      questionCount: number;
      /** Null preserves honest count-only receipts written before v2. */
      items: readonly McpQuestionResolutionItem[] | null;
    }
  | {
      id: string;
      kind: "provider-summary";
      createdAt: string;
      turnId: TurnId;
      operationKey: string;
      summary: ProviderPublicSummary;
    }
  | {
      id: string;
      kind: "visualization";
      createdAt: string;
      visualization: VisualizationTimelineEntry;
    }
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return uiText("{seconds}s", { seconds: 0 });

  // Turn-duration labels are user-facing liveness/status text, not precise
  // profiling metrics. Keep the same whole-second model for both the live
  // "Working for ..." timer and the completed "Worked for ..." summary so the
  // label does not change shape when a turn finishes.
  const elapsedSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (elapsedSeconds < 60) {
    return uiText("{seconds}s", { seconds: elapsedSeconds });
  }

  const hours = Math.floor(elapsedSeconds / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);
  const seconds = elapsedSeconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(uiText("{hours}h", { hours }));
  }
  if (minutes > 0) {
    parts.push(uiText("{minutes}m", { minutes }));
  }
  if (seconds > 0) {
    parts.push(uiText("{seconds}s", { seconds }));
  }

  return parts.length > 0 ? parts.join(" ") : uiText("{seconds}s", { seconds: 0 });
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<ThreadSession, "orchestrationStatus" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  if (
    session.activeTurnId === latestTurn.turnId &&
    session.orchestrationStatus !== "error" &&
    session.orchestrationStatus !== "interrupted" &&
    session.orchestrationStatus !== "stopped"
  ) {
    return false;
  }
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  const runningTurnId =
    session?.orchestrationStatus === "running" ? (session.activeTurnId ?? null) : null;
  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? sendStartedAt;
    }
    return sendStartedAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "terminal_input_approval":
      return "terminal-input";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(
  detail: string | undefined,
  lane: "approval" | "question",
): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  // A stale response belongs to its exact interaction channel. An unrelated
  // error's prose must not hide a still-pending permission or question card.
  return lane === "approval"
    ? normalized.includes("stale pending approval request") ||
        normalized.includes("unknown pending approval request") ||
        normalized.includes("unknown pending permission request")
    : normalized.includes("stale pending user-input request") ||
        normalized.includes("unknown pending user-input request");
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const requestKind =
      payload &&
      (payload.requestKind === "command" ||
        payload.requestKind === "terminal-input" ||
        payload.requestKind === "file-read" ||
        payload.requestKind === "file-change")
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
        ...(payload?.defaultToNo === true ? { defaultToNo: true } : {}),
        ...(payload?.suppressAlwaysAllowRule === true ? { suppressAlwaysAllowRule: true } : {}),
        ...(isNetworkApproval(payload?.networkApproval)
          ? { networkApproval: payload.networkApproval }
          : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail, "approval")
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      const interaction = isProviderInteraction(payload?.interaction)
        ? payload.interaction
        : undefined;
      if (!questions && !interaction) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions: questions ?? [],
        ...(interaction ? { interaction } : {}),
        // Events written before Codex 0.147 did not carry the field and must
        // remain blocking. Only an explicit false enables auto-resolution.
        isBlocking: payload?.isBlocking !== false,
        ...(payload?.supportsUnanswered === true ? { supportsUnanswered: true } : {}),
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail, "question")
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const allPlanActivities = ordered.filter((activity) => activity.kind === "turn.plan.updated");
  // Codex and Claude both emit complete checklist snapshots rather than
  // per-step patches. Prefer the current turn's newest snapshot, then retain
  // the prior turn's final snapshot across follow-up turns just as the Codex
  // TUI retains its last update_plan progress.
  const latest = Option.firstSomeOf([
    ...(latestTurnId
      ? Arr.findLast(allPlanActivities, (activity) => activity.turnId === latestTurnId)
      : Option.none()),
    Arr.last(allPlanActivities),
  ]).pipe(Option.getOrNull);
  if (!latest) {
    return null;
  }
  const payload =
    latest.payload && typeof latest.payload === "object"
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps = rawPlan
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      if (typeof record.step !== "string") {
        return null;
      }
      const status =
        record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
      return {
        step: record.step,
        status,
      };
    })
    .filter(
      (
        step,
      ): step is {
        step: string;
        status: "pending" | "inProgress" | "completed";
      } => step !== null,
    );
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: latest.createdAt,
    turnId: latest.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function findSidebarProposedPlan(input: {
  threads: ReadonlyArray<Pick<Thread, "id" | "proposedPlans">>;
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "sourceProposedPlan"> | null;
  latestTurnSettled: boolean;
  threadId: ThreadId | string | null | undefined;
}): LatestProposedPlanState | null {
  const activeThreadPlans =
    input.threads.find((thread) => thread.id === input.threadId)?.proposedPlans ?? [];

  if (!input.latestTurnSettled) {
    const sourceProposedPlan = input.latestTurn?.sourceProposedPlan;
    if (sourceProposedPlan) {
      const sourcePlan = input.threads
        .find((thread) => thread.id === sourceProposedPlan.threadId)
        ?.proposedPlans.find((plan) => plan.id === sourceProposedPlan.planId);
      if (sourcePlan) {
        return toLatestProposedPlanState(sourcePlan);
      }
    }
  }

  return findLatestProposedPlan(activeThreadPlans, input.latestTurn?.turnId ?? null);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

interface UnstartedTurnFailureContext {
  /** Canonical retained messages only; optimistic rows cannot attest admission. */
  readonly messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "turnId" | "createdAt">>;
  readonly latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "requestedAt" | "startedAt" | "completedAt"
  > | null;
}

function currentUnstartedMessageTimes(
  context: UnstartedTurnFailureContext | undefined,
  latestTurnId: TurnId | undefined,
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  if (!context || (context.latestTurn?.turnId ?? undefined) !== latestTurnId) return result;
  const boundary = context.latestTurn
    ? Date.parse(
        context.latestTurn.completedAt ??
          context.latestTurn.startedAt ??
          context.latestTurn.requestedAt,
      )
    : null;
  if (boundary !== null && !Number.isFinite(boundary)) return result;
  // A later successful turn closes this suffix. Do not carry old failed
  // messages into every subsequent turn's current work log merely because
  // those messages never acquired a provider TurnId of their own.
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index]!;
    if (message.turnId !== null && message.turnId !== undefined) break;
    if (message.role !== "user") continue;
    const createdAt = Date.parse(message.createdAt);
    if (!Number.isFinite(createdAt) || (boundary !== null && createdAt <= boundary)) continue;
    result.set(message.id, createdAt);
  }
  return result;
}

function isCurrentUnstartedTurnFailure(
  activity: OrchestrationThreadActivity,
  messageTimes: ReadonlyMap<string, number>,
  uniqueLegacyMessageTimes: ReadonlySet<number>,
): boolean {
  if (
    activity.kind !== "provider.turn.start.failed" ||
    activity.turnId !== null ||
    activity.tone !== "error"
  )
    return false;
  const payload = asRecord(activity.payload);
  const failedAt = Date.parse(activity.createdAt);
  if (!Number.isFinite(failedAt)) return false;
  if (
    payload &&
    Object.keys(payload).length === 1 &&
    Object.hasOwn(payload, "detail") &&
    typeof payload.detail === "string"
  ) {
    // Older failed-start rows retained only detail and the original intent's
    // timestamp. A unique same-time canonical pending message admits a generic
    // notice only; temporal coincidence is never a delivery/retry receipt.
    // Partial or future correlation objects cannot fall back to this path.
    return (
      uniqueLegacyMessageTimes.has(failedAt) &&
      (activity.sequence === undefined ||
        (Number.isSafeInteger(activity.sequence) && activity.sequence > 0))
    );
  }
  if (
    typeof payload?.messageId !== "string" ||
    typeof payload.intentSequence !== "number" ||
    !Number.isSafeInteger(payload.intentSequence) ||
    payload.intentSequence <= 0
  )
    return false;
  const messageTime = messageTimes.get(payload.messageId);
  // These received identities select presentation only. They grant no retry,
  // delivery, liveness or native-owner authority. A timestamp cannot bind a
  // stale failure to a later same-ID message, nor can malformed sequence data.
  return (
    messageTime !== undefined &&
    Number.isFinite(failedAt) &&
    failedAt >= messageTime &&
    (activity.sequence === undefined ||
      (Number.isSafeInteger(activity.sequence) && activity.sequence > payload.intentSequence))
  );
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options: DeriveSubagentActivityOptions & {
    includeUnscopedCompaction?: boolean;
    /** Main-chat-only visibility for a durably accepted message with no turn. */
    unstartedTurnFailures?: UnstartedTurnFailureContext;
  } = {},
): WorkLogEntry[] {
  const unstartedMessageTimes = currentUnstartedMessageTimes(
    options.unstartedTurnFailures,
    latestTurnId,
  );
  const uniqueLegacyMessageTimes = new Set<number>();
  const ambiguousLegacyMessageTimes = new Set<number>();
  for (const createdAt of unstartedMessageTimes.values()) {
    if (ambiguousLegacyMessageTimes.has(createdAt)) continue;
    if (uniqueLegacyMessageTimes.has(createdAt)) {
      uniqueLegacyMessageTimes.delete(createdAt);
      ambiguousLegacyMessageTimes.add(createdAt);
    } else uniqueLegacyMessageTimes.add(createdAt);
  }
  const admittedUnstartedFailures = new Set<string>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder).filter((activity) => {
    if (
      options.unstartedTurnFailures &&
      activity.turnId === null &&
      activity.kind === "provider.turn.start.failed"
    ) {
      if (!isCurrentUnstartedTurnFailure(activity, unstartedMessageTimes, uniqueLegacyMessageTimes))
        return false;
      admittedUnstartedFailures.add(activity.id);
      return true;
    }
    return (
      !latestTurnId ||
      activity.turnId === latestTurnId ||
      // Manual requests/failures and some provider compaction notifications
      // have no user turn. Keep them in the main tool list, but never copy
      // them into every historical turn's separately paged work log.
      (options.includeUnscopedCompaction &&
        activity.turnId === null &&
        (isContextCompactionActivity(activity) ||
          activity.kind === "provider.compaction.requested" ||
          activity.kind === "provider.compaction.failed"))
    );
  });
  const latestTaskVisibility = new Map<string, "visible" | "ambient">();
  const configuredCodexTurns = new Set<TurnId>();
  const configurationByActivityId = new Map<string, ProviderTurnConfiguration>();
  const configurationByTurnId = new Map<TurnId, ProviderTurnConfiguration>();
  for (const activity of ordered) {
    if (activity.kind === "provider.turn.configuration") {
      const configuration = readTurnConfiguration(activity.payload);
      if (configuration) {
        configurationByActivityId.set(activity.id, configuration);
        // One stable configuration fact exists per turn; keep the first.
        if (activity.turnId && !configurationByTurnId.has(activity.turnId)) {
          configurationByTurnId.set(activity.turnId, configuration);
        }
        if (activity.turnId && configuration.provider === "codex") {
          configuredCodexTurns.add(activity.turnId);
        }
      }
    }
    const identity = taskActivityIdentityKey(activity);
    if (!identity) continue;
    const visibility = taskActivityVisibility(activity);
    if (visibility) latestTaskVisibility.set(identity, visibility);
  }
  const entries = ordered
    // Structured task lifecycle supersedes the old generic collab tool row.
    // Removing both here avoids rendering `Subagent task - Started /root/x`
    // next to the richer, identity-stable subagent row.
    .filter((activity) => !isSubagentWorkActivity(activity))
    // Provenance-stamped workflow roots have their own richer Tasks card.
    // Malformed/future workflow objects must not fall through to a generic
    // task row, which could expose fields outside the admitted display schema.
    .filter(
      (activity) =>
        !activity.kind.startsWith("task.") || asRecord(activity.payload)?.workflow === undefined,
    )
    .filter((activity) => {
      const identity = taskActivityIdentityKey(activity);
      if (identity && latestTaskVisibility.get(identity) === "ambient") return false;
      return !isAmbientTaskActivity(activity);
    })
    .filter(
      (activity) =>
        activity.kind !== "tool.started" ||
        isContextCompactionActivity(activity) ||
        readClaudeCommandInspection(activity.payload) !== undefined,
    )
    // Reject malformed/future summary contracts instead of falling through to
    // generic detail rendering, where private native fields could be mistaken
    // for disclosed provider text.
    .filter(
      (activity) =>
        activity.kind !== "reasoning.summary" ||
        (asTrimmedString(asRecord(activity.payload)?.itemId) !== null &&
          readProviderPublicSummary(activity.payload) !== undefined),
    )
    .filter(
      (activity) => activity.kind !== "task.started" || isUserVisibleTaskStartedActivity(activity),
    )
    .filter((activity) => activity.kind !== "context-window.updated")
    // These structured prompts have their own nonblocking composer surface.
    // They must not create a duplicate generic work-log row or waiting state.
    .filter((activity) => activity.kind !== "provider.async-questions")
    // MCP handling is a primary conversation notice, including on replay. A
    // malformed/future notice must not fall back to exposing arbitrary detail
    // or answers through the generic Work Log renderer.
    .filter((activity) => activity.kind !== "mcp.question.resolved")
    .filter((activity) => activity.summary !== "Checkpoint captured")
    .filter((activity) => !isPlanBoundaryToolActivity(activity))
    .filter((activity) => !isRetryableSteerDeliveryActivity(activity))
    .filter((activity) => !isRoutineProviderWorkLogActivity(activity))
    // The native ACK is retained in durable history for diagnosis, but a valid
    // configuration row already communicates this same accepted start. Match
    // the exact turn/task identity, never a generic task label or today's turn.
    // Legacy ACKs (or malformed/missing configuration) remain visible unchanged.
    .filter((activity) => {
      if (
        activity.kind !== "task.progress" ||
        !activity.turnId ||
        !configuredCodexTurns.has(activity.turnId)
      )
        return true;
      const payload = asRecord(activity.payload);
      return payload?.taskId !== `codex-turn-start:${activity.turnId}`;
    })
    .map((activity) => {
      if (admittedUnstartedFailures.has(activity.id)) {
        // A preparation failure has no native turn, but it still belongs next
        // to its accepted user message. Keep opaque failure prose out of the
        // ordinary entry/debug/preview. Only the closed server-authored category
        // selects fixed Cafe copy; no received detail becomes display text or a
        // diagnostic subject. This marker grants no retry or native authority.
        const startupFailureCategory = readProviderStartupFailureCategoryFromPayload(
          activity.payload,
        );
        return {
          id: activity.id,
          turnId: activity.turnId,
          createdAt: activity.createdAt,
          label: uiText("Provider turn start failed"),
          ...(startupFailureCategory !== undefined
            ? { detail: providerStartupFailureDetail(startupFailureCategory, getUiLocale()) }
            : {}),
          tone: "error" as const,
          activityKind: activity.kind,
        };
      }
      return toDerivedWorkLogEntry(
        activity,
        configurationByActivityId.get(activity.id),
        activity.turnId ? configurationByTurnId.get(activity.turnId) : undefined,
      );
    });
  const collapsed = collapseDerivedWorkLogEntries(
    foldProviderDiagnosticEntries(foldClaudeOperationSnapshots(entries)),
  ).map(
    ({
      activityKind: _activityKind,
      operationStatus: _operationStatus,
      operationCompletedAt: _operationCompletedAt,
      collapseKey: _collapseKey,
      diagnosticEchoKey: _diagnosticEchoKey,
      ...entry
    }) => entry,
  );
  return collapsed;
}

function taskActivityIdentityKey(activity: OrchestrationThreadActivity): string | undefined {
  if (
    activity.kind !== "task.started" &&
    activity.kind !== "task.progress" &&
    activity.kind !== "task.completed"
  ) {
    return undefined;
  }
  const payload =
    activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;
  const taskId = typeof payload?.taskId === "string" && payload.taskId ? payload.taskId : undefined;
  return taskId ? JSON.stringify([activity.turnId ?? null, taskId]) : undefined;
}

function taskActivityVisibility(
  activity: OrchestrationThreadActivity,
): "visible" | "ambient" | undefined {
  const payload =
    activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;
  return payload?.visibility === "visible" || payload?.visibility === "ambient"
    ? payload.visibility
    : undefined;
}

function isAmbientTaskActivity(activity: OrchestrationThreadActivity): boolean {
  if (
    activity.kind !== "task.started" &&
    activity.kind !== "task.progress" &&
    activity.kind !== "task.completed"
  ) {
    return false;
  }
  return taskActivityVisibility(activity) === "ambient";
}

/**
 * Derive the provider-neutral child roster independently from command/tool
 * activity. Keeping this boundary explicit prevents presentation code from
 * accidentally counting a worker as a Work Log command while retaining the
 * same durable lifecycle ordering for Codex and Claude.
 */
export function deriveSubagentWorkEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
  options: DeriveSubagentActivityOptions = {},
): WorkLogEntry[] {
  const ordered = [...activities]
    .toSorted(compareActivitiesByOrder)
    .filter((activity) => (latestTurnId ? activity.turnId === latestTurnId : true));
  return deriveSubagentActivities(ordered, options).map(subagentToWorkLogEntry);
}

/**
 * Build the composer roster across every turn while completing only legacy
 * rows from turns that are no longer running. Structured provider lifecycle
 * rows remain authoritative, because Codex and Claude children can continue
 * in the background after the parent turn that spawned them settles.
 */
export function deriveActiveSubagentWorkEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  runningTurnId: TurnId | null | undefined,
  options: DeriveSubagentActivityOptions = {},
): WorkLogEntry[] {
  const terminalTurnIds = new Set<TurnId>();
  for (const activity of activities) {
    if (activity.turnId !== null) terminalTurnIds.add(activity.turnId);
  }
  if (runningTurnId) terminalTurnIds.delete(runningTurnId);

  const nativeOwners = new Map(
    deriveCurrentNativeAgentStarts(activities).map(({ activity, observation }) => [
      JSON.stringify([observation.runtimeId, observation.workId]),
      activity.turnId,
    ]),
  );
  const sourceHints = isSubagentRuntimeCurrent(
    options.liveWork?.runtimeId,
    options.runtimeSession ?? null,
  )
    ? options.liveWork
    : undefined;
  const unconfirmedAgentIds = new Set(sourceHints?.unconfirmedAgentIds);

  return deriveSubagentWorkEntries(activities, undefined, { ...options, terminalTurnIds }).filter(
    (entry) => {
      const child = entry.subagent;
      if (!child || (child.status !== "active" && child.status !== "waiting")) return false;
      if (
        child.runtimeId === sourceHints?.runtimeId &&
        (sourceHints?.unconfirmedAgentIdsTruncated === true || unconfirmedAgentIds.has(child.id))
      )
        return false;
      // Keep full historical rows and their exact history/control capabilities.
      // Only the live roster uses the explicit current native owner, matching
      // the shell counter and footer. A delayed old-turn edge cannot replace it.
      const key = JSON.stringify([child.runtimeId, child.id]);
      return !nativeOwners.has(key) || nativeOwners.get(key) === entry.turnId;
    },
  );
}

function isSubagentWorkActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload)
      ? (activity.payload as Record<string, unknown>)
      : null;
  return (
    (payload?.subagent !== null && typeof payload?.subagent === "object") ||
    payload?.itemType === "collab_agent_tool_call"
  );
}

export function subagentToWorkLogEntry(subagent: DerivedSubagentActivity): WorkLogEntry & {
  readonly subagent: NonNullable<WorkLogEntry["subagent"]>;
} {
  const fallback =
    subagent.status === "waiting"
      ? uiText("Waiting")
      : subagent.status === "active"
        ? uiText("Working")
        : subagent.status === "failed"
          ? uiText("Failed")
          : subagent.status === "stopped"
            ? uiText("Stopped")
            : subagent.status === "unknown"
              ? uiText("Status unavailable")
              : uiText("Completed");
  return {
    id: subagent.rowId,
    turnId: subagent.turnId,
    createdAt: subagent.startedAt,
    label: subagent.label,
    ...(subagent.displayLabel !== undefined ? { displayLabel: subagent.displayLabel } : {}),
    detail: subagent.objective ?? subagentDisplayDescription(subagent) ?? fallback,
    tone:
      subagent.status === "failed"
        ? "error"
        : subagent.status === "active" || subagent.status === "waiting"
          ? "thinking"
          : "info",
    itemType: "collab_agent_tool_call",
    subagent: {
      id: subagent.id,
      label: subagentDisplayLabel(subagent),
      ...(subagent.objective ? { objective: subagent.objective } : {}),
      ...(subagent.description ? { description: subagent.description } : {}),
      status: subagent.status,
      startedAt: subagent.startedAt,
      updatedAt: subagent.updatedAt,
      lifecycleRevision: subagent.lifecycleRevision,
      ...(subagent.completedAt ? { completedAt: subagent.completedAt } : {}),
      ...(subagent.historyId ? { historyId: subagent.historyId } : {}),
      ...(subagent.runtimeId ? { runtimeId: subagent.runtimeId } : {}),
      ...(subagent.taskControl ? { taskControl: subagent.taskControl } : {}),
    },
  };
}

/** Recheck locally retained/paged detail selections after a native-session change. */
export function reconcileSubagentWorkEntryRuntime<T extends WorkLogEntry>(
  entry: T,
  session: SubagentRuntimeContext | null,
): T {
  const child = entry.subagent;
  if (
    !child ||
    (child.status !== "active" && child.status !== "waiting") ||
    isSubagentRuntimeCurrent(child.runtimeId, session)
  )
    return entry;
  return {
    ...entry,
    subagent: {
      ...child,
      status: "unknown",
      ...(child.lifecycleRevision
        ? { lifecycleRevision: `${child.lifecycleRevision}:unverified` }
        : {}),
    },
  };
}

/** Canonical routing is unchanged; the input owner is a timeline anchor only. */
export function messageTimelineTurnId(message: ChatMessage): TurnId | null | undefined {
  return message.turnId ?? message.originatingTurn?.turnId;
}

export function deriveFailedUserMessageIds(input: {
  messages: ReadonlyArray<ChatMessage>;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}): ReadonlySet<ChatMessage["id"]> {
  const failed = new Set<ChatMessage["id"]>();
  const messages = new Map(
    input.messages
      .filter((message) => message.role === "user")
      .map((message) => [message.id, message]),
  );
  for (const message of messages.values()) {
    if (message.sendFailed || message.originatingTurn?.state === "error") failed.add(message.id);
  }
  for (const activity of input.activities) {
    if (activity.kind !== "provider.turn.start.failed" || activity.tone !== "error") continue;
    const payload = asRecord(activity.payload);
    if (
      typeof payload?.messageId !== "string" ||
      !Number.isSafeInteger(payload.intentSequence) ||
      Number(payload.intentSequence) <= 0
    )
      continue;
    const message = messages.get(payload.messageId as ChatMessage["id"]);
    if (
      !message ||
      message.originatingTurn ||
      (activity.turnId !== null && activity.turnId !== message.turnId)
    )
      continue;
    const generation = Date.parse(message.completedAt ?? message.createdAt);
    const failedAt = Date.parse(activity.createdAt);
    if (
      Number.isFinite(generation) &&
      Number.isFinite(failedAt) &&
      failedAt >= generation &&
      (activity.sequence === undefined || activity.sequence > Number(payload.intentSequence))
    )
      failed.add(message.id);
  }
  return failed;
}

export function deriveHistoricalWorkLogSummaries(input: {
  messages: ReadonlyArray<ChatMessage>;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  latestTurnId?: TurnId | null | undefined;
  runtimeSession?: DeriveSubagentActivityOptions["runtimeSession"];
}): ReadonlyMap<TurnId, HistoricalWorkLogSummary> {
  const latestTurnId = input.latestTurnId ?? null;
  const historicalTurnIds = new Set<TurnId>();
  for (const message of input.messages) {
    const turnId = messageTimelineTurnId(message);
    if (turnId !== null && turnId !== undefined && turnId !== latestTurnId) {
      historicalTurnIds.add(turnId);
    }
  }
  for (const activity of input.activities) {
    if (activity.turnId !== null && activity.turnId !== latestTurnId) {
      historicalTurnIds.add(activity.turnId);
    }
  }

  const entriesByTurnId = new Map<TurnId, WorkLogEntry[]>();
  const knownHistoricalTurnIds = latestTurnId === null ? new Set<TurnId>() : historicalTurnIds;
  const workLogEntries = deriveWorkLogEntries(input.activities, undefined, {
    terminalTurnIds: knownHistoricalTurnIds,
  });
  for (const entry of workLogEntries) {
    if (
      entry.turnId === null ||
      entry.turnId === undefined ||
      !historicalTurnIds.has(entry.turnId)
    ) {
      continue;
    }
    const existing = entriesByTurnId.get(entry.turnId);
    if (existing) {
      existing.push(entry);
    } else {
      entriesByTurnId.set(entry.turnId, [entry]);
    }
  }
  const subagentsByTurnId = new Map<TurnId, WorkLogEntry[]>();
  for (const entry of deriveSubagentWorkEntries(input.activities, undefined, {
    terminalTurnIds: knownHistoricalTurnIds,
    runtimeSession: input.runtimeSession,
  })) {
    if (
      entry.turnId === null ||
      entry.turnId === undefined ||
      !historicalTurnIds.has(entry.turnId)
    ) {
      continue;
    }
    const existing = subagentsByTurnId.get(entry.turnId);
    if (existing) existing.push(entry);
    else subagentsByTurnId.set(entry.turnId, [entry]);
  }

  const summaries = new Map<TurnId, HistoricalWorkLogSummary>();
  for (const turnId of historicalTurnIds) {
    const entries = entriesByTurnId.get(turnId) ?? [];
    summaries.set(turnId, {
      turnId,
      isHistoricalTurn: latestTurnId !== null,
      previewEntries: entries.slice(-6),
      snapshotEntryCount: entries.length,
      subagentEntries: subagentsByTurnId.get(turnId) ?? [],
    });
  }
  if (latestTurnId !== null && input.activities.length >= THREAD_DETAIL_ACTIVITY_WINDOW_LIMIT) {
    // Retention exceptions (configuration, plans and child lifecycle heads)
    // can be much older than the actual live window. Use the canonical raw
    // tail's floor, not the first exceptional record, or it would hide the
    // very commands whose retained messages still need a history entry point.
    const ordinaryTail = [...input.activities]
      .toSorted(compareActivityWindowOrder)
      .slice(-THREAD_DETAIL_ACTIVITY_WINDOW_LIMIT);
    const floor = ordinaryTail[0];
    if (floor) {
      const retainedBeforeFloor = new Set<string>(
        input.activities
          .filter((activity) => compareActivityWindowOrder(activity, floor) < 0)
          .map((activity) => activity.id),
      );
      // Configuration, recovery and live-work retention can keep ordinary
      // entries older than the raw floor inline. They cannot also prove that
      // Earlier work exists: the reader intentionally removes those duplicates.
      // Send only already-visible identities, within the finite query ceiling;
      // unlisted activity remains eligible rather than hiding unproven history.
      const excludeActivityIds = workLogEntries
        .filter((entry) => entry.turnId === latestTurnId && retainedBeforeFloor.has(entry.id))
        .map((entry) => EventId.make(entry.id))
        .slice(0, THREAD_TURN_ACTIVITY_PAGE_MAX_LIMIT);
      const activityById = new Map<string, OrchestrationThreadActivity>(
        input.activities.map((activity) => [activity.id, activity]),
      );
      const operations = new Map<string, WorkLogOperationIdentity>();
      for (const entry of workLogEntries) {
        if (entry.turnId !== latestTurnId) continue;
        const activity = activityById.get(entry.id);
        const operation = activity && readWorkLogOperationIdentity(activity);
        if (operation) operations.set(JSON.stringify([operation.kind, operation.id]), operation);
      }
      // Stable ordering ignores snapshot receipt ids, operation reordering and
      // context-only churn. A newly inline/evicted operation changes the exact
      // exclusion witness, including previously cached positive presence.
      const excludeOperations = [...operations]
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .slice(0, THREAD_TURN_ACTIVITY_PAGE_MAX_LIMIT)
        .map(([, operation]) => operation);
      summaries.set(latestTurnId, {
        turnId: latestTurnId,
        isHistoricalTurn: false,
        previewEntries: [],
        snapshotEntryCount: 0,
        before: {
          sequence: floor.sequence ?? null,
          createdAt: floor.createdAt,
          activityId: floor.id,
        },
        liveActivities: input.activities.filter((activity) => activity.turnId === latestTurnId),
        ...(excludeActivityIds.length > 0 ? { excludeActivityIds } : {}),
        ...(excludeOperations.length > 0 ? { excludeOperations } : {}),
        ...(workLogEntries.some(
          (entry) => entry.turnId === latestTurnId && entry.turnConfiguration?.provider === "codex",
        )
          ? { excludeTurnStartAck: true }
          : {}),
        // An empty current window stays the same through arbitrarily many
        // context-only updates. Losing its first ordinary operation, however,
        // is new evidence that an earlier command might now be available.
        presenceRevision: deriveWorkLogEntries(ordinaryTail, latestTurnId)[0]?.id ?? "empty",
      });
    }
  }
  return summaries;
}

function isRetryableSteerDeliveryActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "provider.turn.steer.failed") {
    return false;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return payload?.retryableFollowUp === true;
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function isContextCompactionActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return payload?.itemType === "context_compaction" || activity.kind === "context-compaction";
}

function isUserVisibleTaskStartedActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  // The Codex TUI gives an in-progress guardian review visible status while
  // keeping ordinary internal task starts out of conversation history. Cafe's
  // work log follows the same distinction instead of hiding the review until
  // its terminal notification arrives.
  return (
    payload?.taskType === "approval-review" ||
    (payload?.subagent !== null && typeof payload?.subagent === "object")
  );
}

function toDerivedWorkLogEntry(
  activity: OrchestrationThreadActivity,
  turnConfiguration?: ProviderTurnConfiguration,
  /** Accepted settings of the activity's own turn, when that record is loaded. */
  turnSettings?: ProviderTurnConfiguration,
): DerivedWorkLogEntry {
  const deliveryLabel = codexSteerDeliveryWorkLogLabel(activity.kind);
  if (deliveryLabel) {
    // Delivery observations contain only the fixed public phase. In particular,
    // don't let generic tool/detail extraction copy inputs, IDs, or raw provider
    // content from the receipt into a collapsed row, tooltip or diagnostic copy.
    return {
      id: activity.id,
      turnId: activity.turnId,
      createdAt: activity.createdAt,
      ...deliveryLabel,
      tone: "info",
      activityKind: activity.kind,
    };
  }
  const providerDiagnostic = deriveProviderDiagnosticWorkLogRecord(activity);
  if (providerDiagnostic) {
    // Diagnostic rows are not roster lifecycle rows. Keep only bounded public
    // identity/status here: raw provider messages/JSON must not enter ordinary
    // preview, tooltip, path extraction, or renderer debug snapshot surfaces.
    const diagnosticEchoKey = providerDiagnosticEchoKey(activity);
    const daybreak =
      providerDiagnostic.category === "cyber-policy" && turnSettings?.provider === "codex"
        ? turnSettings.daybreak
        : undefined;
    const record =
      daybreak === undefined
        ? providerDiagnostic
        : { ...providerDiagnostic, turnDaybreak: daybreak };
    return {
      id: activity.id,
      turnId: activity.turnId,
      createdAt: activity.createdAt,
      label: providerDiagnosticWorkLogLabel(record),
      tone: record.summary.status === "error" ? "error" : "info",
      activityKind: activity.kind,
      providerDiagnostic: record,
      ...(diagnosticEchoKey !== null ? { diagnosticEchoKey } : {}),
    };
  }
  const retryLabel =
    activity.kind === "runtime.warning"
      ? (codexRecoveryWorkLogLabel(activity) ?? nativeRetryWorkLogLabel(activity.payload))
      : null;
  if (retryLabel) {
    // Admit retry metadata before generic tool/detail extraction. Native JSON
    // is neither a display preview nor a callback/stringification surface for
    // these fixed operational rows, and prose fractions never become totals.
    return {
      id: activity.id,
      turnId: activity.turnId,
      createdAt: activity.createdAt,
      label: retryLabel,
      tone: "info",
      activityKind: activity.kind,
    };
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const compaction = isContextCompactionActivity(activity);
  // Native titles are often identical at start and completion. The tool row
  // must communicate the lifecycle outcome, including a failed compaction.
  const title = compaction
    ? activity.kind === "tool.started"
      ? "Compacting context"
      : activity.summary
    : extractToolTitle(payload);
  const isTaskActivity = activity.kind === "task.progress" || activity.kind === "task.completed";
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const displayLabel = !taskLabel ? cafeWorkLogDisplayLabel(activity) : undefined;
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : extractActivityDetail(activity.kind, payload, title ?? activity.summary);
  const toolCallId =
    readWorkLogOperationIdentity(activity)?.id ??
    (isTaskActivity ? null : extractToolCallId(payload));
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    turnId: activity.turnId,
    createdAt: activity.createdAt,
    label: taskLabel ?? activity.summary,
    ...(displayLabel !== undefined ? { displayLabel } : {}),
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
    ...((activity.kind === "tool.completed" || activity.kind === "task.completed") &&
    Number.isFinite(Date.parse(activity.createdAt))
      ? { operationCompletedAt: activity.createdAt }
      : {}),
    ...(payload?.status === "inProgress" ||
    payload?.status === "completed" ||
    payload?.status === "failed"
      ? { operationStatus: payload.status }
      : payload?.status === "stopped" && toolCallId && isTaskActivity
        ? { operationStatus: "failed" as const }
        : {}),
  };
  const publicSummary =
    activity.kind === "reasoning.summary" ? readProviderPublicSummary(payload) : undefined;
  if (publicSummary) {
    // The plain label stays canonical English for transcript copy/search.
    if (publicSummary.provider === "opencode") {
      entry.label = "OpenCode thinking";
      entry.displayLabel = uiText("OpenCode thinking");
    } else {
      entry.label = "Claude summary";
      entry.displayLabel = uiText("Claude summary");
    }
    entry.tone = "info";
    entry.publicSummary = publicSummary;
    entry.detail = publicSummary.text;
    const summaryItemId = readWorkLogOperationIdentity(activity)?.id;
    if (summaryItemId) entry.toolCallId = summaryItemId;
  }
  const commandInspection = readClaudeCommandInspection(payload);
  if (commandInspection) {
    entry.commandInspection = {
      ...commandInspection,
      ...(activity.kind === "tool.started" &&
      !commandInspection.startedAt &&
      Number.isFinite(Date.parse(activity.createdAt))
        ? { startedAt: activity.createdAt, status: "inProgress" as const }
        : {}),
      ...(activity.kind === "tool.completed" &&
      !commandInspection.completedAt &&
      Number.isFinite(Date.parse(activity.createdAt))
        ? { completedAt: activity.createdAt }
        : {}),
    };
    // The admitted inspector and generic history reader use the same native
    // operation identity, including explicit ACP tool identities when present.
    const commandItemId = readWorkLogOperationIdentity(activity)?.id;
    if (commandItemId) entry.toolCallId = commandItemId;
  }
  if (turnConfiguration) {
    const presentation = presentTurnConfiguration(turnConfiguration);
    // The plain label remains useful for transcript copy/search consumers; the
    // row renderer uses the same frozen object to show the two compact lines.
    entry.label = `Turn accepted · ${presentation.settings}`;
    entry.displayLabel = uiText("Turn accepted · {settings}", { settings: presentation.settings });
    entry.detail = `${presentation.account} · ${presentation.modes} · ${presentation.source}`;
    entry.turnConfiguration = turnConfiguration;
  }
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  if (detail && !turnConfiguration && !publicSummary) {
    entry.detail = detail;
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) entry.toolTitle = title;
  if (itemType === "web_search") {
    const nativeToolName = asRecord(payload?.data)?.nativeToolName;
    if (nativeToolName === "web_search") entry.displayToolTitle = uiText("Searched the web");
    else if (nativeToolName === "fetch_url") entry.displayToolTitle = uiText("Opened web page");
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (toolCallId && !publicSummary && !commandInspection) {
    entry.toolCallId = toolCallId;
  }
  if (commandInspection) {
    // Copy/search and path presentation use the same admitted strings as the
    // disclosure, not an unsanitized legacy detail fallback.
    delete entry.command;
    delete entry.detail;
    if (commandInspection.command) entry.command = commandInspection.command;
    if (commandInspection.description) entry.detail = commandInspection.description;
    delete entry.rawCommand;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

/**
 * Snapshots update one primary block/tool in place, even if another operation
 * has appeared between updates. Preserve its initial chronological position
 * and stable row key so live/replayed history never reorders or resets an open
 * detail disclosure. Identity includes the turn; native block ids can repeat.
 */
function foldClaudeOperationSnapshots(entries: DerivedWorkLogEntry[]): DerivedWorkLogEntry[] {
  const folded: DerivedWorkLogEntry[] = [];
  const positions = new Map<string, number>();
  const commandKey = (entry: DerivedWorkLogEntry) =>
    entry.turnId && entry.toolCallId
      ? JSON.stringify([entry.turnId, "command", entry.toolCallId])
      : undefined;
  // Older background edges omitted the inspection marker. Only an admitted
  // command in this bounded input can supply its disclosure; native identity
  // can join lifecycle metadata but never promote arbitrary legacy tool JSON.
  const inspectedCommands = new Set(
    entries.filter((entry) => entry.commandInspection).map(commandKey),
  );
  for (const entry of entries) {
    const keyForCommand = commandKey(entry);
    const isCommandLifecycle =
      keyForCommand !== undefined &&
      inspectedCommands.has(keyForCommand) &&
      (isCollapsibleToolLifecycleActivity(entry.activityKind) ||
        entry.activityKind === "task.progress" ||
        entry.activityKind === "task.completed");
    const kind = entry.publicSummary ? "summary" : isCommandLifecycle ? "command" : null;
    if (!kind || !entry.toolCallId || !entry.turnId) {
      folded.push(entry);
      continue;
    }
    // Provider-native block ids are not a shared namespace. In particular an
    // OpenCode thinking replay must never replace a Claude public block merely
    // because their turn and native item labels happen to match.
    const key = JSON.stringify(
      kind === "summary"
        ? [entry.turnId, kind, entry.publicSummary?.provider, entry.toolCallId]
        : [entry.turnId, kind, entry.toolCallId],
    );
    const position = positions.get(key);
    const previous = position === undefined ? undefined : folded[position];
    if (!previous || position === undefined) {
      positions.set(key, folded.length);
      folded.push(entry);
      continue;
    }
    // A delayed replay/update cannot revive an already terminal operation.
    // Summary completion may have a same-status proven snapshot repair, but
    // an ordinary tool's authoritative completion is its final disclosure.
    if (kind === "command") {
      // Bash can return a successful background-start receipt before the
      // associated native task finishes. Its exact task outcome still belongs
      // to this command; ordinary delayed tool updates cannot reopen it.
      const taskCompletion =
        entry.activityKind === "task.completed" && previous.activityKind !== "task.completed";
      if (
        previous.commandInspection &&
        ((isCommandCompletion(previous) && !taskCompletion) ||
          entry.activityKind === "task.progress")
      )
        continue;
      const merged =
        entry.commandInspection || !previous.commandInspection
          ? mergeDerivedWorkLogEntries(previous, entry)
          : { ...previous, activityKind: entry.activityKind };
      const terminal = taskCompletion
        ? entry
        : isCommandCompletion(previous)
          ? previous
          : isCommandCompletion(entry)
            ? entry
            : undefined;
      const status =
        isCommandCompletion(previous) && previous.operationStatus === "failed"
          ? "failed"
          : (terminal?.operationStatus ?? entry.operationStatus ?? previous.operationStatus);
      if (merged.commandInspection) {
        merged.commandInspection = {
          ...merged.commandInspection,
          ...(status ? { status } : {}),
          ...(terminal?.operationCompletedAt &&
          (taskCompletion || !merged.commandInspection.completedAt)
            ? { completedAt: terminal.operationCompletedAt }
            : {}),
        };
        // Generic task summaries and legacy output never replace the admitted
        // description, command or output, including copy/search presentation.
        delete merged.detail;
        delete merged.command;
        delete merged.rawCommand;
        if (merged.commandInspection.description)
          merged.detail = merged.commandInspection.description;
        if (merged.commandInspection.command) merged.command = merged.commandInspection.command;
      }
      folded[position] = {
        ...merged,
        ...(terminal ? { activityKind: terminal.activityKind } : {}),
        ...(terminal?.operationCompletedAt
          ? { operationCompletedAt: terminal.operationCompletedAt }
          : {}),
        ...(status ? { operationStatus: status } : {}),
        id: previous.id,
        createdAt: previous.createdAt,
      };
      continue;
    }
    const previousSummaryStatus = previous.publicSummary?.status;
    if (
      (previousSummaryStatus === "completed" || previousSummaryStatus === "failed") &&
      entry.publicSummary?.status !== previousSummaryStatus
    )
      continue;
    const merged = mergeDerivedWorkLogEntries(previous, entry);
    folded[position] = { ...merged, id: previous.id, createdAt: previous.createdAt };
  }
  return folded;
}

function isCommandCompletion(entry: DerivedWorkLogEntry): boolean {
  return entry.activityKind === "tool.completed" || entry.activityKind === "task.completed";
}

function providerDiagnosticSubjectKey(entry: DerivedWorkLogEntry): string | null {
  const diagnostic = entry.providerDiagnostic;
  if (!diagnostic) return null;
  const subject = diagnostic.summary.subject;
  return JSON.stringify([entry.turnId ?? null, subject.kind, subject.id ?? null]);
}

/**
 * Presentation-only folding of provider diagnostic rows, applied to adjacent
 * rows of one turn and one agent:
 * - Consecutive reconnect observations keep only the newest row; its count
 *   already carries the observed lower bound.
 * - A reconnect run that ends in an error becomes part of that error row
 *   ("… after 5 reconnects"), since the error is the outcome the person needs.
 * - An error row whose content-free echo witness equals an earlier error row
 *   in the same turn is the same failure recorded twice by an older build.
 * Every activity and private copy stays persisted; nothing here changes
 * lifecycle, retry or recovery state.
 */
function foldProviderDiagnosticEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const folded: DerivedWorkLogEntry[] = [];
  const echoKeysByTurn = new Map<string, Set<string>>();
  for (const entry of entries) {
    const diagnostic = entry.providerDiagnostic;
    if (diagnostic?.summary.status === "error" && entry.diagnosticEchoKey) {
      const turnKey = String(entry.turnId ?? "");
      const seen = echoKeysByTurn.get(turnKey) ?? new Set<string>();
      if (seen.has(entry.diagnosticEchoKey)) continue;
      seen.add(entry.diagnosticEchoKey);
      echoKeysByTurn.set(turnKey, seen);
    }
    const previous = folded.at(-1);
    const subjectKey = providerDiagnosticSubjectKey(entry);
    if (
      previous?.providerDiagnostic?.summary.status === "retry" &&
      diagnostic &&
      subjectKey !== null &&
      providerDiagnosticSubjectKey(previous) === subjectKey
    ) {
      const retry = previous.providerDiagnostic.summary;
      if (diagnostic.summary.status === "retry") {
        // Counts are per-target lower bounds; keep the larger one if a newer
        // row arrives without its own count.
        const replacement =
          diagnostic.summary.observedRetryCount === undefined &&
          retry.observedRetryCount !== undefined
            ? {
                ...entry,
                providerDiagnostic: {
                  ...diagnostic,
                  summary: {
                    ...diagnostic.summary,
                    observedRetryCount: retry.observedRetryCount,
                    ...(retry.countLimited ? { countLimited: true as const } : {}),
                  },
                },
              }
            : entry;
        folded[folded.length - 1] = {
          ...replacement,
          label: providerDiagnosticWorkLogLabel(replacement.providerDiagnostic!),
        };
        continue;
      }
      if (retry.observedRetryCount !== undefined) {
        const withRetries = {
          ...diagnostic,
          retriesBefore: {
            count: retry.observedRetryCount,
            countLimited: retry.countLimited === true,
          },
        };
        folded[folded.length - 1] = {
          ...entry,
          label: providerDiagnosticWorkLogLabel(withRetries),
          providerDiagnostic: withRetries,
        };
        continue;
      }
    }
    folded.push(entry);
  }
  return folded;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  for (const entry of entries) {
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      collapsed[collapsed.length - 1] = mergeDerivedWorkLogEntries(previous, entry);
      continue;
    }
    collapsed.push(entry);
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (!isCollapsibleToolLifecycleActivity(previous.activityKind)) {
    return false;
  }
  if (!isCollapsibleToolLifecycleActivity(next.activityKind)) {
    return false;
  }
  if (previous.turnId !== next.turnId) {
    return false;
  }
  if (previous.activityKind === "tool.completed") {
    return false;
  }
  if (previous.collapseKey !== undefined && previous.collapseKey === next.collapseKey) {
    return true;
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
}

function isCollapsibleToolLifecycleActivity(activityKind: OrchestrationThreadActivity["kind"]) {
  return (
    activityKind === "tool.started" ||
    activityKind === "tool.updated" ||
    activityKind === "tool.completed"
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const {
    displayLabel: _previousDisplayLabel,
    displayToolTitle: previousDisplayToolTitle,
    ...previousCanonical
  } = previous;
  const displayToolTitle =
    next.displayToolTitle ??
    (toolTitle === previous.toolTitle ? previousDisplayToolTitle : undefined);
  return {
    ...previousCanonical,
    ...next,
    ...(displayToolTitle !== undefined ? { displayToolTitle } : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(previous.commandInspection && next.commandInspection
      ? {
          commandInspection: mergeClaudeCommandInspections(
            previous.commandInspection,
            next.commandInspection,
          ),
        }
      : {}),
  };
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  if (!isCollapsibleToolLifecycleActivity(entry.activityKind)) {
    return undefined;
  }
  if (entry.toolCallId) {
    return `tool:${entry.toolCallId}`;
  }
  // Older saved compaction items may lack an item id. Their changing status
  // label must not prevent adjacent start/completion edges from collapsing.
  if (entry.itemType === "context_compaction") return "context_compaction";
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeJsonPreview(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    return asTrimmedString(value);
  }
  try {
    return asTrimmedString(JSON.stringify(value));
  } catch {
    return null;
  }
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function formatCommandArrayPart(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== null);
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(" ");
}

function normalizeCommandValue(value: unknown): string | null {
  const formatted = formatCommandValue(value);
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null;
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null {
  const formatted = formatCommandValue(value);
  if (!formatted || normalizedCommand === null) {
    return null;
  }
  return formatted === normalizedCommand ? null : formatted;
}

function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    itemType === "command_execution" && detail ? stripTrailingExitCode(detail).output : null,
  ];

  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      continue;
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    };
  }

  return {
    command: null,
    rawCommand: null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(data?.toolCallId);
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePreviewForComparison(value: string | null | undefined): string | null {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return null;
  }
  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase();
}

function summarizeToolTextOutput(value: string): string | null {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => normalizeInlinePreview(line))
    .filter((line) => line.length > 0);
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return truncateInlinePreview(firstLine);
  }
  if (lines.length > 1) {
    return uiText("{count, plural, one {{formatted} line} other {{formatted} lines}}", {
      count: lines.length,
      formatted: uiFormatNumber(lines.length),
    });
  }
  return null;
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  if (!rawOutput) {
    return null;
  }

  const totalFiles = asNumber(rawOutput.totalFiles);
  if (totalFiles !== null) {
    const suffix = rawOutput.truncated === true ? "+" : "";
    return uiText("{count, plural, one {{formatted} file} other {{formatted} files}}{suffix}", {
      count: totalFiles,
      formatted: uiFormatNumber(totalFiles),
      suffix,
    });
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    return summarizeToolTextOutput(content);
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    return summarizeToolTextOutput(stdout);
  }

  return null;
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean {
  const data = asRecord(payload?.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase();
  return (
    extractWorkLogItemType(payload) === "command_execution" ||
    kind === "execute" ||
    title === "terminal" ||
    title === "ran command"
  );
}

function extractPersistedWebSearchQuery(payload: Record<string, unknown> | null): string | null {
  if (extractWorkLogItemType(payload) !== "web_search") {
    return null;
  }
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const action = asRecord(item?.action);
  const rawInput = asRecord(data?.rawInput);
  const rawOutput = asRecord(data?.rawOutput);
  const rawOutputAction = asRecord(rawOutput?.action);
  const nestedToolInput = asRecord(rawInput?.tool_input);
  const query =
    asTrimmedString(item?.query) ??
    asTrimmedString(action?.query) ??
    asTrimmedString(rawInput?.query) ??
    asTrimmedString(rawInput?.pattern) ??
    asTrimmedString(rawInput?.searchTerm) ??
    asTrimmedString(rawInput?.url) ??
    asTrimmedString(nestedToolInput?.query) ??
    asTrimmedString(nestedToolInput?.pattern) ??
    asTrimmedString(nestedToolInput?.searchTerm) ??
    asTrimmedString(rawOutputAction?.query);
  return summarizeToolArguments(query) ?? null;
}

function extractPersistedToolInvocationDetail(
  payload: Record<string, unknown> | null,
): string | null {
  const itemType = extractWorkLogItemType(payload);
  if (itemType !== "mcp_tool_call" && itemType !== "dynamic_tool_call") {
    return null;
  }
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  if (item) {
    const itemKind = asTrimmedString(item.type);
    if (itemKind === "mcpToolCall" || itemKind === "dynamicToolCall") {
      const namespace = asTrimmedString(itemKind === "mcpToolCall" ? item.server : item.namespace);
      const tool = asTrimmedString(item.tool);
      const toolName = truncateInlinePreview(
        normalizeInlinePreview([namespace, tool].filter(Boolean).join(".")),
        160,
      );
      const argumentsPreview = summarizeToolArguments(item.arguments);
      if (toolName && argumentsPreview) {
        return `${toolName}: ${argumentsPreview}`;
      }
      return toolName || argumentsPreview || null;
    }
  }

  const rawInput = asRecord(data?.rawInput);
  return summarizeToolArguments(rawInput?.tool_input) ?? null;
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedHeading = normalizePreviewForComparison(heading);
  const normalizedDetail = normalizePreviewForComparison(detail);

  if (detail && normalizedHeading !== normalizedDetail) {
    return detail;
  }

  if (isCommandToolDetail(payload, heading)) {
    return null;
  }

  // Older persisted Codex activities predate the adapter's canonical `detail`
  // mapping but retain the original webSearch item under `data`.
  const persistedWebSearchQuery = extractPersistedWebSearchQuery(payload);
  if (persistedWebSearchQuery) {
    return persistedWebSearchQuery;
  }

  // Retained Codex and ACP activities can predate the provider-side detail
  // mapping. Recover only bounded/redacted invocation metadata here so old
  // rows improve without replaying or rewriting the durable event store.
  const persistedToolInvocationDetail = extractPersistedToolInvocationDetail(payload);
  if (persistedToolInvocationDetail) {
    return persistedToolInvocationDetail;
  }

  const rawOutputSummary = summarizeToolRawOutput(payload);
  if (rawOutputSummary) {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary);
    if (normalizedRawOutputSummary !== normalizedHeading) {
      return rawOutputSummary;
    }
  }

  return null;
}

function extractActivityDetail(
  activityKind: OrchestrationThreadActivity["kind"],
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  if (activityKind === "runtime.warning" || activityKind === "runtime.error") {
    const message = asTrimmedString(payload?.message);
    const detail = safeJsonPreview(payload?.detail);
    const normalizedMessage = normalizePreviewForComparison(message);
    const normalizedDetail = normalizePreviewForComparison(detail);
    if (message && detail && normalizedMessage !== normalizedDetail) {
      return `${message}\n${detail}`;
    }
    return message ?? detail;
  }

  return extractToolDetail(payload, heading);
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "terminal-input" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || isTruncatedPathCandidate(normalized) || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function isTruncatedPathCandidate(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.includes("…") || normalized.includes("[truncated]") || normalized.includes("...")
  );
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string") {
        pushChangedFile(target, seen, entry);
        if (target.length >= 12) {
          return;
        }
        continue;
      }
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.file_path);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.relative_path);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.new_path);
  pushChangedFile(target, seen, record.oldPath);
  pushChangedFile(target, seen, record.old_path);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
    "changedFiles",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  if (itemType !== "file_change" && requestKind !== "file-change") {
    return [];
  }
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  // Match the SQLite/retention total order independently of the viewer's
  // locale. Lifecycle rank applies only at a genuine sequence/clock tie; it
  // cannot override a newer owner observation or a known sequence boundary.
  if (left.sequence !== right.sequence || left.createdAt !== right.createdAt) {
    return compareActivityWindowOrder(left, right);
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return compareActivityWindowOrder(left, right);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}

/**
 * Only the server's completed MCP-handling activity enters this display
 * contract. Requested/failed operations and native user-input envelopes never
 * become completion receipts just because their payload mentions MCP. The
 * backend establishes provenance and native acceptance; this reader only
 * refuses unsupported presentation versions and copies finite public fields.
 */
function readMcpQuestionResolution(
  payload: unknown,
): Pick<
  Extract<TimelineEntry, { kind: "question-resolution" }>,
  "action" | "questionCount" | "items"
> | null {
  // Projections arrive as JSON. Copy only own data descriptors into fresh
  // inert objects before encoding the finite receipt or rendering exact text.
  // Unknown native fields, accessors and a payload's toJSON are never invoked.
  const own = (value: unknown, key: string): unknown => {
    if (value === null || typeof value !== "object") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const array = (value: unknown, limit: number): unknown[] | null => {
    if (!Array.isArray(value)) return null;
    const length = own(value, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > limit)
      return null;
    const result: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return null;
      result.push(descriptor.value);
    }
    return result;
  };
  const text = (value: unknown, limit: number): value is string =>
    typeof value === "string" && value.length <= limit && value.trim().length > 0;
  try {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    const version = own(payload, "version");
    if ((version !== 1 && version !== 2) || own(payload, "source") !== "mcp") return null;
    const action = own(payload, "action");
    const questionCount = own(payload, "questionCount");
    if (
      (action !== "answered" && action !== "skipped" && action !== "cleared") ||
      typeof questionCount !== "number" ||
      !Number.isSafeInteger(questionCount) ||
      questionCount < 1 ||
      questionCount > 64
    )
      return null;
    if (version === 1) return { action, questionCount, items: null };
    const rawItems = array(own(payload, "items"), 64);
    if (rawItems === null || rawItems.length !== questionCount) return null;
    const items: McpQuestionResolutionItem[] = [];
    const seenIds = new Set<string>();
    let chars = 0;
    for (const raw of rawItems) {
      const rawQuestion = own(raw, "question");
      const id = own(rawQuestion, "id");
      const header = own(rawQuestion, "header");
      const questionText = own(rawQuestion, "question");
      if (
        !text(id, 16_384) ||
        typeof header !== "string" ||
        header.length > 65_536 ||
        !text(questionText, 65_536) ||
        seenIds.has(id)
      )
        return null;
      seenIds.add(id);
      const question = { id, header, question: questionText };
      chars += id.length + header.length + questionText.length;
      const rawAnswer = own(raw, "answer");
      const disposition = own(raw, "disposition");
      if (action === "answered") {
        if (disposition !== undefined) return null;
        let answer: string | readonly string[];
        if (typeof rawAnswer === "string") {
          if (!text(rawAnswer, PROVIDER_SEND_TURN_MAX_INPUT_CHARS)) return null;
          answer = rawAnswer;
          chars += answer.length;
        } else {
          const values = array(rawAnswer, 64);
          if (
            values === null ||
            values.length === 0 ||
            values.some((value) => !text(value, PROVIDER_SEND_TURN_MAX_INPUT_CHARS))
          )
            return null;
          const selected = values as string[];
          if (new Set(selected).size !== selected.length) return null;
          answer = selected;
          chars += selected.reduce((total, value) => total + value.length, 0);
        }
        items.push({ question, answer });
      } else {
        const expectedDisposition = action === "skipped" ? "skipped" : "dismissed";
        if (rawAnswer !== undefined || disposition !== expectedDisposition) return null;
        items.push({ question, disposition: expectedDisposition });
      }
      // Reject cheaply before allocating encoded copies. This is an aggregate
      // character pre-bound, followed by the actual UTF-8 receipt limit below.
      if (chars > 1_048_576) return null;
    }
    const encoder = new TextEncoder();
    if (
      encoder.encode(JSON.stringify({ version: 2, source: "mcp", action, questionCount, items }))
        .byteLength > 1_048_576
    )
      return null;
    return { action, questionCount, items };
  } catch {
    return null;
  }
}

export function deriveTimelineEntries(
  messages: ChatMessage[],
  proposedPlans: ProposedPlan[],
  workEntries: WorkLogEntry[],
  visualizations: readonly VisualizationTimelineEntry[] = [],
  retainedActivities: ReadonlyArray<OrchestrationThreadActivity> = [],
): TimelineEntry[] {
  const messageRows: TimelineEntry[] = messages.map((message) => ({
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  }));
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  // Public Claude summaries are conversation prose, not a completed root
  // response. Reuse the existing strict disclosure/folding path so neither
  // raw thinking nor arbitrary activity detail can enter the primary chat.
  // The bounded snapshot also contains prior turns: replay their known public
  // summaries without a database rewrite or an unbounded history fetch.
  const summaryEntries = deriveWorkLogEntries(
    retainedActivities.filter((activity) => activity.kind === "reasoning.summary"),
    undefined,
  );
  const summaries = new Map<string, Extract<TimelineEntry, { kind: "provider-summary" }>>();
  for (const entry of [...summaryEntries, ...workEntries]) {
    const operationKey = primaryClaudeSummaryKey(entry);
    if (!operationKey || !entry.turnId || !entry.publicSummary || summaries.has(operationKey))
      continue;
    summaries.set(operationKey, {
      id: `provider-summary:${operationKey}`,
      kind: "provider-summary",
      createdAt: entry.createdAt,
      turnId: entry.turnId,
      operationKey,
      summary: entry.publicSummary,
    });
  }
  const placedSummaries = new Set<string>();
  const workRows = workEntries.flatMap<TimelineEntry>((entry) => {
    const operationKey = primaryClaudeSummaryKey(entry);
    if (!operationKey)
      return [{ id: entry.id, kind: "work" as const, createdAt: entry.createdAt, entry }];
    const summary = summaries.get(operationKey);
    if (!summary || placedSummaries.has(operationKey)) return [];
    placedSummaries.add(operationKey);
    // Keep an interleaved command's existing position even when its clock
    // equals this block's first receipt. Later text snapshots never move it.
    return [summary];
  });
  const visualizationRows: TimelineEntry[] = visualizations.map((visualization) => ({
    id: `visualization:${visualizationEntryIdentity(visualization)}`,
    kind: "visualization",
    createdAt: visualization.occurredAt,
    visualization,
  }));
  const resolutionActivities = new Map<string, OrchestrationThreadActivity>();
  for (const activity of retainedActivities
    .filter((entry) => entry.kind === "mcp.question.resolved")
    .toSorted(compareActivitiesByOrder)) {
    // The same immutable activity can be present in both the ordinary tail and
    // the retained-notice window. It represents one visible handling receipt.
    resolutionActivities.set(activity.id, activity);
  }
  const resolutionRows = [...resolutionActivities.values()].flatMap<TimelineEntry>((activity) => {
    const resolution = readMcpQuestionResolution(activity.payload);
    return resolution
      ? [
          {
            id: `question-resolution:${activity.id}`,
            kind: "question-resolution",
            createdAt: activity.createdAt,
            turnId: activity.turnId,
            ...resolution,
          },
        ]
      : [];
  });
  return [
    ...messageRows,
    ...proposedPlanRows,
    ...workRows,
    ...[...summaries.values()].filter((summary) => !placedSummaries.has(summary.operationKey)),
    ...visualizationRows,
    ...resolutionRows,
  ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function deriveCompletionDividerBeforeEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  if (latestTurn.assistantMessageId) {
    const exactMatch = timelineEntries.find(
      (timelineEntry) =>
        timelineEntry.kind === "message" &&
        timelineEntry.message.role === "assistant" &&
        timelineEntry.message.id === latestTurn.assistantMessageId,
    );
    if (exactMatch) {
      return exactMatch.id;
    }
  }

  const turnStartedAt = Date.parse(latestTurn.startedAt);
  const turnCompletedAt = Date.parse(latestTurn.completedAt);
  if (Number.isNaN(turnStartedAt) || Number.isNaN(turnCompletedAt)) {
    return null;
  }

  let inRangeMatch: string | null = null;
  let fallbackMatch: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (timelineEntry.kind !== "message" || timelineEntry.message.role !== "assistant") {
      continue;
    }
    const messageAt = Date.parse(timelineEntry.message.createdAt);
    if (Number.isNaN(messageAt) || messageAt < turnStartedAt) {
      continue;
    }
    fallbackMatch = timelineEntry.id;
    if (messageAt <= turnCompletedAt) {
      inRangeMatch = timelineEntry.id;
    }
  }
  return inRangeMatch ?? fallbackMatch;
}

export function deriveCompletionDividerAfterEntryId(
  timelineEntries: ReadonlyArray<TimelineEntry>,
  latestTurn: Pick<
    OrchestrationLatestTurn,
    "turnId" | "assistantMessageId" | "startedAt" | "completedAt"
  > | null,
): string | null {
  if (!latestTurn?.startedAt || !latestTurn.completedAt) {
    return null;
  }

  let latestSameTurnEntryId: string | null = null;
  for (const timelineEntry of timelineEntries) {
    if (
      (timelineEntry.kind === "message" && timelineEntry.message.turnId === latestTurn.turnId) ||
      (timelineEntry.kind === "work" && timelineEntry.entry.turnId === latestTurn.turnId) ||
      (timelineEntry.kind === "provider-summary" && timelineEntry.turnId === latestTurn.turnId) ||
      (timelineEntry.kind === "visualization" &&
        timelineEntry.visualization.turnId === latestTurn.turnId) ||
      (timelineEntry.kind === "proposed-plan" &&
        timelineEntry.proposedPlan.turnId === latestTurn.turnId)
    ) {
      latestSameTurnEntryId = timelineEntry.id;
    }
  }
  if (latestSameTurnEntryId !== null) {
    return latestSameTurnEntryId;
  }

  return deriveCompletionDividerBeforeEntryId(timelineEntries, latestTurn);
}

export function inferCheckpointTurnCountByTurnId(
  summaries: TurnDiffSummary[],
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (!session || session.status === "closed") return "disconnected";
  if (session.status === "connecting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
