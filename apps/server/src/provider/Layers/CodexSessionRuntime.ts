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
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
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
const CODEX_SNAPSHOT_BACKFILL_TURN_LIMIT = 1;
const CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS = [
  "2 seconds",
  "10 seconds",
  "30 seconds",
  "60 seconds",
  "180 seconds",
  "300 seconds",
] as const;
const CODEX_SEND_TURN_SNAPSHOT_BACKFILL_READ_TIMEOUT = "10 seconds" as const;
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

// TODO: Verify `packages/effect-codex-app-server/scripts/generate.ts` so the generated
// `V2TurnStartParams` schema includes `collaborationMode` directly.
const CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;
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
type CodexSnapshotThread = {
  readonly id: string;
  readonly turns: ReadonlyArray<CodexSnapshotTurn>;
};
type CodexSnapshotBackfillReason =
  | "session-start"
  | "session-resume"
  | "send-turn-follow-up"
  | "turn-steer-follow-up";

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
  readonly lastBackfillTurnFound: boolean | undefined;
  readonly lastBackfillTurnStatus: string | undefined;
  readonly lastBackfillItemCount: number | undefined;
  readonly lastBackfillItemsView: string | null | undefined;
}

type CodexServerNotification = {
  readonly method: string;
  readonly params: unknown;
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

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly additionalDirectories?: ReadonlyArray<string> | undefined;
}): EffectCodexSchema.V2ThreadStartParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const workspaceWriteConfig =
    input.runtimeMode === "auto-accept-edits" && input.additionalDirectories?.length
      ? {
          config: {
            sandbox_workspace_write: {
              writable_roots: input.additionalDirectories,
            },
          },
        }
      : {};
  return {
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    ...workspaceWriteConfig,
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
  CodexTurnStartParamsWithCollaborationMode,
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

  return decodeCodexTurnStartParamsWithCollaborationMode({
    threadId: input.threadId,
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

interface CodexThreadOpenClient {
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

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
    return input.client.request("thread/start", startParams);
  }

  return input.client
    .request("thread/resume", {
      threadId: resumeThreadId,
      ...startParams,
    })
    .pipe(
      Effect.catchIf(isRecoverableThreadResumeError, (error) =>
        Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId: input.threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error.message,
        }).pipe(Effect.andThen(input.client.request("thread/start", startParams))),
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

function hasBackfillableSnapshotItem(turn: CodexSnapshotTurn): boolean {
  return turn.items.some(isBackfillableSnapshotItem);
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

  for (const turn of selectedTurns) {
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

    // `~` is not shell-expanded when env vars are set via
    // `child_process.spawn`; `expandHomePath` lets a configured
    // `CODEX_HOME=~/.codex_work` reach codex as an absolute path.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...(options.environment ?? process.env),
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const appServerArgs = buildCodexAppServerArgs(options.transportPolicy);
    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.binaryPath, appServerArgs, {
          cwd: options.cwd,
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
      readonly turn: CodexSnapshotTurn | null;
    }) =>
      updateTurnStartObservation(input.turnId, (observation) => ({
        ...observation,
        lastBackfillAt: input.observedAt,
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
            lastBackfillTurnFound: observation.lastBackfillTurnFound ?? null,
            lastBackfillTurnStatus: observation.lastBackfillTurnStatus ?? null,
            lastBackfillItemCount: observation.lastBackfillItemCount ?? null,
            lastBackfillItemsView: observation.lastBackfillItemsView ?? null,
            semantics:
              "turn/start is an acknowledgement; turn/started must arrive later from the app-server listener.",
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
              return nowIso.pipe(
                Effect.flatMap((observedAt) =>
                  markTurnStartBackfillResult({
                    turnId: input.focusTurnId,
                    observedAt,
                    turn: turn ?? null,
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
                    itemCount: turn?.items.length ?? 0,
                    itemsView: turn?.itemsView ?? null,
                  }),
                ),
                Effect.as(turn ?? null),
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

    const emitTurnSnapshotStillInProgressWarning = (input: {
      readonly providerThreadId: string;
      readonly turnId: TurnId;
      readonly reason: CodexSnapshotBackfillReason;
      readonly elapsedDelay: (typeof CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS)[number];
      readonly turn: CodexSnapshotTurn;
    }) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("codex.turnProgress.stillInProgressAfterSnapshotPolling", {
          threadId: options.threadId,
          providerInstanceId: options.providerInstanceId ?? PROVIDER,
          providerThreadId: input.providerThreadId,
          turnId: input.turnId,
          reason: input.reason,
          elapsedDelay: input.elapsedDelay,
          itemCount: input.turn.items.length,
          itemsView: input.turn.itemsView ?? null,
        });
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: "codex.turnProgress/stillInProgressAfterSnapshotPolling",
          turnId: input.turnId,
          message:
            "Codex still reports the active turn as in progress after delayed snapshot polling.",
          payload: {
            providerThreadId: input.providerThreadId,
            turnId: input.turnId,
            reason: input.reason,
            elapsedDelay: input.elapsedDelay,
            itemCount: input.turn.items.length,
            itemsView: input.turn.itemsView ?? null,
            semantics:
              "Cafe will not synthesize turn completion from diff or item events; upstream Codex must emit turn/completed or report a terminal turn status from thread/read.",
          },
        });
      });

    const scheduleSendTurnSnapshotBackfill = (input: {
      readonly providerThreadId: string;
      readonly turnId: TurnId;
      readonly reason: CodexSnapshotBackfillReason;
    }) =>
      Effect.gen(function* () {
        const terminalDelay =
          CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS[
            CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS.length - 1
          ];
        for (const delay of CODEX_SEND_TURN_SNAPSHOT_BACKFILL_DELAYS) {
          yield* Effect.sleep(delay);
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
          const turn = yield* readAndBackfillSnapshot({
            providerThreadId: input.providerThreadId,
            focusTurnId: input.turnId,
            reason: input.reason,
          });
          if (turn && turn.status !== "inProgress" && hasBackfillableSnapshotItem(turn)) {
            return;
          }
          if (turn?.status === "inProgress" && delay === terminalDelay) {
            yield* emitTurnSnapshotStillInProgressWarning({
              providerThreadId: input.providerThreadId,
              turnId: input.turnId,
              reason: input.reason,
              elapsedDelay: delay,
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
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: "ready",
        cwd: opened.cwd,
        ...(options.additionalDirectories !== undefined
          ? { additionalDirectories: options.additionalDirectories }
          : {}),
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: yield* nowIso,
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");
      yield* emitSnapshotBackfillEvents({
        providerThread: opened.thread,
        reason: readResumeCursorThreadId(options.resumeCursor) ? "session-resume" : "session-start",
      });
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
          const params = yield* buildTurnSteerParams({
            threadId: providerThreadId,
            expectedTurnId: input.expectedTurnId,
            ...(input.input ? { prompt: input.input } : {}),
            ...(input.attachments ? { attachments: input.attachments } : {}),
          });
          const steerRequestedAt = yield* nowIso;
          const steerRequestedAtMs = yield* Clock.currentTimeMillis;
          const rawResponse = yield* client.raw.request("turn/steer", params);
          const steerAcknowledgedAt = yield* nowIso;
          const steerAcknowledgedAtMs = yield* Clock.currentTimeMillis;
          const response = yield* decodeV2TurnSteerResponse(rawResponse).pipe(
            Effect.mapError((error) =>
              toProtocolParseError("Invalid turn/steer response payload", error),
            ),
          );
          const turnId = TurnId.make(response.turnId);
          const diagnostics = {
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
          yield* client.request("turn/interrupt", {
            threadId: providerThreadId,
            turnId: effectiveTurnId,
          });
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
