// @effect-diagnostics nodeBuiltinImport:off
/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps the typed Codex session runtime behind the `CodexAdapter` service
 * contract and maps runtime failures into the shared `ProviderAdapterError`
 * algebra.
 *
 * @module CodexAdapterLive
 */
import * as Crypto from "node:crypto";
import * as NodeFs from "node:fs";

import {
  type CanonicalItemType,
  type CanonicalRequestType,
  type CodexSettings,
  ProviderDriverKind,
  type ProviderEvent,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRequestKind,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ProviderApprovalDecision,
  ThreadId,
  ProviderSendTurnInput,
  RuntimeTaskId,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@cafecode/shared/model";
import { CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT } from "@cafecode/shared/codexCompaction";

import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  CodexResumeCursorSchema,
  CodexSessionRuntimeThreadIdMissingError,
  makeCodexSessionRuntime,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
  type CodexTransportPolicy,
} from "./CodexSessionRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type { CodexShadowHomeError } from "../Drivers/CodexHomeLayout.ts";
const isCodexAppServerProcessExitedError = Schema.is(CodexErrors.CodexAppServerProcessExitedError);
const isCodexAppServerTransportError = Schema.is(CodexErrors.CodexAppServerTransportError);
const isCodexSessionRuntimeThreadIdMissingError = Schema.is(
  CodexSessionRuntimeThreadIdMissingError,
);
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);

const PROVIDER = ProviderDriverKind.make("codex");
const CODEX_TRANSPORT_POLICY_FILENAME = "codex-transport-policy.json";
const CODEX_TRANSPORT_POLICY_PERSISTENCE_ENV = "CAFE_CODE_PERSIST_CODEX_HTTP_FALLBACK";
const CODEX_WEBSOCKET_FALLBACK_REASON = "responses_websocket_stream_disconnected";

class CodexTransportPolicyFileError extends Data.TaggedError("CodexTransportPolicyFileError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export interface CodexAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly prepareRuntimeHome?: Effect.Effect<void, CodexShadowHomeError>;
  readonly makeRuntime?: (
    options: CodexSessionRuntimeOptions,
  ) => Effect.Effect<
    CodexSessionRuntimeShape,
    CodexSessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface CodexAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: CodexSessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  readonly transportPolicyApplied: boolean;
  pendingTransportPolicyRetirement?: {
    readonly fallbackEventId: string;
    readonly observedAt: string;
    readonly reason: string;
  };
  stopped: boolean;
}

