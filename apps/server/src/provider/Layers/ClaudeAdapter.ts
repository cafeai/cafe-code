/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type CanUseTool,
  query,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SettingSource,
  type SDKUserMessage,
  type ModelUsage,
} from "@anthropic-ai/claude-agent-sdk";
import { parseCliArgs } from "@cafecode/shared/cliArgs";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ClaudeSettings,
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderSteerTurnInput,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@cafecode/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
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
import { makeClaudeEnvironment } from "../Drivers/ClaudeHome.ts";
import {
  getClaudeModelCapabilities,
  normalizeClaudeCliEffort,
  resolveClaudeApiModelId,
  resolveClaudeSelectedContextWindowTokens,
  resolveClaudeEffort,
} from "./ClaudeProvider.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);
const decodeUnknownJsonStringExit = Schema.decodeUnknownExit(Schema.UnknownFromJsonString);

const PROVIDER = ProviderDriverKind.make("claudeAgent");
type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;
type ClaudeSdkEffort = NonNullable<ClaudeQueryOptions["effort"]>;
type ClaudePromptInput = Pick<ProviderSendTurnInput, "input" | "attachments"> &
  Partial<Pick<ProviderSendTurnInput, "modelSelection">>;

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
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
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

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

type RuntimeFork = <A, E>(effect: Effect.Effect<A, E, never>) => Fiber.Fiber<A, E>;

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
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
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  hasSubmittedUserPrompt: boolean;
  authFailureSeen: boolean;
  stopped: boolean;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
}

export interface ClaudeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

function safeParseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function transcriptLineHasClaudeMessageUuid(line: string, messageUuid: string): boolean {
  const parsed = safeParseJsonObject(line);
  return parsed?.uuid === messageUuid;
}

function transcriptFileContainsClaudeMessageUuid(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly filePath: string;
  readonly messageUuid: string;
}): Effect.Effect<boolean, never> {
  return input.fileSystem.readFileString(input.filePath).pipe(
    Effect.map((contents) =>
      contents
        .split(/\r?\n/)
        .some((line) => transcriptLineHasClaudeMessageUuid(line, input.messageUuid)),
    ),
    Effect.catch(() => Effect.succeed(false)),
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

function normalizeClaudeTokenUsage(
  value: unknown,
  contextWindow?: number,
): ThreadTokenUsageSnapshot | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const usage = value as Record<string, unknown>;
  const inputTokens =
    (typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? usage.input_tokens
      : 0) +
    (typeof usage.cache_creation_input_tokens === "number" &&
    Number.isFinite(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : 0) +
    (typeof usage.cache_read_input_tokens === "number" &&
    Number.isFinite(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : 0);
  const outputTokens =
    typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
      ? usage.output_tokens
      : 0;
  const derivedTotalProcessedTokens = inputTokens + outputTokens;
  const totalProcessedTokens =
    (typeof usage.total_tokens === "number" && Number.isFinite(usage.total_tokens)
      ? usage.total_tokens
      : undefined) ?? (derivedTotalProcessedTokens > 0 ? derivedTotalProcessedTokens : undefined);
  if (totalProcessedTokens === undefined || totalProcessedTokens <= 0) {
    return undefined;
  }

  const maxTokens =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  const usedTokens =
    maxTokens !== undefined ? Math.min(totalProcessedTokens, maxTokens) : totalProcessedTokens;

  return {
    usedTokens,
    lastUsedTokens: usedTokens,
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
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
): ThreadTokenUsageSnapshot | undefined {
  // Claude task/subagent updates can also carry a `usage.total_tokens` shape,
  // but those counters describe the background task, not the main transcript's
  // current context window. Only message/result-style usage with Anthropic's
  // token fields is eligible for live context-window projection.
  return hasClaudeMessageUsageCounters(value)
    ? normalizeClaudeTokenUsage(value, contextWindow)
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

  return {
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
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

function claudeProjectDirectoryName(path: Path.Path, cwd: string): string {
  return path.resolve(cwd).replaceAll(path.sep, "-");
}

function resolveClaudeConfigDirectory(path: Path.Path, env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) {
    return path.resolve(configDir);
  }
  const homePath = env.HOME?.trim();
  return homePath ? path.join(path.resolve(homePath), ".claude") : path.resolve(".claude");
}

function pathExists(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<boolean, never> {
  return fileSystem.exists(filePath).pipe(Effect.catch(() => Effect.succeed(false)));
}

function copyRegularFileIfMissing(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sourcePath: string;
  readonly targetPath: string;
}): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (yield* pathExists(input.fileSystem, input.targetPath)) {
      return false;
    }
    const sourceInfo = yield* input.fileSystem
      .stat(input.sourcePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (sourceInfo?.type !== "File") {
      return false;
    }
    yield* input.fileSystem
      .makeDirectory(input.path.dirname(input.targetPath), { recursive: true })
      .pipe(Effect.catch(() => Effect.void));
    return yield* input.fileSystem
      .copy(input.sourcePath, input.targetPath, {
        overwrite: false,
        preserveTimestamps: true,
      })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
  });
}

function copyDirectoryIfMissing(input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sourcePath: string;
  readonly targetPath: string;
}): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (yield* pathExists(input.fileSystem, input.targetPath)) {
      return false;
    }
    const sourceInfo = yield* input.fileSystem
      .stat(input.sourcePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (sourceInfo?.type !== "Directory") {
      return false;
    }
    yield* input.fileSystem
      .makeDirectory(input.path.dirname(input.targetPath), { recursive: true })
      .pipe(Effect.catch(() => Effect.void));
    return yield* input.fileSystem
      .copy(input.sourcePath, input.targetPath, {
        overwrite: false,
        preserveTimestamps: true,
      })
      .pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
  });
}

