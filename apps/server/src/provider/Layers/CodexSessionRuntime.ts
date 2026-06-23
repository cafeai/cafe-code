import {
  ApprovalRequestId,
  DEFAULT_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderTurnSteerResult,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { normalizeModelSlug } from "@cafecode/shared/model";
import {
  CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
  CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
} from "@cafecode/shared/codexCompaction";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SchemaIssue from "effect/SchemaIssue";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  isDiagnosticsQueryProcess,
  readProcessRows,
  sanitizeProcessCommand,
  type ProcessRow,
} from "../../diagnostics/ProcessDiagnostics.ts";
const decodeV2TurnStartResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartResponse);
const decodeV2TurnSteerParams = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerParams);
const decodeV2TurnSteerResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnSteerResponse);

const PROVIDER = ProviderDriverKind.make("codex");

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
const CODEX_REMOTE_COMPACTION_V2_FEATURE_CONFIG_KEY = "features.remote_compaction_v2";
const CODEX_LOCAL_ENVIRONMENT_ID = "local";
const CODEX_SNAPSHOT_BACKFILL_TURN_LIMIT = 1;
const CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS = [
  "2 seconds",
  "10 seconds",
  "30 seconds",
  "60 seconds",
  "120 seconds",
  "180 seconds",
  "300 seconds",
  "600 seconds",
  "900 seconds",
  "1200 seconds",
  "1800 seconds",
] as const;
const CODEX_SEND_TURN_STILL_IN_PROGRESS_WARNING_DELAYS = new Set<
  (typeof CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS)[number]
>([
  "60 seconds",
  "120 seconds",
  "180 seconds",
  "300 seconds",
  "600 seconds",
  "900 seconds",
  "1200 seconds",
  "1800 seconds",
]);
const CODEX_SEND_TURN_SNAPSHOT_BACKFILL_READ_TIMEOUT = "10 seconds" as const;
const CODEX_TURN_STEER_PROCESSING_WARNING_DELAYS = [
  "15 seconds",
  "60 seconds",
  "120 seconds",
] as const;
const CODEX_APP_SERVER_CHILD_PROCESS_WARNING_LIMIT = 8;
const CODEX_APP_SERVER_CHILD_PROCESS_COMMAND_PREVIEW_LENGTH = 180;
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});
const CodexUserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);
const isCodexUserInputAnswerObject = Schema.is(CodexUserInputAnswerObject);

const CodexRuntimeWorkspaceRoots = Schema.Array(Schema.String);
const CodexLocalTurnEnvironments = Schema.Array(
  Schema.Struct({
    environmentId: Schema.String,
    cwd: Schema.String,
  }),
);
const CodexThreadStartParamsWithRuntimeWorkspaceRoots = EffectCodexSchema.V2ThreadStartParams.pipe(
  Schema.fieldsAssign({
    environments: Schema.optionalKey(CodexLocalTurnEnvironments),
    runtimeWorkspaceRoots: Schema.optionalKey(CodexRuntimeWorkspaceRoots),
  }),
);

// Upstream marks `environments`, `runtimeWorkspaceRoots`, and `collaborationMode` as
// experimental, so the public generated TypeScript schema omits them even
// though the TUI sends them after initializing with `experimentalApi: true`.
// Cafe opts into the same capability and layers those fields onto the local
// request schema so request construction is still explicit and testable.
const CodexTurnStartParamsWithExperimentalFields = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
    environments: Schema.optionalKey(CodexLocalTurnEnvironments),
    runtimeWorkspaceRoots: Schema.optionalKey(CodexRuntimeWorkspaceRoots),
  }),
);
const decodeCodexTurnStartParamsWithExperimentalFields = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithExperimentalFields,
);
const decodeV2ThreadStartResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2ThreadStartResponse,
);
const decodeV2ThreadResumeResponse = Schema.decodeUnknownEffect(
  EffectCodexSchema.V2ThreadResumeResponse,
);

type CodexThreadStartParamsWithRuntimeWorkspaceRoots =
  typeof CodexThreadStartParamsWithRuntimeWorkspaceRoots.Type;
type CodexThreadResumeParamsWithRuntimeWorkspaceRoots = EffectCodexSchema.V2ThreadResumeParams & {
  readonly environments?: ReadonlyArray<{ readonly environmentId: string; readonly cwd: string }>;
  readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
};
export type CodexTurnStartParamsWithExperimentalFields =
  typeof CodexTurnStartParamsWithExperimentalFields.Type;
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();
const CODEX_HTTP_FALLBACK_PROVIDER_ID = "cafecode-openai-http";

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexServiceTier = NonNullable<EffectCodexSchema.V2ThreadStartParams["serviceTier"]>;
type CodexThreadItem =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["turns"][number]["items"][number];
type CodexSnapshotThreadItem = CodexThreadItem;
type CodexSnapshotTurn = {
  readonly completedAt?: number | null;
  readonly durationMs?: number | null;
  readonly error?: { readonly message: string } | null;
  readonly id: string;
  readonly items: ReadonlyArray<CodexSnapshotThreadItem>;
  readonly itemsView?: "notLoaded" | "summary" | "full";
  readonly startedAt?: number | null;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
};
type CodexSnapshotThreadStatus =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["status"]
  | EffectCodexSchema.V2ThreadResumeResponse["thread"]["status"]
  | EffectCodexSchema.V2ThreadStartResponse["thread"]["status"]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["status"];
type CodexSnapshotThread = {
  readonly id: string;
  readonly status?: CodexSnapshotThreadStatus | undefined;
  readonly turns: ReadonlyArray<CodexSnapshotTurn>;
};
type CodexSnapshotBackfillReason =
  | "session-start"
  | "session-resume"
  | "session-resume-active-turn"
  | "send-turn-follow-up"
  | "thread-status-idle-reconciliation"
  | "turn-steer-follow-up";

type CodexElapsedDelayLabel =
  | (typeof CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS)[number]
  | (typeof CODEX_TURN_STEER_PROCESSING_WARNING_DELAYS)[number];

export interface CodexTransportPolicy {
  readonly responsesWebsockets: "auto" | "disabled";
  readonly reason?: string;
  readonly observedAt?: string;
}

export function buildCodexAppServerArgs(
  transportPolicy: CodexTransportPolicy | undefined,
): ReadonlyArray<string> {
  if (transportPolicy?.responsesWebsockets !== "disabled") {
    return ["app-server"];
  }

  // Codex's built-in `openai` provider cannot be overridden by config. A
  // Cafe-scoped provider id lets us keep ChatGPT/OpenAI auth and Responses API
  // behavior while turning off only the unstable Responses WebSocket transport.
  return [
    "app-server",
    "-c",
    `model_provider="${CODEX_HTTP_FALLBACK_PROVIDER_ID}"`,
    "-c",
    `model_providers.${CODEX_HTTP_FALLBACK_PROVIDER_ID}.name="OpenAI"`,
    "-c",
    `model_providers.${CODEX_HTTP_FALLBACK_PROVIDER_ID}.wire_api="responses"`,
    "-c",
    `model_providers.${CODEX_HTTP_FALLBACK_PROVIDER_ID}.requires_openai_auth=true`,
    "-c",
    `model_providers.${CODEX_HTTP_FALLBACK_PROVIDER_ID}.env_http_headers.OpenAI-Organization="OPENAI_ORGANIZATION"`,
    "-c",
    `model_providers.${CODEX_HTTP_FALLBACK_PROVIDER_ID}.env_http_headers.OpenAI-Project="OPENAI_PROJECT"`,
    "-c",
    `model_providers.${CODEX_HTTP_FALLBACK_PROVIDER_ID}.supports_websockets=false`,
  ];
}

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly appServerCwd?: string;
  readonly homePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly transportPolicy?: CodexTransportPolicy;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly additionalDirectories?: ReadonlyArray<string> | undefined;
  readonly resumeCursor?: CodexResumeCursor;
}

export interface CodexSessionRuntimeSendTurnInput {
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly interactionMode?: ProviderInteractionMode;
  readonly additionalDirectories?: ReadonlyArray<string> | undefined;
}

export interface CodexSessionRuntimeSteerTurnInput {
  readonly expectedTurnId: TurnId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
}

export interface CodexThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<CodexThreadItem>;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

export interface CodexSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, CodexSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly steerTurn: (
    input: CodexSessionRuntimeSteerTurnInput,
  ) => Effect.Effect<ProviderTurnSteerResult, CodexSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

export type CodexSessionRuntimeError =
  | CodexErrors.CodexAppServerError
  | CodexSessionRuntimePendingApprovalNotFoundError
  | CodexSessionRuntimePendingUserInputNotFoundError
  | CodexSessionRuntimeInvalidUserInputAnswersError
  | CodexSessionRuntimeThreadIdMissingError;

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedErrorClass<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedErrorClass<CodexSessionRuntimeThreadIdMissingError>()(
  "CodexSessionRuntimeThreadIdMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex session is missing a provider thread id for ${this.threadId}`;
  }
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: string;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ApprovalCorrelation {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface CodexTurnStartObservation {
  readonly providerThreadId: string;
  readonly turnId: TurnId;
  readonly requestedAt: string;
  readonly acknowledgedAt: string;
  readonly ackLatencyMs: number;
  readonly promptByteLength: number;
  readonly attachmentCount: number;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly serviceTier: string | undefined;
  readonly additionalDirectoryCount: number;
  readonly firstNotificationAt: string | undefined;
  readonly firstNotificationMethod: string | undefined;
  readonly firstTurnEventAt: string | undefined;
  readonly firstTurnEventMethod: string | undefined;
  readonly lastNotificationAt: string | undefined;
  readonly lastNotificationMethod: string | undefined;
  readonly backfillAttemptCount: number;
  readonly noTurnEventWarningCount: number;
  readonly lastBackfillAt: string | undefined;
  readonly lastBackfillThreadStatus: string | undefined;
  readonly lastBackfillTurnFound: boolean | undefined;
  readonly lastBackfillTurnStatus: string | undefined;
  readonly lastBackfillItemCount: number | undefined;
  readonly lastBackfillItemsView: string | null | undefined;
}

export interface CodexPendingSteerProcessing {
  readonly steerId: string;
  readonly providerThreadId: string;
  readonly turnId: TurnId;
  readonly requestedAt: string;
  readonly acknowledgedAt: string;
  readonly acknowledgedAtMs: number;
  readonly ackLatencyMs: number;
  readonly promptByteLength: number;
  readonly attachmentCount: number;
  readonly warningCount: number;
  readonly processedAt?: string;
  readonly providerUserMessageItemId?: ProviderItemId;
  readonly providerUserMessageMethod?: string;
  readonly ackToProviderItemMs?: number;
}

type CodexServerNotification = {
  readonly method: string;
  readonly params: unknown;
};

interface CodexSnapshotReadResult {
  readonly threadStatusType: "notLoaded" | "idle" | "systemError" | "active" | undefined;
  readonly turn: CodexSnapshotTurn | null;
}

export interface CodexActiveContextCompaction {
  readonly providerThreadId?: string;
  readonly turnId: TurnId;
  readonly itemId: ProviderItemId;
  readonly startedAt: string;
}

export interface CodexAppServerChildProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly depth: number;
  readonly role: "active" | "support";
  readonly supportReason?: string;
  readonly status: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly elapsed: string;
  readonly elapsedSeconds: number | null;
  readonly commandLabel: string;
  readonly command: string;
  readonly childPids: ReadonlyArray<number>;
}

export type CodexAppServerChildProcessDiagnostics =
  | {
      readonly status: "available";
      readonly appServerPid: number;
      readonly processCount: number;
      readonly activeProcessCount: number;
      readonly supportProcessCount: number;
      readonly listedProcessCount: number;
      readonly hiddenProcessCount: number;
      readonly totalCpuPercent: number;
      readonly totalRssBytes: number;
      readonly longestElapsed: string | null;
      readonly longestElapsedSeconds: number | null;
      readonly processes: ReadonlyArray<CodexAppServerChildProcessEntry>;
    }
  | {
      readonly status: "unavailable";
      readonly appServerPid?: number;
      readonly error: string;
    };

function makeCodexServerNotification(method: string, params: unknown): CodexServerNotification {
  return { method, params };
}

function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }
  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }
  return normalized;
}

function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return isCodexResumeCursorSchema(resumeCursor) ? resumeCursor.threadId : undefined;
}

function runtimeModeToThreadConfig(input: RuntimeMode): {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
} {
  switch (input) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
  }
}

function normalizeComparableWorkspaceRoot(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
}

function buildRuntimeWorkspaceRoots(input: {
  readonly cwd: string;
  readonly additionalDirectories?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [input.cwd, ...(input.additionalDirectories ?? [])]) {
    const root = candidate.trim();
    if (root.length === 0) {
      continue;
    }
    const comparable = normalizeComparableWorkspaceRoot(root);
    if (seen.has(comparable)) {
      continue;
    }
    seen.add(comparable);
    roots.push(root);
  }
  return roots;
}