function mapCodexRuntimeError(
  threadId: ThreadId,
  method: string,
  error: CodexSessionRuntimeError,
): ProviderAdapterError {
  if (isCodexAppServerProcessExitedError(error) || isCodexAppServerTransportError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  if (isCodexSessionRuntimeThreadIdMissingError(error)) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"];

type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  const isPayload = Schema.is(schema);
  return isPayload(payload) ? payload : undefined;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

interface CodexTransportPolicyEntry {
  readonly responsesWebsockets: CodexTransportPolicy["responsesWebsockets"];
  readonly reason?: string;
  readonly observedAt?: string;
  readonly source?: string;
  readonly lastEventId?: string;
  readonly lastThreadId?: string;
  readonly lastTurnId?: string;
  readonly failureCount?: number;
}

interface CodexTransportPolicyFile {
  readonly version: 1;
  readonly instances: Record<string, CodexTransportPolicyEntry>;
}

function readRecordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPayloadMessage(event: ProviderEvent): string | undefined {
  const payload = readRecordValue(event.payload);
  const error = readRecordValue(payload?.error);
  return (
    readStringValue(event.message) ??
    readStringValue(payload?.message) ??
    readStringValue(error?.message)
  );
}

function readPayloadAdditionalDetails(event: ProviderEvent): string | undefined {
  const payload = readRecordValue(event.payload);
  const error = readRecordValue(payload?.error);
  return (
    readStringValue(payload?.additionalDetails) ??
    readStringValue(error?.additionalDetails) ??
    readStringValue(error?.details)
  );
}

function containsNormalized(value: string | undefined, needle: string): boolean {
  return value?.toLowerCase().includes(needle.toLowerCase()) ?? false;
}

function isCodexResponsesWebsocketFallbackEvent(event: ProviderEvent): boolean {
  const message = readPayloadMessage(event);
  const additionalDetails = readPayloadAdditionalDetails(event);
  const combined = [message, additionalDetails].filter(Boolean).join("\n");

  // Match upstream Codex exactly: retry notifications such as
  // "Reconnecting... 5/5" are not the transport decision. Codex only switches a
  // session to HTTP after its fallback branch activates and emits the
  // WebSockets-to-HTTPS/HTTP warning. Cafe observes that official decision but
  // does not persist it by default because upstream keeps it session-scoped.
  return (
    containsNormalized(combined, "falling back from websockets to https transport") ||
    containsNormalized(combined, "falling back to http")
  );
}

function isCodexResponsesWebsocketStderrDiagnostic(event: ProviderEvent): boolean {
  if (event.method !== "process/stderr") {
    return false;
  }
  const message = event.message ?? readPayloadMessage(event);
  if (!message) {
    return false;
  }

  // Upstream Codex rust-v0.141.0 reports retry/fallback state through structured
  // StreamError and Warning events. The Responses WebSocket tracing line on
  // stderr is duplicate transport noise, especially after machine sleep/wake
  // DNS loss, so Cafe keeps the structured work-log facts and drops only this
  // raw diagnostic line.
  return (
    containsNormalized(message, "codex_api::endpoint::responses_websocket") &&
    containsNormalized(message, "failed to connect to websocket") &&
    containsNormalized(message, "/backend-api/codex/responses")
  );
}

function isCodexLowValueMetadataStderrWarning(event: ProviderEvent): boolean {
  if (event.method !== "process/stderr") {
    return false;
  }
  const message = event.message ?? readPayloadMessage(event);
  if (!message) {
    return false;
  }

  // Codex can emit one stderr line for every plugin/skill metadata issue while
  // scanning homes and plugin caches. These are retained in native provider logs
  // but are not useful thread activity, and bursts can dominate WebSocket traffic
  // on slow links.
  return (
    (containsNormalized(message, "codex_core_plugins::manifest") &&
      containsNormalized(message, "ignoring interface.defaultprompt")) ||
    (containsNormalized(message, "codex_core_skills::loader") &&
      (containsNormalized(message, "ignoring interface.icon_small") ||
        containsNormalized(message, "ignoring interface.icon_large")))
  );
}

function isCodexAuthInvalidatedEvent(event: ProviderEvent): boolean {
  const message = readPayloadMessage(event);
  const additionalDetails = readPayloadAdditionalDetails(event);
  const combined = [message, additionalDetails].filter(Boolean).join("\n");
  return (
    containsNormalized(combined, "token_revoked") ||
    containsNormalized(combined, "invalidated oauth token")
  );
}

function isCodexTransportPolicyPersistenceEnabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment[CODEX_TRANSPORT_POLICY_PERSISTENCE_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isCodexTurnTerminalEvent(event: ProviderEvent): boolean {
  return event.method === "turn/completed" || event.method === "turn/aborted";
}

function shouldAuditCodexBridgeEvent(event: ProviderEvent): boolean {
  return (
    isCodexTurnTerminalEvent(event) ||
    event.method === "thread/status/changed" ||
    event.method === "account/rateLimits/updated" ||
    event.method === "item/completed"
  );
}

function bridgeEventLogContext(
  event: ProviderEvent,
  extra?: {
    readonly runtimeEvents?: ReadonlyArray<ProviderRuntimeEvent>;
    readonly stage?: string;
    readonly cause?: unknown;
  },
): Record<string, unknown> {
  return {
    provider: event.provider,
    providerInstanceId: event.providerInstanceId,
    threadId: event.threadId,
    turnId: event.turnId,
    itemId: event.itemId,
    eventId: event.id,
    method: event.method,
    ...(extra?.stage ? { stage: extra.stage } : {}),
    ...(extra?.runtimeEvents
      ? {
          canonicalEventCount: extra.runtimeEvents.length,
          canonicalEventTypes: extra.runtimeEvents.map((entry) => entry.type),
        }
      : {}),
    ...(extra?.cause ? { cause: extra.cause } : {}),
  };
}

function codexTransportPolicyKey(input: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly homePath?: string;
}): string {
  // The key intentionally avoids user prompts and thread content. It binds the
  // decision to the exact provider instance + Codex binary + CODEX_HOME so one
  // local Codex identity cannot silently change another identity's transport.
  return JSON.stringify({
    instanceId: input.instanceId,
    binaryPath: input.binaryPath,
    homePath: input.homePath ?? "",
  });
}

function parseCodexTransportPolicyFile(value: unknown): CodexTransportPolicyFile | undefined {
  const record = readRecordValue(value);
  const instancesRecord = readRecordValue(record?.instances);
  if (record?.version !== 1 || !instancesRecord) {
    return undefined;
  }

  const instances: Record<string, CodexTransportPolicyEntry> = {};
  for (const [key, rawEntry] of Object.entries(instancesRecord)) {
    const entry = readRecordValue(rawEntry);
    if (
      !entry ||
      (entry.responsesWebsockets !== "auto" && entry.responsesWebsockets !== "disabled")
    ) {
      continue;
    }
    const reason = readStringValue(entry.reason);
    const observedAt = readStringValue(entry.observedAt);
    const source = readStringValue(entry.source);
    const lastEventId = readStringValue(entry.lastEventId);
    const lastThreadId = readStringValue(entry.lastThreadId);
    const lastTurnId = readStringValue(entry.lastTurnId);
    const failureCount =
      typeof entry.failureCount === "number" && Number.isFinite(entry.failureCount)
        ? Math.max(0, Math.floor(entry.failureCount))
        : undefined;
    const parsedEntry = {
      responsesWebsockets: entry.responsesWebsockets,
      ...(reason ? { reason } : {}),
      ...(observedAt ? { observedAt } : {}),
      ...(source ? { source } : {}),
      ...(lastEventId ? { lastEventId } : {}),
      ...(lastThreadId ? { lastThreadId } : {}),
      ...(lastTurnId ? { lastTurnId } : {}),
      ...(failureCount !== undefined ? { failureCount } : {}),
    } satisfies CodexTransportPolicyEntry;
    instances[key] = parsedEntry;
  }
  return { version: 1, instances };
}

function toRuntimeTransportPolicy(
  entry: CodexTransportPolicyEntry | undefined,
): CodexTransportPolicy | undefined {
  if (entry?.responsesWebsockets !== "disabled") {
    return undefined;
  }
  return {
    responsesWebsockets: "disabled",
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.observedAt ? { observedAt: entry.observedAt } : {}),
  };
}

const loadCodexTransportPolicy = Effect.fn("loadCodexTransportPolicy")(function* (
  filePath: string,
  key: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false)))) {
    return undefined;
  }
  const loaded = yield* fileSystem.readFileString(filePath).pipe(
    Effect.flatMap((contents) =>
      Effect.try({
        try: () => parseCodexTransportPolicyFile(JSON.parse(contents)),
        catch: (cause) => new CodexTransportPolicyFileError({ cause }),
      }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("codex.transportPolicy.loadFailed", {
        filePath,
        detail: cause instanceof Error ? cause.message : String(cause),
      }).pipe(Effect.as(undefined)),
    ),
  );
  return loaded?.instances[key];
});