function isDirectory(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<boolean, never> {
  return fileSystem.stat(filePath).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.catch(() => Effect.succeed(false)),
  );
}

const ensureClaudeResumeArtifactsForCwd = Effect.fn(
  "ClaudeAdapter.ensureClaudeResumeArtifactsForCwd",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  readonly resumeSessionId: string | undefined;
}): Effect.fn.Return<
  | {
      readonly checked: false;
      readonly reason: "missing-cwd-or-session";
    }
  | {
      readonly checked: true;
      readonly sessionFileExists: boolean;
      readonly targetSessionFile: string;
      readonly targetProjectDirectory: string;
      readonly copiedFile: boolean;
      readonly copiedDirectory: boolean;
      readonly sourceProjectDirectory?: string;
    },
  never
> {
  if (!input.cwd || !input.resumeSessionId) {
    return {
      checked: false,
      reason: "missing-cwd-or-session",
    };
  }

  const { fileSystem, path } = input;
  const resumeSessionId = input.resumeSessionId;
  const projectsDirectory = path.join(resolveClaudeConfigDirectory(path, input.env), "projects");
  if (!(yield* pathExists(fileSystem, projectsDirectory))) {
    const targetProjectDirectory = path.join(
      projectsDirectory,
      claudeProjectDirectoryName(path, input.cwd),
    );
    return {
      checked: true,
      sessionFileExists: false,
      targetSessionFile: path.join(targetProjectDirectory, `${resumeSessionId}.jsonl`),
      targetProjectDirectory,
      copiedFile: false,
      copiedDirectory: false,
    };
  }

  const targetProjectDirectory = path.join(
    projectsDirectory,
    claudeProjectDirectoryName(path, input.cwd),
  );
  const targetSessionFile = path.join(targetProjectDirectory, `${resumeSessionId}.jsonl`);
  const targetSessionDirectory = path.join(targetProjectDirectory, resumeSessionId);

  const result = yield* Effect.gen(function* () {
    const targetSessionFileExists = yield* pathExists(fileSystem, targetSessionFile);
    if (targetSessionFileExists) {
      return {
        checked: true as const,
        sessionFileExists: true,
        targetSessionFile,
        targetProjectDirectory,
        copiedFile: false,
        copiedDirectory: false,
      };
    }

    const projectEntries = yield* fileSystem.readDirectory(projectsDirectory);
    for (const entryName of projectEntries) {
      const sourceProjectDirectory = path.join(projectsDirectory, entryName);
      if (sourceProjectDirectory === targetProjectDirectory) {
        continue;
      }
      if (!(yield* isDirectory(fileSystem, sourceProjectDirectory))) {
        continue;
      }

      const sourceSessionFile = path.join(sourceProjectDirectory, `${resumeSessionId}.jsonl`);
      const sourceSessionDirectory = path.join(sourceProjectDirectory, resumeSessionId);
      const sourceSessionFileExists = yield* pathExists(fileSystem, sourceSessionFile);
      const sourceSessionDirectoryExists = yield* pathExists(fileSystem, sourceSessionDirectory);
      if (!sourceSessionFileExists && !sourceSessionDirectoryExists) {
        continue;
      }

      const copiedFile = sourceSessionFileExists
        ? yield* copyRegularFileIfMissing({
            fileSystem,
            path,
            sourcePath: sourceSessionFile,
            targetPath: targetSessionFile,
          })
        : false;
      const copiedDirectory = sourceSessionDirectoryExists
        ? yield* copyDirectoryIfMissing({
            fileSystem,
            path,
            sourcePath: sourceSessionDirectory,
            targetPath: targetSessionDirectory,
          })
        : false;
      if (!copiedFile && !copiedDirectory) {
        return {
          checked: true as const,
          sessionFileExists: yield* pathExists(fileSystem, targetSessionFile),
          targetSessionFile,
          targetProjectDirectory,
          copiedFile,
          copiedDirectory,
          sourceProjectDirectory,
        };
      }

      return {
        checked: true as const,
        sessionFileExists: yield* pathExists(fileSystem, targetSessionFile),
        targetSessionFile,
        targetProjectDirectory,
        copiedFile,
        copiedDirectory,
        sourceProjectDirectory,
      };
    }
    return {
      checked: true as const,
      sessionFileExists: yield* pathExists(fileSystem, targetSessionFile),
      targetSessionFile,
      targetProjectDirectory,
      copiedFile: false,
      copiedDirectory: false,
    };
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("claude.resume.artifacts.copy-failed", {
        sessionId: input.resumeSessionId,
        cwd: input.cwd,
        cause: Cause.pretty(cause),
      }).pipe(
        Effect.as({
          checked: true as const,
          sessionFileExists: false,
          targetSessionFile,
          targetProjectDirectory,
          copiedFile: false,
          copiedDirectory: false,
        }),
      ),
    ),
  );

  const copiedSourceProjectDirectory =
    "sourceProjectDirectory" in result ? result.sourceProjectDirectory : undefined;
  if (copiedSourceProjectDirectory !== undefined && (result.copiedFile || result.copiedDirectory)) {
    yield* Effect.logInfo("claude.resume.artifacts.copied-for-cwd", {
      sessionId: input.resumeSessionId,
      sourceProjectDirectory: copiedSourceProjectDirectory,
      targetProjectDirectory: result.targetProjectDirectory,
      copiedFile: result.copiedFile,
      copiedDirectory: result.copiedDirectory,
      sessionFileExists: result.sessionFileExists,
    });
  }

  return result;
});