function buildLocalCodexTurnEnvironments(
  cwd: string,
): ReadonlyArray<{ readonly environmentId: string; readonly cwd: string }> {
  // Codex 0.142 promotes execution environments to the app-server request
  // layer. The TUI's default local environment selection pairs the fallback
  // cwd with the local environment id, while additional write roots remain
  // separate workspace/sandbox policy. Keep this explicit so app-server does
  // not have to infer the environment from its own process cwd.
  return [
    {
      environmentId: CODEX_LOCAL_ENVIRONMENT_ID,
      cwd,
    },
  ];
}

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly additionalDirectories?: ReadonlyArray<string> | undefined;
}): CodexThreadStartParamsWithRuntimeWorkspaceRoots {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  // Upstream Codex 0.142.0 only auto-compacts when the resolved model info or
  // request config supplies `model_auto_compact_token_limit`. Current Codex
  // model metadata can advertise a large context window while leaving that
  // limit null, so Cafe passes the documented request-config override for
  // Cafe-managed threads instead of mutating the user's shared
  // `~/.codex/config.toml`. The shared constant documents why Cafe currently
  // chooses 200k instead of the older 100k override.
  const threadConfig: Record<string, unknown> = {
    // Upstream Codex rust-v0.142.0 marks remote_compaction_v2 stable and
    // default-enabled, but its compaction request still builds the normal
    // model-visible tool set. Cafe has observed text compaction failures from
    // inherited hosted image-generation tools on accounts/models without that
    // image model, so this remains a deliberate Cafe reliability quarantine
    // until a live long-context compaction smoke verifies the v2 path.
    [CODEX_REMOTE_COMPACTION_V2_FEATURE_CONFIG_KEY]: false,
    model_auto_compact_token_limit: CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
    model_auto_compact_token_limit_scope: CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT_SCOPE,
  };
  if (input.runtimeMode === "auto-accept-edits" && input.additionalDirectories?.length) {
    threadConfig.sandbox_workspace_write = {
      writable_roots: input.additionalDirectories,
    };
  }
  return {
    cwd: input.cwd,
    environments: buildLocalCodexTurnEnvironments(input.cwd),
    runtimeWorkspaceRoots: buildRuntimeWorkspaceRoots({
      cwd: input.cwd,
      additionalDirectories: input.additionalDirectories,
    }),
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    config: threadConfig,
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

function runtimeModeToTurnSandboxPolicy(
  input: RuntimeMode,
  additionalDirectories: ReadonlyArray<string> = [],
): EffectCodexSchema.V2TurnStartParams__SandboxPolicy {
  switch (input) {
    case "approval-required":
      return {
        type: "readOnly",
      };
    case "auto-accept-edits":
      return {
        type: "workspaceWrite",
        ...(additionalDirectories.length > 0 ? { writableRoots: additionalDirectories } : {}),
      };
    case "full-access":
    default:
      return {
        type: "dangerFullAccess",
      };
  }
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
}): EffectCodexSchema.V2TurnStartParams__CollaborationMode | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL;
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions:
        input.interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

export function buildTurnStartParams(input: {
  readonly threadId: string;
  readonly cwd?: string;
  readonly runtimeMode: RuntimeMode;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly interactionMode?: ProviderInteractionMode;
  readonly additionalDirectories?: ReadonlyArray<string> | undefined;
}): Effect.Effect<
  CodexTurnStartParamsWithExperimentalFields,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnStartParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });

  return decodeCodexTurnStartParamsWithExperimentalFields({
    threadId: input.threadId,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.cwd
      ? {
          environments: buildLocalCodexTurnEnvironments(input.cwd),
          runtimeWorkspaceRoots: buildRuntimeWorkspaceRoots({
            cwd: input.cwd,
            additionalDirectories: input.additionalDirectories,
          }),
        }
      : {}),
    input: turnInput,
    approvalPolicy: config.approvalPolicy,
    sandboxPolicy: runtimeModeToTurnSandboxPolicy(
      input.runtimeMode,
      input.additionalDirectories ?? [],
    ),
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/start request payload", error)),
  );
}

export function buildTurnSteerParams(input: {
  readonly threadId: string;
  readonly expectedTurnId: TurnId;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
}): Effect.Effect<
  EffectCodexSchema.V2TurnSteerParams,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnSteerParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  // Upstream Codex app-server documents `turn/steer` as input injection for
  // the current in-flight turn. It requires the active turn precondition and
  // intentionally omits turn-level overrides such as model, effort, sandbox, or
  // collaboration mode. It returns the existing active turn id and does not emit
  // a new `turn/started` notification.
  return decodeV2TurnSteerParams({
    threadId: input.threadId,
    expectedTurnId: input.expectedTurnId,
    input: turnInput,
  }).pipe(
    Effect.mapError((error) => toProtocolParseError("Invalid turn/steer request payload", error)),
  );
}

function codexContextCompactionKey(turnId: TurnId, itemId: ProviderItemId): string {
  return `${String(turnId)}:${String(itemId)}`;
}

function normalizeCodexItemType(value: string | undefined | null): string | undefined {
  if (!value) {
    return undefined;
  }
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]+/g, " ")
    .trim()
    .toLowerCase();
}

export function isCodexContextCompactionItemType(value: string | undefined | null): boolean {
  const normalized = normalizeCodexItemType(value);
  return normalized === "context compaction";
}

export function isCodexUserMessageItemType(value: string | undefined | null): boolean {
  const normalized = normalizeCodexItemType(value);
  return normalized === "user message";
}

export function updateCodexActiveContextCompactions(
  current: ReadonlyMap<string, CodexActiveContextCompaction>,
  input: {
    readonly method: string;
    readonly providerThreadId?: string | undefined;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: ProviderItemId | undefined;
    readonly itemType?: string | null | undefined;
    readonly observedAt: string;
  },
): Map<string, CodexActiveContextCompaction> {
  const unchanged = () => (current instanceof Map ? current : new Map(current));

  if (input.method === "turn/completed" && input.turnId) {
    let changed = false;
    const next = new Map(current);
    for (const [key, compaction] of next) {
      if (compaction.turnId === input.turnId) {
        next.delete(key);
        changed = true;
      }
    }
    return changed ? next : unchanged();
  }

  if (!input.turnId || !input.itemId) {
    return unchanged();
  }

  const key = codexContextCompactionKey(input.turnId, input.itemId);
  const existing = current.get(key);
  const isContextCompaction = isCodexContextCompactionItemType(input.itemType);

  if (input.method === "item/started" && isContextCompaction) {
    const next = new Map(current);
    next.set(key, {
      ...(input.providerThreadId ? { providerThreadId: input.providerThreadId } : {}),
      turnId: input.turnId,
      itemId: input.itemId,
      startedAt: input.observedAt,
    });
    return next;
  }

  if (input.method === "item/completed" && (isContextCompaction || existing !== undefined)) {
    if (existing === undefined) {
      return unchanged();
    }
    const next = new Map(current);
    next.delete(key);
    return next;
  }

  return unchanged();
}

export function updateCodexPendingSteerProcessingFromNotification(
  current: ReadonlyMap<string, CodexPendingSteerProcessing>,
  input: {
    readonly method: string;
    readonly providerThreadId?: string | undefined;
    readonly turnId?: TurnId | undefined;
    readonly itemId?: ProviderItemId | undefined;
    readonly itemType?: string | undefined;
    readonly observedAt: string;
    readonly observedAtMs: number;
  },
): {
  readonly pending: CodexPendingSteerProcessing | undefined;
  readonly next: Map<string, CodexPendingSteerProcessing>;
} {
  const unchanged = () => (current instanceof Map ? current : new Map(current));

  if (
    (input.method !== "item/started" && input.method !== "item/completed") ||
    !input.turnId ||
    !isCodexUserMessageItemType(input.itemType)
  ) {
    return { pending: undefined, next: unchanged() };
  }

  const pending = Array.from(current.values())
    .filter(
      (entry) =>
        entry.processedAt === undefined &&
        entry.turnId === input.turnId &&
        (!input.providerThreadId || entry.providerThreadId === input.providerThreadId),
    )
    .toSorted((left, right) => left.acknowledgedAt.localeCompare(right.acknowledgedAt))[0];

  if (!pending) {
    return { pending: undefined, next: unchanged() };
  }

  const updated = {
    ...pending,
    processedAt: input.observedAt,
    providerUserMessageMethod: input.method,
    ackToProviderItemMs: Math.max(0, input.observedAtMs - pending.acknowledgedAtMs),
    ...(input.itemId ? { providerUserMessageItemId: input.itemId } : {}),
  } satisfies CodexPendingSteerProcessing;
  const next = new Map(current);
  next.set(pending.steerId, updated);
  return { pending: updated, next };
}

function prunePendingSteerProcessing(
  current: ReadonlyMap<string, CodexPendingSteerProcessing>,
): Map<string, CodexPendingSteerProcessing> {
  const next = new Map(current);
  while (next.size > 50) {
    const oldest = Array.from(next.values()).toSorted((left, right) =>
      left.acknowledgedAt.localeCompare(right.acknowledgedAt),
    )[0];
    if (!oldest) {
      break;
    }
    next.delete(oldest.steerId);
  }
  return next;
}

function parseCodexProcessElapsedSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "n/a") return null;

  const [dayPart, timePart = dayPart] = trimmed.includes("-")
    ? (trimmed.split("-", 2) as [string, string])
    : ["0", trimmed];
  const days = Number.parseInt(dayPart, 10);
  if (!Number.isInteger(days) || days < 0) return null;

  const parts = timePart.split(":");
  const secondsText = parts.at(-1);
  if (!secondsText) return null;
  const seconds = Number.parseFloat(secondsText);
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  const minutesText = parts.length >= 2 ? parts.at(-2) : "0";
  const hoursText = parts.length >= 3 ? parts.at(-3) : "0";
  const minutes = Number.parseInt(minutesText ?? "0", 10);
  const hours = Number.parseInt(hoursText ?? "0", 10);
  if (!Number.isInteger(minutes) || minutes < 0 || !Number.isInteger(hours) || hours < 0) {
    return null;
  }

  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function codexProcessChildrenByParent(rows: ReadonlyArray<ProcessRow>): Map<number, ProcessRow[]> {
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row);
    childrenByParent.set(row.ppid, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.pid - right.pid);
  }
  return childrenByParent;
}

function tokenizeProcessCommandPreview(command: string): ReadonlyArray<string> {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^["']|["']$/g, ""));
}

function processTokenBasename(token: string): string {
  return token.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? token;
}

function isSafeProcessToken(token: string): boolean {
  return /^[A-Za-z0-9._:@=/-]{1,96}$/.test(token) && !token.includes("[redacted]");
}

function summarizeCodexChildProcessCommand(command: string): {
  readonly label: string;
  readonly preview: string;
} {
  const sanitized = sanitizeProcessCommand(command, {
    maxLength: CODEX_APP_SERVER_CHILD_PROCESS_COMMAND_PREVIEW_LENGTH * 2,
  });
  const tokens = tokenizeProcessCommandPreview(sanitized);
  const basenames = tokens.map(processTokenBasename);
  const seleneIndex = basenames.findIndex((token) => token.toLowerCase() === "selene");
  if (seleneIndex >= 0) {
    const args = tokens
      .slice(seleneIndex + 1, seleneIndex + 4)
      .filter(isSafeProcessToken)
      .map((token) => token);
    return {
      label: "selene",
      preview: ["selene", ...args].join(" "),
    };
  }

  const codexIndex = basenames.findIndex((token) => token.toLowerCase() === "codex");
  if (codexIndex >= 0) {
    const preview = ["codex"];
    const subcommand = tokens[codexIndex + 1];
    let index = codexIndex + 1;
    if (subcommand && ["app-server", "exec"].includes(subcommand)) {
      preview.push(subcommand);
      index += 1;
    }

    while (index < tokens.length && preview.length < 8) {
      const token = tokens[index];
      if (token === "--model" && isSafeProcessToken(tokens[index + 1] ?? "")) {
        preview.push(token, tokens[index + 1] as string);
        index += 2;
        continue;
      }
      if (token === "--sandbox" && isSafeProcessToken(tokens[index + 1] ?? "")) {
        preview.push(token, tokens[index + 1] as string);
        index += 2;
        continue;
      }
      if (token === "--cd" && isSafeProcessToken(tokens[index + 1] ?? "")) {
        preview.push(token, tokens[index + 1] as string);
        index += 2;
        continue;
      }
      if (token === "--skip-git-repo-check") {
        preview.push(token);
      }
      index += 1;
    }

    return {
      label: "codex",
      preview: preview.join(" "),
    };
  }

  const label = processTokenBasename(tokens[0] ?? "process");
  return {
    label,
    preview: label,
  };
}

function classifyCodexAppServerChildProcess(
  row: ProcessRow,
  command: ReturnType<typeof summarizeCodexChildProcessCommand>,
): Pick<CodexAppServerChildProcessEntry, "role" | "supportReason"> {
  const normalizedCommand = row.command.toLowerCase();
  const normalizedLabel = command.label.toLowerCase();

  // These processes are long-lived support servers launched by Codex.app's
  // bundled MCP/runtime stack. They can remain alive for the whole app-server
  // session, so counting them as active turn work makes a quiescent or wedged
  // turn look legitimately busy. Upstream TUI waits on app-server turn events,
  // not on these helper process lifetimes.
  if (
    normalizedLabel === "node_repl" ||
    normalizedCommand.includes("/node_repl") ||
    normalizedCommand.includes("\\node_repl")
  ) {
    return {
      role: "support",
      supportReason: "codex-bundled-node-repl",
    };
  }

  if (normalizedCommand.includes("skycomputeruseclient")) {
    return {
      role: "support",
      supportReason: "codex-bundled-computer-use-mcp",
    };
  }

  if (normalizedCommand.includes("codex") && normalizedCommand.includes("app-server")) {
    return {
      role: "support",
      supportReason:
        normalizedCommand.includes("--listen") || normalizedCommand.includes("stdio://")
          ? "codex-bundled-nested-app-server"
          : "codex-app-server-runtime",
    };
  }

  return { role: "active" };
}

export function summarizeCodexAppServerChildProcesses(input: {
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly appServerPid: number;
  readonly diagnosticsRootPid?: number;
  readonly limit?: number;
}): CodexAppServerChildProcessDiagnostics {
  if (!Number.isSafeInteger(input.appServerPid) || input.appServerPid <= 0) {
    return {
      status: "unavailable",
      error: "Codex app-server PID is unavailable.",
    };
  }

  const diagnosticsRootPid = input.diagnosticsRootPid ?? process.pid;
  const rows = input.rows.filter((row) => !isDiagnosticsQueryProcess(row, diagnosticsRootPid));
  const childrenByParent = codexProcessChildrenByParent(rows);
  const entries: Array<{ readonly row: ProcessRow; readonly depth: number }> = [];
  const queue: Array<{ readonly row: ProcessRow; readonly depth: number }> = (
    childrenByParent.get(input.appServerPid) ?? []
  ).map((row) => ({ row, depth: 0 }));
  const seen = new Set<number>();

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next.row.pid)) continue;
    seen.add(next.row.pid);
    entries.push(next);
    queue.push(
      ...(childrenByParent.get(next.row.pid) ?? []).map((row) => ({
        row,
        depth: next.depth + 1,
      })),
    );
  }

  const allProcesses = entries.map(({ row, depth }) => {
    const elapsedSeconds = parseCodexProcessElapsedSeconds(row.elapsed);
    const command = summarizeCodexChildProcessCommand(row.command);
    const classification = classifyCodexAppServerChildProcess(row, command);
    const entry: CodexAppServerChildProcessEntry = {
      pid: row.pid,
      ppid: row.ppid,
      depth,
      role: classification.role,
      status: row.status || "unknown",
      cpuPercent: Math.max(0, row.cpuPercent),
      rssBytes: Math.max(0, row.rssBytes),
      elapsed: row.elapsed || "n/a",
      elapsedSeconds,
      commandLabel: command.label,
      command: command.preview,
      childPids: (childrenByParent.get(row.pid) ?? []).map((child) => child.pid),
    };
    return classification.supportReason === undefined
      ? entry
      : Object.assign(entry, { supportReason: classification.supportReason });
  });
  const longest = allProcesses
    .filter((process) => process.elapsedSeconds !== null)
    .toSorted((left, right) => (right.elapsedSeconds ?? 0) - (left.elapsedSeconds ?? 0))[0];
  const limit = Math.max(0, input.limit ?? CODEX_APP_SERVER_CHILD_PROCESS_WARNING_LIMIT);
  const processes = allProcesses.slice(0, limit);
  const activeProcessCount = allProcesses.filter((process) => process.role === "active").length;
  const supportProcessCount = allProcesses.length - activeProcessCount;

  return {
    status: "available",
    appServerPid: input.appServerPid,
    processCount: allProcesses.length,
    activeProcessCount,
    supportProcessCount,
    listedProcessCount: processes.length,
    hiddenProcessCount: Math.max(0, allProcesses.length - processes.length),
    totalCpuPercent:
      Math.round(allProcesses.reduce((sum, row) => sum + row.cpuPercent, 0) * 100) / 100,
    totalRssBytes: allProcesses.reduce((sum, row) => sum + row.rssBytes, 0),
    longestElapsed: longest?.elapsed ?? null,
    longestElapsedSeconds: longest?.elapsedSeconds ?? null,
    processes,
  };
}

