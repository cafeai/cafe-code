/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";

import {
  deleteSession,
  forkSession,
  getSessionMessages,
  getSubagentMessages,
  listSubagents,
  type ForkSessionOptions,
  type ForkSessionResult,
  type CanUseTool,
  type OnElicitation,
  type FastModeDisabledReason,
  type FastModeState,
  type SDKControlInterruptResponse,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SettingSource,
  type SDKUserMessage,
  type ModelUsage,
  type SessionStore,
  type SessionStoreEntry,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@cafecode/shared/cliArgs";
import { publicClaudeCommands, UNAVAILABLE_COMMAND_CATALOG } from "../claudeCommands.ts";
import { mapClaudeSessionQuotaReport, stripClaudeUsageReport } from "../claudeSessionQuota.ts";
import { resolveConfiguredSubagentLimit } from "../Drivers/SubagentConcurrency.ts";
import {
  getSafeInteractionUrl,
  normalizeElicitationRequest,
  validateInteractionResponse,
} from "@cafecode/shared/providerInteraction";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ClaudeSettings,
  EventId,
  type ModelSelection,
  type ModelCapabilities,
  type ProviderApprovalDecision,
  type ProviderCommandCatalog,
  type ProviderSessionQuotaReport,
  ProviderDriverKind,
  type ProviderInteractionMode,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionForkResult,
  type ThreadTokenUsageSnapshot,
  type ProviderSteerTurnInput,
  type ProviderTaskControlInput,
  type ProviderUserInputAnswers,
  type ProviderElicitation,
  type RuntimeSessionState,
  type RuntimeMode,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeResourceLink,
  RuntimeTaskId,
  type RuntimeSubagentPresentation,
  type RuntimeTaskVisibility,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@cafecode/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  resolvePromptInjectedEffort,
} from "@cafecode/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  readSchedulingSessionBroker,
  type SchedulingSessionBinding,
} from "../../scheduledFollowups/sessionRuntime.ts";
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import { makeProviderSessionTitle } from "../providerSessionTitle.ts";
import { awaitClaudeDecision } from "../claudeDecision.ts";
import { recoverClaudeResume } from "../claudeResumeRecovery.ts";
import { createObservedClaudeQuery } from "../claudeQueryProcess.ts";
import {
  supportsClaudeTaskControls,
  isClaudeDetachedToolResult,
  admittedClaudeControlIdentity,
} from "../claudeTaskControls.ts";
import {
  readClaudeRewindMessageIds,
  readClaudeRewindSnapshot,
  publishClaudeRewindCandidate,
  remapClaudeRewindMessageIds,
  selectClaudeRewindCutoff,
  type ClaudeRewindMessageIds,
} from "../claudeConversationRewind.ts";
import {
  readClaudeForkMessageIds,
  rememberClaudeForkMessage,
  remapClaudeForkMessageIds,
  type ClaudeForkMessageIds,
} from "../claudeForkMessageIds.ts";
import { readClaudeUsageBaseline } from "../claudeUsageBaseline.ts";
import { prepareFileAttachmentPrompt } from "../fileAttachmentPrompt.ts";
import {
  makeClaudeUsageAccounting,
  configureClaudeUsageVersion,
  observeClaudeAssistantUsage,
  observeClaudeResultUsage,
  type ClaudeUsageAccounting,
  type ClaudeUsageBaseline,
} from "../claudeUsageAccounting.ts";
import {
  getClaudeModelCapabilities,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeSelectedContextWindowTokens,
  resolveClaudeSessionEffort,
} from "./ClaudeProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterRewindOutcomeUnknownError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  makeProviderSubagentDetailReadError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import type { ProviderSubagentDetail } from "../Services/ProviderAdapter.ts";
import {
  canonicalizeProviderSubagentDetail,
  canonicalizeProviderSubagentActivities,
  type ProviderSubagentActivityInput,
} from "../subagentDetail.ts";
import { subagentCommandDetail, subagentFileDetail } from "../subagentActivityDetail.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);

const PROVIDER = ProviderDriverKind.make("claudeAgent");
// SDK 0.3.259 caps merged first-reply/result correlation at 64 prompt UUIDs.
// Bound inspection as well as retention even if a newer/untrusted CLI sends more.
const CLAUDE_PROMPT_CORRELATION_LIMIT = 64;
const CLAUDE_TASK_BINDING_LIMIT = 4_096;
const CLAUDE_HIDDEN_TRANSCRIPT_TASK_LIMIT = 4_096;
const CLAUDE_SUBAGENT_MESSAGE_DEDUPE_LIMIT = 4_096;
const CLAUDE_SUBAGENT_PROGRESS_TEXT_LIMIT = 4_000;
const CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT = 1_000;
const CLAUDE_TASK_SUMMARY_TEXT_LIMIT = 4_000;
const CLAUDE_TASK_TOOL_NAME_TEXT_LIMIT = 256;
const CLAUDE_HOOK_OUTPUT_TEXT_LIMIT = 16_000;
// Claude Agent SDK 0.3.257 preserves MCP resource links in foreground tool
// results and background task notifications. Mirror the upstream count and
// serialized-size ceilings while additionally excluding raw URIs and `_meta`
// annotations from Cafe's durable/runtime surfaces.
const CLAUDE_RESOURCE_LINK_LIMIT = 50;
const CLAUDE_RESOURCE_LINK_INSPECTION_LIMIT = CLAUDE_RESOURCE_LINK_LIMIT * 2;
const CLAUDE_RESOURCE_LINK_SERIALIZED_BYTES_LIMIT = 64 * 1_024;
const CLAUDE_RESOURCE_URI_UTF8_BYTES_LIMIT = 16 * 1_024;
const CLAUDE_RESOURCE_LINK_HASH_DOMAIN = "cafecode/claude/resource-link/v1";
const CLAUDE_RESOURCE_REDACTION_MAX_DEPTH = 32;
const CLAUDE_RESOURCE_LINK_OVERFLOW_OMISSION =
  "[tool result omitted: resource-link metadata exceeded safety limit]";
const CLAUDE_RESOURCE_LINK_OVERFLOW_TASK_SUMMARY =
  "Task summary omitted because resource-link metadata exceeded the safety limit.";
const CLAUDE_SUBAGENT_LABEL_LIMIT = 96;
const CLAUDE_SUBAGENT_OBJECTIVE_LIMIT = 240;
const CLAUDE_SUBAGENT_ROLE_LIMIT = 80;
const CLAUDE_SUBAGENT_MAX_INFERRED_DURATION_MS = 365 * 24 * 60 * 60 * 1_000;
// Claude normally emits short opaque task/tool ids. Bound every retained map
// key to 512 UTF-8 bytes so a compromised or incompatible provider cannot pin
// arbitrarily large strings for the lifetime of a multi-week session. Values
// above the limit are represented by a domain-separated digest of the complete
// id; hashing the full value (instead of truncating a prefix) preserves stable
// lifecycle correlation for hostile ids that differ only near their tails.
const CLAUDE_OPAQUE_ID_MAX_UTF8_BYTES = 512;
const CLAUDE_TASK_ID_HASH_PREFIX = "claude-task-sha256:";
const CLAUDE_TOOL_USE_ID_HASH_PREFIX = "claude-tool-use-sha256:";
const CLAUDE_TASK_ID_HASH_DOMAIN = "cafecode/claude/task-id/v1";
const CLAUDE_TOOL_USE_ID_HASH_DOMAIN = "cafecode/claude/tool-use-id/v1";
// Transcript discovery is deliberately bounded even though the SDK's
// `listSubagents()` result itself has no limit parameter. A hostile provider
// home must not turn one authenticated detail click into thousands of history
// reads. Real Claude sessions are comfortably below this ceiling.
const CLAUDE_SUBAGENT_DISCOVERY_MAX_AGENTS = 256;
const CLAUDE_SUBAGENT_DISCOVERY_MAX_DIRECTORY_ENTRIES = 4_096;
const CLAUDE_SUBAGENT_DISCOVERY_MAX_DEPTH = 32;
const CLAUDE_SUBAGENT_HISTORY_READ_TIMEOUT_MS = 15_000;
const CLAUDE_SUBAGENT_HISTORY_FILE_MAX_BYTES = 256 * 1024 * 1024;
const CLAUDE_SUBAGENT_HISTORY_METADATA_MAX_BYTES = 64 * 1024;

function runtimeModeToClaudePermissionMode(runtimeMode: RuntimeMode): PermissionMode {
  switch (runtimeMode) {
    case "approval-required":
      // SDK 0.3.286 stopped inserting `default` when this option is absent:
      // omission now inherits native settings and can start in classifier-backed
      // Auto mode. Cafe's Manual selection is an explicit approval policy, so
      // bind it at query creation (including resumes), rather than relying on
      // native defaults or sending a pre-prompt setPermissionMode() request.
      // https://github.com/anthropics/claude-agent-sdk-typescript/blob/9d8cb9c1ae68672c343d75723440b73afe5b993c/CHANGELOG.md
      return "default";
    case "auto-accept-edits":
      return "acceptEdits";
    case "full-access":
      return "bypassPermissions";
  }
}

function resolveClaudePermissionMode(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly basePermissionMode: PermissionMode | undefined;
}): PermissionMode | undefined {
  // Claude Code 2.1.216 calls the standard UI state "manual", while the Agent
  // SDK control protocol continues to spell it `default`. Plan and Auto are
  // real SDK modes, not prompt decorations or aliases for Cafe access policy.
  if (input.interactionMode === "plan" || input.interactionMode === "auto") {
    return input.interactionMode;
  }
  return input.basePermissionMode;
}

type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;
type ClaudeSdkEffort = NonNullable<ClaudeQueryOptions["effort"]>;
type ClaudeSdkThinkingDisplay = "summarized" | "omitted" | null;
type ClaudeCommandLifecycleState = "queued" | "started" | "completed" | "cancelled" | "discarded";
type ClaudePromptLifecycleState = "submitted" | ClaudeCommandLifecycleState;
type ClaudePromptInput = Pick<ProviderSendTurnInput, "threadId" | "input" | "attachments"> &
  Partial<Pick<ProviderSendTurnInput, "modelSelection" | "deliveryPriority" | "inputOrigin">>;
// The bundled Claude Code binary can emit newer system subtypes before the
// installed SDK declarations include them. Keep those known runtime shapes in
// a narrow local union so handlers stay typed without dropping diagnostics.
type ClaudeForwardCompatibleSystemMessage =
  | (Record<string, unknown> & {
      readonly type: "system";
      readonly subtype: "commands_changed";
    })
  | (Record<string, unknown> & {
      readonly type: "system";
      readonly subtype: "background_tasks_changed";
      readonly tasks?: ReadonlyArray<unknown>;
    })
  | (Record<string, unknown> & {
      readonly type: "system";
      readonly subtype: "informational";
      readonly content: string;
      readonly level?: string;
      readonly prevent_continuation?: boolean;
      readonly tool_use_id?: string;
    })
  | (Record<string, unknown> & {
      readonly type: "system";
      readonly subtype: "model_refusal_fallback";
      readonly content: string;
      readonly trigger?: string;
      readonly direction?: string;
      readonly scope?: "session" | "local";
      readonly original_model?: string;
      readonly fallback_model?: string;
      readonly request_id?: string;
      readonly api_refusal_category?: string;
      readonly api_refusal_explanation?: string;
      readonly retracted_message_uuids?: ReadonlyArray<string>;
      readonly refused_user_message_uuid?: string;
    })
  | (Record<string, unknown> & {
      readonly type: "system";
      readonly subtype: "model_refusal_no_fallback";
      readonly content: string;
      readonly original_model?: string;
      readonly request_id?: string;
      readonly api_refusal_category?: string;
      readonly api_refusal_explanation?: string;
      readonly refused_user_message_uuid?: string;
    })
  | (Record<string, unknown> & {
      readonly type: "system";
      readonly subtype: "worker_shutting_down";
      readonly reason?: string;
    })
  | (Record<string, unknown> & {
      readonly type: "system";
      readonly subtype: "vcs_state_changed";
      readonly kind?: string;
      readonly branch?: string;
      readonly cwd?: string;
    })
  | (Record<string, unknown> & {
      readonly type: "system";
      readonly subtype: "code_change_published";
      readonly provider?: string;
      readonly url?: string;
      readonly repo?: string;
      readonly identifier?: string;
      readonly action?: string;
    })
  | (Record<string, unknown> & {
      readonly type: "system";
      readonly subtype: "feedback_draft_queued";
    });
type ClaudeSdkMessageWithForwardCompatibleSystem =
  | SDKMessage
  | ClaudeForwardCompatibleSystemMessage;

// Claude Code 2.1.206 advertises `msg_lifecycle_v1` and emits this top-level
// frame, but Agent SDK 0.3.209 still omits it from the public SDKMessage union.
// Keep the runtime decoder local and narrow until Anthropic publishes the type.
interface ClaudeCommandLifecycleMessage extends Record<string, unknown> {
  readonly type: "command_lifecycle";
  readonly command_uuid: string;
  readonly state: ClaudeCommandLifecycleState;
  readonly uuid?: string;
  readonly session_id?: string;
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
  readonly rewindMessageIds?: ClaudeRewindMessageIds;
  readonly rewindMessageIdsInvalid?: true;
  readonly forkMessageIds?: ClaudeForkMessageIds;
  readonly forkMessageIdsInvalid?: true;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  /**
   * User turns may only be extended through `steerTurn`; a second `sendTurn`
   * must never silently terminalize them. Synthetic turns are the exception:
   * they represent provider-initiated background output that arrived between
   * user prompts and may be closed before the next explicit user turn starts.
   */
  readonly origin: "user" | "synthetic";
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  /** Native API message ids scope indexes; wrapper UUIDs identify individual snapshots. */
  assistantNativeMessageKey?: string | undefined;
  readonly pendingAssistantSnapshots: Array<AssistantTextBlockState>;
  readonly reportedAssistantSnapshotKeys: Set<string>;
  readonly capturedProposedPlanKeys: Set<string>;
  readonly reportedSubagentRetryKeys: Set<string>;
  /**
   * Claude can deliver a normalized subagent assistant block more than once
   * while reconciling partial and completed snapshots. Bound this provider-
   * controlled set so a pathological stream cannot grow a multi-day session
   * without limit.
   */
  readonly reportedSubagentMessageKeys: Set<string>;
  sdkMessageCount: number;
  firstSdkMessageAt?: string;
  firstSdkMessageType?: string;
  firstSdkMessageMethod?: string;
  firstSdkMessageTtftMs?: number;
  lastSdkMessageAt?: string;
  lastSdkMessageType?: string;
  lastSdkMessageMethod?: string;
  promptQueuedAt?: string;
  promptTextBytes?: number;
  promptAttachmentCount?: number;
  watchdogWarningsEmitted: number;
  nextSyntheticAssistantBlockIndex: number;
}

interface ClaudeDeferredTurnResult {
  readonly status: ProviderRuntimeTurnStatus;
  readonly result: SDKResultMessage;
  readonly errorMessage?: string;
}

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  readonly nativeMessageKey?: string;
  /** Commit exact UTF-16 units without retaining a second copy of streamed prose. */
  readonly streamedTextHash: ReturnType<typeof createHash>;
  streamedTextLength: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly suppressAlwaysAllowRule?: boolean;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly interaction?: ProviderElicitation;
  /** Authorization URLs are live capabilities, never durable event fields. */
  readonly interactionUrl?: string;
}

interface ToolInFlight {
  /** Server-minted reference for background-only control before a native task exists. */
  readonly controlId: string;
  readonly controlGeneration: string;
  readonly itemId: string;
  /** Response segments may advance while this exact native call is detached. */
  readonly turnId?: TurnId;
  readonly detached?: boolean;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

type ClaudeTaskVisibilityAuthority = "provider" | "snapshot-retraction";

interface ClaudeTaskVisibilityState {
  visibility: RuntimeTaskVisibility;
  authority: ClaudeTaskVisibilityAuthority;
}

interface ClaudeTaskBinding {
  readonly retiredToolUseKeys?: ReadonlyArray<string> | undefined;
  readonly incarnationRequiresToolUseId?: boolean | undefined;
  readonly taskId: RuntimeTaskId;
  readonly nativeTaskId?: string | undefined;
  readonly taskGeneration?: string | undefined;
  readonly backgrounded?: boolean | undefined;
  /** Root turn at first observation; null is authoritative between turns. */
  readonly turnId: TurnId | null;
  /** Shared across every task/tool alias so visibility cannot evict separately. */
  readonly visibilityState: ClaudeTaskVisibilityState;
  /** Exact spawning tool id. It is never used as a substitute for taskId. */
  readonly toolUseId?: string;
  /** Canonical current map key retained even when the raw id exceeds display bounds. */
  readonly toolUseKey?: string;
  /** Exact SDK transcript identity returned by a structured Agent result. */
  readonly historyId?: string;
  readonly description?: string;
  /** A fallback/recovery description cannot supersede a native lifecycle title. */
  readonly provisionalDescription: boolean;
  /**
   * True only while parent_tool_use_id is the sole available child identity.
   * Only a structured lifecycle edge carrying the exact task and spawning-tool
   * identities may resolve it; unrelated progress must never guess a join.
   */
  readonly provisionalTaskIdentity: boolean;
  /** Canonical provisional row id retained across an exact task/tool upgrade. */
  readonly provisionalTaskId?: RuntimeTaskId;
  /** Canonical spawning-tool key that authorized the provisional row. */
  readonly provisionalToolUseKey?: string;
  readonly subagentType?: string;
  readonly objective?: string;
  readonly startedAt?: string;
  readonly isSubagent: boolean;
}

type RuntimeFork = <A, E>(effect: Effect.Effect<A, E, never>) => Fiber.Fiber<A, E>;

interface ClaudeSessionContext {
  session: ProviderSession;
  /** Cached actual executable version; SDK package identity is not runtime authority. */
  taskControlVersion: string | null | undefined;
  /** Immutable native query generation, independent of resumable history. */
  readonly subagentRuntimeId: string;
  /** Frozen per-query environment; never shared or mutated by a sibling chat. */
  readonly environment: NodeJS.ProcessEnv;
  /** A forgotten live child cannot later authorize destructive idle retirement. */
  taskLivenessUncertain: boolean;
  /** SDK messages consumed from the iterator but not fully projected. */
  inFlightSdkMessageCount: number;
  /** Result/terminal lifecycle frames fence priority delivery before async projection. */
  inFlightSdkTurnBoundaryCount: number;
  /** Iterator termination is authoritative before asynchronous session retirement. */
  sdkStreamEnded: boolean;
  /** Changes at iterator ingress, before asynchronous normalization. */
  sdkMessageRevision: number;
  /** Native close threw; never admit another owner until explicit recovery. */
  queryClosureUncertain: boolean;
  /** A rewind's exact-exit requirement survives later explicit stop attempts. */
  rewindRetirementUncertain: boolean;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  /** A push supersedes initialization even while that cached SDK read awaits init. */
  commandCatalogPushRevision: number;
  commandCatalogPublishPending: boolean;
  /** At most one content-free invalidation; balances never enter events. */
  quotaReportPublishPending: boolean;
  pendingCommandCatalog:
    | { readonly sessionId: string; readonly catalog: ProviderCommandCatalog }
    | undefined;
  /** Exact query-owned scheduling authority; never shared with a resumed query. */
  readonly schedulingBinding: SchedulingSessionBinding | undefined;
  readonly runFork: RuntimeFork;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  currentPermissionMode: PermissionMode;
  currentApiModelId: string | undefined;
  selectedContextWindowTokens: number | undefined;
  resumeSessionId: string | undefined;
  resumeCursorDurable: boolean;
  resumeBaseTurnCount: number;
  rewindMessageIds: ClaudeRewindMessageIds | undefined;
  forkMessageIds: ClaudeForkMessageIds;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  /**
   * Content block indexes are only unique inside one Claude stream. Nested
   * agents restart their indexes at zero, so the parent tool-use id is part of
   * the key; otherwise a child tool can overwrite the main agent's live tool.
   */
  readonly inFlightTools: Map<string, ToolInFlight>;
  readonly backgroundTaskIds: Set<string>;
  /**
   * Live level-snapshot bindings are retained independently of the generic
   * task binding cache. Unrelated task churn can legitimately fill the generic
   * 4,096-entry cache between background snapshots; omission reconciliation
   * still needs the original owner and bounded presentation metadata.
   */
  readonly backgroundTaskBindings: Map<string, ClaudeTaskBinding>;
  readonly taskBindingsByToolUseId: Map<string, ClaudeTaskBinding>;
  readonly taskBindingsByTaskId: Map<string, ClaudeTaskBinding>;
  /**
   * Agent SDK 0.3.228 marks ambient/housekeeping tasks with
   * `skip_transcript`. Keep their ids so every later progress, nested stream,
   * and terminal edge obeys the same instruction even when the individual
   * follow-up message does not repeat the flag. The set is provider-controlled
   * and therefore bounded for multi-week sessions.
   */
  readonly hiddenTranscriptTaskIds: Set<string>;
  /** Subset hidden only because a level snapshot stopped reporting the task. */
  readonly snapshotRetractedTaskIds: Set<string>;
  /**
   * Terminal task identities are tombstoned independently of retained task
   * bindings. Claude SDK 0.3.251 permits the terminal notification and the
   * shrinking background-task snapshot to arrive in either order. Keeping a
   * bounded tombstone prevents a late level snapshot from resurrecting or
   * retracting a row that Cafe has already projected as terminal.
   */
  readonly terminalTaskIds: Set<string>;
  /** Once fallback identities overflow, unknown task visibility fails closed. */
  failClosedTaskVisibilityOverflow: boolean;
  readonly promptLifecycleByUuid: Map<string, ClaudePromptLifecycleState>;
  readonly capabilities: Set<string>;
  readonly fastModeRequested: boolean;
  turnState: ClaudeTurnState | undefined;
  deferredTurnResult: ClaudeDeferredTurnResult | undefined;
  lastFastModeNoticeKey: string | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  /** Query-local billing epoch, independent of the resumable transcript ID. */
  usageAccounting: ClaudeUsageAccounting;
  readonly usageAccountingResetIds: Set<string>;
  usageAccountingResetOverflow: boolean;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  hasSubmittedUserPrompt: boolean;
  authFailureSeen: boolean;
  stopped: boolean;
}

/** Provider visibility is not liveness authority: ambient children count too. */
function isClaudeTreeIdle(context: ClaudeSessionContext): boolean {
  if (
    context.stopped ||
    context.session.status !== "ready" ||
    context.session.activeTurnId !== undefined ||
    context.turnState !== undefined ||
    context.deferredTurnResult !== undefined ||
    context.inFlightTools.size > 0 ||
    context.pendingApprovals.size > 0 ||
    context.pendingUserInputs.size > 0 ||
    context.promptLifecycleByUuid.size > 0 ||
    context.backgroundTaskIds.size > 0 ||
    context.taskLivenessUncertain ||
    context.failClosedTaskVisibilityOverflow ||
    context.inFlightSdkMessageCount > 0 ||
    context.queryClosureUncertain ||
    Array.from(context.taskBindingsByTaskId.values()).some(
      (binding) => !context.terminalTaskIds.has(String(binding.taskId)),
    )
  )
    return false;
  return true;
}

function reserveClaudeIdleRetirement(context: ClaudeSessionContext): boolean {
  if (!isClaudeTreeIdle(context)) return false;
  // Synchronous check and reservation: no stream callback/send can interleave
  // before stopped=true. Teardown happens later with this exact reservation.
  context.stopped = true;
  return true;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly supportedCommands?: () => Promise<unknown>;
  readonly stopTask?: (taskId: string) => Promise<void>;
  readonly backgroundTasks?: (toolUseId: string) => Promise<boolean>;
  readonly interrupt: () => Promise<SDKControlInterruptResponse | undefined>;
  // The 0.3.228 runtime implements this control request, but its public Query
  // interface has not exposed the method yet. Keep it optional for older SDKs.
  readonly cancelAsyncMessage?: (messageUuid: string) => Promise<boolean>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (
    maxThinkingTokens: number | null,
    thinkingDisplay?: ClaudeSdkThinkingDisplay,
  ) => Promise<void>;
  readonly close: () => void;
  /** Cafe-owned exact process exit observation, never SDK close acknowledgement. */
  readonly waitForExit?: () => Promise<void>;
}

export interface ClaudeAdapterLiveOptions {
  readonly commandCatalogConfigurationKey?: string;
  readonly getNativeVersion?: () => string | null | undefined;
  /** Cached owning-driver status only; this getter must never launch a probe. */
  readonly getSubagentConcurrencySupport?: () => boolean;
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  /** Owning-instance login selection; existing query environments remain snapshots. */
  readonly resolveEnvironment?: Effect.Effect<NodeJS.ProcessEnv>;
  /** Read only the owning driver's already-observed initialization metadata. */
  readonly getModelCapabilities?: (model: string) => Effect.Effect<ModelCapabilities>;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly forkNativeSession?: (
    sessionId: string,
    options: ForkSessionOptions,
  ) => Promise<ForkSessionResult>;
  readonly deleteNativeSession?: (sessionId: string, options: ForkSessionOptions) => Promise<void>;
  /** Test seam around the official SDK history APIs; production uses the SDK exports directly. */
  readonly listNativeSubagents?: typeof listSubagents;
  readonly getNativeSubagentMessages?: typeof getSubagentMessages;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Invoked when the adapter observes upstream Claude authentication state
   * change: `true` when a turn fails with a 401/authentication error and
   * `false` when a turn completes successfully again. Lets the owning driver
   * flip the provider snapshot to needs-login without waiting for a probe —
   * the local capability probe cannot detect expired credentials because it
   * never performs an authenticated API request.
   */
  readonly onAuthStatusChanged?: (failed: boolean) => Effect.Effect<void>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function makeClaudeRewindRefusal(): ProviderAdapterValidationError {
  return new ProviderAdapterValidationError({
    provider: PROVIDER,
    operation: "prepareRollbackThread",
    issue:
      "Claude could not prove this checkpoint's exact idle native conversation boundary. Its original history was preserved.",
  });
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

function isZeroTurnClaudeExecutionFailure(message: SDKMessage): boolean {
  return (
    message.type === "result" &&
    message.subtype !== "success" &&
    message.is_error === true &&
    message.num_turns === 0
  );
}

function isClaudeAuthFailureSystemMessage(message: SDKMessage): boolean {
  if (message.type !== "system") {
    return false;
  }
  const record = message as Record<string, unknown>;
  return (
    record.subtype === "api_retry" &&
    record.error_status === 401 &&
    record.error === "authentication_failed"
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmedStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function canonicalClaudeOpaqueIdentity(
  value: unknown,
  input: {
    readonly digestDomain: string;
    readonly digestPrefix: string;
  },
): string | undefined {
  const normalized = trimmedStringValue(value);
  if (!normalized) {
    return undefined;
  }

  // Reserve Cafe's digest namespace even for short provider values. Otherwise
  // a malicious short id could impersonate the canonical id of a different,
  // oversized value and merge two independent task lifecycles.
  if (
    Buffer.byteLength(normalized, "utf8") <= CLAUDE_OPAQUE_ID_MAX_UTF8_BYTES &&
    !normalized.startsWith(input.digestPrefix)
  ) {
    return normalized;
  }

  const digest = createHash("sha256")
    .update(input.digestDomain, "utf8")
    .update("\0", "utf8")
    .update(normalized, "utf8")
    .digest("hex");
  return `${input.digestPrefix}${digest}`;
}

function canonicalClaudeTaskId(value: unknown): RuntimeTaskId | undefined {
  const taskId = canonicalClaudeOpaqueIdentity(value, {
    digestDomain: CLAUDE_TASK_ID_HASH_DOMAIN,
    digestPrefix: CLAUDE_TASK_ID_HASH_PREFIX,
  });
  return taskId ? RuntimeTaskId.make(taskId) : undefined;
}

function canonicalClaudeToolUseBindingKey(value: unknown): string | undefined {
  return canonicalClaudeOpaqueIdentity(value, {
    digestDomain: CLAUDE_TOOL_USE_ID_HASH_DOMAIN,
    digestPrefix: CLAUDE_TOOL_USE_ID_HASH_PREFIX,
  });
}

function exactClaudeProviderIdentity(
  value: unknown,
  options?: { readonly pathSegment?: boolean },
): string | undefined {
  const normalized = trimmedStringValue(value);
  if (
    !normalized ||
    Buffer.byteLength(normalized, "utf8") > CLAUDE_OPAQUE_ID_MAX_UTF8_BYTES ||
    Array.from(normalized).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x061c ||
        (codePoint >= 0x200e && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2066 && codePoint <= 0x2069)
      );
    })
  ) {
    return undefined;
  }
  // `getSubagentMessages()` ultimately treats agentId as a transcript key.
  // Accept only one inert key segment even when the value came from the SDK;
  // membership in `listSubagents()` is checked separately before every read.
  if (
    options?.pathSegment === true &&
    (normalized === "." ||
      normalized === ".." ||
      normalized.includes("/") ||
      normalized.includes("\\"))
  ) {
    return undefined;
  }
  return normalized;
}

function claudeParentToolUseId(message: SDKMessage): string | undefined {
  return trimmedStringValue((message as unknown as Record<string, unknown>).parent_tool_use_id);
}

function claudeStreamBlockKey(parentToolUseId: string | undefined, blockIndex: number): string {
  // A length prefix makes this unambiguous even if an upstream tool id itself
  // contains separators. This key remains internal and is never persisted.
  return parentToolUseId === undefined
    ? `root:${blockIndex}`
    : `child:${parentToolUseId.length}:${parentToolUseId}:${blockIndex}`;
}

function rememberBoundedClaudeKey(keys: Set<string>, key: string, limit: number): boolean {
  if (keys.has(key)) {
    return false;
  }
  keys.add(key);
  while (keys.size > limit) {
    const oldest = keys.values().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    keys.delete(oldest);
  }
  return true;
}

function upsertClaudeTaskBinding(
  context: ClaudeSessionContext,
  input: {
    readonly retiredToolUseKeys?: ReadonlyArray<string>;
    readonly incarnationRequiresToolUseId?: boolean;
    readonly taskId: RuntimeTaskId;
    readonly nativeTaskId?: string | undefined;
    readonly taskGeneration?: string | undefined;
    readonly backgrounded?: boolean | undefined;
    readonly toolUseKey?: string | undefined;
    readonly toolUseId?: string | undefined;
    readonly historyId?: string | undefined;
    readonly description?: string | undefined;
    readonly provisionalDescription?: boolean | undefined;
    readonly provisionalTaskIdentity?: boolean | undefined;
    readonly provisionalTaskId?: RuntimeTaskId | undefined;
    readonly provisionalToolUseKey?: string | undefined;
    readonly subagentType?: string | undefined;
    readonly objective?: string | undefined;
    readonly startedAt?: string | undefined;
    readonly taskType?: string | undefined;
    readonly spawnDepth?: number | undefined;
    readonly isSubagent?: boolean | undefined;
    readonly turnId?: TurnId | null | undefined;
    readonly visibility?: RuntimeTaskVisibility | undefined;
    readonly visibilityAuthority?: ClaudeTaskVisibilityAuthority | undefined;
  },
): ClaudeTaskBinding {
  const taskMapKey = String(input.taskId);
  // Refresh insertion order when a progress edge carries richer metadata.
  // Both maps use canonical, size-bounded keys because every field is
  // provider-controlled and Claude sessions may remain alive for weeks.
  const previous =
    context.taskBindingsByTaskId.get(taskMapKey) ??
    (input.toolUseKey ? context.taskBindingsByToolUseId.get(input.toolUseKey) : undefined);
  // Bound every provider-authored display value before it enters a retained
  // binding map. Event projection applies its own limits too, but a long-lived
  // session can retain thousands of bindings between projections.
  const incomingDescription = claudeSubagentDisplayLine(
    input.description,
    CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
  );
  const incomingDescriptionIsProvisional = input.provisionalDescription === true;
  const acceptsIncomingDescription =
    incomingDescription !== undefined &&
    (!incomingDescriptionIsProvisional ||
      previous?.description === undefined ||
      previous.provisionalDescription);
  const description = acceptsIncomingDescription ? incomingDescription : previous?.description;
  const provisionalDescription = acceptsIncomingDescription
    ? incomingDescriptionIsProvisional
    : (previous?.provisionalDescription ?? false);
  const provisionalTaskIdentity =
    input.provisionalTaskIdentity ?? previous?.provisionalTaskIdentity ?? false;
  const provisionalTaskId =
    input.provisionalTaskIdentity === false
      ? undefined
      : (input.provisionalTaskId ??
        previous?.provisionalTaskId ??
        (input.provisionalTaskIdentity === true ? input.taskId : undefined));
  const provisionalToolUseKey =
    input.provisionalTaskIdentity === false
      ? undefined
      : (input.provisionalToolUseKey ??
        previous?.provisionalToolUseKey ??
        (input.provisionalTaskIdentity === true ? input.toolUseKey : undefined));
  const subagentType =
    claudeSubagentDisplayLine(input.subagentType, CLAUDE_SUBAGENT_ROLE_LIMIT) ??
    previous?.subagentType;
  const objective =
    claudeSubagentDisplayLine(input.objective, CLAUDE_SUBAGENT_OBJECTIVE_LIMIT) ??
    previous?.objective;
  // The first observed clock remains authoritative. Progress snapshots repeat
  // duration metadata and must not make a long-running row jump forward every
  // time Claude reports another update.
  const newIncarnation =
    input.taskGeneration !== undefined && input.taskGeneration !== previous?.taskGeneration;
  const startedAt =
    (newIncarnation ? undefined : previous?.startedAt) ??
    claudeSubagentDisplayLine(input.startedAt, 80);
  // These identities come from different SDK fields and stay distinct. In
  // particular, never infer an Agent transcript id from a task/tool id.
  const toolUseId = exactClaudeProviderIdentity(input.toolUseId) ?? previous?.toolUseId;
  const toolUseKey = input.toolUseKey ?? previous?.toolUseKey;
  const historyId =
    exactClaudeProviderIdentity(input.historyId, { pathSegment: true }) ?? previous?.historyId;
  const taskType = claudeSubagentDisplayLine(input.taskType, 120);
  // Background snapshots and terminal notifications may arrive after the root
  // turn settles. Preserve the first owning turn so a later ambient retraction
  // targets the exact renderer row instead of creating a second cross-turn key.
  const turnId =
    previous !== undefined && !newIncarnation
      ? previous.turnId
      : input.turnId !== undefined
        ? input.turnId
        : (context.turnState?.turnId ?? null);
  const visibilityState = previous?.visibilityState ?? {
    visibility:
      context.hiddenTranscriptTaskIds.has(taskMapKey) ||
      context.snapshotRetractedTaskIds.has(taskMapKey) ||
      context.failClosedTaskVisibilityOverflow
        ? "ambient"
        : "visible",
    authority:
      !context.hiddenTranscriptTaskIds.has(taskMapKey) &&
      context.snapshotRetractedTaskIds.has(taskMapKey)
        ? "snapshot-retraction"
        : "provider",
  };
  if (input.visibility !== undefined) {
    // Mutate the shared state object before replacing presentation metadata so
    // older tool-use aliases observe the same authoritative visibility.
    const requestedAuthority = input.visibilityAuthority ?? "provider";
    // Snapshot omission is only evidence that a task is no longer in Claude's
    // live level set. It must never weaken an explicit provider-authored
    // ambient/skip_transcript instruction, which remains authoritative for the
    // later terminal notification even if that notification omits visibility.
    if (
      requestedAuthority !== "snapshot-retraction" ||
      visibilityState.authority !== "provider" ||
      visibilityState.visibility !== "ambient"
    ) {
      visibilityState.visibility = input.visibility;
      visibilityState.authority = requestedAuthority;
    }
  }
  const isSubagent =
    previous?.isSubagent === true ||
    input.isSubagent === true ||
    subagentType !== undefined ||
    input.spawnDepth !== undefined ||
    taskType === "local_agent" ||
    taskType === "agent" ||
    taskType === "subagent";
  const binding: ClaudeTaskBinding = {
    ...((input.incarnationRequiresToolUseId ?? previous?.incarnationRequiresToolUseId)
      ? { incarnationRequiresToolUseId: true }
      : {}),
    ...((input.retiredToolUseKeys ?? previous?.retiredToolUseKeys)
      ? { retiredToolUseKeys: input.retiredToolUseKeys ?? previous?.retiredToolUseKeys }
      : {}),
    taskId: input.taskId,
    ...((input.nativeTaskId ?? previous?.nativeTaskId)
      ? { nativeTaskId: input.nativeTaskId ?? previous?.nativeTaskId }
      : {}),
    ...((input.taskGeneration ?? previous?.taskGeneration)
      ? { taskGeneration: input.taskGeneration ?? previous?.taskGeneration }
      : {}),
    ...(input.backgrounded !== undefined || previous?.backgrounded !== undefined
      ? { backgrounded: input.backgrounded ?? previous?.backgrounded }
      : {}),
    turnId,
    visibilityState,
    ...(toolUseId ? { toolUseId } : {}),
    ...(toolUseKey ? { toolUseKey } : {}),
    ...(historyId ? { historyId } : {}),
    ...(description ? { description } : {}),
    provisionalDescription,
    provisionalTaskIdentity,
    ...(provisionalTaskId ? { provisionalTaskId } : {}),
    ...(provisionalToolUseKey ? { provisionalToolUseKey } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(objective ? { objective } : {}),
    ...(startedAt ? { startedAt } : {}),
    isSubagent,
  };

  context.taskBindingsByTaskId.delete(taskMapKey);
  context.taskBindingsByTaskId.set(taskMapKey, binding);
  if (input.toolUseKey) {
    context.taskBindingsByToolUseId.delete(input.toolUseKey);
    context.taskBindingsByToolUseId.set(input.toolUseKey, binding);
  }
  while (context.taskBindingsByToolUseId.size > CLAUDE_TASK_BINDING_LIMIT) {
    const oldest = context.taskBindingsByToolUseId.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    context.taskBindingsByToolUseId.delete(oldest);
  }
  while (context.taskBindingsByTaskId.size > CLAUDE_TASK_BINDING_LIMIT) {
    const oldest = context.taskBindingsByTaskId.keys().next().value;
    if (typeof oldest !== "string") {
      break;
    }
    const forgotten = context.taskBindingsByTaskId.get(oldest);
    if (forgotten && !context.terminalTaskIds.has(String(forgotten.taskId))) {
      context.taskLivenessUncertain = true;
    }
    context.taskBindingsByTaskId.delete(oldest);
  }
  if (context.backgroundTaskIds.has(taskMapKey)) {
    context.backgroundTaskBindings.delete(taskMapKey);
    context.backgroundTaskBindings.set(taskMapKey, binding);
    while (context.backgroundTaskBindings.size > CLAUDE_TASK_BINDING_LIMIT) {
      const oldest = context.backgroundTaskBindings.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      context.backgroundTaskBindings.delete(oldest);
    }
  }
  return binding;
}

function restoreClaudeRetainedTaskBinding(
  context: ClaudeSessionContext,
  retained: ClaudeTaskBinding,
  visibility?: {
    readonly value: RuntimeTaskVisibility;
    readonly authority: ClaudeTaskVisibilityAuthority;
  },
): ClaudeTaskBinding {
  const toolUseKey = retained.toolUseKey ?? canonicalClaudeToolUseBindingKey(retained.toolUseId);
  return upsertClaudeTaskBinding(context, {
    taskId: retained.taskId,
    ...(retained.nativeTaskId ? { nativeTaskId: retained.nativeTaskId } : {}),
    ...(retained.taskGeneration ? { taskGeneration: retained.taskGeneration } : {}),
    ...(retained.backgrounded !== undefined ? { backgrounded: retained.backgrounded } : {}),
    ...(retained.retiredToolUseKeys ? { retiredToolUseKeys: retained.retiredToolUseKeys } : {}),
    ...(retained.incarnationRequiresToolUseId ? { incarnationRequiresToolUseId: true } : {}),
    ...(toolUseKey ? { toolUseKey } : {}),
    ...(retained.toolUseId ? { toolUseId: retained.toolUseId } : {}),
    ...(retained.historyId ? { historyId: retained.historyId } : {}),
    ...(retained.description ? { description: retained.description } : {}),
    provisionalDescription: retained.provisionalDescription,
    provisionalTaskIdentity: retained.provisionalTaskIdentity,
    ...(retained.provisionalTaskId ? { provisionalTaskId: retained.provisionalTaskId } : {}),
    ...(retained.provisionalToolUseKey
      ? { provisionalToolUseKey: retained.provisionalToolUseKey }
      : {}),
    ...(retained.subagentType ? { subagentType: retained.subagentType } : {}),
    ...(retained.objective ? { objective: retained.objective } : {}),
    ...(retained.startedAt ? { startedAt: retained.startedAt } : {}),
    isSubagent: retained.isSubagent,
    turnId: retained.turnId,
    ...(visibility
      ? {
          visibility: visibility.value,
          visibilityAuthority: visibility.authority,
        }
      : {}),
  });
}

function bindClaudeTaskToToolUse(
  context: ClaudeSessionContext,
  input: {
    readonly taskId: string;
    readonly toolUseId?: string | undefined;
    readonly historyId?: string | undefined;
    readonly description?: string | undefined;
    readonly provisionalDescription?: boolean | undefined;
    readonly provisionalTaskIdentity?: boolean | undefined;
    readonly subagentType?: string | undefined;
    readonly objective?: string | undefined;
    readonly startedAt?: string | undefined;
    readonly taskType?: string | undefined;
    readonly spawnDepth?: number | undefined;
    readonly turnId?: TurnId | undefined;
    readonly visibility?: RuntimeTaskVisibility | undefined;
    readonly visibilityAuthority?: ClaudeTaskVisibilityAuthority | undefined;
  },
): ClaudeTaskBinding | undefined {
  const taskId = canonicalClaudeTaskId(input.taskId);
  if (!taskId) {
    return undefined;
  }
  const retained = context.backgroundTaskBindings.get(String(taskId));
  if (retained && !context.taskBindingsByTaskId.has(String(taskId)))
    restoreClaudeRetainedTaskBinding(context, retained);
  const toolUseKey = canonicalClaudeToolUseBindingKey(input.toolUseId);
  return upsertClaudeTaskBinding(context, {
    taskId,
    ...(toolUseKey ? { toolUseKey } : {}),
    ...(input.toolUseId !== undefined ? { toolUseId: input.toolUseId } : {}),
    ...(input.historyId !== undefined ? { historyId: input.historyId } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.provisionalDescription !== undefined
      ? { provisionalDescription: input.provisionalDescription }
      : {}),
    ...(input.provisionalTaskIdentity !== undefined
      ? { provisionalTaskIdentity: input.provisionalTaskIdentity }
      : {}),
    ...(input.subagentType !== undefined ? { subagentType: input.subagentType } : {}),
    ...(input.objective !== undefined ? { objective: input.objective } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.taskType !== undefined ? { taskType: input.taskType } : {}),
    ...(input.spawnDepth !== undefined ? { spawnDepth: input.spawnDepth } : {}),
    ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    ...(input.visibilityAuthority !== undefined
      ? { visibilityAuthority: input.visibilityAuthority }
      : {}),
  });
}

function findClaudeTaskBinding(
  context: ClaudeSessionContext,
  input: {
    readonly taskId?: string | undefined;
    readonly toolUseId?: string | undefined;
  },
): ClaudeTaskBinding | undefined {
  const taskId = canonicalClaudeTaskId(input.taskId);
  const toolUseKey = canonicalClaudeToolUseBindingKey(input.toolUseId);
  return (
    (taskId ? context.taskBindingsByTaskId.get(String(taskId)) : undefined) ??
    (toolUseKey ? context.taskBindingsByToolUseId.get(toolUseKey) : undefined)
  );
}

interface ClaudeAuthoritativeTaskIdentity {
  readonly taskId: RuntimeTaskId;
  readonly toolUseKey?: string;
  readonly provisionalAlias?: ClaudeTaskBinding;
}

function prepareClaudeAuthoritativeTaskIdentity(
  context: ClaudeSessionContext,
  rawTaskId: unknown,
  rawToolUseId: unknown,
  allowNewIncarnation = false,
): ClaudeAuthoritativeTaskIdentity | undefined {
  const taskId = canonicalClaudeTaskId(rawTaskId);
  if (!taskId) return undefined;

  const toolUseKey = canonicalClaudeToolUseBindingKey(rawToolUseId);
  const current =
    context.taskBindingsByTaskId.get(String(taskId)) ??
    context.backgroundTaskBindings.get(String(taskId));
  if (!allowNewIncarnation && current?.incarnationRequiresToolUseId && !toolUseKey)
    return undefined;
  if (toolUseKey && current?.retiredToolUseKeys?.includes(toolUseKey)) return undefined;
  // A delayed frame from an earlier incarnation cannot rebind or finish the
  // replacement. Only a new explicit start after terminal evidence may reuse
  // the native task id with a different spawning tool.
  if (
    current?.toolUseKey &&
    toolUseKey &&
    current.toolUseKey !== toolUseKey &&
    !(allowNewIncarnation && context.terminalTaskIds.has(String(taskId)))
  )
    return undefined;
  const correlatedBinding = toolUseKey
    ? context.taskBindingsByToolUseId.get(toolUseKey)
    : undefined;
  const provisionalTaskId = correlatedBinding?.provisionalTaskId;
  if (!provisionalTaskId || provisionalTaskId === taskId) {
    return {
      taskId,
      ...(toolUseKey ? { toolUseKey } : {}),
    };
  }

  // Only the exact task/tool association carried by one SDK lifecycle edge may
  // retire an assistant-first alias. Re-read the alias map and require its
  // private provenance so an unrelated task that reused the same opaque text
  // cannot be retracted. Removal happens before the bounded replacement upsert,
  // preventing a transient extra entry from evicting unrelated live state.
  const provisionalTaskKey = String(provisionalTaskId);
  const provisionalAlias = context.taskBindingsByTaskId.get(provisionalTaskKey);
  if (
    provisionalAlias?.provisionalTaskIdentity !== true ||
    provisionalAlias.taskId !== provisionalTaskId ||
    provisionalAlias.toolUseKey !== toolUseKey ||
    provisionalAlias.provisionalTaskId !== provisionalTaskId ||
    provisionalAlias.provisionalToolUseKey !== toolUseKey
  ) {
    return {
      taskId,
      ...(toolUseKey ? { toolUseKey } : {}),
    };
  }
  context.taskBindingsByTaskId.delete(provisionalTaskKey);
  return {
    taskId,
    ...(toolUseKey ? { toolUseKey } : {}),
    provisionalAlias,
  };
}

function claudeSubagentDisplayLine(value: unknown, limit: number): string | undefined {
  const text = typeof value === "string" ? sanitizeDiagnosticLine(value) : "";
  const normalized = text
    .replace(/[\p{Bidi_Control}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

/**
 * Bound provider-authored canonical text before it enters the durable event
 * ledger. Hook output keeps line structure for troubleshooting, while task
 * display fields use the single-line helper above at their call sites.
 */
function boundedClaudeProviderText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\p{Bidi_Control}]+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > limit ? `${normalized.slice(0, limit - 3)}...` : normalized;
}

function claudeResourceLinkScheme(uri: string): string | undefined {
  // Avoid URL parsing here: MCP permits provider-defined URI schemes and Cafe
  // only needs a non-authoritative display hint. A strict scheme prefix keeps
  // this inert and prevents a malformed resource identifier from being treated
  // as a path or navigable URL.
  const match = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):/.exec(uri);
  return match?.[1]?.toLowerCase();
}

interface ClaudeResourceUriRedaction {
  readonly uri: string;
  readonly referenceId: string;
}

interface ClaudeResourceLinkProjection {
  readonly links: ReadonlyArray<RuntimeResourceLink> | undefined;
  readonly redactions: ReadonlyArray<ClaudeResourceUriRedaction>;
  readonly hasUninspectedEntries: boolean;
}

function claudeResourceReferenceId(uri: string): string {
  return `sha256:${createHash("sha256")
    .update(CLAUDE_RESOURCE_LINK_HASH_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(uri, "utf8")
    .digest("hex")}`;
}

function claudeResourceUriOmission(referenceId: string): string {
  return `[resource URI omitted; ref ${referenceId}]`;
}

/**
 * Remove resource identifiers from provider-authored text while retaining the
 * surrounding tool output. Claude Code renders MCP resource links into API
 * tool results as `[Resource link: label] URI`; handle that wire shape even if
 * a future SDK message omits the parallel structured `resourceLinks` array.
 */
function redactClaudeResourceString(
  value: string,
  redactions: ReadonlyArray<ClaudeResourceUriRedaction>,
): string {
  const renderedLinkRedacted = value.replace(
    /\[Resource link:([^\]\r\n]{0,512})\][ \t]+([A-Za-z][A-Za-z0-9+.-]{0,31}:[^\s]{0,16383})/g,
    (_match, labelValue: string, uri: string) => {
      const label = claudeSubagentDisplayLine(labelValue, 512) ?? "resource";
      return `[Resource link: ${label}] ${claudeResourceUriOmission(
        claudeResourceReferenceId(uri),
      )}`;
    },
  );

  // Longest-first replacement prevents a shorter URI that happens to prefix a
  // second resource identifier from leaving the latter's sensitive suffix.
  return redactions
    .toSorted((left, right) => right.uri.length - left.uri.length)
    .reduce(
      (text, redaction) =>
        text.split(redaction.uri).join(claudeResourceUriOmission(redaction.referenceId)),
      renderedLinkRedacted,
    );
}

/**
 * SDK message payloads are JSON-like but provider-controlled. Clone them while
 * redacting resource identifiers so neither the canonical item payload nor the
 * adapter's resumable thread snapshot retains a signed URL, local path, or MCP
 * bearer token. Cycles/depth abuse are replaced rather than copied through.
 */
function redactClaudeResourceUris<T>(
  value: T,
  redactions: ReadonlyArray<ClaudeResourceUriRedaction>,
): T {
  const ancestors = new WeakSet<object>();
  const visit = (current: unknown, depth: number): unknown => {
    if (typeof current === "string") {
      return redactClaudeResourceString(current, redactions);
    }
    if (current === null || typeof current !== "object") {
      return current;
    }
    if (depth >= CLAUDE_RESOURCE_REDACTION_MAX_DEPTH) {
      return "[deep provider value omitted]";
    }
    if (ancestors.has(current)) {
      return "[circular provider value omitted]";
    }

    ancestors.add(current);
    const sanitized = Array.isArray(current)
      ? current.map((entry) => visit(entry, depth + 1))
      : Object.fromEntries(
          Object.entries(current).map(([key, entry]) => [
            redactClaudeResourceString(key, redactions),
            visit(entry, depth + 1),
          ]),
        );
    ancestors.delete(current);
    return sanitized;
  };

  return visit(value, 0) as T;
}

/**
 * Convert untrusted provider resource-link objects into a bounded, inert
 * runtime representation. Raw URIs and arbitrary annotations never cross this
 * boundary; a stable digest retains correlation without leaking signed URLs,
 * filesystem paths, or provider bearer material.
 */
function projectClaudeResourceLinks(value: unknown): ClaudeResourceLinkProjection {
  if (!Array.isArray(value)) {
    return { links: undefined, redactions: [], hasUninspectedEntries: false };
  }

  // The SDK contract caps resource links at 50. Allow a second bounded window
  // so malformed/duplicate entries cannot starve later valid metadata, while
  // still preventing an adversarial array from creating unbounded work.
  const sourceEntries = value.slice(0, CLAUDE_RESOURCE_LINK_INSPECTION_LIMIT);
  const redactions: Array<ClaudeResourceUriRedaction> = [];
  const seenUris = new Set<string>();
  for (const entry of sourceEntries) {
    const uri = trimmedStringValue(recordValue(entry)?.uri);
    if (
      !uri ||
      seenUris.has(uri) ||
      Buffer.byteLength(uri, "utf8") > CLAUDE_RESOURCE_URI_UTF8_BYTES_LIMIT
    ) {
      continue;
    }
    seenUris.add(uri);
    redactions.push({ uri, referenceId: claudeResourceReferenceId(uri) });
  }

  const links: Array<RuntimeResourceLink> = [];
  const seenReferences = new Set<string>();
  let encodedBytes = 2; // JSON array brackets.
  for (const entry of sourceEntries) {
    if (links.length >= CLAUDE_RESOURCE_LINK_LIMIT) break;
    const record = recordValue(entry);
    const uri = trimmedStringValue(record?.uri);
    const name = boundedClaudeProviderText(
      typeof record?.name === "string"
        ? redactClaudeResourceString(record.name, redactions)
        : undefined,
      512,
    );
    if (
      !record ||
      !uri ||
      !name ||
      Buffer.byteLength(uri, "utf8") > CLAUDE_RESOURCE_URI_UTF8_BYTES_LIMIT
    ) {
      continue;
    }

    const referenceId = claudeResourceReferenceId(uri);
    if (seenReferences.has(referenceId)) continue;

    const title = boundedClaudeProviderText(
      typeof record.title === "string"
        ? redactClaudeResourceString(record.title, redactions)
        : undefined,
      512,
    );
    const description = boundedClaudeProviderText(
      typeof record.description === "string"
        ? redactClaudeResourceString(record.description, redactions)
        : undefined,
      2_048,
    );
    const mimeType = boundedClaudeProviderText(
      typeof record.mimeType === "string"
        ? redactClaudeResourceString(record.mimeType, redactions)
        : undefined,
      256,
    );
    const size = boundedClaudeNativeNumber(record.size, true);
    const scheme = claudeResourceLinkScheme(uri);
    const link: RuntimeResourceLink = {
      referenceId,
      name,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(size !== undefined ? { size } : {}),
      ...(scheme ? { scheme } : {}),
    };
    const candidateBytes = Buffer.byteLength(JSON.stringify(link), "utf8") + (links.length ? 1 : 0);
    if (encodedBytes + candidateBytes > CLAUDE_RESOURCE_LINK_SERIALIZED_BYTES_LIMIT) break;
    encodedBytes += candidateBytes;
    seenReferences.add(referenceId);
    links.push(link);
  }
  return {
    links: links.length > 0 ? links : undefined,
    redactions,
    hasUninspectedEntries: value.length > CLAUDE_RESOURCE_LINK_INSPECTION_LIMIT,
  };
}

function claudeForegroundResourceLinkProjection(message: SDKMessage): ClaudeResourceLinkProjection {
  if (message.type !== "user") {
    return { links: undefined, redactions: [], hasUninspectedEntries: false };
  }
  const toolUseResult = recordValue(
    (message as unknown as Record<string, unknown>).tool_use_result,
  );
  return projectClaudeResourceLinks(toolUseResult?.resourceLinks ?? toolUseResult?.resource_links);
}

function claudeForegroundResourceLinks(
  message: SDKMessage,
): ReadonlyArray<RuntimeResourceLink> | undefined {
  return claudeForegroundResourceLinkProjection(message).links;
}

function boundedClaudeNativeResourceLinks(
  value: ReadonlyArray<RuntimeResourceLink> | undefined,
): ReadonlyArray<Omit<RuntimeResourceLink, "description">> | undefined {
  if (!value) return undefined;
  // Native diagnostics intentionally omit provider prose as well as the raw
  // URI. Canonical task/item activity retains the bounded description for the
  // user-facing history.
  return value.map(({ description: _description, ...link }) => link);
}

function boundedClaudeNativeIdentifier(value: unknown, identityKind: string): string | undefined {
  const normalized = trimmedStringValue(value);
  if (!normalized) return undefined;
  // Native diagnostics need correlation, not provider-owned cursors. Hash the
  // complete value with a field-specific domain so logs cannot disclose a
  // session/task/tool key or collide identities from different namespaces.
  return `sha256:${createHash("sha256")
    .update("cafecode/claude/native-diagnostic-identity/v1", "utf8")
    .update("\0", "utf8")
    .update(identityKind, "utf8")
    .update("\0", "utf8")
    .update(normalized, "utf8")
    .digest("hex")}`;
}

function claudeNativeKeyCarriesProviderIdentity(key: string): boolean {
  const normalized = key.toLocaleLowerCase().replaceAll("-", "_");
  return (
    normalized === "id" ||
    normalized === "uuid" ||
    normalized.endsWith("_id") ||
    normalized.endsWith("_uuid") ||
    /(?:Id|Uuid)$/.test(key)
  );
}

/**
 * Native logs are an operational aid, not a transcript/session cursor store.
 * Recursively hash provider-owned identities even for forward-compatible SDK
 * frames whose complete payload is otherwise retained. This covers nested
 * message/tool/content-block ids as well as the top-level session/UUID fields.
 */
function redactClaudeNativeProviderIdentities(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (depth > 32) return "[omitted:depth-limit]";
  if (Array.isArray(value)) {
    return value.map((entry) => redactClaudeNativeProviderIdentities(entry, depth + 1, seen));
  }
  const record = recordValue(value);
  if (!record) return value;
  if (seen.has(record)) return "[omitted:circular]";
  seen.add(record);
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (claudeNativeKeyCarriesProviderIdentity(key) && typeof entry === "string") {
      redacted[key] = boundedClaudeNativeIdentifier(entry, `payload-${key}`);
    } else {
      redacted[key] = redactClaudeNativeProviderIdentities(entry, depth + 1, seen);
    }
  }
  return redacted;
}

function boundedClaudeNativeNumber(value: unknown, nonNegative = false): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integral = Math.trunc(value);
  return Math.max(
    nonNegative ? 0 : Number.MIN_SAFE_INTEGER,
    Math.min(Number.MAX_SAFE_INTEGER, integral),
  );
}

function boundedClaudeNativeTaskUsage(
  value: unknown,
): Readonly<Record<string, number>> | undefined {
  const usage = recordValue(value);
  if (!usage) return undefined;
  const totalTokens = boundedClaudeNativeNumber(usage.total_tokens, true);
  const toolUses = boundedClaudeNativeNumber(usage.tool_uses, true);
  const durationMs = boundedClaudeNativeNumber(usage.duration_ms, true);
  if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) {
    return undefined;
  }
  return {
    ...(totalTokens !== undefined ? { total_tokens: totalTokens } : {}),
    ...(toolUses !== undefined ? { tool_uses: toolUses } : {}),
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
  };
}

function boundedClaudeNativeTaskStatus(value: unknown): string | undefined {
  switch (value) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
    case "stopped":
    case "killed":
    case "paused":
      return value;
    default:
      return undefined;
  }
}

function boundedClaudeNativeSystemEnvelope(
  source: Readonly<Record<string, unknown>>,
  subtype: string,
): Readonly<Record<string, unknown>> {
  const uuid = boundedClaudeNativeIdentifier(source.uuid, "message-uuid");
  const sessionId = boundedClaudeNativeIdentifier(source.session_id, "session-id");
  return {
    type: "system",
    subtype,
    ...(uuid ? { uuid } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

/**
 * SDK 0.3.283 declares plugin_errors on init, including resolved local paths
 * for failed directory plugins. Names, messages, paths and unknown fields are
 * provider/plugin-controlled and must not enter durable configuration or logs.
 * Keep only fixed categories and counts. The 64-row inspection ceiling bounds
 * work on repeated init frames; the remaining count is explicitly uninspected.
 * An omitted field remains omitted because older and remote emitters can omit
 * plugin diagnostics even when a plugin did not load.
 */
function boundedClaudeInitPluginDiagnostics(
  source: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const {
    plugin_errors: pluginErrors,
    // This is Cafe-owned diagnostic metadata, never an upstream passthrough.
    plugin_error_summary: _untrustedSummary,
    ...diagnostic
  } = source;
  if (pluginErrors === undefined) return diagnostic;

  const categories = {
    "path-not-found": 0,
    "manifest-validation-error": 0,
    "dependency-unsatisfied": 0,
    "hook-load-failed": 0,
    "generic-error": 0,
    malformed: 0,
    uninspected: 0,
  };
  if (!Array.isArray(pluginErrors)) {
    categories.malformed = 1;
    return { ...diagnostic, plugin_error_summary: { count: 1, categories } };
  }

  const inspectedCount = Math.min(pluginErrors.length, 64);
  for (let index = 0; index < inspectedCount; index += 1) {
    const error = recordValue(pluginErrors[index]);
    if (!error || typeof error.type !== "string") {
      categories.malformed += 1;
      continue;
    }
    // An open-set native category must never become an arbitrary object key.
    // Unknown/new categories remain a generic failure until explicitly audited.
    switch (error.type) {
      case "path-not-found":
      case "manifest-validation-error":
      case "dependency-unsatisfied":
      case "hook-load-failed":
        categories[error.type] += 1;
        break;
      default:
        categories["generic-error"] += 1;
    }
  }
  categories.uninspected = pluginErrors.length - inspectedCount;
  return {
    ...diagnostic,
    plugin_error_summary: { count: pluginErrors.length, categories },
  };
}

function boundedClaudeNativeMessagePayload(message: SDKMessage): unknown {
  const source = message as unknown as Record<string, unknown>;
  if (source.type === "user") {
    const parentToolUseId = boundedClaudeNativeIdentifier(
      source.parent_tool_use_id,
      "parent-tool-use-id",
    );
    const resourceLinks = boundedClaudeNativeResourceLinks(claudeForegroundResourceLinks(message));
    const content = recordValue(source.message)?.content;
    const toolResultCount = Array.isArray(content)
      ? content.filter((entry) => recordValue(entry)?.type === "tool_result").length
      : 0;
    return {
      type: "user",
      ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
      ...(typeof source.isSynthetic === "boolean" ? { isSynthetic: source.isSynthetic } : {}),
      ...(source.priority === "now" || source.priority === "next" || source.priority === "later"
        ? { priority: source.priority }
        : {}),
      ...(typeof source.shouldQuery === "boolean" ? { shouldQuery: source.shouldQuery } : {}),
      ...(toolResultCount > 0 ? { tool_result_count: toolResultCount } : {}),
      ...(resourceLinks ? { resource_links: resourceLinks } : {}),
    };
  }
  if (source.type === "assistant" && source.task_description !== undefined) {
    return {
      ...source,
      task_description: boundedClaudeProviderText(
        source.task_description,
        CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
      ),
    };
  }
  if (source.type === "tool_use_summary") {
    return {
      ...source,
      summary: boundedClaudeProviderText(source.summary, CLAUDE_TASK_SUMMARY_TEXT_LIMIT),
    };
  }
  if (source.type === "active_goal") {
    return {
      ...source,
      goal: boundedClaudeProviderText(source.goal, CLAUDE_TASK_SUMMARY_TEXT_LIMIT),
      objective: boundedClaudeProviderText(source.objective, CLAUDE_TASK_SUMMARY_TEXT_LIMIT),
      title: boundedClaudeProviderText(source.title, CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT),
      description: boundedClaudeProviderText(
        source.description,
        CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
      ),
    };
  }
  if (source.type !== "system") return message;

  switch (source.subtype) {
    case "init":
      return boundedClaudeInitPluginDiagnostics(source);
    case "hook_started": {
      const hookId = boundedClaudeNativeIdentifier(source.hook_id, "hook-id");
      const hookName = boundedClaudeProviderText(source.hook_name, 256);
      const hookEvent = boundedClaudeProviderText(source.hook_event, 256);
      return {
        ...boundedClaudeNativeSystemEnvelope(source, "hook_started"),
        ...(hookId ? { hook_id: hookId } : {}),
        ...(hookName ? { hook_name: hookName } : {}),
        ...(hookEvent ? { hook_event: hookEvent } : {}),
      };
    }
    case "hook_progress": {
      const hookId = boundedClaudeNativeIdentifier(source.hook_id, "hook-id");
      const hookName = boundedClaudeProviderText(source.hook_name, 256);
      const hookEvent = boundedClaudeProviderText(source.hook_event, 256);
      const output = boundedClaudeProviderText(source.output, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
      const stdout = boundedClaudeProviderText(source.stdout, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
      const stderr = boundedClaudeProviderText(source.stderr, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
      return {
        ...boundedClaudeNativeSystemEnvelope(source, "hook_progress"),
        ...(hookId ? { hook_id: hookId } : {}),
        ...(hookName ? { hook_name: hookName } : {}),
        ...(hookEvent ? { hook_event: hookEvent } : {}),
        ...(output ? { output } : {}),
        ...(stdout ? { stdout } : {}),
        ...(stderr ? { stderr } : {}),
      };
    }
    case "hook_response": {
      const hookId = boundedClaudeNativeIdentifier(source.hook_id, "hook-id");
      const hookName = boundedClaudeProviderText(source.hook_name, 256);
      const hookEvent = boundedClaudeProviderText(source.hook_event, 256);
      const output = boundedClaudeProviderText(source.output, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
      const stdout = boundedClaudeProviderText(source.stdout, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
      const stderr = boundedClaudeProviderText(source.stderr, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
      const exitCode = boundedClaudeNativeNumber(source.exit_code);
      const outcome =
        source.outcome === "success" || source.outcome === "error" || source.outcome === "cancelled"
          ? source.outcome
          : undefined;
      return {
        ...boundedClaudeNativeSystemEnvelope(source, "hook_response"),
        ...(hookId ? { hook_id: hookId } : {}),
        ...(hookName ? { hook_name: hookName } : {}),
        ...(hookEvent ? { hook_event: hookEvent } : {}),
        ...(outcome ? { outcome } : {}),
        ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
        ...(output ? { output } : {}),
        ...(stdout ? { stdout } : {}),
        ...(stderr ? { stderr } : {}),
      };
    }
    case "task_started": {
      const taskId = boundedClaudeNativeIdentifier(source.task_id, "task-id");
      const toolUseId = boundedClaudeNativeIdentifier(source.tool_use_id, "tool-use-id");
      const description = boundedClaudeProviderText(
        source.description,
        CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
      );
      const subagentType = boundedClaudeProviderText(
        source.subagent_type,
        CLAUDE_SUBAGENT_ROLE_LIMIT,
      );
      const taskType = boundedClaudeProviderText(source.task_type, 120);
      const workflowName = boundedClaudeProviderText(source.workflow_name, 120);
      const spawnDepth = boundedClaudeNativeNumber(source.spawn_depth, true);
      return {
        ...boundedClaudeNativeSystemEnvelope(source, "task_started"),
        ...(taskId ? { task_id: taskId } : {}),
        ...(toolUseId ? { tool_use_id: toolUseId } : {}),
        ...(description ? { description } : {}),
        ...(subagentType ? { subagent_type: subagentType } : {}),
        ...(taskType ? { task_type: taskType } : {}),
        ...(workflowName ? { workflow_name: workflowName } : {}),
        ...(spawnDepth !== undefined ? { spawn_depth: spawnDepth } : {}),
        ...(typeof source.is_backgrounded === "boolean"
          ? { is_backgrounded: source.is_backgrounded }
          : {}),
        ...(typeof source.skip_transcript === "boolean"
          ? { skip_transcript: source.skip_transcript }
          : {}),
        ...(typeof source.ambient === "boolean" ? { ambient: source.ambient } : {}),
      };
    }
    case "task_progress": {
      const taskId = boundedClaudeNativeIdentifier(source.task_id, "task-id");
      const toolUseId = boundedClaudeNativeIdentifier(source.tool_use_id, "tool-use-id");
      const description = boundedClaudeProviderText(
        source.description,
        CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
      );
      const summary = boundedClaudeProviderText(source.summary, CLAUDE_TASK_SUMMARY_TEXT_LIMIT);
      const subagentType = boundedClaudeProviderText(
        source.subagent_type,
        CLAUDE_SUBAGENT_ROLE_LIMIT,
      );
      const lastToolName = boundedClaudeProviderText(
        source.last_tool_name,
        CLAUDE_TASK_TOOL_NAME_TEXT_LIMIT,
      );
      const usage = boundedClaudeNativeTaskUsage(source.usage);
      return {
        ...boundedClaudeNativeSystemEnvelope(source, "task_progress"),
        ...(taskId ? { task_id: taskId } : {}),
        ...(toolUseId ? { tool_use_id: toolUseId } : {}),
        ...(description ? { description } : {}),
        ...(summary ? { summary } : {}),
        ...(subagentType ? { subagent_type: subagentType } : {}),
        ...(lastToolName ? { last_tool_name: lastToolName } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    case "task_notification": {
      const taskId = boundedClaudeNativeIdentifier(source.task_id, "task-id");
      const toolUseId = boundedClaudeNativeIdentifier(source.tool_use_id, "tool-use-id");
      const status = boundedClaudeNativeTaskStatus(source.status);
      const resourceProjection = projectClaudeResourceLinks(source.resource_links);
      const summary = resourceProjection.hasUninspectedEntries
        ? CLAUDE_RESOURCE_LINK_OVERFLOW_TASK_SUMMARY
        : boundedClaudeProviderText(source.summary, CLAUDE_TASK_SUMMARY_TEXT_LIMIT);
      const usage = boundedClaudeNativeTaskUsage(source.usage);
      const resourceLinks = boundedClaudeNativeResourceLinks(resourceProjection.links);
      return {
        ...boundedClaudeNativeSystemEnvelope(source, "task_notification"),
        ...(taskId ? { task_id: taskId } : {}),
        ...(toolUseId ? { tool_use_id: toolUseId } : {}),
        ...(status ? { status } : {}),
        ...(summary ? { summary } : {}),
        ...(usage ? { usage } : {}),
        ...(resourceLinks ? { resource_links: resourceLinks } : {}),
        ...(typeof source.skip_transcript === "boolean"
          ? { skip_transcript: source.skip_transcript }
          : {}),
        ...(typeof source.ambient === "boolean" ? { ambient: source.ambient } : {}),
      };
    }
    case "task_updated": {
      const patch = recordValue(source.patch);
      const taskId = boundedClaudeNativeIdentifier(source.task_id, "task-id");
      const toolUseId = boundedClaudeNativeIdentifier(source.tool_use_id, "tool-use-id");
      const patchStatus = boundedClaudeNativeTaskStatus(patch?.status);
      const patchDescription = boundedClaudeProviderText(
        patch?.description,
        CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
      );
      const patchSummary = boundedClaudeProviderText(
        patch?.summary,
        CLAUDE_TASK_SUMMARY_TEXT_LIMIT,
      );
      const patchError = boundedClaudeProviderText(patch?.error, CLAUDE_TASK_SUMMARY_TEXT_LIMIT);
      const patchLastToolName = boundedClaudeProviderText(
        patch?.last_tool_name,
        CLAUDE_TASK_TOOL_NAME_TEXT_LIMIT,
      );
      const patchSubagentType = boundedClaudeProviderText(
        patch?.subagent_type,
        CLAUDE_SUBAGENT_ROLE_LIMIT,
      );
      const patchTaskType = boundedClaudeProviderText(patch?.task_type, 120);
      const patchUsage = boundedClaudeNativeTaskUsage(patch?.usage);
      const patchSpawnDepth = boundedClaudeNativeNumber(patch?.spawn_depth, true);
      const patchEndTime = boundedClaudeNativeNumber(patch?.end_time, true);
      const patchPausedMs = boundedClaudeNativeNumber(patch?.total_paused_ms, true);
      return {
        ...boundedClaudeNativeSystemEnvelope(source, "task_updated"),
        ...(taskId ? { task_id: taskId } : {}),
        ...(toolUseId ? { tool_use_id: toolUseId } : {}),
        patch: {
          ...(patchStatus ? { status: patchStatus } : {}),
          ...(patchDescription ? { description: patchDescription } : {}),
          ...(patchSummary ? { summary: patchSummary } : {}),
          ...(patchError ? { error: patchError } : {}),
          ...(patchLastToolName ? { last_tool_name: patchLastToolName } : {}),
          ...(patchSubagentType ? { subagent_type: patchSubagentType } : {}),
          ...(patchTaskType ? { task_type: patchTaskType } : {}),
          ...(patchUsage ? { usage: patchUsage } : {}),
          ...(patchSpawnDepth !== undefined ? { spawn_depth: patchSpawnDepth } : {}),
          ...(patchEndTime !== undefined ? { end_time: patchEndTime } : {}),
          ...(patchPausedMs !== undefined ? { total_paused_ms: patchPausedMs } : {}),
          ...(typeof patch?.is_backgrounded === "boolean"
            ? { is_backgrounded: patch.is_backgrounded }
            : {}),
          ...(typeof patch?.skip_transcript === "boolean"
            ? { skip_transcript: patch.skip_transcript }
            : {}),
          ...(typeof patch?.ambient === "boolean" ? { ambient: patch.ambient } : {}),
        },
        ...(typeof source.skip_transcript === "boolean"
          ? { skip_transcript: source.skip_transcript }
          : {}),
        ...(typeof source.ambient === "boolean" ? { ambient: source.ambient } : {}),
      };
    }
    case "background_tasks_changed": {
      return {
        ...boundedClaudeNativeSystemEnvelope(source, "background_tasks_changed"),
        tasks: Array.isArray(source.tasks)
          ? source.tasks.slice(0, CLAUDE_TASK_BINDING_LIMIT).flatMap((task) => {
              const record = recordValue(task);
              if (!record) return [];
              const taskId = boundedClaudeNativeIdentifier(record.task_id, "task-id");
              const taskType = boundedClaudeProviderText(record.task_type, 120);
              const description = boundedClaudeProviderText(
                record.description,
                CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
              );
              return [
                {
                  ...(taskId ? { task_id: taskId } : {}),
                  ...(taskType ? { task_type: taskType } : {}),
                  ...(description ? { description } : {}),
                  ...(typeof record.ambient === "boolean" ? { ambient: record.ambient } : {}),
                },
              ];
            })
          : [],
      };
    }
    case "task_summary": {
      const detailRecord = recordValue(source.detail);
      const detail = boundedClaudeProviderText(
        source.detail ??
          detailRecord?.summary ??
          detailRecord?.detail ??
          detailRecord?.text ??
          detailRecord?.description,
        CLAUDE_TASK_SUMMARY_TEXT_LIMIT,
      );
      const taskId = boundedClaudeNativeIdentifier(source.task_id, "task-id");
      const agentId = boundedClaudeNativeIdentifier(source.agent_id, "agent-id");
      return {
        ...boundedClaudeNativeSystemEnvelope(source, "task_summary"),
        ...(taskId ? { task_id: taskId } : {}),
        ...(agentId ? { agent_id: agentId } : {}),
        ...(detail ? { detail } : {}),
      };
    }
    default:
      return message;
  }
}

function claudeSubagentStartedAtFromUsage(createdAt: string, usage: unknown): string | undefined {
  const usageRecord = recordValue(usage);
  const durationMs = usageRecord?.duration_ms;
  const completedAtMs = Date.parse(createdAt);
  if (
    typeof durationMs !== "number" ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    !Number.isFinite(completedAtMs)
  ) {
    return undefined;
  }
  // Provider duration is display metadata, not an authority boundary. Clamp a
  // malformed value so it cannot manufacture an ancient clock or overflow a
  // Date while still covering Cafe's multi-week session target comfortably.
  const boundedDurationMs = Math.min(durationMs, CLAUDE_SUBAGENT_MAX_INFERRED_DURATION_MS);
  return new Date(Math.max(0, completedAtMs - boundedDurationMs)).toISOString();
}

function claudeSubagentLabel(binding: ClaudeTaskBinding): string | undefined {
  const description = claudeSubagentDisplayLine(binding.description, CLAUDE_SUBAGENT_LABEL_LIMIT);
  if (description) return description;
  const role = claudeSubagentDisplayLine(binding.subagentType, CLAUDE_SUBAGENT_ROLE_LIMIT);
  if (!role) return undefined;
  const normalized = role.replace(/[_-]+/gu, " ").toLocaleLowerCase();
  return `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}`;
}

function claudeSubagentPresentation(
  binding: ClaudeTaskBinding | undefined,
  status: RuntimeSubagentPresentation["status"],
): RuntimeSubagentPresentation | undefined {
  if (!binding?.isSubagent) return undefined;
  const label = claudeSubagentLabel(binding);
  const role = claudeSubagentDisplayLine(binding.subagentType, CLAUDE_SUBAGENT_ROLE_LIMIT);
  const objective = claudeSubagentDisplayLine(binding.objective, CLAUDE_SUBAGENT_OBJECTIVE_LIMIT);
  return {
    threadId: String(binding.taskId),
    ...(binding.historyId ? { historyId: binding.historyId } : {}),
    ...(label ? { label } : {}),
    ...(role ? { role } : {}),
    ...(objective ? { objective } : {}),
    ...(status ? { status } : {}),
    ...(binding.startedAt ? { startedAt: binding.startedAt } : {}),
  };
}

function claudeSubagentStatus(value: unknown): RuntimeSubagentPresentation["status"] {
  const status = trimmedStringValue(value)?.toLocaleLowerCase();
  if (status === "pending" || status === "paused") return "waiting";
  if (status === "failed" || status === "error") return "failed";
  if (status === "killed" || status === "stopped" || status === "cancelled") return "stopped";
  if (status === "completed") return "completed";
  return "active";
}

function hideClaudeTaskFromTranscript(context: ClaudeSessionContext, taskId: string): void {
  const canonicalTaskId = canonicalClaudeTaskId(taskId);
  if (!canonicalTaskId) {
    return;
  }
  rememberBoundedClaudeKey(
    context.hiddenTranscriptTaskIds,
    String(canonicalTaskId),
    CLAUDE_HIDDEN_TRANSCRIPT_TASK_LIMIT,
  );
}

function setClaudeTaskFallbackVisibilityByKey(
  context: ClaudeSessionContext,
  canonicalTaskKey: string,
  visibility: RuntimeTaskVisibility,
  authority: ClaudeTaskVisibilityAuthority = "provider",
): void {
  if (visibility === "ambient") {
    if (authority === "snapshot-retraction") {
      // Provider-authored ambient/skip_transcript is a stronger and durable
      // visibility instruction. Snapshot omission is redundant in that case
      // and must not replace the provider authority with a weaker fallback.
      if (context.hiddenTranscriptTaskIds.has(canonicalTaskKey)) {
        return;
      }
      const snapshotFallbackWillEvict =
        !context.snapshotRetractedTaskIds.has(canonicalTaskKey) &&
        context.snapshotRetractedTaskIds.size >= CLAUDE_HIDDEN_TRANSCRIPT_TASK_LIMIT;
      rememberBoundedClaudeKey(
        context.snapshotRetractedTaskIds,
        canonicalTaskKey,
        CLAUDE_HIDDEN_TRANSCRIPT_TASK_LIMIT,
      );
      context.failClosedTaskVisibilityOverflow ||= snapshotFallbackWillEvict;
    } else {
      const hiddenFallbackWillEvict =
        !context.hiddenTranscriptTaskIds.has(canonicalTaskKey) &&
        context.hiddenTranscriptTaskIds.size >= CLAUDE_HIDDEN_TRANSCRIPT_TASK_LIMIT;
      rememberBoundedClaudeKey(
        context.hiddenTranscriptTaskIds,
        canonicalTaskKey,
        CLAUDE_HIDDEN_TRANSCRIPT_TASK_LIMIT,
      );
      context.failClosedTaskVisibilityOverflow ||= hiddenFallbackWillEvict;
      context.snapshotRetractedTaskIds.delete(canonicalTaskKey);
    }
    return;
  }
  if (authority === "provider") {
    context.hiddenTranscriptTaskIds.delete(canonicalTaskKey);
  }
  context.snapshotRetractedTaskIds.delete(canonicalTaskKey);
}

function markClaudeTaskTerminal(context: ClaudeSessionContext, binding: ClaudeTaskBinding): void {
  const taskKey = String(binding.taskId);
  rememberBoundedClaudeKey(context.terminalTaskIds, taskKey, CLAUDE_TASK_BINDING_LIMIT);
  // The task is no longer live even if Claude's next level snapshot has not
  // arrived yet. Removing membership here makes both supported event orders
  // converge on the same terminal state.
  context.backgroundTaskIds.delete(taskKey);
  context.backgroundTaskBindings.delete(taskKey);
}

function setClaudeTaskFallbackVisibility(
  context: ClaudeSessionContext,
  providerTaskId: string,
  visibility: RuntimeTaskVisibility,
): void {
  const canonicalTaskId = canonicalClaudeTaskId(providerTaskId);
  if (!canonicalTaskId) return;
  setClaudeTaskFallbackVisibilityByKey(context, String(canonicalTaskId), visibility);
}

function claudeTaskVisibilityForProviderTaskId(
  context: ClaudeSessionContext,
  taskId: string | undefined,
): RuntimeTaskVisibility {
  const canonicalTaskId = canonicalClaudeTaskId(taskId);
  if (!canonicalTaskId) return "visible";
  const key = String(canonicalTaskId);
  return (
    context.taskBindingsByTaskId.get(key)?.visibilityState.visibility ??
    (context.hiddenTranscriptTaskIds.has(key) ||
    context.snapshotRetractedTaskIds.has(key) ||
    context.failClosedTaskVisibilityOverflow
      ? "ambient"
      : "visible")
  );
}

function claudeTaskVisibilityForBinding(
  _context: ClaudeSessionContext,
  binding: ClaudeTaskBinding,
): RuntimeTaskVisibility {
  return binding.visibilityState.visibility;
}

function isClaudeNestedStreamHidden(
  context: ClaudeSessionContext,
  parentToolUseId: string | undefined,
): boolean {
  if (parentToolUseId === undefined) {
    return false;
  }
  const toolUseKey = canonicalClaudeToolUseBindingKey(parentToolUseId);
  const binding = toolUseKey ? context.taskBindingsByToolUseId.get(toolUseKey) : undefined;
  // `binding.taskId` is already canonical. Looking it up directly avoids
  // re-hashing Cafe's reserved digest namespace as if it came from Claude.
  return (
    binding !== undefined &&
    (context.hiddenTranscriptTaskIds.has(String(binding.taskId)) ||
      context.snapshotRetractedTaskIds.has(String(binding.taskId)) ||
      claudeTaskVisibilityForBinding(context, binding) === "ambient")
  );
}

function isClaudeCommandLifecycleState(value: unknown): value is ClaudeCommandLifecycleState {
  return (
    value === "queued" ||
    value === "started" ||
    value === "completed" ||
    value === "cancelled" ||
    value === "discarded"
  );
}

function readClaudeCommandLifecycleMessage(
  value: unknown,
): ClaudeCommandLifecycleMessage | undefined {
  const record = recordValue(value);
  if (
    record?.type !== "command_lifecycle" ||
    trimmedStringValue(record.command_uuid) === undefined ||
    !isClaudeCommandLifecycleState(record.state)
  ) {
    return undefined;
  }

  return record as ClaudeCommandLifecycleMessage;
}

function isTerminalClaudeCommandLifecycleState(state: ClaudeCommandLifecycleState): boolean {
  return state === "completed" || state === "cancelled" || state === "discarded";
}

/** Only turn-retiring frames fence explicit priority; ordinary deltas remain deliverable. */
function isClaudePriorityTurnBoundaryMessage(message: SDKMessage): boolean {
  if (message.type === "result") return true;
  const lifecycle = readClaudeCommandLifecycleMessage(message);
  return lifecycle !== undefined && isTerminalClaudeCommandLifecycleState(lifecycle.state);
}

type ClaudePromptCorrelation = {
  readonly user_message_uuid?: unknown;
  readonly user_message_uuids?: unknown;
};

function knownClaudePromptUuids(
  context: ClaudeSessionContext,
  message: ClaudePromptCorrelation,
): ReadonlyArray<string> | undefined {
  if (message.user_message_uuid === undefined && message.user_message_uuids === undefined) {
    return undefined;
  }

  const known = new Set<string>();
  const admit = (value: unknown) => {
    // Inputs are exact Cafe-minted UUIDs. Do not trim, invent, or retain an
    // unknown provider identity; the short length gate also bounds map hashing.
    if (
      typeof value === "string" &&
      value.length === 36 &&
      context.promptLifecycleByUuid.has(value)
    ) {
      known.add(value);
    }
  };
  if (Array.isArray(message.user_message_uuids)) {
    for (const uuid of message.user_message_uuids.slice(0, CLAUDE_PROMPT_CORRELATION_LIMIT)) {
      admit(uuid);
    }
  }
  // The singular representative is always part of a valid upstream batch.
  // Retain it independently for older producers and malformed/incomplete lists.
  admit(message.user_message_uuid);
  return [...known];
}

function claudeResultQueuedTurnCount(result: SDKResultMessage): number | undefined {
  const value = (result as Record<string, unknown>).queued_turn_count;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function acknowledgeKnownClaudePromptsStarted(
  context: ClaudeSessionContext,
  message: ClaudePromptCorrelation,
): void {
  // SDK 0.3.265+ can stamp another reply when a synthetic/auto-resume turn
  // folds in a different host message. Inspect every primary reply, not just
  // the first frame of a Cafe turn: Cafe's turn can span several native response
  // segments, and an upstream meta UUID is never proof of owned user input.
  // The public 0.3.266 SDKAssistantMessage / SDKPartialAssistantMessage types
  // describe this switch rule; the SDK forwards the native stamps unchanged.
  for (const messageUuid of knownClaudePromptUuids(context, message) ?? []) {
    const current = context.promptLifecycleByUuid.get(messageUuid);
    // Only outstanding submitted/queued inputs may advance. Replayed reply
    // stamps for already-started or retired input cannot revive old work.
    if (current !== "submitted" && current !== "queued") continue;
    context.promptLifecycleByUuid.set(messageUuid, "started");
    // A reply or correlated thinking frame proves a later response segment
    // started. Its predecessor's deferred result cannot complete this segment.
    context.deferredTurnResult = undefined;
  }
}

/**
 * Retire exactly the Cafe-owned inputs represented by a Claude result.
 *
 * SDK 0.3.259's `user_message_uuids` includes both the initial merged batch and
 * later inputs folded into this response between tool rounds. The singular
 * `user_message_uuid` represents only one member, not every answered steer.
 * Source: SDKAssistantMessage / SDKPartialAssistantMessage / SDKResultMessage
 * in @anthropic-ai/claude-agent-sdk@0.3.266/sdk.d.ts and upstream changelog:
 * https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md
 * Since 0.3.265 this includes host inputs folded into synthetic/auto-resume
 * turns, and a zero-inference success (for example a slash command) still
 * carries its singular UUID. Neither path requires an earlier reply frame.
 * Older CLIs and error results can omit correlation, so the compatibility path
 * retires the oldest input Claude has acknowledged as started. A final fallback
 * handles pre-2.1.206 runtimes that do not emit command lifecycle frames at all.
 * Explicit but unknown/malformed correlation must never take that fallback:
 * a late replay or another producer's result cannot consume unrelated input.
 * Map insertion order is the provider input order and is never reconstructed
 * from prompt text, keeping this boundary content-blind and deterministic.
 */
function consumeClaudeResultPrompt(
  context: ClaudeSessionContext,
  result: SDKResultMessage,
): number {
  const correlatedUuids = knownClaudePromptUuids(context, result);
  if (correlatedUuids !== undefined) {
    for (const uuid of correlatedUuids) context.promptLifecycleByUuid.delete(uuid);
    return correlatedUuids.length;
  }

  // Claude Code 2.1.274 coalesces queued background completions into one model
  // call, but still emits an empty successful zero-turn result for each held
  // notification. Those provider-owned results carry task-notification origin
  // and no client UUID: they are not acknowledgements of a queued Cafe prompt.
  // Do not let the older uncorrelated-result fallback consume user input here.
  // Explicit correlation above remains authoritative when a synthetic turn
  // actually folds in a Cafe message; missing/older origin keeps compatibility.
  // Source: 0.3.274 SDK changelog and its paired CLI queue-drain/result emitter.
  if (
    result.subtype === "success" &&
    result.is_error === false &&
    result.num_turns === 0 &&
    result.result === "" &&
    result.origin?.kind === "task-notification"
  ) {
    return 0;
  }

  const started = Array.from(context.promptLifecycleByUuid).find(
    ([, state]) => state === "started",
  );
  const fallback = started ?? context.promptLifecycleByUuid.entries().next().value;
  if (fallback === undefined) {
    return 0;
  }

  const [messageUuid] = fallback;
  context.promptLifecycleByUuid.delete(messageUuid);
  return 1;
}

function claudeTaskTerminalStatus(value: unknown): "completed" | "failed" | "stopped" | undefined {
  const status = trimmedStringValue(value)?.toLowerCase();
  if (status === "completed" || status === "failed" || status === "stopped") {
    return status;
  }
  if (status === "killed" || status === "cancelled" || status === "canceled") {
    return "stopped";
  }
  return undefined;
}

function runtimeStateFromClaudeSessionState(
  state: "idle" | "running" | "requires_action",
): RuntimeSessionState {
  switch (state) {
    case "idle":
      return "ready";
    case "running":
      return "running";
    case "requires_action":
      return "waiting";
  }
}

function resultPrimaryError(result: SDKResultMessage): string | undefined {
  if ("errors" in result && Array.isArray(result.errors)) {
    const first = result.errors.find((entry): entry is string => typeof entry === "string");
    if (first && first.trim().length > 0) {
      return first;
    }
  }

  const resultText = (result as { readonly result?: unknown }).result;
  return typeof resultText === "string" && resultText.trim().length > 0 ? resultText : undefined;
}

function isClaudeAuthFailureResult(message: SDKMessage): message is SDKResultMessage {
  if (message.type !== "result") {
    return false;
  }
  const record = message as Record<string, unknown>;
  return (
    message.is_error === true &&
    (record.api_error_status === 401 ||
      resultPrimaryError(message)?.toLowerCase().includes("invalid authentication credentials") ===
        true)
  );
}

function isClaudeAuthFailureAssistantMessage(message: SDKMessage): boolean {
  if (message.type !== "assistant") {
    return false;
  }
  const record = message as Record<string, unknown>;
  if (record.error === "authentication_failed") {
    return true;
  }

  const content = message.message?.content;
  return (
    Array.isArray(content) &&
    content.some((block) => {
      if (!block || typeof block !== "object") {
        return false;
      }
      const text = (block as { readonly text?: unknown }).text;
      return (
        typeof text === "string" &&
        text.toLowerCase().includes("invalid authentication credentials")
      );
    })
  );
}

function hasDurableClaudeSessionId(message: SDKMessage): boolean {
  if (isZeroTurnClaudeExecutionFailure(message) || isClaudeAuthFailureResult(message)) {
    // Claude Code may allocate a brand-new session id for pre-turn failures
    // such as an invalid resume cursor, then report `error_during_execution`
    // with `num_turns: 0`. That id does not represent the user's durable
    // conversation and must not replace the previous resume session.
    return false;
  }

  if (message.type !== "system") {
    return true;
  }

  return (
    message.subtype !== "hook_started" &&
    message.subtype !== "hook_progress" &&
    message.subtype !== "hook_response"
  );
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function toProcessError(
  cause: unknown,
  fallback: string,
  threadId: ThreadId,
): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: toMessage(cause, fallback),
    cause,
  });
}

function normalizeClaudeStreamMessages(
  cause: Cause.Cause<{ readonly message: string }>,
): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function getEffectiveClaudeAgentEffort(effort: string | null | undefined): ClaudeSdkEffort | null {
  const normalized = normalizeClaudeCliEffort(effort);
  return normalized ? (normalized as ClaudeSdkEffort) : null;
}

export function resolveClaudeModelSessionOptions(
  modelSelection: ModelSelection | undefined,
  nativeCapabilities?: ModelCapabilities,
): {
  readonly apiModelId: string | undefined;
  readonly selectedContextWindowTokens: number | undefined;
  readonly effectiveEffort: ClaudeSdkEffort | null;
  readonly agentProgressSummaries: boolean;
  readonly settings: {
    readonly alwaysThinkingEnabled?: boolean;
    readonly fastMode?: boolean;
    readonly outputStyle?: "Concise";
  };
} {
  const caps = nativeCapabilities ?? getClaudeModelCapabilities(modelSelection?.model);
  const descriptors = getProviderOptionDescriptors({
    caps,
    selections: modelSelection?.options,
  });
  const rawEffort = getModelSelectionStringOptionValue(modelSelection, "effort");
  const effort = resolveClaudeSessionEffort(caps, rawEffort) ?? null;
  const fastModeSupported = descriptors.some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
  );
  const thinkingSupported = descriptors.some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "thinking",
  );
  const outputStyle = getProviderOptionCurrentValue(
    descriptors.find(
      (descriptor) => descriptor.type === "select" && descriptor.id === "outputStyle",
    ),
  );
  const agentProgressSummaries = getProviderOptionCurrentValue(
    descriptors.find(
      (descriptor) => descriptor.type === "boolean" && descriptor.id === "agentProgressSummaries",
    ),
  );
  const fastMode = fastModeSupported
    ? getModelSelectionBooleanOptionValue(modelSelection, "fastMode")
    : undefined;
  const thinking = thinkingSupported
    ? getModelSelectionBooleanOptionValue(modelSelection, "thinking")
    : undefined;

  return {
    apiModelId: modelSelection ? resolveClaudeApiModelId(modelSelection) : undefined,
    selectedContextWindowTokens: resolveClaudeSelectedContextWindowTokens(modelSelection),
    effectiveEffort: getEffectiveClaudeAgentEffort(effort),
    agentProgressSummaries: agentProgressSummaries !== false,
    settings: {
      ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
      // An explicit false must override a persisted Claude fast-mode setting.
      // Omitting it would let the native settings layer silently re-enable the
      // premium mode after the user selected normal mode in Cafe. Absence still
      // delegates to upstream, and unsupported models keep ignoring stale values.
      ...(typeof fastMode === "boolean" ? { fastMode } : {}),
      // Output-style names enter Claude's system prompt. Forward only the
      // built-in value Cafe advertises; never treat a persisted arbitrary
      // string as an inline Claude settings fragment.
      ...(outputStyle === "concise" ? { outputStyle: "Concise" as const } : {}),
    },
  };
}

function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

function isClaudeInterruptedCause(cause: Cause.Cause<{ readonly message: string }>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

function messageFromClaudeStreamCause(
  cause: Cause.Cause<{ readonly message: string }>,
  fallback: string,
): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

function interruptionMessageFromClaudeCause(
  cause: Cause.Cause<{ readonly message: string }>,
): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

function resultErrorsText(result: SDKResultMessage): string {
  const errors = "errors" in result && Array.isArray(result.errors) ? result.errors.join(" ") : "";
  const resultText = resultPrimaryError(result) ?? "";
  return `${errors} ${resultText}`.toLowerCase();
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.make(value);
}

function maxClaudeContextWindowFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;

  let maxContextWindow: number | undefined;
  for (const value of Object.values(modelUsage)) {
    const contextWindow = value.contextWindow;
    maxContextWindow = Math.max(maxContextWindow ?? 0, contextWindow);
  }

  return maxContextWindow;
}

/**
 * Agent SDK 0.3.258 reports `thinkingTokens` as a subset of output tokens in
 * each cumulative ModelUsage entry. Summing the per-model entries captures the
 * main loop plus Task subagents, sidechains, compaction, and workflows exactly
 * once; callers must never add this subset to output-token totals.
 */
function totalClaudeThinkingTokensFromModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): number | undefined {
  if (!modelUsage) return undefined;

  let observed = false;
  let total = 0;
  for (const value of Object.values(modelUsage)) {
    // Keep the cast until the repository's SDK declaration includes the
    // 0.3.258 field. Runtime messages from Claude Code 2.1.257+ already carry
    // it, and unknown/older payloads simply take the undefined compatibility
    // path below.
    const thinkingTokens = boundedClaudeNativeNumber(
      (value as unknown as Record<string, unknown>).thinkingTokens,
      true,
    );
    if (thinkingTokens === undefined) continue;
    observed = true;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + thinkingTokens);
  }

  return observed ? total : undefined;
}

function normalizeClaudeTokenUsage(
  value: unknown,
  contextWindow?: number,
  options?: { readonly resetPerMessageCounters?: boolean },
): ThreadTokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const freshInputTokens =
    typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : 0;
  const cacheCreationInputTokens =
    typeof usage.cache_creation_input_tokens === "number" &&
    Number.isFinite(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : 0;
  const cacheReadInputTokens =
    typeof usage.cache_read_input_tokens === "number" &&
    Number.isFinite(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0;
  const inputTokens = freshInputTokens + cacheCreationInputTokens + cacheReadInputTokens;
  const reportedOutputTokens =
    typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : undefined;
  const outputTokens = reportedOutputTokens ?? 0;
  const outputTokenDetails = recordValue(usage.output_tokens_details);
  const reportedThinkingTokens = boundedClaudeNativeNumber(
    outputTokenDetails?.thinking_tokens ?? usage.thinking_tokens,
    true,
  );
  // Claude reports thinking as a subset of output. Clamp defensively so a
  // malformed forward-compatible frame cannot make downstream accounting add
  // more reasoning than the provider's own output total.
  const reasoningOutputTokens =
    reportedThinkingTokens !== undefined
      ? Math.min(reportedThinkingTokens, Math.max(0, Math.trunc(outputTokens)))
      : undefined;
  const derivedTotalProcessedTokens = inputTokens + outputTokens;
  const totalProcessedTokens =
    (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : undefined) ?? (derivedTotalProcessedTokens > 0 ? derivedTotalProcessedTokens : undefined);
  if (
    (totalProcessedTokens === undefined || totalProcessedTokens <= 0) &&
    options?.resetPerMessageCounters !== true
  ) {
    return undefined;
  }

  const maxTokens =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  const nonNegativeTotalProcessedTokens = Math.max(0, totalProcessedTokens ?? 0);
  const usedTokens =
    maxTokens !== undefined
      ? Math.min(nonNegativeTotalProcessedTokens, maxTokens)
      : nonNegativeTotalProcessedTokens;
  const includePerMessageOutput =
    reportedOutputTokens !== undefined || options?.resetPerMessageCounters === true;
  const normalizedReasoningOutputTokens =
    reasoningOutputTokens ?? (options?.resetPerMessageCounters === true ? 0 : undefined);

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(nonNegativeTotalProcessedTokens > usedTokens
      ? { totalProcessedTokens: nonNegativeTotalProcessedTokens }
      : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    // Anthropic reports the cache split alongside fresh input. `inputTokens`
    // above stays the combined figure so existing readers are unaffected;
    // these two are the subsets, which is what cost accounting needs since
    // cache reads and cache writes are priced differently from fresh input.
    ...(cacheReadInputTokens > 0 ? { cachedInputTokens: cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens > 0 ? { cacheWriteInputTokens: cacheCreationInputTokens } : {}),
    ...(includePerMessageOutput ? { outputTokens: Math.max(0, Math.trunc(outputTokens)) } : {}),
    ...(normalizedReasoningOutputTokens !== undefined
      ? {
          reasoningOutputTokens: normalizedReasoningOutputTokens,
          lastReasoningOutputTokens: normalizedReasoningOutputTokens,
        }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(typeof usage.tool_uses === "number" && Number.isFinite(usage.tool_uses)
      ? { toolUses: usage.tool_uses }
      : {}),
    ...(typeof usage.duration_ms === "number" && Number.isFinite(usage.duration_ms)
      ? { durationMs: usage.duration_ms }
      : {}),
  };
}

const CLAUDE_MESSAGE_USAGE_COUNTER_FIELDS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
] as const;

function hasClaudeMessageUsageCounters(value: unknown): boolean {
  const usage = recordValue(value);
  if (!usage) {
    return false;
  }

  return CLAUDE_MESSAGE_USAGE_COUNTER_FIELDS.some((key) => {
    const counter = usage[key];
    return typeof counter === "number" && Number.isFinite(counter);
  });
}

function normalizeClaudeMessageTokenUsage(
  value: unknown,
  contextWindow?: number,
  options?: { readonly resetPerMessageCounters?: boolean },
): ThreadTokenUsageSnapshot | undefined {
  // Claude task/subagent updates can also carry a `usage.total_tokens` shape,
  // but those counters describe the background task, not the main transcript's
  // current context window. Only message/result-style usage with Anthropic's
  // token fields is eligible for live context-window projection.
  return hasClaudeMessageUsageCounters(value)
    ? normalizeClaudeTokenUsage(value, contextWindow, options)
    : undefined;
}

function claudeStreamEventUsagePayload(message: SDKMessage): unknown {
  if (message.type !== "stream_event") {
    return undefined;
  }

  const event = recordValue(message.event);
  if (!event) {
    return undefined;
  }

  if (event.type === "message_start") {
    return recordValue(event.message)?.usage;
  }
  if (event.type === "message_delta") {
    return event.usage;
  }

  return undefined;
}

function claudeAssistantUsagePayload(message: SDKMessage): unknown {
  if (message.type !== "assistant") {
    return undefined;
  }

  return recordValue(message.message)?.usage;
}

const THREAD_TOKEN_USAGE_SNAPSHOT_KEYS = [
  "usedTokens",
  "totalProcessedTokens",
  "maxTokens",
  "inputTokens",
  "cachedInputTokens",
  "totalReasoningOutputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "lastUsedTokens",
  "lastInputTokens",
  "lastCachedInputTokens",
  "lastOutputTokens",
  "lastReasoningOutputTokens",
  "toolUses",
  "durationMs",
  "compactsAutomatically",
  "autoCompactTokenLimit",
] as const satisfies ReadonlyArray<keyof ThreadTokenUsageSnapshot>;

function sameThreadTokenUsageSnapshot(
  left: ThreadTokenUsageSnapshot | undefined,
  right: ThreadTokenUsageSnapshot,
): boolean {
  if (!left) {
    return false;
  }

  return THREAD_TOKEN_USAGE_SNAPSHOT_KEYS.every((key) => left[key] === right[key]);
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.make(value);
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
    rewindMessageIds?: unknown;
    forkMessageIds?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.make(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;
  let rewindMessageIds: ClaudeRewindMessageIds | undefined;
  let rewindMessageIdsInvalid = false;
  let forkMessageIds: ClaudeForkMessageIds | undefined;
  let forkMessageIdsInvalid = false;
  try {
    forkMessageIds = readClaudeForkMessageIds(cursor.forkMessageIds);
  } catch {
    forkMessageIdsInvalid = true;
  }
  try {
    rewindMessageIds = readClaudeRewindMessageIds(cursor.rewindMessageIds);
  } catch {
    rewindMessageIdsInvalid = true;
  }

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(rewindMessageIds ? { rewindMessageIds } : {}),
    ...(rewindMessageIdsInvalid ? { rewindMessageIdsInvalid: true as const } : {}),
    ...(forkMessageIds && Object.keys(forkMessageIds).length > 0 ? { forkMessageIds } : {}),
    ...(forkMessageIdsInvalid ? { forkMessageIdsInvalid: true as const } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
  };
}

function isDurableClaudeResumeState(
  resumeState: ClaudeResumeState | undefined,
): resumeState is ClaudeResumeState & { readonly resume: string } {
  if (!resumeState?.resume) {
    return false;
  }
  return Boolean(resumeState.resumeSessionAt) || (resumeState.turnCount ?? 0) > 0;
}

const CLAUDE_PROJECT_DIRECTORY_PREFIX_LIMIT = 200;

function claudeProjectDirectoryHash(value: string): string {
  // Claude Code uses the conventional signed 32-bit JavaScript string hash
  // here. Keep the bitwise truncation explicit so long-path transcript lookup
  // remains byte-for-byte compatible with the upstream CLI on every host.
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Encode an absolute cwd using Claude Code's project-directory algorithm.
 *
 * Agent SDK 0.3.215's `projectKey` implementation replaces every
 * non-alphanumeric character, not only the host path separator, and bounds
 * long names with a deterministic hash suffix. Besides matching upstream,
 * replacing the Windows volume colon prevents an invalid `projects/C:...`
 * child path from escaping the intended directory component.
 */
export function encodeClaudeProjectDirectoryName(resolvedCwd: string): string {
  const encoded = resolvedCwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (encoded.length <= CLAUDE_PROJECT_DIRECTORY_PREFIX_LIMIT) {
    return encoded;
  }
  return `${encoded.slice(0, CLAUDE_PROJECT_DIRECTORY_PREFIX_LIMIT)}-${claudeProjectDirectoryHash(resolvedCwd)}`;
}

export function claudeProjectDirectoryName(path: Pick<Path.Path, "resolve">, cwd: string): string {
  return encodeClaudeProjectDirectoryName(path.resolve(cwd));
}

function claudeSessionStoreProjectKey(path: Pick<Path.Path, "resolve">, cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  let canonicalCwd = resolvedCwd;
  try {
    // Agent SDK 0.3.228 canonicalizes an existing cwd through realpath before
    // deriving SessionStore.projectKey. This matters on macOS (`/var` aliases
    // `/private/var`) and for Windows path aliases/casing. Match that exact
    // identity while retaining the resolved fallback used by the SDK when the
    // workspace no longer exists.
    canonicalCwd = realpathSync(resolvedCwd);
  } catch {
    // Ended sessions can outlive a deleted workspace. The SDK uses the same
    // resolved spelling when realpath fails, so history can still fail closed
    // against its supplied cwd without performing an all-project search.
  }
  return encodeClaudeProjectDirectoryName(canonicalCwd);
}

function resolveClaudeConfigDirectory(path: Path.Path, env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) {
    return path.resolve(configDir);
  }
  const homePath = env.HOME?.trim();
  return homePath ? path.join(path.resolve(homePath), ".claude") : path.resolve(".claude");
}

async function readBoundedClaudeHistoryRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  // Check the directory entry itself before opening. O_NOFOLLOW below closes
  // the remaining leaf replacement race on POSIX; this lstat is also the
  // explicit fail-closed guard on Windows, where O_NOFOLLOW is unavailable.
  const pathInfo = await lstat(filePath);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw new Error("Claude subagent history is not a private regular file.");
  }
  // O_NOFOLLOW closes the lstat/open replacement race on POSIX. Windows does
  // not implement the flag, so the FileHandle stat below remains the final
  // regular-file and size authority there.
  const flags =
    fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  const handle = await open(filePath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) {
      throw new Error("Claude subagent history is not a bounded regular file.");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    // A same-user writer can append after stat(). Recheck the bytes actually
    // read so an actively growing transcript cannot bypass the memory cap.
    if (Buffer.byteLength(contents, "utf8") > maxBytes) {
      throw new Error("Claude subagent history exceeded its read bound.");
    }
    return contents;
  } finally {
    await handle.close();
  }
}

async function assertPrivateClaudeHistoryDirectory(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Claude subagent history ancestor is not a private directory.");
  }
}

function makeClaudeForkSessionStore(input: {
  readonly path: Path.Path;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly publication: { readonly configurationDirectory: string; readonly commitment: string };
  readonly sessionId: string;
}): SessionStore {
  const projectKey = claudeSessionStoreProjectKey(input.path, input.cwd);
  const configurationDirectory = resolveClaudeConfigDirectory(input.path, input.env);
  if (configurationDirectory !== input.publication.configurationDirectory)
    throw new Error("Claude fork compensation profile changed.");
  const projectsDirectory = input.path.join(configurationDirectory, "projects");
  const projectDirectory = input.path.join(projectsDirectory, projectKey);

  const sessionPath = (key: { readonly projectKey: string; readonly sessionId: string }) => {
    if (
      key.projectKey !== projectKey ||
      !isUuid(key.sessionId) ||
      key.sessionId !== input.sessionId
    ) {
      throw new Error("Claude fork session store received an invalid project/session key.");
    }
    return input.path.join(projectDirectory, `${key.sessionId}.jsonl`);
  };

  return {
    load: async () => {
      throw new Error("Claude fork compensation cannot load history.");
    },
    append: async () => {
      throw new Error("Claude fork compensation cannot publish history.");
    },
    delete: async (key) => {
      if (key.subpath !== undefined) {
        throw new Error("Claude fork session store does not accept subagent paths.");
      }
      // The public disk fork creates only its exclusive transcript. It never
      // starts a target query or creates subagent storage, so a neighboring
      // same-named directory is not compensation authority.
      const current = await readClaudeRewindSnapshot({
        filePath: sessionPath(key),
        directories: [configurationDirectory, projectsDirectory, projectDirectory],
      });
      if (current.commitment !== input.publication.commitment)
        throw new Error("Claude fork compensation publication changed.");
      // No asynchronous Cafe callback can replace the checked namespace before
      // unlink. Node does not expose portable unlink-by-held-handle; a separate
      // same-user writer can still race these native calls. Private directory
      // ownership remains the existing trust boundary, not an atomicity claim.
      for (const expected of current.directoryIdentities) {
        const latest = lstatSync(expected.path, { bigint: true });
        if (
          !latest.isDirectory() ||
          latest.isSymbolicLink() ||
          latest.dev !== expected.dev ||
          latest.ino !== expected.ino
        )
          throw new Error("Claude fork compensation namespace changed.");
      }
      const leaf = lstatSync(sessionPath(key), { bigint: true });
      if (
        !leaf.isFile() ||
        leaf.isSymbolicLink() ||
        `${leaf.dev}:${leaf.ino}:${leaf.size}:${leaf.mtimeNs}:${leaf.ctimeNs}` !==
          current.fileIdentity
      )
        throw new Error("Claude fork compensation leaf changed.");
      unlinkSync(sessionPath(key));
    },
  };
}

/**
 * Build a read-only Agent SDK SessionStore over the exact configured Claude
 * home and cwd. The SDK remains responsible for interpreting transcript
 * chains and producing SessionMessage values; this adapter only supplies the
 * JSON-safe entries required by the official SessionStore contract.
 */
function makeClaudeSubagentHistorySessionStore(input: {
  readonly path: Path.Path;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly sessionId: string;
}): SessionStore {
  const projectKey = claudeSessionStoreProjectKey(input.path, input.cwd);
  const projectDirectory = input.path.join(
    resolveClaudeConfigDirectory(input.path, input.env),
    "projects",
    projectKey,
  );
  const sessionDirectory = input.path.join(projectDirectory, input.sessionId);

  const assertSessionDirectoryChain = async (): Promise<void> => {
    // Refuse a symlink at either provider-owned identity boundary. Without
    // these checks an attacker could redirect an authorized session id into a
    // different project or arbitrary local directory before the leaf-level
    // O_NOFOLLOW check runs.
    await assertPrivateClaudeHistoryDirectory(projectDirectory);
    await assertPrivateClaudeHistoryDirectory(sessionDirectory);
  };

  const validateRootKey = (key: {
    readonly projectKey: string;
    readonly sessionId: string;
  }): void => {
    if (
      key.projectKey !== projectKey ||
      key.sessionId !== input.sessionId ||
      !isUuid(key.sessionId)
    ) {
      throw new Error("Claude history store received an invalid project/session key.");
    }
  };

  const safeSubpathSegments = (subpath: string | undefined): ReadonlyArray<string> => {
    if (subpath === undefined) {
      throw new Error("Claude history store only exposes verified subagent transcripts.");
    }
    const segments = subpath.split("/");
    if (
      segments.length < 2 ||
      segments.length % 2 !== 0 ||
      segments.some(
        (segment, index) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment.includes("\\") ||
          (index % 2 === 0
            ? segment !== "subagents"
            : !segment.startsWith("agent-") ||
              exactClaudeProviderIdentity(segment.slice("agent-".length), {
                pathSegment: true,
              }) === undefined),
      )
    ) {
      throw new Error("Claude history store received an unsafe subagent key.");
    }
    return segments;
  };

  const readEntries = async (filePath: string): Promise<SessionStoreEntry[] | null> => {
    const contents = await readBoundedClaudeHistoryRegularFile(
      filePath,
      CLAUDE_SUBAGENT_HISTORY_FILE_MAX_BYTES,
    );
    const entries: SessionStoreEntry[] = [];
    for (const line of contents.split(/\r?\n/u)) {
      if (line.trim().length === 0) continue;
      const entry = JSON.parse(line) as unknown;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("Claude subagent transcript contained an invalid JSON entry.");
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.type !== "string" || record.type.length === 0) {
        throw new Error("Claude subagent transcript entry was missing its type.");
      }
      entries.push(record as SessionStoreEntry);
    }

    // Claude stores the exact spawning tool id in a bounded sidecar rather
    // than the JSONL itself. `importSessionToStore()` in Agent SDK 0.3.228
    // materializes this as an `agent_metadata` store entry; reproduce only
    // that official storage bridge so getSubagentMessages() can attach
    // `parent_tool_use_id` without Cafe interpreting transcript internals.
    const metadataPath = filePath.replace(/\.jsonl$/u, ".meta.json");
    try {
      const metadataText = await readBoundedClaudeHistoryRegularFile(
        metadataPath,
        CLAUDE_SUBAGENT_HISTORY_METADATA_MAX_BYTES,
      );
      const metadata = JSON.parse(metadataText) as unknown;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error("Claude subagent metadata was not a JSON object.");
      }
      entries.push({
        ...(metadata as Record<string, unknown>),
        // Keep an adversarial sidecar from overriding the SDK discriminator.
        type: "agent_metadata",
      });
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
        throw cause;
      }
      // Older Claude sessions may legitimately predate metadata sidecars.
      // They remain readable only when Cafe already holds an exact historyId;
      // the active task/tool resolver therefore fails closed for those rows.
    }

    return entries.length > 0 ? entries : null;
  };

  return {
    append: async () => {
      throw new Error("Claude history store is read-only.");
    },
    load: async (key) => {
      validateRootKey(key);
      const segments = safeSubpathSegments(key.subpath);
      await assertSessionDirectoryChain();
      let ancestor = sessionDirectory;
      for (const segment of segments.slice(0, -1)) {
        ancestor = input.path.join(ancestor, segment);
        await assertPrivateClaudeHistoryDirectory(ancestor);
      }
      const filePath = input.path.join(sessionDirectory, ...segments) + ".jsonl";
      return readEntries(filePath);
    },
    listSubkeys: async (key) => {
      validateRootKey(key);
      await assertSessionDirectoryChain();
      const subagentRoot = input.path.join(sessionDirectory, "subagents");
      await assertPrivateClaudeHistoryDirectory(subagentRoot);

      const subkeys: string[] = [];
      let scannedEntries = 0;
      const scan = async (directory: string, prefix: ReadonlyArray<string>): Promise<void> => {
        if (prefix.length / 2 > CLAUDE_SUBAGENT_DISCOVERY_MAX_DEPTH) {
          throw new Error("Claude subagent history exceeded its nesting bound.");
        }
        // Stream directory entries instead of allocating an attacker-sized
        // array. The independent scan cap also bounds directories containing
        // thousands of irrelevant files rather than valid agent histories.
        for await (const entry of await opendir(directory)) {
          scannedEntries += 1;
          if (scannedEntries > CLAUDE_SUBAGENT_DISCOVERY_MAX_DIRECTORY_ENTRIES) {
            throw new Error("Claude subagent history exceeded its directory-entry bound.");
          }
          if (subkeys.length > CLAUDE_SUBAGENT_DISCOVERY_MAX_AGENTS) return;
          const entryPath = input.path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            if (!entry.name.startsWith("agent-")) continue;
            const agentId = exactClaudeProviderIdentity(entry.name.slice("agent-".length), {
              pathSegment: true,
            });
            if (!agentId) continue;
            await assertPrivateClaudeHistoryDirectory(entryPath);
            const nestedRoot = input.path.join(entryPath, "subagents");
            let nestedInfo: Awaited<ReturnType<typeof lstat>>;
            try {
              nestedInfo = await lstat(nestedRoot);
            } catch (cause) {
              if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
                // A leaf agent normally has no nested subagent directory.
                continue;
              }
              throw cause;
            }
            if (!nestedInfo.isDirectory() || nestedInfo.isSymbolicLink()) {
              throw new Error("Claude nested subagent history is not a private directory.");
            }
            await scan(nestedRoot, [...prefix, entry.name, "subagents"]);
            continue;
          }
          if (
            !entry.isFile() ||
            !entry.name.startsWith("agent-") ||
            !entry.name.endsWith(".jsonl")
          ) {
            continue;
          }
          const keyName = entry.name.slice(0, -".jsonl".length);
          const agentId = exactClaudeProviderIdentity(keyName.slice("agent-".length), {
            pathSegment: true,
          });
          if (!agentId) continue;
          subkeys.push([...prefix, keyName].join("/"));
        }
      };
      await scan(subagentRoot, ["subagents"]);
      return subkeys;
    },
  };
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}

type PlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

function extractPlanStepsFromTodoInput(input: Record<string, unknown>): PlanStep[] | null {
  // TodoWrite format: { todos: [{ content, status, activeForm? }] }
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) {
    return null;
  }
  return todos
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((todo) => ({
      step:
        typeof todo.content === "string" && todo.content.trim().length > 0
          ? todo.content.trim()
          : "Task",
      status:
        todo.status === "completed"
          ? "completed"
          : todo.status === "in_progress"
            ? "inProgress"
            : "pending",
    }));
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  // For agent/subagent tools, prefer human-readable description or prompt over raw JSON
  const itemType = classifyToolItemType(toolName);
  if (itemType === "collab_agent_tool_call") {
    const description =
      typeof input.description === "string" ? input.description.trim() : undefined;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : undefined;
    const subagentType =
      typeof input.subagent_type === "string" ? input.subagent_type.trim() : undefined;
    const label = description || (prompt ? prompt.slice(0, 200) : undefined);
    if (label) {
      return subagentType ? `${subagentType}: ${label}` : label;
    }
  }

  const serialized = encodeJsonStringForDiagnostics(input) ?? "[unserializable input]";
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;
const CLAUDE_TURN_START_WATCHDOG_DELAYS = [
  "2 seconds",
  "10 seconds",
  "30 seconds",
  "60 seconds",
] as const;
const MAX_CLAUDE_STDERR_DIAGNOSTIC_CHARS = 2_000;
const ANSI_ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "g");
const CLAUDE_EXECUTION_DIAGNOSTIC_PREFIX = "[ede_diagnostic]";

function makeClaudeTurnState(input: {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly origin: "user" | "synthetic";
}): ClaudeTurnState {
  return {
    turnId: input.turnId,
    startedAt: input.startedAt,
    origin: input.origin,
    items: [],
    assistantTextBlocks: new Map(),
    assistantTextBlockOrder: [],
    pendingAssistantSnapshots: [],
    reportedAssistantSnapshotKeys: new Set(),
    capturedProposedPlanKeys: new Set(),
    reportedSubagentRetryKeys: new Set(),
    reportedSubagentMessageKeys: new Set(),
    sdkMessageCount: 0,
    watchdogWarningsEmitted: 0,
    nextSyntheticAssistantBlockIndex: -1,
  };
}

function sanitizeDiagnosticLine(value: string): string {
  let withoutControlCharacters = "";
  for (const char of value.replace(ANSI_ESCAPE_SEQUENCE, "")) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      continue;
    }
    if (code === 127) {
      continue;
    }
    withoutControlCharacters += char;
  }
  return withoutControlCharacters.trim().slice(0, MAX_CLAUDE_STDERR_DIAGNOSTIC_CHARS);
}

function isClaudeExecutionDiagnosticLine(line: string): boolean {
  // Claude Code emits these stderr-only execution summaries during healthy
  // tool-use flows. They are SDK telemetry, not actionable provider failures,
  // so Cafe drops them before they can become work-log warnings or toasts.
  const normalized = line.toLowerCase();
  return (
    normalized === CLAUDE_EXECUTION_DIAGNOSTIC_PREFIX ||
    normalized.startsWith(`${CLAUDE_EXECUTION_DIAGNOSTIC_PREFIX} `)
  );
}

function splitClaudeStderrLines(data: string): ReadonlyArray<string> {
  return data
    .split(/\r?\n/)
    .map(sanitizeDiagnosticLine)
    .filter((line) => line.length > 0 && !isClaudeExecutionDiagnosticLine(line));
}

function buildPromptText(input: ClaudePromptInput, boundInstanceId: ProviderInstanceId): string {
  const rawEffort =
    input.modelSelection?.instanceId === boundInstanceId
      ? getModelSelectionStringOptionValue(input.modelSelection, "effort")
      : null;
  const claudeModel =
    input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection.model : undefined;
  const caps = getClaudeModelCapabilities(claudeModel);

  const promptEffort = resolvePromptInjectedEffort(caps, rawEffort);
  return applyClaudePromptEffortPrefix(input.input?.trim() ?? "", promptEffort);
}

function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
  readonly messageUuid: string;
  readonly deliveryPriority?: ProviderSendTurnInput["deliveryPriority"];
  readonly inputOrigin?: ProviderSendTurnInput["inputOrigin"];
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    uuid: input.messageUuid,
    // Agent SDK 0.3.211+ documents that hosts wrapping keyboard input must
    // explicitly attest human provenance. Leaving origin absent is not a
    // neutral legacy value: strict upstream isHuman() gates fail closed and
    // treat the message as unattributed.
    ...(input.inputOrigin === "scheduled" ? { isSynthetic: true } : { origin: { kind: "human" } }),
    ...(input.deliveryPriority !== undefined ? { priority: input.deliveryPriority } : {}),
    message: {
      role: "user",
      content: input.sdkContent as unknown as SDKUserMessage["message"]["content"],
    },
  } as SDKUserMessage;
}

function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

const buildUserMessageEffect = Effect.fn("buildUserMessageEffect")(function* (
  input: ClaudePromptInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
    readonly boundInstanceId: ProviderInstanceId;
    readonly method: "turn/start" | "turn/steer";
    readonly messageUuid: string;
  },
) {
  const text = buildPromptText(input, dependencies.boundInstanceId);
  const sdkContent: Array<Record<string, unknown>> = [];

  if (text.length > 0) {
    sdkContent.push({ type: "text", text });
  }

  // Keep uploaded documents out of the initial model context. Claude's public
  // Read tool can inspect text and PDF paths on demand, with the existing
  // canUseTool permission boundary for paths outside the project. In particular,
  // do not grant the whole attachment store through additionalDirectories.
  // https://code.claude.com/docs/en/tools-reference#read-tool-behavior
  const fileManifest = yield* Effect.tryPromise({
    try: () =>
      prepareFileAttachmentPrompt({
        attachmentsDir: dependencies.attachmentsDir,
        threadId: input.threadId,
        attachments: input.attachments,
      }),
    catch: () =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: dependencies.method,
        detail: "Failed to prepare a validated file attachment.",
      }),
  });
  if (fileManifest.length > 0) {
    sdkContent.push({ type: "text", text: fileManifest });
  }

  for (const attachment of input.attachments ?? []) {
    if (attachment.type !== "image") {
      continue;
    }

    if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: dependencies.method,
        detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
      });
    }

    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: dependencies.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: dependencies.method,
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }

    const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: dependencies.method,
            detail: toMessage(cause, "Failed to read attachment file."),
            cause,
          }),
      ),
    );

    sdkContent.push(
      buildClaudeImageContentBlock({
        mimeType: attachment.mimeType,
        bytes,
      }),
    );
  }

  return buildUserMessage({
    sdkContent,
    messageUuid: dependencies.messageUuid,
    ...(input.deliveryPriority !== undefined ? { deliveryPriority: input.deliveryPriority } : {}),
    ...(input.inputOrigin !== undefined ? { inputOrigin: input.inputOrigin } : {}),
  });
});

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (result.is_error === true) {
    return "failed";
  }
  if (result.subtype === "success") {
    return "completed";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.make(options.providerItemId),
    };
  }
  return {};
}

function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (
      candidate.type === "text" &&
      typeof candidate.text === "string" &&
      candidate.text.length > 0
    ) {
      fragments.push(candidate.text);
    }
  }

  return fragments;
}

function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

function extractClaudeSubagentSessionMessageText(message: SessionMessage): string | undefined {
  if (message.type !== "user" && message.type !== "assistant") {
    return undefined;
  }
  const envelope = recordValue(message.message);
  const content = envelope?.content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? content : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  // Only explicit public text blocks cross this boundary. Thinking/reasoning,
  // tool use, tool results, images, documents, and provider metadata are
  // intentionally discarded even if they happen to contain a `text` field.
  const text = content
    .flatMap((entry) => {
      const block = recordValue(entry);
      return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
    })
    .join("\n\n");
  return text.trim().length > 0 ? text : undefined;
}

/** Project only known native fields; server/MCP/unknown payloads remain private. */
function* claudeSubagentActivities(
  messages: ReadonlyArray<SessionMessage>,
): Iterable<ProviderSubagentActivityInput> {
  for (const message of messages) {
    if (message.type !== "assistant") continue;
    const content = recordValue(message.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const entry of content) {
      const block = recordValue(entry);
      if (block?.type === "server_tool_use" || block?.type === "mcp_tool_use") {
        yield { kind: "tool" };
        continue;
      }
      if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
      const kind =
        block.name === "Bash"
          ? "command"
          : block.name === "Read" || block.name === "Glob" || block.name === "Grep"
            ? "file_read"
            : block.name === "Edit" || block.name === "Write" || block.name === "NotebookEdit"
              ? "file_edit"
              : block.name === "SendMessage"
                ? "agent_message"
                : "tool";
      const input = recordValue(block.input);
      const detail =
        block.name === "Bash"
          ? subagentCommandDetail(input?.command)
          : block.name === "Read" || block.name === "Edit" || block.name === "Write"
            ? subagentFileDetail(input?.file_path)
            : block.name === "NotebookEdit"
              ? subagentFileDetail(input?.notebook_path)
              : block.name === "Glob" || block.name === "Grep"
                ? subagentFileDetail(input?.path)
                : undefined;
      yield { kind, ...(detail !== undefined ? { detail } : {}) };
    }
  }
}

function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  const result = decodeUnknownJsonStringExit(value);
  if (!Exit.isSuccess(result)) {
    return undefined;
  }
  const parsed = result.value;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  return encodeJsonStringForDiagnostics(input);
}

function toolResultStreamKind(itemType: CanonicalItemType): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}

function claudeAgentOutputHistoryIdentity(
  message: SDKMessage,
): { readonly historyId: string; readonly status: "active" | "completed" } | undefined {
  if (message.type !== "user") {
    return undefined;
  }
  const result = recordValue(message.tool_use_result);
  const status = trimmedStringValue(result?.status);
  if (status !== "completed" && status !== "async_launched") {
    // `remote_launched` is not a local Claude subagent transcript and has no
    // `agentId`; other tool outputs must not be duck-typed as Agent results.
    return undefined;
  }
  const historyId = exactClaudeProviderIdentity(result?.agentId, { pathSegment: true });
  return historyId
    ? {
        historyId,
        status: status === "completed" ? "completed" : "active",
      }
    : undefined;
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

function sdkMessageTtftMs(message: SDKMessage): number | undefined {
  const candidate = (message as { ttft_ms?: unknown }).ttft_ms;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? candidate
    : undefined;
}

export const makeClaudeAdapter = Effect.fn("makeClaudeAdapter")(function* (
  claudeSettings: ClaudeSettings,
  options?: ClaudeAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("claudeAgent");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, options?.environment).pipe(
    Effect.provideService(Path.Path, path),
  );
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);

  const createQuery = options?.createQuery ?? createObservedClaudeQuery;
  const forkNativeSession = options?.forkNativeSession ?? forkSession;
  const deleteNativeSession = options?.deleteNativeSession ?? deleteSession;
  const listNativeSubagents = options?.listNativeSubagents ?? listSubagents;
  const getNativeSubagentMessages = options?.getNativeSubagentMessages ?? getSubagentMessages;

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (
    context: ClaudeSessionContext,
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> => {
    // All callbacks carry the exact originating query context. Looking up the
    // current thread here would let a late old-query callback borrow its
    // replacement's generation and falsely reanimate a persisted worker.
    const stamped = { ...event, subagentRuntimeId: context.subagentRuntimeId };
    const binding =
      event.type === "task.started" ||
      event.type === "task.progress" ||
      event.type === "task.completed"
        ? context.taskBindingsByTaskId.get(String(event.payload.taskId))
        : undefined;
    const taskControl =
      binding?.taskGeneration &&
      binding.nativeTaskId &&
      !binding.provisionalTaskIdentity &&
      binding.visibilityState.visibility === "visible" &&
      !context.terminalTaskIds.has(String(binding.taskId)) &&
      supportsClaudeTaskControls(context.taskControlVersion) &&
      context.query.stopTask
        ? {
            providerInstanceId: boundInstanceId,
            taskGeneration: binding.taskGeneration,
            canStop: true,
            canBackground:
              !!context.query.backgroundTasks &&
              !!admittedClaudeControlIdentity(binding.toolUseId) &&
              binding.backgrounded !== true,
          }
        : undefined;
    const foregroundTool =
      event.type === "item.started" || event.type === "item.updated"
        ? Array.from(context.inFlightTools.values()).find((tool) => tool.itemId === event.itemId)
        : undefined;
    const toolControl =
      foregroundTool &&
      !foregroundTool.detached &&
      !Array.from(context.taskBindingsByTaskId.values()).some(
        (task) => task.nativeTaskId && task.toolUseId === foregroundTool.itemId,
      ) &&
      admittedClaudeControlIdentity(foregroundTool.itemId) &&
      supportsClaudeTaskControls(context.taskControlVersion) &&
      context.query.backgroundTasks
        ? {
            taskId: foregroundTool.controlId,
            runtimeId: context.subagentRuntimeId,
            capability: {
              providerInstanceId: boundInstanceId,
              taskGeneration: foregroundTool.controlGeneration,
              canStop: false,
              canBackground: true,
            },
          }
        : undefined;
    if ((event.type === "item.started" || event.type === "item.updated") && toolControl) {
      return Queue.offer(runtimeEventQueue, {
        ...stamped,
        payload: { ...event.payload, individualTaskControl: toolControl },
      } as ProviderRuntimeEvent).pipe(Effect.asVoid);
    }
    return Queue.offer(
      runtimeEventQueue,
      (event.type === "task.started" ||
        event.type === "task.progress" ||
        event.type === "task.completed") &&
        (event.payload.subagent || taskControl)
        ? ({
            ...stamped,
            payload: {
              ...event.payload,
              ...(taskControl
                ? {
                    individualTaskControl: {
                      taskId: String(binding!.taskId),
                      runtimeId: context.subagentRuntimeId,
                      capability: taskControl,
                    },
                  }
                : {}),
              ...(event.payload.subagent
                ? {
                    subagent: {
                      ...event.payload.subagent,
                      runtimeId: context.subagentRuntimeId,
                      ...(taskControl ? { taskControl } : {}),
                    },
                  }
                : {}),
            },
          } as ProviderRuntimeEvent)
        : stamped,
    ).pipe(Effect.asVoid);
  };

  const emitClaudeProvisionalTaskRetraction = Effect.fn("emitClaudeProvisionalTaskRetraction")(
    function* (
      context: ClaudeSessionContext,
      binding: ClaudeTaskBinding | undefined,
      sourceMessage: SDKMessage,
    ) {
      if (!binding) return;
      const stamp = yield* makeEventStamp();
      const subagent = claudeSubagentPresentation(binding, "active");
      yield* offerRuntimeEvent(context, {
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: binding.turnId ?? undefined,
        type: "task.progress",
        payload: {
          taskId: binding.taskId,
          description: binding.description ?? "Claude subagent",
          summary: "Claude reported the authoritative task identity.",
          visibility: "ambient",
          ...(subagent ? { subagent } : {}),
        },
        providerRefs: nativeProviderRefs(context),
        raw: {
          source: "claude.sdk.message",
          method: sdkNativeMethod(sourceMessage),
          messageType:
            sourceMessage.type === "system"
              ? `${sourceMessage.type}:${sourceMessage.subtype}`
              : sourceMessage.type,
          payload: boundedClaudeNativeMessagePayload(sourceMessage),
        },
      });
    },
  );

  const notifyAuthStatusChanged = (failed: boolean): Effect.Effect<void> =>
    options?.onAuthStatusChanged
      ? options.onAuthStatusChanged(failed).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("claude.auth-status-notify-failed", {
              failed,
              cause: Cause.pretty(cause),
            }),
          ),
        )
      : Effect.void;

  const emitThreadTokenUsageUpdate = Effect.fn("emitThreadTokenUsageUpdate")(function* (
    context: ClaudeSessionContext,
    usage: ThreadTokenUsageSnapshot,
  ) {
    // Once ModelUsage supplies its session-cumulative reasoning counter, keep
    // it on intervening message_start/message_delta snapshots. Otherwise the
    // usage service would fall back to the per-message reasoning counter and
    // then compare the next cumulative result against the wrong watermark,
    // double-counting main-loop thinking on every later turn.
    const previousTotalReasoningOutputTokens =
      context.lastKnownTokenUsage?.totalReasoningOutputTokens;
    const normalizedUsage =
      usage.totalReasoningOutputTokens === undefined &&
      previousTotalReasoningOutputTokens !== undefined
        ? {
            ...usage,
            totalReasoningOutputTokens: previousTotalReasoningOutputTokens,
          }
        : usage;
    if (sameThreadTokenUsageSnapshot(context.lastKnownTokenUsage, normalizedUsage)) {
      return;
    }

    context.lastKnownTokenUsage = normalizedUsage;
    const usageStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent(context, {
      type: "thread.token-usage.updated",
      eventId: usageStamp.eventId,
      provider: PROVIDER,
      createdAt: usageStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        usage: normalizedUsage,
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const logNativeSdkMessage = Effect.fn("logNativeSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (!nativeEventLogger) {
      return;
    }

    const observedAt = yield* nowIso;
    const itemId = sdkNativeItemId(message);
    const nativeEventId =
      "uuid" in message
        ? boundedClaudeNativeIdentifier(message.uuid, "native-event-id")
        : undefined;
    const providerThreadId = boundedClaudeNativeIdentifier(
      message.session_id,
      "native-provider-thread-id",
    );
    const providerItemId = boundedClaudeNativeIdentifier(itemId, "native-provider-item-id");

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id: nativeEventId ?? (yield* Random.nextUUIDv4),
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(providerThreadId ? { providerThreadId } : {}),
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          ...(providerItemId ? { itemId: ProviderItemId.make(providerItemId) } : {}),
          payload: redactClaudeNativeProviderIdentities(boundedClaudeNativeMessagePayload(message)),
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: ClaudeSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return {
      threadId,
      turns: context.turns.map((turn) => ({
        id: turn.id,
        items: [...turn.items],
      })),
    };
  });

  const updateResumeCursor = Effect.fn("updateResumeCursor")(function* (
    context: ClaudeSessionContext,
  ) {
    const threadId = context.session.threadId;
    if (!threadId) return;
    if (!context.resumeCursorDurable) return;

    const resumeCursor = {
      threadId,
      ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
      turnCount: context.resumeBaseTurnCount + context.turns.length,
      ...(context.rewindMessageIds ? { rewindMessageIds: context.rewindMessageIds } : {}),
      ...(Object.keys(context.forkMessageIds).length > 0
        ? { forkMessageIds: { ...context.forkMessageIds } }
        : {}),
    };

    context.session = {
      ...context.session,
      resumeCursor,
      updatedAt: yield* nowIso,
    };
  });

  const ensureAssistantTextBlock = Effect.fn("ensureAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    blockIndex: number,
    options?: {
      readonly fallbackText?: string;
      readonly streamClosed?: boolean;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return undefined;
    }

    const existing = turnState.assistantTextBlocks.get(blockIndex);
    if (
      existing &&
      !existing.completionEmitted &&
      existing.nativeMessageKey === turnState.assistantNativeMessageKey
    ) {
      if (existing.fallbackText.length === 0 && options?.fallbackText) {
        existing.fallbackText = options.fallbackText;
      }
      if (options?.streamClosed) {
        existing.streamClosed = true;
      }
      return { blockIndex, block: existing };
    }

    const block: AssistantTextBlockState = {
      itemId: yield* Random.nextUUIDv4,
      blockIndex,
      ...(turnState.assistantNativeMessageKey
        ? { nativeMessageKey: turnState.assistantNativeMessageKey }
        : {}),
      streamedTextHash: createHash("sha256"),
      streamedTextLength: 0,
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
    turnState.pendingAssistantSnapshots.push(block);
    // Only unmatched snapshots need correlation state. Normal producers keep
    // this queue at one entry; bound it even if a faulty producer omits frames.
    if (turnState.pendingAssistantSnapshots.length > CLAUDE_SUBAGENT_MESSAGE_DEDUPE_LIMIT) {
      turnState.pendingAssistantSnapshots.shift();
    }
    return { blockIndex, block };
  });

  const createSyntheticAssistantTextBlock = Effect.fn("createSyntheticAssistantTextBlock")(
    function* (context: ClaudeSessionContext, fallbackText: string) {
      const turnState = context.turnState;
      if (!turnState) {
        return undefined;
      }

      const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
      turnState.nextSyntheticAssistantBlockIndex -= 1;
      return yield* ensureAssistantTextBlock(context, blockIndex, {
        fallbackText,
        streamClosed: true,
      });
    },
  );

  const completeAssistantTextBlock = Effect.fn("completeAssistantTextBlock")(function* (
    context: ClaudeSessionContext,
    block: AssistantTextBlockState,
    options?: {
      readonly force?: boolean;
      readonly rawMethod?: string;
      readonly rawPayload?: unknown;
    },
  ) {
    const turnState = context.turnState;
    if (!turnState || block.completionEmitted) {
      return;
    }

    if (!options?.force && !block.streamClosed) {
      return;
    }

    if (!block.emittedTextDelta && block.fallbackText.length > 0) {
      const deltaStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "content.delta",
        eventId: deltaStamp.eventId,
        provider: PROVIDER,
        createdAt: deltaStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(block.itemId),
        payload: {
          streamKind: "assistant_text",
          delta: block.fallbackText,
        },
        providerRefs: nativeProviderRefs(context),
        ...(options?.rawMethod || options?.rawPayload
          ? {
              raw: {
                source: "claude.sdk.message" as const,
                ...(options.rawMethod ? { method: options.rawMethod } : {}),
                payload: options?.rawPayload,
              },
            }
          : {}),
      });
    }

    block.completionEmitted = true;
    if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
      turnState.assistantTextBlocks.delete(block.blockIndex);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent(context, {
      type: "item.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      itemId: asRuntimeItemId(block.itemId),
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        title: "Assistant message",
        ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(options?.rawMethod || options?.rawPayload
        ? {
            raw: {
              source: "claude.sdk.message" as const,
              ...(options.rawMethod ? { method: options.rawMethod } : {}),
              payload: options?.rawPayload,
            },
          }
        : {}),
    });
    // Completed blocks are no longer part of result-time draining. Release
    // their potentially large snapshot text now; only the bounded unmatched
    // snapshot queue may keep a small identity/commitment record alive.
    const completedIndex = turnState.assistantTextBlockOrder.indexOf(block);
    if (completedIndex >= 0) {
      turnState.assistantTextBlockOrder.splice(completedIndex, 1);
    }
    block.fallbackText = "";
  });

  const backfillAssistantTextBlocksFromSnapshot = Effect.fn(
    "backfillAssistantTextBlocksFromSnapshot",
  )(function* (context: ClaudeSessionContext, message: SDKMessage) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    const snapshotTextBlocks = extractAssistantTextBlocks(message);
    if (snapshotTextBlocks.length === 0) {
      return;
    }

    if (message.type !== "assistant") {
      return;
    }
    const snapshotKey = createHash("sha256")
      .update("claude-assistant-snapshot-v1\0")
      .update(Buffer.from(message.uuid, "utf16le"))
      .digest("hex");
    if (
      !rememberBoundedClaudeKey(
        turnState.reportedAssistantSnapshotKeys,
        snapshotKey,
        CLAUDE_SUBAGENT_MESSAGE_DEDUPE_LIMIT,
      )
    ) {
      return;
    }
    const nativeMessageKey =
      typeof message.message.id === "string"
        ? createHash("sha256").update(Buffer.from(message.message.id, "utf16le")).digest("hex")
        : undefined;

    // SDK assistant frames carry ONE completed content block, not the entire
    // Cafe turn. Several such frames share an API message.id but have distinct
    // wrapper UUIDs. Match only one unclaimed block in that native message;
    // never index into the accumulated turn's first text block.
    // https://code.claude.com/docs/en/agent-sdk/streaming-output#message-flow
    for (const text of snapshotTextBlocks) {
      const candidates = turnState.pendingAssistantSnapshots.filter(
        (block) =>
          block.nativeMessageKey === nativeMessageKey ||
          (block.nativeMessageKey === undefined &&
            turnState.assistantNativeMessageKey === undefined),
      );
      if (candidates.length > 1 || (candidates.length > 0 && snapshotTextBlocks.length > 1)) {
        yield* emitRuntimeWarning(
          context,
          "Claude assistant snapshot could not be matched to a unique text block; streamed text was preserved.",
          { candidateCount: candidates.length, textBlockCount: snapshotTextBlocks.length },
        );
        return;
      }
      const existingBlock = candidates[0];
      const entry = existingBlock
        ? { block: existingBlock }
        : yield* createSyntheticAssistantTextBlock(context, text);
      if (!entry) {
        continue;
      }
      const pendingIndex = turnState.pendingAssistantSnapshots.indexOf(entry.block);
      if (pendingIndex >= 0) {
        turnState.pendingAssistantSnapshots.splice(pendingIndex, 1);
      }
      // A public SDK wrapper UUID identifies this exact native content block.
      // Bind only a unique single-block frame whose emitted prefix matches;
      // text similarity, API message.id and completion alone are not authority.
      if (
        snapshotTextBlocks.length === 1 &&
        message.session_id === context.resumeSessionId &&
        entry.block.streamedTextLength <= text.length &&
        createHash("sha256")
          .update(Buffer.from(text.slice(0, entry.block.streamedTextLength), "utf16le"))
          .digest("hex") === entry.block.streamedTextHash.copy().digest("hex") &&
        (!entry.block.completionEmitted || entry.block.streamedTextLength === text.length)
      ) {
        rememberClaudeForkMessage({
          ids: context.forkMessageIds,
          messageId: `assistant:${entry.block.itemId}`,
          nativeId: message.uuid,
          turnId: turnState.turnId,
          turnCount: context.resumeBaseTurnCount + context.turns.length + 1,
        });
      }
      if (entry.block.completionEmitted) {
        // Older producers can deliver the snapshot after block_stop. Its exact
        // item has already closed; do not create a duplicate or mutate another.
        continue;
      }
      const prefixMatches =
        entry.block.streamedTextLength <= text.length &&
        createHash("sha256")
          .update(Buffer.from(text.slice(0, entry.block.streamedTextLength), "utf16le"))
          .digest("hex") === entry.block.streamedTextHash.copy().digest("hex");
      if (!prefixMatches) {
        entry.block.fallbackText = "";
        yield* emitRuntimeWarning(
          context,
          "Claude assistant snapshot did not match its streamed text; streamed text was preserved.",
          { streamedLength: entry.block.streamedTextLength, snapshotLength: text.length },
        );
        continue;
      }
      entry.block.fallbackText = text;
      const missingSuffix = text.slice(entry.block.streamedTextLength);
      if (entry.block.emittedTextDelta && missingSuffix.length > 0) {
        const stamp = yield* makeEventStamp();
        entry.block.streamedTextHash.update(Buffer.from(missingSuffix, "utf16le"));
        entry.block.streamedTextLength += missingSuffix.length;
        yield* offerRuntimeEvent(context, {
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          itemId: asRuntimeItemId(entry.block.itemId),
          payload: { streamKind: "assistant_text", delta: missingSuffix },
          providerRefs: nativeProviderRefs(context),
        });
      }
      if (entry.block.streamClosed && !entry.block.completionEmitted) {
        yield* completeAssistantTextBlock(context, entry.block, {
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }
  });

  const ensureThreadId = Effect.fn("ensureThreadId")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (typeof message.session_id !== "string" || message.session_id.length === 0) {
      return;
    }
    if (!hasDurableClaudeSessionId(message)) {
      return;
    }
    const nextThreadId = message.session_id;
    if (context.resumeSessionId !== undefined && context.resumeSessionId !== nextThreadId) {
      context.commandCatalogPushRevision += 1;
      context.pendingCommandCatalog = undefined;
      setCommandCatalog(context, UNAVAILABLE_COMMAND_CATALOG);
      setQuotaReport(context, undefined);
    }
    if (context.resumeSessionId !== message.session_id) {
      context.rewindMessageIds = undefined;
      if (context.resumeSessionId !== undefined) context.forkMessageIds = Object.create(null);
    }
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "thread.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          providerThreadId: nextThreadId,
        },
        providerRefs: {},
        raw: {
          source: "claude.sdk.message",
          method: "claude/thread/started",
          payload: {
            session_id: message.session_id,
          },
        },
      });
    }
  });

  const emitRuntimeError = Effect.fn("emitRuntimeError")(function* (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) {
    if (cause !== undefined) {
      void cause;
    }
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent(context, {
      type: "runtime.error",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        class: "provider_error",
        ...(cause !== undefined ? { detail: cause } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });
  });

  const emitRuntimeWarning = Effect.fn("emitRuntimeWarning")(function* (
    context: ClaudeSessionContext,
    message: string,
    detail?: unknown,
    raw?: NonNullable<ProviderRuntimeEvent["raw"]>,
  ) {
    const turnState = context.turnState;
    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent(context, {
      type: "runtime.warning",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
      payload: {
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
      providerRefs: nativeProviderRefs(context),
      ...(raw ? { raw } : {}),
    });
  });

  const reportClaudeFastModeStatus = Effect.fn("reportClaudeFastModeStatus")(function* (
    context: ClaudeSessionContext,
    message: {
      readonly fast_mode_state?: FastModeState;
      readonly fast_mode_disabled_reason?: FastModeDisabledReason;
    },
  ) {
    if (!context.fastModeRequested) {
      return;
    }

    const state = message.fast_mode_state;
    const reason = message.fast_mode_disabled_reason;
    if (state === "on" && reason === undefined) {
      // Clear the dedupe key so a later cooldown or eligibility change remains
      // visible even when it repeats a status seen before this healthy period.
      context.lastFastModeNoticeKey = undefined;
      return;
    }

    const noticeKey = `${state ?? "unknown"}:${reason ?? "none"}`;
    if (context.lastFastModeNoticeKey === noticeKey) {
      return;
    }

    let notice: string | undefined;
    if (state === "cooldown") {
      notice =
        "Claude fast mode is cooling down after a rate limit; this session is continuing at standard speed.";
    } else if (reason !== undefined) {
      notice =
        "Claude could not activate the requested fast mode; this session is continuing at standard speed.";
    }
    if (notice === undefined) {
      return;
    }

    context.lastFastModeNoticeKey = noticeKey;
    yield* emitRuntimeWarning(context, notice, {
      fastModeState: state,
      fastModeDisabledReason: reason,
    });
  });

  const emitClaudeProcessStderr = Effect.fn("emitClaudeProcessStderr")(function* (
    context: ClaudeSessionContext,
    line: string,
  ) {
    const detail = {
      line,
      threadId: context.session.threadId,
      sessionStatus: context.session.status,
      ...(context.session.activeTurnId ? { activeTurnId: context.session.activeTurnId } : {}),
      ...(context.resumeSessionId ? { resumeSessionId: context.resumeSessionId } : {}),
      ...(context.turnState
        ? {
            sdkMessageCount: context.turnState.sdkMessageCount,
            promptQueuedAt: context.turnState.promptQueuedAt,
          }
        : {}),
    };
    yield* emitRuntimeWarning(context, "Claude process stderr.", detail, {
      source: "claude.sdk.message",
      method: "process/stderr",
      payload: detail,
    });
  });

  const recordTurnSdkMessage = Effect.fn("recordTurnSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    const observedAt = yield* nowIso;
    const messageType = sdkMessageSubtype(message)
      ? `${message.type}:${sdkMessageSubtype(message)}`
      : message.type;
    const method = sdkNativeMethod(message);
    const ttftMs = sdkMessageTtftMs(message);

    turnState.sdkMessageCount += 1;
    if (!turnState.firstSdkMessageAt) {
      turnState.firstSdkMessageAt = observedAt;
      turnState.firstSdkMessageType = messageType;
      turnState.firstSdkMessageMethod = method;
      if (ttftMs !== undefined) {
        turnState.firstSdkMessageTtftMs = ttftMs;
      }
    }
    turnState.lastSdkMessageAt = observedAt;
    turnState.lastSdkMessageType = messageType;
    turnState.lastSdkMessageMethod = method;
  });

  const emitClaudeTurnStartStarvationWarning = Effect.fn("emitClaudeTurnStartStarvationWarning")(
    function* (context: ClaudeSessionContext, turnState: ClaudeTurnState, elapsedLabel: string) {
      const detail = {
        provider: PROVIDER,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        elapsed: elapsedLabel,
        startedAt: turnState.startedAt,
        promptQueuedAt: turnState.promptQueuedAt,
        promptTextBytes: turnState.promptTextBytes,
        promptAttachmentCount: turnState.promptAttachmentCount,
        sdkMessageCount: turnState.sdkMessageCount,
        warningCount: turnState.watchdogWarningsEmitted,
        sessionStatus: context.session.status,
        activeTurnId: context.session.activeTurnId,
        currentApiModelId: context.currentApiModelId,
        selectedContextWindowTokens: context.selectedContextWindowTokens,
        basePermissionMode: context.basePermissionMode,
        resumeSessionId: context.resumeSessionId,
        resumeCursor: context.session.resumeCursor,
        streamFiberAlive: context.streamFiber?.pollUnsafe() === undefined,
      };
      yield* emitRuntimeWarning(
        context,
        `Claude SDK has not emitted any messages ${elapsedLabel} after the user prompt was queued.`,
        detail,
        {
          source: "claude.sdk.message",
          method: "claude.turnStart/noSdkMessageYet",
          payload: detail,
        },
      );
    },
  );

  function scheduleClaudeTurnStartWatchdog(
    context: ClaudeSessionContext,
    turnState: ClaudeTurnState,
  ): void {
    context.runFork(
      Effect.gen(function* () {
        for (const delay of CLAUDE_TURN_START_WATCHDOG_DELAYS) {
          yield* Effect.sleep(delay);
          if (
            context.stopped ||
            context.turnState !== turnState ||
            context.session.status !== "running" ||
            context.session.activeTurnId !== turnState.turnId
          ) {
            return;
          }
          if (turnState.sdkMessageCount > 0) {
            return;
          }

          turnState.watchdogWarningsEmitted += 1;
          yield* emitClaudeTurnStartStarvationWarning(context, turnState, delay);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("claude.turn-start-watchdog.failed", {
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
    );
  }

  const emitProposedPlanCompleted = Effect.fn("emitProposedPlanCompleted")(function* (
    context: ClaudeSessionContext,
    input: {
      readonly planMarkdown: string;
      readonly toolUseId?: string | undefined;
      readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
      readonly rawMethod: string;
      readonly rawPayload: unknown;
    },
  ) {
    const turnState = context.turnState;
    const planMarkdown = input.planMarkdown.trim();
    if (!turnState || planMarkdown.length === 0) {
      return;
    }

    const captureKey = exitPlanCaptureKey({
      toolUseId: input.toolUseId,
      planMarkdown,
    });
    if (turnState.capturedProposedPlanKeys.has(captureKey)) {
      return;
    }
    turnState.capturedProposedPlanKeys.add(captureKey);

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent(context, {
      type: "turn.proposed.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        planMarkdown,
      },
      providerRefs: nativeProviderRefs(context, {
        providerItemId: input.toolUseId,
      }),
      raw: {
        source: input.rawSource,
        method: input.rawMethod,
        payload: input.rawPayload,
      },
    });
  });

  const finalizeTurnSegment = Effect.fn("finalizeTurnSegment")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    result?: SDKResultMessage,
  ) {
    const turnState = context.turnState;
    if (!turnState) {
      return;
    }

    for (const [blockKey, tool] of context.inFlightTools.entries()) {
      // A response boundary is not terminal evidence for a detached call. Its
      // eventual result/notification retains the original item and turn, and
      // the retained binding continues to prevent unsafe idle rewind.
      if (tool.detached) continue;
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "item.completed",
        eventId: toolStamp.eventId,
        provider: PROVIDER,
        createdAt: toolStamp.createdAt,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: status === "completed" ? "completed" : "failed",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: tool.input,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/result",
          payload: result ?? { status },
        },
      });
      context.inFlightTools.delete(blockKey);
    }

    // Completion removes its own entry, so iterate a stable copy of the drain.
    for (const block of turnState.assistantTextBlockOrder.slice()) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
    }

    // A streaming-input query emits one result per dequeued user-message batch.
    // A Cafe steer can therefore produce another assistant response with block
    // index zero while the same Cafe turn remains active. Retain accumulated
    // turn items, diagnostics, and the canonical turn id, but reset all state
    // whose identifiers are scoped to one Claude response segment.
    turnState.assistantTextBlocks.clear();
    turnState.assistantTextBlockOrder.splice(0);
    turnState.pendingAssistantSnapshots.splice(0);
    turnState.assistantNativeMessageKey = undefined;
    turnState.reportedAssistantSnapshotKeys.clear();
    turnState.reportedSubagentMessageKeys.clear();
    turnState.nextSyntheticAssistantBlockIndex = -1;
  });

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
    options?: { readonly segmentAlreadyFinalized?: boolean },
  ) {
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
    const totalReasoningOutputTokens = totalClaudeThinkingTokensFromModelUsage(result?.modelUsage);
    const effectiveContextWindow =
      context.selectedContextWindowTokens ?? resultContextWindow ?? context.lastKnownContextWindow;
    if (effectiveContextWindow !== undefined) {
      context.lastKnownContextWindow = effectiveContextWindow;
    }

    // Agent SDK 0.3.223 clarified that result.usage is the per-turn aggregate
    // for the main agent loop only. It can span several model requests inside
    // that turn, so it still does NOT represent the current context-window
    // occupancy. result.modelUsage is the cumulative query-pipeline accounting
    // source and includes Task subagents, sidechains, compaction, and workflows.
    // Prefer the last message-level usage snapshot from message_start/message_delta
    // as the current-window estimate, and attach the main-loop turn aggregate as
    // totalProcessedTokens for throughput diagnostics.
    const accumulatedSnapshot = normalizeClaudeTokenUsage(result?.usage, effectiveContextWindow);
    const accumulatedTotalProcessedTokens =
      accumulatedSnapshot?.totalProcessedTokens ?? accumulatedSnapshot?.usedTokens;
    const lastGoodUsage = context.lastKnownTokenUsage;
    const maxTokens = effectiveContextWindow;
    const baseUsageSnapshot: ThreadTokenUsageSnapshot | undefined = lastGoodUsage
      ? {
          ...lastGoodUsage,
          ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
            ? { maxTokens }
            : {}),
          ...(typeof accumulatedTotalProcessedTokens === "number" &&
          Number.isFinite(accumulatedTotalProcessedTokens) &&
          accumulatedTotalProcessedTokens > lastGoodUsage.usedTokens
            ? {
                totalProcessedTokens: accumulatedTotalProcessedTokens,
              }
            : {}),
        }
      : accumulatedSnapshot;
    const usageSnapshot: ThreadTokenUsageSnapshot | undefined = baseUsageSnapshot
      ? {
          ...baseUsageSnapshot,
          ...(totalReasoningOutputTokens !== undefined ? { totalReasoningOutputTokens } : {}),
        }
      : undefined;

    const turnState = context.turnState;
    if (!turnState) {
      if (usageSnapshot) {
        yield* emitThreadTokenUsageUpdate(context, usageSnapshot);
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "turn.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          state: status,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
          ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
          ...(result?.usage ? { usage: result.usage } : {}),
          ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
          ...(typeof result?.total_cost_usd === "number"
            ? { totalCostUsd: result.total_cost_usd }
            : {}),
          ...(errorMessage ? { errorMessage } : {}),
        },
        providerRefs: {},
      });
      return;
    }

    if (options?.segmentAlreadyFinalized !== true) {
      yield* finalizeTurnSegment(context, status, result);
    }

    const zeroTurnExecutionFailure =
      result !== undefined && isZeroTurnClaudeExecutionFailure(result);
    if (!zeroTurnExecutionFailure) {
      context.turns.push({
        id: turnState.turnId,
        items: [...turnState.items],
      });
    }
    context.resumeCursorDurable = true;
    yield* updateResumeCursor(context);

    if (usageSnapshot) {
      yield* emitThreadTokenUsageUpdate(context, usageSnapshot);
    }

    const stamp = yield* makeEventStamp();
    yield* offerRuntimeEvent(context, {
      type: "turn.completed",
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      turnId: turnState.turnId,
      payload: {
        state: status,
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
        ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
        ...(result?.usage ? { usage: result.usage } : {}),
        ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
        ...(typeof result?.total_cost_usd === "number"
          ? { totalCostUsd: result.total_cost_usd }
          : {}),
        ...(errorMessage ? { errorMessage } : {}),
      },
      providerRefs: nativeProviderRefs(context),
    });

    const updatedAt = yield* nowIso;
    context.deferredTurnResult = undefined;
    context.turnState = undefined;
    context.session = {
      ...context.session,
      status: "ready",
      activeTurnId: undefined,
      updatedAt,
      ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
    };
    yield* updateResumeCursor(context);
  });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "stream_event") {
      return;
    }

    const { event } = message;
    const parentToolUseId = claudeParentToolUseId(message);
    const isNestedAgentStream = parentToolUseId !== undefined;
    if (!isNestedAgentStream) {
      acknowledgeKnownClaudePromptsStarted(context, message);
    }
    if (isClaudeNestedStreamHidden(context, parentToolUseId)) {
      return;
    }
    if (!isNestedAgentStream && event.type === "message_start" && context.turnState) {
      context.turnState.assistantNativeMessageKey =
        typeof event.message.id === "string"
          ? createHash("sha256").update(Buffer.from(event.message.id, "utf16le")).digest("hex")
          : undefined;
    }
    if (!isNestedAgentStream) {
      const normalizedUsage = normalizeClaudeMessageTokenUsage(
        claudeStreamEventUsagePayload(message),
        context.selectedContextWindowTokens ?? context.lastKnownContextWindow,
        { resetPerMessageCounters: event.type === "message_start" },
      );
      if (normalizedUsage) {
        yield* emitThreadTokenUsageUpdate(context, normalizedUsage);
      }
    }

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
        // With forwardSubagentText enabled, nested agents emit their own text
        // stream using the same block indexes as the main loop. Their completed
        // assistant snapshots are projected below as bounded task progress;
        // emitting these deltas as ordinary content would splice child prose
        // into the parent's final answer and create token-rate DB churn.
        if (isNestedAgentStream) {
          return;
        }
        const deltaText =
          event.delta.type === "text_delta"
            ? event.delta.text
            : typeof event.delta.thinking === "string"
              ? event.delta.thinking
              : "";
        if (deltaText.length === 0) {
          return;
        }
        const streamKind = streamKindFromDeltaType(event.delta.type);
        const assistantBlockEntry =
          event.delta.type === "text_delta"
            ? yield* ensureAssistantTextBlock(context, event.index)
            : context.turnState.assistantTextBlocks.get(event.index)
              ? {
                  blockIndex: event.index,
                  block: context.turnState.assistantTextBlocks.get(
                    event.index,
                  ) as AssistantTextBlockState,
                }
              : undefined;
        if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
          assistantBlockEntry.block.emittedTextDelta = true;
          assistantBlockEntry.block.streamedTextHash.update(Buffer.from(deltaText, "utf16le"));
          assistantBlockEntry.block.streamedTextLength += deltaText.length;
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "content.delta",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          ...(assistantBlockEntry?.block
            ? {
                itemId: asRuntimeItemId(assistantBlockEntry.block.itemId),
              }
            : {}),
          payload: {
            streamKind,
            delta: deltaText,
          },
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta",
            payload: message,
          },
        });
        return;
      }

      if (event.delta.type === "input_json_delta") {
        const blockKey = claudeStreamBlockKey(parentToolUseId, event.index);
        const tool = context.inFlightTools.get(blockKey);
        if (!tool || typeof event.delta.partial_json !== "string") {
          return;
        }

        const partialInputJson = tool.partialInputJson + event.delta.partial_json;
        const parsedInput = tryParseJsonRecord(partialInputJson);
        const detail = parsedInput ? summarizeToolRequest(tool.toolName, parsedInput) : tool.detail;
        let nextTool: ToolInFlight = {
          ...tool,
          partialInputJson,
          ...(parsedInput ? { input: parsedInput } : {}),
          ...(detail ? { detail } : {}),
        };

        const nextFingerprint =
          parsedInput && Object.keys(parsedInput).length > 0
            ? toolInputFingerprint(parsedInput)
            : undefined;
        context.inFlightTools.set(blockKey, nextTool);

        if (
          !parsedInput ||
          !nextFingerprint ||
          tool.lastEmittedInputFingerprint === nextFingerprint
        ) {
          return;
        }

        nextTool = {
          ...nextTool,
          lastEmittedInputFingerprint: nextFingerprint,
        };
        context.inFlightTools.set(blockKey, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          itemId: asRuntimeItemId(nextTool.itemId),
          payload: {
            itemType: nextTool.itemType,
            status: "inProgress",
            title: nextTool.title,
            ...(nextTool.detail ? { detail: nextTool.detail } : {}),
            data: {
              toolName: nextTool.toolName,
              input: nextTool.input,
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: nextTool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/stream_event/content_block_delta/input_json_delta",
            payload: message,
          },
        });

        // Emit plan update when TodoWrite input is parsed
        if (parsedInput && isTodoTool(nextTool.toolName)) {
          const planSteps = extractPlanStepsFromTodoInput(parsedInput);
          if (planSteps && planSteps.length > 0) {
            const planStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "turn.plan.updated",
              eventId: planStamp.eventId,
              provider: PROVIDER,
              createdAt: planStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState
                ? {
                    turnId: asCanonicalTurnId(context.turnState.turnId),
                  }
                : {}),
              payload: {
                plan: planSteps,
              },
              providerRefs: nativeProviderRefs(context),
            });
          }
        }
      }
      return;
    }

    if (event.type === "content_block_start") {
      const { index, content_block: block } = event;
      if (block.type === "text") {
        if (isNestedAgentStream) {
          return;
        }
        yield* ensureAssistantTextBlock(context, index, {
          fallbackText: extractContentBlockText(block),
        });
        return;
      }
      if (
        block.type !== "tool_use" &&
        block.type !== "server_tool_use" &&
        block.type !== "mcp_tool_use"
      ) {
        return;
      }

      const toolName = block.name;
      const itemType = classifyToolItemType(toolName);
      const toolInput =
        typeof block.input === "object" && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};
      const itemId = block.id;
      const detail = summarizeToolRequest(toolName, toolInput);
      const inputFingerprint =
        Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

      const tool: ToolInFlight = {
        controlId: randomUUID(),
        controlGeneration: randomUUID(),
        itemId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        itemType,
        toolName,
        title: titleForTool(itemType),
        detail,
        input: toolInput,
        partialInputJson: "",
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
      };
      context.inFlightTools.set(claudeStreamBlockKey(parentToolUseId, index), tool);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "item.started",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: {
            toolName: tool.toolName,
            input: toolInput,
          },
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/stream_event/content_block_start",
          payload: boundedClaudeNativeMessagePayload(message),
        },
      });
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const assistantBlock = isNestedAgentStream
        ? undefined
        : context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(claudeStreamBlockKey(parentToolUseId, index));
      if (!tool) {
        return;
      }
    }
  });

  const handleUserMessage = Effect.fn("handleUserMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "user") {
      return;
    }

    if (isClaudeNestedStreamHidden(context, claudeParentToolUseId(message))) {
      return;
    }

    const foregroundResourceProjection = claudeForegroundResourceLinkProjection(message);
    const toolResults = toolResultBlocksFromUserMessage(message);
    const quarantineToolResultContent = foregroundResourceProjection.hasUninspectedEntries;
    const foregroundResourceLinks =
      toolResults.length === 1 ? foregroundResourceProjection.links : undefined;
    if (context.turnState) {
      // Claude Code renders MCP links into the tool-result content before the
      // SDK exposes this message. Store a cloned/redacted message so readThread
      // and later resume snapshots cannot reintroduce the raw URI. If the
      // structured envelope exceeds our bounded inspection window, omit the
      // complete provider-authored result because an uninspected URI could have
      // been copied into a nonstandard text shape.
      context.turnState.items.push(
        quarantineToolResultContent
          ? {
              role: "user",
              content: [{ type: "text", text: CLAUDE_RESOURCE_LINK_OVERFLOW_OMISSION }],
            }
          : redactClaudeResourceUris(message.message, foregroundResourceProjection.redactions),
      );
    }

    const agentHistoryIdentity =
      toolResults.length === 1 ? claudeAgentOutputHistoryIdentity(message) : undefined;
    for (const toolResult of toolResults) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [blockKey, tool] = toolEntry;
      if (isClaudeDetachedToolResult(message.tool_use_result)) {
        // This is an acknowledgement that the exact call stepped aside, not its
        // output. Keep its original identity alive across response segments so
        // a later result can settle it once and idle rewind cannot race it.
        context.inFlightTools.delete(blockKey);
        // Stream indices restart at zero in each response. Move this call to
        // its exact item identity so the next response cannot overwrite it.
        context.inFlightTools.set(`detached:${tool.itemId}`, { ...tool, detached: true });
        const detachedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          ...detachedStamp,
          provider: PROVIDER,
          threadId: context.session.threadId,
          turnId: tool.turnId,
          type: "item.updated",
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            itemType: tool.itemType,
            status: "inProgress",
            title: tool.title,
            detail: "Continuing in the background",
          },
        });
        continue;
      }
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const redactedToolResultBlock = quarantineToolResultContent
        ? {
            type: "tool_result",
            content: CLAUDE_RESOURCE_LINK_OVERFLOW_OMISSION,
            ...(toolResult.isError ? { is_error: true } : {}),
          }
        : redactClaudeResourceUris(toolResult.block, foregroundResourceProjection.redactions);
      const redactedToolResultText = quarantineToolResultContent
        ? CLAUDE_RESOURCE_LINK_OVERFLOW_OMISSION
        : redactClaudeResourceString(toolResult.text, foregroundResourceProjection.redactions);
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: redactedToolResultBlock,
        ...(foregroundResourceLinks ? { resourceLinks: foregroundResourceLinks } : {}),
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(tool.turnId ? { turnId: tool.turnId } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: toolResult.isError ? "failed" : "inProgress",
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: boundedClaudeNativeMessagePayload(message),
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && redactedToolResultText.length > 0 && tool.turnId) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: tool.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: redactedToolResultText,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: tool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: boundedClaudeNativeMessagePayload(message),
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(tool.turnId ? { turnId: tool.turnId } : {}),
        itemId: asRuntimeItemId(tool.itemId),
        payload: {
          itemType: tool.itemType,
          status: itemStatus,
          title: tool.title,
          ...(tool.detail ? { detail: tool.detail } : {}),
          data: toolData,
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: tool.itemId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/user",
          payload: boundedClaudeNativeMessagePayload(message),
        },
      });

      if (tool.itemType === "collab_agent_tool_call" && agentHistoryIdentity !== undefined) {
        const toolUseKey = canonicalClaudeToolUseBindingKey(toolResult.toolUseId);
        const existingBinding = toolUseKey
          ? context.taskBindingsByToolUseId.get(toolUseKey)
          : undefined;
        if (existingBinding !== undefined) {
          // Agent SDK `task_id`, spawning `tool_use_id`, and AgentOutput
          // `agentId` are independent identifiers. This edge durably repeats
          // the exact association after the structured Agent result reveals
          // it, allowing ended sessions to authorize history without parsing
          // prose or guessing that any ids are equal.
          const historyBinding = upsertClaudeTaskBinding(context, {
            taskId: existingBinding.taskId,
            toolUseKey,
            toolUseId: toolResult.toolUseId,
            historyId: agentHistoryIdentity.historyId,
            taskType: "agent",
          });
          const subagent = claudeSubagentPresentation(historyBinding, agentHistoryIdentity.status);
          const visibility = claudeTaskVisibilityForBinding(context, historyBinding);
          const historyStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(
            context,
            agentHistoryIdentity.status === "completed"
              ? {
                  type: "task.completed",
                  eventId: historyStamp.eventId,
                  provider: PROVIDER,
                  createdAt: historyStamp.createdAt,
                  threadId: context.session.threadId,
                  ...(historyBinding.turnId ? { turnId: historyBinding.turnId } : {}),
                  payload: {
                    taskId: historyBinding.taskId,
                    status: "completed",
                    summary: "Claude subagent completed.",
                    visibility,
                    ...(subagent ? { subagent } : {}),
                  },
                  providerRefs: nativeProviderRefs(context, {
                    providerItemId: toolResult.toolUseId,
                  }),
                }
              : {
                  type: "task.progress",
                  eventId: historyStamp.eventId,
                  provider: PROVIDER,
                  createdAt: historyStamp.createdAt,
                  threadId: context.session.threadId,
                  ...(historyBinding.turnId ? { turnId: historyBinding.turnId } : {}),
                  payload: {
                    taskId: historyBinding.taskId,
                    description:
                      historyBinding.description ?? "Claude subagent is working in the background.",
                    summary: "Claude subagent history is available.",
                    visibility,
                    ...(subagent ? { subagent } : {}),
                  },
                  providerRefs: nativeProviderRefs(context, {
                    providerItemId: toolResult.toolUseId,
                  }),
                },
          );
        }
      }

      context.inFlightTools.delete(blockKey);
    }
  });

  const handleCommandLifecycleMessage = Effect.fn("handleCommandLifecycleMessage")(function* (
    context: ClaudeSessionContext,
    message: ClaudeCommandLifecycleMessage,
  ) {
    const previousState = context.promptLifecycleByUuid.get(message.command_uuid);
    if (previousState === undefined) {
      // Claude can report lifecycle for internally queued commands. Upstream's
      // interrupt contract explicitly requires clients to ignore unknown UUIDs.
      return;
    }

    if (isTerminalClaudeCommandLifecycleState(message.state)) {
      context.promptLifecycleByUuid.delete(message.command_uuid);
    } else {
      context.promptLifecycleByUuid.set(message.command_uuid, message.state);
    }

    if (message.state === "started" && context.deferredTurnResult !== undefined) {
      // A queued message promoted after the preceding result owns a new Claude
      // response segment and will emit its own result. Retire the older deferred
      // boundary so a later lifecycle-completed frame cannot close Cafe's turn
      // before this newly started segment reports its terminal result. For a
      // coalesced batch, every member is already `started` before the shared
      // result arrives, so this branch does not discard the batch result.
      context.deferredTurnResult = undefined;
    }

    if (
      message.state === "completed" &&
      context.promptLifecycleByUuid.size === 0 &&
      context.deferredTurnResult !== undefined
    ) {
      // Claude can coalesce several queued user messages into one model turn.
      // In that case a single result represents the batch while lifecycle
      // frames retire every UUID. Complete only after the final tracked UUID
      // reaches terminal state; the response segment was already finalized
      // when its result arrived, so doing so again would duplicate item events.
      const deferred = context.deferredTurnResult;
      context.deferredTurnResult = undefined;
      yield* completeTurn(context, deferred.status, deferred.errorMessage, deferred.result, {
        segmentAlreadyFinalized: true,
      });
    }

    if (message.state === "discarded") {
      yield* Effect.logWarning("claude.commandLifecycle.discarded", {
        threadId: context.session.threadId,
        providerInstanceId: boundInstanceId,
        previousState,
      });
      yield* emitRuntimeWarning(
        context,
        "Claude exited before a tracked queued input reached a terminal lifecycle state.",
        {
          previousState,
          state: message.state,
        },
      );
    }
  });

  const handleAssistantMessage = Effect.fn("handleAssistantMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "assistant") {
      return;
    }
    if (isClaudeAuthFailureAssistantMessage(message)) {
      context.authFailureSeen = true;
      yield* emitRuntimeWarning(
        context,
        "Claude authentication failed; suppressing Claude Code's synthetic assistant error and retiring this stale session.",
        {
          apiErrorStatus: 401,
          error: "authentication_failed",
          sessionId: typeof message.session_id === "string" ? message.session_id : undefined,
        },
        {
          source: "claude.sdk.message",
          method: "claude/assistant/authentication_failed",
          payload: message,
        },
      );
      return;
    }

    const parentToolUseId = claudeParentToolUseId(message);
    if (parentToolUseId === undefined) {
      acknowledgeKnownClaudePromptsStarted(context, message);
    }
    if (isClaudeNestedStreamHidden(context, parentToolUseId)) {
      return;
    }

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState) {
      const turnId = TurnId.make(yield* Random.nextUUIDv4);
      const startedAt = yield* nowIso;
      context.turnState = makeClaudeTurnState({
        turnId,
        startedAt,
        origin: "synthetic",
      });
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "turn.started",
        eventId: turnStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: turnStartedStamp.createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {
          ...nativeProviderRefs(context),
          providerTurnId: turnId,
        },
        raw: {
          source: "claude.sdk.message",
          method: "claude/synthetic-turn-start",
          payload: {},
        },
      });
    }

    if (parentToolUseId !== undefined) {
      if (context.turnState) {
        context.turnState.items.push(message.message);
      }

      const text = extractAssistantTextBlocks(message).join("\n\n").trim();
      if (text.length === 0 || !context.turnState) {
        return;
      }

      const toolUseKey = canonicalClaudeToolUseBindingKey(parentToolUseId);
      if (!toolUseKey) {
        return;
      }
      const dedupeKey = `${toolUseKey.length}:${toolUseKey}:${message.uuid}`;
      if (
        !rememberBoundedClaudeKey(
          context.turnState.reportedSubagentMessageKeys,
          dedupeKey,
          CLAUDE_SUBAGENT_MESSAGE_DEDUPE_LIMIT,
        )
      ) {
        return;
      }

      const existingBinding = context.taskBindingsByToolUseId.get(toolUseKey);
      const subagentType =
        claudeSubagentDisplayLine(message.subagent_type, CLAUDE_SUBAGENT_ROLE_LIMIT) ??
        existingBinding?.subagentType;
      const recoveredDescription =
        claudeSubagentDisplayLine(message.task_description, CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT) ??
        existingBinding?.description ??
        (subagentType ? `${subagentType} subagent` : "Claude subagent");
      const binding = existingBinding
        ? upsertClaudeTaskBinding(context, {
            taskId: existingBinding.taskId,
            toolUseKey,
            description: recoveredDescription,
            provisionalDescription: true,
            ...(subagentType ? { subagentType } : {}),
            // A non-null parent_tool_use_id is the SDK's structured proof that
            // this assistant frame came from a subagent. Keep the recovery path
            // visible even when task_started was delayed or omitted and the
            // older producer did not repeat subagent_type on this frame.
            taskType: "agent",
          })
        : bindClaudeTaskToToolUse(context, {
            taskId: parentToolUseId,
            toolUseId: parentToolUseId,
            description: recoveredDescription,
            provisionalDescription: true,
            provisionalTaskIdentity: true,
            ...(subagentType ? { subagentType } : {}),
            taskType: "agent",
          });
      if (!binding) {
        return;
      }
      const description = binding.description ?? recoveredDescription;
      const summary =
        text.length > CLAUDE_SUBAGENT_PROGRESS_TEXT_LIMIT
          ? `${text.slice(0, CLAUDE_SUBAGENT_PROGRESS_TEXT_LIMIT - 3)}...`
          : text;
      const stamp = yield* makeEventStamp();
      const subagent = claudeSubagentPresentation(binding, "active");
      const visibility = claudeTaskVisibilityForBinding(context, binding);
      yield* offerRuntimeEvent(context, {
        type: "task.progress",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        turnId: binding.turnId ?? undefined,
        payload: {
          taskId: binding.taskId,
          description,
          summary,
          visibility,
          ...(subagent ? { subagent } : {}),
        },
        providerRefs: nativeProviderRefs(context, {
          providerItemId: parentToolUseId,
        }),
        raw: {
          source: "claude.sdk.message",
          method: "claude/assistant/subagent",
          payload: boundedClaudeNativeMessagePayload(message),
        },
      });
      return;
    }

    const normalizedUsage = normalizeClaudeMessageTokenUsage(
      claudeAssistantUsagePayload(message),
      context.selectedContextWindowTokens ?? context.lastKnownContextWindow,
    );
    if (normalizedUsage) {
      yield* emitThreadTokenUsageUpdate(context, normalizedUsage);
    }

    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const toolUse = block as {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          input?: unknown;
        };
        if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
          continue;
        }
        const planMarkdown = extractExitPlanModePlan(toolUse.input);
        if (!planMarkdown) {
          continue;
        }
        yield* emitProposedPlanCompleted(context, {
          planMarkdown,
          toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
          rawSource: "claude.sdk.message",
          rawMethod: "claude/assistant",
          rawPayload: message,
        });
      }
    }

    if (context.turnState) {
      context.turnState.items.push(message.message);
      // Agent SDK 0.3.215 can mark this snapshot `aborted` when interruption
      // truncates it before stop_reason. The partial text is still user-visible
      // output worth preserving; only the later result/interrupt event may
      // terminalize the turn.
      yield* backfillAssistantTextBlocksFromSnapshot(context, message);
    }

    context.lastAssistantUuid = message.uuid;
    yield* updateResumeCursor(context);
  });

  const handleResultMessage = Effect.fn("handleResultMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    if (message.type !== "result") {
      return;
    }

    yield* reportClaudeFastModeStatus(context, message);

    const status = turnStatusFromResult(message);
    const resultErrors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
    const authFailure = isClaudeAuthFailureResult(message);
    const errorMessage =
      status !== "completed"
        ? (resultPrimaryError(message) ?? resultErrors[0] ?? "Claude turn failed.")
        : undefined;
    const completedPromptCount = consumeClaudeResultPrompt(context, message);
    // Claude Code 2.1.245 / Agent SDK 0.3.245 adds queued_turn_count to the
    // result boundary. Local UUID lifecycle remains the strongest attribution
    // signal, while the provider count closes the race where the next command
    // is already queued but its command_lifecycle frame has not reached Cafe.
    // A positive count is liveness, not a terminal result for the canonical
    // Cafe turn; the next result or lifecycle boundary will settle it.
    const queuedTurnCount = claudeResultQueuedTurnCount(message);
    const pendingPromptCount = Math.max(context.promptLifecycleByUuid.size, queuedTurnCount ?? 0);
    const hasQueuedCafeInput = pendingPromptCount > 0;

    if (status === "failed") {
      if (isZeroTurnClaudeExecutionFailure(message)) {
        const detail = {
          errors: resultErrors,
          resumeSessionId: context.resumeSessionId,
          failedSessionId: typeof message.session_id === "string" ? message.session_id : undefined,
        };
        yield* emitRuntimeWarning(
          context,
          "Claude returned a zero-turn pre-run failure; preserving the previous resume session.",
          detail,
          {
            source: "claude.sdk.message",
            method: "claude/result/zero-turn-failure",
            payload: message,
          },
        );
      } else if (authFailure) {
        context.authFailureSeen = true;
        yield* notifyAuthStatusChanged(true);
        yield* emitRuntimeWarning(
          context,
          "Claude authentication failed; retiring this stale Claude session so the next turn starts with current login material.",
          {
            apiErrorStatus: 401,
            error: "authentication_failed",
            sessionId: typeof message.session_id === "string" ? message.session_id : undefined,
          },
          {
            source: "claude.sdk.message",
            method: "claude/result/authentication_failed",
            payload: message,
          },
        );
      } else if (hasQueuedCafeInput) {
        // A result is scoped to one dequeued command/batch, not to the lifetime
        // of the streaming query. Claude continues draining its input queue
        // after recoverable execution errors, so keep this diagnostic in the
        // work log and let the already-accepted follow-up continue.
        yield* emitRuntimeWarning(
          context,
          "Claude response segment failed; an already-queued follow-up remains active.",
          {
            error: sanitizeDiagnosticLine(errorMessage ?? "Claude turn failed."),
            pendingPromptCount,
          },
        );
      } else {
        yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
      }
    }

    if (status === "completed") {
      // A successful turn proves the stored credentials work again (e.g.
      // after the user re-ran /login), so clear any needs-login provider
      // state derived from an earlier 401.
      yield* notifyAuthStatusChanged(false);
    }

    if (!authFailure && hasQueuedCafeInput) {
      // Claude's stream-json queue emits a result for the response segment that
      // just finished, then promotes the next queued SDKUserMessage without
      // ending the process. This remains true for recoverable execution-error
      // results. Preserve the same user-facing lifecycle Cafe uses for a Codex
      // steer: one canonical turn stays active while the provider reaches a
      // safe boundary and incorporates the follow-up. Finalize only segment-
      // local stream/tool state here; a later result (or the terminal lifecycle
      // frames of a coalesced batch) closes the canonical turn.
      yield* finalizeTurnSegment(context, status, message);
      context.deferredTurnResult = {
        status,
        result: message,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      };
      yield* Effect.logInfo("claude.followUp.resultBoundaryDeferred", {
        threadId: context.session.threadId,
        providerInstanceId: boundInstanceId,
        completedPromptCount,
        pendingPromptCount,
        ...(queuedTurnCount !== undefined ? { providerQueuedTurnCount: queuedTurnCount } : {}),
        messageLifecycleAdvertised: context.capabilities.has("msg_lifecycle_v1"),
      });
      return;
    }

    context.deferredTurnResult = undefined;
    yield* completeTurn(context, status, errorMessage, message);
    if (authFailure) {
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
        interruptStreamFiber: false,
      });
    }
  });

  const setCommandCatalog = (context: ClaudeSessionContext, catalog: ProviderCommandCatalog) => {
    if (context.stopped || sessions.get(context.session.threadId) !== context) return;
    context.session = { ...context.session, commandCatalog: catalog };
    if (context.commandCatalogPublishPending) return;
    context.commandCatalogPublishPending = true;
    // The SDK pushes full levels. Keep one pending publication and publish the
    // newest level after this finite window, rather than queueing every plugin
    // reload edge or postponing forever under a continuous event storm.
    context.runFork(
      Effect.gen(function* () {
        yield* Effect.sleep(50);
        context.commandCatalogPublishPending = false;
        if (context.stopped || sessions.get(context.session.threadId) !== context) return;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          ...stamp,
          type: "session.configured",
          provider: PROVIDER,
          threadId: context.session.threadId,
          payload: { config: {}, commandCatalogChanged: true },
          providerRefs: {},
        });
      }),
    );
  };

  const setQuotaReport = (
    context: ClaudeSessionContext,
    report: ProviderSessionQuotaReport | undefined,
  ) => {
    if (context.stopped || sessions.get(context.session.threadId) !== context) return;
    if (report === undefined && context.session.quotaReport === undefined) return;
    // A native session replacement/reset invalidates the entire level. Never
    // merge anonymous meters, retain old balances after failure, or treat this
    // query/config scope as authenticated account identity.
    const { quotaReport: _previous, ...session } = context.session;
    context.session = report === undefined ? session : { ...session, quotaReport: report };
    if (context.quotaReportPublishPending) return;
    context.quotaReportPublishPending = true;
    context.runFork(
      Effect.gen(function* () {
        yield* Effect.sleep(50);
        context.quotaReportPublishPending = false;
        if (context.stopped || sessions.get(context.session.threadId) !== context) return;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          ...stamp,
          type: "session.configured",
          provider: PROVIDER,
          threadId: context.session.threadId,
          payload: { config: {}, quotaReportChanged: true },
          providerRefs: {},
        });
      }),
    );
  };

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    sdkMessage: SDKMessage,
  ) {
    const message = sdkMessage as ClaudeSdkMessageWithForwardCompatibleSystem;
    if (message.type !== "system") {
      return;
    }

    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(sdkMessage),
        messageType: `${message.type}:${message.subtype}`,
        payload: boundedClaudeNativeMessagePayload(sdkMessage),
      },
    };

    const rawSystemSubtype = sdkMessageSubtype(message);
    if (rawSystemSubtype === "post_turn_summary") {
      // Claude Code 2.1.198 emits an AI-written end-of-turn status summary
      // (status_category / status_detail / needs_action) that the published
      // Agent SDK subtype union does not include yet, so the typed switch
      // below cannot match it. Promote the human-readable text to a work-log
      // progress row; the full payload stays available via the raw native
      // event instead of surfacing an unhandled-subtype warning.
      const record = message as unknown as Record<string, unknown>;
      const statusDetail = claudeSubagentDisplayLine(
        record.status_detail,
        CLAUDE_TASK_SUMMARY_TEXT_LIMIT,
      );
      const needsAction = claudeSubagentDisplayLine(
        record.needs_action,
        CLAUDE_TASK_SUMMARY_TEXT_LIMIT,
      );
      const summary = claudeSubagentDisplayLine(
        statusDetail && needsAction && needsAction !== statusDetail
          ? `${statusDetail} — ${needsAction}`
          : (statusDetail ?? needsAction),
        CLAUDE_TASK_SUMMARY_TEXT_LIMIT,
      );
      if (summary) {
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "tool.progress",
          payload: {
            summary,
          },
        });
      }
      return;
    }
    if (rawSystemSubtype === "task_summary") {
      // Claude Code 2.1.198 forwards subagent task summaries as
      // system:task_summary with `detail` holding either the summary text or a
      // structured record. Same treatment as post_turn_summary: surface
      // readable text without a generic unhandled-subtype warning.
      const record = message as unknown as Record<string, unknown>;
      const detailRecord = recordValue(record.detail);
      const summary = claudeSubagentDisplayLine(
        record.detail ??
          detailRecord?.summary ??
          detailRecord?.detail ??
          detailRecord?.text ??
          detailRecord?.description,
        CLAUDE_TASK_SUMMARY_TEXT_LIMIT,
      );
      if (summary) {
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "tool.progress",
          payload: {
            summary,
          },
        });
      }
      return;
    }

    switch (message.subtype) {
      case "api_retry":
        if (isClaudeAuthFailureSystemMessage(message)) {
          context.authFailureSeen = true;
          yield* notifyAuthStatusChanged(true);
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "runtime.warning",
            payload: {
              message:
                "Claude authentication retry failed with 401; Cafe will retire this session if Claude reports the turn as failed.",
              detail: {
                apiErrorStatus: 401,
                error: "authentication_failed",
                attempt: (message as Record<string, unknown>).attempt,
                maxRetries: (message as Record<string, unknown>).max_retries,
                retryDelayMs: (message as Record<string, unknown>).retry_delay_ms,
              },
            },
          });
          return;
        }
        yield* emitRuntimeWarning(context, "Claude reported an API retry.", message, {
          source: "claude.sdk.message",
          method: "claude/system/api_retry",
          payload: message,
        });
        return;
      case "control_request_progress": {
        // Agent SDK 0.3.241+ declares this as a system subtype. Older leaked
        // bridge frames used a top-level type, which remains accepted by the
        // compatibility guard below. Keep both wire shapes warning-free and
        // promote only bounded provider-authored progress metadata.
        const record = message as Record<string, unknown>;
        const summary =
          trimmedStringValue(record.summary) ??
          (message.status === "api_retry"
            ? `Claude control request retry ${Math.max(1, message.attempt ?? 1)}/${Math.max(
                message.attempt ?? 1,
                message.max_retries ?? 1,
              )}${
                typeof message.retry_delay_ms === "number" && message.retry_delay_ms > 0
                  ? ` in ${Math.trunc(message.retry_delay_ms)} ms`
                  : ""
              }.`
            : "Claude control request started.");
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "tool.progress",
          payload: { summary },
        });
        return;
      }
      case "init":
        if (context.pendingCommandCatalog) {
          const pending = context.pendingCommandCatalog;
          context.pendingCommandCatalog = undefined;
          setCommandCatalog(
            context,
            pending.sessionId === message.session_id
              ? pending.catalog
              : UNAVAILABLE_COMMAND_CATALOG,
          );
        }
        context.taskControlVersion = message.claude_code_version;
        configureClaudeUsageVersion(context.usageAccounting, message.claude_code_version);
        context.capabilities.clear();
        for (const capability of message.capabilities ?? []) {
          if (typeof capability === "string" && capability.length > 0) {
            context.capabilities.add(capability);
          }
        }
        yield* reportClaudeFastModeStatus(context, message);
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "session.configured",
          payload: {
            config: boundedClaudeInitPluginDiagnostics(message as Record<string, unknown>),
          },
        });
        return;
      case "status":
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "session.state.changed",
          payload: {
            state: message.status === "compacting" ? "waiting" : "running",
            reason: `status:${message.status ?? "active"}`,
            detail: message,
          },
        });
        return;
      case "compact_boundary":
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "thread.state.changed",
          payload: {
            state: "compacted",
            detail: message,
          },
        });
        return;
      case "thinking_tokens":
        // Claude Agent SDK 0.3.153 added this system subtype as live,
        // approximate progress telemetry digested from redacted thinking
        // deltas. It is explicitly not authoritative billed token usage, so
        // Cafe records the raw native event but does not project a work-log
        // warning or context-window update from it. SDK 0.3.260 adds prompt
        // correlation before the first reply frame; that UUID is real liveness
        // evidence, unlike the approximate token count. Never apply child
        // thinking telemetry to the primary prompt queue.
        if (claudeParentToolUseId(message) === undefined) {
          acknowledgeKnownClaudePromptsStarted(context, message);
        }
        return;
      case "commands_changed":
        // SDK 0.3.288 explicitly documents a complete replacement payload;
        // supportedCommands() caches this same push. No reinitialize, process
        // restart, metadata probe, or model request belongs on this path.
        if (
          typeof message.session_id !== "string" ||
          !message.session_id ||
          message.session_id.length > 1024 ||
          (context.resumeSessionId !== undefined && message.session_id !== context.resumeSessionId)
        )
          return;
        context.commandCatalogPushRevision += 1;
        if (!context.resumeSessionId) {
          context.pendingCommandCatalog = {
            sessionId: message.session_id,
            catalog: publicClaudeCommands(message.commands),
          };
          // Retain only one pre-init level, but do not claim it current before
          // the native init establishes the matching session identity. This is
          // unavailable (not unbounded loading) if no init ever arrives.
          setCommandCatalog(context, UNAVAILABLE_COMMAND_CATALOG);
        } else if (message.session_id === context.resumeSessionId) {
          setCommandCatalog(context, publicClaudeCommands(message.commands));
        }
        return;
      case "background_tasks_changed":
        // This is a level-set signal rather than a start/completion edge: the
        // payload replaces the CLI process' current background-task set. The
        // Tasks surfaces consume distinct task.progress rows for visible live
        // members and retractions; let task_updated /
        // task_notification carry terminal status when Claude emits it.
        const previousBackgroundTaskIds = new Set(context.backgroundTaskIds);
        // Capture the bindings before admitting any replacement members. The
        // provider-controlled binding map is capped at 4,096 entries; inserting
        // a full replacement snapshot first could otherwise evict the omitted
        // rows before Cafe had a chance to retract them.
        const previousBackgroundTaskBindings = new Map(context.backgroundTaskBindings);
        const allTasks = Array.isArray((message as Record<string, unknown>).tasks)
          ? (message as { readonly tasks: ReadonlyArray<unknown> }).tasks
          : [];
        const tasks = allTasks.slice(0, CLAUDE_TASK_BINDING_LIMIT);
        if (allTasks.length > CLAUDE_TASK_BINDING_LIMIT) {
          yield* emitRuntimeWarning(
            context,
            `Claude background-task snapshot exceeded Cafe's ${CLAUDE_TASK_BINDING_LIMIT}-task safety limit; excess entries were ignored.`,
            {
              subtype: "background_tasks_changed",
              reportedTaskCount: allTasks.length,
              acceptedTaskCount: CLAUDE_TASK_BINDING_LIMIT,
            },
          );
        }
        const stagedTasks: Array<{
          readonly taskRecord: Record<string, unknown>;
          readonly taskId: string;
          readonly canonicalTaskKey: string;
        }> = [];
        for (const task of tasks) {
          const taskRecord = recordValue(task);
          if (!taskRecord) {
            continue;
          }
          const taskId = trimmedStringValue(taskRecord.task_id);
          if (!taskId) {
            continue;
          }
          const canonicalTaskId = canonicalClaudeTaskId(taskId);
          if (!canonicalTaskId) {
            continue;
          }
          const canonicalTaskKey = String(canonicalTaskId);
          // A terminal notification may legally precede the level snapshot
          // that removes this task. Do not let that stale snapshot resurrect a
          // completed row. A genuine task-id reuse begins with task_started,
          // which explicitly clears this bounded tombstone.
          if (context.terminalTaskIds.has(canonicalTaskKey)) {
            continue;
          }
          stagedTasks.push({ taskRecord, taskId, canonicalTaskKey });
        }

        const nextBackgroundTaskIds = new Set(
          stagedTasks.map(({ canonicalTaskKey }) => canonicalTaskKey),
        );
        context.backgroundTaskIds.clear();
        for (const canonicalTaskKey of nextBackgroundTaskIds) {
          context.backgroundTaskIds.add(canonicalTaskKey);
        }
        context.backgroundTaskBindings.clear();

        // `background_tasks_changed` is a full replacement snapshot. Reconcile
        // omissions against the stable prior-binding snapshot *before* any new
        // member can pressure the bounded binding map. Omission is not proof of
        // success or failure, so project only an ambient visibility retraction.
        for (const previousTaskKey of previousBackgroundTaskIds) {
          if (
            nextBackgroundTaskIds.has(previousTaskKey) ||
            context.terminalTaskIds.has(previousTaskKey)
          ) {
            continue;
          }
          const previousBinding = previousBackgroundTaskBindings.get(previousTaskKey);
          if (!previousBinding) continue;
          const retractedBinding = restoreClaudeRetainedTaskBinding(context, previousBinding, {
            value: "ambient",
            authority: "snapshot-retraction",
          });
          setClaudeTaskFallbackVisibilityByKey(
            context,
            previousTaskKey,
            "ambient",
            "snapshot-retraction",
          );
          const subagent = claudeSubagentPresentation(retractedBinding, "active");
          yield* offerRuntimeEvent(context, {
            ...base,
            ...(yield* makeEventStamp()),
            turnId: retractedBinding.turnId ?? undefined,
            type: "task.progress",
            payload: {
              taskId: retractedBinding.taskId,
              description: retractedBinding.description ?? "Background task",
              summary: "Claude no longer reports this task as active.",
              visibility: "ambient",
              ...(subagent ? { subagent } : {}),
            },
          });
        }

        for (const { taskRecord, taskId, canonicalTaskKey } of stagedTasks) {
          const description =
            claudeSubagentDisplayLine(taskRecord.description, CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT) ??
            "Background task";
          const taskType = claudeSubagentDisplayLine(taskRecord.task_type, 120);
          const retainedPreviousBinding = previousBackgroundTaskBindings.get(canonicalTaskKey);
          // Generic task traffic may evict an otherwise-live background task
          // between two level snapshots. Seed the bounded generic cache from
          // the dedicated live-background binding before applying the repeated
          // member so upsert preserves the original owner and first-seen clock.
          if (
            !context.taskBindingsByTaskId.has(canonicalTaskKey) &&
            retainedPreviousBinding !== undefined
          ) {
            restoreClaudeRetainedTaskBinding(context, retainedPreviousBinding);
          }
          const previousBinding = context.taskBindingsByTaskId.get(canonicalTaskKey);
          const previousVisibility = claudeTaskVisibilityForProviderTaskId(context, taskId);
          const visibility: RuntimeTaskVisibility =
            typeof taskRecord.ambient === "boolean"
              ? taskRecord.ambient
                ? "ambient"
                : "visible"
              : previousBinding?.visibilityState.authority === "provider" &&
                  previousBinding.visibilityState.visibility === "ambient"
                ? "ambient"
                : "visible";
          setClaudeTaskFallbackVisibility(context, taskId, visibility);
          const binding = bindClaudeTaskToToolUse(context, {
            taskId,
            description,
            ...(taskType ? { taskType } : {}),
            ...(trimmedStringValue(taskRecord.subagent_type)
              ? { subagentType: trimmedStringValue(taskRecord.subagent_type) }
              : {}),
            ...(typeof taskRecord.spawn_depth === "number"
              ? { spawnDepth: taskRecord.spawn_depth }
              : {}),
            startedAt: base.createdAt,
            visibility,
            visibilityAuthority: "provider",
          });
          if (!binding) {
            continue;
          }
          if (
            previousBackgroundTaskIds.has(canonicalTaskKey) &&
            previousVisibility === visibility
          ) {
            // Level snapshots repeat every still-live task on each membership
            // change. Re-emitting all of them creates quadratic work-log churn
            // during highly parallel Opus/Fable runs; task edge messages carry
            // the actual progress and terminal updates.
            continue;
          }
          const subagent = claudeSubagentPresentation(binding, "active");
          yield* offerRuntimeEvent(context, {
            ...base,
            ...(yield* makeEventStamp()),
            turnId: binding.turnId ?? undefined,
            type: "task.progress",
            payload: {
              taskId: binding.taskId,
              description,
              visibility,
              ...(taskType ? { summary: `${taskType} background task is running.` } : {}),
              ...(subagent ? { subagent } : {}),
            },
          });
        }
        return;
      case "memory_recall":
        // Memory recall is a transcript adornment from Claude's own memory
        // layer. Cafe preserves the raw event but should not leak local memory
        // file paths or synthesis content into generic work-log warnings.
        return;
      case "elicitation_complete":
        // Completion of an MCP elicitation handshake is control-plane
        // bookkeeping. The actual answer/result flows through the SDK's
        // canonical tool/user messages.
        return;
      case "local_command_output": {
        const record = message as Record<string, unknown>;
        const content = trimmedStringValue(record.content);
        if (!content) {
          return;
        }
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "item.completed",
          itemId: asRuntimeItemId(`claude-local-command-${message.uuid}`),
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Claude command output",
            detail: content,
          },
        });
        return;
      }
      case "informational": {
        if (message.level === "warning" || message.prevent_continuation === true) {
          yield* emitRuntimeWarning(context, message.content, {
            subtype: message.subtype,
            level: message.level,
            ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
            ...(message.prevent_continuation !== undefined
              ? { preventContinuation: message.prevent_continuation }
              : {}),
          });
        }
        return;
      }
      case "model_refusal_fallback":
        yield* emitRuntimeWarning(context, message.content, {
          subtype: message.subtype,
          trigger: message.trigger,
          direction: message.direction,
          ...("scope" in message && message.scope !== undefined ? { scope: message.scope } : {}),
          originalModel: message.original_model,
          fallbackModel: message.fallback_model,
          requestId: message.request_id,
          ...(message.api_refusal_category !== undefined
            ? { apiRefusalCategory: message.api_refusal_category }
            : {}),
          ...(message.api_refusal_explanation !== undefined
            ? { apiRefusalExplanation: message.api_refusal_explanation }
            : {}),
          ...(message.retracted_message_uuids !== undefined
            ? { retractedMessageUuids: message.retracted_message_uuids }
            : {}),
          ...(message.refused_user_message_uuid !== undefined
            ? { refusedUserMessageUuid: message.refused_user_message_uuid }
            : {}),
        });
        return;
      case "model_refusal_no_fallback":
        yield* emitRuntimeWarning(context, message.content, {
          subtype: message.subtype,
          originalModel: message.original_model,
          requestId: message.request_id,
          ...(message.api_refusal_category !== undefined
            ? { apiRefusalCategory: message.api_refusal_category }
            : {}),
          ...(message.api_refusal_explanation !== undefined
            ? { apiRefusalExplanation: message.api_refusal_explanation }
            : {}),
          ...(message.refused_user_message_uuid !== undefined
            ? { refusedUserMessageUuid: message.refused_user_message_uuid }
            : {}),
        });
        return;
      case "session_state_changed":
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "session.state.changed",
          payload: {
            state: runtimeStateFromClaudeSessionState(message.state),
            reason: `session_state_changed:${message.state}`,
            detail: message,
          },
        });
        return;
      case "worker_shutting_down":
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "session.state.changed",
          payload: {
            state: "waiting",
            reason: `worker_shutting_down:${message.reason}`,
            detail: message,
          },
        });
        return;
      case "vcs_state_changed": {
        // Claude Code 2.1.232+ emits this after a foreground shell command
        // performs a commit, push, merge, or rebase. Upstream documents it as
        // an invalidation hint, not proof of repository state. In particular,
        // `cwd` comes from the provider process and is untrusted: omit it from
        // the canonical event and let the server resolve the already-bound
        // session cwd before performing any filesystem or Git operation.
        const kind = sanitizeDiagnosticLine(message.kind ?? "unknown").slice(0, 64) || "unknown";
        const branch = message.branch
          ? sanitizeDiagnosticLine(message.branch).slice(0, 256) || undefined
          : undefined;
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "vcs.state.changed",
          payload: {
            kind,
            ...(branch ? { branch } : {}),
          },
          raw: {
            source: "claude.sdk.message",
            method: "claude/system/vcs_state_changed",
            messageType: "system:vcs_state_changed",
            // Keep the useful invalidation metadata while deliberately
            // excluding provider-supplied paths and identifiers from the
            // canonical/debug event surface.
            payload: {
              type: "system",
              subtype: "vcs_state_changed",
              kind,
              ...(branch ? { branch } : {}),
            },
          },
        });
        return;
      }
      case "code_change_published": {
        // This is a successful publication edge (for example, a pull request),
        // not an adapter warning. Surface a bounded summary without copying a
        // provider-controlled URL into work-log text or canonical diagnostics.
        const action = message.action
          ? sanitizeDiagnosticLine(message.action).slice(0, 80) || undefined
          : undefined;
        const identifier = message.identifier
          ? sanitizeDiagnosticLine(message.identifier).slice(0, 120) || undefined
          : undefined;
        const repo = message.repo
          ? sanitizeDiagnosticLine(message.repo).slice(0, 160) || undefined
          : undefined;
        const provider = message.provider
          ? sanitizeDiagnosticLine(message.provider).slice(0, 80) || undefined
          : undefined;
        const summary = [
          `Claude ${action ?? "published"} a code change${identifier ? ` ${identifier}` : ""}`,
          repo ? `in ${repo}` : undefined,
        ]
          .filter((part): part is string => part !== undefined)
          .join(" ");
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "tool.progress",
          payload: {
            summary: `${summary}.`,
          },
          raw: {
            source: "claude.sdk.message",
            method: "claude/system/code_change_published",
            messageType: "system:code_change_published",
            payload: {
              type: "system",
              subtype: "code_change_published",
              ...(provider ? { provider } : {}),
              ...(repo ? { repo } : {}),
              ...(identifier ? { identifier } : {}),
              ...(action ? { action } : {}),
            },
          },
        });
        return;
      }
      case "feedback_draft_queued":
        // Claude's own runtime says this draft is local-only and explicitly
        // instructs clients not to announce it. The native provider log keeps
        // the frame for diagnosis; chat, work log, and toast surfaces stay
        // quiet until the user explicitly submits feedback upstream.
        return;
      case "notification":
        if (message.priority === "high" || message.priority === "immediate") {
          yield* emitRuntimeWarning(context, message.text, {
            subtype: message.subtype,
            key: message.key,
            priority: message.priority,
            ...(message.timeout_ms !== undefined ? { timeoutMs: message.timeout_ms } : {}),
          });
        }
        return;
      case "permission_denied":
        yield* emitRuntimeWarning(context, message.message, {
          subtype: message.subtype,
          toolName: message.tool_name,
          toolUseId: message.tool_use_id,
          ...(message.agent_id ? { agentId: message.agent_id } : {}),
          ...(message.decision_reason_type
            ? { decisionReasonType: message.decision_reason_type }
            : {}),
          ...(message.decision_reason ? { decisionReason: message.decision_reason } : {}),
        });
        return;
      case "mirror_error":
        yield* emitRuntimeWarning(context, "Claude transcript mirror dropped a batch.", {
          subtype: message.subtype,
          error: message.error,
          key: message.key,
        });
        return;
      case "plugin_install":
        if (message.status === "failed") {
          yield* emitRuntimeWarning(
            context,
            message.error ??
              `Claude plugin install failed${message.name ? `: ${message.name}` : ""}.`,
            {
              subtype: message.subtype,
              status: message.status,
              ...(message.name ? { name: message.name } : {}),
            },
          );
        }
        return;
      case "hook_started":
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress": {
        const output = boundedClaudeProviderText(message.output, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
        const stdout = boundedClaudeProviderText(message.stdout, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
        const stderr = boundedClaudeProviderText(message.stderr, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            ...(output ? { output } : {}),
            ...(stdout ? { stdout } : {}),
            ...(stderr ? { stderr } : {}),
          },
        });
        return;
      }
      case "hook_response": {
        const output = boundedClaudeProviderText(message.output, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
        const stdout = boundedClaudeProviderText(message.stdout, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
        const stderr = boundedClaudeProviderText(message.stderr, CLAUDE_HOOK_OUTPUT_TEXT_LIMIT);
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            ...(output ? { output } : {}),
            ...(stdout ? { stdout } : {}),
            ...(stderr ? { stderr } : {}),
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      }
      case "task_started": {
        const taskStartedRecord = message as unknown as Record<string, unknown>;
        const nativeDescription = claudeSubagentDisplayLine(
          message.description,
          CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
        );
        const description = nativeDescription ?? "Claude task";
        const taskType = claudeSubagentDisplayLine(message.task_type, 120);
        const authoritativeIdentity = prepareClaudeAuthoritativeTaskIdentity(
          context,
          message.task_id,
          message.tool_use_id,
          true,
        );
        if (!authoritativeIdentity) {
          yield* emitRuntimeWarning(context, "Claude task start was missing a task id.", message);
          return;
        }
        const visibility: RuntimeTaskVisibility =
          message.ambient === true || message.skip_transcript === true ? "ambient" : "visible";
        const priorBinding = context.taskBindingsByTaskId.get(String(authoritativeIdentity.taskId));
        const retiredToolUseKeys = [...(priorBinding?.retiredToolUseKeys ?? [])];
        const reusedNativeTaskId = context.terminalTaskIds.has(
          String(authoritativeIdentity.taskId),
        );
        if (reusedNativeTaskId) {
          if (priorBinding?.toolUseKey) retiredToolUseKeys.push(priorBinding.toolUseKey);
          if (retiredToolUseKeys.length > 128) {
            context.taskLivenessUncertain = true;
            yield* emitRuntimeWarning(
              context,
              "Claude task identity reuse exceeded the safe tracking bound.",
              message,
            );
            return;
          }
          // Native task ids may be reused. A new explicit start must not borrow
          // the previous worker's tool/history identities or control receipt.
          context.taskBindingsByTaskId.delete(String(authoritativeIdentity.taskId));
          for (const [key, old] of context.taskBindingsByToolUseId) {
            if (old.taskId === authoritativeIdentity.taskId)
              context.taskBindingsByToolUseId.delete(key);
          }
        }
        setClaudeTaskFallbackVisibility(context, message.task_id, visibility);
        let startedBinding = bindClaudeTaskToToolUse(context, {
          taskId: message.task_id,
          ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
          description,
          provisionalDescription: nativeDescription === undefined,
          ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
          ...(taskType ? { taskType } : {}),
          ...(trimmedStringValue(taskStartedRecord.prompt)
            ? { objective: trimmedStringValue(taskStartedRecord.prompt) }
            : {}),
          ...(typeof taskStartedRecord.spawn_depth === "number"
            ? { spawnDepth: taskStartedRecord.spawn_depth }
            : {}),
          provisionalTaskIdentity: false,
          startedAt: base.createdAt,
          visibility,
          visibilityAuthority: "provider",
        });
        if (!startedBinding) {
          yield* emitRuntimeWarning(context, "Claude task start was missing a task id.", message);
          return;
        }
        startedBinding = upsertClaudeTaskBinding(context, {
          retiredToolUseKeys,
          incarnationRequiresToolUseId:
            reusedNativeTaskId || priorBinding?.incarnationRequiresToolUseId === true,
          taskId: startedBinding.taskId,
          ...(startedBinding.toolUseKey ? { toolUseKey: startedBinding.toolUseKey } : {}),
          nativeTaskId: admittedClaudeControlIdentity(message.task_id),
          taskGeneration:
            startedBinding.taskGeneration &&
            !context.terminalTaskIds.has(String(startedBinding.taskId))
              ? startedBinding.taskGeneration
              : randomUUID(),
          backgrounded: taskStartedRecord.is_backgrounded === true,
          startedAt: base.createdAt,
          turnId: context.turnState?.turnId ?? null,
        });
        // An explicit start is the only authoritative indication that Claude
        // intentionally reused a previously terminal task id.
        context.terminalTaskIds.delete(String(startedBinding.taskId));
        if (message.skip_transcript === true) {
          hideClaudeTaskFromTranscript(context, message.task_id);
        }
        // The exact SDK task/tool association can replace an assistant-first
        // tool-id alias. Visibility retraction removes only that provisional
        // renderer row and deliberately does not manufacture terminal state.
        yield* emitClaudeProvisionalTaskRetraction(
          context,
          authoritativeIdentity.provisionalAlias,
          sdkMessage,
        );
        const startedSubagent = claudeSubagentPresentation(startedBinding, "active");
        // Replace the foreground-tool affordance with the native task's exact
        // lifecycle once Claude publishes it, without displaying duplicate work.
        const spawningTool = Array.from(context.inFlightTools.values()).find(
          (tool) => tool.itemId === startedBinding.toolUseId,
        );
        if (spawningTool) {
          yield* offerRuntimeEvent(context, {
            ...base,
            ...(yield* makeEventStamp()),
            type: "item.updated",
            turnId: spawningTool.turnId,
            itemId: asRuntimeItemId(spawningTool.itemId),
            payload: {
              itemType: spawningTool.itemType,
              status: "inProgress",
              title: spawningTool.title,
            },
          });
        }
        yield* offerRuntimeEvent(context, {
          ...base,
          turnId: startedBinding.turnId ?? undefined,
          type: "task.started",
          payload: {
            taskId: startedBinding.taskId,
            description,
            ...(taskType ? { taskType } : {}),
            visibility,
            ...(startedSubagent ? { subagent: startedSubagent } : {}),
          },
        });
        return;
      }
      case "task_progress": {
        const nativeDescription = claudeSubagentDisplayLine(
          message.description,
          CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
        );
        const description = nativeDescription ?? "Claude task";
        const summary = claudeSubagentDisplayLine(message.summary, CLAUDE_TASK_SUMMARY_TEXT_LIMIT);
        const lastToolName = claudeSubagentDisplayLine(
          message.last_tool_name,
          CLAUDE_TASK_TOOL_NAME_TEXT_LIMIT,
        );
        const inferredStartedAt = claudeSubagentStartedAtFromUsage(base.createdAt, message.usage);
        const usage = boundedClaudeNativeTaskUsage(message.usage);
        const authoritativeIdentity = prepareClaudeAuthoritativeTaskIdentity(
          context,
          message.task_id,
          message.tool_use_id,
        );
        if (!authoritativeIdentity) {
          yield* emitRuntimeWarning(
            context,
            "Claude task progress was missing a task id.",
            message,
          );
          return;
        }
        const progressBinding = bindClaudeTaskToToolUse(context, {
          taskId: message.task_id,
          ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
          description,
          provisionalDescription: nativeDescription === undefined,
          provisionalTaskIdentity: false,
          ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
          ...(inferredStartedAt ? { startedAt: inferredStartedAt } : {}),
        });
        if (!progressBinding) {
          yield* emitRuntimeWarning(
            context,
            "Claude task progress was missing a task id.",
            message,
          );
          return;
        }
        yield* emitClaudeProvisionalTaskRetraction(
          context,
          authoritativeIdentity.provisionalAlias,
          sdkMessage,
        );
        const progressSubagent = claudeSubagentPresentation(progressBinding, "active");
        const visibility = claudeTaskVisibilityForBinding(context, progressBinding);
        yield* offerRuntimeEvent(context, {
          ...base,
          turnId: progressBinding.turnId ?? undefined,
          type: "task.progress",
          payload: {
            taskId: progressBinding.taskId,
            description: progressBinding.description ?? description,
            ...(summary ? { summary } : {}),
            ...(usage ? { usage } : {}),
            ...(lastToolName ? { lastToolName } : {}),
            visibility,
            ...(progressSubagent ? { subagent: progressSubagent } : {}),
          },
        });
        return;
      }
      case "task_updated": {
        // Claude Code 2.1.173 started emitting task_updated as a patch-style
        // lifecycle message for the same background task ids previously
        // announced through task_started/task_progress/task_notification.
        // The SDK types can lag behind the binary, so treat the patch as
        // untrusted provider data: copy only structured fields Cafe already
        // understands, keep only bounded allowlisted fields in native
        // diagnostics, and avoid warning for a valid upstream subtype.
        const record = message as Record<string, unknown>;
        const patch = recordValue(record.patch) ?? {};
        const taskId = trimmedStringValue(record.task_id);
        if (!taskId) {
          yield* emitRuntimeWarning(context, "Claude task update was missing a task id.", message);
          return;
        }
        const patchedToolUseId = patch.tool_use_id ?? record.tool_use_id;
        if (!prepareClaudeAuthoritativeTaskIdentity(context, taskId, patchedToolUseId)) return;

        const skipTranscript = patch.skip_transcript === true || record.skip_transcript === true;
        const ambient = patch.ambient ?? record.ambient;
        const requestedVisibility: RuntimeTaskVisibility | undefined =
          skipTranscript || typeof ambient === "boolean"
            ? skipTranscript || ambient === true
              ? "ambient"
              : "visible"
            : undefined;
        if (requestedVisibility) {
          setClaudeTaskFallbackVisibility(context, taskId, requestedVisibility);
        }
        if (skipTranscript) {
          hideClaudeTaskFromTranscript(context, taskId);
        }

        const patchedDescription = claudeSubagentDisplayLine(
          patch.description ?? record.description,
          CLAUDE_TASK_DESCRIPTION_TEXT_LIMIT,
        );
        const patchedSummary = claudeSubagentDisplayLine(
          patch.summary ?? record.summary,
          CLAUDE_TASK_SUMMARY_TEXT_LIMIT,
        );
        const patchedLastToolName = claudeSubagentDisplayLine(
          patch.last_tool_name ?? record.last_tool_name,
          CLAUDE_TASK_TOOL_NAME_TEXT_LIMIT,
        );

        let updatedBinding = bindClaudeTaskToToolUse(context, {
          taskId,
          ...(patchedDescription ? { description: patchedDescription } : {}),
          ...(trimmedStringValue(patch.subagent_type ?? record.subagent_type)
            ? { subagentType: trimmedStringValue(patch.subagent_type ?? record.subagent_type) }
            : {}),
          ...(trimmedStringValue(patch.task_type ?? record.task_type)
            ? { taskType: trimmedStringValue(patch.task_type ?? record.task_type) }
            : {}),
          ...(typeof (patch.spawn_depth ?? record.spawn_depth) === "number"
            ? { spawnDepth: (patch.spawn_depth ?? record.spawn_depth) as number }
            : {}),
          ...(requestedVisibility ? { visibility: requestedVisibility } : {}),
          ...(requestedVisibility ? { visibilityAuthority: "provider" as const } : {}),
        });
        if (!updatedBinding) {
          return;
        }
        if (typeof (patch.is_backgrounded ?? record.is_backgrounded) === "boolean") {
          updatedBinding = upsertClaudeTaskBinding(context, {
            taskId: updatedBinding.taskId,
            backgrounded: (patch.is_backgrounded ?? record.is_backgrounded) as boolean,
          });
        }
        const usage = boundedClaudeNativeTaskUsage(patch.usage ?? record.usage);
        const terminalStatus = claudeTaskTerminalStatus(patch.status ?? record.status);
        if (
          terminalStatus &&
          requestedVisibility === undefined &&
          updatedBinding.visibilityState.authority === "snapshot-retraction"
        ) {
          updatedBinding = upsertClaudeTaskBinding(context, {
            taskId: updatedBinding.taskId,
            visibility: "visible",
            visibilityAuthority: "provider",
          });
          setClaudeTaskFallbackVisibilityByKey(context, String(updatedBinding.taskId), "visible");
        }
        const visibility = claudeTaskVisibilityForBinding(context, updatedBinding);
        if (terminalStatus) {
          markClaudeTaskTerminal(context, updatedBinding);
          const detached = updatedBinding.toolUseId
            ? Array.from(context.inFlightTools.entries()).find(
                ([, tool]) => tool.detached && tool.itemId === updatedBinding.toolUseId,
              )
            : undefined;
          if (detached) {
            const [key, tool] = detached;
            context.inFlightTools.delete(key);
            yield* offerRuntimeEvent(context, {
              ...base,
              ...(yield* makeEventStamp()),
              type: "item.completed",
              turnId: tool.turnId,
              itemId: asRuntimeItemId(tool.itemId),
              payload: {
                itemType: tool.itemType,
                status: terminalStatus === "completed" ? "completed" : "failed",
                title: tool.title,
                ...(patchedSummary ? { detail: patchedSummary } : {}),
              },
            });
          }
          const terminalSubagent = claudeSubagentPresentation(
            updatedBinding,
            claudeSubagentStatus(patch.status ?? record.status),
          );
          yield* offerRuntimeEvent(context, {
            ...base,
            turnId: updatedBinding.turnId ?? undefined,
            type: "task.completed",
            payload: {
              taskId: updatedBinding.taskId,
              status: terminalStatus,
              ...(patchedSummary ? { summary: patchedSummary } : {}),
              ...(usage !== undefined ? { usage } : {}),
              visibility,
              ...(terminalSubagent ? { subagent: terminalSubagent } : {}),
            },
          });
          return;
        }

        const rawStatus = trimmedStringValue(patch.status ?? record.status);
        const description =
          patchedDescription ?? (rawStatus ? `Task ${rawStatus}` : "Task updated");
        const updatedSubagent = claudeSubagentPresentation(
          updatedBinding,
          claudeSubagentStatus(rawStatus),
        );
        yield* offerRuntimeEvent(context, {
          ...base,
          turnId: updatedBinding.turnId ?? undefined,
          type: "task.progress",
          payload: {
            taskId: updatedBinding.taskId,
            description,
            ...(patchedSummary ? { summary: patchedSummary } : {}),
            ...(usage !== undefined ? { usage } : {}),
            ...(patchedLastToolName ? { lastToolName: patchedLastToolName } : {}),
            visibility,
            ...(updatedSubagent ? { subagent: updatedSubagent } : {}),
          },
        });
        return;
      }
      case "task_notification": {
        const taskNotificationRecord = message as unknown as Record<string, unknown>;
        const resourceProjection = projectClaudeResourceLinks(
          taskNotificationRecord.resource_links,
        );
        const summary = resourceProjection.hasUninspectedEntries
          ? CLAUDE_RESOURCE_LINK_OVERFLOW_TASK_SUMMARY
          : claudeSubagentDisplayLine(message.summary, CLAUDE_TASK_SUMMARY_TEXT_LIMIT);
        const inferredStartedAt = claudeSubagentStartedAtFromUsage(base.createdAt, message.usage);
        const usage = boundedClaudeNativeTaskUsage(message.usage);
        const resourceLinks = resourceProjection.links;
        const requestedVisibility: RuntimeTaskVisibility | undefined =
          message.skip_transcript === true || typeof message.ambient === "boolean"
            ? message.skip_transcript === true || message.ambient === true
              ? "ambient"
              : "visible"
            : undefined;
        const authoritativeIdentity = prepareClaudeAuthoritativeTaskIdentity(
          context,
          message.task_id,
          message.tool_use_id,
        );
        if (!authoritativeIdentity) {
          yield* emitRuntimeWarning(
            context,
            "Claude task notification was missing a task id.",
            message,
          );
          return;
        }
        if (requestedVisibility) {
          setClaudeTaskFallbackVisibility(context, message.task_id, requestedVisibility);
        }
        const existingNotificationBinding = findClaudeTaskBinding(context, {
          taskId: message.task_id,
          ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
        });
        let notificationBinding = bindClaudeTaskToToolUse(context, {
          taskId: message.task_id,
          ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
          // `summary` is the terminal result, not the task title. Only use it
          // as a label when Cafe missed every earlier lifecycle edge.
          ...(!existingNotificationBinding && summary ? { description: summary } : {}),
          ...(!existingNotificationBinding && summary ? { provisionalDescription: true } : {}),
          provisionalTaskIdentity: false,
          ...(trimmedStringValue(taskNotificationRecord.subagent_type)
            ? { subagentType: trimmedStringValue(taskNotificationRecord.subagent_type) }
            : {}),
          ...(trimmedStringValue(taskNotificationRecord.task_type)
            ? { taskType: trimmedStringValue(taskNotificationRecord.task_type) }
            : {}),
          ...(inferredStartedAt ? { startedAt: inferredStartedAt } : {}),
          ...(requestedVisibility ? { visibility: requestedVisibility } : {}),
          ...(requestedVisibility ? { visibilityAuthority: "provider" as const } : {}),
        });
        if (!notificationBinding) {
          yield* emitRuntimeWarning(
            context,
            "Claude task notification was missing a task id.",
            message,
          );
          return;
        }
        if (message.skip_transcript === true) {
          hideClaudeTaskFromTranscript(context, message.task_id);
        }
        if (
          requestedVisibility === undefined &&
          notificationBinding.visibilityState.authority === "snapshot-retraction"
        ) {
          notificationBinding = upsertClaudeTaskBinding(context, {
            taskId: notificationBinding.taskId,
            visibility: "visible",
            visibilityAuthority: "provider",
          });
          setClaudeTaskFallbackVisibilityByKey(
            context,
            String(notificationBinding.taskId),
            "visible",
          );
        }
        yield* emitClaudeProvisionalTaskRetraction(
          context,
          authoritativeIdentity.provisionalAlias,
          sdkMessage,
        );
        const notificationSubagent = claudeSubagentPresentation(
          notificationBinding,
          claudeSubagentStatus(message.status),
        );
        const visibility = claudeTaskVisibilityForBinding(context, notificationBinding);
        markClaudeTaskTerminal(context, notificationBinding);
        // A terminal task notification may be the only completion edge for a
        // detached tool. Settle its original item exactly once, without touching
        // the current response's tools or sibling tasks.
        const detached = notificationBinding.toolUseId
          ? Array.from(context.inFlightTools.entries()).find(
              ([, tool]) => tool.detached && tool.itemId === notificationBinding.toolUseId,
            )
          : undefined;
        if (detached) {
          const [key, tool] = detached;
          context.inFlightTools.delete(key);
          yield* offerRuntimeEvent(context, {
            ...base,
            ...(yield* makeEventStamp()),
            type: "item.completed",
            turnId: tool.turnId,
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: message.status === "completed" ? "completed" : "failed",
              title: tool.title,
              ...(summary ? { detail: summary } : {}),
            },
          });
        }
        yield* offerRuntimeEvent(context, {
          ...base,
          turnId: notificationBinding.turnId ?? undefined,
          type: "task.completed",
          payload: {
            taskId: notificationBinding.taskId,
            status: message.status,
            ...(summary ? { summary } : {}),
            ...(usage ? { usage } : {}),
            ...(resourceLinks ? { resourceLinks } : {}),
            visibility,
            ...(notificationSubagent ? { subagent: notificationSubagent } : {}),
          },
        });
        return;
      }
      case "files_persisted":
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "files.persisted",
          payload: {
            files: Array.isArray(message.files)
              ? message.files.map((file: { filename: string; file_id: string }) => ({
                  filename: file.filename,
                  fileId: file.file_id,
                }))
              : [],
            ...(Array.isArray(message.failed)
              ? {
                  failed: message.failed.map((entry: { filename: string; error: string }) => ({
                    filename: entry.filename,
                    error: entry.error,
                  })),
                }
              : {}),
          },
        });
        return;
      default:
        const unknownSystemMessage = message as unknown as Record<string, unknown>;
        yield* emitRuntimeWarning(
          context,
          `Unhandled Claude system message subtype '${String(unknownSystemMessage.subtype)}'.`,
          message,
        );
        return;
    }
  });

  const handleSdkTelemetryMessage = Effect.fn("handleSdkTelemetryMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    const stamp = yield* makeEventStamp();
    const base = {
      eventId: stamp.eventId,
      provider: PROVIDER,
      createdAt: stamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      providerRefs: nativeProviderRefs(context),
      raw: {
        source: "claude.sdk.message" as const,
        method: sdkNativeMethod(message),
        messageType: message.type,
        payload: boundedClaudeNativeMessagePayload(message),
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent(context, {
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      });

      const retry = message.subagent_retry;
      if (retry) {
        // Claude 2.1.214 emits periodic heartbeat frames for silent tools and
        // attaches structured retry data when a subagent is actually being
        // retried. Heartbeats remain ephemeral liveness signals; only one row
        // per concrete retry attempt belongs in Cafe's durable work log.
        const retryKey = `${retry.agent_id}:${retry.attempt}`;
        const alreadyReported = context.turnState?.reportedSubagentRetryKeys.has(retryKey) ?? false;
        if (!alreadyReported) {
          context.turnState?.reportedSubagentRetryKeys.add(retryKey);
          const subagentType = sanitizeDiagnosticLine(message.subagent_type ?? "").slice(0, 120);
          const errorCategory = sanitizeDiagnosticLine(retry.error_category).slice(0, 120);
          const attempt = Math.max(1, Math.trunc(retry.attempt));
          const maxRetries = Math.max(attempt, Math.trunc(retry.max_retries));
          const retryDelayMs = Math.max(0, Math.trunc(retry.retry_delay_ms));
          const retryTarget = subagentType ? `${subagentType} subagent` : "Claude subagent";
          const retrySummary = `Retrying ${retryTarget}${
            errorCategory ? ` after ${errorCategory}` : ""
          } (retry ${attempt}/${maxRetries}${
            retryDelayMs > 0 ? `, ${retryDelayMs} ms delay` : ""
          }).`;
          const binding = bindClaudeTaskToToolUse(context, {
            taskId: message.task_id ?? retry.agent_id,
            // Retry copy is progress state, not the provider's task title.
            // Omitting it here preserves an established description while a
            // first-seen retry still receives a role-derived structured label.
            ...(subagentType ? { subagentType } : {}),
            taskType: "subagent",
            startedAt: base.createdAt,
          });
          if (!binding) {
            return;
          }
          const subagent = claudeSubagentPresentation(binding, "active");
          const visibility = claudeTaskVisibilityForBinding(context, binding);

          yield* offerRuntimeEvent(context, {
            ...base,
            turnId: binding.turnId ?? undefined,
            type: "task.progress",
            payload: {
              taskId: binding.taskId,
              description: retrySummary,
              summary: retrySummary,
              lastToolName: message.tool_name,
              visibility,
              ...(subagent ? { subagent } : {}),
            },
          });
        }
      }
      return;
    }

    if (message.type === "tool_use_summary") {
      const summary = claudeSubagentDisplayLine(message.summary, CLAUDE_TASK_SUMMARY_TEXT_LIMIT);
      if (!summary) return;
      yield* offerRuntimeEvent(context, {
        ...base,
        type: "tool.summary",
        payload: {
          summary,
          ...(message.preceding_tool_use_ids.length > 0
            ? {
                precedingToolUseIds: message.preceding_tool_use_ids,
              }
            : {}),
        },
      });
      return;
    }

    if (message.type === "auth_status") {
      yield* offerRuntimeEvent(context, {
        ...base,
        type: "auth.status",
        payload: {
          isAuthenticating: message.isAuthenticating,
          output: message.output,
          ...(message.error ? { error: message.error } : {}),
        },
      });
      return;
    }

    if (message.type === "rate_limit_event") {
      yield* offerRuntimeEvent(context, {
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      return;
    }

    const rawMessage = message as unknown as Record<string, unknown>;
    if (rawMessage.type === "control_request_progress") {
      // Claude Agent SDK 0.3.198 added progress frames for control-channel
      // requests. The shape is intentionally loose in the published types, so
      // only promote obvious human-readable progress text; otherwise the raw
      // native event remains available through the provider log without
      // creating a generic "unhandled SDK message" warning.
      const summary =
        trimmedStringValue(rawMessage.summary) ??
        trimmedStringValue(rawMessage.message) ??
        trimmedStringValue(rawMessage.content) ??
        trimmedStringValue(rawMessage.text);
      if (summary) {
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "tool.progress",
          payload: {
            summary,
          },
        });
      }
      return;
    }

    if (rawMessage.type === "conversation_reset") {
      // Conversation resets are upstream session lifecycle state, not a turn
      // failure. Mark the thread active so the next user message can continue
      // on the fresh upstream conversation without surfacing a scary warning.
      yield* offerRuntimeEvent(context, {
        ...base,
        type: "thread.state.changed",
        payload: {
          state: "active",
          detail: rawMessage,
        },
      });
      return;
    }

    if (rawMessage.type === "active_goal") {
      // Claude Code 2.1.198 can forward active-goal frames even though the SDK
      // declaration currently lists them only on the lower-level stdout union.
      // Cafe does not have a dedicated active-goal pane, but a concise work-log
      // progress row is useful and avoids a false unhandled-message warning.
      const goal = claudeSubagentDisplayLine(
        rawMessage.goal ?? rawMessage.objective ?? rawMessage.title ?? rawMessage.description,
        CLAUDE_TASK_SUMMARY_TEXT_LIMIT,
      );
      if (goal) {
        const goalTaskId = canonicalClaudeTaskId(
          trimmedStringValue(rawMessage.goal_id) ??
            trimmedStringValue(rawMessage.id) ??
            "claude-active-goal",
        );
        if (!goalTaskId) {
          return;
        }
        yield* offerRuntimeEvent(context, {
          ...base,
          type: "task.progress",
          payload: {
            taskId: goalTaskId,
            description: "Active goal",
            summary: goal,
          },
        });
      }
      return;
    }

    if (rawMessage.type === "autocompact_state") {
      // Agent SDK 0.3.234 forwards this lower-level host synchronization frame,
      // while Cafe already receives authoritative compaction lifecycle through
      // system/status and system/compact_boundary. Treat it as transport state
      // rather than duplicating UI or work-log events.
      return;
    }

    if (rawMessage.type === "transcript_mirror") {
      // Current SDK releases consume transcript mirrors internally before the
      // public async iterator. Keep this guard for mixed CLI/SDK deployments so
      // a leaked internal persistence frame never becomes a user-facing warning.
      return;
    }
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    incomingMessage: SDKMessage,
  ) {
    // Redaction is deliberately before every logger, accounting mapper, raw
    // event and transcript projection. Even rejected/foreign/subagent reports
    // must not bypass privacy simply because they cannot update the metadata.
    const stripped = stripClaudeUsageReport(incomingMessage);
    const message = stripped.message;
    if (stripped.hasReport) {
      const primary =
        message.type === "assistant" &&
        (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined);
      const sameNativeSession =
        typeof message.session_id === "string" &&
        message.session_id.length > 0 &&
        message.session_id.length <= 1024 &&
        context.resumeSessionId !== undefined &&
        context.lastThreadStartedId === context.resumeSessionId &&
        message.session_id === context.resumeSessionId;
      if (
        primary &&
        sameNativeSession &&
        !context.stopped &&
        !context.authFailureSeen &&
        sessions.get(context.session.threadId) === context
      ) {
        const observedAt = yield* nowIso;
        setQuotaReport(context, mapClaudeSessionQuotaReport(stripped.report, observedAt));
      }
      yield* logNativeSdkMessage(context, message);
      // A quota-bearing frame is not session-identity or synthetic-turn
      // authority. Only the ordinary text of an already-active user turn may
      // continue through projection; an idle report changes metadata only.
      if (!primary || !sameNativeSession || !context.turnState || context.stopped) return;
    } else {
      yield* logNativeSdkMessage(context, message);
    }
    if (message.type === "system" && sdkMessageSubtype(message) === "session_title_changed") {
      // Claude Code 2.1.285 added this internal session-name notification,
      // which is still absent from the published SDK union. It may precede
      // init or repeat; Cafe owns its chat titles and session identity, so
      // retain only the existing protected native log, without rebinding the
      // session or publishing the title as a canonical event or warning.
      return;
    }
    // Command telemetry cannot establish or replace native conversation
    // identity. In particular a pre-init push must await the authoritative
    // init frame and a foreign-session push must not rebind this query.
    if (
      !stripped.hasReport &&
      !(message.type === "system" && message.subtype === "commands_changed")
    ) {
      yield* ensureThreadId(context, message);
    }
    yield* recordTurnSdkMessage(context, message);

    const rawMessageType = sdkMessageType(message);
    // Account at the SDK boundary, including every intermediate result emitted
    // while a queued steer keeps the canonical Cafe turn running. Delaying this
    // until completeTurn would lose the last good totals if a later segment
    // crashes. Only bounded numeric/model metadata enters this new event.
    if (rawMessageType === "conversation_reset") {
      setQuotaReport(context, undefined);
      const reset = message as unknown as Record<string, unknown>;
      const conversationId = reset.new_conversation_id;
      if (
        typeof conversationId === "string" &&
        isUuid(conversationId) &&
        !context.usageAccountingResetIds.has(conversationId) &&
        context.usageAccountingResetIds.size < 16_384
      ) {
        context.usageAccountingResetIds.add(conversationId);
        context.usageAccounting = makeClaudeUsageAccounting(randomUUID());
      } else if (context.usageAccountingResetIds.size >= 16_384) {
        // Never reuse an old epoch after exhausting reset-identity tracking.
        // Preserve the last known accounting lower bound until a new query
        // starts with fresh bounded state instead of guessing counter offsets.
        context.usageAccountingResetOverflow = true;
      }
    }
    const accounting = context.usageAccountingResetOverflow
      ? undefined
      : message.type === "assistant"
        ? observeClaudeAssistantUsage(context.usageAccounting, message)
        : message.type === "result"
          ? observeClaudeResultUsage(context.usageAccounting, message)
          : undefined;
    if (accounting) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        ...stamp,
        type: "thread.usage-accounting.updated",
        provider: PROVIDER,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        payload: accounting,
        providerRefs: {},
      });
    }
    if (rawMessageType === "command_lifecycle") {
      const lifecycleMessage = readClaudeCommandLifecycleMessage(message);
      if (lifecycleMessage) {
        yield* handleCommandLifecycleMessage(context, lifecycleMessage);
      } else {
        yield* emitRuntimeWarning(
          context,
          "Claude emitted a malformed command_lifecycle frame.",
          message,
        );
      }
      return;
    }
    if (
      rawMessageType === "control_request_progress" ||
      rawMessageType === "conversation_reset" ||
      rawMessageType === "active_goal" ||
      rawMessageType === "autocompact_state" ||
      rawMessageType === "transcript_mirror"
    ) {
      yield* handleSdkTelemetryMessage(context, message);
      return;
    }

    switch (message.type) {
      case "stream_event":
        yield* handleStreamEvent(context, message);
        return;
      case "user":
        yield* handleUserMessage(context, message);
        return;
      case "assistant":
        yield* handleAssistantMessage(context, message);
        return;
      case "result":
        yield* handleResultMessage(context, message);
        return;
      case "system":
        yield* handleSystemMessage(context, message);
        return;
      case "tool_progress":
      case "tool_use_summary":
      case "auth_status":
      case "rate_limit_event":
        yield* handleSdkTelemetryMessage(context, message);
        return;
      case "prompt_suggestion":
        // Claude can predict a next user prompt after a turn when prompt
        // suggestions are enabled. Cafe has no UI for these suggestions yet,
        // so preserve the raw native event but do not surface a generic
        // provider warning.
        return;
      default:
        const unknownSdkMessage = message as unknown as Record<string, unknown>;
        yield* emitRuntimeWarning(
          context,
          `Unhandled Claude SDK message type '${String(unknownSdkMessage.type)}'.`,
          message,
        );
        return;
    }
  });

  const runSdkStream = (
    context: ClaudeSessionContext,
  ): Effect.Effect<void, ProviderAdapterProcessError> =>
    Stream.fromAsyncIterable(
      {
        [Symbol.asyncIterator]() {
          const iterator = context.query[Symbol.asyncIterator]();
          return {
            async next() {
              try {
                const message = await iterator.next();
                // Count before stream batching or logger/normalizer awaits can
                // hide a consumed task_started edge from idle retirement, or a
                // terminal result from explicit-priority admission. None of
                // these new priority-only fences change ordinary steer rules.
                if (message.done) {
                  context.sdkStreamEnded = true;
                } else {
                  context.inFlightSdkMessageCount += 1;
                  context.sdkMessageRevision += 1;
                  if (isClaudePriorityTurnBoundaryMessage(message.value)) {
                    context.inFlightSdkTurnBoundaryCount += 1;
                  }
                }
                return message;
              } catch (cause) {
                context.sdkStreamEnded = true;
                throw cause;
              }
            },
            ...(iterator.return ? { return: () => iterator.return!() } : {}),
          };
        },
      },
      (cause) => toProcessError(cause, "Claude runtime stream failed.", context.session.threadId),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) =>
        handleSdkMessage(context, message).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              context.inFlightSdkMessageCount = Math.max(0, context.inFlightSdkMessageCount - 1);
              if (isClaudePriorityTurnBoundaryMessage(message)) {
                context.inFlightSdkTurnBoundaryCount = Math.max(
                  0,
                  context.inFlightSdkTurnBoundaryCount - 1,
                );
              }
            }),
          ),
        ),
      ),
    );

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, ProviderAdapterProcessError>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      if (isClaudeInterruptedCause(exit.cause)) {
        if (context.turnState) {
          yield* completeTurn(
            context,
            "interrupted",
            interruptionMessageFromClaudeCause(exit.cause),
          );
        }
      } else {
        const message = messageFromClaudeStreamCause(exit.cause, "Claude runtime stream failed.");
        yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
        yield* completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: {
      readonly emitExitEvent?: boolean;
      readonly interruptStreamFiber?: boolean;
      readonly retirementReserved?: boolean;
      readonly queryAlreadyClosed?: boolean;
    },
  ) {
    if (context.stopped && !options?.retirementReserved && !context.queryClosureUncertain) return;

    // Inconclusive teardown deliberately retains an ownership-fenced context
    // in sessions. Remove presentation metadata synchronously so that retained
    // context cannot keep serving a stopped query's old quota level.
    const hadQuotaReport = context.session.quotaReport !== undefined;
    const { quotaReport: _stoppedQuota, ...stoppedSession } = context.session;
    context.session = stoppedSession;
    context.stopped = true;
    // Any cleanup failure before query.close is also inconclusive teardown.
    // Keep the ownership fence until that exact query is proven closed.
    context.queryClosureUncertain = options?.queryAlreadyClosed !== true;

    // Revoke before any asynchronous provider teardown. Even an uncertain
    // native close must not leave a stopped query able to schedule new work.
    yield* Effect.promise(() => context.schedulingBinding?.dispose() ?? Promise.resolve()).pipe(
      Effect.catchCause(() => Effect.logWarning("Claude scheduling cleanup remains pending.")),
    );
    if (hadQuotaReport) {
      // The coalesced publisher is stopped-fenced; explicitly invalidate this
      // revoked level without waiting for provider close/exit acknowledgement.
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        ...stamp,
        type: "session.configured",
        provider: PROVIDER,
        threadId: context.session.threadId,
        payload: { config: {}, quotaReportChanged: true },
        providerRefs: {},
      });
    }

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "request.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision: "cancel",
        },
        providerRefs: nativeProviderRefs(context),
      });
    }
    context.pendingApprovals.clear();
    for (const pending of context.pendingUserInputs.values()) {
      yield* Deferred.succeed(pending.answers, { __cafeInteraction: { action: "cancel" } });
    }
    context.pendingUserInputs.clear();
    context.promptLifecycleByUuid.clear();

    if (context.turnState) {
      yield* completeTurn(context, "interrupted", "Session stopped.");
    }

    yield* Queue.shutdown(context.promptQueue);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;
    if (
      options?.interruptStreamFiber !== false &&
      streamFiber &&
      streamFiber.pollUnsafe() === undefined
    ) {
      yield* Fiber.interrupt(streamFiber);
    }

    yield* Effect.tryPromise({
      try: async () => {
        if (!options?.queryAlreadyClosed) context.query.close();
        if (context.rewindRetirementUncertain && !options?.queryAlreadyClosed) {
          if (!context.query.waitForExit) throw new Error("Claude rewind has no exit observation.");
          await context.query.waitForExit();
        }
        context.queryClosureUncertain = false;
        context.rewindRetirementUncertain = false;
      },
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: toMessage(cause, "Failed to close Claude runtime query."),
          cause,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: 10_000,
        orElse: () =>
          Effect.fail(
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.session.threadId,
              detail: "Claude runtime exit could not be verified.",
            }),
          ),
      }),
      Effect.catch((cause) => {
        context.queryClosureUncertain = true;
        return emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
      }),
    );

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: context.queryClosureUncertain ? "error" : "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: "Session stopped",
          exitKind: "graceful",
        },
        providerRefs: {},
      });
    }

    if (!context.queryClosureUncertain) sessions.delete(context.session.threadId);
  });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(
        new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(
        new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        }),
      );
    }
    return Effect.succeed(context);
  };

  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")((input) => {
    let schedulingBinding: SchedulingSessionBinding | undefined;
    let startedQuery: ClaudeQueryRuntime | undefined;
    let startedContext: ClaudeSessionContext | undefined;
    let sessionTransferred = false;
    return Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existingContext = sessions.get(input.threadId);
      // A failed native close is not proof of retirement. Keep its ownership
      // fence until an explicit stop successfully closes that exact query;
      // neither ordinary replacement nor a concurrency change may start a
      // competing query while the old process could still be alive.
      if (existingContext?.queryClosureUncertain) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/reconfigure",
          remoteErrorTag: "subagent-concurrency-retirement-uncertain",
          detail: "The existing provider runtime could not be conclusively retired.",
        });
      }
      const maxConcurrentSubagents = yield* Effect.try({
        try: () =>
          resolveConfiguredSubagentLimit(
            input.maxConcurrentSubagents,
            claudeSettings.maxConcurrentSubagents,
          ),
        catch: () =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Subagent concurrency must be an integer between 1 and 64.",
          }),
      });
      if (input.requireIdleForSubagentLimitChange && !options?.getSubagentConcurrencySupport?.()) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/reconfigure",
          remoteErrorTag: "subagent-concurrency-active",
          detail: "Subagent concurrency is unavailable for this configured provider runtime.",
        });
      }
      const sessionEnvironment = yield* makeClaudeEnvironment(
        {
          homePath: claudeSettings.homePath,
          ...(maxConcurrentSubagents !== null ? { maxConcurrentSubagents } : {}),
        },
        options?.resolveEnvironment ? yield* options.resolveEnvironment : options?.environment,
      ).pipe(Effect.provideService(Path.Path, path));
      if (existingContext) {
        yield* Effect.logWarning("claude.session.replacing", {
          threadId: input.threadId,
          existingSessionStatus: existingContext.session.status,
          reason: "startSession called with existing active session",
        });
        const stopExisting = Effect.suspend(() => {
          if (
            input.requireIdleForSubagentLimitChange &&
            !reserveClaudeIdleRetirement(existingContext)
          ) {
            return Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/reconfigure",
                remoteErrorTag: "subagent-concurrency-active",
                detail:
                  "Subagent concurrency cannot change while provider work is active or uncertain.",
              }),
            );
          }
          if (!input.requireIdleForSubagentLimitChange) {
            return stopSessionInternal(existingContext, { emitExitEvent: false });
          }
          // The SDK's close is synchronous. Reserve above and close before any
          // fallible cleanup awaits, so admission is atomic with native
          // retirement. A thrown close must not be hidden by best-effort stop
          // cleanup, or mistaken for an active-limit deferral by the reactor.
          return Effect.try({
            try: () => existingContext.query.close(),
            catch: () => {
              existingContext.queryClosureUncertain = true;
              existingContext.session = { ...existingContext.session, status: "error" };
              return new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/reconfigure",
                remoteErrorTag: "subagent-concurrency-retirement-uncertain",
                detail: "The existing provider runtime could not be conclusively retired.",
              });
            },
          }).pipe(
            Effect.andThen(
              stopSessionInternal(existingContext, {
                emitExitEvent: false,
                retirementReserved: true,
                queryAlreadyClosed: true,
              }),
            ),
          );
        });
        yield* input.requireIdleForSubagentLimitChange
          ? stopExisting
          : stopExisting.pipe(
              // Replacement cleanup is best-effort: never block the new session on
              // either typed failures or unexpected defects from tearing down the old one.
              Effect.catchCause((cause) =>
                Effect.logWarning("claude.session.replace.stop-failed", {
                  threadId: input.threadId,
                  cause,
                }),
              ),
            );
        if (existingContext.queryClosureUncertain) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/reconfigure",
            remoteErrorTag: "subagent-concurrency-retirement-uncertain",
            detail: "The existing provider runtime could not be conclusively retired.",
          });
        }
      }

      const startedAt = yield* nowIso;
      const resumeState = readClaudeResumeState(input.resumeCursor);
      if (resumeState?.rewindMessageIdsInvalid || resumeState?.forkMessageIdsInvalid) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "The saved Claude checkpoint lineage is invalid; its conversation was preserved.",
        });
      }
      let durableResumeState = isDurableClaudeResumeState(resumeState) ? resumeState : undefined;
      const threadId = input.threadId;

      const runtimeContext = yield* Effect.context<never>();
      const runFork = Effect.runForkWith(runtimeContext);
      const runPromise = Effect.runPromiseWith(runtimeContext);

      const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
      const prompt = Stream.fromQueue(promptQueue).pipe(
        Stream.filter((item) => item.type === "message"),
        Stream.map((item) => item.message),
        Stream.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
        ),
        Stream.toAsyncIterable,
      );

      const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
      const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
      const inFlightTools = new Map<string, ToolInFlight>();

      const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

      const onElicitationEffect = Effect.fn("claude.onElicitation")(function* (
        request: Parameters<OnElicitation>[0],
        callback: Parameters<OnElicitation>[1],
      ) {
        const context = yield* Ref.get(contextRef);
        if (!context || context.stopped || callback.signal.aborted)
          return { action: "cancel" as const };
        const interaction = normalizeElicitationRequest({
          ...request,
          mode: request.mode ?? "form",
        });
        if (!interaction || pendingUserInputs.size >= 64) return { action: "decline" as const };
        const interactionUrl =
          interaction.mode === "url" ? getSafeInteractionUrl(request.url) : null;
        if (interaction.mode === "url" && !interactionUrl) return { action: "decline" as const };
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();
        pendingUserInputs.set(requestId, {
          questions: [],
          answers,
          interaction,
          ...(interactionUrl ? { interactionUrl } : {}),
        });
        const requestedStamp = yield* makeEventStamp();
        const received = yield* awaitClaudeDecision({
          signal: callback.signal,
          decision: answers,
          cancelled: { __cafeInteraction: { action: "cancel" } },
          publish: offerRuntimeEvent(context, {
            type: "user-input.requested",
            ...requestedStamp,
            provider: PROVIDER,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: { questions: [], isBlocking: true, interaction },
            providerRefs: nativeProviderRefs(context),
          }),
          onClose: () => {
            pendingUserInputs.delete(requestId);
          },
        });
        const response =
          callback.signal.aborted || context.stopped
            ? { action: "cancel" as const }
            : (validateInteractionResponse(interaction, received) ?? { action: "cancel" as const });
        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "user-input.resolved",
          ...resolvedStamp,
          provider: PROVIDER,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          // Form answers and authorization capabilities go only to the waiting
          // SDK callback, never into logs or the durable resolution event.
          payload: { answers: { __cafeInteraction: { action: response.action } } },
          providerRefs: nativeProviderRefs(context),
        });
        return {
          action: response.action,
          ...(response.content
            ? {
                content: Object.fromEntries(
                  Object.entries(response.content).map(([key, value]) => [
                    key,
                    typeof value === "object" ? [...value] : value,
                  ]),
                ),
              }
            : {}),
        };
      });
      const onElicitation: OnElicitation = (request, callback) =>
        runPromise(onElicitationEffect(request, callback));

      /**
       * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
       * runtime event and waiting for the user to respond via `respondToUserInput`.
       */
      const handleAskUserQuestion = Effect.fn("handleAskUserQuestion")(function* (
        context: ClaudeSessionContext,
        toolInput: Record<string, unknown>,
        callbackOptions: {
          readonly signal: AbortSignal;
          readonly toolUseID?: string;
        },
      ) {
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);

        // Parse questions from the SDK's AskUserQuestion input.
        // `id` MUST equal the full question text — Claude SDK >= 2.1.121 looks
        // up answers by question text in `mapToolResultToToolResultBlockParam`,
        // so the key the UI uses to keep its draft answer must match the SDK's
        // expected lookup key. See https://github.com/pingdotgg/t3code/issues/2388
        const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
        const questions: Array<UserInputQuestion> = rawQuestions.map(
          (q: Record<string, unknown>, idx: number) => ({
            id: typeof q.question === "string" && q.question.length > 0 ? q.question : `q-${idx}`,
            header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
            question: typeof q.question === "string" ? q.question : "",
            options: Array.isArray(q.options)
              ? q.options.map((opt: Record<string, unknown>) => ({
                  label: typeof opt.label === "string" ? opt.label : "",
                  description: typeof opt.description === "string" ? opt.description : "",
                }))
              : [],
            multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
          }),
        );

        const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
        let aborted = false;
        const pendingInput: PendingUserInput = {
          questions,
          answers: answersDeferred,
        };

        // Emit user-input.requested so the UI can present the questions.
        const requestedStamp = yield* makeEventStamp();
        const publish = offerRuntimeEvent(context, {
          type: "user-input.requested",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: { questions },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/AskUserQuestion",
            payload: {
              toolName: "AskUserQuestion",
              input: toolInput,
            },
          },
        });

        pendingUserInputs.set(requestId, pendingInput);
        const answers = yield* awaitClaudeDecision({
          signal: callbackOptions.signal,
          decision: answersDeferred,
          cancelled: {} as ProviderUserInputAnswers,
          publish,
          onAbort: () => {
            aborted = true;
          },
          onClose: () => {
            pendingUserInputs.delete(requestId);
          },
        });

        // Emit user-input.resolved so the UI knows the interaction completed.
        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "user-input.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: { answers },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/AskUserQuestion/resolved",
            payload: { answers },
          },
        });

        if (aborted || context.stopped || callbackOptions.signal.aborted) {
          return {
            behavior: "deny",
            message: "User cancelled tool execution.",
          } satisfies PermissionResult;
        }

        // Return the answers to the SDK in the expected format:
        // { questions: [...], answers: { questionText: selectedLabel } }
        return {
          behavior: "allow",
          updatedInput: {
            questions: toolInput.questions,
            answers,
          },
        } satisfies PermissionResult;
      });

      const canUseToolEffect = Effect.fn("canUseTool")(function* (
        toolName: Parameters<CanUseTool>[0],
        toolInput: Parameters<CanUseTool>[1],
        callbackOptions: Parameters<CanUseTool>[2],
      ) {
        const context = yield* Ref.get(contextRef);
        if (!context || context.stopped || callbackOptions.signal.aborted) {
          return {
            behavior: "deny",
            message: "Claude session context is unavailable.",
          } satisfies PermissionResult;
        }

        // Handle AskUserQuestion: surface clarifying questions to the
        // user via the user-input runtime event channel, regardless of
        // runtime mode (plan mode relies on this heavily).
        if (toolName === "AskUserQuestion") {
          if (pendingUserInputs.size >= 64)
            return {
              behavior: "deny",
              message: "Too many pending user-input requests.",
            } satisfies PermissionResult;
          return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
        }

        if (toolName === "ExitPlanMode") {
          const planMarkdown = extractExitPlanModePlan(toolInput);
          if (planMarkdown) {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: callbackOptions.toolUseID,
              rawSource: "claude.sdk.permission",
              rawMethod: "canUseTool/ExitPlanMode",
              rawPayload: {
                toolName,
                input: toolInput,
              },
            });
          }

          return {
            behavior: "deny",
            message:
              "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          } satisfies PermissionResult;
        }

        const matchedAskRule = callbackOptions.matchedAskRule !== undefined;
        // Agent SDK 0.3.215 marks prompts forced by a user-configured
        // permissions.ask rule. That explicit rule is more specific than
        // Cafe's broad full-access mode, so it must still reach a human instead
        // of being silently auto-approved. Do not persist ruleContent here: it
        // can contain sensitive project policy and is not needed to honor the
        // upstream decision.
        // Only true bypass mode may skip Cafe's callback. Auto mode can be
        // layered over a historical full-access runtime policy, but upstream's
        // classifier must remain authoritative. If Auto falls back to a human
        // prompt, silently allowing it here would defeat the safety model.
        if (
          context.currentPermissionMode === "bypassPermissions" &&
          !matchedAskRule &&
          callbackOptions.defaultToNo !== true &&
          callbackOptions.suppressAlwaysAllowRule !== true
        ) {
          return {
            behavior: "allow",
            updatedInput: toolInput,
          } satisfies PermissionResult;
        }

        if (pendingApprovals.size >= 64)
          return {
            behavior: "deny",
            message: "Too many pending approval requests.",
          } satisfies PermissionResult;
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const requestType = classifyRequestType(toolName);
        const toolDetail = summarizeToolRequest(toolName, toolInput);
        const detail = matchedAskRule
          ? toolDetail
            ? `Permission rule requires confirmation. ${toolDetail}`
            : "Permission rule requires confirmation."
          : toolDetail;
        const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
        const pendingApproval: PendingApproval = {
          requestType,
          detail,
          decision: decisionDeferred,
          ...(callbackOptions.suppressAlwaysAllowRule === true
            ? { suppressAlwaysAllowRule: true }
            : {}),
          ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
        };

        const requestedStamp = yield* makeEventStamp();
        const publish = offerRuntimeEvent(context, {
          type: "request.opened",
          eventId: requestedStamp.eventId,
          provider: PROVIDER,
          createdAt: requestedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            detail,
            ...(callbackOptions.defaultToNo === true ? { defaultToNo: true } : {}),
            ...(callbackOptions.suppressAlwaysAllowRule === true
              ? { suppressAlwaysAllowRule: true }
              : {}),
            args: {
              toolName,
              input: toolInput,
              ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
              ...(matchedAskRule ? { matchedAskRule: true } : {}),
            },
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/request",
            payload: {
              toolName,
              input: toolInput,
              ...(matchedAskRule ? { matchedAskRule: true } : {}),
            },
          },
        });

        pendingApprovals.set(requestId, pendingApproval);
        const decision = yield* awaitClaudeDecision<ProviderApprovalDecision>({
          signal: callbackOptions.signal,
          decision: decisionDeferred,
          cancelled: "cancel",
          publish,
          onClose: () => {
            pendingApprovals.delete(requestId);
          },
        });

        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "request.resolved",
          eventId: resolvedStamp.eventId,
          provider: PROVIDER,
          createdAt: resolvedStamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          requestId: asRuntimeRequestId(requestId),
          payload: {
            requestType,
            decision,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: callbackOptions.toolUseID,
          }),
          raw: {
            source: "claude.sdk.permission",
            method: "canUseTool/decision",
            payload: {
              decision,
            },
          },
        });

        if (
          (decision === "accept" || decision === "acceptForSession") &&
          !callbackOptions.signal.aborted &&
          !context.stopped
        ) {
          const sessionPermissionUpdates =
            decision === "acceptForSession"
              ? pendingApproval.suggestions?.filter(
                  (suggestion) => suggestion.destination === "session",
                )
              : undefined;
          return {
            behavior: "allow",
            updatedInput: toolInput,
            ...(sessionPermissionUpdates && sessionPermissionUpdates.length > 0
              ? {
                  // The Cafe decision label promises session-only scope.
                  // Claude suggestions may also contain persistent settings or
                  // CLI destinations; forwarding those here would silently
                  // outlive the approval the user actually granted.
                  updatedPermissions: sessionPermissionUpdates,
                }
              : {}),
          } satisfies PermissionResult;
        }

        return {
          behavior: "deny",
          message:
            decision === "cancel"
              ? "User cancelled tool execution."
              : "User declined tool execution.",
        } satisfies PermissionResult;
      });

      const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
        runPromise(canUseToolEffect(toolName, toolInput, callbackOptions));

      const claudeBinaryPath = claudeSettings.binaryPath;
      const extraArgs = parseCliArgs(claudeSettings.launchArgs).flags;
      const modelSelection =
        input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
      const {
        apiModelId,
        selectedContextWindowTokens,
        effectiveEffort,
        agentProgressSummaries,
        settings,
      } = resolveClaudeModelSessionOptions(
        modelSelection,
        modelSelection?.model && options?.getModelCapabilities
          ? yield* options.getModelCapabilities(modelSelection.model)
          : undefined,
      );
      const fastMode = settings.fastMode === true;
      const permissionMode = runtimeModeToClaudePermissionMode(input.runtimeMode);
      const initialPermissionMode = resolveClaudePermissionMode({
        interactionMode: input.interactionMode,
        basePermissionMode: permissionMode,
      });
      const claudeAdditionalDirectories = [
        ...(input.cwd ? [input.cwd] : []),
        ...(input.additionalDirectories ?? []),
      ].filter((directory, index, directories) => directories.indexOf(directory) === index);

      const initialResumeSessionId = durableResumeState?.resume;
      // Recovery is bounded and distinguishes proven absence from inaccessible
      // or unsafe storage. Never discard a durable conversation on I/O failure.
      if (durableResumeState?.resume && input.cwd) {
        const recovery = yield* Effect.promise((signal) =>
          recoverClaudeResume({
            configDirectory: resolveClaudeConfigDirectory(path, sessionEnvironment),
            projectKey:
              sessionEnvironment.CLAUDE_CODE_PROJECT_DIR_NAME?.trim() ||
              claudeProjectDirectoryName(path, input.cwd!),
            sessionId: durableResumeState!.resume!,
            ...(durableResumeState?.resumeSessionAt
              ? { checkpoint: durableResumeState.resumeSessionAt }
              : {}),
            signal,
          }),
        );
        if (recovery.status === "inconclusive") {
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/resume",
              detail:
                "Could not safely inspect the saved Claude conversation. Its identity was preserved; check storage access and retry.",
            }),
          );
        }
        if (recovery.status === "missing") {
          yield* Effect.logWarning("claude.resume.cursor.dropped-missing-transcript", { threadId });
          durableResumeState = undefined;
        } else if (recovery.sessionId !== durableResumeState.resume) {
          const { resumeSessionAt: _checkpoint, ...rest } = durableResumeState;
          durableResumeState = { ...rest, resume: recovery.sessionId };
        }
      }

      const existingResumeSessionId = durableResumeState?.resume;
      const resumeBaseTurnCount = durableResumeState?.turnCount ?? 0;
      // Capture a numeric offset before query() can restore and automatically
      // continue work. Since Claude Code 2.1.277, result.modelUsage includes
      // saved history, including on a fork. Missing/unsafe metadata is nonfatal:
      // the accounting layer retains only provably new usage in that case.
      const resumeUsageBaseline: ClaudeUsageBaseline | undefined = existingResumeSessionId
        ? input.cwd
          ? yield* Effect.promise((signal) =>
              readClaudeUsageBaseline({
                configDirectory: resolveClaudeConfigDirectory(path, sessionEnvironment),
                projectKey:
                  sessionEnvironment.CLAUDE_CODE_PROJECT_DIR_NAME?.trim() ||
                  claudeProjectDirectoryName(path, input.cwd!),
                sessionId: existingResumeSessionId,
                signal,
              }),
            ).pipe(
              Effect.timeoutOrElse({
                duration: 1_000,
                orElse: () => Effect.succeed<ClaudeUsageBaseline>({ status: "unavailable" }),
              }),
            )
          : { status: "unavailable" }
        : undefined;

      const schedulingBroker = readSchedulingSessionBroker();
      if (schedulingBroker) {
        // Install cleanup ownership before restoring interruption. The prior
        // query has already retired above, so this generation may become
        // active before the SDK starts consuming its streaming prompt queue.
        yield* Effect.uninterruptible(
          Effect.tryPromise({
            try: async () => {
              schedulingBinding = await schedulingBroker.bind({
                threadId,
                providerInstanceId: boundInstanceId,
                provider: "claudeAgent",
              });
              await schedulingBinding.activate();
            },
            catch: () =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: "Failed to prepare this session's scheduling tools.",
              }),
          }),
        );
      }

      const queryOptions: ClaudeQueryOptions = {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(apiModelId ? { model: apiModelId } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: [...CLAUDE_SETTING_SOURCES],
        // SDK 0.3.288 supports per-query stdio MCP configuration. Leave
        // strictMcpConfig and permission allowlists unset: user/project MCP
        // sources and the existing permission callback remain authoritative.
        // alwaysLoad makes this small built-in catalog discoverable on the
        // first turn without granting permission to invoke any of its tools.
        // https://code.claude.com/docs/en/agent-sdk/mcp
        ...(schedulingBinding
          ? {
              mcpServers: {
                [schedulingBinding.name]: {
                  type: "stdio" as const,
                  command: schedulingBinding.launch.command,
                  args: [...schedulingBinding.launch.args],
                  env: { ...schedulingBinding.launch.env },
                  alwaysLoad: true,
                },
              },
            }
          : {}),
        // The SDK type can lag the CLI here: current Claude Code exposes
        // `xhigh`, but older published Agent SDK unions may not include it yet.
        ...(effectiveEffort
          ? {
              effort: effectiveEffort as unknown as NonNullable<ClaudeQueryOptions["effort"]>,
            }
          : {}),
        // Claude's Agent SDK supports setting the session permission mode at
        // query creation, and reserves setPermissionMode() for changing an
        // already-active streaming session. Starting a plan-mode first turn
        // here avoids a pre-prompt control request that current Claude Code
        // rejects because no transcript message exists yet.
        ...(initialPermissionMode ? { permissionMode: initialPermissionMode } : {}),
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
        ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
        // Agent SDK Options.title suppresses native auto-title generation for
        // a new session. Cafe already owns its task label, so supply that seed
        // (or a fixed recovery label) without another model request or prompt
        // injection. Decide after resume repair: a missing transcript starts
        // fresh, while a real resume must retain its persisted native title.
        // Reference: @anthropic-ai/claude-agent-sdk 0.3.260 Options.title.
        ...(!existingResumeSessionId ? { title: makeProviderSessionTitle(input.title) } : {}),
        // Let upstream Claude Code allocate fresh session IDs. The Agent SDK
        // documents `sessionId` as an optional override whose default is an
        // auto-generated UUID, and its sessions guide recommends capturing the
        // durable ID from the init/result SDK messages before later passing it
        // back through `resume`. With Cafe's long-lived AsyncIterable prompt
        // queue, preassigning a fresh `--session-id` can make current Claude
        // Code validate the ID before a transcript exists and fail the turn
        // with "No conversation found with session ID". We therefore only
        // send upstream resume coordinates after a real persisted Claude
        // transcript has produced a session_id.
        includePartialMessages: true,
        // Cafe has no next-prompt suggestion surface. Disable the speculative
        // model request explicitly so provider/user settings cannot spend
        // tokens on a message that Cafe intentionally discards.
        promptSuggestions: false,
        // Claude's SDK intentionally withholds subagent prose by default. Cafe
        // opts into the complete nested stream, then uses parent_tool_use_id to
        // keep child text in task/work-log activity rather than corrupting the
        // main assistant transcript. Agent SDK 0.3.225 also fixes the matching
        // headless worker-resume path after background Bash/Monitor completion.
        forwardSubagentText: true,
        // Upstream documents this as the CLI-supported way to receive
        // periodic AI-written summaries for long-running subagents. Without it,
        // Claude can be doing real background work while Cafe only sees sparse
        // task/tool lifecycle frames, which makes long turns look silent.
        agentProgressSummaries,
        canUseTool,
        onElicitation,
        stderr: (data: string) => {
          const lines = splitClaudeStderrLines(data);
          if (lines.length === 0) {
            return;
          }
          runFork(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                yield* Effect.logWarning("claude.stderr.before-context", {
                  lines,
                });
                return;
              }
              for (const line of lines) {
                yield* emitClaudeProcessStderr(context, line);
              }
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("claude.stderr.emit-failed", {
                  lines,
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          );
        },
        env: sessionEnvironment,
        ...(claudeAdditionalDirectories.length > 0
          ? { additionalDirectories: [...claudeAdditionalDirectories] }
          : {}),
        ...(Object.keys(extraArgs).length > 0 ? { extraArgs } : {}),
      };

      yield* Effect.annotateCurrentSpan({
        "provider.kind": PROVIDER,
        "provider.thread_id": threadId,
        "provider.runtime_mode": input.runtimeMode,
        "claude.resume.source":
          existingResumeSessionId !== undefined ? "resume-session" : "fresh-session",
        "claude.resume.dropped_missing_transcript":
          initialResumeSessionId !== undefined && existingResumeSessionId === undefined,
        "claude.resume.thread_id": durableResumeState?.threadId ?? "",
        "claude.resume.session_id": existingResumeSessionId ?? initialResumeSessionId ?? "",
        "claude.resume.session_at_ignored": durableResumeState?.resumeSessionAt ?? "",
        "claude.resume.turn_count": durableResumeState?.turnCount ?? -1,
        "claude.query.cwd": input.cwd ?? "",
        "claude.query.model": apiModelId ?? "",
        "claude.query.effort": effectiveEffort ?? "",
        "claude.query.permission_mode": initialPermissionMode ?? "",
        "claude.query.base_permission_mode": permissionMode ?? "",
        "claude.query.allow_dangerously_skip_permissions": permissionMode === "bypassPermissions",
        "claude.query.resume": existingResumeSessionId ?? "",
        "claude.query.resume_session_at": "",
        "claude.query.session_id": "",
        "claude.query.include_partial_messages": true,
        "claude.query.agent_progress_summaries": agentProgressSummaries,
        "claude.query.additional_directories": claudeAdditionalDirectories,
        "claude.query.setting_sources": [...CLAUDE_SETTING_SOURCES],
        "claude.query.settings_json": encodeJsonStringForDiagnostics(settings) ?? "",
        "claude.query.extra_args_json": encodeJsonStringForDiagnostics(extraArgs) ?? "",
        "claude.query.path_to_executable": claudeBinaryPath,
      });

      const queryRuntime = yield* Effect.try({
        try: () => {
          startedQuery = createQuery({
            prompt,
            options: queryOptions,
          });
          return startedQuery;
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to start Claude runtime session."),
            cause,
          }),
      });

      const initialResumeCursor =
        existingResumeSessionId !== undefined
          ? {
              ...(threadId ? { threadId } : {}),
              resume: existingResumeSessionId,
              turnCount: resumeBaseTurnCount,
              ...(durableResumeState?.rewindMessageIds
                ? { rewindMessageIds: durableResumeState.rewindMessageIds }
                : {}),
              ...(durableResumeState?.forkMessageIds
                ? { forkMessageIds: durableResumeState.forkMessageIds }
                : {}),
            }
          : undefined;
      const subagentRuntimeId = randomUUID();
      const session: ProviderSession = {
        threadId,
        provider: PROVIDER,
        commandCatalog: {
          status: queryRuntime.supportedCommands ? "loading" : "unavailable",
          commands: [],
        },
        ...(options?.commandCatalogConfigurationKey
          ? { commandCatalogConfigurationKey: options.commandCatalogConfigurationKey }
          : {}),
        subagentRuntimeId,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        maxConcurrentSubagents,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.additionalDirectories !== undefined
          ? { additionalDirectories: input.additionalDirectories }
          : {}),
        ...(modelSelection?.model ? { model: modelSelection.model } : {}),
        ...(threadId ? { threadId } : {}),
        ...(initialResumeCursor !== undefined ? { resumeCursor: initialResumeCursor } : {}),
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: ClaudeSessionContext = {
        taskControlVersion: options?.getNativeVersion?.(),
        session,
        subagentRuntimeId,
        environment: sessionEnvironment,
        taskLivenessUncertain: false,
        inFlightSdkMessageCount: 0,
        inFlightSdkTurnBoundaryCount: 0,
        sdkStreamEnded: false,
        sdkMessageRevision: 0,
        queryClosureUncertain: false,
        rewindRetirementUncertain: false,
        promptQueue,
        query: queryRuntime,
        commandCatalogPushRevision: 0,
        commandCatalogPublishPending: false,
        quotaReportPublishPending: false,
        pendingCommandCatalog: undefined,
        schedulingBinding,
        runFork,
        streamFiber: undefined,
        startedAt,
        basePermissionMode: permissionMode,
        currentPermissionMode: initialPermissionMode ?? "default",
        currentApiModelId: apiModelId,
        selectedContextWindowTokens,
        resumeSessionId: existingResumeSessionId,
        resumeCursorDurable: existingResumeSessionId !== undefined,
        resumeBaseTurnCount,
        rewindMessageIds: durableResumeState?.rewindMessageIds,
        forkMessageIds: durableResumeState?.forkMessageIds ?? Object.create(null),
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        inFlightTools,
        backgroundTaskIds: new Set(),
        backgroundTaskBindings: new Map(),
        taskBindingsByToolUseId: new Map(),
        taskBindingsByTaskId: new Map(),
        hiddenTranscriptTaskIds: new Set(),
        snapshotRetractedTaskIds: new Set(),
        terminalTaskIds: new Set(),
        failClosedTaskVisibilityOverflow: false,
        promptLifecycleByUuid: new Map(),
        capabilities: new Set(),
        fastModeRequested: fastMode,
        turnState: undefined,
        deferredTurnResult: undefined,
        lastFastModeNoticeKey: undefined,
        lastKnownContextWindow: selectedContextWindowTokens,
        lastKnownTokenUsage: undefined,
        usageAccounting: makeClaudeUsageAccounting(randomUUID(), resumeUsageBaseline),
        usageAccountingResetIds: new Set(),
        usageAccountingResetOverflow: false,
        lastAssistantUuid: undefined,
        lastThreadStartedId: undefined,
        hasSubmittedUserPrompt: false,
        authFailureSeen: false,
        stopped: false,
      };
      startedContext = context;
      yield* Ref.set(contextRef, context);
      sessions.set(threadId, context);

      const sessionStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "session.started",
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        payload: initialResumeCursor !== undefined ? { resume: initialResumeCursor } : {},
        providerRefs: {},
      });

      const configuredStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "session.configured",
        eventId: configuredStamp.eventId,
        provider: PROVIDER,
        createdAt: configuredStamp.createdAt,
        threadId,
        payload: {
          config: {
            ...(apiModelId ? { model: apiModelId } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(effectiveEffort ? { effort: effectiveEffort } : {}),
            ...(initialPermissionMode ? { permissionMode: initialPermissionMode } : {}),
            ...(permissionMode ? { basePermissionMode: permissionMode } : {}),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
            ...(initialResumeSessionId !== undefined && existingResumeSessionId === undefined
              ? { droppedResumeReason: "missing-transcript" }
              : {}),
            ...(typeof settings.fastMode === "boolean" ? { fastMode: settings.fastMode } : {}),
          },
        },
        providerRefs: {},
      });

      const readyStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent(context, {
        type: "session.state.changed",
        eventId: readyStamp.eventId,
        provider: PROVIDER,
        createdAt: readyStamp.createdAt,
        threadId,
        payload: {
          state: "ready",
        },
        providerRefs: {},
      });

      // Capture before starting the stream: a buffered pre-init push may be
      // consumed synchronously as the stream fiber starts.
      const initialCommandCatalogRevision = context.commandCatalogPushRevision;
      let streamFiber: Fiber.Fiber<void, never>;
      streamFiber = runFork(
        Effect.exit(runSdkStream(context)).pipe(
          Effect.flatMap((exit) => {
            if (context.stopped) {
              return Effect.void;
            }
            if (context.streamFiber === streamFiber) {
              context.streamFiber = undefined;
            }
            return handleStreamExit(context, exit);
          }),
        ),
      );
      context.streamFiber = streamFiber;
      if (queryRuntime.supportedCommands) {
        // supportedCommands waits for the query's cached initialize response;
        // it does not send a user prompt or reinitialize the CLI. Initialization
        // is deliberately independent of turn startup and cannot block it.
        runFork(
          Effect.gen(function* () {
            const commands = yield* Effect.tryPromise(() => queryRuntime.supportedCommands!()).pipe(
              Effect.timeout(8_000),
              Effect.catchCause(() => Effect.succeed(undefined)),
            );
            if (context.commandCatalogPushRevision !== initialCommandCatalogRevision) return;
            setCommandCatalog(context, publicClaudeCommands(commands));
          }),
        );
      }
      streamFiber.addObserver(() => {
        if (context.streamFiber === streamFiber) {
          context.streamFiber = undefined;
        }
      });

      sessionTransferred = true;
      return {
        ...session,
      };
    }).pipe(
      Effect.onExit(() => {
        if (sessionTransferred) return Effect.void;
        // Unlike the ACP adapters, Claude's query is not owned by a child
        // Effect scope. Cover both synchronous SDK launch failures and
        // cancellation during publication before ownership is transferred.
        return Effect.gen(function* () {
          yield* Effect.promise(() => schedulingBinding?.dispose() ?? Promise.resolve()).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Claude scheduling cleanup remains pending."),
            ),
          );
          if (startedContext) {
            yield* stopSessionInternal(startedContext, { emitExitEvent: false });
          } else if (startedQuery) {
            yield* Effect.try({
              try: () => startedQuery?.close(),
              catch: () => new Error("Claude startup cleanup failed."),
            }).pipe(Effect.ignore);
          }
        });
      }),
    );
  });

  const forkProviderSession: NonNullable<ClaudeAdapterShape["forkSession"]> = Effect.fn(
    "forkSession",
  )(function* (input) {
    const source = yield* requireSession(input.sourceThreadId);
    if (
      source.turnState !== undefined ||
      source.session.status === "connecting" ||
      source.session.status === "running" ||
      source.session.activeTurnId !== undefined
    ) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "forkSession",
        issue: "Claude source session must be idle before it can be forked.",
      });
    }
    if (!source.resumeCursorDurable || !source.resumeSessionId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "forkSession",
        issue: "Claude has not persisted a resumable transcript for this thread yet.",
      });
    }
    const cwd = source.session.cwd;
    if (!cwd) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "forkSession",
        issue: "Claude source session has no workspace directory.",
      });
    }

    const cutoff = input.messageCutoff;
    const sessionId = source.resumeSessionId;
    const refusal = () =>
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "forkSession",
        issue:
          "The selected Claude message has no safe current native boundary. Resume an idle source chat and select an available message; no source history or files were changed.",
      });
    const native = cutoff ? source.forkMessageIds[cutoff.sourceMessageId] : undefined;
    const revision = source.sdkMessageRevision;
    const turnCount = source.resumeBaseTurnCount + source.turns.length;
    if (
      !isUuid(sessionId) ||
      !isClaudeTreeIdle(source) ||
      (cutoff &&
        (!native ||
          native.turnId !== cutoff.turnId ||
          native.turnCount !== cutoff.retainedTurnCount ||
          !input.sourceMessageIds ||
          input.sourceMessageIds.length > 2000 ||
          !input.sourceMessageIds.includes(cutoff.sourceMessageId) ||
          new Set(input.sourceMessageIds).size !== input.sourceMessageIds.length ||
          input.sourceMessageIds.some((id) => !source.forkMessageIds[id]) ||
          cutoff.retainedTurnCount > turnCount))
    )
      return yield* refusal();
    const projectKey = claudeSessionStoreProjectKey(path, cwd);
    if (
      source.environment.CLAUDE_CODE_PROJECT_DIR_NAME?.trim() &&
      source.environment.CLAUDE_CODE_PROJECT_DIR_NAME.trim() !== projectKey
    )
      return yield* refusal();
    const configDirectory = resolveClaudeConfigDirectory(path, source.environment);
    const projectsDirectory = path.join(configDirectory, "projects");
    const projectDirectory = path.join(projectsDirectory, projectKey);
    const snapshotInput = {
      filePath: path.join(projectDirectory, `${sessionId}.jsonl`),
      directories: [configDirectory, projectsDirectory, projectDirectory],
    };
    const snapshot = yield* Effect.tryPromise({
      try: () => readClaudeRewindSnapshot(snapshotInput),
      catch: refusal,
    });
    const assertUnchanged = async () => {
      if (
        sessions.get(input.sourceThreadId) !== source ||
        source.resumeSessionId !== sessionId ||
        source.sdkMessageRevision !== revision ||
        !isClaudeTreeIdle(source)
      )
        throw refusal();
      const current = await readClaudeRewindSnapshot(snapshotInput);
      if (
        current.commitment !== snapshot.commitment ||
        source.sdkMessageRevision !== revision ||
        !isClaudeTreeIdle(source)
      )
        throw refusal();
    };
    const matching = native
      ? snapshot.entries.filter((entry) => entry.uuid === native.nativeId)
      : [];
    const entry = matching[0];
    if (
      cutoff &&
      (matching.length !== 1 ||
        !entry ||
        entry.sessionId !== sessionId ||
        entry.isSidechain === true ||
        entry.isMeta === true ||
        (entry.type !== "user" && entry.type !== "assistant"))
    )
      return yield* refusal();
    const frozenStore: SessionStore = {
      load: async (key) => {
        if (
          key.projectKey !== projectKey ||
          key.sessionId !== sessionId ||
          key.subpath !== undefined
        )
          throw refusal();
        return structuredClone(snapshot.entries);
      },
      append: async () => {
        throw refusal();
      },
    };
    if (native && entry) {
      const messages = yield* Effect.tryPromise({
        try: () => getSessionMessages(sessionId, { dir: cwd, sessionStore: frozenStore }),
        catch: refusal,
      });
      if (
        !messages.some((message) => message.uuid === native.nativeId && message.type === entry.type)
      )
        return yield* refusal();
    }
    let publishedId: string | undefined;
    let publishedEntries: SessionStoreEntry[] | undefined;
    const publicationStore: SessionStore = {
      ...frozenStore,
      append: async (key, entries) => {
        if (
          publishedId !== undefined ||
          key.projectKey !== projectKey ||
          key.subpath !== undefined ||
          !isUuid(key.sessionId) ||
          key.sessionId === sessionId
        )
          throw refusal();
        // SDK 0.3.288 consumes this immutable in-memory source and slices the
        // exact wrapper UUID inclusively. It cannot reread a moving native
        // transcript. Whole-tree/ingress checks bracket its bounded snapshot;
        // fork never closes, interrupts or resumes the source query.
        await assertUnchanged();
        publishedId = key.sessionId;
        publishedEntries = structuredClone(entries);
        await publishClaudeRewindCandidate({
          filePath: path.join(projectDirectory, `${key.sessionId}.jsonl`),
          snapshot,
          entries,
        });
      },
    };
    const forked = yield* Effect.tryPromise({
      try: () =>
        forkNativeSession(sessionId, {
          dir: cwd,
          title: input.title,
          ...(native ? { upToMessageId: native.nativeId } : {}),
          sessionStore: publicationStore,
        }),
      catch: refusal,
    });
    if (!publishedEntries || publishedId !== forked.sessionId) return yield* refusal();
    const forkMessageIds = yield* Effect.try({
      try: () =>
        Object.keys(source.forkMessageIds).length === 0
          ? (Object.create(null) as ClaudeForkMessageIds)
          : remapClaudeForkMessageIds({
              ids: source.forkMessageIds,
              entries: publishedEntries!,
              sourceSessionId: sessionId,
              targetSessionId: forked.sessionId,
              targetThreadId: input.targetThreadId,
            }),
      catch: refusal,
    });
    if (cutoff && !forkMessageIds[`copy:${input.targetThreadId}:${cutoff.sourceMessageId}`])
      return yield* refusal();
    // The SDK's retained lineage decides membership. Cafe receive times can
    // tie and random item IDs are not native ordering authority; filtering
    // the source projection by these IDs cannot copy a later native block.
    const retainedMessageIds = cutoff
      ? input.sourceMessageIds!.filter(
          (id) => forkMessageIds[`copy:${input.targetThreadId}:${id}`] !== undefined,
        )
      : undefined;
    let forkPublicationCommitment: string | undefined;
    yield* Effect.tryPromise({
      try: async () => {
        await assertUnchanged();
        const candidate = await readClaudeRewindSnapshot({
          ...snapshotInput,
          filePath: path.join(projectDirectory, `${forked.sessionId}.jsonl`),
        });
        if (JSON.stringify(candidate.entries) !== JSON.stringify(publishedEntries)) throw refusal();
        if (source.sdkMessageRevision !== revision || !isClaudeTreeIdle(source)) throw refusal();
        forkPublicationCommitment = candidate.commitment;
      },
      catch: refusal,
    });
    // Any uncertain publication preserves its private candidate for recovery;
    // it never grants authority to delete or retry against the source.
    return {
      operationId: input.operationId,
      sourceThreadId: input.sourceThreadId,
      targetThreadId: input.targetThreadId,
      ...(cutoff ? { messageCutoff: cutoff, retainedMessageIds } : {}),
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      runtimeMode: source.session.runtimeMode,
      maxConcurrentSubagents: source.session.maxConcurrentSubagents ?? null,
      ...(source.session.interactionMode !== undefined
        ? { interactionMode: source.session.interactionMode }
        : {}),
      cwd,
      ...(source.session.additionalDirectories !== undefined
        ? { additionalDirectories: source.session.additionalDirectories }
        : {}),
      ...(source.session.model !== undefined ? { model: source.session.model } : {}),
      ...(source.session.modelSelection !== undefined
        ? { modelSelection: source.session.modelSelection }
        : {}),
      resumeCursor: {
        threadId: input.targetThreadId,
        resume: forked.sessionId,
        forkPublication: {
          configurationDirectory: configDirectory,
          commitment: forkPublicationCommitment,
        },
        turnCount: cutoff?.retainedTurnCount ?? turnCount,
        ...(Object.keys(forkMessageIds).length > 0 ? { forkMessageIds } : {}),
      },
    } satisfies ProviderSessionForkResult;
  });

  const discardProviderSessionFork: NonNullable<ClaudeAdapterShape["discardSessionFork"]> =
    Effect.fn("discardSessionFork")(function* (fork) {
      const resumeState = readClaudeResumeState(fork.resumeCursor);
      const publication =
        typeof fork.resumeCursor === "object" && fork.resumeCursor !== null
          ? (Reflect.get(fork.resumeCursor, "forkPublication") as unknown)
          : undefined;
      const publicationDirectory =
        typeof publication === "object" && publication !== null
          ? (Reflect.get(publication, "configurationDirectory") as unknown)
          : undefined;
      const publicationCommitment =
        typeof publication === "object" && publication !== null
          ? (Reflect.get(publication, "commitment") as unknown)
          : undefined;
      const cleanupCwd = fork.cwd;
      if (
        !resumeState?.resume ||
        !isUuid(resumeState.resume) ||
        !cleanupCwd ||
        typeof publicationDirectory !== "string" ||
        typeof publicationCommitment !== "string" ||
        !/^[a-f0-9]{64}$/.test(publicationCommitment) ||
        sessions.has(fork.targetThreadId)
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "discardSessionFork",
          issue: "Claude fork resume state is invalid.",
        });
      }
      const cleanupSessionId = resumeState.resume;
      const sessionStore = yield* Effect.try({
        try: () =>
          makeClaudeForkSessionStore({
            path,
            env: claudeEnvironment,
            cwd: cleanupCwd,
            sessionId: cleanupSessionId,
            publication: {
              configurationDirectory: publicationDirectory,
              commitment: publicationCommitment,
            },
          }),
        catch: () =>
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "discardSessionFork",
            issue: "Claude fork cleanup authority changed; recovery evidence was preserved.",
          }),
      });
      yield* Effect.tryPromise({
        try: () =>
          deleteNativeSession(cleanupSessionId, {
            ...(fork.cwd !== undefined ? { dir: fork.cwd } : {}),
            sessionStore,
          }),
        catch: () =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/fork/delete",
            detail:
              "Claude could not verify and discard the uncommitted fork; recovery evidence was preserved.",
          }),
      });
    });

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (
      input.deliveryPriority !== undefined &&
      (input.inputOrigin === "scheduled" || !supportsClaudeTaskControls(context.taskControlVersion))
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail:
          "Explicit message priority requires a qualified Claude runtime and a human message.",
      });
    }
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;

    if (context.turnState) {
      if (context.turnState.origin === "synthetic") {
        // Auto-close provider-initiated background output before beginning the
        // user's next explicit turn. A real user turn is never eligible for
        // this path because closing it would drop or split a queued follow-up.
        yield* completeTurn(context, "completed");
      } else {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Claude turn '${context.turnState.turnId}' is already active; route additional input through turn/steer so Claude can queue it without interruption.`,
        });
      }
    }

    if (modelSelection?.model) {
      const apiModelId = resolveClaudeApiModelId(modelSelection);
      const selectedContextWindowTokens = resolveClaudeSelectedContextWindowTokens(modelSelection);
      if (context.currentApiModelId !== apiModelId) {
        yield* Effect.tryPromise({
          try: () => context.query.setModel(apiModelId),
          catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
        });
        context.currentApiModelId = apiModelId;
      }
      context.selectedContextWindowTokens = selectedContextWindowTokens;
      if (selectedContextWindowTokens !== undefined) {
        context.lastKnownContextWindow = selectedContextWindowTokens;
      }
      context.session = {
        ...context.session,
        model: modelSelection.model,
      };
    }

    // Apply only real permission-mode transitions here. The session's initial
    // permission mode is already bound into query() options at startSession
    // time; issuing a redundant setPermissionMode() before Claude Code has
    // attached the first streamed user message can fail with "No message
    // found" / "No conversation found" on current Claude Agent SDK releases.
    const desiredPermissionMode =
      input.interactionMode === undefined
        ? undefined
        : (resolveClaudePermissionMode({
            interactionMode: input.interactionMode,
            basePermissionMode: context.basePermissionMode,
          }) ?? "default");
    if (
      desiredPermissionMode !== undefined &&
      desiredPermissionMode !== context.currentPermissionMode
    ) {
      if (!context.hasSubmittedUserPrompt) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/setPermissionMode",
          detail:
            "Claude permission mode cannot be changed before the first streamed user prompt. Start the Claude session with the first turn's interaction mode instead.",
        });
      }
      yield* Effect.tryPromise({
        try: () => context.query.setPermissionMode(desiredPermissionMode),
        catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
      });
      context.currentPermissionMode = desiredPermissionMode;
    }

    const turnId = TurnId.make(yield* Random.nextUUIDv4);
    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      boundInstanceId,
      method: "turn/start",
      messageUuid: turnId,
    });

    const turnState = makeClaudeTurnState({
      turnId,
      startedAt: yield* nowIso,
      origin: "user",
    });
    turnState.promptTextBytes = Buffer.byteLength(buildPromptText(input, boundInstanceId), "utf8");
    turnState.promptAttachmentCount = input.attachments?.length ?? 0;

    const updatedAt = yield* nowIso;
    context.turnState = turnState;
    context.session = {
      ...context.session,
      status: "running",
      activeTurnId: turnId,
      updatedAt,
    };

    const turnStartedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent(context, {
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: modelSelection?.model ? { model: modelSelection.model } : {},
      providerRefs: {},
    });

    context.promptLifecycleByUuid.set(turnId, "submitted");
    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(
      Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)),
      Effect.tapError(() =>
        Effect.sync(() => {
          context.promptLifecycleByUuid.delete(turnId);
        }),
      ),
      Effect.tapError((error) =>
        completeTurn(context, "failed", toMessage(error, "Failed to queue Claude turn.")),
      ),
    );
    context.hasSubmittedUserPrompt = true;
    rememberClaudeForkMessage({
      ids: context.forkMessageIds,
      messageId: input.messageId,
      nativeId: turnId,
      turnId,
      turnCount: context.resumeBaseTurnCount + context.turns.length + 1,
    });
    turnState.promptQueuedAt = yield* nowIso;
    scheduleClaudeTurnStartWatchdog(context, turnState);

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: ClaudeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* requireSession(threadId);
      const receipt = yield* Effect.tryPromise({
        try: () => context.query.interrupt(),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });

      // Claude Code 2.1.205+ returns UUIDs for queued inputs that survive an
      // interrupt. Cancel only UUIDs Cafe submitted: the receipt can include
      // internal cron/auto-resume commands, and upstream explicitly requires
      // clients to ignore unknown identifiers. Include locally submitted or
      // lifecycle-confirmed queued messages in case the SDK input writer has
      // not yet made them visible to the worker's receipt snapshot.
      const cancellationCandidates = new Set<string>();
      for (const [messageUuid, state] of context.promptLifecycleByUuid) {
        if (state === "submitted" || state === "queued") {
          cancellationCandidates.add(messageUuid);
        }
      }
      for (const messageUuid of receipt?.still_queued ?? []) {
        if (context.promptLifecycleByUuid.has(messageUuid)) {
          cancellationCandidates.add(messageUuid);
        }
      }

      if (cancellationCandidates.size === 0) {
        return;
      }

      let confirmedCancellationCount = 0;
      let unconfirmedCancellationCount = 0;
      const cancelAsyncMessage = context.query.cancelAsyncMessage;
      if (cancelAsyncMessage) {
        for (const messageUuid of cancellationCandidates) {
          const cancellation = yield* Effect.tryPromise({
            try: () => cancelAsyncMessage.call(context.query, messageUuid),
            catch: (cause) => toRequestError(threadId, "turn/cancelAsyncMessage", cause),
          }).pipe(Effect.exit);
          if (Exit.isSuccess(cancellation) && cancellation.value === true) {
            confirmedCancellationCount += 1;
            context.promptLifecycleByUuid.delete(messageUuid);
          } else {
            unconfirmedCancellationCount += 1;
          }
        }
      } else {
        unconfirmedCancellationCount = cancellationCandidates.size;
      }

      if (unconfirmedCancellationCount === 0) {
        yield* Effect.logInfo("claude.turnInterrupt.queuedInputsCancelled", {
          threadId,
          providerInstanceId: boundInstanceId,
          confirmedCancellationCount,
          receiptCount: receipt?.still_queued.length ?? 0,
        });
        return;
      }

      // A false cancel result is ambiguous once Claude has dequeued a coalesced
      // batch. Retire the process instead of allowing an unconfirmed duplicate
      // to run after Cafe replays durable input through a fresh session.
      yield* emitRuntimeWarning(
        context,
        "Claude could not confirm cancellation of every queued input after interrupt; Cafe retired the provider session before accepting more input.",
        {
          candidateCount: cancellationCandidates.size,
          confirmedCancellationCount,
          unconfirmedCancellationCount,
          receiptCount: receipt?.still_queued.length ?? 0,
          interruptReceiptAdvertised: context.capabilities.has("interrupt_receipt_v1"),
          messageLifecycleAdvertised: context.capabilities.has("msg_lifecycle_v1"),
        },
      );
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  const readSubagentDetail: NonNullable<ClaudeAdapterShape["readSubagentDetail"]> = (
    threadId,
    subagentId,
    readContext,
  ) =>
    Effect.gen(function* () {
      // The caller already authorizes this Cafe task identity against durable
      // activity, but the adapter still rejects normalization ambiguities and
      // control characters before using it as an in-memory lookup key.
      if (exactClaudeProviderIdentity(subagentId) !== subagentId) {
        return yield* makeProviderSubagentDetailReadError("invalid-request");
      }
      const authorizedHistoryId = exactClaudeProviderIdentity(readContext?.historyId, {
        pathSegment: true,
      });
      // Opaque authorization keys are exact, not user-facing names. Trimming
      // a supplied key could read a canonical sibling the caller never named.
      if (readContext?.historyId !== undefined && authorizedHistoryId !== readContext.historyId) {
        return yield* makeProviderSubagentDetailReadError("invalid-request");
      }

      const currentLiveSession = sessions.get(threadId);
      const persistedResumeSessionId = readClaudeResumeState(readContext?.resumeCursor)?.resume;
      const hasPersistedRootConstraint = readContext !== undefined && "resumeCursor" in readContext;
      const persistedCwd =
        typeof readContext?.cwd === "string" && readContext.cwd.length > 0
          ? readContext.cwd
          : undefined;
      // A Cafe thread can later return to this same Claude instance while a
      // different native session owns the live slot. Reusing that slot for an
      // ended child would silently discard the immutable history provenance and
      // could expose a colliding agent id from the new root. Only retain the live
      // optimization when every persisted root discriminator we have still
      // matches; otherwise the official history APIs read the old root directly.
      const liveSession =
        currentLiveSession !== undefined &&
        (!hasPersistedRootConstraint ||
          (persistedResumeSessionId !== undefined &&
            currentLiveSession.resumeSessionId === persistedResumeSessionId &&
            (persistedCwd === undefined || currentLiveSession.session.cwd === persistedCwd)))
          ? currentLiveSession
          : undefined;
      const liveBinding = liveSession?.taskBindingsByTaskId.get(subagentId);
      const resumeSessionId = liveSession?.resumeSessionId ?? persistedResumeSessionId;
      const cwd = liveSession?.session.cwd ?? persistedCwd;
      if (!resumeSessionId || !isUuid(resumeSessionId) || !cwd || cwd.trim().length === 0) {
        return yield* makeProviderSubagentDetailReadError("session-unavailable");
      }
      const historySessionStore = makeClaudeSubagentHistorySessionStore({
        path,
        env: claudeEnvironment,
        cwd,
        sessionId: resumeSessionId,
      });

      if (
        liveBinding?.historyId !== undefined &&
        authorizedHistoryId !== undefined &&
        liveBinding.historyId !== authorizedHistoryId
      ) {
        return yield* makeProviderSubagentDetailReadError("child-identity-mismatch");
      }

      const runHistoryRequest = <A>(request: () => Promise<A>) =>
        Effect.tryPromise({
          try: request,
          catch: () => makeProviderSubagentDetailReadError("provider-request-failed"),
        }).pipe(
          Effect.timeout(CLAUDE_SUBAGENT_HISTORY_READ_TIMEOUT_MS),
          Effect.mapError(() => makeProviderSubagentDetailReadError("provider-request-failed")),
          // Keep the complete provider exception/stack out of defects as well
          // as the typed error channel. Transcript APIs can mention local paths.
          Effect.catchDefect(() =>
            Effect.fail(makeProviderSubagentDetailReadError("provider-request-failed")),
          ),
        );

      const listedHistoryIds = yield* runHistoryRequest(() =>
        listNativeSubagents(resumeSessionId, {
          dir: cwd,
          sessionStore: historySessionStore,
        }),
      );
      if (listedHistoryIds.length > CLAUDE_SUBAGENT_DISCOVERY_MAX_AGENTS) {
        return yield* makeProviderSubagentDetailReadError("provider-response-invalid");
      }
      const historyIds: string[] = [];
      for (const value of listedHistoryIds) {
        const historyId = exactClaudeProviderIdentity(value, { pathSegment: true });
        if (historyId === undefined) {
          return yield* makeProviderSubagentDetailReadError("provider-response-invalid");
        }
        if (!historyIds.includes(historyId)) {
          historyIds.push(historyId);
        }
      }

      let historyId = authorizedHistoryId ?? liveBinding?.historyId;
      if (historyId !== undefined && !historyIds.includes(historyId)) {
        return yield* makeProviderSubagentDetailReadError("child-identity-mismatch");
      }

      if (historyId === undefined) {
        // A live pre-result task may not have exposed AgentOutput.agentId yet.
        // Resolve it only through the SDK's transcript metadata: the first
        // message carries the exact spawning parent_tool_use_id. This is a
        // bounded compatibility path, never a taskId===agentId guess.
        if (liveBinding?.toolUseId === undefined) {
          return yield* makeProviderSubagentDetailReadError("missing-subagent-metadata");
        }
        const matches = yield* Effect.forEach(
          historyIds,
          (candidate) =>
            runHistoryRequest(() =>
              getNativeSubagentMessages(resumeSessionId, candidate, {
                dir: cwd,
                limit: 1,
                sessionStore: historySessionStore,
              }),
            ).pipe(
              Effect.map((messages) =>
                messages.some((message) => message.parent_tool_use_id === liveBinding.toolUseId)
                  ? candidate
                  : undefined,
              ),
            ),
          { concurrency: 4 },
        ).pipe(
          Effect.map((values) => values.filter((value): value is string => value !== undefined)),
        );
        if (matches.length !== 1) {
          return yield* makeProviderSubagentDetailReadError(
            matches.length === 0 ? "missing-subagent-metadata" : "parent-metadata-mismatch",
          );
        }
        historyId = matches[0];
        if (liveSession !== undefined && liveBinding !== undefined && historyId !== undefined) {
          const toolUseKey = canonicalClaudeToolUseBindingKey(liveBinding.toolUseId);
          const resolvedBinding = upsertClaudeTaskBinding(liveSession, {
            taskId: liveBinding.taskId,
            ...(toolUseKey ? { toolUseKey } : {}),
            ...(liveBinding.toolUseId ? { toolUseId: liveBinding.toolUseId } : {}),
            historyId,
            taskType: "agent",
          });
          // Persist the just-verified relationship immediately rather than
          // waiting for the Agent tool's terminal result. This also gives an
          // already-open detail view a canonical task-progress invalidation;
          // subsequent nested assistant snapshots repeat the same historyId.
          const historyStamp = yield* makeEventStamp();
          const subagent = claudeSubagentPresentation(resolvedBinding, "active");
          const visibility = claudeTaskVisibilityForBinding(liveSession, resolvedBinding);
          yield* offerRuntimeEvent(liveSession, {
            type: "task.progress",
            eventId: historyStamp.eventId,
            provider: PROVIDER,
            createdAt: historyStamp.createdAt,
            threadId: liveSession.session.threadId,
            ...(resolvedBinding.turnId ? { turnId: resolvedBinding.turnId } : {}),
            payload: {
              taskId: resolvedBinding.taskId,
              description:
                resolvedBinding.description ?? "Claude subagent is working in the background.",
              summary: "Claude subagent history is available.",
              visibility,
              ...(subagent ? { subagent } : {}),
            },
            providerRefs: nativeProviderRefs(
              liveSession,
              liveBinding.toolUseId ? { providerItemId: liveBinding.toolUseId } : undefined,
            ),
          });
        }
      }

      if (historyId === undefined) {
        return yield* makeProviderSubagentDetailReadError("missing-subagent-metadata");
      }
      const messages = yield* runHistoryRequest(() =>
        getNativeSubagentMessages(resumeSessionId, historyId, {
          dir: cwd,
          sessionStore: historySessionStore,
        }),
      );
      const publicMessages = messages.flatMap((message) => {
        const text = extractClaudeSubagentSessionMessageText(message);
        return text === undefined || (message.type !== "user" && message.type !== "assistant")
          ? []
          : [{ role: message.type, text } as const];
      });
      return {
        ...canonicalizeProviderSubagentDetail(publicMessages),
        ...canonicalizeProviderSubagentActivities(claudeSubagentActivities(messages)),
      } satisfies ProviderSubagentDetail;
    }).pipe(
      // One authenticated UI read has one wall-clock budget. Per-request
      // timeouts redact individual SDK failures, but without this outer cap a
      // hostile 256-agent listing could consume the per-call budget in waves.
      Effect.timeoutOrElse({
        duration: CLAUDE_SUBAGENT_HISTORY_READ_TIMEOUT_MS,
        orElse: () => Effect.fail(makeProviderSubagentDetailReadError("provider-request-failed")),
      }),
      Effect.catchDefect(() =>
        Effect.fail(makeProviderSubagentDetailReadError("provider-request-failed")),
      ),
    );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = () =>
    Effect.fail(
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "rollbackThread",
        issue: "Claude conversation rewind requires an exact prepared checkpoint transaction.",
      }),
    );

  const prepareRollbackThread: NonNullable<ClaudeAdapterShape["prepareRollbackThread"]> = Effect.fn(
    "prepareRollbackThread",
  )(function* (threadId, numTurns, boundary) {
    const context = yield* requireSession(threadId);
    const refused = makeClaudeRewindRefusal;
    // Live SDK messages can replace this identity after persisted-cursor
    // validation. Admit it again before it becomes a native transcript path,
    // including baseline rewinds that have no retained-message cutoff check.
    const sessionId = context.resumeSessionId;
    const cwd = context.session.cwd;
    const waitForExit = context.query.waitForExit;
    if (
      !Number.isSafeInteger(numTurns) ||
      numTurns < 1 ||
      !Number.isSafeInteger(boundary.retainedTurnCount) ||
      boundary.retainedTurnCount < 0 ||
      boundary.retainedTurnCount + numTurns !==
        context.resumeBaseTurnCount + context.turns.length ||
      !sessionId ||
      !isUuid(sessionId) ||
      !context.resumeCursorDurable ||
      !cwd ||
      !waitForExit
    )
      return yield* refused();

    const projectKey = claudeSessionStoreProjectKey(path, cwd);
    // The SDK disk-fork API derives its key from cwd. A separately configured
    // key has no public per-call override here; never read a different home
    // or silently fork the similarly named default transcript.
    if (
      context.environment.CLAUDE_CODE_PROJECT_DIR_NAME?.trim() &&
      context.environment.CLAUDE_CODE_PROJECT_DIR_NAME.trim() !== projectKey
    ) {
      return yield* refused();
    }
    const configDirectory = resolveClaudeConfigDirectory(path, context.environment);
    const projectsDirectory = path.join(configDirectory, "projects");
    const projectDirectory = path.join(projectsDirectory, projectKey);
    const snapshotInput = {
      filePath: path.join(projectDirectory, `${sessionId}.jsonl`),
      directories: [configDirectory, projectsDirectory, projectDirectory],
    };
    const snapshot = yield* Effect.tryPromise({
      try: () => readClaudeRewindSnapshot(snapshotInput),
      catch: refused,
    });
    const frozenStore: SessionStore = {
      load: async (key) => {
        if (
          key.projectKey !== projectKey ||
          key.sessionId !== sessionId ||
          key.subpath !== undefined
        ) {
          throw new Error("Claude rewind requested an unrelated transcript.");
        }
        return structuredClone(snapshot.entries);
      },
      append: async () => {
        throw new Error("Claude rewind inspection is read-only.");
      },
    };
    let cutoff: string | null = null;
    // Discarding the complete conversation has no retained native boundary.
    // It is still safe after compaction removed its oldest prompt; partial
    // history rewinds must prove the exact current-chain prompt below.
    if (boundary.retainedTurnCount > 0) {
      cutoff = yield* Effect.try({
        try: () =>
          selectClaudeRewindCutoff({
            entries: snapshot.entries,
            sessionId,
            firstRemovedTurnId: boundary.firstRemovedTurnId,
            ...(context.rewindMessageIds ? { messageIds: context.rewindMessageIds } : {}),
          }),
        catch: refused,
      });
      const selectedPrompt =
        context.rewindMessageIds?.[boundary.firstRemovedTurnId] ?? boundary.firstRemovedTurnId;
      const nativeMessages = yield* Effect.tryPromise({
        try: () => getSessionMessages(sessionId, { dir: cwd, sessionStore: frozenStore }),
        catch: refused,
      });
      if (
        !nativeMessages.some(
          (message) => message.type === "user" && message.uuid === selectedPrompt,
        ) ||
        cutoff === null
      )
        return yield* refused();
    }

    // No await may separate the liveness check from reservation. Once this
    // succeeds, every send/callback sees stopped=true. Keep that fence on any
    // inconclusive exit rather than allowing a competing native writer.
    if (sessions.get(threadId) !== context || !reserveClaudeIdleRetirement(context))
      return yield* refused();
    context.queryClosureUncertain = true;
    context.rewindRetirementUncertain = true;
    context.session = { ...context.session, status: "error" };
    const retire = Effect.tryPromise({
      try: async () => {
        context.query.close();
        await waitForExit();
      },
      catch: () => new ProviderAdapterRewindOutcomeUnknownError(),
    }).pipe(
      Effect.timeoutOrElse({
        duration: 10_000,
        orElse: () => Effect.fail(new ProviderAdapterRewindOutcomeUnknownError()),
      }),
    );
    yield* retire;
    // An event already consumed during shutdown is not projected after the
    // reservation, but it is evidence that the supposedly idle tree moved.
    const settledSnapshot = yield* Effect.tryPromise({
      try: () => readClaudeRewindSnapshot(snapshotInput),
      catch: () => new ProviderAdapterRewindOutcomeUnknownError(),
    });
    if (settledSnapshot.commitment !== snapshot.commitment || context.inFlightSdkMessageCount > 0) {
      return yield* new ProviderAdapterRewindOutcomeUnknownError();
    }
    context.queryClosureUncertain = false;
    yield* stopSessionInternal(context, {
      retirementReserved: true,
      queryAlreadyClosed: true,
      emitExitEvent: false,
    });
    const {
      subagentRuntimeId: _retiredRuntimeId,
      activeTurnId: _retiredTurnId,
      ...closedSession
    } = context.session;
    // A baseline rewind intentionally has no native transcript to resume.
    // Do not manufacture an empty native session id or start paid inference.
    if (boundary.retainedTurnCount === 0) {
      return { ...closedSession, status: "closed" as const, resumeCursor: undefined };
    }

    let publishedSessionId: string | undefined;
    let publishedEntries: SessionStoreEntry[] | undefined;
    const publicationStore: SessionStore = {
      ...frozenStore,
      append: async (key, entries) => {
        if (
          publishedSessionId !== undefined ||
          key.subpath !== undefined ||
          key.projectKey !== projectKey ||
          !isUuid(key.sessionId) ||
          key.sessionId === sessionId
        ) {
          throw new Error("Claude rewind produced an invalid publication target.");
        }
        // Record before I/O. A thrown fsync/close is ambiguous and must never
        // authorize blind replay or deletion of a possibly durable candidate.
        publishedSessionId = key.sessionId;
        publishedEntries = entries;
        await publishClaudeRewindCandidate({
          filePath: path.join(projectDirectory, `${key.sessionId}.jsonl`),
          snapshot,
          entries,
        });
      },
    };
    const forked = yield* Effect.tryPromise({
      try: () =>
        forkNativeSession(sessionId, {
          dir: cwd,
          upToMessageId: cutoff!,
          sessionStore: publicationStore,
        }),
      // Retirement itself changes event authority. Even a disk-fork refusal
      // before publication must retain the durable fence for this generation.
      catch: () => new ProviderAdapterRewindOutcomeUnknownError(),
    });
    if (forked.sessionId !== publishedSessionId || !publishedEntries) {
      return yield* new ProviderAdapterRewindOutcomeUnknownError();
    }
    const rewindMessageIds = yield* Effect.try({
      try: () =>
        remapClaudeRewindMessageIds({
          sourceSessionId: sessionId,
          targetSessionId: forked.sessionId,
          entries: publishedEntries!,
          ...(context.rewindMessageIds ? { previous: context.rewindMessageIds } : {}),
        }),
      catch: () => new ProviderAdapterRewindOutcomeUnknownError(),
    });
    const retainedForkMessageIds = yield* Effect.try({
      try: () =>
        Object.keys(context.forkMessageIds).length > 0
          ? remapClaudeForkMessageIds({
              ids: context.forkMessageIds,
              entries: publishedEntries!,
              sourceSessionId: sessionId,
              targetSessionId: forked.sessionId,
            })
          : undefined,
      catch: () => new ProviderAdapterRewindOutcomeUnknownError(),
    });
    // Validate the exact durable candidate and recheck the original after
    // SDK work. A concurrent external writer cannot be hidden by a successful
    // fork acknowledgement. Both files remain available on ambiguous error.
    yield* Effect.tryPromise({
      try: async () => {
        const candidate = await readClaudeRewindSnapshot({
          ...snapshotInput,
          filePath: path.join(projectDirectory, `${forked.sessionId}.jsonl`),
        });
        if (JSON.stringify(candidate.entries) !== JSON.stringify(publishedEntries))
          throw new Error("Claude rewind candidate changed.");
        const original = await readClaudeRewindSnapshot(snapshotInput);
        if (original.commitment !== snapshot.commitment)
          throw new Error("Claude rewind source changed.");
      },
      catch: () => new ProviderAdapterRewindOutcomeUnknownError(),
    });
    return {
      ...closedSession,
      status: "closed" as const,
      resumeCursor: {
        threadId,
        resume: forked.sessionId,
        turnCount: boundary.retainedTurnCount,
        rewindMessageIds,
        ...(retainedForkMessageIds ? { forkMessageIds: retainedForkMessageIds } : {}),
      },
    };
  });

  const respondToRequest: ClaudeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }

      // SDK 0.3.274 exposes asks whose reusable rule would grant more than
      // the action being reviewed. Enforce that restriction here as well as
      // in the UI: an older/reconnected client must not broaden permission.
      // Keep the request open so the user can still explicitly approve once.
      if (decision === "acceptForSession" && pending.suppressAlwaysAllowRule) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "item/requestApproval/decision",
          detail: "This provider approval permits a one-time decision only.",
        });
      }
      context.pendingApprovals.delete(requestId);
      yield* Deferred.succeed(pending.decision, decision);
    },
  );

  const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = Effect.fn(
    "respondToUserInput",
  )(function* (threadId, requestId, answers) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (!pending) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }

    if (pending.interaction && !validateInteractionResponse(pending.interaction, answers)) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: "The response does not match the pending provider interaction.",
      });
    }
    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const resolveInteractionUrl = Effect.fn("ClaudeAdapter.resolveInteractionUrl")(function* (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
  ) {
    const context = yield* requireSession(threadId);
    const pending = context.pendingUserInputs.get(requestId);
    if (pending?.interaction?.mode !== "url" || !pending.interactionUrl) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "interaction/resolveUrl",
        detail: "The provider interaction is no longer available.",
      });
    }
    return pending.interactionUrl;
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      // A guarded close failure deliberately retains a stopped ownership
      // context. Explicit stop is allowed to retry that exact native query;
      // other operations still require a live, non-fenced session.
      const retained = sessions.get(threadId);
      const context = retained?.queryClosureUncertain ? retained : yield* requireSession(threadId);
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
      });
    },
  );

  const listSessions: ClaudeAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const steerTurn: ClaudeAdapterShape["steerTurn"] = Effect.fn("steerTurn")(function* (
    input: ProviderSteerTurnInput,
  ) {
    const context = yield* requireSession(input.threadId);
    const activeTurnId = context.session.activeTurnId ?? context.turnState?.turnId;
    if (
      input.deliveryPriority !== undefined &&
      !supportsClaudeTaskControls(context.taskControlVersion)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/steer",
        detail: "Explicit message priority is not supported by this Claude runtime.",
      });
    }

    if (context.session.status !== "running" || !context.turnState || !activeTurnId) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/steer",
        detail: `Claude session '${input.threadId}' has no active turn to steer.`,
      });
    }

    if (activeTurnId !== input.expectedTurnId) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/steer",
        detail: `Claude active turn mismatch: expected '${input.expectedTurnId}' but session is running '${activeTurnId}'.`,
      });
    }

    // Keep the object identity as well as the public turn id. A resumed query
    // can reuse history, but it must never inherit an in-flight priority steer.
    const admittedTurnState = context.turnState;
    const messageUuid = yield* Random.nextUUIDv4;
    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      boundInstanceId,
      method: "turn/steer",
      messageUuid,
    });

    if (input.deliveryPriority !== undefined) {
      return yield* Effect.suspend(() => {
        const expectedSession = input.expectedPrioritySession;
        // Attachment preparation yields. Native result/lifecycle processing is
        // independent of ProviderService's session lock, so the entry checks
        // alone cannot authorize this later queue write. An unprojected terminal
        // frame is inconclusive too: a result can be awaiting its native logger
        // while the old turn still appears running. Ordinary token deltas do
        // not fence delivery. Fail closed without registering a prompt or
        // retrying against a replacement turn/query.
        if (
          sessions.get(input.threadId) !== context ||
          context.stopped ||
          context.queryClosureUncertain ||
          context.inFlightSdkTurnBoundaryCount > 0 ||
          context.sdkStreamEnded ||
          context.session.status !== "running" ||
          context.turnState !== admittedTurnState ||
          context.turnState.turnId !== input.expectedTurnId ||
          context.session.activeTurnId !== input.expectedTurnId ||
          (expectedSession !== undefined &&
            (expectedSession.providerInstanceId !== boundInstanceId ||
              expectedSession.activeTurnId !== input.expectedTurnId ||
              expectedSession.subagentRuntimeId !== context.subagentRuntimeId))
        ) {
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/steer",
              detail: "The observed Claude session changed before priority delivery.",
            }),
          );
        }

        // This queue is unbounded. Its synchronous offer either accepts one
        // message or reports a closed queue; no scheduler boundary may separate
        // the final identity check, lifecycle registration and prompt admission.
        // Keep accounting in the same critical section so completion cannot
        // clear/replace turnState before the accepted prompt is attributed.
        context.promptLifecycleByUuid.set(messageUuid, "submitted");
        if (!Queue.offerUnsafe(context.promptQueue, { type: "message", message })) {
          context.promptLifecycleByUuid.delete(messageUuid);
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/steer",
              detail: "The observed Claude prompt stream closed before priority delivery.",
            }),
          );
        }
        context.hasSubmittedUserPrompt = true;
        rememberClaudeForkMessage({
          ids: context.forkMessageIds,
          messageId: input.messageId,
          nativeId: messageUuid,
          turnId: activeTurnId,
          turnCount: context.resumeBaseTurnCount + context.turns.length + 1,
        });
        admittedTurnState.promptTextBytes =
          (admittedTurnState.promptTextBytes ?? 0) +
          Buffer.byteLength(input.input?.trim() ?? "", "utf8");
        admittedTurnState.promptAttachmentCount =
          (admittedTurnState.promptAttachmentCount ?? 0) + (input.attachments?.length ?? 0);
        return Effect.succeed({
          threadId: context.session.threadId,
          turnId: activeTurnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        });
      });
    }

    // Official Claude Agent SDK streaming input mode is the long-lived,
    // interactive path: `query({ prompt: AsyncIterable<SDKUserMessage> })`
    // supports dynamic message queueing and interruption, and the local
    // package types document `streamInput()` as the multi-turn input pipe.
    // Claude does not expose a Codex-style expected-turn RPC, so Cafe binds the
    // steer to its own active turn id before queueing exactly one SDK user
    // message into the already-running prompt stream.
    context.promptLifecycleByUuid.set(messageUuid, "submitted");
    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(
      Effect.mapError((cause) => toRequestError(input.threadId, "turn/steer", cause)),
      Effect.tapError(() =>
        Effect.sync(() => {
          context.promptLifecycleByUuid.delete(messageUuid);
        }),
      ),
    );

    context.hasSubmittedUserPrompt = true;
    rememberClaudeForkMessage({
      ids: context.forkMessageIds,
      messageId: input.messageId,
      nativeId: messageUuid,
      turnId: activeTurnId,
      turnCount: context.resumeBaseTurnCount + context.turns.length + 1,
    });
    context.turnState.promptTextBytes =
      (context.turnState.promptTextBytes ?? 0) +
      Buffer.byteLength(input.input?.trim() ?? "", "utf8");
    context.turnState.promptAttachmentCount =
      (context.turnState.promptAttachmentCount ?? 0) + (input.attachments?.length ?? 0);

    return {
      threadId: context.session.threadId,
      turnId: activeTurnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const stopAll: ClaudeAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: true,
        }),
      { discard: true },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) =>
        stopSessionInternal(context, {
          emitExitEvent: false,
        }),
      { discard: true },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  const controlTask: NonNullable<ClaudeAdapterShape["controlTask"]> = Effect.fn("controlTask")(
    function* (input: ProviderTaskControlInput) {
      const context = yield* requireSession(input.threadId);
      const foregroundTool = Array.from(context.inFlightTools.values()).find(
        (tool) => tool.controlId === input.taskId,
      );
      if (foregroundTool) {
        if (
          input.providerInstanceId !== boundInstanceId ||
          input.runtimeId !== context.subagentRuntimeId ||
          input.turnId !== foregroundTool.turnId ||
          input.taskGeneration !== foregroundTool.controlGeneration ||
          input.action !== "background" ||
          !supportsClaudeTaskControls(context.taskControlVersion) ||
          !context.query.backgroundTasks ||
          !admittedClaudeControlIdentity(foregroundTool.itemId)
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "task/control",
            detail: "The task control no longer matches this exact live task and account.",
          });
        }
        if (
          foregroundTool.detached ||
          Array.from(context.taskBindingsByTaskId.values()).some(
            (task) => task.nativeTaskId && task.toolUseId === foregroundTool.itemId,
          )
        )
          return { status: "not-foreground" as const };
        const accepted = yield* Effect.tryPromise({
          try: () => context.query.backgroundTasks!(foregroundTool.itemId),
          catch: () =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "task/control",
              detail: "The task control outcome is unknown. Wait for a provider status update.",
            }),
        });
        return { status: accepted ? ("accepted" as const) : ("not-foreground" as const) };
      }
      const binding = context.taskBindingsByTaskId.get(input.taskId);
      if (
        input.providerInstanceId !== boundInstanceId ||
        input.runtimeId !== context.subagentRuntimeId ||
        !binding ||
        binding.turnId !== input.turnId ||
        binding.taskGeneration !== input.taskGeneration ||
        !binding.nativeTaskId ||
        binding.provisionalTaskIdentity ||
        binding.visibilityState.visibility !== "visible" ||
        !supportsClaudeTaskControls(context.taskControlVersion)
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "task/control",
          detail: "The task control no longer matches this exact live task and account.",
        });
      }
      if (context.terminalTaskIds.has(String(binding.taskId)))
        return { status: "already-terminal" as const };
      if (input.action === "stop") {
        if (!context.query.stopTask)
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "task/control",
            detail: "Stopping individual tasks is unavailable in this runtime.",
          });
        yield* Effect.tryPromise({
          try: () => context.query.stopTask!(binding.nativeTaskId!),
          catch: () =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "task/control",
              detail: "The task control outcome is unknown. Wait for a provider status update.",
            }),
        });
        return { status: "accepted" as const };
      }
      const toolUseId = admittedClaudeControlIdentity(binding.toolUseId);
      if (!context.query.backgroundTasks || !toolUseId)
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "task/control",
          detail: "Backgrounding this individual task is unavailable.",
        });
      if (binding.backgrounded) return { status: "not-foreground" as const };
      const accepted = yield* Effect.tryPromise({
        try: () => context.query.backgroundTasks!(toolUseId),
        catch: () =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "task/control",
            detail: "The task control outcome is unknown. Wait for a provider status update.",
          }),
      });
      return { status: accepted ? ("accepted" as const) : ("not-foreground" as const) };
    },
  );

  return {
    controlTask,
    provider: PROVIDER,
    capabilities: {
      get subagentConcurrency() {
        return options?.getSubagentConcurrencySupport?.() ?? false;
      },
      sessionModelSwitch: "in-session",
      liveSteer: "supported",
      sessionFork: "supported",
    },
    startSession,
    forkSession: forkProviderSession,
    discardSessionFork: discardProviderSessionFork,
    sendTurn,
    steerTurn,
    interruptTurn,
    readThread,
    readSubagentDetail,
    rollbackThread,
    prepareRollbackThread,
    respondToRequest,
    respondToUserInput,
    resolveInteractionUrl,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ClaudeAdapterShape;
});
