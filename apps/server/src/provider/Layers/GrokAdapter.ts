// @effect-diagnostics nodeBuiltinImport:off
import * as NodeConstants from "node:constants";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeTimers from "node:timers/promises";

import {
  ApprovalRequestId,
  type GrokSettings,
  EventId,
  type ProviderApprovalDecision,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderThreadGoal,
  type ProviderThreadGoalSetInput,
  type ProviderSteerTurnInput,
  type ProviderUserInputAnswers,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@cafecode/contracts";
import type { AuthSessionId } from "@cafecode/contracts/auth";
import { getModelSelectionStringOptionValue } from "@cafecode/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { prepareFileAttachmentPrompt } from "../fileAttachmentPrompt.ts";
import type { SessionCredentialServiceShape } from "../../auth/Services/SessionCredentialService.ts";
import { readProviderMcpCredentialIssuer } from "../../auth/ProviderMcpCredentialBroker.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  grokPermissionModeForRuntimeMode,
  grokSandboxProfileForRuntimeMode,
  makeGrokAcpRuntime,
  readGrokAcpSessionModelMetadata,
  resolveGrokAcpBaseModelId,
  type GrokSandboxProfile,
} from "../acp/GrokAcpSupport.ts";
import {
  extractXAiExitPlanModeParams,
  extractXAiAskUserQuestions,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  promptResponseHasMissingXAiStopReason,
  XAiAskUserQuestionRequest,
  XAiExitPlanModeRequest,
  XAiExitPlanModeResponse,
  XAiInterjectResponse,
  XAiRewindExecuteResponse,
  XAiRewindPointsResponse,
  XAiSessionUsageResponse,
} from "../acp/XAiAcpExtension.ts";
import { readGrokLastCallUsageFromUnifiedLog } from "../grokContextUsageLog.ts";
import { type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeXAiSessionUsageResponse = Schema.decodeUnknownEffect(XAiSessionUsageResponse);
const decodeXAiInterjectResponse = Schema.decodeUnknownEffect(XAiInterjectResponse);
const decodeXAiRewindPointsResponse = Schema.decodeUnknownEffect(XAiRewindPointsResponse);
const decodeXAiRewindExecuteResponse = Schema.decodeUnknownEffect(XAiRewindExecuteResponse);

const PROVIDER = ProviderDriverKind.make("grok");
const GROK_RESUME_VERSION = 1 as const;
const GROK_GOAL_STATE_MAX_BYTES = 256 * 1024;
const GROK_GOAL_STATE_READ_ATTEMPTS = 12;
const GROK_GOAL_STATE_READ_RETRY_DELAY_MS = 10;
const GROK_GOAL_STATE_WAIT_ATTEMPTS = 80;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface GrokAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
  /** Owner-scoped credential issuer used only for the loopback Cafe MCP endpoint. */
  readonly sessionCredentials?: Pick<SessionCredentialServiceShape, "issue" | "revoke">;
}

export function resolveGrokCafeMcpUrl(
  config: Pick<ServerConfigShape, "port" | "cafeMcpPort">,
): string {
  return `http://127.0.0.1:${config.cafeMcpPort ?? config.port}/mcp`;
}

const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError(
      (cause) =>
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed to process Grok ACP callback.",
          cause,
        }),
    ),
  );

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface GrokSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly sandboxProfile: GrokSandboxProfile;
  readonly mcpAuthSessionId: AuthSessionId | undefined;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  /** Turns already interrupted; late prompt RPCs must not resurrect them. */
  interruptedTurnIds: Set<TurnId>;
  /** Number of sendTurn prompts currently in flight or being prepared.
   * >0 means a turn is actively running, so a new sendTurn is a steer that
   * continues it, and only the last remaining prompt settles the turn. */
  promptsInFlight: number;
  currentModelId: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly maxTokens: number | undefined;
  readonly goalStatePath: string;
  readonly unifiedLogPath: string;
  /** Last provider-reported current-context occupancy. Unlike session usage,
   * this value may fall after Grok compacts its conversation. */
  lastContextTokens: number | undefined;
  /** Cumulative usage emitted to Cafe, including a resumed process offset. */
  usageOffset: GrokUsageTotals;
  lastUsage: GrokUsageTotals;
  stopped: boolean;
}

function normalizedGoalTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function grokGoalStatus(value: unknown): ProviderThreadGoal["status"] | undefined {
  switch (value) {
    case "active":
    case "paused":
    case "blocked":
    case "complete":
      return value;
    case "usage_limited":
    case "usageLimited":
      return "usageLimited";
    case "budget_limited":
    case "budgetLimited":
      return "budgetLimited";
    default:
      return undefined;
  }
}

async function readBoundedNonSymlinkFile(filePath: string): Promise<string | null> {
  let handle: NodeFS.FileHandle | undefined;
  try {
    handle = await NodeFS.open(filePath, NodeConstants.O_RDONLY | NodeConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("Grok goal state is not a regular file.");
    }
    if (stat.size > GROK_GOAL_STATE_MAX_BYTES) {
      throw new Error("Grok goal state exceeds the safe size limit.");
    }

    /* The provider owns this file and can replace its contents after stat().
       Read at most MAX+1 bytes from the already no-followed descriptor so an
       attacker (or a broken provider) cannot win that race and make Cafe
       allocate an unbounded file. Regular files may short-read, so fill the
       fixed buffer until EOF or the hard limit is proven exceeded. */
    const bytes = Buffer.allocUnsafe(GROK_GOAL_STATE_MAX_BYTES + 1);
    let bytesReadTotal = 0;
    while (bytesReadTotal < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        bytesReadTotal,
        bytes.length - bytesReadTotal,
        bytesReadTotal,
      );
      if (bytesRead === 0) break;
      bytesReadTotal += bytesRead;
    }
    if (bytesReadTotal > GROK_GOAL_STATE_MAX_BYTES) {
      throw new Error("Grok goal state exceeded the safe size limit while being read.");
    }
    return bytes.toString("utf8", 0, bytesReadTotal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  } finally {
    await handle?.close();
  }
}

async function readGrokGoalStateFile(
  ctx: Pick<GrokSessionContext, "goalStatePath" | "threadId">,
): Promise<ProviderThreadGoal | null> {
  for (let attempt = 1; ; attempt += 1) {
    const raw = await readBoundedNonSymlinkFile(ctx.goalStatePath);
    if (raw === null) return null;

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        throw new Error("Grok goal state has an invalid structure.");
      }
      const objective = typeof parsed.objective === "string" ? parsed.objective.trim() : "";
      const status = grokGoalStatus(parsed.status);
      if (!objective || !status) {
        throw new Error("Grok goal state is missing required fields.");
      }
      const now = new Date().toISOString();
      const createdAt = normalizedGoalTimestamp(parsed.created_at, now);
      const updatedAt = normalizedGoalTimestamp(parsed.updated_at, createdAt);
      const tokenBudget = nonNegativeFinite(parsed.token_budget);
      return {
        threadId: ctx.threadId,
        objective,
        status,
        tokenBudget: tokenBudget > 0 ? Math.floor(tokenBudget) : null,
        tokensUsed: Math.floor(nonNegativeFinite(parsed.tokens_used_high_water)),
        timeUsedSeconds: Math.floor(nonNegativeFinite(parsed.elapsed_ms) / 1_000),
        createdAt,
        updatedAt,
      };
    } catch (cause) {
      /* Grok owns this file and currently rewrites it in place. A reader can
         therefore observe the short truncate/write window even though neither
         process has failed. Retry only JSON syntax failures, reopen with
         O_NOFOLLOW on every attempt, and preserve the final parse error after
         a small fixed budget so a persistently malformed or adversarial file
         still fails closed. */
      if (!(cause instanceof SyntaxError) || attempt >= GROK_GOAL_STATE_READ_ATTEMPTS) {
        throw cause;
      }
      await NodeTimers.setTimeout(GROK_GOAL_STATE_READ_RETRY_DELAY_MS);
    }
  }
}