function codexActiveChildProcessCount(diagnostics: CodexAppServerChildProcessDiagnostics): number {
  return diagnostics.status === "available" ? diagnostics.activeProcessCount : 0;
}

function findCodexActiveContextCompactionForTurn(
  compactions: ReadonlyMap<string, CodexActiveContextCompaction>,
  turnId: TurnId,
  providerThreadId: string,
): CodexActiveContextCompaction | undefined {
  for (const compaction of compactions.values()) {
    if (compaction.turnId !== turnId) {
      continue;
    }
    if (compaction.providerThreadId && compaction.providerThreadId !== providerThreadId) {
      continue;
    }
    return compaction;
  }
  return undefined;
}

export function buildCodexActiveContextCompactionSteerError(input: {
  readonly providerThreadId: string;
  readonly turnId: TurnId;
  readonly itemId: ProviderItemId;
  readonly startedAt: string;
}): CodexErrors.CodexAppServerRequestError {
  return CodexErrors.CodexAppServerRequestError.invalidRequest("cannot steer a compact turn", {
    message: "cannot steer a compact turn",
    codexErrorInfo: {
      activeTurnNotSteerable: {
        turnKind: "compact",
      },
    },
    additionalDetails: {
      providerThreadId: input.providerThreadId,
      turnId: input.turnId,
      itemId: input.itemId,
      contextCompactionStartedAt: input.startedAt,
    },
  });
}

function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "WARN" && level !== "ERROR") {
      return null;
    }
    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread")) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"];

type CodexThreadOpenMethod = "thread/start" | "thread/resume";
type CodexThreadOpenPayloadByMethod = {
  readonly "thread/start": CodexThreadStartParamsWithRuntimeWorkspaceRoots;
  readonly "thread/resume": CodexThreadResumeParamsWithRuntimeWorkspaceRoots;
};

interface CodexThreadOpenClient {
  readonly raw: {
    readonly request: (
      method: CodexThreadOpenMethod,
      payload: CodexThreadOpenPayloadByMethod[CodexThreadOpenMethod],
    ) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
  };
}

const requestCodexThreadOpen = <M extends CodexThreadOpenMethod>(
  client: CodexThreadOpenClient,
  method: M,
  payload: CodexThreadOpenPayloadByMethod[M],
): Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError> =>
  client.raw.request(method, payload).pipe(
    Effect.flatMap((rawResponse) => {
      if (method === "thread/start") {
        return decodeV2ThreadStartResponse(rawResponse).pipe(
          Effect.mapError((error) =>
            toProtocolParseError("Invalid thread/start response payload", error),
          ),
        ) as Effect.Effect<
          CodexRpc.ClientRequestResponsesByMethod[M],
          CodexErrors.CodexAppServerError
        >;
      }
      return decodeV2ThreadResumeResponse(rawResponse).pipe(
        Effect.mapError((error) =>
          toProtocolParseError("Invalid thread/resume response payload", error),
        ),
      ) as Effect.Effect<
        CodexRpc.ClientRequestResponsesByMethod[M],
        CodexErrors.CodexAppServerError
      >;
    }),
  );

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resumeThreadId: string | undefined;
  readonly additionalDirectories?: ReadonlyArray<string> | undefined;
}): Effect.Effect<CodexThreadOpenResponse, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;
  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
    additionalDirectories: input.additionalDirectories,
  });

  if (resumeThreadId === undefined) {
    return requestCodexThreadOpen(input.client, "thread/start", startParams);
  }

  return requestCodexThreadOpen(input.client, "thread/resume", {
    threadId: resumeThreadId,
    ...startParams,
  }).pipe(
    Effect.catchIf(isRecoverableThreadResumeError, (error) =>
      Effect.logWarning("codex app-server thread resume fell back to fresh start", {
        threadId: input.threadId,
        requestedRuntimeMode: input.runtimeMode,
        resumeThreadId,
        recoverable: true,
        cause: error.message,
      }).pipe(Effect.andThen(requestCodexThreadOpen(input.client, "thread/start", startParams))),
    ),
  );
};

function readNotificationThreadId(notification: CodexServerNotification): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return (
        readNotificationNestedString(notification, "thread", "id") ??
        readNotificationParamString(notification, "threadId")
      );
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return readNotificationParamString(notification, "threadId");
    default:
      return undefined;
  }
}

function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: readNotificationTurnId(notification),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: readNotificationTurnId(notification),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
      return {
        turnId: readNotificationTurnId(notification),
        itemId: undefined,
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "item/started":
    case "item/completed":
      return {
        turnId: readNotificationTurnId(notification),
        itemId: readNotificationItemId(notification),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: readNotificationTurnId(notification),
        itemId: readNotificationItemId(notification),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  const params = readRecord(notification.params);
  const item = params ? readRecord(params.item) : undefined;
  if (item?.type !== "collabAgentToolCall") {
    return;
  }

  const receiverThreadIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
  for (const receiverThreadId of receiverThreadIds) {
    if (typeof receiverThreadId !== "string") {
      continue;
    }
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

function shouldSuppressChildConversationNotification(method: string): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

export function readCodexExpectedActiveTurnMismatchActualTurnId(
  error: unknown,
): TurnId | undefined {
  const message = error instanceof Error ? error.message : String(error);
  const quoted = /^expected active turn id `[^`]+` but found `([^`]+)`$/.exec(message);
  if (quoted?.[1]) {
    return TurnId.make(quoted[1]);
  }

  // Upstream Codex app-server currently formats `turn/steer` mismatches with
  // backticks and `turn/interrupt` mismatches without them. Treat both as the
  // same active-turn reconciliation signal so Cafe can retry against the
  // app-server-reported turn instead of surfacing a recoverable stale projection.
  const unquoted = /^expected active turn id \S+ but found (\S+)$/.exec(message);
  const actualTurnId = unquoted?.[1]?.trim();
  return actualTurnId && actualTurnId.length > 0 ? TurnId.make(actualTurnId) : undefined;
}

export const readCodexSteerExpectedTurnMismatchActualTurnId =
  readCodexExpectedActiveTurnMismatchActualTurnId;

function isCodexSteerExpectedTurnMismatch(error: unknown): boolean {
  return readCodexExpectedActiveTurnMismatchActualTurnId(error) !== undefined;
}

function isCodexNoActiveTurnToSteerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "no active turn to steer";
}

function isCodexNoActiveTurnToInterruptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message === "no active turn to interrupt";
}

function toCodexUserInputAnswer(
  questionId: string,
  value: ProviderUserInputAnswers[string],
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse__ToolRequestUserInputAnswer,
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  if (typeof value === "string") {
    return Effect.succeed({ answers: [value] });
  }
  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return Effect.succeed({ answers });
  }
  if (isCodexUserInputAnswerObject(value)) {
    return Effect.succeed({ answers: value.answers });
  }
  return Effect.fail(new CodexSessionRuntimeInvalidUserInputAnswersError({ questionId }));
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse["answers"],
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  return Effect.forEach(
    Object.entries(answers),
    ([questionId, value]) =>
      toCodexUserInputAnswer(questionId, value).pipe(
        Effect.map((answer) => [questionId, answer] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

function toProtocolParseError(
  detail: string,
  cause: Schema.SchemaError,
): CodexErrors.CodexAppServerProtocolParseError {
  return new CodexErrors.CodexAppServerProtocolParseError({
    detail: `${detail}: ${formatSchemaIssue(cause.issue)}`,
    cause,
  });
}

function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

function turnObservationKey(turnId: TurnId): string {
  return String(turnId);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNotificationParamString(
  notification: CodexServerNotification,
  field: string,
): string | undefined {
  const params = readRecord(notification.params);
  return params ? readString(params[field]) : undefined;
}

function readNotificationNestedString(
  notification: CodexServerNotification,
  field: string,
  nestedField: string,
): string | undefined {
  const params = readRecord(notification.params);
  const nested = params ? readRecord(params[field]) : undefined;
  return nested ? readString(nested[nestedField]) : undefined;
}

function readNotificationParamBoolean(
  notification: CodexServerNotification,
  field: string,
): boolean | undefined {
  const params = readRecord(notification.params);
  const value = params?.[field];
  return typeof value === "boolean" ? value : undefined;
}

function readNotificationThreadStatusType(
  notification: CodexServerNotification,
): "notLoaded" | "idle" | "systemError" | "active" | undefined {
  const params = readRecord(notification.params);
  const status = params ? readRecord(params.status) : undefined;
  const type = status?.type;
  switch (type) {
    case "notLoaded":
    case "idle":
    case "systemError":
    case "active":
      return type;
    default:
      return undefined;
  }
}

function readNotificationTurnId(notification: CodexServerNotification): TurnId | undefined {
  const turnId =
    readNotificationParamString(notification, "turnId") ??
    readNotificationNestedString(notification, "turn", "id");
  return turnId ? TurnId.make(turnId) : undefined;
}

function readNotificationItemId(notification: CodexServerNotification): ProviderItemId | undefined {
  const itemId =
    readNotificationParamString(notification, "itemId") ??
    readNotificationNestedString(notification, "item", "id");
  return itemId ? ProviderItemId.make(itemId) : undefined;
}

function readNotificationItemType(notification: CodexServerNotification): string | undefined {
  return (
    readNotificationNestedString(notification, "item", "type") ??
    readNotificationParamString(notification, "itemType")
  );
}

function readNotificationTurnStatus(notification: CodexServerNotification): string | undefined {
  return readNotificationNestedString(notification, "turn", "status");
}

function readNotificationErrorMessage(notification: CodexServerNotification): string | undefined {
  return (
    readNotificationNestedString(notification, "error", "message") ??
    readNotificationParamString(notification, "message")
  );
}

function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      ...updates,
      updatedAt,
    }));
  });
}

function parseThreadSnapshot(
  response: EffectCodexSchema.V2ThreadReadResponse | EffectCodexSchema.V2ThreadRollbackResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      items: turn.items,
    })),
  };
}

function timestampSecondsToIso(timestampSeconds: number | null | undefined): string | undefined {
  if (timestampSeconds === null || timestampSeconds === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
    return undefined;
  }
  return DateTime.formatIso(DateTime.makeUnsafe(timestampSeconds * 1_000));
}

function timestampSecondsToMillis(
  timestampSeconds: number | null | undefined,
  fallbackIso: string,
): number {
  if (timestampSeconds === null || timestampSeconds === undefined) {
    return DateTime.toEpochMillis(DateTime.makeUnsafe(fallbackIso));
  }
  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) {
    return DateTime.toEpochMillis(DateTime.makeUnsafe(fallbackIso));
  }
  return Math.trunc(timestampSeconds * 1_000);
}

export function codexElapsedDelayMilliseconds(delay: CodexElapsedDelayLabel): number {
  const match = /^(\d+) seconds$/.exec(delay);
  if (!match) {
    throw new Error(`Unsupported Codex elapsed delay label: ${delay}`);
  }
  return Number.parseInt(match[1]!, 10) * 1_000;
}

