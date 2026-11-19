import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  TurnId,
  type ChatAttachment,
  type GeminiSettings,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import {
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
} from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntime, AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import { makeGeminiAcpRuntime, qualifyGeminiCli } from "../acp/GeminiAcpRuntime.ts";
import { applyGeminiAcpSelection, GeminiAcpSelectionError } from "../acp/GeminiAcpSupport.ts";

const PROVIDER = ProviderDriverKind.make("gemini");
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TURN_IMAGE_BYTES = 12 * 1024 * 1024;
const START_REQUEST_TIMEOUT = "20 seconds";
const CONFIGURATION_TIMEOUT = "8 seconds";
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const NativeSessionId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,200}$/u));
const decodeNativeSessionId = Schema.decodeUnknownEffect(NativeSessionId);
const decodeResume = Schema.decodeUnknownEffect(
  Schema.Struct({
    version: Schema.Literal(1),
    instanceId: ProviderInstanceId,
    threadId: Schema.String,
    cwd: Schema.String,
    sessionId: NativeSessionId,
  }),
);
type Runtime = AcpSessionRuntime["Service"];

interface PendingApproval {
  readonly turnId: TurnId;
  readonly permission: AcpPermissionRequest;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface SessionOwner {
  readonly runtime: Runtime;
  readonly scope: Scope.Closeable;
  readonly nativeId: string;
  readonly supportsImages: boolean;
  readonly approvals: Map<ApprovalRequestId, PendingApproval>;
  session: ProviderSession;
  permissionModeRevoked: boolean;
  retiring: boolean;
}

export interface GeminiAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
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

function getDefaultMode(configOptions: ReadonlyArray<AcpSchema.SessionConfigOption>) {
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
    collectSessionConfigOptionValues(mode).filter((value) => value === "default").length !== 1
  )
    return undefined;
  return mode;
}