const findClaudeSessionIdByMessageUuid = Effect.fn(
  "ClaudeAdapter.findClaudeSessionIdByMessageUuid",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly projectDirectory: string;
  readonly messageUuid: string | undefined;
}): Effect.fn.Return<string | undefined, never> {
  if (!input.messageUuid) {
    return undefined;
  }

  const entries = yield* input.fileSystem
    .readDirectory(input.projectDirectory)
    .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)));
  for (const entryName of entries.toSorted()) {
    if (!entryName.endsWith(".jsonl")) {
      continue;
    }

    const sessionId = entryName.slice(0, -".jsonl".length);
    if (!isUuid(sessionId)) {
      continue;
    }

    const filePath = input.path.join(input.projectDirectory, entryName);
    if (
      yield* transcriptFileContainsClaudeMessageUuid({
        fileSystem: input.fileSystem,
        filePath,
        messageUuid: input.messageUuid,
      })
    ) {
      return sessionId;
    }
  }

  return undefined;
});

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
}): ClaudeTurnState {
  return {
    turnId: input.turnId,
    startedAt: input.startedAt,
    items: [],
    assistantTextBlocks: new Map(),
    assistantTextBlockOrder: [],
    capturedProposedPlanKeys: new Set(),
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
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
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
  },
) {
  const text = buildPromptText(input, dependencies.boundInstanceId);
  const sdkContent: Array<Record<string, unknown>> = [];

  if (text.length > 0) {
    sdkContent.push({ type: "text", text });
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

  return buildUserMessage({ sdkContent });
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

  const createQuery =
    options?.createQuery ??
    ((input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }) =>
      query({
        prompt: input.prompt,
        options: input.options,
      }) as ClaudeQueryRuntime);

  const sessions = new Map<ThreadId, ClaudeSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const emitThreadTokenUsageUpdate = Effect.fn("emitThreadTokenUsageUpdate")(function* (
    context: ClaudeSessionContext,
    usage: ThreadTokenUsageSnapshot,
  ) {
    if (sameThreadTokenUsageSnapshot(context.lastKnownTokenUsage, usage)) {
      return;
    }

    context.lastKnownTokenUsage = usage;
    const usageStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: usageStamp.eventId,
      provider: PROVIDER,
      createdAt: usageStamp.createdAt,
      threadId: context.session.threadId,
      ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
      payload: {
        usage,
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

    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id:
            "uuid" in message && typeof message.uuid === "string"
              ? message.uuid
              : yield* Random.nextUUIDv4,
          kind: "notification",
          provider: PROVIDER,
          createdAt: observedAt,
          method: sdkNativeMethod(message),
          ...(typeof message.session_id === "string"
            ? { providerThreadId: message.session_id }
            : {}),
          ...(context.turnState
            ? {
                turnId: asCanonicalTurnId(context.turnState.turnId),
              }
            : {}),
          ...(itemId ? { itemId: ProviderItemId.make(itemId) } : {}),
          payload: message,
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
    if (existing && !existing.completionEmitted) {
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
      emittedTextDelta: false,
      fallbackText: options?.fallbackText ?? "",
      streamClosed: options?.streamClosed ?? false,
      completionEmitted: false,
    };
    turnState.assistantTextBlocks.set(blockIndex, block);
    turnState.assistantTextBlockOrder.push(block);
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
      yield* offerRuntimeEvent({
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
    yield* offerRuntimeEvent({
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

    const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
      blockIndex: block.blockIndex,
      block,
    }));

    for (const [position, text] of snapshotTextBlocks.entries()) {
      const existingEntry = orderedBlocks[position];
      const entry =
        existingEntry ??
        (yield* createSyntheticAssistantTextBlock(context, text).pipe(
          Effect.map((created) => {
            if (!created) {
              return undefined;
            }
            orderedBlocks.push(created);
            return created;
          }),
        ));
      if (!entry) {
        continue;
      }

      if (entry.block.fallbackText.length === 0) {
        entry.block.fallbackText = text;
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
    context.resumeSessionId = message.session_id;
    yield* updateResumeCursor(context);

    if (context.lastThreadStartedId !== nextThreadId) {
      context.lastThreadStartedId = nextThreadId;
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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
    yield* offerRuntimeEvent({
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
    yield* offerRuntimeEvent({
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
    yield* offerRuntimeEvent({
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

  const completeTurn = Effect.fn("completeTurn")(function* (
    context: ClaudeSessionContext,
    status: ProviderRuntimeTurnStatus,
    errorMessage?: string,
    result?: SDKResultMessage,
  ) {
    const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
    const effectiveContextWindow =
      context.selectedContextWindowTokens ?? resultContextWindow ?? context.lastKnownContextWindow;
    if (effectiveContextWindow !== undefined) {
      context.lastKnownContextWindow = effectiveContextWindow;
    }

    // The SDK result.usage contains *accumulated* totals across all API calls
    // (input_tokens, cache_read_input_tokens, etc. summed over every request).
    // This does NOT necessarily represent the current context window size.
    // Prefer the last message-level usage snapshot from message_start/message_delta
    // as the current-window estimate, and attach the accumulated result total as
    // totalProcessedTokens for cost/throughput diagnostics.
    const accumulatedSnapshot = normalizeClaudeTokenUsage(result?.usage, effectiveContextWindow);
    const accumulatedTotalProcessedTokens =
      accumulatedSnapshot?.totalProcessedTokens ?? accumulatedSnapshot?.usedTokens;
    const lastGoodUsage = context.lastKnownTokenUsage;
    const maxTokens = effectiveContextWindow;
    const usageSnapshot: ThreadTokenUsageSnapshot | undefined = lastGoodUsage
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

    const turnState = context.turnState;
    if (!turnState) {
      if (usageSnapshot) {
        yield* emitThreadTokenUsageUpdate(context, usageSnapshot);
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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

    for (const [index, tool] of context.inFlightTools.entries()) {
      const toolStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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
      context.inFlightTools.delete(index);
    }
    // Clear any remaining stale entries (e.g. from interrupted content blocks)
    context.inFlightTools.clear();

    for (const block of turnState.assistantTextBlockOrder) {
      yield* completeAssistantTextBlock(context, block, {
        force: true,
        rawMethod: "claude/result",
        rawPayload: result ?? { status },
      });
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
    yield* offerRuntimeEvent({
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
    const normalizedUsage = normalizeClaudeMessageTokenUsage(
      claudeStreamEventUsagePayload(message),
      context.selectedContextWindowTokens ?? context.lastKnownContextWindow,
    );
    if (normalizedUsage) {
      yield* emitThreadTokenUsageUpdate(context, normalizedUsage);
    }

    if (event.type === "content_block_delta") {
      if (
        (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
        context.turnState
      ) {
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
        }
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
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
        const tool = context.inFlightTools.get(event.index);
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
        context.inFlightTools.set(event.index, nextTool);

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
        context.inFlightTools.set(event.index, nextTool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
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
            yield* offerRuntimeEvent({
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
        itemId,
        itemType,
        toolName,
        title: titleForTool(itemType),
        detail,
        input: toolInput,
        partialInputJson: "",
        ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
      };
      context.inFlightTools.set(index, tool);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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
          payload: message,
        },
      });
      return;
    }

    if (event.type === "content_block_stop") {
      const { index } = event;
      const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
      if (assistantBlock) {
        assistantBlock.streamClosed = true;
        yield* completeAssistantTextBlock(context, assistantBlock, {
          rawMethod: "claude/stream_event/content_block_stop",
          rawPayload: message,
        });
        return;
      }
      const tool = context.inFlightTools.get(index);
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

    if (context.turnState) {
      context.turnState.items.push(message.message);
    }

    for (const toolResult of toolResultBlocksFromUserMessage(message)) {
      const toolEntry = Array.from(context.inFlightTools.entries()).find(
        ([, tool]) => tool.itemId === toolResult.toolUseId,
      );
      if (!toolEntry) {
        continue;
      }

      const [index, tool] = toolEntry;
      const itemStatus = toolResult.isError ? "failed" : "completed";
      const toolData = {
        toolName: tool.toolName,
        input: tool.input,
        result: toolResult.block,
      };

      const updatedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.updated",
        eventId: updatedStamp.eventId,
        provider: PROVIDER,
        createdAt: updatedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
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
          payload: message,
        },
      });

      const streamKind = toolResultStreamKind(tool.itemType);
      if (streamKind && toolResult.text.length > 0 && context.turnState) {
        const deltaStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "content.delta",
          eventId: deltaStamp.eventId,
          provider: PROVIDER,
          createdAt: deltaStamp.createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState.turnId,
          itemId: asRuntimeItemId(tool.itemId),
          payload: {
            streamKind,
            delta: toolResult.text,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: tool.itemId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user",
            payload: message,
          },
        });
      }

      const completedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "item.completed",
        eventId: completedStamp.eventId,
        provider: PROVIDER,
        createdAt: completedStamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
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
          payload: message,
        },
      });

      context.inFlightTools.delete(index);
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

    // Auto-start a synthetic turn for assistant messages that arrive without
    // an active turn (e.g., background agent/subagent responses between user prompts).
    if (!context.turnState) {
      const turnId = TurnId.make(yield* Random.nextUUIDv4);
      const startedAt = yield* nowIso;
      context.turnState = makeClaudeTurnState({
        turnId,
        startedAt,
      });
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const turnStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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

    const status = turnStatusFromResult(message);
    const resultErrors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
    const authFailure = isClaudeAuthFailureResult(message);
    const errorMessage =
      status !== "completed"
        ? (resultPrimaryError(message) ?? resultErrors[0] ?? "Claude turn failed.")
        : undefined;

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
      } else {
        yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
      }
    }

    yield* completeTurn(context, status, errorMessage, message);
    if (authFailure) {
      yield* stopSessionInternal(context, {
        emitExitEvent: true,
        interruptStreamFiber: false,
      });
    }
  });

  const handleSystemMessage = Effect.fn("handleSystemMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
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
        method: sdkNativeMethod(message),
        messageType: `${message.type}:${message.subtype}`,
        payload: message,
      },
    };

    switch (message.subtype) {
      case "api_retry":
        if (isClaudeAuthFailureSystemMessage(message)) {
          context.authFailureSeen = true;
          yield* offerRuntimeEvent({
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
      case "init":
        yield* offerRuntimeEvent({
          ...base,
          type: "session.configured",
          payload: {
            config: message as Record<string, unknown>,
          },
        });
        return;
      case "status":
        yield* offerRuntimeEvent({
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
        yield* offerRuntimeEvent({
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
        // warning or context-window update from it.
        return;
      case "hook_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.started",
          payload: {
            hookId: message.hook_id,
            hookName: message.hook_name,
            hookEvent: message.hook_event,
          },
        });
        return;
      case "hook_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.progress",
          payload: {
            hookId: message.hook_id,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
          },
        });
        return;
      case "hook_response":
        yield* offerRuntimeEvent({
          ...base,
          type: "hook.completed",
          payload: {
            hookId: message.hook_id,
            outcome: message.outcome,
            output: message.output,
            stdout: message.stdout,
            stderr: message.stderr,
            ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
          },
        });
        return;
      case "task_started":
        yield* offerRuntimeEvent({
          ...base,
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.task_type ? { taskType: message.task_type } : {}),
          },
        });
        return;
      case "task_progress":
        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            description: message.description,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
            ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
          },
        });
        return;
      case "task_updated": {
        // Claude Code 2.1.173 started emitting task_updated as a patch-style
        // lifecycle message for the same background task ids previously
        // announced through task_started/task_progress/task_notification.
        // The SDK types can lag behind the binary, so treat the patch as
        // untrusted provider data: copy only structured fields Cafe already
        // understands, keep the complete payload only in the raw native event,
        // and avoid surfacing a runtime warning for a valid upstream subtype.
        const record = message as Record<string, unknown>;
        const patch = recordValue(record.patch) ?? {};
        const taskId = trimmedStringValue(record.task_id);
        if (!taskId) {
          yield* emitRuntimeWarning(context, "Claude task update was missing a task id.", message);
          return;
        }

        const usage = patch.usage ?? record.usage;
        const terminalStatus = claudeTaskTerminalStatus(patch.status ?? record.status);
        if (terminalStatus) {
          yield* offerRuntimeEvent({
            ...base,
            type: "task.completed",
            payload: {
              taskId: RuntimeTaskId.make(taskId),
              status: terminalStatus,
              ...(trimmedStringValue(patch.summary ?? record.summary)
                ? { summary: trimmedStringValue(patch.summary ?? record.summary) }
                : {}),
              ...(usage !== undefined ? { usage } : {}),
            },
          });
          return;
        }

        const rawStatus = trimmedStringValue(patch.status ?? record.status);
        const summary = trimmedStringValue(patch.summary ?? record.summary);
        const description =
          trimmedStringValue(patch.description ?? record.description) ??
          (rawStatus ? `Task ${rawStatus}` : "Task updated");
        yield* offerRuntimeEvent({
          ...base,
          type: "task.progress",
          payload: {
            taskId: RuntimeTaskId.make(taskId),
            description,
            ...(summary ? { summary } : {}),
            ...(usage !== undefined ? { usage } : {}),
            ...(trimmedStringValue(patch.last_tool_name ?? record.last_tool_name)
              ? { lastToolName: trimmedStringValue(patch.last_tool_name ?? record.last_tool_name) }
              : {}),
          },
        });
        return;
      }
      case "task_notification":
        yield* offerRuntimeEvent({
          ...base,
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(message.task_id),
            status: message.status,
            ...(message.summary ? { summary: message.summary } : {}),
            ...(message.usage ? { usage: message.usage } : {}),
          },
        });
        return;
      case "files_persisted":
        yield* offerRuntimeEvent({
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
        yield* emitRuntimeWarning(
          context,
          `Unhandled Claude system message subtype '${message.subtype}'.`,
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
        payload: message,
      },
    };

    if (message.type === "tool_progress") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.progress",
        payload: {
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSeconds: message.elapsed_time_seconds,
          ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
        },
      });
      return;
    }

    if (message.type === "tool_use_summary") {
      yield* offerRuntimeEvent({
        ...base,
        type: "tool.summary",
        payload: {
          summary: message.summary,
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
      yield* offerRuntimeEvent({
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
      yield* offerRuntimeEvent({
        ...base,
        type: "account.rate-limits.updated",
        payload: {
          rateLimits: message,
        },
      });
      return;
    }
  });

  const handleSdkMessage = Effect.fn("handleSdkMessage")(function* (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) {
    yield* logNativeSdkMessage(context, message);
    yield* ensureThreadId(context, message);
    yield* recordTurnSdkMessage(context, message);

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
      default:
        yield* emitRuntimeWarning(
          context,
          `Unhandled Claude SDK message type '${message.type}'.`,
          message,
        );
        return;
    }
  });

  const runSdkStream = (
    context: ClaudeSessionContext,
  ): Effect.Effect<void, ProviderAdapterProcessError> =>
    Stream.fromAsyncIterable(context.query, (cause) =>
      toProcessError(cause, "Claude runtime stream failed.", context.session.threadId),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) => handleSdkMessage(context, message)),
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
    options?: { readonly emitExitEvent?: boolean; readonly interruptStreamFiber?: boolean },
  ) {
    if (context.stopped) return;

    context.stopped = true;

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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

    yield* Effect.try({
      try: () => context.query.close(),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: toMessage(cause, "Failed to close Claude runtime query."),
          cause,
        }),
    }).pipe(
      Effect.catch((cause) =>
        emitRuntimeError(context, "Failed to close Claude runtime query.", cause),
      ),
    );

    const updatedAt = yield* nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (options?.emitExitEvent !== false) {
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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

    sessions.delete(context.session.threadId);
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

  const startSession: ClaudeAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      const existingContext = sessions.get(input.threadId);
      if (existingContext) {
        yield* Effect.logWarning("claude.session.replacing", {
          threadId: input.threadId,
          existingSessionStatus: existingContext.session.status,
          reason: "startSession called with existing active session",
        });
        yield* stopSessionInternal(existingContext, {
          emitExitEvent: false,
        }).pipe(
          // Replacement cleanup is best-effort: never block the new session on
          // either typed failures or unexpected defects from tearing down the old one.
          Effect.catchCause((cause) =>
            Effect.logWarning("claude.session.replace.stop-failed", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );
      }

      const startedAt = yield* nowIso;
      const resumeState = readClaudeResumeState(input.resumeCursor);
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
      const inFlightTools = new Map<number, ToolInFlight>();

      const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

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
        yield* offerRuntimeEvent({
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

        // Handle abort (e.g. turn interrupted while waiting for user input).
        const onAbort = () => {
          if (!pendingUserInputs.has(requestId)) {
            return;
          }
          aborted = true;
          pendingUserInputs.delete(requestId);
          runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
        };
        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        // Block until the user provides answers.
        const answers = yield* Deferred.await(answersDeferred);
        pendingUserInputs.delete(requestId);

        // Emit user-input.resolved so the UI knows the interaction completed.
        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
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

        if (aborted) {
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
        if (!context) {
          return {
            behavior: "deny",
            message: "Claude session context is unavailable.",
          } satisfies PermissionResult;
        }

        // Handle AskUserQuestion: surface clarifying questions to the
        // user via the user-input runtime event channel, regardless of
        // runtime mode (plan mode relies on this heavily).
        if (toolName === "AskUserQuestion") {
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

        const runtimeMode = input.runtimeMode ?? "full-access";
        if (runtimeMode === "full-access") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
          } satisfies PermissionResult;
        }

        const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
        const requestType = classifyRequestType(toolName);
        const detail = summarizeToolRequest(toolName, toolInput);
        const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
        const pendingApproval: PendingApproval = {
          requestType,
          detail,
          decision: decisionDeferred,
          ...(callbackOptions.suggestions ? { suggestions: callbackOptions.suggestions } : {}),
        };

        const requestedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
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
            args: {
              toolName,
              input: toolInput,
              ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
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
            },
          },
        });

        pendingApprovals.set(requestId, pendingApproval);

        const onAbort = () => {
          if (!pendingApprovals.has(requestId)) {
            return;
          }
          pendingApprovals.delete(requestId);
          runFork(Deferred.succeed(decisionDeferred, "cancel"));
        };

        callbackOptions.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        const decision = yield* Deferred.await(decisionDeferred);
        pendingApprovals.delete(requestId);

        const resolvedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
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

        if (decision === "accept" || decision === "acceptForSession") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            ...(decision === "acceptForSession" && pendingApproval.suggestions
              ? {
                  updatedPermissions: [...pendingApproval.suggestions],
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
      const caps = getClaudeModelCapabilities(modelSelection?.model);
      const descriptors = getProviderOptionDescriptors({ caps });
      const apiModelId = modelSelection ? resolveClaudeApiModelId(modelSelection) : undefined;
      const selectedContextWindowTokens = resolveClaudeSelectedContextWindowTokens(modelSelection);
      const rawEffort = getModelSelectionStringOptionValue(modelSelection, "effort");
      const effort = resolveClaudeEffort(caps, rawEffort) ?? null;
      const fastModeSupported = descriptors.some(
        (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
      );
      const thinkingSupported = descriptors.some(
        (descriptor) => descriptor.type === "boolean" && descriptor.id === "thinking",
      );
      const fastMode =
        getModelSelectionBooleanOptionValue(modelSelection, "fastMode") === true &&
        fastModeSupported;
      const thinking = thinkingSupported
        ? getModelSelectionBooleanOptionValue(modelSelection, "thinking")
        : undefined;
      const effectiveEffort = getEffectiveClaudeAgentEffort(effort);
      const runtimeModeToPermission: Record<string, PermissionMode> = {
        "auto-accept-edits": "acceptEdits",
        "full-access": "bypassPermissions",
      };
      const permissionMode = runtimeModeToPermission[input.runtimeMode];
      const initialPermissionMode = input.interactionMode === "plan" ? "plan" : permissionMode;
      const settings = {
        ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
        ...(fastMode ? { fastMode: true } : {}),
      };
      const claudeAdditionalDirectories = [
        ...(input.cwd ? [input.cwd] : []),
        ...(input.additionalDirectories ?? []),
      ].filter((directory, index, directories) => directories.indexOf(directory) === index);

      const initialResumeSessionId = durableResumeState?.resume;
      let resumeArtifactStatus =
        initialResumeSessionId === undefined
          ? undefined
          : yield* ensureClaudeResumeArtifactsForCwd({
              fileSystem,
              path,
              env: claudeEnvironment,
              cwd: input.cwd,
              resumeSessionId: initialResumeSessionId,
            });
      if (resumeArtifactStatus?.checked === true && !resumeArtifactStatus.sessionFileExists) {
        const repairedResumeSessionId = yield* findClaudeSessionIdByMessageUuid({
          fileSystem,
          path,
          projectDirectory: resumeArtifactStatus.targetProjectDirectory,
          messageUuid: durableResumeState?.resumeSessionAt,
        });

        if (repairedResumeSessionId !== undefined && durableResumeState !== undefined) {
          // `resumeSessionAt` is an explicit Claude Agent SDK checkpoint. It is
          // not needed for normal Claude CLI-style follow-ups and can make
          // current Claude Code reject otherwise valid sessions when Cafe has a
          // stale resume id. Repair from the transcript that actually contains
          // the stored assistant message, then resume by session id only.
          yield* Effect.logWarning("claude.resume.cursor.repaired-missing-session", {
            threadId,
            staleResumeSessionId: initialResumeSessionId,
            repairedResumeSessionId,
            resumeSessionAt: durableResumeState?.resumeSessionAt ?? "",
            cwd: input.cwd ?? "",
            targetProjectDirectory: resumeArtifactStatus.targetProjectDirectory,
          });
          const { resumeSessionAt: _ignoredResumeSessionAt, ...resumeStateWithoutCheckpoint } =
            durableResumeState;
          durableResumeState = {
            ...resumeStateWithoutCheckpoint,
            resume: repairedResumeSessionId,
          };
          resumeArtifactStatus = yield* ensureClaudeResumeArtifactsForCwd({
            fileSystem,
            path,
            env: claudeEnvironment,
            cwd: input.cwd,
            resumeSessionId: repairedResumeSessionId,
          });
        }
      }

      if (resumeArtifactStatus?.checked === true && !resumeArtifactStatus.sessionFileExists) {
        // Claude's sessions guide documents resume as loading the local
        // transcript under ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl.
        // Passing a durable Cafe cursor whose transcript file is absent makes
        // current Claude Code fail before the model turn starts. Drop that
        // stale cursor and start a fresh upstream session; the user's prompt is
        // still sent once, but without a doomed `--resume`.
        yield* Effect.logWarning("claude.resume.cursor.dropped-missing-transcript", {
          threadId,
          resumeSessionId: initialResumeSessionId,
          cwd: input.cwd ?? "",
          targetSessionFile: resumeArtifactStatus.targetSessionFile,
        });
        durableResumeState = undefined;
      }

      const existingResumeSessionId = durableResumeState?.resume;
      const resumeBaseTurnCount = durableResumeState?.turnCount ?? 0;

      const queryOptions: ClaudeQueryOptions = {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(apiModelId ? { model: apiModelId } : {}),
        pathToClaudeCodeExecutable: claudeBinaryPath,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: [...CLAUDE_SETTING_SOURCES],
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
        canUseTool,
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
        env: claudeEnvironment,
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
        "claude.resume.target_session_file":
          resumeArtifactStatus?.checked === true ? resumeArtifactStatus.targetSessionFile : "",
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
        "claude.query.additional_directories": claudeAdditionalDirectories,
        "claude.query.setting_sources": [...CLAUDE_SETTING_SOURCES],
        "claude.query.settings_json": encodeJsonStringForDiagnostics(settings) ?? "",
        "claude.query.extra_args_json": encodeJsonStringForDiagnostics(extraArgs) ?? "",
        "claude.query.path_to_executable": claudeBinaryPath,
      });

      const queryRuntime = yield* Effect.try({
        try: () =>
          createQuery({
            prompt,
            options: queryOptions,
          }),
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
            }
          : undefined;
      const session: ProviderSession = {
        threadId,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
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
        session,
        promptQueue,
        query: queryRuntime,
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
        pendingApprovals,
        pendingUserInputs,
        turns: [],
        inFlightTools,
        turnState: undefined,
        lastKnownContextWindow: selectedContextWindowTokens,
        lastKnownTokenUsage: undefined,
        lastAssistantUuid: undefined,
        lastThreadStartedId: undefined,
        hasSubmittedUserPrompt: false,
        authFailureSeen: false,
        stopped: false,
      };
      yield* Ref.set(contextRef, context);
      sessions.set(threadId, context);

      const sessionStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId: sessionStartedStamp.eventId,
        provider: PROVIDER,
        createdAt: sessionStartedStamp.createdAt,
        threadId,
        payload: initialResumeCursor !== undefined ? { resume: initialResumeCursor } : {},
        providerRefs: {},
      });

      const configuredStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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
            ...(fastMode ? { fastMode: true } : {}),
          },
        },
        providerRefs: {},
      });

      const readyStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
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
      streamFiber.addObserver(() => {
        if (context.streamFiber === streamFiber) {
          context.streamFiber = undefined;
        }
      });

      return {
        ...session,
      };
    },
  );

  const sendTurn: ClaudeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;

    if (context.turnState) {
      // Auto-close a stale synthetic turn (from background agent responses
      // between user prompts) to prevent blocking the user's next turn.
      yield* completeTurn(context, "completed");
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
      input.interactionMode === "plan"
        ? "plan"
        : input.interactionMode === "default"
          ? (context.basePermissionMode ?? "default")
          : undefined;
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

    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      boundInstanceId,
      method: "turn/start",
    });

    const turnId = TurnId.make(yield* Random.nextUUIDv4);
    const turnState = makeClaudeTurnState({
      turnId,
      startedAt: yield* nowIso,
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
    yield* offerRuntimeEvent({
      type: "turn.started",
      eventId: turnStartedStamp.eventId,
      provider: PROVIDER,
      createdAt: turnStartedStamp.createdAt,
      threadId: context.session.threadId,
      turnId,
      payload: modelSelection?.model ? { model: modelSelection.model } : {},
      providerRefs: {},
    });

    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(
      Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)),
      Effect.tapError((error) =>
        completeTurn(context, "failed", toMessage(error, "Failed to queue Claude turn.")),
      ),
    );
    context.hasSubmittedUserPrompt = true;
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
      yield* Effect.tryPromise({
        try: () => context.query.interrupt(),
        catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
      });
    },
  );

  const readThread: ClaudeAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      return yield* snapshotThread(context);
    },
  );

  const rollbackThread: ClaudeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);
      const nextLength = Math.max(0, context.turns.length - numTurns);
      context.turns.splice(nextLength);
      yield* updateResumeCursor(context);
      return yield* snapshotThread(context);
    },
  );

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

    context.pendingUserInputs.delete(requestId);
    yield* Deferred.succeed(pending.answers, answers);
  });

  const stopSession: ClaudeAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
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

    const message = yield* buildUserMessageEffect(input, {
      fileSystem,
      attachmentsDir: serverConfig.attachmentsDir,
      boundInstanceId,
      method: "turn/steer",
    });

    // Official Claude Agent SDK streaming input mode is the long-lived,
    // interactive path: `query({ prompt: AsyncIterable<SDKUserMessage> })`
    // supports dynamic message queueing and interruption, and the local
    // package types document `streamInput()` as the multi-turn input pipe.
    // Claude does not expose a Codex-style expected-turn RPC, so Cafe binds the
    // steer to its own active turn id before queueing exactly one SDK user
    // message into the already-running prompt stream.
    yield* Queue.offer(context.promptQueue, {
      type: "message",
      message,
    }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/steer", cause)));

    context.hasSubmittedUserPrompt = true;
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

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
      liveSteer: "supported",
    },
    startSession,
    sendTurn,
    steerTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies ClaudeAdapterShape;
});