export function codexElapsedDelayRemainingMilliseconds(input: {
  readonly startedAtMs: number;
  readonly nowMs: number;
  readonly delay: CodexElapsedDelayLabel;
}): number {
  // The labels are elapsed checkpoints from the original turn/steer ACK, not
  // incremental sleeps. Upstream Codex treats app-server turn state as
  // authoritative and keeps waiting for `turn/completed`; Cafe mirrors that
  // model while polling `thread/read` at predictable elapsed times so a missed
  // terminal notification can be reconciled quickly without inventing one.
  return Math.max(0, input.startedAtMs + codexElapsedDelayMilliseconds(input.delay) - input.nowMs);
}

function snapshotEventId(parts: ReadonlyArray<string>): EventId {
  return EventId.make(["codex-snapshot", ...parts].join(":"));
}

function isBackfillableSnapshotItem(
  item: CodexSnapshotThreadItem,
): item is Extract<CodexSnapshotThreadItem, { readonly type: "agentMessage" | "plan" }> {
  switch (item.type) {
    case "agentMessage":
      return item.text.trim().length > 0;
    case "plan":
      return item.text.trim().length > 0;
    default:
      return false;
  }
}

function readCodexSnapshotThreadStatusType(
  status: CodexSnapshotThreadStatus | undefined,
): "notLoaded" | "idle" | "systemError" | "active" | undefined {
  return status?.type;
}

function normalizeCodexSnapshotTurnForThreadStatus(
  turn: CodexSnapshotTurn,
  threadStatusType: ReturnType<typeof readCodexSnapshotThreadStatusType>,
): CodexSnapshotTurn {
  if (
    turn.status !== "inProgress" ||
    threadStatusType === undefined ||
    threadStatusType === "active" ||
    threadStatusType === "idle" ||
    threadStatusType === "notLoaded"
  ) {
    return turn;
  }

  // Upstream Codex 0.142.0 keeps the `thread/read` status reconciliation from
  // `resolve_thread_status`: if a snapshot contains an in-progress turn while
  // the loaded watch status is `Idle` or `NotLoaded`, app-server resolves the
  // thread to `Active` instead of interrupting the turn. Preserve that shape
  // here so delayed snapshot backfill cannot falsely close a live turn. A real
  // `SystemError` snapshot still remains non-active and therefore terminalizes
  // an in-progress turn, matching upstream `set_thread_status_and_interrupt_stale_turns`.
  return {
    ...turn,
    status: "interrupted",
  };
}

function summarizeCodexSnapshotTurnItems(turn: CodexSnapshotTurn): {
  readonly agentMessageCount: number;
  readonly commandExecutionInProgressCount: number;
  readonly commandExecutionTerminalCount: number;
  readonly collabAgentInProgressCount: number;
  readonly dynamicToolInProgressCount: number;
  readonly mcpToolInProgressCount: number;
  readonly lastItemId: string | null;
  readonly lastItemStatus: string | null;
  readonly lastItemType: string | null;
} {
  let agentMessageCount = 0;
  let commandExecutionInProgressCount = 0;
  let commandExecutionTerminalCount = 0;
  let collabAgentInProgressCount = 0;
  let dynamicToolInProgressCount = 0;
  let mcpToolInProgressCount = 0;

  for (const item of turn.items) {
    switch (item.type) {
      case "agentMessage":
        agentMessageCount += item.text.trim().length > 0 ? 1 : 0;
        break;
      case "commandExecution":
        if (item.status === "inProgress") {
          commandExecutionInProgressCount += 1;
        } else {
          commandExecutionTerminalCount += 1;
        }
        break;
      case "collabAgentToolCall":
        collabAgentInProgressCount += item.status === "inProgress" ? 1 : 0;
        break;
      case "dynamicToolCall":
        dynamicToolInProgressCount += item.status === "inProgress" ? 1 : 0;
        break;
      case "mcpToolCall":
        mcpToolInProgressCount += item.status === "inProgress" ? 1 : 0;
        break;
      default:
        break;
    }
  }

  const lastItem = turn.items.at(-1);
  const lastItemStatus =
    lastItem && "status" in lastItem && typeof lastItem.status === "string"
      ? lastItem.status
      : null;

  return {
    agentMessageCount,
    commandExecutionInProgressCount,
    commandExecutionTerminalCount,
    collabAgentInProgressCount,
    dynamicToolInProgressCount,
    mcpToolInProgressCount,
    lastItemId: lastItem?.id ?? null,
    lastItemStatus,
    lastItemType: lastItem?.type ?? null,
  };
}

export function selectCodexActiveSnapshotTurn(
  providerThread: CodexSnapshotThread,
): CodexSnapshotTurn | undefined {
  const latestInProgressTurn = providerThread.turns.findLast(
    (turn) => turn.status === "inProgress",
  );
  if (latestInProgressTurn) {
    return latestInProgressTurn;
  }

  // Upstream `thread/resume` and `thread/read` expose the provider's
  // authoritative thread status separately from the per-turn snapshots. If the
  // thread is not active, Cafe must not keep or restore an active turn id from
  // stale projection state.
  if (readCodexSnapshotThreadStatusType(providerThread.status) !== "active") {
    return undefined;
  }
  return undefined;
}

function selectSnapshotTurns(input: {
  readonly turns: ReadonlyArray<CodexSnapshotTurn>;
  readonly focusTurnId?: TurnId;
  readonly turnLimit: number;
}): ReadonlyArray<CodexSnapshotTurn> {
  if (input.focusTurnId) {
    return input.turns.filter((turn) => turn.id === input.focusTurnId);
  }

  if (input.turns.length <= input.turnLimit) {
    return input.turns;
  }

  return input.turns.slice(-input.turnLimit);
}

function providerEventBase(input: {
  readonly id: EventId;
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly createdAt: string;
  readonly method: string;
  readonly turnId?: TurnId;
  readonly itemId?: ProviderItemId;
  readonly payload: unknown;
}): ProviderEvent {
  return {
    id: input.id,
    kind: "notification",
    provider: PROVIDER,
    ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
    threadId: input.threadId,
    createdAt: input.createdAt,
    method: input.method,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: input.itemId } : {}),
    payload: input.payload,
  };
}