function persistCodexTransportPolicy(
  path: Path.Path,
  filePath: string,
  key: string,
  entry: CodexTransportPolicyEntry,
): void {
  const existing = (() => {
    try {
      return parseCodexTransportPolicyFile(JSON.parse(NodeFs.readFileSync(filePath, "utf8")));
    } catch {
      return undefined;
    }
  })();
  const next: CodexTransportPolicyFile = {
    version: 1,
    instances: {
      ...existing?.instances,
      [key]: entry,
    },
  };

  const targetDirectory = path.dirname(filePath);
  const tempFileId = Crypto.randomUUID();
  const tempPath = path.join(targetDirectory, `${path.basename(filePath)}.${tempFileId}.tmp`);

  try {
    NodeFs.mkdirSync(targetDirectory, { recursive: true });
    NodeFs.writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    // This file is not a secret, but it influences process launch behavior.
    // Keep it user-private so other local users cannot force a transport mode.
    try {
      NodeFs.chmodSync(tempPath, 0o600);
    } catch {
      // Best-effort on filesystems that do not support POSIX modes.
    }
    NodeFs.renameSync(tempPath, filePath);
    try {
      NodeFs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort on filesystems that do not support POSIX modes.
    }
  } catch (error) {
    try {
      NodeFs.rmSync(tempPath, { force: true });
    } catch {
      // Ignore cleanup failures; the original write failure is more useful.
    }
    throw error;
  }
}

function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): ThreadTokenUsageSnapshot | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
    autoCompactTokenLimit: CODEX_DEFAULT_AUTO_COMPACT_TOKEN_LIMIT,
  };
}

function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "context_compaction":
      return "Context compaction";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function itemDetail(item: CodexLifecycleItem): string | undefined {
  const candidates = [
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions
    .map((question) => {
      const options =
        question.options
          ?.map((option) => {
            const label = trimText(option.label);
            const description = trimText(option.description);
            if (!label || !description) {
              return undefined;
            }
            return { label, description };
          })
          .filter((option) => option !== undefined) ?? [];

      const id = trimText(question.id);
      const header = trimText(question.header);
      const prompt = trimText(question.question);
      if (!id || !header || !prompt || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      };
    })
    .filter((question) => question !== undefined);

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item) {
    return undefined;
  }
  const itemType = toCanonicalItemType(item.type);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const detail = itemDetail(item);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(itemTitle(itemType) ? { title: itemTitle(itemType) } : {}),
      ...(detail ? { detail } : {}),
      ...(event.payload !== undefined ? { data: event.payload } : {}),
    },
  };
}

