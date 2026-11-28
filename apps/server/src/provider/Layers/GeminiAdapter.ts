import {
  ApprovalRequestId,
  EventId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  SubagentRuntimeId,
  TurnId,
  type ChatAttachment,
  type GeminiSettings,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeMode,
  type ThreadId,
} from "@cafecode/contracts";
import { compareSemverVersions } from "@cafecode/shared/semver";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { AcpError } from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";
// Native attachment boundary: descriptor identity and nonblocking no-follow open.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, open } from "node:fs/promises";
import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { APPLICATION_VERSION } from "../../applicationVersion.ts";
import { ServerConfig } from "../../config.ts";
import { makeManagementMcpSession } from "../../mcp/sessionConnection.ts";
import { buildCafeInstructions } from "../CafeInstructions.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  collectSessionConfigOptionValues,
  parsePermissionRequest,
  type AcpPermissionRequest,
  type AcpToolCallState,
} from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntime, AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import {
  buildGeminiElicitationResponse,
  GeminiElicitationRequest,
  parseGeminiElicitation,
  type GeminiElicitationPlan,
  type GeminiElicitationResolved,
} from "../acp/GeminiAcpElicitation.ts";
import {
  geminiPrivateHomeScope,
  makeGeminiAcpRuntime,
  qualifyGeminiCli,
} from "../acp/GeminiAcpRuntime.ts";
import {
  applyGeminiAcpSelection,
  GeminiAcpSelectionError,
  readGeminiAcpSelection,
} from "../acp/GeminiAcpSupport.ts";
import { readGeminiPromptUsage } from "../acp/GeminiAcpUsage.ts";
import { prepareFileAttachmentPrompt } from "../fileAttachmentPrompt.ts";
import {
  PUBLIC_REASONING_SUMMARY_BLOCKS,
  PUBLIC_REASONING_SUMMARY_CHARS,
  PUBLIC_REASONING_SUMMARY_INTERVAL_MS,
  PUBLIC_REASONING_SUMMARY_STREAM_KIND,
  PUBLIC_REASONING_SUMMARY_VERSION,
  publicReasoningSummaryDisplayText,
  publicReasoningSummaryTail,
} from "../publicReasoningSummary.ts";

const PROVIDER = ProviderDriverKind.make("gemini");
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TURN_IMAGE_BYTES = 12 * 1024 * 1024;
const START_REQUEST_TIMEOUT = "20 seconds";
const CONFIGURATION_TIMEOUT = "8 seconds";
const MAX_GEMINI_FOLLOW_UPS_PER_TURN = 64;
const MAX_OPEN_TOOL_CALLS = 64;
const MAX_RETIRED_TOOL_IDS = 128;
const MAX_SEEN_DETACHED_MESSAGES = 16;
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const NATIVE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u;
const NativeSessionId = Schema.String.check(Schema.isPattern(NATIVE_ID_PATTERN));
const decodeNativeSessionId = Schema.decodeUnknownEffect(NativeSessionId);
const decodeResume = Schema.decodeUnknownEffect(
  Schema.Struct({
    version: Schema.Literal(1),
    instanceId: ProviderInstanceId,
    threadId: Schema.String,
    cwd: Schema.String,
    sessionId: NativeSessionId,
    nativeHomeScope: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  }),
);
type Runtime = AcpSessionRuntime["Service"];
type NativePermissionMode = "default" | "accept-edits" | "auto" | "plan";

interface PendingApproval {
  readonly turnId: TurnId;
  readonly permission: AcpPermissionRequest;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type GeminiQuestionResolution =
  | ({ readonly _tag: "answered" } & GeminiElicitationResolved)
  | { readonly _tag: "cancelled" };

interface PendingQuestion {
  readonly turnId: TurnId;
  readonly plan: GeminiElicitationPlan;
  readonly decision: Deferred.Deferred<GeminiQuestionResolution>;
}

interface PublicThought {
  readonly sourceItemId: string;
  readonly itemId: RuntimeItemId;
  readonly turnId: TurnId;
  readonly startedAt: string;
  text: string;
  publishedText: string | undefined;
  publishedTruncated: boolean;
  truncated: boolean;
  flush: Fiber.Fiber<void> | undefined;
}

interface GeminiToolBinding {
  readonly turnId: TurnId;
  detached: boolean;
  runningTool: AcpToolCallState | undefined;
}

interface GeminiBackgroundReply {
  readonly itemId: RuntimeItemId;
  readonly sourceItemId: string;
  readonly nativeMessageId: string | undefined;
  readonly turnId: TurnId;
  readonly startedAt: string;
  text: string;
  published: string | undefined;
  flush: Fiber.Fiber<void> | undefined;
}

interface GeminiPromptGroup {
  readonly turnId: TurnId;
  readonly model: string;
  usageModelConfirmed: boolean;
  pending: number;
  submitted: number;
  rootQueued: boolean;
  latestQueued: boolean;
  latest: { readonly index: number; readonly response: AcpSchema.PromptResponse } | undefined;
}

interface SessionOwner {
  readonly runtime: Runtime;
  readonly scope: Scope.Closeable;
  readonly nativeId: string;
  readonly runtimeId: SubagentRuntimeId;
  readonly supportsDetachedWake: boolean;
  readonly permissionMode: NativePermissionMode;
  readonly permissionConfigId: string;
  readonly bypassPermissions: boolean;
  readonly supportsImages: boolean;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  readonly questions: Map<ApprovalRequestId, PendingQuestion>;
  readonly toolBindings: Map<string, GeminiToolBinding>;
  readonly toolLifecycle: Semaphore.Semaphore;
  readonly retiredToolIds: Set<string>;
  readonly detachedMessages: Map<string, GeminiBackgroundReply>;
  session: ProviderSession;
  promptGroup: GeminiPromptGroup | undefined;
  lastSettledTurnId: TurnId | undefined;
  backgroundReply: GeminiBackgroundReply | undefined;
  publicThought: PublicThought | undefined;
  publicThoughtCount: number;
  permissionModeRevoked: boolean;
  retiring: boolean;
}

export interface GeminiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeHome?: string | undefined;
}

function invalid(operation: string, issue: string) {
  return new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue });
}

function exactPermissionOption(
  options: ReadonlyArray<AcpSchema.PermissionOption>,
  kind: "allow_once" | "reject_once",
): string | undefined {
  const matches = options.filter((option) => option.kind === kind);
  const id = matches.length === 1 ? matches[0]?.optionId : undefined;
  if (!id || id.length > 256 || options.filter((option) => option.optionId === id).length !== 1)
    return undefined;
  return id;
}

function resolvePermissionMode(
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
): NativePermissionMode | undefined {
  if (interactionMode === "gemini-bypass") {
    return runtimeMode === "full-access" ? "default" : undefined;
  }
  if (
    runtimeMode !== "full-access" &&
    runtimeMode !== "approval-required" &&
    runtimeMode !== "auto-accept-edits"
  )
    return undefined;
  if (interactionMode === "plan" || interactionMode === "auto") return interactionMode;
  if (interactionMode !== "default") return undefined;
  return runtimeMode === "auto-accept-edits" ? "accept-edits" : "default";
}

function getPermissionModeOption(
  configOptions: ReadonlyArray<AcpSchema.SessionConfigOption>,
  expected: NativePermissionMode,
) {
  if (configOptions.length > 128) return undefined;
  const options = configOptions.filter((option) => option.category === "mode");
  const mode = options[0];
  if (
    options.length !== 1 ||
    !mode ||
    mode.type !== "select" ||
    mode.id.length === 0 ||
    mode.id.length > 128 ||
    mode.id !== mode.id.trim() ||
    /[\p{Cc}\p{Cf}]/u.test(mode.id) ||
    configOptions.filter((option) => option.id.trim() === mode.id).length !== 1 ||
    collectSessionConfigOptionValues(mode).filter((value) => value === expected).length !== 1
  )
    return undefined;
  return mode;
}