export function buildCodexThreadSnapshotBackfillEvents(input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerThread: CodexSnapshotThread;
  readonly createdAt: string;
  readonly reason: CodexSnapshotBackfillReason;
  readonly focusTurnId?: TurnId;
  readonly turnLimit?: number;
}): ReadonlyArray<ProviderEvent> {
  const selectedTurns = selectSnapshotTurns({
    turns: input.providerThread.turns,
    ...(input.focusTurnId ? { focusTurnId: input.focusTurnId } : {}),
    turnLimit: input.turnLimit ?? CODEX_SNAPSHOT_BACKFILL_TURN_LIMIT,
  });
  const events: ProviderEvent[] = [];
  const threadStatusType = readCodexSnapshotThreadStatusType(input.providerThread.status);

  for (const snapshotTurn of selectedTurns) {
    const turn = normalizeCodexSnapshotTurnForThreadStatus(snapshotTurn, threadStatusType);
    const turnId = TurnId.make(turn.id);
    const startedAt = timestampSecondsToIso(turn.startedAt) ?? input.createdAt;
    const completedAt = timestampSecondsToIso(turn.completedAt) ?? input.createdAt;
    events.push(
      providerEventBase({
        id: snapshotEventId([input.reason, input.providerThread.id, turn.id, "turn-started"]),
        threadId: input.threadId,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        createdAt: startedAt,
        method: "turn/started",
        turnId,
        payload: {
          threadId: input.providerThread.id,
          turn,
        } satisfies EffectCodexSchema.V2TurnStartedNotification,
      }),
    );

    for (const item of turn.items) {
      if (!isBackfillableSnapshotItem(item)) {
        continue;
      }
      const itemId = ProviderItemId.make(item.id);
      events.push(
        providerEventBase({
          id: snapshotEventId([
            input.reason,
            input.providerThread.id,
            turn.id,
            item.id,
            "item-completed",
          ]),
          threadId: input.threadId,
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          createdAt: completedAt,
          method: "item/completed",
          turnId,
          itemId,
          payload: {
            completedAtMs: timestampSecondsToMillis(turn.completedAt, completedAt),
            threadId: input.providerThread.id,
            turnId: turn.id,
            item,
          } satisfies EffectCodexSchema.V2ItemCompletedNotification,
        }),
      );
    }

    if (turn.status !== "inProgress") {
      events.push(
        providerEventBase({
          id: snapshotEventId([input.reason, input.providerThread.id, turn.id, "turn-completed"]),
          threadId: input.threadId,
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          createdAt: completedAt,
          method: "turn/completed",
          turnId,
          payload: {
            threadId: input.providerThread.id,
            turn,
          } satisfies EffectCodexSchema.V2TurnCompletedNotification,
        }),
      );
    }
  }

  return events;
}

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const pendingApprovalsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingApproval>());
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputsRef = yield* Ref.make(new Map<ApprovalRequestId, PendingUserInput>());
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const closedRef = yield* Ref.make(false);
    const snapshotBackfillEventIdsRef = yield* Ref.make(new Set<string>());
    const turnStartObservationsRef = yield* Ref.make(new Map<string, CodexTurnStartObservation>());
    const activeContextCompactionsRef = yield* Ref.make(
      new Map<string, CodexActiveContextCompaction>(),
    );
    const pendingSteerProcessingRef = yield* Ref.make(
      new Map<string, CodexPendingSteerProcessing>(),
    );

    // `~` is not shell-expanded when env vars are set via
    // `child_process.spawn`; `expandHomePath` lets a configured
    // `CODEX_HOME=~/.codex_work` reach codex as an absolute path.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...(options.environment ?? process.env),
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const appServerArgs = buildCodexAppServerArgs(options.transportPolicy);
    const appServerCwd = options.appServerCwd ?? process.cwd();
    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.binaryPath, appServerArgs, {
          // Codex app-server resolves absolute request cwd values through
          // `std::env::current_dir()` as of 0.142. Running the app-server
          // process from a project directory that macOS later denies can make
          // every `turn/start` fail with `invalid cwd: Operation not
          // permitted` before Codex even sees the protocol cwd. Keep the
          // process cwd on Cafe's own backend-owned directory and pass the real
          // project cwd through `thread/start`/`turn/start` plus local
          // environment selections, matching the TUI's protocol-level cwd
          // ownership without depending on process cwd.
          cwd: appServerCwd,
          env,
          forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
          shell: process.platform === "win32",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} ${appServerArgs.join(" ")}`,
              cause,
            }),
        ),
      );

    const clientContext = yield* CodexClient.layerChildProcess(child, {
      logger: (event) =>
        Effect.logWarning("codex.app-server.protocol.diagnostic", {
          threadId: options.threadId,
          providerInstanceId: options.providerInstanceId ?? PROVIDER,
          direction: event.direction,
          stage: event.stage,
          payload: event.payload,
        }),
    }).pipe(Layer.build, Effect.provideService(Scope.Scope, runtimeScope));
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    const serverNotifications = yield* Queue.unbounded<CodexServerNotification>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const sessionCreatedAt = yield* nowIso;
    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.additionalDirectories !== undefined
        ? { additionalDirectories: options.additionalDirectories }
        : {}),
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt,
    } satisfies ProviderSession;
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.gen(function* () {
        const id = yield* Random.nextUUIDv4;
        return yield* offerEvent({
          id: EventId.make(id),
          provider: PROVIDER,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          createdAt: yield* nowIso,
          ...event,
        });
      });
    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });
    const appServerPid = (() => {
      const pid = Number(child.pid);
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    })();
    const readCodexAppServerChildProcessDiagnostics =
      (): Effect.Effect<CodexAppServerChildProcessDiagnostics> =>
        Effect.gen(function* () {
          if (appServerPid === undefined) {
            return {
              status: "unavailable",
              error: "Codex app-server PID is unavailable.",
            } satisfies CodexAppServerChildProcessDiagnostics;
          }

          const rows = yield* readProcessRows().pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          return summarizeCodexAppServerChildProcesses({
            rows,
            appServerPid,
            diagnosticsRootPid: process.pid,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({
              status: "unavailable",
              ...(appServerPid === undefined ? {} : { appServerPid }),
              error: sanitizeProcessCommand(Cause.pretty(cause), { maxLength: 360 }),
            } satisfies CodexAppServerChildProcessDiagnostics),
          ),
        );

    const recordTurnStartObservation = (observation: CodexTurnStartObservation) =>
      Ref.update(turnStartObservationsRef, (current) => {
        const next = new Map(current);
        next.set(turnObservationKey(observation.turnId), observation);
        while (next.size > 50) {
          const oldestKey = next.keys().next().value;
          if (oldestKey === undefined) {
            break;
          }
          next.delete(oldestKey);
        }
        return next;
      });

    const updateTurnStartObservation = (
      turnId: TurnId,
      update: (observation: CodexTurnStartObservation) => CodexTurnStartObservation,
    ) =>
      Ref.update(turnStartObservationsRef, (current) => {
        const key = turnObservationKey(turnId);
        const existing = current.get(key);
        if (!existing) {
          return current;
        }
        const next = new Map(current);
        next.set(key, update(existing));
        return next;
      });

    const readTurnStartObservation = (turnId: TurnId) =>
      Ref.get(turnStartObservationsRef).pipe(
        Effect.map((observations) => observations.get(turnObservationKey(turnId))),
      );

    const markTurnStartBackfillAttempt = (turnId: TurnId) =>
      Ref.modify(turnStartObservationsRef, (current) => {
        const key = turnObservationKey(turnId);
        const existing = current.get(key);
        if (!existing) {
          return [undefined, current] as const;
        }
        const nextObservation = {
          ...existing,
          backfillAttemptCount: existing.backfillAttemptCount + 1,
        };
        const next = new Map(current);
        next.set(key, nextObservation);
        return [nextObservation, next] as const;
      });

    const markTurnStartBackfillResult = (input: {
      readonly turnId: TurnId;
      readonly observedAt: string;
      readonly threadStatusType: "notLoaded" | "idle" | "systemError" | "active" | undefined;
      readonly turn: CodexSnapshotTurn | null;
    }) =>
      updateTurnStartObservation(input.turnId, (observation) => ({
        ...observation,
        lastBackfillAt: input.observedAt,
        lastBackfillThreadStatus: input.threadStatusType,
        lastBackfillTurnFound: input.turn !== null,
        lastBackfillTurnStatus: input.turn?.status,
        lastBackfillItemCount: input.turn?.items.length,
        lastBackfillItemsView: input.turn?.itemsView ?? null,
      }));

    const markTurnStartNotification = (
      notification: CodexServerNotification,
      routeTurnId: TurnId | undefined,
    ) =>
      Effect.gen(function* () {
        const session = yield* Ref.get(sessionRef);
        const activeTurnId = routeTurnId ?? session.activeTurnId;
        if (!activeTurnId) {
          return;
        }

        const observedAt = yield* nowIso;
        const method = notification.method;
        const isTurnEvent =
          routeTurnId !== undefined ||
          method === "turn/started" ||
          method === "turn/completed" ||
          method === "turn/plan/updated" ||
          method === "turn/diff/updated";

        yield* updateTurnStartObservation(activeTurnId, (observation) => ({
          ...observation,
          firstNotificationAt: observation.firstNotificationAt ?? observedAt,
          firstNotificationMethod: observation.firstNotificationMethod ?? method,
          ...(isTurnEvent
            ? {
                firstTurnEventAt: observation.firstTurnEventAt ?? observedAt,
                firstTurnEventMethod: observation.firstTurnEventMethod ?? method,
              }
            : {}),
          lastNotificationAt: observedAt,
          lastNotificationMethod: method,
        }));
      });

    const markTurnStartNoTurnEventWarning = (turnId: TurnId) =>
      Ref.modify(turnStartObservationsRef, (current) => {
        const key = turnObservationKey(turnId);
        const existing = current.get(key);
        if (!existing || existing.firstTurnEventAt !== undefined) {
          return [undefined, current] as const;
        }
        const nextObservation = {
          ...existing,
          noTurnEventWarningCount: existing.noTurnEventWarningCount + 1,
        };
        const next = new Map(current);
        next.set(key, nextObservation);
        return [nextObservation, next] as const;
      });

    const emitTurnStartNoRuntimeEventWarning = (input: {
      readonly providerThreadId: string;
      readonly turnId: TurnId;
      readonly delay: (typeof CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS)[number];
    }) =>
      Effect.gen(function* () {
        const observation = yield* markTurnStartNoTurnEventWarning(input.turnId);
        if (!observation) {
          return;
        }

        yield* Effect.logWarning("codex.turnStart.noRuntimeEventYet", {
          threadId: options.threadId,
          providerInstanceId: options.providerInstanceId ?? PROVIDER,
          providerThreadId: input.providerThreadId,
          turnId: input.turnId,
          elapsedDelay: input.delay,
          acknowledgedAt: observation.acknowledgedAt,
          ackLatencyMs: observation.ackLatencyMs,
          firstNotificationMethod: observation.firstNotificationMethod ?? null,
          firstTurnEventMethod: observation.firstTurnEventMethod ?? null,
          lastNotificationMethod: observation.lastNotificationMethod ?? null,
          backfillAttemptCount: observation.backfillAttemptCount,
        });
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: "codex.turnStart/noRuntimeEventYet",
          turnId: input.turnId,
          message: "Codex app-server accepted turn/start but has not emitted a turn event yet.",
          payload: {
            providerThreadId: input.providerThreadId,
            turnId: input.turnId,
            elapsedDelay: input.delay,
            requestedAt: observation.requestedAt,
            acknowledgedAt: observation.acknowledgedAt,
            ackLatencyMs: observation.ackLatencyMs,
            promptByteLength: observation.promptByteLength,
            attachmentCount: observation.attachmentCount,
            model: observation.model ?? null,
            effort: observation.effort ?? null,
            interactionMode: observation.interactionMode ?? null,
            serviceTier: observation.serviceTier ?? null,
            additionalDirectoryCount: observation.additionalDirectoryCount,
            firstNotificationAt: observation.firstNotificationAt ?? null,
            firstNotificationMethod: observation.firstNotificationMethod ?? null,
            firstTurnEventAt: observation.firstTurnEventAt ?? null,
            firstTurnEventMethod: observation.firstTurnEventMethod ?? null,
            lastNotificationAt: observation.lastNotificationAt ?? null,
            lastNotificationMethod: observation.lastNotificationMethod ?? null,
            backfillAttemptCount: observation.backfillAttemptCount,
            noTurnEventWarningCount: observation.noTurnEventWarningCount,
            lastBackfillAt: observation.lastBackfillAt ?? null,
            lastBackfillThreadStatus: observation.lastBackfillThreadStatus ?? null,
            lastBackfillTurnFound: observation.lastBackfillTurnFound ?? null,
            lastBackfillTurnStatus: observation.lastBackfillTurnStatus ?? null,
            lastBackfillItemCount: observation.lastBackfillItemCount ?? null,
            lastBackfillItemsView: observation.lastBackfillItemsView ?? null,
            semantics:
              "turn/start is an acknowledgement; turn/started must arrive later from the app-server listener.",
          },
        });
      });

    const recordPendingSteerProcessing = (pending: CodexPendingSteerProcessing) =>
      Ref.update(pendingSteerProcessingRef, (current) => {
        const next = new Map(current);
        next.set(pending.steerId, pending);
        return prunePendingSteerProcessing(next);
      });

    const markPendingSteerProcessingWarning = (
      steerId: string,
      elapsedDelay: (typeof CODEX_TURN_STEER_PROCESSING_WARNING_DELAYS)[number],
    ) =>
      Ref.modify(pendingSteerProcessingRef, (current) => {
        const pending = current.get(steerId);
        if (!pending || pending.processedAt !== undefined) {
          return [undefined, current] as const;
        }
        const updated = {
          ...pending,
          warningCount: pending.warningCount + 1,
        } satisfies CodexPendingSteerProcessing;
        const next = new Map(current);
        next.set(steerId, updated);
        return [{ pending: updated, elapsedDelay }, next] as const;
      });

    const emitPendingSteerNoProviderItemWarning = (input: {
      readonly pending: CodexPendingSteerProcessing;
      readonly elapsedDelay: (typeof CODEX_TURN_STEER_PROCESSING_WARNING_DELAYS)[number];
    }) =>
      Effect.gen(function* () {
        const childProcesses = yield* readCodexAppServerChildProcessDiagnostics();
        const activeChildProcessCount = codexActiveChildProcessCount(childProcesses);
        const message =
          activeChildProcessCount > 0
            ? `Codex accepted turn/steer; it is queued until the active turn finishes current child-process work (${activeChildProcessCount} live descendant process${activeChildProcessCount === 1 ? "" : "es"}).`
            : "Codex app-server accepted turn/steer but has not emitted the steer user message yet.";
        yield* Effect.logWarning("codex.turnSteer.noProviderItemYet", {
          threadId: options.threadId,
          providerInstanceId: options.providerInstanceId ?? PROVIDER,
          steerId: input.pending.steerId,
          providerThreadId: input.pending.providerThreadId,
          turnId: input.pending.turnId,
          elapsedDelay: input.elapsedDelay,
          acknowledgedAt: input.pending.acknowledgedAt,
          ackLatencyMs: input.pending.ackLatencyMs,
          promptByteLength: input.pending.promptByteLength,
          attachmentCount: input.pending.attachmentCount,
          warningCount: input.pending.warningCount,
          appServerChildProcesses: childProcesses,
        });
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: "codex.turnSteer/noProviderItemYet",
          turnId: input.pending.turnId,
          message,
          payload: {
            steerId: input.pending.steerId,
            providerThreadId: input.pending.providerThreadId,
            turnId: input.pending.turnId,
            elapsedDelay: input.elapsedDelay,
            requestedAt: input.pending.requestedAt,
            acknowledgedAt: input.pending.acknowledgedAt,
            ackLatencyMs: input.pending.ackLatencyMs,
            promptByteLength: input.pending.promptByteLength,
            attachmentCount: input.pending.attachmentCount,
            warningCount: input.pending.warningCount,
            appServerChildProcesses: childProcesses,
            semantics:
              "Upstream Codex 0.142.0 stores turn/steer input in the active turn queue and emits the injected userMessage only when the turn loop drains pending input. Cafe has delivered the steer; only child processes classified as active count as turn work. Persistent Codex helper/MCP processes are reported as support processes and do not explain a delayed steer.",
          },
        });
      });

    const schedulePendingSteerProcessingWarnings = (steerId: string) =>
      Effect.gen(function* () {
        const scheduledAtMs = yield* Clock.currentTimeMillis;
        for (const delay of CODEX_TURN_STEER_PROCESSING_WARNING_DELAYS) {
          const sleepMs = codexElapsedDelayRemainingMilliseconds({
            startedAtMs: scheduledAtMs,
            nowMs: yield* Clock.currentTimeMillis,
            delay,
          });
          if (sleepMs > 0) {
            yield* Effect.sleep(Duration.millis(sleepMs));
          }
          if (yield* Ref.get(closedRef)) {
            return;
          }
          const warning = yield* markPendingSteerProcessingWarning(steerId, delay);
          if (warning) {
            yield* emitPendingSteerNoProviderItemWarning(warning);
          }
        }
      }).pipe(Effect.forkIn(runtimeScope), Effect.asVoid);

    const markPendingSteerProcessingFromNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        if (!(yield* notificationBelongsToCurrentSession(notification))) {
          return;
        }

        const observedAt = yield* nowIso;
        const observedAtMs = yield* Clock.currentTimeMillis;
        const processed = yield* Ref.modify(pendingSteerProcessingRef, (current) => {
          const result = updateCodexPendingSteerProcessingFromNotification(current, {
            method: notification.method,
            providerThreadId: readNotificationThreadId(notification),
            turnId: readNotificationTurnId(notification),
            itemId: readNotificationItemId(notification),
            itemType: readNotificationItemType(notification),
            observedAt,
            observedAtMs,
          });
          return [result.pending, result.next] as const;
        });
        if (!processed) {
          return;
        }

        yield* Effect.logInfo("codex.turnSteer.processingStarted", {
          threadId: options.threadId,
          providerInstanceId: options.providerInstanceId ?? PROVIDER,
          steerId: processed.steerId,
          providerThreadId: processed.providerThreadId,
          turnId: processed.turnId,
          providerUserMessageItemId: processed.providerUserMessageItemId ?? null,
          providerUserMessageMethod: processed.providerUserMessageMethod ?? null,
          ackToProviderItemMs: processed.ackToProviderItemMs ?? null,
          warningCount: processed.warningCount,
        });
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: "codex.turnSteer/processingStarted",
          turnId: processed.turnId,
          ...(processed.providerUserMessageItemId
            ? { itemId: processed.providerUserMessageItemId }
            : {}),
          message: "Codex app-server began processing turn/steer.",
          payload: {
            steerId: processed.steerId,
            providerThreadId: processed.providerThreadId,
            turnId: processed.turnId,
            providerUserMessageItemId: processed.providerUserMessageItemId ?? null,
            providerUserMessageMethod: processed.providerUserMessageMethod ?? null,
            requestedAt: processed.requestedAt,
            acknowledgedAt: processed.acknowledgedAt,
            processedAt: processed.processedAt ?? null,
            ackLatencyMs: processed.ackLatencyMs,
            ackToProviderItemMs: processed.ackToProviderItemMs ?? null,
            promptByteLength: processed.promptByteLength,
            attachmentCount: processed.attachmentCount,
            warningCount: processed.warningCount,
            semantics:
              "Codex emitted the userMessage item for an accepted turn/steer. This is the first provider-side proof that the appended steer has entered the active turn item stream.",
          },
        });
      });
    const emitSnapshotBackfillEvents = (input: {
      readonly providerThread: CodexSnapshotThread;
      readonly reason: CodexSnapshotBackfillReason;
      readonly focusTurnId?: TurnId;
    }) =>
      Effect.gen(function* () {
        const builtEvents = buildCodexThreadSnapshotBackfillEvents({
          threadId: options.threadId,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          providerThread: input.providerThread,
          createdAt: yield* nowIso,
          reason: input.reason,
          ...(input.focusTurnId ? { focusTurnId: input.focusTurnId } : {}),
        });
        if (builtEvents.length === 0) {
          return;
        }

        const seenIds = yield* Ref.get(snapshotBackfillEventIdsRef);
        const unseenEvents = builtEvents.filter((event) => !seenIds.has(event.id));
        if (unseenEvents.length === 0) {
          return;
        }
        yield* Ref.update(snapshotBackfillEventIdsRef, (current) => {
          const next = new Set(current);
          for (const event of unseenEvents) {
            next.add(event.id);
          }
          return next;
        });
        yield* Effect.logInfo("codex.snapshot.backfill.emitted", {
          threadId: options.threadId,
          providerThreadId: input.providerThread.id,
          reason: input.reason,
          focusTurnId: input.focusTurnId,
          eventCount: unseenEvents.length,
        });
        yield* Queue.offerAll(events, unseenEvents).pipe(Effect.asVoid);
      });

    const readAndBackfillSnapshot = (input: {
      readonly providerThreadId: string;
      readonly focusTurnId: TurnId;
      readonly reason: CodexSnapshotBackfillReason;
    }) =>
      Effect.logInfo("codex.snapshot.backfill.read-attempt", {
        threadId: options.threadId,
        providerThreadId: input.providerThreadId,
        focusTurnId: input.focusTurnId,
        reason: input.reason,
        timeout: CODEX_SEND_TURN_SNAPSHOT_BACKFILL_READ_TIMEOUT,
      }).pipe(
        Effect.andThen(
          client
            .request("thread/read", {
              threadId: input.providerThreadId,
              includeTurns: true,
            })
            .pipe(Effect.timeoutOption(CODEX_SEND_TURN_SNAPSHOT_BACKFILL_READ_TIMEOUT)),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              nowIso.pipe(
                Effect.flatMap((observedAt) =>
                  markTurnStartBackfillResult({
                    turnId: input.focusTurnId,
                    observedAt,
                    threadStatusType: undefined,
                    turn: null,
                  }),
                ),
                Effect.andThen(
                  Effect.logWarning("codex.snapshot.backfill.read-timeout", {
                    threadId: options.threadId,
                    providerThreadId: input.providerThreadId,
                    focusTurnId: input.focusTurnId,
                    timeout: CODEX_SEND_TURN_SNAPSHOT_BACKFILL_READ_TIMEOUT,
                  }),
                ),
                Effect.as(null),
              ),
            onSome: (response) => {
              const turn = response.thread.turns.find((entry) => entry.id === input.focusTurnId);
              const threadStatusType = readCodexSnapshotThreadStatusType(response.thread.status);
              const normalizedTurn = turn
                ? normalizeCodexSnapshotTurnForThreadStatus(turn, threadStatusType)
                : null;
              return nowIso.pipe(
                Effect.flatMap((observedAt) =>
                  markTurnStartBackfillResult({
                    turnId: input.focusTurnId,
                    observedAt,
                    threadStatusType,
                    turn: normalizedTurn,
                  }),
                ),
                Effect.andThen(
                  emitSnapshotBackfillEvents({
                    providerThread: response.thread,
                    reason: input.reason,
                    focusTurnId: input.focusTurnId,
                  }),
                ),
                Effect.andThen(
                  Effect.logInfo("codex.snapshot.backfill.read-result", {
                    threadId: options.threadId,
                    providerThreadId: input.providerThreadId,
                    focusTurnId: input.focusTurnId,
                    reason: input.reason,
                    turnFound: turn !== undefined,
                    turnStatus: turn?.status ?? null,
                    normalizedTurnStatus: normalizedTurn?.status ?? null,
                    threadStatus: threadStatusType ?? null,
                    itemCount: turn?.items.length ?? 0,
                    itemsView: turn?.itemsView ?? null,
                  }),
                ),
                Effect.as({
                  threadStatusType,
                  turn: normalizedTurn,
                } satisfies CodexSnapshotReadResult),
              );
            },
          }),
        ),
        Effect.catch((cause) =>
          nowIso.pipe(
            Effect.flatMap((observedAt) =>
              markTurnStartBackfillResult({
                turnId: input.focusTurnId,
                observedAt,
                threadStatusType: undefined,
                turn: null,
              }),
            ),
            Effect.andThen(
              Effect.logWarning("codex.snapshot.backfill.read-failed", {
                threadId: options.threadId,
                providerThreadId: input.providerThreadId,
                focusTurnId: input.focusTurnId,
                reason: input.reason,
                cause: cause.message,
              }),
            ),
            Effect.as(null),
          ),
        ),
      );

    const reconcileTerminalActiveTurnSnapshot = (input: {
      readonly providerThreadId: string;
      readonly turnId: TurnId;
      readonly reason: CodexSnapshotBackfillReason;
      readonly threadStatusType: "notLoaded" | "idle" | "systemError" | "active" | null;
      readonly turn: CodexSnapshotTurn;
    }) =>
      Effect.gen(function* () {
        if (input.turn.status === "inProgress") {
          return;
        }

        const session = yield* Ref.get(sessionRef);
        if (session.activeTurnId !== input.turnId) {
          return;
        }

        const observedAt = yield* nowIso;
        yield* updateSession(sessionRef, {
          status: input.turn.status === "failed" ? "error" : "ready",
          activeTurnId: undefined,
          ...(input.turn.status === "failed" && input.turn.error?.message
            ? { lastError: input.turn.error.message }
            : {}),
        });
        yield* Effect.logInfo("codex.turnProgress.reconciledFromThreadRead", {
          threadId: options.threadId,
          providerInstanceId: options.providerInstanceId ?? PROVIDER,
          providerThreadId: input.providerThreadId,
          turnId: input.turnId,
          reason: input.reason,
          threadStatus: input.threadStatusType,
          turnStatus: input.turn.status,
          itemCount: input.turn.items.length,
          itemsView: input.turn.itemsView ?? null,
        });
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: "codex.turnProgress/reconciledFromThreadRead",
          turnId: input.turnId,
          message:
            "Codex thread/read reported a terminal active turn; Cafe Code reconciled the session.",
          payload: {
            providerThreadId: input.providerThreadId,
            turnId: input.turnId,
            reason: input.reason,
            threadStatus: input.threadStatusType,
            turnStatus: input.turn.status,
            itemCount: input.turn.items.length,
            itemsView: input.turn.itemsView ?? null,
            observedAt,
            semantics:
              "Official Codex app-server docs make turn/completed terminal, and thread/read returns authoritative turn statuses. Cafe only clears an active turn from thread-status reconciliation after thread/read reports that same turn as terminal.",
          },
        });
      });

    const reconcileActiveTurnFromThreadRead = (input: {
      readonly providerThreadId: string;
      readonly turnId: TurnId;
      readonly reason: "session-resume-active-turn" | "thread-status-idle-reconciliation";
    }) =>
      Effect.logInfo("codex.turnProgress.reconciliation.read-attempt", {
        threadId: options.threadId,
        providerThreadId: input.providerThreadId,
        turnId: input.turnId,
        reason: input.reason,
        timeout: CODEX_SEND_TURN_SNAPSHOT_BACKFILL_READ_TIMEOUT,
      }).pipe(
        Effect.andThen(
          client
            .request("thread/read", {
              threadId: input.providerThreadId,
              includeTurns: true,
            })
            .pipe(Effect.timeoutOption(CODEX_SEND_TURN_SNAPSHOT_BACKFILL_READ_TIMEOUT)),
        ),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.logWarning("codex.turnProgress.reconciliation.read-timeout", {
                threadId: options.threadId,
                providerInstanceId: options.providerInstanceId ?? PROVIDER,
                providerThreadId: input.providerThreadId,
                turnId: input.turnId,
                reason: input.reason,
                timeout: CODEX_SEND_TURN_SNAPSHOT_BACKFILL_READ_TIMEOUT,
              }),
            onSome: (response) =>
              Effect.gen(function* () {
                const turn = response.thread.turns.find((entry) => entry.id === input.turnId);
                const threadStatusType = readCodexSnapshotThreadStatusType(response.thread.status);
                yield* emitSnapshotBackfillEvents({
                  providerThread: response.thread,
                  reason: input.reason,
                  focusTurnId: input.turnId,
                });

                yield* Effect.logInfo("codex.turnProgress.reconciliation.read-result", {
                  threadId: options.threadId,
                  providerInstanceId: options.providerInstanceId ?? PROVIDER,
                  providerThreadId: input.providerThreadId,
                  turnId: input.turnId,
                  reason: input.reason,
                  threadStatus: threadStatusType ?? null,
                  turnFound: turn !== undefined,
                  turnStatus: turn?.status ?? null,
                  itemCount: turn?.items.length ?? 0,
                  itemsView: turn?.itemsView ?? null,
                });

                if (!turn || turn.status === "inProgress") {
                  return;
                }

                yield* reconcileTerminalActiveTurnSnapshot({
                  providerThreadId: input.providerThreadId,
                  turnId: input.turnId,
                  reason: input.reason,
                  threadStatusType: threadStatusType ?? null,
                  turn,
                });
              }),
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("codex.turnProgress.reconciliation.read-failed", {
            threadId: options.threadId,
            providerInstanceId: options.providerInstanceId ?? PROVIDER,
            providerThreadId: input.providerThreadId,
            turnId: input.turnId,
            reason: input.reason,
            cause: Cause.pretty(cause),
          }),
        ),
      );

    const emitTurnSnapshotStillInProgressWarning = (input: {
      readonly providerThreadId: string;
      readonly turnId: TurnId;
      readonly reason: CodexSnapshotBackfillReason;
      readonly elapsedDelay: (typeof CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS)[number];
      readonly threadStatusType?: "notLoaded" | "idle" | "systemError" | "active" | undefined;
      readonly turn: CodexSnapshotTurn;
    }) =>
      Effect.gen(function* () {
        const itemSummary = summarizeCodexSnapshotTurnItems(input.turn);
        const childProcesses = yield* readCodexAppServerChildProcessDiagnostics();
        const activeChildProcessCount = codexActiveChildProcessCount(childProcesses);
        const message =
          activeChildProcessCount > 0
            ? `Codex still reports the active turn as in progress; app-server has ${activeChildProcessCount} live descendant process${activeChildProcessCount === 1 ? "" : "es"} still running.`
            : "Codex still reports the active turn as in progress after delayed snapshot polling.";
        yield* Effect.logWarning("codex.turnProgress.stillInProgressAfterSnapshotPolling", {
          threadId: options.threadId,
          providerInstanceId: options.providerInstanceId ?? PROVIDER,
          providerThreadId: input.providerThreadId,
          turnId: input.turnId,
          reason: input.reason,
          elapsedDelay: input.elapsedDelay,
          threadStatus: input.threadStatusType ?? null,
          itemCount: input.turn.items.length,
          itemsView: input.turn.itemsView ?? null,
          itemSummary,
          appServerChildProcesses: childProcesses,
        });
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: "codex.turnProgress/stillInProgressAfterSnapshotPolling",
          turnId: input.turnId,
          message,
          payload: {
            providerThreadId: input.providerThreadId,
            turnId: input.turnId,
            reason: input.reason,
            elapsedDelay: input.elapsedDelay,
            threadStatus: input.threadStatusType ?? null,
            itemCount: input.turn.items.length,
            itemsView: input.turn.itemsView ?? null,
            itemSummary,
            appServerChildProcesses: childProcesses,
            semantics:
              "Cafe follows upstream Codex app-server lifecycle semantics: turn/completed or a terminal thread/read turn closes the turn. In Codex 0.142.0, thread/read snapshots that contain an in-progress turn keep the thread effectively active even if the loaded watch status is idle or notLoaded; Cafe only terminalizes an in-progress snapshot when upstream reports a non-active terminal status such as systemError. Only child processes classified as active count as turn work; persistent Codex helper/MCP processes are reported as support processes and do not explain a delayed terminal event.",
          },
        });
      });

    const scheduleSendTurnSnapshotBackfill = (input: {
      readonly providerThreadId: string;
      readonly turnId: TurnId;
      readonly reason: CodexSnapshotBackfillReason;
    }) =>
      Effect.gen(function* () {
        const scheduledAtMs = yield* Clock.currentTimeMillis;
        for (const delay of CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS) {
          const sleepMs = codexElapsedDelayRemainingMilliseconds({
            startedAtMs: scheduledAtMs,
            nowMs: yield* Clock.currentTimeMillis,
            delay,
          });
          if (sleepMs > 0) {
            yield* Effect.sleep(Duration.millis(sleepMs));
          }
          if (yield* Ref.get(closedRef)) {
            return;
          }

          const session = yield* Ref.get(sessionRef);
          if (session.activeTurnId !== input.turnId || session.status !== "running") {
            return;
          }

          const observation = yield* readTurnStartObservation(input.turnId);
          if (!observation?.firstTurnEventAt) {
            yield* emitTurnStartNoRuntimeEventWarning({
              providerThreadId: input.providerThreadId,
              turnId: input.turnId,
              delay,
            });
          }
          yield* markTurnStartBackfillAttempt(input.turnId);
          const snapshot = yield* readAndBackfillSnapshot({
            providerThreadId: input.providerThreadId,
            focusTurnId: input.turnId,
            reason: input.reason,
          });
          const turn = snapshot?.turn ?? null;
          if (turn && turn.status !== "inProgress") {
            yield* reconcileTerminalActiveTurnSnapshot({
              providerThreadId: input.providerThreadId,
              turnId: input.turnId,
              reason: input.reason,
              threadStatusType: snapshot?.threadStatusType ?? null,
              turn,
            });
            return;
          }
          if (
            turn?.status === "inProgress" &&
            CODEX_SEND_TURN_STILL_IN_PROGRESS_WARNING_DELAYS.has(delay)
          ) {
            yield* emitTurnSnapshotStillInProgressWarning({
              providerThreadId: input.providerThreadId,
              turnId: input.turnId,
              reason: input.reason,
              elapsedDelay: delay,
              threadStatusType: snapshot?.threadStatusType,
              turn,
            });
          }
        }
      }).pipe(Effect.forkIn(runtimeScope), Effect.asVoid);

    const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
      Ref.get(pendingApprovalsRef).pipe(
        Effect.flatMap((pendingApprovals) =>
          Effect.forEach(
            Array.from(pendingApprovals.values()),
            (pendingApproval) =>
              Deferred.succeed(pendingApproval.decision, decision).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
      Ref.get(pendingUserInputsRef).pipe(
        Effect.flatMap((pendingUserInputs) =>
          Effect.forEach(
            Array.from(pendingUserInputs.values()),
            (pendingUserInput) =>
              Deferred.succeed(pendingUserInput.answers, answers).pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const currentSessionProviderThreadId = Effect.map(Ref.get(sessionRef), currentProviderThreadId);

    const notificationBelongsToCurrentSession = (notification: CodexServerNotification) =>
      currentSessionProviderThreadId.pipe(
        Effect.map((providerThreadId) => {
          const notificationThreadId = readNotificationThreadId(notification);
          return (
            !providerThreadId || !notificationThreadId || notificationThreadId === providerThreadId
          );
        }),
      );

    const reconcileRawNotificationSessionState = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        if (!(yield* notificationBelongsToCurrentSession(notification))) {
          return;
        }

        switch (notification.method) {
          case "thread/started": {
            const providerThreadId = readNotificationThreadId(notification);
            if (providerThreadId) {
              yield* updateSession(sessionRef, {
                resumeCursor: { threadId: providerThreadId },
              });
            }
            return;
          }
          case "turn/started": {
            const turnId = readNotificationTurnId(notification);
            yield* updateSession(sessionRef, {
              status: "running",
              ...(turnId ? { activeTurnId: turnId } : {}),
            });
            return;
          }
          case "turn/completed": {
            const turnStatus = readNotificationTurnStatus(notification);
            const errorMessage =
              turnStatus === "failed" ? readNotificationErrorMessage(notification) : undefined;
            yield* updateSession(sessionRef, {
              status: turnStatus === "failed" ? "error" : "ready",
              activeTurnId: undefined,
              ...(errorMessage ? { lastError: errorMessage } : {}),
            });
            return;
          }
          case "thread/status/changed": {
            const statusType = readNotificationThreadStatusType(notification);
            const providerThreadId = readNotificationThreadId(notification);
            const session = yield* Ref.get(sessionRef);
            if (!providerThreadId || statusType === undefined) {
              return;
            }

            if (statusType === "idle") {
              if (session.activeTurnId && session.status === "running") {
                // Upstream Codex emits `thread/status/changed: idle` separately
                // from `turn/completed`. Treat idle as a prompt to read the
                // authoritative thread snapshot, not as terminal proof by
                // itself; otherwise a late or out-of-order idle notification can
                // close a live turn and break `turn/steer`'s expectedTurnId
                // precondition.
                yield* reconcileActiveTurnFromThreadRead({
                  providerThreadId,
                  turnId: session.activeTurnId,
                  reason: "thread-status-idle-reconciliation",
                }).pipe(Effect.forkIn(runtimeScope), Effect.asVoid);
              } else {
                yield* updateSession(sessionRef, {
                  status: session.status === "error" ? "error" : "ready",
                  activeTurnId: undefined,
                });
              }
              return;
            }

            if (statusType === "active") {
              if (session.activeTurnId) {
                yield* updateSession(sessionRef, {
                  status: "running",
                });
              }
              return;
            }

            if (statusType === "systemError") {
              yield* updateSession(sessionRef, {
                status: "error",
                activeTurnId: undefined,
                lastError:
                  session.lastError ?? "Codex app-server reported a systemError thread status.",
              });
              return;
            }

            return;
          }
          case "error": {
            const errorMessage = readNotificationErrorMessage(notification);
            const willRetry = readNotificationParamBoolean(notification, "willRetry");
            yield* updateSession(sessionRef, {
              status: willRetry ? "running" : "error",
              ...(errorMessage ? { lastError: errorMessage } : {}),
            });
            return;
          }
          default:
            return;
        }
      });

    const updateActiveContextCompactionsFromNotification = (
      notification: CodexServerNotification,
    ) =>
      Effect.gen(function* () {
        if (!(yield* notificationBelongsToCurrentSession(notification))) {
          return;
        }

        const observedAt = yield* nowIso;
        yield* Ref.update(activeContextCompactionsRef, (current) =>
          updateCodexActiveContextCompactions(current, {
            method: notification.method,
            providerThreadId: readNotificationThreadId(notification),
            turnId: readNotificationTurnId(notification),
            itemId: readNotificationItemId(notification),
            itemType: readNotificationItemType(notification),
            observedAt,
          }),
        );
      });

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        yield* reconcileRawNotificationSessionState(notification).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("codex.raw.notification.session-reconcile.failed", {
              threadId: options.threadId,
              providerInstanceId: options.providerInstanceId ?? PROVIDER,
              method: notification.method,
              cause: Cause.pretty(cause),
            }),
          ),
        );
        yield* updateActiveContextCompactionsFromNotification(notification).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("codex.raw.notification.context-compaction-tracking.failed", {
              threadId: options.threadId,
              providerInstanceId: options.providerInstanceId ?? PROVIDER,
              method: notification.method,
              cause: Cause.pretty(cause),
            }),
          ),
        );
        yield* markPendingSteerProcessingFromNotification(notification).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("codex.raw.notification.steer-processing-tracking.failed", {
              threadId: options.threadId,
              providerInstanceId: options.providerInstanceId ?? PROVIDER,
              method: notification.method,
              cause: Cause.pretty(cause),
            }),
          ),
        );

        const payload = notification.params;
        const route = readRouteFields(notification);
        yield* markTurnStartNotification(notification, route.turnId);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const childParentTurnId = (() => {
          const providerConversationId = readNotificationThreadId(notification);
          return providerConversationId
            ? collabReceiverTurns.get(providerConversationId)
            : undefined;
        })();

        rememberCollabReceiverTurns(collabReceiverTurns, notification, route.turnId);
        if (childParentTurnId && shouldSuppressChildConversationNotification(notification.method)) {
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        let requestId: ApprovalRequestId | undefined;
        let requestKind: ProviderRequestKind | undefined;
        let turnId = childParentTurnId ?? route.turnId;
        let itemId = route.itemId;

        if (notification.method === "serverRequest/resolved") {
          const notificationParams = readRecord(notification.params);
          const rawRequestIdValue = notificationParams?.requestId;
          const rawRequestId =
            typeof rawRequestIdValue === "string"
              ? rawRequestIdValue
              : rawRequestIdValue === undefined
                ? ""
                : String(rawRequestIdValue);
          const correlation = rawRequestId
            ? (yield* Ref.get(approvalCorrelationsRef)).get(rawRequestId)
            : undefined;
          if (correlation) {
            requestId = correlation.requestId;
            requestKind = correlation.requestKind;
            turnId = correlation.turnId ?? turnId;
            itemId = correlation.itemId ?? itemId;
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.delete(rawRequestId);
              return next;
            });
          }
        }

        yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: notification.method,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(requestKind ? { requestKind } : {}),
          ...(notification.method === "item/agentMessage/delta"
            ? { textDelta: readNotificationParamString(notification, "delta") ?? "" }
            : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
      });

    yield* client.handleServerNotification("thread/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.thread.id !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            resumeCursor: { threadId: payload.thread.id },
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            status: "running",
            activeTurnId: TurnId.make(payload.turn.id),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/completed", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          const lastError =
            payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
              ? payload.turn.error.message
              : undefined;
          return updateSession(sessionRef, {
            status: payload.turn.status === "failed" ? "error" : "ready",
            activeTurnId: undefined,
            ...(lastError ? { lastError } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerNotification("error", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          const payloadThreadId = payload.threadId;
          if (providerThreadId && payloadThreadId && payloadThreadId !== providerThreadId) {
            return Effect.void;
          }
          const errorMessage = payload.error.message;
          const willRetry = payload.willRetry;
          return updateSession(sessionRef, {
            status: willRetry ? "running" : "error",
            ...(errorMessage ? { lastError: errorMessage } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.approvalId ?? payload.itemId,
            requestKind: "command",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.approvalId ?? payload.itemId, {
            requestId,
            requestKind: "command",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/commandExecution/requestApproval",
          requestId,
          requestKind: "command",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const decision = yield* Deferred.make<ProviderApprovalDecision>();

        yield* Ref.update(pendingApprovalsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            jsonRpcId: payload.itemId,
            requestKind: "file-change",
            turnId,
            itemId,
            decision,
          });
          return next;
        });
        yield* Ref.update(approvalCorrelationsRef, (current) => {
          const next = new Map(current);
          next.set(payload.itemId, {
            requestId,
            requestKind: "file-change",
            turnId,
            itemId,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/fileChange/requestApproval",
          requestId,
          requestKind: "file-change",
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolved = yield* Deferred.await(decision).pipe(
          Effect.ensuring(
            Ref.update(pendingApprovalsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.gen(function* () {
        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const turnId = TurnId.make(payload.turnId);
        const itemId = ProviderItemId.make(payload.itemId);
        const answers = yield* Deferred.make<ProviderUserInputAnswers>();

        yield* Ref.update(pendingUserInputsRef, (current) => {
          const next = new Map(current);
          next.set(requestId, {
            requestId,
            turnId,
            itemId,
            answers,
          });
          return next;
        });

        yield* emitEvent({
          kind: "request",
          threadId: options.threadId,
          method: "item/tool/requestUserInput",
          requestId,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          payload,
        });

        const resolvedAnswers = yield* Deferred.await(answers).pipe(
          Effect.ensuring(
            Ref.update(pendingUserInputsRef, (current) => {
              const next = new Map(current);
              next.delete(requestId);
              return next;
            }),
          ),
        );

        return {
          answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                questionId: error.questionId,
              }),
            ),
          ),
        } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
      }),
    );

    yield* client.handleUnknownServerRequest((method) =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method)),
    );

    yield* client.raw.notifications.pipe(
      Stream.runForEach((notification) =>
        Queue.offer(
          serverNotifications,
          makeCodexServerNotification(notification.method, notification.params),
        ).pipe(Effect.asVoid),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("codex.raw.notification.stream.failed", {
          threadId: options.threadId,
          providerInstanceId: options.providerInstanceId ?? PROVIDER,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach((notification) =>
        handleRawNotification(notification).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("codex.raw.notification.projection.failed", {
              threadId: options.threadId,
              providerInstanceId: options.providerInstanceId ?? PROVIDER,
              method: notification.method,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.andThen(
                emitEvent({
                  kind: "error",
                  threadId: options.threadId,
                  method: "codex.rawNotification/projectionFailed",
                  message: "Codex notification projection failed",
                  payload: {
                    method: notification.method,
                    cause: Cause.pretty(cause),
                  },
                }).pipe(Effect.catchCause(() => Effect.void)),
              ),
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const stderrRemainderRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = classifyCodexStderrLine(line);
                if (!classified) {
                  return Effect.void;
                }
                return emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "process/stderr",
                  message: classified.message,
                });
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }
            const nextStatus = exitCode === 0 ? "closed" : "error";
            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Starting Codex App Server session.");
      if (options.transportPolicy?.responsesWebsockets === "disabled") {
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: "codex.transportPolicy/applied",
          message: "Codex Responses WebSocket transport disabled; using HTTP Responses transport.",
          payload: {
            responsesWebsockets: "disabled",
            reason: options.transportPolicy.reason ?? null,
            observedAt: options.transportPolicy.observedAt ?? null,
            providerId: CODEX_HTTP_FALLBACK_PROVIDER_ID,
            semantics:
              "Cafe Code preserves Codex's official WebSocket-to-HTTP fallback decision across Cafe restarts.",
          },
        });
      }
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        additionalDirectories: options.additionalDirectories,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
      });

      const providerThreadId = opened.thread.id;
      const activeSnapshotTurn = selectCodexActiveSnapshotTurn(opened.thread);
      const activeSnapshotTurnId = activeSnapshotTurn
        ? TurnId.make(activeSnapshotTurn.id)
        : undefined;
      const openedThreadStatusType = readCodexSnapshotThreadStatusType(opened.thread.status);
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status:
          openedThreadStatusType === "systemError"
            ? "error"
            : activeSnapshotTurnId
              ? "running"
              : "ready",
        cwd: opened.cwd,
        ...(options.additionalDirectories !== undefined
          ? { additionalDirectories: options.additionalDirectories }
          : {}),
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        activeTurnId: activeSnapshotTurnId,
        ...(openedThreadStatusType === "systemError"
          ? {
              lastError:
                "Codex app-server reported a systemError thread status during session start.",
            }
          : {}),
        updatedAt: yield* nowIso,
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");
      yield* emitSnapshotBackfillEvents({
        providerThread: opened.thread,
        reason: readResumeCursorThreadId(options.resumeCursor) ? "session-resume" : "session-start",
      });
      if (activeSnapshotTurnId) {
        yield* scheduleSendTurnSnapshotBackfill({
          providerThreadId,
          turnId: activeSnapshotTurnId,
          reason: "session-resume-active-turn",
        });
        yield* reconcileActiveTurnFromThreadRead({
          providerThreadId,
          turnId: activeSnapshotTurnId,
          reason: "session-resume-active-turn",
        }).pipe(Effect.forkIn(runtimeScope), Effect.asVoid);
      }
      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }
      return providerThreadId;
    });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
      if (alreadyClosed) {
        return;
      }
      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emitSessionEvent("session/closed", "Session stopped");
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    return {
      start,
      getSession: Ref.get(sessionRef),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const normalizedModel = normalizeCodexModelSlug(
            input.model ?? (yield* Ref.get(sessionRef)).model,
          );
          const effectiveAdditionalDirectories =
            input.additionalDirectories ?? options.additionalDirectories ?? [];
          const params = yield* buildTurnStartParams({
            threadId: providerThreadId,
            cwd: options.cwd,
            runtimeMode: options.runtimeMode,
            ...(input.input ? { prompt: input.input } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(normalizedModel ? { model: normalizedModel } : {}),
            ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
            ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
            additionalDirectories: effectiveAdditionalDirectories,
          });
          const turnStartRequestedAt = yield* nowIso;
          const turnStartRequestedAtMs = yield* Clock.currentTimeMillis;
          const rawResponse = yield* client.raw.request("turn/start", params);
          const turnStartAcknowledgedAt = yield* nowIso;
          const turnStartAcknowledgedAtMs = yield* Clock.currentTimeMillis;
          const response = yield* decodeV2TurnStartResponse(rawResponse).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid turn/start response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turn.id);
          yield* recordTurnStartObservation({
            providerThreadId,
            turnId,
            requestedAt: turnStartRequestedAt,
            acknowledgedAt: turnStartAcknowledgedAt,
            ackLatencyMs: Math.max(0, turnStartAcknowledgedAtMs - turnStartRequestedAtMs),
            promptByteLength: Buffer.byteLength(input.input ?? "", "utf8"),
            attachmentCount: input.attachments?.length ?? 0,
            model: normalizedModel,
            effort: input.effort,
            interactionMode: input.interactionMode,
            serviceTier: input.serviceTier,
            additionalDirectoryCount: effectiveAdditionalDirectories.length,
            firstNotificationAt: undefined,
            firstNotificationMethod: undefined,
            firstTurnEventAt: undefined,
            firstTurnEventMethod: undefined,
            lastNotificationAt: undefined,
            lastNotificationMethod: undefined,
            backfillAttemptCount: 0,
            noTurnEventWarningCount: 0,
            lastBackfillAt: undefined,
            lastBackfillThreadStatus: undefined,
            lastBackfillTurnFound: undefined,
            lastBackfillTurnStatus: undefined,
            lastBackfillItemCount: undefined,
            lastBackfillItemsView: undefined,
          });
          const turnStartDiagnostics = {
            providerThreadId,
            turnId,
            requestedAt: turnStartRequestedAt,
            acknowledgedAt: turnStartAcknowledgedAt,
            ackLatencyMs: Math.max(0, turnStartAcknowledgedAtMs - turnStartRequestedAtMs),
            promptByteLength: Buffer.byteLength(input.input ?? "", "utf8"),
            attachmentCount: input.attachments?.length ?? 0,
            model: normalizedModel ?? null,
            effort: input.effort ?? null,
            interactionMode: input.interactionMode ?? null,
            serviceTier: input.serviceTier ?? null,
            additionalDirectoryCount: effectiveAdditionalDirectories.length,
            semantics:
              "turn/start is an acknowledgement; turn/started must arrive later from the app-server listener.",
          };
          yield* Effect.logInfo("codex.turnStart.accepted", {
            threadId: options.threadId,
            providerInstanceId: options.providerInstanceId ?? PROVIDER,
            ...turnStartDiagnostics,
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "codex.turnStart/accepted",
            turnId,
            message: "Codex app-server accepted turn/start.",
            payload: turnStartDiagnostics,
          });
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
            ...(normalizedModel ? { model: normalizedModel } : {}),
          });
          yield* scheduleSendTurnSnapshotBackfill({
            providerThreadId,
            turnId,
            reason: "send-turn-follow-up",
          });
          const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          return {
            threadId: options.threadId,
            turnId,
            ...(resumedProviderThreadId
              ? { resumeCursor: { threadId: resumedProviderThreadId } }
              : {}),
          } satisfies ProviderTurnStartResult;
        }),
      steerTurn: (input) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const rejectIfContextCompactionActive = (expectedTurnId: TurnId) =>
            Effect.gen(function* () {
              const activeContextCompaction = findCodexActiveContextCompactionForTurn(
                yield* Ref.get(activeContextCompactionsRef),
                expectedTurnId,
                providerThreadId,
              );
              if (activeContextCompaction === undefined) {
                return;
              }
              // Upstream schema exposes compact turns as non-steerable, but
              // automatic compaction reaches Cafe as an active
              // `contextCompaction` item on the regular turn. Codex app-server
              // 0.133.0 can ACK `turn/steer` during that item and then leave
              // the turn inProgress, so Cafe preserves the prompt by returning
              // the same structured compact precondition error before
              // transport I/O.
              const observedAt = yield* nowIso;
              const diagnostics = {
                providerThreadId,
                turnId: expectedTurnId,
                itemId: activeContextCompaction.itemId,
                contextCompactionStartedAt: activeContextCompaction.startedAt,
                observedAt,
                promptByteLength: Buffer.byteLength(input.input ?? "", "utf8"),
                attachmentCount: input.attachments?.length ?? 0,
                semantics:
                  "Codex reports active contextCompaction as item lifecycle, while upstream non-steerable state is surfaced as compact. Cafe returns the structured compact precondition failure locally so the follow-up is queued instead of sending turn/steer during compaction.",
              };
              yield* Effect.logWarning("codex.turnSteer.deferredDuringContextCompaction", {
                threadId: options.threadId,
                providerInstanceId: options.providerInstanceId ?? PROVIDER,
                ...diagnostics,
              });
              yield* emitEvent({
                kind: "notification",
                threadId: options.threadId,
                method: "codex.turnSteer/deferredDuringContextCompaction",
                turnId: expectedTurnId,
                itemId: activeContextCompaction.itemId,
                message:
                  "Codex context compaction is active; Cafe Code queued the steer as a follow-up instead of sending turn/steer.",
                payload: diagnostics,
              });
              return yield* buildCodexActiveContextCompactionSteerError({
                providerThreadId,
                turnId: expectedTurnId,
                itemId: activeContextCompaction.itemId,
                startedAt: activeContextCompaction.startedAt,
              });
            });
          const requestSteer = (expectedTurnId: TurnId) =>
            Effect.gen(function* () {
              yield* rejectIfContextCompactionActive(expectedTurnId);
              const params = yield* buildTurnSteerParams({
                threadId: providerThreadId,
                expectedTurnId,
                ...(input.input ? { prompt: input.input } : {}),
                ...(input.attachments ? { attachments: input.attachments } : {}),
              });
              return yield* client.raw.request("turn/steer", params);
            });
          const steerRequestedAt = yield* nowIso;
          const steerRequestedAtMs = yield* Clock.currentTimeMillis;
          const rawResponse = yield* requestSteer(input.expectedTurnId).pipe(
            Effect.catchIf(isCodexNoActiveTurnToSteerError, (error) =>
              Effect.gen(function* () {
                const observedAt = yield* nowIso;
                yield* updateSession(sessionRef, {
                  status: "ready",
                  activeTurnId: undefined,
                });
                yield* Effect.logWarning("codex.turnSteer.noActiveTurnReconciled", {
                  threadId: options.threadId,
                  providerInstanceId: options.providerInstanceId ?? PROVIDER,
                  providerThreadId,
                  requestedExpectedTurnId: input.expectedTurnId,
                  observedAt,
                });
                yield* emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "codex.turnSteer/noActiveTurnReconciled",
                  turnId: input.expectedTurnId,
                  message:
                    "Codex app-server reported no active turn for turn/steer; Cafe Code cleared the active-turn pointer so the message can be retried as a new turn.",
                  payload: {
                    providerThreadId,
                    requestedExpectedTurnId: input.expectedTurnId,
                    observedAt,
                    semantics:
                      "Upstream Codex TUI treats this as an active-turn race: it clears the cached active turn and falls through to turn/start with the same input. Cafe mirrors that by reconciling the runtime session before returning the recoverable error to orchestration.",
                  },
                });
                return yield* error;
              }),
            ),
            Effect.catchIf(isCodexSteerExpectedTurnMismatch, (error) =>
              Effect.gen(function* () {
                const actualTurnId = readCodexSteerExpectedTurnMismatchActualTurnId(error);
                if (actualTurnId === undefined || actualTurnId === input.expectedTurnId) {
                  return yield* error;
                }

                const observedAt = yield* nowIso;
                const diagnostics = {
                  providerThreadId,
                  requestedExpectedTurnId: input.expectedTurnId,
                  actualTurnId,
                  observedAt,
                  promptByteLength: Buffer.byteLength(input.input ?? "", "utf8"),
                  attachmentCount: input.attachments?.length ?? 0,
                  semantics:
                    "Codex app-server reported that Cafe's cached active turn id was stale. Upstream Codex TUI retries turn/steer once with the server-reported active turn id; Cafe mirrors that behavior before surfacing a failure.",
                };
                yield* Effect.logWarning("codex.turnSteer.retryAfterActiveTurnMismatch", {
                  threadId: options.threadId,
                  providerInstanceId: options.providerInstanceId ?? PROVIDER,
                  ...diagnostics,
                });
                yield* emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "codex.turnSteer/retryAfterActiveTurnMismatch",
                  turnId: actualTurnId,
                  message:
                    "Codex app-server reported a newer active turn; Cafe Code retried turn/steer with that turn id.",
                  payload: diagnostics,
                });
                return yield* requestSteer(actualTurnId);
              }),
            ),
          );
          const steerAcknowledgedAt = yield* nowIso;
          const steerAcknowledgedAtMs = yield* Clock.currentTimeMillis;
          const response = yield* decodeV2TurnSteerResponse(rawResponse).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid turn/steer response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turnId);
          const steerId = yield* Random.nextUUIDv4;
          const diagnostics = {
            steerId,
            providerThreadId,
            turnId,
            expectedTurnId: input.expectedTurnId,
            requestedAt: steerRequestedAt,
            acknowledgedAt: steerAcknowledgedAt,
            ackLatencyMs: Math.max(0, steerAcknowledgedAtMs - steerRequestedAtMs),
            promptByteLength: Buffer.byteLength(input.input ?? "", "utf8"),
            attachmentCount: input.attachments?.length ?? 0,
            semantics:
              "turn/steer appends input to the active turn and does not emit a new turn/started notification.",
          };
          yield* Effect.logInfo("codex.turnSteer.accepted", {
            threadId: options.threadId,
            providerInstanceId: options.providerInstanceId ?? PROVIDER,
            ...diagnostics,
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "codex.turnSteer/accepted",
            turnId,
            message: "Codex app-server accepted turn/steer.",
            payload: diagnostics,
          });
          yield* recordPendingSteerProcessing({
            steerId,
            providerThreadId,
            turnId,
            requestedAt: steerRequestedAt,
            acknowledgedAt: steerAcknowledgedAt,
            acknowledgedAtMs: steerAcknowledgedAtMs,
            ackLatencyMs: Math.max(0, steerAcknowledgedAtMs - steerRequestedAtMs),
            promptByteLength: Buffer.byteLength(input.input ?? "", "utf8"),
            attachmentCount: input.attachments?.length ?? 0,
            warningCount: 0,
          });
          yield* schedulePendingSteerProcessingWarnings(steerId);
          yield* updateSession(sessionRef, {
            status: "running",
            activeTurnId: turnId,
          });
          yield* scheduleSendTurnSnapshotBackfill({
            providerThreadId,
            turnId,
            reason: "turn-steer-follow-up",
          });
          const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          return {
            threadId: options.threadId,
            turnId,
            ...(resumedProviderThreadId
              ? { resumeCursor: { threadId: resumedProviderThreadId } }
              : {}),
          } satisfies ProviderTurnSteerResult;
        }),
      interruptTurn: (turnId) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const session = yield* Ref.get(sessionRef);
          const effectiveTurnId = turnId ?? session.activeTurnId;
          if (!effectiveTurnId) {
            return;
          }
          const requestInterrupt = (targetTurnId: TurnId) =>
            client.request("turn/interrupt", {
              threadId: providerThreadId,
              turnId: targetTurnId,
            });

          yield* requestInterrupt(effectiveTurnId).pipe(
            Effect.catchIf(isCodexNoActiveTurnToInterruptError, (error) =>
              Effect.gen(function* () {
                const observedAt = yield* nowIso;
                yield* updateSession(sessionRef, {
                  status: "ready",
                  activeTurnId: undefined,
                });
                yield* Effect.logWarning("codex.turnInterrupt.noActiveTurnReconciled", {
                  threadId: options.threadId,
                  providerInstanceId: options.providerInstanceId ?? PROVIDER,
                  providerThreadId,
                  requestedTurnId: effectiveTurnId,
                  observedAt,
                });
                yield* emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "codex.turnInterrupt/noActiveTurnReconciled",
                  turnId: effectiveTurnId,
                  message:
                    "Codex app-server reported no active turn for turn/interrupt; Cafe Code cleared the active-turn pointer.",
                  payload: {
                    providerThreadId,
                    requestedTurnId: effectiveTurnId,
                    observedAt,
                    semantics:
                      "Codex app-server is authoritative for active turn ownership. A no-active interrupt means Cafe's cached active turn was stale and must not gate future input.",
                  },
                });
                return yield* error;
              }),
            ),
            Effect.catchIf(isCodexSteerExpectedTurnMismatch, (error) =>
              Effect.gen(function* () {
                const actualTurnId = readCodexExpectedActiveTurnMismatchActualTurnId(error);
                if (actualTurnId === undefined || actualTurnId === effectiveTurnId) {
                  return yield* error;
                }

                const observedAt = yield* nowIso;
                const diagnostics = {
                  providerThreadId,
                  requestedTurnId: effectiveTurnId,
                  actualTurnId,
                  observedAt,
                  semantics:
                    "Codex app-server reported that Cafe's interrupt target was stale. Upstream Codex TUI interrupts the current active task without depending on projected turn ids; Cafe mirrors that by retrying once with the server-reported active turn id.",
                };
                yield* Effect.logWarning("codex.turnInterrupt.retryAfterActiveTurnMismatch", {
                  threadId: options.threadId,
                  providerInstanceId: options.providerInstanceId ?? PROVIDER,
                  ...diagnostics,
                });
                yield* emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "codex.turnInterrupt/retryAfterActiveTurnMismatch",
                  turnId: actualTurnId,
                  message:
                    "Codex app-server reported a different active turn; Cafe Code retried turn/interrupt with that turn id.",
                  payload: diagnostics,
                });
                yield* updateSession(sessionRef, {
                  status: "running",
                  activeTurnId: actualTurnId,
                });
                return yield* requestInterrupt(actualTurnId);
              }),
            ),
          );
        }),
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });
        return parseThreadSnapshot(response);
      }),
      rollbackThread: (numTurns) =>
        Effect.gen(function* () {
          const providerThreadId = yield* readProviderThreadId;
          const response = yield* client.request("thread/rollback", {
            threadId: providerThreadId,
            numTurns,
          });
          yield* updateSession(sessionRef, {
            status: "ready",
            activeTurnId: undefined,
          });
          return parseThreadSnapshot(response);
        }),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingApprovalsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }
          yield* Ref.update(pendingApprovalsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.decision, decision);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/requestApproval/decision",
            requestId: pending.requestId,
            requestKind: pending.requestKind,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              requestId: pending.requestId,
              requestKind: pending.requestKind,
              decision,
            },
          });
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const pending = (yield* Ref.get(pendingUserInputsRef)).get(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          yield* Ref.update(pendingUserInputsRef, (current) => {
            const next = new Map(current);
            next.delete(requestId);
            return next;
          });
          yield* Deferred.succeed(pending.answers, answers);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "item/tool/requestUserInput/answered",
            requestId: pending.requestId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            ...(pending.itemId ? { itemId: pending.itemId } : {}),
            payload: {
              answers: codexAnswers,
            },
          });
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