interface GrokUsageTotals {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly durationMs: number;
}

const EMPTY_GROK_USAGE: GrokUsageTotals = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  durationMs: 0,
};

export function validateGrokImageAttachmentBytes(
  attachment: { readonly mimeType: string; readonly sizeBytes: number },
  actualByteLength: number,
): string | undefined {
  if (!attachment.mimeType.toLowerCase().startsWith("image/")) {
    return "The attachment is not a supported image payload.";
  }
  if (
    actualByteLength <= 0 ||
    actualByteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES ||
    actualByteLength !== attachment.sizeBytes
  ) {
    return "The stored image size no longer matches the validated attachment metadata.";
  }
  return undefined;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settlePendingUserInputsAsCancelled(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

function appendPromptResultToTurn(
  ctx: GrokSessionContext,
  turnId: TurnId,
  promptParts: ReadonlyArray<EffectAcpSchema.ContentBlock>,
  result: EffectAcpSchema.PromptResponse,
): void {
  const existingTurnRecord = ctx.turns.find((turn) => turn.id === turnId);
  ctx.turns = existingTurnRecord
    ? ctx.turns.map((turn) =>
        turn.id === turnId
          ? { ...turn, items: [...turn.items, { prompt: promptParts, result }] }
          : turn,
      )
    : [...ctx.turns, { id: turnId, items: [{ prompt: promptParts, result }] }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const resolveNotificationTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveCallbackTurnId = (ctx: GrokSessionContext): TurnId | undefined => ctx.activeTurnId;

const resolveSessionCallbackTurnId = (
  sessions: ReadonlyMap<ThreadId, GrokSessionContext>,
  threadId: ThreadId,
): TurnId | undefined => {
  const ctx = sessions.get(threadId);
  return ctx ? resolveCallbackTurnId(ctx) : undefined;
};

interface GrokResumeCursor {
  readonly schemaVersion: typeof GROK_RESUME_VERSION;
  readonly sessionId: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly sandboxProfile?: GrokSandboxProfile;
  readonly usage?: GrokUsageTotals;
  readonly lastContextTokens?: number;
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseGrokUsage(raw: unknown): GrokUsageTotals {
  if (!isRecord(raw)) return EMPTY_GROK_USAGE;
  const inputTokens = nonNegativeFinite(raw.inputTokens);
  const outputTokens = nonNegativeFinite(raw.outputTokens);
  const totalTokens = nonNegativeFinite(raw.totalTokens);
  return {
    totalTokens: totalTokens > 0 ? totalTokens : inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens: nonNegativeFinite(raw.cachedInputTokens),
    cacheWriteInputTokens: nonNegativeFinite(raw.cacheWriteInputTokens),
    reasoningOutputTokens: nonNegativeFinite(raw.reasoningOutputTokens),
    durationMs: nonNegativeFinite(raw.durationMs),
  };
}

function parseGrokResume(raw: unknown): GrokResumeCursor | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GROK_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  const sandboxProfile =
    raw.sandboxProfile === "read-only" ||
    raw.sandboxProfile === "workspace" ||
    raw.sandboxProfile === "off"
      ? raw.sandboxProfile
      : undefined;
  return {
    schemaVersion: GROK_RESUME_VERSION,
    sessionId: raw.sessionId.trim(),
    ...(typeof raw.model === "string" && raw.model.trim() ? { model: raw.model.trim() } : {}),
    ...(typeof raw.reasoningEffort === "string" && raw.reasoningEffort.trim()
      ? { reasoningEffort: raw.reasoningEffort.trim() }
      : {}),
    ...(sandboxProfile ? { sandboxProfile } : {}),
    ...(isRecord(raw.usage) ? { usage: parseGrokUsage(raw.usage) } : {}),
    ...(nonNegativeFinite(raw.lastContextTokens) > 0
      ? { lastContextTokens: nonNegativeFinite(raw.lastContextTokens) }
      : {}),
  };
}

const GROK_COMPACTION_MIN_TOKEN_DROP = 4_096;

/**
 * Grok 1.0.4 does not emit an ACP compaction notification. A completed model
 * call does expose current-context occupancy, though, so Cafe can detect the
 * one transition that cannot occur without a context rewrite: a substantial
 * decrease while session-cumulative processing continues to increase. The
 * floor avoids reporting small tokenizer/accounting corrections as compacts.
 */
export function didGrokContextCompact(input: {
  readonly previousContextTokens: number | undefined;
  readonly currentContextTokens: number;
  readonly previousProcessedTokens: number;
  readonly currentProcessedTokens: number;
}): boolean {
  if (
    input.previousContextTokens === undefined ||
    input.previousContextTokens <= 0 ||
    input.currentProcessedTokens <= input.previousProcessedTokens
  ) {
    return false;
  }
  const drop = input.previousContextTokens - input.currentContextTokens;
  return (
    drop >= GROK_COMPACTION_MIN_TOKEN_DROP &&
    input.currentContextTokens <= input.previousContextTokens * 0.9
  );
}

function makeGrokEffectiveModelSelection(input: {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly reasoningEffort?: string;
}): ModelSelection {
  return {
    instanceId: input.instanceId,
    model: input.model,
    ...(input.reasoningEffort
      ? { options: [{ id: "reasoningEffort", value: input.reasoningEffort }] }
      : {}),
  };
}

interface GrokLastCallUsage {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly reasoningOutputTokens: number;
}

/**
 * Grok 1.0.4 attaches last-model-call counters to the ACP prompt response.
 * These counters represent current context occupancy; the session usage
 * extension is cumulative throughput and must not drive Cafe's context meter.
 * `reasoningTokens` and cache reads are subsets of output/input respectively,
 * so neither is added to `totalTokens` a second time.
 */
export function readGrokPromptTokenUsage(
  response: EffectAcpSchema.PromptResponse,
): GrokLastCallUsage | undefined {
  const meta = isRecord(response._meta) ? response._meta : undefined;
  if (!meta) return undefined;
  const inputTokens = nonNegativeFinite(meta.inputTokens);
  const outputTokens = nonNegativeFinite(meta.outputTokens);
  const reportedTotalTokens = nonNegativeFinite(meta.totalTokens);
  const totalTokens = reportedTotalTokens > 0 ? reportedTotalTokens : inputTokens + outputTokens;
  if (totalTokens <= 0) return undefined;
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens: nonNegativeFinite(meta.cachedReadTokens),
    cacheWriteInputTokens: nonNegativeFinite(meta.cacheCreationTokens),
    reasoningOutputTokens: nonNegativeFinite(meta.reasoningTokens),
  };
}

function readGrokPromptId(response: EffectAcpSchema.PromptResponse): string | undefined {
  const meta = isRecord(response._meta) ? response._meta : undefined;
  const promptId = meta?.promptId ?? meta?.requestId;
  return typeof promptId === "string" && promptId.length > 0 ? promptId : undefined;
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "accept") ??
    selectPermissionOptionId(request, "acceptForSession")
  );
}

export function shouldAutoApproveGrokPermission(
  runtimeMode: "approval-required" | "auto-accept-edits" | "full-access",
  permissionKind: string,
  interactionMode: "default" | "plan" | "auto" = "default",
): boolean {
  return (
    interactionMode === "default" &&
    runtimeMode === "auto-accept-edits" &&
    (permissionKind === "edit" || permissionKind === "delete" || permissionKind === "move")
  );
}

function summarizeNativePayload(payload: unknown): Readonly<Record<string, unknown>> {
  if (payload === null) return { valueType: "null" };
  if (Array.isArray(payload)) return { valueType: "array", itemCount: payload.length };
  if (payload instanceof Uint8Array) {
    return { valueType: "bytes", byteLength: payload.byteLength };
  }
  if (typeof payload === "string") {
    return { valueType: "string", byteLength: Buffer.byteLength(payload) };
  }
  if (typeof payload !== "object") return { valueType: typeof payload };
  return { valueType: "object", fieldCount: Object.keys(payload).length };
}

function completedStopReasonFromPromptResponse(
  response: EffectAcpSchema.PromptResponse | undefined,
): EffectAcpSchema.StopReason | null {
  if (response === undefined || promptResponseHasMissingXAiStopReason(response)) {
    return null;
  }
  return response.stopReason;
}

export function grokPromptSettlementBelongsToContext(input: {
  readonly liveAcpSessionId: string;
  readonly expectedAcpSessionId: string;
  readonly liveActiveTurnId: TurnId | undefined;
  readonly liveSessionActiveTurnId: TurnId | undefined;
  readonly turnId: TurnId;
}): boolean {
  return (
    input.liveAcpSessionId === input.expectedAcpSessionId &&
    (input.liveActiveTurnId === input.turnId || input.liveSessionActiveTurnId === input.turnId)
  );
}

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("grok");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, GrokSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = Random.nextUUIDv4;
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const settlePromptInFlight = (
      threadId: ThreadId,
      turnId: TurnId,
      expectedAcpSessionId: string,
      options?: {
        readonly errorMessage?: string;
        readonly completedStopReason?: EffectAcpSchema.StopReason | null;
        readonly emitTurnCompletion?: boolean;
        /** Interrupt/cancel: drop every outstanding prompt slot and settle once. */
        readonly settleAllPrompts?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        const liveCtx = sessions.get(threadId);
        if (!liveCtx) {
          return;
        }
        const settlementBelongsToLiveContext = grokPromptSettlementBelongsToContext({
          liveAcpSessionId: liveCtx.acpSessionId,
          expectedAcpSessionId,
          liveActiveTurnId: liveCtx.activeTurnId,
          liveSessionActiveTurnId: liveCtx.session.activeTurnId,
          turnId,
        });
        if (!settlementBelongsToLiveContext) {
          // interruptTurn already consumed every prompt slot for this turn. A
          // late prompt result must neither emit a second terminal event nor
          // consume a slot belonging to a newer turn on the same ACP session.
          if (
            liveCtx.acpSessionId !== expectedAcpSessionId ||
            liveCtx.interruptedTurnIds.has(turnId)
          ) {
            return;
          }
          if (options?.emitTurnCompletion !== false) {
            if (options?.errorMessage !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: options.errorMessage,
                },
              });
            } else if (options?.completedStopReason !== undefined) {
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId,
                turnId,
                payload: {
                  state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: options.completedStopReason ?? null,
                },
              });
            }
          }
          return;
        }
        let settleTurnId = turnId;
        if (options?.settleAllPrompts) {
          liveCtx.promptsInFlight = 0;
          if (liveCtx.activeTurnId !== turnId && liveCtx.session.activeTurnId !== turnId) {
            const fallbackTurnId = liveCtx.activeTurnId ?? liveCtx.session.activeTurnId;
            if (!fallbackTurnId) {
              if (liveCtx.session.status === "running" || liveCtx.session.status === "connecting") {
                const updatedAt = yield* nowIso;
                const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
                liveCtx.activeTurnId = undefined;
                liveCtx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt,
                };
              }
              return;
            }
            settleTurnId = fallbackTurnId;
          }
        } else {
          const remainingPrompts = Math.max(0, liveCtx.promptsInFlight - 1);
          if (
            remainingPrompts > 0 ||
            liveCtx.activeTurnId !== settleTurnId ||
            liveCtx.session.activeTurnId !== settleTurnId
          ) {
            liveCtx.promptsInFlight = remainingPrompts;
            return;
          }
          liveCtx.promptsInFlight = remainingPrompts;
        }
        const updatedAt = yield* nowIso;
        const canEmitTurnCompletion =
          liveCtx.session.status === "running" || liveCtx.session.status === "connecting";
        const shouldEmitFailedTurn = options?.errorMessage !== undefined && canEmitTurnCompletion;
        const shouldEmitCompletedTurn =
          options?.completedStopReason !== undefined && canEmitTurnCompletion;
        const { activeTurnId: _activeTurnId, ...readySession } = liveCtx.session;
        liveCtx.activeTurnId = undefined;
        liveCtx.session = {
          ...readySession,
          status: "ready",
          updatedAt,
        };
        if (options?.emitTurnCompletion === false) {
          return;
        }
        if (shouldEmitFailedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: "failed",
              errorMessage: options.errorMessage,
            },
          });
        } else if (shouldEmitCompletedTurn) {
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId,
            turnId: settleTurnId,
            payload: {
              state: options.completedStopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: options.completedStopReason ?? null,
            },
          });
        }
      });

    const logNative = (threadId: ThreadId, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload: summarizeNativePayload(payload),
            },
          },
          threadId,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to write native Grok notification log.", {
            errorKind: cause.reasons[0]?._tag ?? "Unknown",
            threadId,
            method,
          }),
        ),
      );

    const emitPlanUpdate = (
      ctx: GrokSessionContext,
      turnId: TurnId | undefined,
      stamp: { readonly eventId: EventId; readonly createdAt: string },
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${turnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp,
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload,
            source: "acp.jsonrpc",
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GrokSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const readGoalState = (ctx: GrokSessionContext) =>
      Effect.tryPromise({
        try: () => readGrokGoalStateFile(ctx),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/goal/get",
            detail: "Grok goal state could not be read safely.",
            cause,
          }),
      });

    const emitGoalState = (ctx: GrokSessionContext, goal: ProviderThreadGoal | null) =>
      Effect.gen(function* () {
        yield* offerRuntimeEvent(
          goal
            ? {
                type: "thread.goal.updated",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                payload: { goal },
              }
            : {
                type: "thread.goal.cleared",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: ctx.threadId,
                payload: {},
              },
        );
      });

    const waitForGoalState = (
      ctx: GrokSessionContext,
      predicate: (goal: ProviderThreadGoal | null) => boolean,
      attempts = GROK_GOAL_STATE_WAIT_ATTEMPTS,
    ): Effect.Effect<ProviderThreadGoal | null, ProviderAdapterRequestError> =>
      Effect.gen(function* () {
        const goal = yield* readGoalState(ctx);
        if (predicate(goal)) return goal;
        if (attempts <= 1) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/goal/set",
            detail: "Grok did not persist the requested goal state before the deadline.",
          });
        }
        yield* Effect.sleep("50 millis");
        return yield* waitForGoalState(ctx, predicate, attempts - 1);
      });

    const buildPromptParts = (
      input: Pick<ProviderSteerTurnInput, "threadId" | "input" | "attachments">,
      method: string,
    ) =>
      Effect.gen(function* () {
        const text = input.input?.trim();
        if ((input.attachments?.length ?? 0) > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: method,
            issue: `A Grok prompt accepts at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
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
              method,
              detail: "Failed to prepare a validated file attachment.",
            }),
        });
        const imagePromptParts = yield* Effect.forEach(
          (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
          (attachment) =>
            Effect.gen(function* () {
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
                      detail: "Failed to read a validated Cafe attachment.",
                      cause,
                    }),
                ),
              );
              const attachmentIssue = validateGrokImageAttachmentBytes(
                attachment,
                bytes.byteLength,
              );
              if (attachmentIssue) {
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method,
                  detail: attachmentIssue,
                });
              }
              return {
                type: "image",
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              } satisfies EffectAcpSchema.ContentBlock;
            }),
        );
        const promptParts: Array<EffectAcpSchema.ContentBlock> = [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...(fileManifest ? [{ type: "text" as const, text: fileManifest }] : []),
          ...imagePromptParts,
        ];
        if (promptParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: method,
            issue: "Guidance requires non-empty text or attachments.",
          });
        }
        return promptParts;
      });

    const refreshUsage = (
      ctx: GrokSessionContext,
      turnId: TurnId,
      promptResponse: EffectAcpSchema.PromptResponse,
    ) =>
      Effect.gen(function* () {
        // Released Grok 1.0.4 registers the private method with the ACP
        // underscore prefix. Current source builds spell it without the prefix,
        // so feature-detect both and fall back only on method-not-found.
        const usageParams = { sessionId: ctx.acpSessionId };
        const response = yield* Effect.gen(function* () {
          const raw = yield* ctx.acp
            .request("_x.ai/session/usage", usageParams)
            .pipe(
              Effect.catch((error) =>
                error instanceof EffectAcpErrors.AcpRequestError && error.code === -32601
                  ? ctx.acp.request("x.ai/session/usage", usageParams)
                  : Effect.fail(error),
              ),
            );
          return yield* decodeXAiSessionUsageResponse(raw);
        }).pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            Effect.logDebug("Grok ACP cumulative usage extension was unavailable.", {
              errorKind: cause.reasons[0]?._tag ?? "Unknown",
              threadId: ctx.threadId,
            }).pipe(Effect.as(Option.none<typeof XAiSessionUsageResponse.Type>())),
          ),
        );
        const usage = Option.getOrUndefined(response)?.usage;
        const reportedTotalTokens = nonNegativeFinite(usage?.totalTokens);
        const currentInputTokens = nonNegativeFinite(usage?.inputTokens);
        const currentOutputTokens = nonNegativeFinite(usage?.outputTokens);
        const current: GrokUsageTotals = {
          totalTokens:
            reportedTotalTokens > 0
              ? reportedTotalTokens
              : currentInputTokens + currentOutputTokens,
          inputTokens: currentInputTokens,
          outputTokens: currentOutputTokens,
          cachedInputTokens: nonNegativeFinite(usage?.cachedReadTokens),
          cacheWriteInputTokens: nonNegativeFinite(usage?.cacheCreationTokens),
          reasoningOutputTokens: nonNegativeFinite(usage?.reasoningTokens),
          durationMs: nonNegativeFinite(usage?.apiDurationMs),
        };
        const cumulative: GrokUsageTotals = {
          totalTokens: Math.max(
            ctx.lastUsage.totalTokens,
            ctx.usageOffset.totalTokens + current.totalTokens,
          ),
          inputTokens: Math.max(
            ctx.lastUsage.inputTokens,
            ctx.usageOffset.inputTokens + current.inputTokens,
          ),
          outputTokens: Math.max(
            ctx.lastUsage.outputTokens,
            ctx.usageOffset.outputTokens + current.outputTokens,
          ),
          cachedInputTokens: Math.max(
            ctx.lastUsage.cachedInputTokens,
            ctx.usageOffset.cachedInputTokens + current.cachedInputTokens,
          ),
          cacheWriteInputTokens: Math.max(
            ctx.lastUsage.cacheWriteInputTokens,
            ctx.usageOffset.cacheWriteInputTokens + current.cacheWriteInputTokens,
          ),
          reasoningOutputTokens: Math.max(
            ctx.lastUsage.reasoningOutputTokens,
            ctx.usageOffset.reasoningOutputTokens + current.reasoningOutputTokens,
          ),
          durationMs: Math.max(
            ctx.lastUsage.durationMs,
            ctx.usageOffset.durationMs + current.durationMs,
          ),
        };
        const previousProcessedTokens = ctx.lastUsage.totalTokens;
        ctx.lastUsage = cumulative;
        const responseLastCall = readGrokPromptTokenUsage(promptResponse);
        const promptId = responseLastCall ? undefined : readGrokPromptId(promptResponse);
        const recoveredLastCall = promptId
          ? yield* Effect.promise(() =>
              readGrokLastCallUsageFromUnifiedLog({
                logPath: ctx.unifiedLogPath,
                sessionId: ctx.acpSessionId,
                promptId,
              }),
            )
          : null;
        const lastCall = responseLastCall ?? recoveredLastCall ?? undefined;
        if (!lastCall) {
          // The private usage RPC is cumulative throughput across model calls,
          // not current context occupancy. If neither the standard prompt
          // response nor the metadata-only Grok log provides the final call,
          // retain the prior accurate meter instead of recreating the oversized
          // percentage that originally motivated this split.
          ctx.session = {
            ...ctx.session,
            resumeCursor: {
              schemaVersion: GROK_RESUME_VERSION,
              sessionId: ctx.acpSessionId,
              sandboxProfile: ctx.sandboxProfile,
              ...(ctx.currentModelId ? { model: ctx.currentModelId } : {}),
              ...(ctx.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {}),
              usage: cumulative,
              ...(ctx.lastContextTokens !== undefined
                ? { lastContextTokens: ctx.lastContextTokens }
                : {}),
            },
          };
          return;
        }
        const usedTokens = Math.floor(lastCall.totalTokens);
        const contextCompacted = didGrokContextCompact({
          previousContextTokens: ctx.lastContextTokens,
          currentContextTokens: usedTokens,
          previousProcessedTokens,
          currentProcessedTokens: cumulative.totalTokens,
        });
        const previousContextTokens = ctx.lastContextTokens;
        ctx.lastContextTokens = usedTokens;
        ctx.session = {
          ...ctx.session,
          resumeCursor: {
            schemaVersion: GROK_RESUME_VERSION,
            sessionId: ctx.acpSessionId,
            sandboxProfile: ctx.sandboxProfile,
            ...(ctx.currentModelId ? { model: ctx.currentModelId } : {}),
            ...(ctx.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {}),
            usage: cumulative,
            lastContextTokens: usedTokens,
          },
        };
        if (contextCompacted) {
          yield* offerRuntimeEvent({
            type: "thread.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId,
            payload: {
              state: "compacted",
              detail: {
                detection: "provider-context-token-drop",
                previousUsedTokens: Math.floor(previousContextTokens ?? 0),
                usedTokens,
              },
            },
          });
        }
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          turnId,
          payload: {
            usage: {
              usedTokens,
              ...(cumulative.totalTokens > usedTokens
                ? { totalProcessedTokens: Math.floor(cumulative.totalTokens) }
                : {}),
              ...(ctx.maxTokens ? { maxTokens: Math.floor(ctx.maxTokens) } : {}),
              inputTokens: Math.floor(lastCall?.inputTokens ?? current.inputTokens),
              cachedInputTokens: Math.floor(
                lastCall?.cachedInputTokens ?? current.cachedInputTokens,
              ),
              cacheWriteInputTokens: Math.floor(
                lastCall?.cacheWriteInputTokens ?? current.cacheWriteInputTokens,
              ),
              totalCacheWriteInputTokens: Math.floor(cumulative.cacheWriteInputTokens),
              outputTokens: Math.floor(lastCall?.outputTokens ?? current.outputTokens),
              totalOutputTokens: Math.floor(cumulative.outputTokens),
              reasoningOutputTokens: Math.floor(
                lastCall?.reasoningOutputTokens ?? current.reasoningOutputTokens,
              ),
              lastUsedTokens: usedTokens,
              lastInputTokens: Math.floor(lastCall?.inputTokens ?? current.inputTokens),
              lastCachedInputTokens: Math.floor(
                lastCall?.cachedInputTokens ?? current.cachedInputTokens,
              ),
              lastCacheWriteInputTokens: Math.floor(
                lastCall?.cacheWriteInputTokens ?? current.cacheWriteInputTokens,
              ),
              lastOutputTokens: Math.floor(lastCall?.outputTokens ?? current.outputTokens),
              lastReasoningOutputTokens: Math.floor(
                lastCall?.reasoningOutputTokens ?? current.reasoningOutputTokens,
              ),
              durationMs: Math.floor(cumulative.durationMs),
            },
          },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to publish Grok token usage.", {
            errorKind: cause.reasons[0]?._tag ?? "Unknown",
            threadId: ctx.threadId,
          }),
        ),
      );

    const stopSessionInternal = (
      ctx: GrokSessionContext,
      options?: {
        readonly replaced?: boolean;
        readonly suppressExitEvent?: boolean;
        readonly deferScopeClose?: boolean;
      },
    ) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
        if (activeTurnId !== undefined) {
          // The prompt fiber deliberately skips settlement when its owning
          // session scope is interrupted to avoid deadlocking on this thread
          // lock. Therefore the stop path must publish the terminal event
          // before it closes that scope. This also covers provider-daemon and
          // application teardown, where no user-initiated interrupt RPC may
          // have survived long enough to reach the adapter.
          ctx.interruptedTurnIds.add(activeTurnId);
          yield* settlePromptInFlight(ctx.threadId, activeTurnId, ctx.acpSessionId, {
            completedStopReason: "cancelled",
            settleAllPrompts: true,
          });
        }
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        // A replacement session is fully initialized before ownership moves
        // to it. Closing the prior process afterward must not delete the new
        // context or publish a stale `session.exited` event that regresses the
        // projection back to closed.
        if (sessions.get(ctx.threadId) === ctx) {
          sessions.delete(ctx.threadId);
        }
        if (options?.deferScopeClose !== true) {
          yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        }
        if (options?.replaced === true || options?.suppressExitEvent === true) {
          return;
        }
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: GrokAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          if ((input.additionalDirectories?.length ?? 0) > 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Grok ACP does not yet support additional workspace directories.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const interactionMode = input.interactionMode ?? "default";
          const sandboxProfile = grokSandboxProfileForRuntimeMode(
            input.runtimeMode,
            interactionMode,
          );
          const permissionMode = grokPermissionModeForRuntimeMode(
            input.runtimeMode,
            interactionMode,
          );
          const resumeCursor = parseGrokResume(input.resumeCursor);
          const grokModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const selectedReasoningEffort = getModelSelectionStringOptionValue(
            grokModelSelection,
            "reasoningEffort",
          )?.trim();
          const requestedReasoningEffort = selectedReasoningEffort || resumeCursor?.reasoningEffort;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            if (
              existing.promptsInFlight > 0 ||
              existing.activeTurnId !== undefined ||
              existing.pendingApprovals.size > 0 ||
              existing.pendingUserInputs.size > 0
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startSession",
                issue:
                  "Grok model and reasoning changes can only restart an idle session after its active turn finishes.",
              });
            }
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const resumeSessionId = resumeCursor?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          const credentialIssuer = options?.sessionCredentials ?? readProviderMcpCredentialIssuer();
          if (!credentialIssuer) {
            return yield* new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: "Cafe MCP credential service is unavailable for this Grok session.",
            });
          }
          const mcpCredential = yield* credentialIssuer
            .issue({
              ttl: Duration.hours(24),
              subject: `provider:grok:${boundInstanceId}`,
              method: "bearer-session-token",
              role: "owner",
              client: {
                label: "Grok ACP",
                deviceType: "bot",
                userAgent: "cafe-code-grok-acp",
              },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: "Failed to create the scoped Cafe MCP credential for Grok.",
                    cause,
                  }),
              ),
            );
          yield* Scope.addFinalizer(
            sessionScope,
            credentialIssuer.revoke(mcpCredential.sessionId).pipe(Effect.ignore),
          );
          const acp = yield* makeGrokAcpRuntime({
            grokSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            sandboxProfile,
            permissionMode,
            ...(requestedReasoningEffort ? { reasoningEffort: requestedReasoningEffort } : {}),
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientInfo: { name: "cafe-code", version: "0.0.0" },
            mcpServers: [
              {
                type: "http" as const,
                name: "cafe-code",
                // Desktop adapters live in the detached provider daemon. Its
                // own transport is not the Cafe MCP listener, so desktop
                // bootstrap supplies the main backend port explicitly.
                url: resolveGrokCafeMcpUrl(serverConfig),
                headers: [
                  {
                    name: "Authorization",
                    value: `Bearer ${mcpCredential.token}`,
                  },
                ],
              },
            ],
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to start the Grok ACP runtime.",
                  cause: { _tag: cause._tag },
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* Effect.forEach(
              ["x.ai/ask_user_question", "_x.ai/ask_user_question"] as const,
              (method) =>
                acp.handleExtRequest(method, XAiAskUserQuestionRequest, (params) =>
                  mapAcpCallbackFailure(
                    Effect.gen(function* () {
                      yield* logNative(input.threadId, method, params);
                      const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                      const runtimeRequestId = RuntimeRequestId.make(requestId);
                      const resolution = yield* Deferred.make<PendingUserInputResolution>();
                      const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                      pendingUserInputs.set(requestId, { resolution });
                      yield* offerRuntimeEvent({
                        type: "user-input.requested",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: { questions: extractXAiAskUserQuestions(params) },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: summarizeNativePayload(params),
                        },
                      });
                      const resolved = yield* Deferred.await(resolution);
                      pendingUserInputs.delete(requestId);
                      const resolvedAnswers = resolved._tag === "answered" ? resolved.answers : {};
                      yield* offerRuntimeEvent({
                        type: "user-input.resolved",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: { answers: resolvedAnswers },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: summarizeNativePayload(params),
                        },
                      });
                      switch (resolved._tag) {
                        case "answered":
                          return makeXAiAskUserQuestionResponse(params, resolved.answers);
                        case "cancelled":
                          return makeXAiAskUserQuestionCancelledResponse();
                      }
                    }),
                  ),
                ),
              { discard: true },
            );
            yield* Effect.forEach(
              ["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"] as const,
              (method) =>
                acp.handleExtRequest(method, XAiExitPlanModeRequest, (request) =>
                  mapAcpCallbackFailure(
                    Effect.gen(function* () {
                      yield* logNative(input.threadId, method, request);
                      const params = extractXAiExitPlanModeParams(request);
                      const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                      const runtimeRequestId = RuntimeRequestId.make(requestId);
                      const decision = yield* Deferred.make<ProviderApprovalDecision>();
                      const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                      pendingApprovals.set(requestId, { decision });
                      const planMarkdown = params.planContent?.trim();
                      if (planMarkdown) {
                        yield* offerRuntimeEvent({
                          type: "turn.proposed.completed",
                          ...(yield* makeEventStamp()),
                          provider: PROVIDER,
                          threadId: input.threadId,
                          turnId,
                          payload: { planMarkdown },
                        });
                      }
                      yield* offerRuntimeEvent({
                        type: "request.opened",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: {
                          requestType: "dynamic_tool_call",
                          detail: "Grok is ready to leave plan mode and begin implementation.",
                        },
                        raw: {
                          source: "acp.grok.extension",
                          method,
                          payload: summarizeNativePayload(request),
                        },
                      });
                      const resolved = yield* Deferred.await(decision);
                      pendingApprovals.delete(requestId);
                      yield* offerRuntimeEvent({
                        type: "request.resolved",
                        ...(yield* makeEventStamp()),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId,
                        requestId: runtimeRequestId,
                        payload: {
                          requestType: "dynamic_tool_call",
                          decision: resolved,
                        },
                      });
                      return {
                        outcome:
                          resolved === "accept" || resolved === "acceptForSession"
                            ? "approved"
                            : resolved === "decline"
                              ? "abandoned"
                              : "cancelled",
                      } satisfies typeof XAiExitPlanModeResponse.Type;
                    }),
                  ),
                ),
              { discard: true },
            );
            yield* acp.handleRequestPermission((params) =>
              mapAcpCallbackFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/request_permission", params);
                  const permissionRequest = parsePermissionRequest(params);
                  if (
                    shouldAutoApproveGrokPermission(
                      input.runtimeMode,
                      permissionRequest.kind,
                      interactionMode,
                    )
                  ) {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  const turnId = resolveSessionCallbackTurnId(sessions, input.threadId);
                  pendingApprovals.set(requestId, { decision });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        permissionRequest.toolCall?.title ??
                        "Grok requested permission to use a tool.",
                      args: {
                        kind: permissionRequest.kind,
                        ...(permissionRequest.toolCall?.toolCallId
                          ? { toolCallId: permissionRequest.toolCall.toolCallId }
                          : {}),
                      },
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId =
                    resolved === "cancel" ? undefined : selectPermissionOptionId(params, resolved);
                  return {
                    outcome: selectedOptionId
                      ? {
                          outcome: "selected" as const,
                          optionId: selectedOptionId,
                        }
                      : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          const requestedStartModelId = grokModelSelection?.model
            ? resolveGrokAcpBaseModelId(grokModelSelection.model)
            : undefined;
          const boundModelId = yield* applyGrokAcpModelSelection({
            runtime: acp,
            currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
            requestedModelId: requestedStartModelId,
            mapError: (cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
          });
          const modelMetadata = readGrokAcpSessionModelMetadata(
            started.sessionSetupResult,
            boundModelId,
          );
          if (
            requestedReasoningEffort &&
            modelMetadata.reasoningEfforts.length > 0 &&
            !modelMetadata.reasoningEfforts.some(
              (candidate) => candidate.value === requestedReasoningEffort,
            )
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Grok model '${boundModelId ?? "default"}' does not advertise reasoning level '${requestedReasoningEffort}'.`,
            });
          }
          const boundReasoningEffort = requestedReasoningEffort ?? modelMetadata.reasoningEffort;
          const displayModelId = boundModelId ? resolveGrokAcpBaseModelId(boundModelId) : undefined;

          const now = yield* nowIso;
          const resumedUsage = resumeCursor?.usage ?? EMPTY_GROK_USAGE;
          const grokHome =
            grokSettings.homePath?.trim() ||
            options?.environment?.GROK_HOME?.trim() ||
            process.env.GROK_HOME?.trim() ||
            path.join(NodeOS.homedir(), ".grok");
          const goalStatePath = path.join(
            grokHome,
            "sessions",
            encodeURIComponent(cwd),
            encodeURIComponent(started.sessionId),
            "goal",
            "state.json",
          );
          const unifiedLogPath = path.join(grokHome, "logs", "unified.jsonl");
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            interactionMode,
            cwd,
            ...(displayModelId
              ? {
                  model: displayModelId,
                  modelSelection: makeGrokEffectiveModelSelection({
                    instanceId: boundInstanceId,
                    model: displayModelId,
                    ...(boundReasoningEffort ? { reasoningEffort: boundReasoningEffort } : {}),
                  }),
                }
              : {}),
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: GROK_RESUME_VERSION,
              sessionId: started.sessionId,
              sandboxProfile,
              ...(boundModelId ? { model: boundModelId } : {}),
              ...(boundReasoningEffort ? { reasoningEffort: boundReasoningEffort } : {}),
              usage: resumedUsage,
              ...(resumeCursor?.lastContextTokens
                ? { lastContextTokens: resumeCursor.lastContextTokens }
                : {}),
            },
            createdAt: now,
            updatedAt: now,
          };

          const ctx: GrokSessionContext = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            sandboxProfile,
            mcpAuthSessionId: mcpCredential?.sessionId,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            interruptedTurnIds: new Set(),
            promptsInFlight: 0,
            currentModelId: boundModelId,
            reasoningEffort: boundReasoningEffort,
            maxTokens: modelMetadata.totalContextTokens,
            goalStatePath,
            unifiedLogPath,
            usageOffset: resumedUsage,
            lastUsage: resumedUsage,
            lastContextTokens: resumeCursor?.lastContextTokens,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                const liveContext = sessions.get(ctx.threadId);
                if ((liveContext !== undefined && liveContext !== ctx) || ctx.stopped) {
                  if (event._tag === "EventStreamBarrier") {
                    yield* Deferred.succeed(event.acknowledge, undefined);
                  }
                  return;
                }
                if (event._tag === "EventStreamBarrier") {
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                }
                if (
                  event._tag === "PlanUpdated" ||
                  event._tag === "ToolCallUpdated" ||
                  event._tag === "AvailableCommandsChanged" ||
                  event._tag === "ContentDelta"
                ) {
                  yield* logNative(ctx.threadId, "session/update", event.rawPayload);
                }

                if (event._tag === "ModeChanged") {
                  return;
                }

                const notificationTurnId = resolveNotificationTurnId(ctx);
                if (
                  notificationTurnId === undefined ||
                  ctx.interruptedTurnIds.has(notificationTurnId)
                ) {
                  return;
                }
                const stamp = yield* makeEventStamp();

                switch (event._tag) {
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* emitPlanUpdate(
                      ctx,
                      notificationTurnId,
                      stamp,
                      event.payload,
                      event.rawPayload,
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        toolCall: event.toolCall,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                  case "AvailableCommandsChanged":
                    // Provider discovery consumes the same ACP notification to
                    // populate Cafe's existing slash-command surface. A live
                    // chat does not mutate the provider catalog per session.
                    return;
                  case "ContentDelta":
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp,
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: notificationTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        streamKind: event.streamKind,
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            // Fork into the session scope, not the calling fiber. `forkChild`
            // makes this a child of `startSession`, and Effect interrupts a
            // fiber's children when it completes, so the consumer died as soon
            // as `startSession` returned and every later notification was
            // dropped. The scope is created, stored on the context and closed
            // on teardown already; only the fork target was wrong.
            Effect.forkIn(ctx.scope),
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing, { replaced: true });
          }

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: {
              resume: {
                protocolVersion: started.initializeResult.protocolVersion,
                resumed: resumeSessionId !== undefined,
              },
            },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Grok ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: GrokAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            if (ctx.promptsInFlight > 0 || ctx.activeTurnId !== undefined) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "A Grok turn is already running; use live steering for additional guidance.",
              });
            }
            const turnId = TurnId.make(yield* randomUUIDv4);
            ctx.promptsInFlight += 1;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: "connecting",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const requestedTurnModelId = turnModelSelection?.model
                ? resolveGrokAcpBaseModelId(turnModelSelection.model)
                : undefined;
              const requestedTurnReasoningEffort = getModelSelectionStringOptionValue(
                turnModelSelection,
                "reasoningEffort",
              )?.trim();
              if (
                input.interactionMode !== undefined &&
                input.interactionMode !== (ctx.session.interactionMode ?? "default")
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "The Grok session must be restarted and resumed before changing Plan or Auto mode.",
                });
              }
              if (
                requestedTurnModelId !== undefined &&
                requestedTurnModelId !== ctx.currentModelId
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "The Grok session must be restarted and resumed before sending with a different model.",
                });
              }
              if (
                requestedTurnReasoningEffort !== undefined &&
                requestedTurnReasoningEffort !== ctx.reasoningEffort
              ) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue:
                    "The Grok session must be restarted and resumed before sending with a different reasoning level.",
                });
              }
              const currentModelId = ctx.currentModelId;

              const promptParts = yield* buildPromptParts(input, "session/prompt");

              ctx.currentModelId = currentModelId;
              const displayModel = currentModelId
                ? resolveGrokAcpBaseModelId(currentModelId)
                : undefined;
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                });
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok prompt was interrupted during preparation.",
                });
              }
              ctx.lastPlanFingerprint = undefined;
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: displayModel ? { model: displayModel } : {},
              });

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                resumeCursor: ctx.session.resumeCursor,
                scope: ctx.scope,
                turnId,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);
                  if (!liveCtx) {
                    return;
                  }
                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Grok prompt preparation failed.",
                    emitTurnCompletion: false,
                  });
                }),
              ),
            );
          }),
        );
        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);
        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        const settlePromptAfterExit = Effect.gen(function* () {
          if (yield* Ref.get(promptSettled)) {
            return;
          }

          if (yield* Ref.get(promptRpcSucceeded)) {
            const promptResult = yield* Ref.get(promptResultRef);
            if (promptResult === undefined) {
              return;
            }
            yield* withThreadLock(
              input.threadId,
              Effect.gen(function* () {
                const ctx = yield* requireSession(input.threadId);
                if (ctx.acpSessionId !== prepared.acpSessionId) {
                  yield* settlePromptInFlight(
                    input.threadId,
                    prepared.turnId,
                    prepared.acpSessionId,
                    {
                      errorMessage: "Grok session changed before the turn completed.",
                      settleAllPrompts: true,
                    },
                  );
                  return;
                }
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  return;
                }
                if (
                  ctx.promptsInFlight <= 0 ||
                  ctx.activeTurnId !== prepared.turnId ||
                  ctx.session.activeTurnId !== prepared.turnId
                ) {
                  return;
                }
                appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, promptResult);
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                  },
                );
              }),
            );
            return;
          }

          const errorMessage = yield* Ref.get(promptFailureMessageRef);
          yield* withThreadLock(
            input.threadId,
            settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
              errorMessage: errorMessage ?? "Grok prompt request failed.",
            }),
          );
        }).pipe(Effect.catch(() => Effect.void));

        const runPrompt = Effect.gen(function* () {
          const result = yield* prepared.acp
            .prompt({
              prompt: prepared.promptParts,
            })
            .pipe(
              Effect.tap((promptResult) =>
                Effect.all([
                  Ref.set(promptRpcSucceeded, true),
                  Ref.set(promptResultRef, promptResult),
                ]),
              ),
              Effect.tapError((error) =>
                Ref.set(
                  promptFailureMessageRef,
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
                ).pipe(Effect.andThen(prepared.acp.finishPromptEvents)),
              ),
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: "Grok session changed before the turn completed.",
                    settleAllPrompts: true,
                  },
                );
                yield* Ref.set(promptSettled, true);
                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok session changed before the turn completed.",
                });
              }
              // Keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }
              yield* prepared.acp.finishPromptEvents;
              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);
                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              yield* refreshUsage(ctx, prepared.turnId, result);
              // `/goal` is implemented by Grok as a long-running prompt whose
              // authoritative state is persisted separately from ACP. Sync it
              // at prompt settlement so completion/limit transitions reach
              // Cafe's existing Goal surface without parsing assistant text.
              const settledGoal = yield* readGoalState(ctx).pipe(
                Effect.catch(() => Effect.succeed(null)),
              );
              if (settledGoal) {
                yield* emitGoalState(ctx, settledGoal);
              }
              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              const remainingPrompts = Math.max(0, ctx.promptsInFlight - 1);
              ctx.promptsInFlight = remainingPrompts;

              // Only the last remaining prompt settles the turn. A steer-
              // superseded prompt resolving while another is in flight or
              // pending must leave the merged turn running.
              if (
                remainingPrompts === 0 &&
                ctx.activeTurnId === prepared.turnId &&
                ctx.session.activeTurnId === prepared.turnId
              ) {
                if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                  yield* Ref.set(promptSettled, true);
                  return {
                    threadId: input.threadId,
                    turnId: prepared.turnId,
                    resumeCursor: ctx.session.resumeCursor,
                  };
                }
                const completedAt = yield* nowIso;
                const { activeTurnId: _completedTurnId, ...readySession } = ctx.session;
                ctx.activeTurnId = undefined;
                ctx.session = {
                  ...readySession,
                  status: "ready",
                  updatedAt: completedAt,
                  ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
                };
                const completedStopReason = completedStopReasonFromPromptResponse(result);
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  payload: {
                    state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: completedStopReason,
                  },
                });
                ctx.interruptedTurnIds.delete(prepared.turnId);
                yield* Ref.set(promptSettled, true);
              } else if (remainingPrompts > 0) {
                yield* Ref.set(promptSettled, true);
              }

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          // Session teardown owns cancellation state and closes this fiber
          // while holding the thread lock. Skipping settlement only for a
          // genuine interruption avoids waiting on that same lock; normal ACP
          // success and failure exits still reconcile the turn exactly once.
          Effect.onExit((exit) => (Exit.hasInterrupts(exit) ? Effect.void : settlePromptAfterExit)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("Grok ACP prompt fiber failed.", {
                  errorKind: cause.reasons[0]?._tag ?? "Unknown",
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                }),
          ),
        );

        // ACP `session/prompt` resolves only when the model turn is complete.
        // ProviderService.sendTurn is an acknowledgement boundary, however:
        // holding it open for a long Grok turn also holds the provider-daemon
        // HTTP RPC open until its transport timeout fires. Run the prompt in
        // the durable per-session scope so the daemon receives the turn id
        // immediately while notifications and terminal settlement continue
        // for arbitrarily long prompts. Closing the session scope still owns
        // interruption and cleanup of this background fiber.
        yield* runPrompt.pipe(Effect.forkIn(prepared.scope));

        return {
          threadId: input.threadId,
          turnId: prepared.turnId,
          resumeCursor: prepared.resumeCursor,
        };
      });

    const steerTurn: GrokAdapterShape["steerTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (activeTurnId === undefined || ctx.promptsInFlight <= 0) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "steerTurn",
                issue: "Grok has no active turn to steer.",
              });
            }
            if (activeTurnId !== input.expectedTurnId) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "steerTurn",
                issue: "The Grok turn changed before this guidance could be delivered.",
              });
            }
            const promptParts = yield* buildPromptParts(input, "x.ai/interject");
            return {
              acp: ctx.acp,
              acpSessionId: ctx.acpSessionId,
              turnId: activeTurnId,
              promptParts,
              text: input.input?.trim() ?? "",
            };
          }),
        );

        const rawResponse = yield* prepared.acp
          .request("x.ai/interject", {
            sessionId: prepared.acpSessionId,
            text: prepared.text,
            interjectionId: yield* randomUUIDv4,
            // Grok's own 1.0.4 client intentionally omits `content` for a
            // text-only interjection so the legacy extension wire shape stays
            // byte-compatible. Structured content is needed only when Cafe is
            // carrying images; sending a redundant text block is rejected as
            // an internal extension error by the qualified stable binary.
            ...((input.attachments?.length ?? 0) > 0 ? { content: prepared.promptParts } : {}),
          })
          .pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "x.ai/interject", cause),
            ),
          );
        yield* decodeXAiInterjectResponse(rawResponse).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "x.ai/interject",
                detail: "Grok returned an invalid interjection response.",
                cause,
              }),
          ),
        );

        return yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            if (
              ctx.acpSessionId !== prepared.acpSessionId ||
              ctx.activeTurnId !== prepared.turnId ||
              ctx.interruptedTurnIds.has(prepared.turnId)
            ) {
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "steerTurn",
                issue: "The Grok turn ended before the interjection was acknowledged.",
              });
            }
            return {
              threadId: input.threadId,
              turnId: prepared.turnId,
              resumeCursor: ctx.session.resumeCursor,
            };
          }),
        );
      });

    const interruptTurn: GrokAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }
          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }
          const interruptedTurnId = turnId ?? activeTurnId;
          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }
          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });
        if (observed._tag === "Ignore") {
          return;
        }

        const retiredContext = yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }
            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }
            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }
            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;
            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );
            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }

            // Stable Grok exposes cancellation only as fire-and-forget ACP.
            // A successful stdio write does not prove the session actor has
            // stopped its model/tool loop, and a real 1.0.4 trace showed the
            // old child continuing to edit after Cafe emitted `cancelled`.
            // The native session id is durable, so retire this direct child and
            // make the next user intent load the same conversation in a fresh
            // process. Suppress `session.exited`: the orchestration interrupt
            // event, not process retirement, owns the visible stopped state.
            yield* stopSessionInternal(ctx, {
              suppressExitEvent: true,
              // The prompt fiber's normal cancellation finalizer takes this
              // same thread lock. Detach state now, then close the child scope
              // after releasing the lock so retirement cannot deadlock.
              deferScopeClose: true,
            });
            return ctx;
          }),
        );
        if (retiredContext !== undefined) {
          yield* Effect.ignore(Scope.close(retiredContext.scope, Exit.void));
        }
      });

    const respondToRequest: GrokAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: GrokAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "_x.ai/ask_user_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    const getGoal: NonNullable<GrokAdapterShape["getGoal"]> = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return yield* readGoalState(ctx);
      });

    const retireAndResumeForGoalMutation = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        const session = ctx.session;
        const cwd = session.cwd;
        if (!cwd) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/goal/set",
            detail: "Grok could not resume the active session for goal control.",
          });
        }
        const resumeCursor = parseGrokResume(session.resumeCursor);
        if (!resumeCursor || resumeCursor.sessionId !== ctx.acpSessionId) {
          /* Retirement is intentionally irreversible. Refuse to stop the live
             child unless its opaque cursor is schema-valid and binds the
             replacement to this exact provider-native conversation; falling
             back to session/new here would silently fork the user's goal work. */
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/goal/set",
            detail: "Grok could not safely bind goal control to the active conversation.",
          });
        }

        /* Stable Grok cancellation is fire-and-forget, so interruptTurn
           deliberately retires the direct child and removes its adapter
           context. Goal state can become authoritative before the matching
           long-running `/goal` prompt settles; a prompt submitted immediately
           afterward must therefore be the documented "next user intent" that
           resumes the same native conversation in a fresh process. Capture
           only Cafe's already-validated session configuration before
           retirement, never reuse the cancelled child, and preserve the
           provider-owned session id exclusively inside the opaque cursor. */
        const resumeInput = {
          threadId: ctx.threadId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          cwd,
          runtimeMode: session.runtimeMode,
          ...(session.interactionMode ? { interactionMode: session.interactionMode } : {}),
          ...(session.modelSelection ? { modelSelection: session.modelSelection } : {}),
          resumeCursor,
        } satisfies ProviderSessionStartInput;
        const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;

        yield* interruptTurn(ctx.threadId, activeTurnId);
        yield* startSession(resumeInput);
        return yield* requireSession(ctx.threadId);
      });

    const setGoal: NonNullable<GrokAdapterShape["setGoal"]> = (input: ProviderThreadGoalSetInput) =>
      Effect.gen(function* () {
        let ctx = yield* requireSession(input.threadId);
        const current = yield* readGoalState(ctx);
        if (input.tokenBudget !== undefined && input.tokenBudget !== null) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "setGoal",
            issue: "This Grok version does not expose a reliable goal token-budget control.",
          });
        }
        if (input.objective === null) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "setGoal",
            issue: "A Grok goal objective cannot be null; clear the goal instead.",
          });
        }

        let command: string | undefined;
        let expected: (goal: ProviderThreadGoal | null) => boolean;
        if (input.objective !== undefined) {
          const objective = input.objective.trim();
          if (current && current.objective !== objective) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "setGoal",
              issue: "Clear the existing Grok goal before replacing its objective.",
            });
          }
          command = current ? undefined : `/goal ${objective}`;
          expected = (goal) => goal?.objective === objective;
        } else {
          expected = (goal) => goal !== null;
        }

        if (input.status !== undefined && input.status !== null) {
          if (input.status === "paused" && current?.status !== "paused") {
            command = "/goal pause";
            expected = (goal) => goal?.status === "paused";
          } else if (input.status === "active" && current?.status === "paused") {
            command = "/goal resume";
            expected = (goal) => goal?.status === "active";
          } else if (input.status !== "active" && input.status !== "paused") {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "setGoal",
              issue: `Grok controls status '${input.status}' itself; Cafe can request only active or paused.`,
            });
          }
        }

        if (!command) {
          if (!current) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "setGoal",
              issue: "Starting a Grok goal requires an objective.",
            });
          }
          return current;
        }

        if (ctx.activeTurnId !== undefined || ctx.promptsInFlight > 0) {
          ctx = yield* retireAndResumeForGoalMutation(ctx);
        }
        yield* sendTurn({
          threadId: input.threadId,
          input: command,
          attachments: [],
          ...(ctx.session.modelSelection ? { modelSelection: ctx.session.modelSelection } : {}),
          ...(ctx.session.interactionMode ? { interactionMode: ctx.session.interactionMode } : {}),
        });
        const goal = yield* waitForGoalState(ctx, expected);
        if (!goal) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "thread/goal/set",
            detail: "Grok did not create a goal.",
          });
        }
        yield* emitGoalState(ctx, goal);
        return goal;
      });

    const clearGoal: NonNullable<GrokAdapterShape["clearGoal"]> = (threadId) =>
      Effect.gen(function* () {
        let ctx = yield* requireSession(threadId);
        const current = yield* readGoalState(ctx);
        if (!current) return { cleared: false };
        if (ctx.activeTurnId !== undefined || ctx.promptsInFlight > 0) {
          ctx = yield* retireAndResumeForGoalMutation(ctx);
        }
        yield* sendTurn({
          threadId,
          input: "/goal clear",
          attachments: [],
          ...(ctx.session.modelSelection ? { modelSelection: ctx.session.modelSelection } : {}),
          ...(ctx.session.interactionMode ? { interactionMode: ctx.session.interactionMode } : {}),
        });
        yield* waitForGoalState(ctx, (goal) => goal === null);
        yield* emitGoalState(ctx, null);
        return { cleared: true };
      });

    const readThread: GrokAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: GrokAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 1) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            });
          }
          if (ctx.promptsInFlight > 0 || ctx.activeTurnId !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Grok cannot rewind while a turn is active.",
            });
          }

          const requestWithPrefixFallback = (method: string, params: unknown) =>
            ctx.acp
              .request(`_x.ai/${method}`, params)
              .pipe(
                Effect.catch((error) =>
                  error instanceof EffectAcpErrors.AcpRequestError && error.code === -32601
                    ? ctx.acp.request(`x.ai/${method}`, params)
                    : Effect.fail(error),
                ),
              );
          const pointsRaw = yield* requestWithPrefixFallback("rewind/points", {
            sessionId: ctx.acpSessionId,
          }).pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, threadId, "x.ai/rewind/points", cause),
            ),
          );
          const points = (yield* decodeXAiRewindPointsResponse(pointsRaw).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "x.ai/rewind/points",
                  detail: "Grok returned an invalid rewind-points response.",
                  cause,
                }),
            ),
          )).rewind_points.toSorted((left, right) => left.prompt_index - right.prompt_index);
          if (points.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "Grok has no rewind point for this conversation.",
            });
          }
          // A rewind point represents the state immediately before its prompt.
          // Removing one turn therefore targets the last prompt; removing all
          // known turns targets the first point.
          const target = points[Math.max(0, points.length - numTurns)];
          if (!target) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "x.ai/rewind/execute",
              detail: "Grok could not resolve a rewind target.",
            });
          }
          const executeRaw = yield* requestWithPrefixFallback("rewind/execute", {
            sessionId: ctx.acpSessionId,
            targetPromptIndex: target.prompt_index,
            mode: "conversation_only",
          }).pipe(
            Effect.mapError((cause) =>
              mapAcpToAdapterError(PROVIDER, threadId, "x.ai/rewind/execute", cause),
            ),
          );
          const result = yield* decodeXAiRewindExecuteResponse(executeRaw).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "x.ai/rewind/execute",
                  detail: "Grok returned an invalid rewind response.",
                  cause,
                }),
            ),
          );
          if (!result.success || result.conflicts.length > 0) {
            // Provider error text and conflict paths can contain workspace data;
            // keep the user-facing failure structured and non-sensitive.
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "x.ai/rewind/execute",
              detail: "Grok could not rewind its conversation safely.",
            });
          }
          ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
          ctx.lastContextTokens = undefined;
          return { threadId, turns: ctx.turns };
        }),
      );

    const stopSession: GrokAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: GrokAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: GrokAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: GrokAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), (ctx) => stopSessionInternal(ctx), {
        discard: true,
      });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "restart-resume",
        liveSteer: "supported",
        threadGoals: "supported",
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      getGoal,
      setGoal,
      clearGoal,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies GrokAdapterShape;
  });
}