const configureSession = Effect.fn("gemini.configureSession")(function* (
  runtime: Runtime,
  selection?: ModelSelection,
) {
  const mode = getDefaultMode(yield* runtime.getConfigOptions);
  if (!mode) {
    return yield* new GeminiAcpSelectionError({
      issue: "Gemini did not advertise its Default approval mode.",
    });
  }
  if (mode.currentValue !== "default") {
    const acknowledgement = getDefaultMode(
      (yield* runtime.setConfigOption(mode.id, "default")).configOptions,
    );
    if (acknowledgement?.id !== mode.id || acknowledgement.currentValue !== "default") {
      return yield* new GeminiAcpSelectionError({
        issue: "Gemini did not acknowledge its Default approval mode.",
      });
    }
  }
  const applied = yield* applyGeminiAcpSelection(runtime, selection);
  const current = getDefaultMode(yield* runtime.getConfigOptions);
  if (current?.id !== mode.id || current.currentValue !== "default") {
    return yield* new GeminiAcpSelectionError({
      issue: "Gemini changed its Default approval mode during configuration.",
    });
  }
  return applied;
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
  const events = yield* PubSub.bounded<ProviderRuntimeEvent>(2048);
  const sessions = new Map<ThreadId, SessionOwner>();
  const locks = new Map<ThreadId, { semaphore: Semaphore.Semaphore; users: number }>();
  let disposing = false;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const stamp = Effect.gen(function* () {
    return { eventId: EventId.make(yield* Random.nextUUIDv4), createdAt: yield* now };
  });
  const emit = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, { ...event, providerInstanceId: instanceId }).pipe(Effect.asVoid);
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
      );
    });

  const settle = (
    ctx: SessionOwner,
    turnId: TurnId,
    state: "completed" | "failed" | "cancelled",
    stopReason?: AcpSchema.StopReason,
  ) =>
    Effect.gen(function* () {
      if (ctx.session.activeTurnId !== turnId) return;
      ctx.session = {
        ...ctx.session,
        activeTurnId: undefined,
        status: state === "failed" ? "error" : "ready",
        updatedAt: yield* now,
      };
      yield* emit({
        ...(yield* base(ctx.session.threadId)),
        type: "turn.completed",
        turnId,
        payload: {
          state,
          ...(stopReason ? { stopReason } : {}),
          resumeCursor: ctx.session.resumeCursor,
          ...(state === "failed" ? { errorMessage: "The Gemini ACP turn failed." } : {}),
        },
      });
    });

  const retire = (ctx: SessionOwner, failure: boolean) =>
    Effect.gen(function* () {
      if (!owns(ctx)) return;
      ctx.retiring = true;
      const turnId = ctx.session.activeTurnId;
      if ((turnId || ctx.approvals.size > 0) && !failure) {
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
      yield* Scope.close(ctx.scope, Exit.void);
      if (turnId) yield* settle(ctx, turnId, failure ? "failed" : "cancelled");
      sessions.delete(ctx.session.threadId);
      yield* emit({
        ...(yield* base(ctx.session.threadId)),
        type: "session.exited",
        payload: failure
          ? { exitKind: "error", recoverable: true, reason: "The Gemini ACP session ended." }
          : { exitKind: "graceful" },
      });
    }).pipe(Effect.uninterruptible);

  const projectEvent = (ctx: SessionOwner, event: AcpSessionRuntimeEvent) =>
    Effect.gen(function* () {
      if (event._tag === "EventStreamBarrier") {
        yield* Deferred.succeed(event.acknowledge, undefined);
        return;
      }
      const turnId = ctx.session.activeTurnId;
      if (
        event._tag === "SessionConfigurationChanged" &&
        event.modeId !== "default" &&
        owns(ctx) &&
        !ctx.permissionModeRevoked &&
        (turnId || ctx.approvals.size > 0)
      ) {
        // A live native mode change withdraws callback authority before
        // asynchronous retirement. Retirement must join this event fiber
        // from the separate instance scope.
        ctx.permissionModeRevoked = true;
        yield* locked(ctx.session.threadId, retire(ctx, true)).pipe(Effect.forkIn(instanceScope));
        return;
      }
      if (!owns(ctx) || !turnId) return;
      const threadId = ctx.session.threadId;
      const eventContext = { stamp: yield* stamp, provider: PROVIDER, threadId, turnId };
      if (!owns(ctx) || ctx.session.activeTurnId !== turnId) return;
      switch (event._tag) {
        case "AssistantItemStarted":
        case "AssistantItemCompleted":
          yield* emit(
            makeAcpAssistantItemEvent({
              ...eventContext,
              itemId: event.itemId,
              lifecycle: event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
            }),
          );
          break;
        case "ContentDelta":
          yield* emit(makeAcpContentDeltaEvent({ ...eventContext, ...event }));
          break;
        case "ToolCallUpdated":
          yield* emit(makeAcpToolCallEvent({ ...eventContext, ...event }));
          break;
        case "PlanUpdated":
          yield* emit(
            makeAcpPlanUpdatedEvent({
              ...eventContext,
              ...event,
              source: "acp.jsonrpc",
              method: "session/update",
            }),
          );
          break;
        case "ContextUsageUpdated":
          // ACP reports current context occupancy. Treat neither occupancy
          // nor its optional cost metadata as cumulative account usage.
          yield* emit({
            ...(yield* base(threadId)),
            type: "thread.token-usage.updated",
            turnId,
            payload: { usage: { usedTokens: event.usedTokens, maxTokens: event.maxTokens } },
          });
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
        if (
          input.runtimeMode !== "full-access" ||
          (input.interactionMode !== undefined && input.interactionMode !== "default") ||
          (input.sandboxMode !== undefined && input.sandboxMode !== "danger-full-access") ||
          input.approvalPolicy === "never" ||
          input.additionalDirectories?.length ||
          input.maxConcurrentSubagents != null ||
          input.codexContextWindowOverride != null ||
          input.requireIdleForSubagentLimitChange ||
          input.requireIdleForCodexContextWindowChange
        )
          return yield* invalid(
            "startSession",
            "Gemini currently supports one workspace with native Default approvals and no Cafe sandbox override.",
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
        if (sessions.has(input.threadId))
          return yield* invalid("startSession", "This chat already owns a Gemini session.");
        const qualified = yield* qualifyGeminiCli(settings.binaryPath, cwd, environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.mapError((error) => invalid("startSession", error.message)),
        );
        const scope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred ? Effect.void : Scope.close(scope, Exit.void),
        );
        const runtime = yield* native(
          input.threadId,
          "process/spawn",
          makeGeminiAcpRuntime({
            binaryPath: qualified.binaryPath,
            cwd,
            environment,
            childProcessSpawner,
            clientInfo: { name: "cafe-code", version: APPLICATION_VERSION },
            observeSessionConfigUpdates: true,
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
            const turnId = ctx?.session.activeTurnId;
            if (
              !ctx ||
              !owns(ctx) ||
              ctx.permissionModeRevoked ||
              !turnId ||
              request.sessionId !== ctx.nativeId ||
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
              ctx.session.activeTurnId !== turnId ||
              ctx.approvals.size >= 64
            )
              return cancelled;
            const permission = parsePermissionRequest(request);
            const detail =
              permission.kind === "execute"
                ? permission.toolCall?.command
                : (permission.toolCall?.title ?? permission.toolCall?.detail);
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
            );
            const response = yield* Deferred.await(decision);
            if (!owns(ctx)) return cancelled;
            return yield* locked(
              input.threadId,
              Effect.gen(function* () {
                if (!owns(ctx) || ctx.approvals.get(requestId) !== pending) return cancelled;
                const mode = getDefaultMode(yield* ctx.runtime.getConfigOptions);
                const optionId =
                  ctx.permissionModeRevoked || mode?.currentValue !== "default"
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
          configureSession(runtime, input.modelSelection),
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
        const createdAt = yield* now;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          cwd,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
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
          supportsImages: capabilities?.promptCapabilities?.image === true,
          approvals: new Map(),
          session,
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
          yield* emit({
            ...(yield* base(input.threadId)),
            type: "session.started",
            payload: { resume: { resumed: resume !== undefined } },
          });
          yield* emit({
            ...(yield* base(input.threadId)),
            type: "thread.started",
            payload: { providerThreadId: nativeId },
          });
          yield* emit({
            ...(yield* base(input.threadId)),
            type: "session.state.changed",
            payload: { state: "ready" },
          });
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

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    locked(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireOwner(input.threadId);
        if (
          ctx.session.status !== "ready" ||
          ctx.session.activeTurnId ||
          ctx.permissionModeRevoked ||
          ctx.approvals.size !== 0
        )
          return yield* invalid("sendTurn", "The Gemini session is busy.");
        if (
          (input.modelSelection && input.modelSelection.instanceId !== instanceId) ||
          (input.interactionMode !== undefined && input.interactionMode !== "default")
        )
          return yield* invalid("sendTurn", "The requested Gemini account or mode is unavailable.");
        const text = input.input?.trim();
        // The initial integration exposes no native slash-command selector.
        // Out-of-band /config and /login commands cannot be used as control RPCs.
        if (text && /^\/[a-z][a-z0-9_-]*(?:\s|$)/iu.test(text))
          return yield* invalid(
            "sendTurn",
            "Native Gemini slash commands are not supported in Cafe.",
          );
        const attachments = input.attachments ?? [];
        if (
          attachments.length > 8 ||
          (attachments.length > 0 && !ctx.supportsImages) ||
          attachments.reduce((size, attachment) => size + attachment.sizeBytes, 0) >
            MAX_TURN_IMAGE_BYTES
        )
          return yield* invalid(
            "sendTurn",
            "The Gemini session cannot accept these image attachments.",
          );
        if (!text && attachments.length === 0)
          return yield* invalid("sendTurn", "A Gemini prompt or image attachment is required.");
        const images = yield* Effect.forEach(attachments, (attachment) =>
          imageBlock(input.threadId, attachment),
        );
        const prompt: ReadonlyArray<AcpSchema.ContentBlock> = text
          ? [{ type: "text", text }, ...images]
          : images;
        const configured = yield* native(
          input.threadId,
          "session/configure",
          configureSession(ctx.runtime, input.modelSelection),
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
        const turnId = TurnId.make(yield* Random.nextUUIDv4);
        const eventBase = yield* base(input.threadId);
        yield* Effect.gen(function* () {
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
          yield* emit({
            ...eventBase,
            type: "turn.started",
            turnId,
            payload: {
              model: applied.model,
              ...(applied.reasoningEffort ? { effort: applied.reasoningEffort } : {}),
            },
          });
          const run = Effect.gen(function* () {
            const result = yield* ctx.runtime.prompt({ prompt });
            yield* ctx.runtime.finishPromptEvents;
            yield* locked(
              input.threadId,
              Effect.suspend(() =>
                owns(ctx)
                  ? settle(
                      ctx,
                      turnId,
                      result.stopReason === "cancelled" ? "cancelled" : "completed",
                      result.stopReason,
                    )
                  : Effect.void,
              ),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : locked(input.threadId, retire(ctx, true)).pipe(
                    Effect.forkIn(instanceScope),
                    Effect.asVoid,
                  ),
            ),
          );
          // ACP responds after generation. Cafe acknowledges the turn now and
          // lets the owned session scope publish its terminal event later.
          yield* run.pipe(Effect.interruptible, Effect.forkIn(ctx.scope));
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
    capabilities: { sessionModelSwitch: "in-session", liveSteer: "unsupported" },
    startSession,
    sendTurn,
    steerTurn: () =>
      Effect.fail(invalid("steerTurn", "Gemini ACP cannot bind steering to an exact active turn.")),
    interruptTurn: (threadId, turnId) =>
      locked(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireOwner(threadId);
          const active = ctx.session.activeTurnId;
          const matches = active
            ? !turnId || active === turnId
            : [...ctx.approvals.values()].some((pending) => !turnId || pending.turnId === turnId);
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
    respondToUserInput: () =>
      Effect.fail(invalid("respondToUserInput", "Gemini structured questions are not available.")),
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