function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);
      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );
          return payload?.command ?? payload?.reason ?? undefined;
        }
        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );
          return payload?.reason ?? payload?.command.join(" ");
        }
        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );
          return payload?.tool ?? undefined;
        }
        default:
          return undefined;
      }
    })();

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = readPayload(ApprovalDecisionPayload, event.payload);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(payload ? { decision: payload.decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "starting",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/ready") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.state.changed",
        payload: {
          state: "ready",
          ...(event.message ? { reason: event.message } : {}),
        },
      },
    ];
  }

  if (event.method === "session/started") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.started",
        payload: {
          ...(event.message ? { message: event.message } : {}),
          ...(event.payload !== undefined ? { resume: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "session.exited",
        payload: {
          ...(event.message ? { reason: event.message } : {}),
          ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/started") {
    const payload = readPayload(EffectCodexSchema.V2ThreadStartedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "thread.started",
        payload: {
          providerThreadId: payload.thread.id,
        },
      },
    ];
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    const payload =
      event.method === "thread/status/changed"
        ? readPayload(EffectCodexSchema.V2ThreadStatusChangedNotification, event.payload)
        : undefined;
    return [
      {
        type: "thread.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state:
            event.method === "thread/archived"
              ? "archived"
              : event.method === "thread/closed"
                ? "closed"
                : event.method === "thread/compacted"
                  ? "compacted"
                  : payload
                    ? toThreadState(payload.status)
                    : "active",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/name/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadNameUpdatedNotification, event.payload);
    return [
      {
        type: "thread.metadata.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          ...(trimText(payload?.threadName) ? { name: trimText(payload?.threadName) } : {}),
          ...(payload
            ? {
                metadata: {
                  threadId: payload.threadId,
                  ...(payload.threadName !== undefined && payload.threadName !== null
                    ? { threadName: payload.threadName }
                    : {}),
                },
              }
            : {}),
        },
      },
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
      event.payload,
    );
    const normalizedUsage = payload ? normalizeCodexTokenUsage(payload.tokenUsage) : undefined;
    if (!normalizedUsage) {
      return [];
    }
    return [
      {
        type: "thread.token-usage.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          usage: normalizedUsage,
        },
      },
    ];
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        turnId,
        type: "turn.started",
        payload: {},
      },
    ];
  }

  if (event.method === "turn/completed") {
    const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
    if (!payload) {
      return [];
    }
    const errorMessage = trimText(payload.turn.error?.message);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.completed",
        payload: {
          state: toTurnStatus(payload.turn.status),
          ...(errorMessage ? { errorMessage } : {}),
        },
      },
    ];
  }

  if (event.method === "turn/aborted") {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.aborted",
        payload: {
          reason: event.message ?? "Turn aborted",
        },
      },
    ];
  }

  if (event.method === "turn/plan/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnPlanUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.plan.updated",
        payload: {
          ...(trimText(payload.explanation) ? { explanation: trimText(payload.explanation) } : {}),
          plan: payload.plan.map((step) => ({
            step: trimText(step.step) ?? "step",
            status:
              step.status === "completed" || step.status === "inProgress" ? step.status : "pending",
          })),
        },
      },
    ];
  }

  if (event.method === "turn/diff/updated") {
    const payload = readPayload(EffectCodexSchema.V2TurnDiffUpdatedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.diff.updated",
        payload: {
          unifiedDiff: payload.diff,
        },
      },
    ];
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
    const item = payload?.item;
    if (!item) {
      return [];
    }
    const itemType = toCanonicalItemType(item.type);
    if (itemType === "plan") {
      const detail = itemDetail(item);
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    return completed ? [completed] : [];
  }

  if (
    event.method === "item/reasoning/summaryPartAdded" ||
    event.method === "item/commandExecution/terminalInteraction"
  ) {
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "item.updated",
        payload: {
          itemType:
            event.method === "item/reasoning/summaryPartAdded" ? "reasoning" : "command_execution",
          ...(event.payload !== undefined ? { data: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/plan/delta") {
    const payload = readPayload(EffectCodexSchema.V2PlanDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "turn.proposed.delta",
        payload: {
          delta,
        },
      },
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    const payload = readPayload(EffectCodexSchema.V2AgentMessageDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: contentStreamKindFromMethod(event.method),
          delta,
        },
      },
    ];
  }

  if (event.method === "item/commandExecution/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2CommandExecutionOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "command_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/fileChange/outputDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2FileChangeOutputDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "file_change_output",
          delta,
        },
      },
    ];
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    const payload = readPayload(
      EffectCodexSchema.V2ReasoningSummaryTextDeltaNotification,
      event.payload,
    );
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_summary_text",
          delta,
          ...(payload ? { summaryIndex: payload.summaryIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/reasoning/textDelta") {
    const payload = readPayload(EffectCodexSchema.V2ReasoningTextDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "content.delta",
        payload: {
          streamKind: "reasoning_text",
          delta,
          ...(payload ? { contentIndex: payload.contentIndex } : {}),
        },
      },
    ];
  }

  if (event.method === "item/mcpToolCall/progress") {
    const payload = readPayload(EffectCodexSchema.V2McpToolCallProgressNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "tool.progress",
        payload: {
          summary: payload.message,
        },
      },
    ];
  }

  if (event.method === "serverRequest/resolved") {
    const payload = readPayload(
      EffectCodexSchema.V2ServerRequestResolvedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const requestType = toRequestTypeFromKind(event.requestKind);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    const payload = readPayload(EffectCodexSchema.ToolRequestUserInputResponse, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "user-input.resolved",
        payload: {
          answers: toCanonicalUserInputAnswers(payload.answers),
        },
      },
    ];
  }

  if (event.method === "model/rerouted") {
    const payload = readPayload(EffectCodexSchema.V2ModelReroutedNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "model.rerouted",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          fromModel: payload.fromModel,
          toModel: payload.toModel,
          reason: payload.reason,
        },
      },
    ];
  }

  if (event.method === "turn/moderationMetadata") {
    // Upstream Codex rust-v0.141.0 marks this notification experimental and the
    // TUI routes it to the thread but does not render it in chat. Do the same
    // and avoid persisting arbitrary moderation metadata into work-log/debug
    // activity payloads.
    return [];
  }

  if (event.method === "deprecationNotice") {
    const payload = readPayload(EffectCodexSchema.V2DeprecationNoticeNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "deprecation.notice",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
        },
      },
    ];
  }

  if (event.method === "configWarning") {
    const payload = readPayload(EffectCodexSchema.V2ConfigWarningNotification, event.payload);
    if (!payload) {
      return [];
    }
    return [
      {
        type: "config.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          summary: payload.summary,
          ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
          ...(trimText(payload.path) ? { path: trimText(payload.path) } : {}),
          ...(payload.range !== undefined && payload.range !== null
            ? { range: payload.range }
            : {}),
        },
      },
    ];
  }

  if (event.method === "account/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          account: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "account/rateLimits/updated") {
    if (!readPayload(EffectCodexSchema.V2AccountRateLimitsUpdatedNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "account.rate-limits.updated",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          rateLimits: event.payload ?? {},
        },
      },
    ];
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    const payload = readPayload(
      EffectCodexSchema.V2McpServerOauthLoginCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "mcp.oauth.completed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          success: payload.success,
          name: payload.name,
          ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
        },
      },
    ];
  }

  if (event.method === "thread/realtime/started") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeStartedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.started",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          realtimeSessionId: payload.realtimeSessionId ?? undefined,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/itemAdded") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeItemAddedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.item-added",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          item: payload.item,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    return [
      {
        type: "thread.realtime.audio.delta",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          audio: payload.audio,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/error") {
    const payload = readPayload(EffectCodexSchema.V2ThreadRealtimeErrorNotification, event.payload);
    const message = payload?.message ?? event.message ?? "Realtime error";
    return [
      {
        type: "thread.realtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
        },
      },
    ];
  }

  if (event.method === "thread/realtime/closed") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeClosedNotification,
      event.payload,
    );
    return [
      {
        type: "thread.realtime.closed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          reason: payload?.reason ?? event.message,
        },
      },
    ];
  }

  if (event.method === "error") {
    const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
    const message = payload?.error.message ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      {
        type: willRetry ? "runtime.warning" : "runtime.error",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(!willRetry ? { class: "provider_error" as const } : {}),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (
    event.method === "codex.turnStart/noRuntimeEventYet" ||
    event.method === "codex.turnSteer/noProviderItemYet" ||
    event.method === "codex.turnProgress/stillInProgressAfterSnapshotPolling"
  ) {
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message:
            event.message ??
            (event.method === "codex.turnStart/noRuntimeEventYet"
              ? "Codex app-server accepted turn/start but has not emitted a turn event yet."
              : event.method === "codex.turnSteer/noProviderItemYet"
                ? "Codex app-server accepted turn/steer but has not emitted the steer user message yet."
                : "Codex still reports the active turn as in progress after delayed snapshot polling."),
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "codex.turnStart/accepted") {
    return [
      {
        type: "task.progress",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          taskId: RuntimeTaskId.make(`codex-turn-start:${event.turnId ?? event.id}`),
          description: event.message ?? "Codex app-server accepted turn/start.",
          ...(event.payload !== undefined ? { usage: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "codex.turnSteer/accepted") {
    return [
      {
        type: "task.progress",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          taskId: RuntimeTaskId.make(`codex-turn-steer:${event.turnId ?? event.id}`),
          description: event.message ?? "Codex app-server accepted turn/steer.",
          ...(event.payload !== undefined ? { usage: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "codex.turnSteer/processingStarted") {
    return [
      {
        type: "task.progress",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          taskId: RuntimeTaskId.make(`codex-turn-steer-processing:${event.turnId ?? event.id}`),
          description: event.message ?? "Codex app-server began processing turn/steer.",
          ...(event.payload !== undefined ? { usage: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "codex.turnSteer/retryAfterActiveTurnMismatch") {
    return [
      {
        type: "task.progress",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          taskId: RuntimeTaskId.make(`codex-turn-steer-retry:${event.turnId ?? event.id}`),
          description:
            event.message ??
            "Codex app-server reported a newer active turn; Cafe retried turn/steer with that turn id.",
          ...(event.payload !== undefined ? { usage: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "codex.transportPolicy/applied") {
    return [
      {
        type: "task.progress",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          taskId: RuntimeTaskId.make(`codex-transport-policy:${event.id}`),
          description:
            event.message ??
            "Codex app-server started with Responses WebSockets disabled after fallback.",
          ...(event.payload !== undefined ? { usage: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "warning") {
    const message = readPayloadMessage(event) ?? "Codex runtime warning";
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "process/stderr") {
    if (isCodexResponsesWebsocketStderrDiagnostic(event)) {
      return [];
    }
    if (isCodexLowValueMetadataStderrWarning(event)) {
      return [];
    }
    const message = event.message ?? "Codex process stderr";
    // Keep generic stderr diagnostic output as a non-fatal warning. Actual provider failure
    // still comes from Codex's structured `error` notification with `willRetry: false`,
    // process exit, or terminal turn events.
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    if (!readPayload(EffectCodexSchema.V2WindowsWorldWritableWarningNotification, event.payload)) {
      return [];
    }
    return [
      {
        type: "runtime.warning",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          message: event.message ?? "Windows world-writable warning",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payload = readPayload(
      EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: payload.success === false ? "error" : "ready",
          reason: payload.success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(payload.success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}

/**
 * Build a Codex provider adapter bound to a specific `CodexSettings` payload.
 *
 * The adapter is a captured closure over `codexConfig` — the `binaryPath` and
 * `homePath` are read from that payload, not from `ServerSettingsService`.
 * This is what makes multi-instance routing possible: each `ProviderInstance`
 * in the registry owns its own closure with its own config, so two Codex
 * instances with different `homePath`s cannot step on each other.
 */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  codexConfig: CodexSettings,
  options?: CodexAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("codex");
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);
  const transportPolicyPath = path.join(serverConfig.stateDir, CODEX_TRANSPORT_POLICY_FILENAME);
  const transportPolicyKey = codexTransportPolicyKey({
    instanceId: boundInstanceId,
    binaryPath: codexConfig.binaryPath,
    ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
  });
  const transportPolicyPersistenceEnabled = isCodexTransportPolicyPersistenceEnabled(
    options?.environment ?? process.env,
  );
  const initialTransportPolicy = transportPolicyPersistenceEnabled
    ? yield* loadCodexTransportPolicy(transportPolicyPath, transportPolicyKey)
    : undefined;
  const transportPolicyRef = yield* Ref.make<CodexTransportPolicyEntry | undefined>(
    initialTransportPolicy,
  );
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CodexAdapterSessionContext>();
  const prepareRuntimeHome = options?.prepareRuntimeHome ?? Effect.void;

  const prepareRuntimeHomeForSession = Effect.fn("CodexAdapter.prepareRuntimeHomeForSession")(
    function* (threadId: ThreadId, operation: string) {
      yield* prepareRuntimeHome.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Failed to refresh Codex home before ${operation}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            }),
        ),
      );
    },
  );

  const prepareRuntimeHomeForRequest = Effect.fn("CodexAdapter.prepareRuntimeHomeForRequest")(
    function* (threadId: ThreadId, method: string) {
      yield* prepareRuntimeHome.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method,
              detail: `Failed to refresh Codex home before ${method}: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            }),
        ),
      );
    },
  );

  const disableResponsesWebsocketsFromEvent = (event: ProviderEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const observedAt = DateTime.formatIso(yield* DateTime.now);
      if (!transportPolicyPersistenceEnabled) {
        // Upstream Codex 0.141.0 keeps Responses WebSocket fallback as
        // session-scoped runtime state: the built-in OpenAI provider still has
        // `supports_websockets = true`, and the fallback flag sticks inside the
        // live session after the official warning. Cafe used to persist this
        // across backend/app-server restarts, which meant a single historical
        // disconnect could permanently launch future Codex sessions with a
        // Cafe-scoped HTTP-only provider. That diverges from the TUI and can
        // make current-provider behavior impossible to compare with upstream.
        yield* Effect.logWarning("codex.transportPolicy.responsesWebsocketsFallbackObserved", {
          instanceId: boundInstanceId,
          reason: CODEX_WEBSOCKET_FALLBACK_REASON,
          observedAt,
          threadId: event.threadId,
          turnId: event.turnId,
          eventId: event.id,
          persistence: "disabled",
          semantics:
            "Cafe matches upstream Codex TUI by leaving fallback scoped to the live app-server session. Set CAFE_CODE_PERSIST_CODEX_HTTP_FALLBACK=1 only for local diagnostics that intentionally force future launches onto HTTPS.",
        });
        return;
      }

      const previous = yield* Ref.get(transportPolicyRef);
      const next: CodexTransportPolicyEntry = {
        responsesWebsockets: "disabled",
        reason: CODEX_WEBSOCKET_FALLBACK_REASON,
        observedAt,
        source: "codex.app-server",
        lastEventId: event.id,
        lastThreadId: event.threadId,
        ...(event.turnId ? { lastTurnId: event.turnId } : {}),
        failureCount: (previous?.failureCount ?? 0) + 1,
      };

      yield* Ref.set(transportPolicyRef, next);
      yield* Effect.try({
        try: () => persistCodexTransportPolicy(path, transportPolicyPath, transportPolicyKey, next),
        catch: (cause) => new CodexTransportPolicyFileError({ cause }),
      }).pipe(
        Effect.tap(() =>
          Effect.logWarning("codex.transportPolicy.responsesWebsocketsDisabled", {
            instanceId: boundInstanceId,
            reason: next.reason,
            observedAt,
            threadId: event.threadId,
            turnId: event.turnId,
            eventId: event.id,
          }),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("codex.transportPolicy.persistFailed", {
            instanceId: boundInstanceId,
            filePath: transportPolicyPath,
            detail: cause.message,
          }),
        ),
      );

      const session = sessions.get(event.threadId);
      if (session && !session.stopped && !session.transportPolicyApplied) {
        // Codex should switch this in-flight app-server session to HTTP after
        // emitting the official fallback warning, but older already-running
        // sessions can still surface later reconnect warnings. Retiring only
        // after the terminal turn event preserves the current response while
        // making the next provider turn resume under Cafe's persisted
        // `supports_websockets = false` launch policy.
        session.pendingTransportPolicyRetirement = {
          fallbackEventId: event.id,
          observedAt,
          reason: next.reason ?? CODEX_WEBSOCKET_FALLBACK_REASON,
        };
        yield* Effect.logWarning("codex.transportPolicy.sessionRetirePending", {
          instanceId: boundInstanceId,
          threadId: event.threadId,
          turnId: event.turnId,
          eventId: event.id,
          reason: session.pendingTransportPolicyRetirement.reason,
        });
      }
    });

  const retireSession = Effect.fn("CodexAdapter.retireSession")(function* (
    threadId: ThreadId,
    reason: string,
    diagnosticName: string,
  ) {
    const session = sessions.get(threadId);
    if (!session || session.stopped) {
      return;
    }

    session.stopped = true;
    sessions.delete(threadId);
    yield* Effect.logWarning(diagnosticName, {
      threadId,
      reason,
    });

    yield* session.runtime.close.pipe(Effect.ignore);
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    yield* Effect.forkChild(
      Effect.yieldNow.pipe(Effect.andThen(Fiber.interrupt(session.eventFiber).pipe(Effect.ignore))),
    );
  });

  const retireExitedSession = (threadId: ThreadId, reason: string): Effect.Effect<void> =>
    retireSession(threadId, reason, "codex.session.retired-after-runtime-exit");

  const retireSessionAfterTransportFallback = (
    threadId: ThreadId,
    reason: string,
  ): Effect.Effect<void> =>
    retireSession(threadId, reason, "codex.session.retired-after-transport-fallback");

  const startSession: CodexAdapterShape["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* Effect.suspend(() => stopSessionInternal(existing));
        }

        yield* prepareRuntimeHomeForSession(input.threadId, "startSession");

        const currentTransportPolicy = toRuntimeTransportPolicy(yield* Ref.get(transportPolicyRef));
        const runtimeInput: CodexSessionRuntimeOptions = {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          cwd: input.cwd ?? process.cwd(),
          ...(input.additionalDirectories !== undefined
            ? { additionalDirectories: input.additionalDirectories }
            : {}),
          binaryPath: codexConfig.binaryPath,
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
          ...(isCodexResumeCursorSchema(input.resumeCursor)
            ? { resumeCursor: input.resumeCursor }
            : {}),
          runtimeMode: input.runtimeMode,
          ...(input.modelSelection?.instanceId === boundInstanceId
            ? { model: input.modelSelection.model }
            : {}),
          ...(input.modelSelection?.instanceId === boundInstanceId &&
          getModelSelectionBooleanOptionValue(input.modelSelection, "fastMode") === true
            ? { serviceTier: "fast" }
            : {}),
          ...(currentTransportPolicy !== undefined
            ? { transportPolicy: currentTransportPolicy }
            : {}),
        };
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const createRuntime = options?.makeRuntime ?? makeCodexSessionRuntime;
        const runtime = yield* createRuntime(runtimeInput).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("codex.runtime.bridge.native-log-write-failed", {
                  ...bridgeEventLogContext(event, {
                    stage: "native-log",
                    cause: Cause.pretty(cause),
                  }),
                }),
              ),
            );

            const runtimeEvents = yield* Effect.sync(() =>
              mapToRuntimeEvents(event, event.threadId),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("codex.runtime.bridge.map-failed", {
                  ...bridgeEventLogContext(event, {
                    stage: "map",
                    cause: Cause.pretty(cause),
                  }),
                }).pipe(Effect.as([] as ReadonlyArray<ProviderRuntimeEvent>)),
              ),
            );

            if (runtimeEvents.length === 0) {
              const context = bridgeEventLogContext(event, {
                stage: "map",
                runtimeEvents,
              });
              if (shouldAuditCodexBridgeEvent(event)) {
                yield* Effect.logWarning("codex.runtime.bridge.important-event-unmapped", context);
              } else {
                yield* Effect.logDebug("ignoring unhandled Codex provider event", context);
              }
              return;
            }
            if (isCodexResponsesWebsocketFallbackEvent(event)) {
              yield* disableResponsesWebsocketsFromEvent(event);
            }
            const enqueued = yield* Queue.offerAll(runtimeEventQueue, runtimeEvents).pipe(
              Effect.as(true),
              Effect.catchCause((cause) =>
                Effect.logWarning("codex.runtime.bridge.enqueue-failed", {
                  ...bridgeEventLogContext(event, {
                    stage: "enqueue",
                    runtimeEvents,
                    cause: Cause.pretty(cause),
                  }),
                }).pipe(Effect.as(false)),
              ),
            );
            if (enqueued && shouldAuditCodexBridgeEvent(event)) {
              yield* Effect.logDebug("codex.runtime.bridge.enqueued", {
                ...bridgeEventLogContext(event, {
                  stage: "enqueue",
                  runtimeEvents,
                }),
              });
            }
            if (isCodexAuthInvalidatedEvent(event)) {
              yield* prepareRuntimeHome.pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning("codex.home.authRefreshAfterInvalidationFailed", {
                    instanceId: boundInstanceId,
                    threadId: event.threadId,
                    turnId: event.turnId,
                    detail: cause instanceof Error ? cause.message : String(cause),
                  }),
                ),
                Effect.ignore,
              );
              yield* retireSession(
                event.threadId,
                "Codex reported an invalidated OAuth token; refreshed the shadow auth copy and retired the app-server so the next turn starts with current login material.",
                "codex.session.retired-after-auth-invalidation",
              );
              return;
            }
            if (isCodexTurnTerminalEvent(event)) {
              const session = sessions.get(event.threadId);
              const pendingRetirement = session?.pendingTransportPolicyRetirement;
              if (session && !session.stopped && pendingRetirement !== undefined) {
                yield* retireSessionAfterTransportFallback(
                  event.threadId,
                  `Codex Responses WebSocket fallback was observed at ${pendingRetirement.observedAt}; restarting future turns with HTTP Responses transport. Fallback event: ${pendingRetirement.fallbackEventId}.`,
                );
                return;
              }
            }
            if (event.method === "session/exited" || event.method === "session/closed") {
              yield* retireExitedSession(
                event.threadId,
                event.message ?? `${event.method} received from Codex runtime`,
              );
            }
          }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.failCause(cause);
              }
              return Effect.logWarning("codex.runtime.bridge.event-failed", {
                ...bridgeEventLogContext(event, {
                  stage: "event",
                  cause: Cause.pretty(cause),
                }),
              });
            }),
          ),
        ).pipe(
          // This bridge is the only path from the Codex runtime's native
          // event queue into the provider daemon journal. It must be owned by
          // the durable session scope, not by the short-lived `startSession`
          // caller scope, otherwise a session can accept `turn/start` and then
          // silently strand every later assistant/token/tool event in the
          // runtime queue.
          Effect.forkIn(sessionScope),
        );

        const started = yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
              Effect.andThen(Fiber.interrupt(eventFiber)),
              Effect.ignore,
            ),
          ),
        );

        sessions.set(input.threadId, {
          threadId: input.threadId,
          scope: sessionScope,
          runtime,
          eventFiber,
          transportPolicyApplied: currentTransportPolicy?.responsesWebsockets === "disabled",
          stopped: false,
        });
        sessionScopeTransferred = true;

        return started;
      }),
    );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    method: "turn/start" | "turn/steer",
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: `Failed to read attachment file: ${cause.message}.`,
            cause,
          }),
      ),
    );
    return {
      type: "image" as const,
      url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    yield* prepareRuntimeHomeForRequest(input.threadId, "turn/start");

    const codexAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment("turn/start", attachment),
      { concurrency: 1 },
    );

    const session = yield* requireSession(input.threadId);
    const reasoningEffort =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
        : undefined;
    const fastMode =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionBooleanOptionValue(input.modelSelection, "fastMode")
        : undefined;
    return yield* session.runtime
      .sendTurn({
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        ...(reasoningEffort
          ? {
              effort: reasoningEffort as EffectCodexSchema.V2TurnStartParams__ReasoningEffort,
            }
          : {}),
        ...(fastMode === true ? { serviceTier: "fast" } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
      })
      .pipe(Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/start", cause)));
  });

  const steerTurn: CodexAdapterShape["steerTurn"] = Effect.fn("steerTurn")(function* (input) {
    yield* prepareRuntimeHomeForRequest(input.threadId, "turn/steer");

    const codexAttachments = yield* Effect.forEach(
      input.attachments ?? [],
      (attachment) => resolveAttachment("turn/steer", attachment),
      { concurrency: 1 },
    );

    const session = yield* requireSession(input.threadId);
    return yield* session.runtime
      .steerTurn({
        expectedTurnId: input.expectedTurnId,
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
      })
      .pipe(Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/steer", cause)));
  });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!session || session.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return session;
  });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    Effect.gen(function* () {
      const session = yield* requireSession(threadId);
      yield* session.runtime.interruptTurn(turnId);
      // Codex app-server can remain superficially healthy after an interrupt:
      // it may still ACK a later `turn/start` while never delivering the
      // provider-side item stream for that new turn. Upstream Codex persists
      // thread state independently of the app-server process, and
      // ProviderService keeps the durable resume cursor in its session binding,
      // so retiring the local process after a successful interrupt preserves
      // the conversation while preventing a poisoned app-server stream from
      // being reused for the user's next intent.
      yield* retireSession(
        threadId,
        "Codex turn interrupted; retiring app-server so the next turn resumes through a fresh process.",
        "codex.session.retired-after-turn-interrupt",
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "turn/interrupt", cause),
      ),
    );

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.readThread),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/read", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.rollbackThread(numTurns)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/rollback", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToRequest(requestId, decision)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/requestApproval/decision", cause),
      ),
    );

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToUserInput(requestId, answers)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/tool/requestUserInput", cause),
      ),
    );

  const writeNativeEvent = Effect.fn("writeNativeEvent")(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    session: CodexAdapterSessionContext,
  ) {
    if (session.stopped) {
      return;
    }
    session.stopped = true;
    sessions.delete(session.threadId);
    yield* session.runtime.close.pipe(Effect.ignore);
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
  });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const session = sessions.get(threadId);
      if (!session) {
        return;
      }
      yield* stopSessionInternal(session);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(sessions.values()).filter((session) => !session.stopped),
      (session) => session.runtime.getSession,
      { concurrency: 1 },
    );

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) =>
    Effect.succeed(Boolean(sessions.get(threadId) && !sessions.get(threadId)?.stopped));

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.forEach(Array.from(sessions.values()), stopSessionInternal, {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(managedNativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
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
  } satisfies CodexAdapterShape;
});

// NOTE: the old `CodexAdapterLive` / `makeCodexAdapterLive` singleton Layer
// exports have been removed as part of the per-instance-driver refactor.
// `makeCodexAdapter(codexConfig, options?)` is now invoked directly by
// `CodexDriver.create()` for each configured instance; downstream consumers
// (server bootstrap, integration harness, this module's tests) will be
// migrated to the registry in a follow-up pass.