const configureSession = Effect.fn("gemini.configureSession")(function* (
  runtime: Runtime,
  expectedMode: NativePermissionMode,
  expectedConfigId: string | undefined,
  selection?: ModelSelection,
) {
  const mode = getPermissionModeOption(yield* runtime.getConfigOptions, expectedMode);
  if (!mode || (expectedConfigId !== undefined && mode.id !== expectedConfigId)) {
    return yield* new GeminiAcpSelectionError({
      issue: "Gemini did not advertise the requested permission mode in this session.",
    });
  }
  if (mode.currentValue !== expectedMode) {
    const acknowledgement = getPermissionModeOption(
      (yield* runtime.setConfigOption(mode.id, expectedMode)).configOptions,
      expectedMode,
    );
    if (acknowledgement?.id !== mode.id || acknowledgement.currentValue !== expectedMode) {
      return yield* new GeminiAcpSelectionError({
        issue: "Gemini did not acknowledge the requested permission mode.",
      });
    }
  }
  const applied = yield* applyGeminiAcpSelection(runtime, selection);
  const current = getPermissionModeOption(yield* runtime.getConfigOptions, expectedMode);
  if (current?.id !== mode.id || current.currentValue !== expectedMode) {
    return yield* new GeminiAcpSelectionError({
      issue: "Gemini changed its permission mode during configuration.",
    });
  }
  return { ...applied, permissionConfigId: mode.id };
});

async function readExactImage(path: string, size: number): Promise<string> {
  const named = await lstat(path, { bigint: true });
  if (!named.isFile() || named.nlink !== 1n || named.size !== BigInt(size))
    throw new Error("Attachment identity is invalid.");
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const matches = (observed: typeof named) =>
      observed.isFile() &&
      observed.nlink === 1n &&
      observed.dev === named.dev &&
      observed.ino === named.ino &&
      observed.size === named.size &&
      observed.mtimeNs === named.mtimeNs &&
      observed.ctimeNs === named.ctimeNs;
    if (!matches(await handle.stat({ bigint: true })))
      throw new Error("Attachment identity changed.");
    const bytes = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== size || !matches(await handle.stat({ bigint: true })))
      throw new Error("Attachment bytes changed.");
    return bytes.subarray(0, offset).toString("base64");
  } finally {
    await handle.close();
  }
}

export const makeGeminiAdapter = Effect.fn("makeGeminiAdapter")(function* (
  settings: GeminiSettings,
  options: GeminiAdapterOptions = {},
) {
  const instanceScope = yield* Scope.Scope;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const config = yield* ServerConfig;
  const instanceId = options.instanceId ?? ProviderInstanceId.make("gemini");
  const environment = options.environment ?? {};
  const nativeHomeScope = geminiPrivateHomeScope(options.nativeHome);
  const events = yield* PubSub.bounded<ProviderRuntimeEvent>(2048);
  const sessions = new Map<ThreadId, SessionOwner>();
  const locks = new Map<ThreadId, { semaphore: Semaphore.Semaphore; users: number }>();
  let disposing = false;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const stamp = Effect.gen(function* () {
    return { eventId: EventId.make(yield* Random.nextUUIDv4), createdAt: yield* now };
  });
  const emit = (event: ProviderRuntimeEvent, owner?: SessionOwner) =>
    PubSub.publish(events, {
      ...event,
      providerInstanceId: instanceId,
      ...(owner ? { subagentRuntimeId: owner.runtimeId } : {}),
    }).pipe(Effect.asVoid);
  const locked = <A, E, R>(id: ThreadId, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const entry = locks.get(id) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        locks.set(id, entry);
        entry.users++;
        return entry;
      }),
      ({ semaphore }) => semaphore.withPermits(1)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.users--;
          if (entry.users === 0) locks.delete(id);
        }),
    );
  const owns = (ctx: SessionOwner) => !ctx.retiring && sessions.get(ctx.session.threadId) === ctx;
  const requireOwner = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const ctx = sessions.get(threadId);
      return ctx && owns(ctx)
        ? Effect.succeed(ctx)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    });
  const native = <A>(
    threadId: ThreadId,
    method: string,
    effect: Effect.Effect<A, AcpError | GeminiAcpSelectionError>,
  ) =>
    effect.pipe(
      Effect.mapError((error) =>
        error._tag === "GeminiAcpSelectionError"
          ? invalid(method, error.issue)
          : mapAcpToAdapterError(PROVIDER, threadId, method, error),
      ),
    );
  const base = (threadId: ThreadId) =>
    stamp.pipe(Effect.map((eventStamp) => ({ provider: PROVIDER, threadId, ...eventStamp })));

  const publishThought = (
    ctx: SessionOwner,
    block: PublicThought,
    terminal?: "completed" | "failed",
  ) =>
    Effect.gen(function* () {
      const text = block.text.trim() || block.publishedText;
      if (
        !text ||
        (!terminal && text === block.publishedText && block.truncated === block.publishedTruncated)
      )
        return;
      block.publishedText = text;
      block.publishedTruncated = block.truncated;
      yield* emit(
        {
          ...(yield* base(ctx.session.threadId)),
          createdAt: block.startedAt,
          type: terminal ? "item.completed" : "item.updated",
          turnId: block.turnId,
          itemId: block.itemId,
          payload: {
            itemType: "reasoning",
            title: "Gemini thinking",
            detail: text,
            status: terminal ?? "inProgress",
            data: {
              summaryVersion: PUBLIC_REASONING_SUMMARY_VERSION,
              streamKind: PUBLIC_REASONING_SUMMARY_STREAM_KIND,
              truncated: block.truncated,
            },
          },
          // ACP's disclosed text is the only input. Provider metadata can
          // carry private tokens, signatures or encrypted reasoning.
        },
        ctx,
      );
    });

  const finishThought = (ctx: SessionOwner, turnId: TurnId, status: "completed" | "failed") =>
    Effect.gen(function* () {
      const block = ctx.publicThought;
      if (!block || block.turnId !== turnId) return;
      ctx.publicThought = undefined;
      if (block.flush) yield* Fiber.interrupt(block.flush);
      yield* publishThought(ctx, block, status);
    });

  const observeThought = (
    ctx: SessionOwner,
    turnId: TurnId,
    itemId: string,
    text: string,
    createdAt: string,
  ) =>
    Effect.gen(function* () {
      let block = ctx.publicThought;
      if (block && block.sourceItemId !== itemId) {
        yield* finishThought(ctx, turnId, "completed");
        block = undefined;
      }
      if (!owns(ctx) || ctx.session.activeTurnId !== turnId) return;
      // Trim only the displayed value so deltas retain their spaces and
      // Markdown separators. Bounded slices precede any sanitization or join.
      const tail = publicReasoningSummaryDisplayText(publicReasoningSummaryTail(text));
      if (!block) {
        if (!tail.trim() || ctx.publicThoughtCount >= PUBLIC_REASONING_SUMMARY_BLOCKS) return;
        ctx.publicThoughtCount += 1;
        block = {
          sourceItemId: itemId,
          itemId: RuntimeItemId.make(`${itemId}:thought:${ctx.publicThoughtCount}`),
          turnId,
          startedAt: createdAt,
          text: "",
          publishedText: undefined,
          publishedTruncated: false,
          truncated: false,
          flush: undefined,
        };
        ctx.publicThought = block;
      }
      block.truncated ||= block.text.length + text.length > PUBLIC_REASONING_SUMMARY_CHARS;
      block.text = publicReasoningSummaryTail(block.text + tail);
      if (block.publishedText === undefined) {
        yield* publishThought(ctx, block);
        return;
      }
      if (!block.flush) {
        const observed = block;
        block.flush = yield* Effect.sleep(PUBLIC_REASONING_SUMMARY_INTERVAL_MS).pipe(
          Effect.andThen(
            Effect.suspend(() => {
              if (
                !owns(ctx) ||
                ctx.publicThought !== observed ||
                ctx.session.activeTurnId !== turnId
              )
                return Effect.void;
              return publishThought(ctx, observed);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              observed.flush = undefined;
            }),
          ),
          Effect.interruptible,
          Effect.forkIn(ctx.scope),
        );
      }
    });

  const publishBackgroundReply = (ctx: SessionOwner, reply: GeminiBackgroundReply) =>
    Effect.gen(function* () {
      const text = reply.text.trim();
      if (!owns(ctx) || !text || text === reply.published) return;
      reply.published = text;
      // A detached ACP reply has no standalone completion receipt. This is
      // a bounded work-log snapshot, never a new foreground assistant turn.
      yield* emit(
        {
          ...(yield* base(ctx.session.threadId)),
          createdAt: reply.startedAt,
          type: "item.updated",
          turnId: reply.turnId,
          itemId: reply.itemId,
          payload: {
            itemType: "assistant_message",
            title: "Gemini background reply",
            detail: text,
            data: { geminiBackgroundReplyVersion: 1 },
          },
        },
        ctx,
      );
    });

  const finishBackgroundReply = (ctx: SessionOwner) =>
    Effect.gen(function* () {
      const reply = ctx.backgroundReply;
      if (!reply) return;
      ctx.backgroundReply = undefined;
      if (reply.flush) yield* Fiber.interrupt(reply.flush);
      yield* publishBackgroundReply(ctx, reply);
    });

  const observeBackgroundReply = (
    ctx: SessionOwner,
    event: Extract<AcpSessionRuntimeEvent, { readonly _tag: "ContentDelta" }>,
    turnId: TurnId,
    ownedReply?: GeminiBackgroundReply,
  ) =>
    Effect.gen(function* () {
      if (!event.itemId) return;
      const nativeMessageId =
        event.nativeMessageId && NATIVE_ID_PATTERN.test(event.nativeMessageId)
          ? event.nativeMessageId
          : undefined;
      let reply = ownedReply ?? ctx.backgroundReply;
      if (
        reply &&
        !ownedReply &&
        (reply.sourceItemId !== event.itemId || reply.nativeMessageId !== nativeMessageId)
      ) {
        yield* finishBackgroundReply(ctx);
        reply = undefined;
      }
      if (!owns(ctx)) return;
      const tail = publicReasoningSummaryDisplayText(publicReasoningSummaryTail(event.text));
      if (!reply) {
        if (!tail.trim()) return;
        reply = {
          itemId: RuntimeItemId.make(`gemini-background:${yield* Random.nextUUIDv4}`),
          sourceItemId: event.itemId,
          nativeMessageId,
          turnId,
          startedAt: yield* now,
          text: "",
          published: undefined,
          flush: undefined,
        };
        ctx.backgroundReply = reply;
        if (nativeMessageId) {
          ctx.detachedMessages.set(nativeMessageId, reply);
          if (ctx.detachedMessages.size > MAX_SEEN_DETACHED_MESSAGES) {
            const oldest = ctx.detachedMessages.keys().next().value;
            if (oldest !== undefined) ctx.detachedMessages.delete(oldest);
          }
        }
      }
      reply.text = publicReasoningSummaryTail(reply.text + tail);
      if (reply.published === undefined) {
        yield* publishBackgroundReply(ctx, reply);
        return;
      }
      if (reply.flush) return;
      const observed = reply;
      reply.flush = yield* Effect.sleep(PUBLIC_REASONING_SUMMARY_INTERVAL_MS).pipe(
        Effect.andThen(publishBackgroundReply(ctx, observed)),
        Effect.ensuring(
          Effect.sync(() => {
            observed.flush = undefined;
          }),
        ),
        Effect.interruptible,
        Effect.forkIn(ctx.scope),
      );
    });

  // Published Cafe turn.started is not proof a native prompt is queued.
  const foregroundTurnFor = (ctx: SessionOwner) =>
    ctx.promptGroup?.rootQueued === false ? undefined : ctx.session.activeTurnId;

  const projectTool = (
    ctx: SessionOwner,
    event: Extract<AcpSessionRuntimeEvent, { readonly _tag: "ToolCallUpdated" }>,
  ) =>
    Effect.gen(function* () {
      // Waiting for the foreground handoff may have retired this exact owner.
      if (!owns(ctx) || ctx.permissionModeRevoked) return;
      const id = event.toolCall.toolCallId;
      if (!NATIVE_ID_PATTERN.test(id) || ctx.retiredToolIds.has(id)) return;
      const foregroundTurn = foregroundTurnFor(ctx);
      const detachedTurn =
        ctx.supportsDetachedWake && !foregroundTurn ? ctx.lastSettledTurnId : undefined;
      let binding = ctx.toolBindings.get(id);
      const observedTurn = foregroundTurn ?? detachedTurn;
      if (
        event.started &&
        !binding &&
        observedTurn &&
        ctx.toolBindings.size < MAX_OPEN_TOOL_CALLS
      ) {
        binding = {
          turnId: observedTurn,
          detached: detachedTurn !== undefined,
          runningTool: undefined,
        };
        ctx.toolBindings.set(id, binding);
      }
      const turnId = binding?.turnId ?? foregroundTurn;
      if (!turnId) return;
      const terminal = event.toolCall.status === "completed" || event.toolCall.status === "failed";
      if (binding && detachedTurn && !terminal) binding.detached = true;
      if (binding && ctx.supportsDetachedWake) {
        const { kind, title, status } = event.toolCall;
        // Carry only an explicit running observation. Keep the bounded card
        // label and status, without retaining command arguments or results.
        binding.runningTool =
          !binding.detached && status === "inProgress"
            ? {
                toolCallId: id,
                status,
                ...(kind ? { kind } : {}),
                ...(title ? { title: title.slice(0, 300) } : {}),
                data: {},
              }
            : undefined;
      }
      if (binding && terminal) {
        ctx.toolBindings.delete(id);
        ctx.retiredToolIds.add(id);
        if (ctx.retiredToolIds.size > MAX_RETIRED_TOOL_IDS) {
          const oldest = ctx.retiredToolIds.values().next().value;
          if (oldest !== undefined) ctx.retiredToolIds.delete(oldest);
        }
      }
      yield* emit(
        makeAcpToolCallEvent({
          ...event,
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: ctx.session.threadId,
          turnId,
          geminiDetachedTool: binding?.detached === true,
        }),
        ctx,
      );
    });

  const hasDetachedTools = (ctx: SessionOwner) =>
    [...ctx.toolBindings.values()].some((binding) => binding.detached);
  const approvalTurnFor = (ctx: SessionOwner, toolCallId: string) => {
    const foregroundTurn = foregroundTurnFor(ctx);
    if (!ctx.supportsDetachedWake) return foregroundTurn;
    return ctx.toolBindings.get(toolCallId)?.turnId ?? foregroundTurn ?? ctx.lastSettledTurnId;
  };

  const resolveApproval = (
    ctx: SessionOwner,
    requestId: ApprovalRequestId,
    pending: PendingApproval,
    decision: ProviderApprovalDecision,
  ) =>
    Effect.gen(function* () {
      if (ctx.approvals.get(requestId) !== pending) return;
      ctx.approvals.delete(requestId);
      yield* emit(
        makeAcpRequestResolvedEvent({
          stamp: yield* stamp,
          provider: PROVIDER,
          threadId: ctx.session.threadId,
          turnId: pending.turnId,
          requestId: RuntimeRequestId.make(requestId),
          permissionRequest: pending.permission,
          decision,
        }),
        ctx,
      );
    });

  const resolveQuestion = (
    ctx: SessionOwner,
    requestId: ApprovalRequestId,
    pending: PendingQuestion,
    resolution: GeminiQuestionResolution,
  ) =>
    Effect.gen(function* () {
      if (ctx.questions.get(requestId) !== pending) return;
      ctx.questions.delete(requestId);
      yield* emit(
        {
          ...(yield* base(ctx.session.threadId)),
          type: "user-input.resolved",
          turnId: pending.turnId,
          requestId: RuntimeRequestId.make(requestId),
          payload:
            resolution._tag === "answered"
              ? {
                  answers: resolution.answers,
                  ...(resolution.unanswered ? { unanswered: resolution.unanswered } : {}),
                }
              : { answers: {}, cancelled: true },
        },
        ctx,
      );
    });

  const settle = (
    ctx: SessionOwner,
    turnId: TurnId,
    state: "completed" | "failed" | "cancelled",
    stopReason?: AcpSchema.StopReason,
  ) =>
    ctx.toolLifecycle.withPermits(1)(
      Effect.gen(function* () {
        if (ctx.session.activeTurnId !== turnId) return;
        yield* finishThought(ctx, turnId, state === "completed" ? "completed" : "failed");
        const updatedAt = yield* now;
        const carriedTools: AcpToolCallState[] = [];
        if (state === "completed" && owns(ctx) && !ctx.permissionModeRevoked) {
          // Antigravity can end the prompt while an already running tool is
          // quiet until completion. Reserve its original binding before
          // clearing the foreground, so a native permission-mode change
          // always observes a live owner across that boundary.
          for (const binding of ctx.toolBindings.values()) {
            if (binding.turnId !== turnId || binding.detached || !binding.runningTool) continue;
            carriedTools.push(binding.runningTool);
            binding.detached = true;
            binding.runningTool = undefined;
          }
        }
        ctx.lastSettledTurnId = state === "completed" ? turnId : undefined;
        ctx.session = {
          ...ctx.session,
          activeTurnId: undefined,
          status: state === "failed" ? "error" : "ready",
          updatedAt,
        };
        // Publish before foreground completion. Native tool updates share
        // this permit, so a terminal edge cannot overtake the carried state.
        for (const toolCall of carriedTools) {
          const eventStamp = yield* stamp;
          if (!owns(ctx) || ctx.permissionModeRevoked) break;
          yield* emit(
            makeAcpToolCallEvent({
              stamp: eventStamp,
              provider: PROVIDER,
              threadId: ctx.session.threadId,
              turnId,
              toolCall,
              rawPayload: undefined,
              geminiDetachedTool: true,
            }),
            ctx,
          );
        }
        yield* emit(
          {
            ...(yield* base(ctx.session.threadId)),
            type: "turn.completed",
            turnId,
            payload: {
              state,
              ...(stopReason ? { stopReason } : {}),
              resumeCursor: ctx.session.resumeCursor,
              ...(state === "failed" ? { errorMessage: "The Gemini ACP turn failed." } : {}),
            },
          },
          ctx,
        );
      }),
    );

  const retire = (
    ctx: SessionOwner,
    failure: boolean,
    options?: { readonly suppressExitEvent?: boolean },
  ) =>
    Effect.gen(function* () {
      if (!owns(ctx)) return;
      ctx.retiring = true;
      const turnId = ctx.session.activeTurnId;
      if (
        (turnId || ctx.approvals.size > 0 || ctx.questions.size > 0 || hasDetachedTools(ctx)) &&
        !failure
      ) {
        // Cancellation is a notification, so its transport write alone cannot
        // authorize reuse. Close the same owned child even if delivery fails.
        yield* ctx.runtime.cancel.pipe(
          Effect.interruptible,
          Effect.timeoutOption(2_000),
          Effect.ignore,
        );
      }
      for (const [id, pending] of ctx.approvals) {
        yield* Deferred.succeed(pending.decision, "cancel");
        yield* resolveApproval(ctx, id, pending, "cancel");
      }
      for (const [id, pending] of ctx.questions) {
        yield* Deferred.succeed(pending.decision, { _tag: "cancelled" });
        yield* resolveQuestion(ctx, id, pending, { _tag: "cancelled" });
      }
      yield* Scope.close(ctx.scope, Exit.void);
      if (turnId) yield* settle(ctx, turnId, failure ? "failed" : "cancelled");
      sessions.delete(ctx.session.threadId);
      // An intentional idle replacement publishes a new session on the
      // same chat. Its old exit must never overwrite that new projection.
      if (!failure && options?.suppressExitEvent === true) return;
      yield* emit(
        {
          ...(yield* base(ctx.session.threadId)),
          type: "session.exited",
          payload: failure
            ? { exitKind: "error", recoverable: true, reason: "The Gemini ACP session ended." }
            : { exitKind: "graceful" },
        },
        ctx,
      );
    }).pipe(Effect.uninterruptible);

  const projectEvent = (ctx: SessionOwner, event: AcpSessionRuntimeEvent) =>
    Effect.gen(function* () {
      if (event._tag === "EventStreamBarrier") {
        yield* Deferred.succeed(event.acknowledge, undefined);
        return;
      }
      const turnId = foregroundTurnFor(ctx);
      if (
        event._tag === "SessionConfigurationChanged" &&
        event.modeId !== ctx.permissionMode &&
        owns(ctx) &&
        !ctx.permissionModeRevoked &&
        (turnId || ctx.approvals.size > 0 || ctx.questions.size > 0 || hasDetachedTools(ctx))
      ) {
        // A live native mode change withdraws callback authority before
        // asynchronous retirement. Retirement must join this event fiber
        // from the separate instance scope.
        ctx.permissionModeRevoked = true;
        yield* locked(ctx.session.threadId, retire(ctx, true)).pipe(Effect.forkIn(instanceScope));
        return;
      }
      if (!owns(ctx) || ctx.permissionModeRevoked) return;
      if (event._tag === "ToolCallUpdated") {
        yield* ctx.toolLifecycle.withPermits(1)(projectTool(ctx, event));
        return;
      }
      if (
        ctx.supportsDetachedWake &&
        event._tag === "ContentDelta" &&
        event.streamKind === "assistant_text"
      ) {
        const known = event.nativeMessageId
          ? ctx.detachedMessages.get(event.nativeMessageId)
          : undefined;
        const backgroundTurn = known?.turnId ?? (turnId ? undefined : ctx.lastSettledTurnId);
        if (backgroundTurn) {
          yield* observeBackgroundReply(ctx, event, backgroundTurn, known);
          return;
        }
      }
      if (
        event._tag === "AssistantItemCompleted" &&
        ctx.backgroundReply?.sourceItemId === event.itemId
      ) {
        yield* finishBackgroundReply(ctx);
        return;
      }
      if (!turnId) return;
      const threadId = ctx.session.threadId;
      const eventContext = { stamp: yield* stamp, provider: PROVIDER, threadId, turnId };
      if (!owns(ctx) || ctx.session.activeTurnId !== turnId) return;
      switch (event._tag) {
        case "AssistantItemStarted":
        case "AssistantItemCompleted":
          if (
            event._tag === "AssistantItemCompleted" &&
            ctx.publicThought?.sourceItemId === event.itemId
          )
            yield* finishThought(ctx, turnId, "completed");
          yield* emit(
            makeAcpAssistantItemEvent({
              ...eventContext,
              itemId: event.itemId,
              lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
            }),
            ctx,
          );
          break;
        case "ContentDelta":
          if (event.streamKind === "reasoning_text") {
            if (event.itemId)
              yield* observeThought(
                ctx,
                turnId,
                event.itemId,
                event.text,
                eventContext.stamp.createdAt,
              );
          } else {
            yield* finishThought(ctx, turnId, "completed");
            yield* emit(makeAcpContentDeltaEvent({ ...eventContext, ...event }), ctx);
          }
          break;
        case "PlanUpdated":
          yield* emit(
            makeAcpPlanUpdatedEvent({
              ...eventContext,
              ...event,
              source: "acp.jsonrpc",
              method: "session/update",
            }),
            ctx,
          );
          break;
        case "ContextUsageUpdated":
          // ACP reports current context occupancy. Treat neither occupancy
          // nor its optional cost metadata as cumulative account usage.
          yield* emit(
            {
              ...(yield* base(threadId)),
              type: "thread.token-usage.updated",
              turnId,
              payload: { usage: { usedTokens: event.usedTokens, maxTokens: event.maxTokens } },
            },
            ctx,
          );
          break;
      }
    });

  const imageBlock = (threadId: ThreadId, attachment: ChatAttachment) =>
    Effect.gen(function* () {
      if (
        attachment.type !== "image" ||
        !IMAGE_MIME_TYPES.has(attachment.mimeType) ||
        !Number.isSafeInteger(attachment.sizeBytes) ||
        attachment.sizeBytes <= 0 ||
        attachment.sizeBytes > MAX_IMAGE_BYTES ||
        parseThreadSegmentFromAttachmentId(attachment.id) !==
          toSafeThreadAttachmentSegment(threadId)
      )
        return yield* invalid(
          "sendTurn",
          "Gemini accepts chat-owned PNG, JPEG and WebP images up to 5 MiB.",
        );
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      if (!path) return yield* invalid("sendTurn", "The image attachment is unavailable.");
      const data = yield* Effect.tryPromise({
        try: () => readExactImage(path, attachment.sizeBytes),
        catch: () => invalid("sendTurn", "The image attachment is unavailable."),
      });
      return {
        type: "image",
        mimeType: attachment.mimeType,
        data,
      } satisfies AcpSchema.ContentBlock;
    });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    locked(
      input.threadId,
      Effect.gen(function* () {
        if (
          disposing ||
          !settings.enabled ||
          (input.provider !== undefined && input.provider !== PROVIDER) ||
          (input.providerInstanceId !== undefined && input.providerInstanceId !== instanceId) ||
          (input.modelSelection !== undefined && input.modelSelection.instanceId !== instanceId)
        )
          return yield* invalid(
            "startSession",
            "The selected Gemini provider instance is unavailable.",
          );
        const interactionMode = input.interactionMode ?? "default";
        const permissionMode = resolvePermissionMode(input.runtimeMode, interactionMode);
        const bypassPermissions = interactionMode === "gemini-bypass";
        if (
          permissionMode === undefined ||
          (input.sandboxMode !== undefined && input.sandboxMode !== "danger-full-access") ||
          (input.approvalPolicy === "never" && !bypassPermissions) ||
          input.additionalDirectories?.length ||
          input.maxConcurrentSubagents != null ||
          input.codexContextWindowOverride != null ||
          input.requireIdleForSubagentLimitChange ||
          input.requireIdleForCodexContextWindowChange
        )
          return yield* invalid(
            "startSession",
            "Gemini supports one workspace with native permissions and no Cafe sandbox override.",
          );
        const cwd = input.cwd ?? config.cwd;
        const resume =
          input.resumeCursor == null
            ? undefined
            : yield* decodeResume(input.resumeCursor).pipe(
                Effect.mapError(() =>
                  invalid("startSession", "The Gemini resume cursor is invalid."),
                ),
              );
        if (
          resume &&
          (resume.instanceId !== instanceId ||
            resume.threadId !== input.threadId ||
            resume.cwd !== cwd)
        )
          return yield* invalid(
            "startSession",
            "The Gemini resume cursor belongs to another chat or workspace.",
          );
        if (resume && resume.nativeHomeScope !== nativeHomeScope)
          return yield* invalid(
            "startSession",
            "The Gemini conversation belongs to another native provider home.",
          );
        const previous = sessions.get(input.threadId);
        if (previous) {
          if (
            !owns(previous) ||
            previous.session.status !== "ready" ||
            previous.session.activeTurnId ||
            previous.approvals.size > 0 ||
            previous.questions.size > 0 ||
            hasDetachedTools(previous)
          )
            return yield* invalid(
              "startSession",
              "Gemini permissions can change only while the chat is idle.",
            );
          if (
            previous.session.runtimeMode === input.runtimeMode &&
            previous.session.interactionMode === interactionMode
          )
            return yield* invalid("startSession", "This chat already owns a Gemini session.");
          if (resume?.sessionId !== previous.nativeId || cwd !== previous.session.cwd)
            return yield* invalid(
              "startSession",
              "Changing Gemini permissions requires the exact resumable conversation.",
            );
        }
        const qualified = yield* qualifyGeminiCli(
          settings.binaryPath,
          cwd,
          environment,
          options.nativeHome,
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.mapError((error) => invalid("startSession", error.message)),
        );
        // The same per-chat lock covers both lifetimes. Join the exact idle
        // native process before starting a different permission owner, even
        // where both modes project the same ACP selector value.
        if (previous) {
          if (
            !owns(previous) ||
            previous.approvals.size > 0 ||
            previous.questions.size > 0 ||
            hasDetachedTools(previous)
          ) {
            return yield* invalid(
              "startSession",
              "Gemini background work is still active under the current permission mode.",
            );
          }
          yield* retire(previous, false, { suppressExitEvent: true });
        }
        const scope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred ? Effect.void : Scope.close(scope, Exit.void),
        );
        // The bridge and its scoped owner credential belong to this exact
        // opening. Scope cleanup revokes them after a rejected or interrupted
        // startup as well as after the admitted Gemini session retires.
        const managementMcp = yield* Effect.acquireRelease(
          makeManagementMcpSession({
            threadId: input.threadId,
            providerInstanceId: instanceId,
          }).pipe(
            Effect.provideService(ServerConfig, config),
            Effect.mapError(
              () =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Could not attach Cafe management tools.",
                }),
            ),
          ),
          (binding) => binding?.dispose ?? Effect.void,
        ).pipe(Effect.provideService(Scope.Scope, scope));
        const runtime = yield* native(
          input.threadId,
          "process/spawn",
          makeGeminiAcpRuntime({
            binaryPath: qualified.binaryPath,
            nativeHome: qualified.nativeHome,
            bypassPermissions,
            cwd,
            environment,
            childProcessSpawner,
            clientCapabilities: { elicitation: { form: {} } },
            clientInfo: { name: "cafe-code", version: APPLICATION_VERSION },
            observeSessionConfigUpdates: true,
            observeToolLifecycle: true,
            sessionMeta: (initializeResult) => {
              const antigravity = (
                initializeResult.agentCapabilities?._meta as
                  | {
                      readonly antigravity?: {
                        readonly systemPrompt?: { readonly append?: unknown };
                      };
                    }
                  | null
                  | undefined
              )?.antigravity;
              if (antigravity?.systemPrompt?.append !== true) return undefined;
              return {
                antigravity: {
                  systemPrompt: {
                    append: buildCafeInstructions({ cwd }),
                  },
                },
              };
            },
            ...(managementMcp ? { managementMcp } : {}),
            ...(resume
              ? { resumeSessionId: resume.sessionId, resumeSessionPolicy: "acknowledged" }
              : {}),
          }).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        let owner: SessionOwner | undefined;
        // The runtime receives no client-side filesystem or terminal
        // capabilities. No callback before exact session/turn admission grants
        // anything, even if the peer claims it belongs to this conversation.
        yield* runtime.handleRequestPermission((request) =>
          Effect.gen(function* () {
            const cancelled = { outcome: { outcome: "cancelled" as const } };
            const ctx = owner;
            const toolCallId = request.toolCall.toolCallId;
            const turnId = ctx ? approvalTurnFor(ctx, toolCallId) : undefined;
            if (
              !ctx ||
              !owns(ctx) ||
              ctx.bypassPermissions ||
              ctx.permissionModeRevoked ||
              !turnId ||
              request.sessionId !== ctx.nativeId ||
              !NATIVE_ID_PATTERN.test(toolCallId) ||
              ctx.retiredToolIds.has(toolCallId) ||
              ctx.approvals.size >= 64 ||
              request.options.length > 32
            )
              return cancelled;
            const allowOnce = exactPermissionOption(request.options, "allow_once");
            const rejectOnce = exactPermissionOption(request.options, "reject_once");
            if (!allowOnce) return cancelled;
            const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            if (
              !owns(ctx) ||
              ctx.permissionModeRevoked ||
              approvalTurnFor(ctx, toolCallId) !== turnId ||
              ctx.approvals.size >= 64
            )
              return cancelled;
            const permission = parsePermissionRequest(request);
            const detail =
              permission.kind === "execute"
                ? permission.toolCall?.command
                : (permission.toolCall?.detail ?? permission.toolCall?.title);
            // Approve only a bounded, displayable native action. A generic
            // prompt or truncated command cannot convey the scope of consent.
            if (!detail || detail.length > 4096) return cancelled;
            const pending = { turnId, decision, permission };
            ctx.approvals.set(requestId, pending);
            yield* emit(
              makeAcpRequestOpenedEvent({
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                requestId: RuntimeRequestId.make(requestId),
                permissionRequest: permission,
                detail,
                args: {},
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: {},
                suppressAlwaysAllowRule: true,
              }),
              ctx,
            );
            const response = yield* Deferred.await(decision);
            if (!owns(ctx)) return cancelled;
            return yield* locked(
              input.threadId,
              Effect.gen(function* () {
                if (!owns(ctx) || ctx.approvals.get(requestId) !== pending) return cancelled;
                const mode = getPermissionModeOption(
                  yield* ctx.runtime.getConfigOptions,
                  ctx.permissionMode,
                );
                const optionId =
                  ctx.permissionModeRevoked ||
                  mode?.id !== ctx.permissionConfigId ||
                  mode.currentValue !== ctx.permissionMode
                    ? undefined
                    : response === "accept"
                      ? allowOnce
                      : response === "decline"
                        ? rejectOnce
                        : undefined;
                yield* resolveApproval(ctx, requestId, pending, optionId ? response : "cancel");
                return optionId
                  ? { outcome: { outcome: "selected" as const, optionId } }
                  : cancelled;
              }),
            );
          }),
        );
        const handleElicitationRequest = (
          request: GeminiElicitationRequest | AcpSchema.ElicitationRequest,
        ): Effect.Effect<AcpSchema.ElicitationAction> =>
          Effect.gen(function* () {
            const cancelled = { action: "cancel" as const };
            const ctx = owner;
            const toolCallId =
              "toolCallId" in request && typeof request.toolCallId === "string"
                ? request.toolCallId
                : undefined;
            if (
              !ctx ||
              !owns(ctx) ||
              ctx.retiring ||
              ctx.permissionModeRevoked ||
              request.sessionId !== ctx.nativeId ||
              ctx.questions.size >= 32 ||
              (toolCallId !== undefined &&
                (!NATIVE_ID_PATTERN.test(toolCallId) || ctx.retiredToolIds.has(toolCallId)))
            ) {
              return cancelled;
            }
            const turnId =
              toolCallId !== undefined ? approvalTurnFor(ctx, toolCallId) : foregroundTurnFor(ctx);
            if (!turnId) return cancelled;
            const plan = parseGeminiElicitation(request);
            if (!plan) return cancelled;
            const requestId = ApprovalRequestId.make(yield* Random.nextUUIDv4);
            const decision = yield* Deferred.make<GeminiQuestionResolution>();
            if (
              !owns(ctx) ||
              ctx.retiring ||
              ctx.permissionModeRevoked ||
              ctx.questions.size >= 32
            ) {
              return cancelled;
            }
            const pending: PendingQuestion = { turnId, plan, decision };
            ctx.questions.set(requestId, pending);
            yield* emit(
              {
                ...(yield* base(input.threadId)),
                type: "user-input.requested",
                turnId,
                requestId: RuntimeRequestId.make(requestId),
                payload: {
                  questions: plan.questions,
                  ...(plan.supportsUnanswered ? { supportsUnanswered: true } : {}),
                },
              },
              ctx,
            );
            const resolution = yield* Deferred.await(decision);
            if (!owns(ctx)) return cancelled;
            return yield* locked(
              input.threadId,
              Effect.gen(function* () {
                if (!owns(ctx) || ctx.questions.get(requestId) !== pending) return cancelled;
                yield* resolveQuestion(ctx, requestId, pending, resolution);
                return resolution._tag === "answered" ? resolution.response : cancelled;
              }),
            );
          });
        yield* runtime.handleExtRequest(
          "elicitation/create",
          GeminiElicitationRequest,
          handleElicitationRequest,
        );
        yield* runtime.handleElicitation((request) =>
          handleElicitationRequest(request).pipe(Effect.map((action) => ({ action }))),
        );
        const started = yield* native(input.threadId, "session/setup", runtime.start()).pipe(
          Effect.timeoutOrElse({
            duration: START_REQUEST_TIMEOUT,
            orElse: () =>
              Effect.fail(
                invalid("startSession", "Gemini did not acknowledge session setup in time."),
              ),
          }),
        );
        const nativeId = yield* decodeNativeSessionId(started.sessionId).pipe(
          Effect.mapError(() =>
            invalid("startSession", "Gemini returned an invalid session identity."),
          ),
        );
        const applied = yield* native(
          input.threadId,
          "session/configure",
          configureSession(runtime, permissionMode, undefined, input.modelSelection),
        ).pipe(
          Effect.timeoutOrElse({
            duration: CONFIGURATION_TIMEOUT,
            orElse: () =>
              Effect.fail(
                invalid(
                  "startSession",
                  "Gemini did not acknowledge session configuration in time.",
                ),
              ),
          }),
        );
        if (disposing)
          return yield* invalid("startSession", "The Gemini provider is shutting down.");
        const capabilities = started.initializeResult.agentCapabilities;
        const resumable =
          capabilities?.sessionCapabilities?.resume != null || capabilities?.loadSession === true;
        const runtimeId = SubagentRuntimeId.make(yield* Random.nextUUIDv4);
        const createdAt = yield* now;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          subagentRuntimeId: runtimeId,
          threadId: input.threadId,
          cwd,
          runtimeMode: input.runtimeMode,
          interactionMode,
          status: "ready",
          model: applied.model,
          modelSelection: {
            instanceId,
            model: applied.model,
            ...(applied.reasoningEffort
              ? { options: [{ id: "reasoningEffort", value: applied.reasoningEffort }] }
              : {}),
          },
          ...(resumable
            ? {
                resumeCursor: {
                  version: 1,
                  instanceId,
                  threadId: input.threadId,
                  cwd,
                  sessionId: nativeId,
                  ...(nativeHomeScope ? { nativeHomeScope } : {}),
                },
              }
            : {}),
          createdAt,
          updatedAt: createdAt,
        };
        const ctx: SessionOwner = {
          runtime,
          scope,
          nativeId,
          runtimeId,
          supportsDetachedWake: compareSemverVersions(qualified.version, "1.5.10") >= 0,
          permissionMode,
          permissionConfigId: applied.permissionConfigId,
          bypassPermissions,
          supportsImages: capabilities?.promptCapabilities?.image === true,
          approvals: new Map(),
          questions: new Map(),
          toolBindings: new Map(),
          toolLifecycle: Semaphore.makeUnsafe(1),
          retiredToolIds: new Set(),
          detachedMessages: new Map(),
          session,
          promptGroup: undefined,
          lastSettledTurnId: undefined,
          backgroundReply: undefined,
          publicThought: undefined,
          publicThoughtCount: 0,
          permissionModeRevoked: false,
          retiring: false,
        };
        // Transfer and publish together. Failed or interrupted startup still
        // belongs to the opening scope and cannot leak a discoverable owner.
        yield* Effect.gen(function* () {
          owner = ctx;
          sessions.set(input.threadId, ctx);
          transferred = true;
          yield* runtime.getEvents().pipe(
            Stream.runForEach((event) => projectEvent(ctx, event)),
            Effect.interruptible,
            Effect.forkIn(scope),
          );
          yield* emit(
            {
              ...(yield* base(input.threadId)),
              type: "session.started",
              payload: { resume: { resumed: resume !== undefined } },
            },
            ctx,
          );
          yield* emit(
            {
              ...(yield* base(input.threadId)),
              type: "thread.started",
              payload: { providerThreadId: nativeId },
            },
            ctx,
          );
          yield* emit(
            {
              ...(yield* base(input.threadId)),
              type: "session.state.changed",
              payload: { state: "ready" },
            },
            ctx,
          );
          if (runtime.awaitExit) {
            yield* runtime.awaitExit.pipe(
              Effect.catch(() => Effect.succeed(-1)),
              Effect.andThen(locked(input.threadId, retire(ctx, true))),
              // Retirement joins the session scope, so its exit observer must
              // live beside that scope, not inside the scope it will close.
              Effect.interruptible,
              Effect.forkIn(instanceScope),
            );
          }
        }).pipe(Effect.uninterruptible);
        return session;
      }).pipe(Effect.scoped),
    );

  const ownsPromptGroup = (ctx: SessionOwner, group: GeminiPromptGroup) =>
    owns(ctx) && ctx.promptGroup === group && ctx.session.activeTurnId === group.turnId;

  const launchGroupedPrompt = (
    ctx: SessionOwner,
    group: GeminiPromptGroup,
    prompt: ReadonlyArray<AcpSchema.ContentBlock>,
    index: number,
  ) => {
    const threadId = ctx.session.threadId;
    const run = Effect.gen(function* () {
      const configOptions = yield* ctx.runtime.getConfigOptions;
      const mode = getPermissionModeOption(configOptions, ctx.permissionMode);
      if (!ownsPromptGroup(ctx, group)) return;
      if (
        group.usageModelConfirmed &&
        readGeminiAcpSelection(configOptions).model !== group.model
      ) {
        group.usageModelConfirmed = false;
      }
      if (
        !ctx.runtime.promptInGroup ||
        ctx.permissionModeRevoked ||
        mode?.id !== ctx.permissionConfigId ||
        mode.currentValue !== ctx.permissionMode
      ) {
        ctx.permissionModeRevoked = true;
        return yield* new GeminiAcpSelectionError({
          issue: "Gemini changed permission mode before sending the prompt.",
        });
      }
      const result = yield* ctx.runtime.promptInGroup(
        { prompt },
        {
          configOptions,
          isCurrent: () => ownsPromptGroup(ctx, group) && !ctx.permissionModeRevoked,
          onQueued: () => {
            if (!ownsPromptGroup(ctx, group)) return;
            if (index === 0) group.rootQueued = true;
            if (index === group.submitted) group.latestQueued = true;
          },
        },
      );
      yield* locked(
        threadId,
        Effect.gen(function* () {
          if (!ownsPromptGroup(ctx, group)) return;
          group.pending -= 1;
          if (!group.latest || group.latest.index < index)
            group.latest = { index, response: result };
          // Antigravity can answer the original RPC as soon as it receives a
          // concurrent follow-up. Its continued stream still belongs to this
          // Cafe turn until the final admitted RPC has also answered.
          if (group.pending !== 0) return;
          yield* ctx.runtime.finishPromptEvents;
          if (!ownsPromptGroup(ctx, group)) return;
          const { response } = group.latest;
          ctx.promptGroup = undefined;
          // This exact group has now settled once. Retain the highest admitted
          // RPC's result, regardless of which RPC replied last on the wire.
          if (group.usageModelConfirmed && !ctx.permissionModeRevoked) {
            const current = readGeminiAcpSelection(yield* ctx.runtime.getConfigOptions);
            const usage =
              !ctx.permissionModeRevoked && current.model === group.model
                ? readGeminiPromptUsage(group.model, response, group.submitted > 0)
                : undefined;
            if (usage) {
              yield* emit(
                {
                  ...(yield* base(threadId)),
                  type: "thread.usage-accounting.updated",
                  turnId: group.turnId,
                  payload: {
                    scopeId: yield* Random.nextUUIDv4,
                    revision: 1,
                    models: [usage.model],
                    completeness: usage.completeness,
                  },
                },
                ctx,
              );
            }
          }
          const reason = response.stopReason;
          yield* settle(
            ctx,
            group.turnId,
            reason === "cancelled" ? "cancelled" : "completed",
            reason,
          );
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : locked(
              threadId,
              Effect.gen(function* () {
                if (!ownsPromptGroup(ctx, group)) return;
                if (index !== 0 || group.submitted > 0) {
                  yield* emit(
                    {
                      ...(yield* base(threadId)),
                      type: "runtime.warning",
                      turnId: group.turnId,
                      payload: {
                        message:
                          "Gemini could not confirm the follow-up. Check the conversation before retrying.",
                      },
                    },
                    ctx,
                  );
                }
                // A disconnected RPC might already have reached the exact
                // native session. Preserve the Cafe input and never replay it.
                yield* retire(ctx, true);
              }),
            ).pipe(Effect.forkIn(instanceScope), Effect.asVoid),
      ),
    );
    return run.pipe(Effect.interruptible, Effect.forkIn(ctx.scope), Effect.asVoid);
  };

  const makePrompt = Effect.fn("gemini.makePrompt")(function* (
    ctx: SessionOwner,
    input: {
      readonly input?: string | undefined;
      readonly attachments?: readonly ChatAttachment[] | undefined;
    },
    operation: "sendTurn" | "steerTurn",
  ) {
    const text = input.input?.trim();
    // Sending an ordinary message must never invoke native /config or /login.
    if (text && /^\/[a-z][a-z0-9_-]*(?:\s|$)/iu.test(text))
      return yield* invalid(operation, "Native Gemini slash commands are not supported in Cafe.");
    const attachments = input.attachments ?? [];
    if (
      attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
      attachments.reduce((size, attachment) => size + attachment.sizeBytes, 0) >
        PROVIDER_SEND_TURN_MAX_TOTAL_ATTACHMENT_BYTES
    )
      return yield* invalid(operation, "The Gemini prompt exceeds the attachment limits.");
    if (!text && attachments.length === 0)
      return yield* invalid(operation, "A Gemini prompt or attachment is required.");

    // Image capability and inline byte limits apply only to native image blocks.
    const imageAttachments = attachments.filter((attachment) => attachment.type === "image");
    if (
      (imageAttachments.length > 0 && !ctx.supportsImages) ||
      imageAttachments.reduce((size, attachment) => size + attachment.sizeBytes, 0) >
        MAX_TURN_IMAGE_BYTES
    )
      return yield* invalid(operation, "The Gemini session cannot accept these image attachments.");

    // Reuse the chat-owned file inventory so Gemini reads validated local snapshots
    // with its current tool permissions. The prompt contains metadata and paths only.
    const fileManifest = yield* Effect.tryPromise({
      try: () =>
        prepareFileAttachmentPrompt({
          attachmentsDir: config.attachmentsDir,
          threadId: ctx.session.threadId,
          attachments,
        }),
      catch: () => invalid(operation, "A Gemini file attachment could not be prepared."),
    });
    const images = yield* Effect.forEach(imageAttachments, (attachment) =>
      imageBlock(ctx.session.threadId, attachment),
    );
    return [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...(fileManifest ? [{ type: "text" as const, text: fileManifest }] : []),
      ...images,
    ];
  });

  const deferSteer = () =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "steerTurn",
      remoteErrorTag: "gemini-follow-up-not-admitted",
      detail: "Gemini can take this follow-up after the current response.",
    });

  const steerTurn: ProviderAdapterShape<ProviderAdapterError>["steerTurn"] = (input) =>
    locked(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireOwner(input.threadId);
        const group = ctx.promptGroup;
        if (
          !group ||
          group.turnId !== input.expectedTurnId ||
          !ownsPromptGroup(ctx, group) ||
          ctx.permissionModeRevoked ||
          !group.latestQueued ||
          group.pending !== 1 ||
          group.submitted >= MAX_GEMINI_FOLLOW_UPS_PER_TURN
        )
          return yield* deferSteer();
        const prompt = yield* makePrompt(ctx, input, "steerTurn");
        if (
          !ownsPromptGroup(ctx, group) ||
          ctx.permissionModeRevoked ||
          !group.latestQueued ||
          group.pending !== 1 ||
          group.submitted >= MAX_GEMINI_FOLLOW_UPS_PER_TURN
        )
          return yield* deferSteer();
        yield* Effect.gen(function* () {
          group.latestQueued = false;
          group.pending += 1;
          group.submitted += 1;
          yield* launchGroupedPrompt(ctx, group, prompt, group.submitted);
        }).pipe(Effect.uninterruptible);
        return {
          threadId: input.threadId,
          turnId: group.turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      }),
    );

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    locked(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireOwner(input.threadId);
        if (
          ctx.session.status !== "ready" ||
          ctx.session.activeTurnId ||
          ctx.permissionModeRevoked ||
          ctx.approvals.size !== 0 ||
          ctx.questions.size !== 0
        )
          return yield* invalid("sendTurn", "The Gemini session is busy.");
        if (
          (input.modelSelection && input.modelSelection.instanceId !== instanceId) ||
          (input.interactionMode ?? "default") !== ctx.session.interactionMode
        )
          return yield* invalid("sendTurn", "The requested Gemini account or mode is unavailable.");
        const prompt = yield* makePrompt(ctx, input, "sendTurn");
        const configured = yield* native(
          input.threadId,
          "session/configure",
          configureSession(
            ctx.runtime,
            ctx.permissionMode,
            ctx.permissionConfigId,
            input.modelSelection,
          ),
        ).pipe(Effect.timeoutOption(CONFIGURATION_TIMEOUT));
        if (Option.isNone(configured)) {
          // The change may already have reached Gemini. Join this process
          // instead of submitting a later prompt under an ambiguous tuple.
          yield* retire(ctx, true);
          return yield* invalid(
            "sendTurn",
            "Gemini did not acknowledge session configuration in time.",
          );
        }
        const applied = configured.value;
        // Finish already observed idle output before publishing a new root.
        // Only exact native IDs already seen idle can cross this boundary.
        yield* ctx.runtime.finishPromptEvents;
        yield* finishBackgroundReply(ctx);
        if (ctx.approvals.size > 0 || ctx.questions.size > 0) {
          return yield* invalid(
            "sendTurn",
            ctx.questions.size > 0
              ? "Gemini is waiting for a question response."
              : "Gemini is waiting for a permission response.",
          );
        }
        if (!owns(ctx) || ctx.permissionModeRevoked) {
          return yield* invalid(
            "sendTurn",
            "Gemini changed permission mode before sending the prompt.",
          );
        }
        const turnId = TurnId.make(yield* Random.nextUUIDv4);
        const eventBase = yield* base(input.threadId);
        yield* Effect.gen(function* () {
          const group: GeminiPromptGroup = {
            turnId,
            model: applied.model,
            usageModelConfirmed: true,
            pending: 1,
            submitted: 0,
            rootQueued: false,
            latestQueued: false,
            latest: undefined,
          };
          ctx.promptGroup = group;
          ctx.publicThoughtCount = 0;
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            status: "running",
            model: applied.model,
            modelSelection: {
              instanceId,
              model: applied.model,
              ...(applied.reasoningEffort
                ? { options: [{ id: "reasoningEffort", value: applied.reasoningEffort }] }
                : {}),
            },
            updatedAt: eventBase.createdAt,
          };
          yield* emit(
            {
              ...eventBase,
              type: "turn.started",
              turnId,
              payload: {
                model: applied.model,
                ...(applied.reasoningEffort ? { effort: applied.reasoningEffort } : {}),
              },
            },
            ctx,
          );
          // Let the owned scope settle every native reply without holding the
          // command lock or preventing Stop during generation.
          yield* launchGroupedPrompt(ctx, group, prompt, 0);
        }).pipe(Effect.uninterruptible);
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
          resolvedGeminiConfiguration: {
            model: applied.model,
            ...(applied.reasoningEffort ? { effort: applied.reasoningEffort } : {}),
          },
        };
      }),
    );

  const stopAll = () =>
    Effect.suspend(() =>
      Effect.forEach(
        [...sessions.values()],
        (ctx) => locked(ctx.session.threadId, retire(ctx, false)),
        { discard: true },
      ),
    );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      disposing = true;
      yield* stopAll();
      yield* PubSub.shutdown(events);
    }),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", liveSteer: "supported" },
    startSession,
    sendTurn,
    steerTurn,
    interruptTurn: (threadId, turnId) =>
      locked(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireOwner(threadId);
          const active = ctx.session.activeTurnId;
          const matches = active
            ? !turnId || active === turnId
            : [...ctx.approvals.values()].some((pending) => !turnId || pending.turnId === turnId) ||
              [...ctx.questions.values()].some((pending) => !turnId || pending.turnId === turnId) ||
              [...ctx.toolBindings.values()].some(
                (binding) => binding.detached && (!turnId || binding.turnId === turnId),
              );
          if (matches) yield* retire(ctx, false);
        }),
      ),
    respondToRequest: (threadId, requestId, decision) =>
      locked(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireOwner(threadId);
          const pending = ctx.approvals.get(requestId);
          if (
            !pending ||
            !(decision === "accept" || decision === "decline" || decision === "cancel")
          )
            return yield* invalid(
              "respondToRequest",
              "The exact Gemini approval is unavailable or this choice is unsupported.",
            );
          if (!(yield* Deferred.succeed(pending.decision, decision)))
            return yield* invalid(
              "respondToRequest",
              "The Gemini approval has already been resolved.",
            );
        }),
      ),
    respondToUserInput: (threadId, requestId, answers, unanswered?) =>
      locked(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireOwner(threadId);
          const pending = ctx.questions.get(requestId);
          if (!pending) {
            return yield* invalid(
              "respondToUserInput",
              "The Gemini question is no longer pending.",
            );
          }
          const resolved = buildGeminiElicitationResponse(pending.plan, answers, unanswered);
          if (!resolved) {
            return yield* invalid(
              "respondToUserInput",
              "The response does not match the pending Gemini question.",
            );
          }
          if (!(yield* Deferred.succeed(pending.decision, { _tag: "answered", ...resolved }))) {
            return yield* invalid(
              "respondToUserInput",
              "The Gemini question has already been resolved.",
            );
          }
        }),
      ),
    stopSession: (threadId) =>
      locked(
        threadId,
        Effect.suspend(() => {
          const ctx = sessions.get(threadId);
          return ctx ? retire(ctx, false) : Effect.void;
        }),
      ),
    stopAll,
    listSessions: () =>
      Effect.sync(() => [...sessions.values()].filter(owns).map((ctx) => ctx.session)),
    hasSession: (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && owns(ctx);
      }),
    readThread: () =>
      Effect.fail(
        invalid("readThread", "Gemini ACP does not expose a read-only transcript snapshot."),
      ),
    rollbackThread: () =>
      Effect.fail(
        invalid("rollbackThread", "Gemini ACP does not support Cafe checkpoint rollback."),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
