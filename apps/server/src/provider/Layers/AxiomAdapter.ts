import { createHash, randomUUID } from "node:crypto";
import {
  ProviderCommandCatalog,
  ProviderMcpState,
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  SubagentRuntimeId,
  TurnId,
  type AxiomSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSecurityNativeRefreshInput,
  type ProviderSecurityReport,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as AcpErrors from "effect-acp/errors";
import * as AcpSchema from "effect-acp/schema";
import { ServerConfig } from "../../config.ts";
import { readStoredFileAttachment } from "../../fileAttachmentStore.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { AcpSessionRuntime } from "../acp/AcpSessionRuntime.ts";
import {
  applyAxiomSelection,
  configureAxiomDesktopSession,
  AxiomAccount,
  AxiomModels,
  AxiomVerification,
  axiomConfigurationKey,
  axiomAccountKey,
  decodeAxiom,
  makeAxiomControl,
  makeAxiomRuntime,
  validateAxiomEvidence,
  type AxiomModel,
  type AxiomSessionIdentity,
} from "../acp/AxiomAcpSupport.ts";
import { axiomUsageAccounting, axiomUsageTimestamp } from "../axiomUsageAccounting.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";

const PROVIDER = ProviderDriverKind.make("axiom");
// These native commands change ownership or policy managed by Cafe, including
// security-consent aliases. Route them through the corresponding Cafe control.
const OWNED_COMMANDS = new Set([
  "new",
  "load",
  "resume",
  "sessions",
  "delete",
  "delete-session",
  "delete-sessions",
  "update",
  "exit",
  "quit",
  "model",
  "models",
  "thinking",
  "reasoning",
  "profile",
  "permissions",
  "login",
  "signin",
  "logout",
  "signout",
  "account",
  "whoami",
  "security",
  "attestation",
  "refresh",
  "reverify",
  "accept-outdated-tee",
  "theme",
  "web",
  "balance",
  "credits",
  "topup",
  "top-up",
  "redeem",
  "usage",
  "mcp",
]);
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const ResumeFields = {
  sessionId: Identifier,
  accountKey: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  turns: Schema.optional(
    Schema.Array(Schema.Struct({ nativeId: Identifier, cafeId: TurnId })).check(
      Schema.isMaxLength(2000),
    ),
  ),
};
const Resume = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  frontend: Schema.Literal("desktop-chat"),
  nativeCwd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192)),
  agentRevision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  ...ResumeFields,
});
const decodeResume = Schema.decodeUnknownEffect(Resume);
const readMcpState = (runtime: Pick<AcpSessionRuntime["Service"], "request">, nativeId: string) =>
  runtime.request("_axiom/desktop/mcp", { threadId: nativeId, action: { kind: "list" } }).pipe(
    Effect.flatMap((value) => decodeAxiom(ProviderMcpState, value)),
    Effect.timeout("15 seconds"),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        AcpErrors.AcpRequestError.invalidParams(
          "Axiom MCP settings could not be read. Refresh before retrying.",
        ),
      ),
    ),
  );
const decodeCommandCatalog = Schema.decodeUnknownExit(ProviderCommandCatalog);
const NativeHistoryPage = Schema.Struct({
  thread: Schema.Struct({
    threadId: Identifier,
    revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    lastTimelineSequence: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  }),
  items: Schema.Array(
    Schema.Struct({
      id: Identifier,
      turnId: Schema.optional(Schema.NullOr(Identifier)),
      kind: Identifier,
      content: Schema.String.check(Schema.isMaxLength(2 * 1024 * 1024)),
    }),
  ).check(Schema.isMaxLength(500)),
  nextCursor: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  ),
});
const ContextUsage = Schema.Struct({
  modelId: Identifier,
  inputTokens: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  outputTokens: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  contextWindowTokens: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ),
});
const Activity = Schema.Struct({
  runtimeInstanceId: Identifier,
  sessionId: Schema.optional(Identifier),
  sequence: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
  ),
  occurredAt: Schema.String.check(Schema.isMaxLength(64)),
  event: Schema.Record(Schema.String, Schema.Unknown),
});
const Usage = Schema.Struct({
  requestId: Identifier,
  modelId: Identifier,
  turnId: Schema.optional(Schema.NullOr(Identifier)),
  purpose: Schema.optional(Schema.Literals(["conversation", "title", "compaction"])),
  state: Schema.optional(Schema.Literals(["running", "completed", "failed", "cancelled"])),
  responseVerified: Schema.optional(Schema.Boolean),
});
const MessageDelivery = Schema.Struct({
  update: Schema.Struct({ messageId: Schema.optional(Identifier) }),
});
const ActiveTurn = Schema.Struct({ turnId: Schema.NullOr(Identifier) });
const decodeMessageDelivery = Schema.decodeUnknownExit(MessageDelivery);
const SteerResult = Schema.Struct({ turnId: Identifier, clientItemId: Identifier });

interface PendingApproval {
  readonly deferred: Deferred.Deferred<ProviderApprovalDecision | null>;
  readonly request: AcpSchema.RequestPermissionRequest;
}
type AxiomQuestionResult =
  | { action: "cancel" }
  | { action: "accept"; content: Record<string, string | string[]> };
interface PendingQuestion {
  readonly deferred: Deferred.Deferred<AxiomQuestionResult>;
  readonly request: Extract<AcpSchema.ElicitationRequest, { mode: "form" }>;
}
interface SessionContext {
  session: ProviderSession;
  runtime: AcpSessionRuntime["Service"];
  scope: Scope.Closeable;
  nativeId: string;
  identity: AxiomSessionIdentity;
  nativeCwd: string;
  agentRevision: number;
  webEnabled: boolean;
  mcp: typeof ProviderMcpState.Type;
  models: readonly AxiomModel[];
  sequence: number;
  nativeTurn: string | undefined;
  turn: TurnId | undefined;
  verificationBusy: boolean;
  closed: boolean;
  replyChecked: boolean;
  replyFailed: boolean;
  replyRequests: Map<string, boolean>;
  settledCosts: Set<string>;
  approvals: Map<ApprovalRequestId, PendingApproval>;
  questions: Map<ApprovalRequestId, PendingQuestion>;
  nativeTurns: Map<string, TurnId>;
  completion: Deferred.Deferred<void> | undefined;
  cancelRequested: boolean;
  accountValid: boolean;
  localCommand: boolean;
  pendingItems: Set<string>;
  admittedItems: Set<string>;
}

const resumeCursor = (
  ctx: Pick<
    SessionContext,
    "identity" | "nativeId" | "nativeCwd" | "agentRevision" | "nativeTurns"
  >,
) => ({
  schemaVersion: 2,
  frontend: "desktop-chat",
  nativeCwd: ctx.nativeCwd,
  agentRevision: ctx.agentRevision,
  sessionId: ctx.nativeId,
  accountKey: ctx.identity.accountKey,
  turns: [...ctx.nativeTurns].map(([nativeId, cafeId]) => ({ nativeId, cafeId })),
});

export function selectAxiomPermissionOption(
  request: AcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  // Select an actual offered id. A native prefix/session grant is narrower
  // than a generic Cafe label and must never be invented by this adapter.
  const kind =
    decision === "accept"
      ? "allow_once"
      : decision === "acceptForSession"
        ? "allow_always"
        : "reject_once";
  const choices = request.options.filter((option) => option.kind === kind);
  if (decision === "acceptForSession")
    return choices.find((option) => option.optionId === "allow_exact_session")?.optionId;
  return choices.length === 1 ? choices[0]?.optionId : undefined;
}

export function axiomQuestionOptions(
  property: AcpSchema.ElicitationPropertySchema,
): readonly string[] {
  if (property.type === "string")
    return property.enum ?? property.oneOf?.map((option) => option.const) ?? [];
  if (property.type === "array")
    return "enum" in property.items
      ? property.items.enum
      : property.items.anyOf.map((option) => option.const);
  return [];
}

export interface AxiomAdapterOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: typeof makeAxiomRuntime;
  readonly onAccountChanged?: Effect.Effect<void>;
  readonly configurationKey?: string;
}

export const makeAxiomAdapter = Effect.fn("makeAxiomAdapter")(function* (
  settings: AxiomSettings,
  options: AxiomAdapterOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const instanceScope = yield* Scope.Scope;
  let loginPending = false;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const instanceId = options.instanceId ?? ProviderInstanceId.make("axiom");
  const factory = options.makeRuntime ?? makeAxiomRuntime;
  const sessions = new Map<string, SessionContext>();
  const locks = new Map<string, Semaphore.Semaphore>();
  const events = yield* PubSub.bounded<ProviderRuntimeEvent>(2048);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const stamp = Effect.gen(function* () {
    return { eventId: EventId.make(randomUUID()), createdAt: yield* now };
  });
  const emit = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, {
      ...event,
      providerInstanceId: instanceId,
      ...(sessions.get(event.threadId)?.session.subagentRuntimeId
        ? { subagentRuntimeId: sessions.get(event.threadId)!.session.subagentRuntimeId }
        : {}),
    }).pipe(Effect.asVoid);
  const lock = <A, E, R>(id: string, effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      let semaphore = locks.get(id);
      if (!semaphore) {
        semaphore = yield* Semaphore.make(1);
        locks.set(id, semaphore);
      }
      return yield* semaphore.withPermits(1)(effect);
    });
  const requireSession = (id: string) =>
    Effect.suspend(() => {
      const ctx = sessions.get(id);
      return ctx && !ctx.closed
        ? Effect.succeed(ctx)
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId: id }),
          );
    });
  const invalid = (operation: string, issue: string) =>
    new ProviderAdapterValidationError({ provider: PROVIDER, operation, issue });
  const native = <A>(
    ctx: SessionContext,
    method: string,
    effect: Effect.Effect<A, AcpErrors.AcpError>,
  ) =>
    effect.pipe(
      Effect.mapError((error) =>
        mapAcpToAdapterError(PROVIDER, ctx.session.threadId, method, error),
      ),
    );
  const metadataChanged = (ctx: SessionContext) =>
    Effect.gen(function* () {
      yield* emit({
        type: "session.configured",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: ctx.session.threadId,
        payload: { config: {}, securityReportChanged: true },
      });
    });
  const updateReport = (ctx: SessionContext, update: Partial<ProviderSecurityReport>) =>
    Effect.gen(function* () {
      const old = ctx.session.securityReport;
      if (!old || !ctx.accountValid || ctx.closed || sessions.get(ctx.session.threadId) !== ctx)
        return;
      ctx.session = {
        ...ctx.session,
        securityReport: { ...old, ...update, observedAt: yield* now },
      };
      yield* metadataChanged(ctx);
    });
  const settle = (
    ctx: SessionContext,
    turn: TurnId,
    state: "completed" | "failed" | "cancelled",
    stopReason?: string,
  ) =>
    Effect.gen(function* () {
      if (ctx.turn !== turn) return;
      // A completed prompt alone is not response authentication. Every observed
      // conversation request must have a native authenticated terminal receipt.
      const verified =
        state === "completed" &&
        ctx.replyChecked &&
        !ctx.replyFailed &&
        ctx.replyRequests.size > 0 &&
        [...ctx.replyRequests.values()].every(Boolean);
      yield* updateReport(ctx, {
        reply: {
          state: verified ? "verified" : state === "failed" ? "failed" : "incomplete",
          turnId: turn,
          modelId: ctx.session.model,
        },
      });
      yield* cancelInteractions(ctx);
      ctx.turn = undefined;
      ctx.nativeTurn = undefined;
      ctx.session = {
        ...ctx.session,
        status: state === "failed" || !ctx.accountValid ? "error" : "ready",
        activeTurnId: undefined,
        updatedAt: yield* now,
      };
      yield* emit({
        type: "turn.completed",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: ctx.session.threadId,
        turnId: turn,
        payload: {
          state,
          resumeCursor: ctx.session.resumeCursor,
          ...(stopReason ? { stopReason } : {}),
          ...(state === "failed"
            ? { errorMessage: "Axiom could not complete this response." }
            : {}),
        },
      });
      if (ctx.completion) yield* Deferred.succeed(ctx.completion, undefined);
    });
  const cancelInteractions = (ctx: SessionContext) =>
    Effect.gen(function* () {
      for (const approval of ctx.approvals.values())
        yield* Deferred.succeed(approval.deferred, null);
      for (const question of ctx.questions.values())
        yield* Deferred.succeed(question.deferred, { action: "cancel" });
    });
  const close = (ctx: SessionContext) =>
    Effect.gen(function* () {
      if (ctx.closed) return;
      yield* cancelInteractions(ctx);
      if (ctx.turn) yield* settle(ctx, ctx.turn, "cancelled", "cancelled");
      ctx.closed = true;
      ctx.session = { ...ctx.session, status: "closed", updatedAt: yield* now };
      yield* Scope.close(ctx.scope, Exit.void);
      if (sessions.get(ctx.session.threadId) === ctx) sessions.delete(ctx.session.threadId);
      yield* emit({
        type: "session.exited",
        ...(yield* stamp),
        provider: PROVIDER,
        threadId: ctx.session.threadId,
        payload: { exitKind: "graceful" },
      });
    });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...sessions.values()], close, { discard: true }),
  );

  const recordCost = (ctx: SessionContext, usage: unknown) =>
    Effect.gen(function* () {
      if (!ctx.accountValid || ctx.closed) return;
      const snapshot = axiomUsageAccounting(ctx.identity.accountKey, ctx.nativeId, usage);
      if (!snapshot || ctx.settledCosts.has(snapshot.scopeId)) return;
      const occurredAt = axiomUsageTimestamp(usage);
      yield* emit({
        type: "thread.usage-accounting.updated",
        ...(yield* stamp),
        ...(occurredAt ? { createdAt: occurredAt } : {}),
        provider: PROVIDER,
        threadId: ctx.session.threadId,
        payload: snapshot,
      });
      if (ctx.settledCosts.size < 4096) ctx.settledCosts.add(snapshot.scopeId);
    });

  const reconcileCosts = (ctx: SessionContext) =>
    Effect.gen(function* () {
      let cursor: string | undefined;
      const pageSchema = Schema.Struct({
        thread: Schema.Struct({ threadId: Identifier }),
        requestUsage: Schema.Array(Schema.Unknown).check(Schema.isMaxLength(500)),
        nextRequestUsageCursor: Schema.optional(Schema.NullOr(Identifier)),
      });
      for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
        if (ctx.closed || !ctx.accountValid || sessions.get(ctx.session.threadId) !== ctx) return;
        const page = yield* ctx.runtime
          .request("_axiom/thread/timeline", {
            threadId: ctx.nativeId,
            limit: 500,
            // Omit both cursors on the first page: the native handler only
            // reconciles pending accounting in that exact spelling.
            ...(cursor ? { afterRequestId: cursor, afterSequence: 0 } : {}),
          })
          .pipe(Effect.flatMap((value) => decodeAxiom(pageSchema, value)));
        if (page.thread.threadId !== ctx.nativeId || ctx.closed || !ctx.accountValid) return;
        for (const usage of page.requestUsage) {
          yield* recordCost(ctx, usage);
        }
        if (!page.nextRequestUsageCursor) return;
        if (page.nextRequestUsageCursor === cursor) return;
        cursor = page.nextRequestUsageCursor;
      }
    }).pipe(
      Effect.timeoutOption("15 seconds"),
      Effect.catchCause(() => Effect.logWarning("Axiom reported-cost recovery is unavailable.")),
      Effect.asVoid,
    );

  const refreshSecurity = (input: ProviderSecurityNativeRefreshInput) =>
    lock(
      input.threadId,
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (
          !ctx.accountValid ||
          input.instanceId !== instanceId ||
          input.runtimeId !== ctx.identity.runtimeId ||
          input.configurationKey !== ctx.session.commandCatalogConfigurationKey ||
          input.modelId !== ctx.session.model ||
          ctx.turn ||
          ctx.verificationBusy
        )
          return yield* invalid(
            "refreshSecurity",
            "The exact idle Axiom session and model are required.",
          );
        if (
          input.acceptOutdatedTee &&
          (ctx.session.securityReport?.attestation.state !== "outdated" ||
            ctx.session.securityReport.providerId !== "near")
        )
          return yield* invalid(
            "refreshSecurity",
            "Review the current outdated-TEE report before accepting it.",
          );
        ctx.verificationBusy = true;
        const expectedModel = ctx.session.model!;
        return yield* Effect.gen(function* () {
          yield* updateReport(ctx, { attestation: { state: "verifying" }, evidence: null });
          const result = yield* native(
            ctx,
            "security/verify",
            ctx.runtime
              .request("_axiom/security/verify", {
                threadId: ctx.nativeId,
                ...(input.acceptOutdatedTee
                  ? { acceptOutdatedTee: true, modelId: expectedModel }
                  : {}),
              })
              .pipe(Effect.flatMap((value) => decodeAxiom(AxiomVerification, value))),
          ).pipe(
            Effect.timeout(90_000),
            Effect.mapError(() =>
              invalid(
                "refreshSecurity",
                "Native Axiom verification did not complete within its bounded control request.",
              ),
            ),
          );
          const evidence = yield* Effect.try({
            try: () => validateAxiomEvidence(result, expectedModel),
            catch: () =>
              invalid(
                "refreshSecurity",
                "The public attestation report is incomplete or mismatched.",
              ),
          });
          if (
            ctx.closed ||
            sessions.get(input.threadId) !== ctx ||
            ctx.session.model !== expectedModel
          )
            return yield* invalid("refreshSecurity", "The verification context changed.");
          yield* updateReport(ctx, { attestation: { state: result.status.state }, evidence });
          return { report: ctx.session.securityReport ?? null };
        }).pipe(
          Effect.onError(() =>
            ctx.session.securityReport?.attestation.state === "outdated"
              ? Effect.void
              : updateReport(ctx, { attestation: { state: "failed" }, evidence: null }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              ctx.verificationBusy = false;
            }),
          ),
        );
      }),
    );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    login: () =>
      Effect.gen(function* () {
        if (loginPending || sessions.size > 0)
          return yield* invalid(
            "login",
            "Close this account's Cafe chats before changing its native sign-in.",
          );
        loginPending = true;
        const scope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred
            ? Effect.void
            : Scope.close(scope, Exit.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    loginPending = false;
                  }),
                ),
              ),
        );
        const control = yield* makeAxiomControl(
          settings,
          serverConfig.cwd,
          options.environment,
        ).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.timeout(15_000),
          Effect.mapError(() =>
            invalid("login", "Could not start the native Axiom account connection."),
          ),
        );
        const result = yield* control.client.raw
          .request("_axiom/account/native_login_start", {})
          .pipe(
            Effect.flatMap((value) =>
              decodeAxiom(
                Schema.Struct({
                  login: Schema.Struct({ loginId: Identifier, browserOpened: Schema.Boolean }),
                }),
                value,
              ),
            ),
            Effect.timeout(15_000),
            Effect.mapError(() => invalid("login", "Could not open native Axiom sign-in.")),
          );
        if (!result.login.browserOpened) {
          yield* control.client.raw
            .request("_axiom/account/native_login_cancel", { loginId: result.login.loginId })
            .pipe(Effect.ignore);
          return yield* invalid(
            "login",
            "Open Axiom's installed app to sign in, then refresh Cafe's provider.",
          );
        }
        // Only this explicit user action creates a native login. The private
        // connection outlives its short acknowledgement, is owned by the provider
        // instance, and closes on completion, timeout or instance retirement.
        yield* control.client.raw
          .request("_axiom/account/native_login_complete", { loginId: result.login.loginId })
          .pipe(
            Effect.timeout(10 * 60_000),
            Effect.andThen(options.onAccountChanged ?? Effect.void),
            Effect.catchCause(() => Effect.void),
            Effect.ensuring(
              Scope.close(scope, Exit.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    loginPending = false;
                  }),
                ),
              ),
            ),
            Effect.forkIn(instanceScope),
          );
        transferred = true;
      }).pipe(Effect.scoped),
    capabilities: {
      sessionModelSwitch: "in-session",
      liveSteer: "supported",
      manualCompaction: "supported",
      sessionFork: "unsupported",
      threadGoals: "unsupported",
    },
    manageMcp: (input) =>
      lock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (
            !ctx.accountValid ||
            input.instanceId !== instanceId ||
            input.runtimeId !== ctx.identity.runtimeId ||
            input.modelId !== ctx.session.model ||
            input.configurationKey !== ctx.session.commandCatalogConfigurationKey ||
            ctx.turn ||
            ctx.verificationBusy
          )
            return yield* invalid("manageMcp", "The exact idle Axiom session is required.");
          if (
            input.action.kind !== "list" &&
            [...sessions.values()].some(
              (other) =>
                other.identity.accountKey === ctx.identity.accountKey &&
                (other.turn || other.verificationBusy),
            )
          )
            return yield* invalid(
              "manageMcp",
              "Wait for this Axiom account’s active conversations before changing MCP settings.",
            );
          const account = yield* native(
            ctx,
            "account/status",
            ctx.runtime
              .request("_axiom/account/status", {})
              .pipe(Effect.flatMap((value) => decodeAxiom(AxiomAccount, value))),
          );
          if (
            account.status.state !== "valid" ||
            !account.status.account ||
            axiomAccountKey(account.status.account.id) !== ctx.identity.accountKey
          )
            return yield* invalid("manageMcp", "The native Axiom account changed.");
          const state = yield* native(
            ctx,
            "desktop/mcp",
            ctx.runtime
              .request("_axiom/desktop/mcp", {
                threadId: ctx.nativeId,
                ...(input.expectedRevision !== undefined
                  ? { expectedRevision: input.expectedRevision }
                  : {}),
                action: input.action,
              })
              .pipe(
                Effect.flatMap((value) => decodeAxiom(ProviderMcpState, value)),
                Effect.timeout("40 seconds"),
                Effect.catchTag("TimeoutError", () =>
                  Effect.fail(
                    AcpErrors.AcpRequestError.invalidParams(
                      "MCP did not complete. Refresh before retrying.",
                    ),
                  ),
                ),
              ),
          );
          if (!ctx.accountValid || ctx.closed) return { state: null };
          ctx.mcp = state;
          return { state };
        }),
      ).pipe(
        Effect.timeout("45 seconds"),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            invalid("manageMcp", "MCP control did not complete. Refresh before retrying."),
          ),
        ),
      ),
    readSecurity: (input) =>
      Effect.sync(() => {
        const ctx = sessions.get(input.threadId);
        return {
          report:
            ctx &&
            ctx.accountValid &&
            !ctx.closed &&
            input.instanceId === instanceId &&
            ctx.identity.runtimeId === input.runtimeId &&
            ctx.session.model === input.modelId &&
            ctx.session.commandCatalogConfigurationKey === input.configurationKey
              ? (ctx.session.securityReport ?? null)
              : null,
        };
      }),
    refreshSecurity,
    startSession: (input) =>
      lock(
        input.threadId,
        Effect.gen(function* () {
          if (
            !input.cwd ||
            (input.provider && input.provider !== PROVIDER) ||
            input.additionalDirectories?.length ||
            input.maxConcurrentSubagents != null
          )
            return yield* invalid(
              "startSession",
              "Axiom requires one workspace and its native supported configuration.",
            );
          const previous = sessions.get(input.threadId);
          if (previous && !previous.closed) {
            if (previous.turn || previous.verificationBusy)
              return yield* invalid(
                "startSession",
                "Wait for Axiom's active work before reconfiguring this session.",
              );
            yield* close(previous);
          }
          const resume =
            input.resumeCursor == null
              ? undefined
              : yield* decodeResume(input.resumeCursor).pipe(
                  Effect.mapError(() =>
                    invalid("startSession", "The Axiom resume identity is invalid."),
                  ),
                );
          const scope = yield* Scope.make("sequential");
          let transferred = false;
          let identity: AxiomSessionIdentity | undefined;
          yield* Effect.addFinalizer(() =>
            transferred ? Effect.void : Scope.close(scope, Exit.void),
          );
          const runtime = yield* factory(
            settings,
            {
              cwd: input.cwd,
              frontend: "desktop-chat",
              ...(resume ? { resumeSessionId: resume.sessionId } : {}),
              ...(resume ? { nativeResumeCwd: resume.nativeCwd } : {}),
            },
            (value) => {
              identity = value;
            },
            options.environment,
            resume?.accountKey,
          ).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
          // Callbacks are registered before initialize/new/load; no permission can
          // be accepted during native startup or history replay.
          let ctx: SessionContext | undefined;
          yield* runtime.handleRequestPermission((request) =>
            Effect.gen(function* () {
              if (
                !ctx ||
                ctx.closed ||
                !ctx.turn ||
                request.sessionId !== ctx.nativeId ||
                ctx.approvals.size >= 128
              )
                return { outcome: { outcome: "cancelled" as const } };
              const owner = ctx;
              const turn = owner.turn;
              const requestId = ApprovalRequestId.make(randomUUID());
              const deferred = yield* Deferred.make<ProviderApprovalDecision | null>();
              owner.approvals.set(requestId, { deferred, request });
              const permissionRequest = {
                kind: request.toolCall.kind ?? "other",
                ...(request.toolCall.title ? { detail: request.toolCall.title } : {}),
              };
              yield* emit(
                makeAcpRequestOpenedEvent({
                  stamp: yield* stamp,
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: turn,
                  requestId: RuntimeRequestId.make(requestId),
                  permissionRequest,
                  detail: request.toolCall.title ?? "Axiom requests approval",
                  args: {},
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: {},
                  suppressAlwaysAllowRule:
                    selectAxiomPermissionOption(request, "acceptForSession") === undefined,
                }),
              );
              return yield* Effect.gen(function* () {
                const decision = yield* Deferred.await(deferred);
                if (!decision || decision === "cancel" || owner.closed || owner.turn !== turn) {
                  yield* emit(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* stamp,
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: turn,
                      requestId: RuntimeRequestId.make(requestId),
                      permissionRequest,
                      decision: "cancel",
                    }),
                  );
                  return { outcome: { outcome: "cancelled" as const } };
                }
                const optionId = selectAxiomPermissionOption(request, decision);
                if (!optionId) return { outcome: { outcome: "cancelled" as const } };
                yield* emit(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* stamp,
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: turn,
                    requestId: RuntimeRequestId.make(requestId),
                    permissionRequest,
                    decision,
                  }),
                );
                return { outcome: { outcome: "selected" as const, optionId } };
              }).pipe(Effect.ensuring(Effect.sync(() => owner.approvals.delete(requestId))));
            }),
          );
          // Axiom's reviewed ACP schema spells this method elicitation/create.
          // effect-acp's extension dispatch admits typed non-core methods, so the
          // existing session/elicitation contract and other providers stay intact.
          yield* runtime.handleExtRequest(
            "elicitation/create",
            AcpSchema.ElicitationRequest,
            (request) =>
              Effect.gen(function* () {
                if (
                  !ctx ||
                  ctx.closed ||
                  !ctx.turn ||
                  request.sessionId !== ctx.nativeId ||
                  request.mode !== "form" ||
                  ctx.questions.size >= 32
                )
                  return { action: "cancel" };
                const owner = ctx;
                const requestId = ApprovalRequestId.make(randomUUID());
                const properties = Object.entries(request.requestedSchema.properties ?? {});
                if (properties.length === 0 || properties.length > 16) return { action: "cancel" };
                if (
                  properties.some(
                    ([id, property]) =>
                      id.length > 128 ||
                      (property.type !== "string" && property.type !== "array") ||
                      (property.title?.length ?? 0) > 8192 ||
                      axiomQuestionOptions(property).length > 32 ||
                      axiomQuestionOptions(property).some((value) => value.length > 512),
                  )
                )
                  return { action: "cancel" };
                const questionTurn = owner.turn;
                const questions = properties.map(([id, property]) => ({
                  id,
                  header: property.title ?? id,
                  question: property.title ?? request.message,
                  multiSelect: property.type === "array",
                  options: axiomQuestionOptions(property)
                    .filter((value): value is string => typeof value === "string")
                    .map((label) => ({ label, description: label })),
                }));
                const deferred = yield* Deferred.make<AxiomQuestionResult>();
                owner.questions.set(requestId, { deferred, request });
                yield* emit({
                  type: "user-input.requested",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: owner.turn,
                  requestId: RuntimeRequestId.make(requestId),
                  payload: { questions },
                });
                return yield* Deferred.await(deferred).pipe(
                  Effect.tap((response) =>
                    Effect.gen(function* () {
                      yield* emit({
                        type: "user-input.resolved",
                        ...(yield* stamp),
                        provider: PROVIDER,
                        threadId: input.threadId,
                        turnId: questionTurn,
                        requestId: RuntimeRequestId.make(requestId),
                        payload: { answers: response.action === "accept" ? response.content : {} },
                      });
                    }),
                  ),
                  Effect.ensuring(Effect.sync(() => owner.questions.delete(requestId))),
                );
              }),
          );
          yield* runtime.handleUnknownExtNotification((method, value) =>
            Effect.gen(function* () {
              if (method !== "_axiom/event" || !ctx || ctx.closed) return;
              const event = yield* decodeAxiom(Activity, value).pipe(
                Effect.catch(() => Effect.succeed(undefined)),
              );
              if (
                !event ||
                event.runtimeInstanceId !== ctx.identity.runtimeId ||
                event.sequence <= ctx.sequence
              )
                return;
              if (ctx.sequence !== 0 && event.sequence !== ctx.sequence + 1) {
                ctx.replyFailed = true;
                ctx.accountValid = false;
                ctx.session = { ...ctx.session, securityReport: undefined };
                yield* metadataChanged(ctx);
              }
              ctx.sequence = event.sequence;
              if (event.event.kind === "account_changed") {
                const account = yield* decodeAxiom(AxiomAccount, {
                  status: event.event.status,
                }).pipe(Effect.catch(() => Effect.succeed(undefined)));
                if (
                  !account ||
                  account.status.state !== "valid" ||
                  !account.status.account ||
                  axiomAccountKey(account.status.account.id) !== ctx.identity.accountKey
                ) {
                  yield* updateReport(ctx, {
                    attestation: { state: "unverified" },
                    evidence: null,
                    reply: { state: "none" },
                  });
                  ctx.accountValid = false;
                  ctx.session = { ...ctx.session, securityReport: undefined };
                  yield* metadataChanged(ctx);
                  yield* cancelInteractions(ctx);
                  if (ctx.turn) yield* settle(ctx, ctx.turn, "failed");
                  ctx.session = { ...ctx.session, status: "error" };
                }
                return;
              }
              if (event.sessionId !== ctx.nativeId) return;
              if (event.event.kind === "request_usage_changed" && ctx.accountValid) {
                yield* recordCost(ctx, event.event.usage);
              }
              if (event.event.kind === "active_turn_changed") {
                const active = yield* decodeAxiom(ActiveTurn, event.event).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                );
                if (
                  active &&
                  ctx.turn &&
                  active.turnId &&
                  (!ctx.nativeTurns.has(active.turnId) ||
                    ctx.nativeTurns.get(active.turnId) === ctx.turn)
                ) {
                  ctx.nativeTurn = active.turnId;
                  if (ctx.cancelRequested) yield* ctx.runtime.cancel.pipe(Effect.ignore);
                  ctx.nativeTurns.set(active.turnId, ctx.turn);
                  if (ctx.nativeTurns.size > 2000)
                    ctx.nativeTurns.delete(ctx.nativeTurns.keys().next().value!);
                  ctx.session = {
                    ...ctx.session,
                    resumeCursor: resumeCursor(ctx),
                  };
                }
              } else if (event.event.kind === "context_usage_changed" && ctx.turn) {
                const usage = yield* decodeAxiom(ContextUsage, event.event.usage).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                );
                if (
                  !usage ||
                  usage.modelId !== ctx.session.model ||
                  !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
                )
                  return;
                yield* emit({
                  type: "thread.token-usage.updated",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId: ctx.turn,
                  payload: {
                    usage: {
                      usedTokens: usage.inputTokens + usage.outputTokens,
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      ...(usage.contextWindowTokens
                        ? { maxTokens: usage.contextWindowTokens }
                        : {}),
                    },
                  },
                });
              } else if (event.event.kind === "request_usage_changed" && ctx.turn) {
                const usage = yield* decodeAxiom(Usage, event.event.usage).pipe(
                  Effect.catch(() => Effect.succeed(undefined)),
                );
                if (
                  usage?.purpose !== "conversation" ||
                  usage.modelId !== ctx.session.model ||
                  !ctx.nativeTurn ||
                  usage.turnId !== ctx.nativeTurn
                )
                  return;
                if (!ctx.replyRequests.has(usage.requestId) && ctx.replyRequests.size >= 4096) {
                  ctx.replyFailed = true;
                  return;
                }
                ctx.replyRequests.set(
                  usage.requestId,
                  usage.state === "completed" && usage.responseVerified === true,
                );
                if (usage.state === "completed" && usage.responseVerified === true)
                  ctx.replyChecked = true;
                if (
                  usage.state === "failed" ||
                  usage.state === "cancelled" ||
                  (usage.state === "completed" && usage.responseVerified !== true)
                )
                  ctx.replyFailed = true;
              } else if (event.event.kind === "security_changed") {
                const status = yield* decodeAxiom(AxiomVerification, {
                  status: event.event.status,
                  evidence: null,
                }).pipe(Effect.catch(() => Effect.succeed(undefined)));
                if (status) {
                  // Status-only notifications cannot mint public attestation proof.
                  // Reject provider error prose; refresh/prewarm supply checked DTOs.
                  yield* updateReport(ctx, {
                    attestation: { state: status.status.state },
                    ...(status.status.state === "failed" || status.status.state === "unverified"
                      ? { evidence: null }
                      : {}),
                  });
                }
              }
            }),
          );
          const started = yield* runtime.start().pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.timeout(60_000),
            Effect.mapError(() =>
              invalid(
                "startSession",
                "Axiom startup did not complete. Check installation and sign-in.",
              ),
            ),
          );
          if (!identity || identity.frontend !== "desktop-chat")
            return yield* invalid(
              "startSession",
              "Axiom did not establish native account ownership.",
            );
          const modelList = yield* runtime.request("_axiom/models/list", {}).pipe(
            Effect.flatMap((value) => decodeAxiom(AxiomModels, value)),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "models/list", error),
            ),
          );
          yield* applyAxiomSelection(runtime, input.modelSelection).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/config", error),
            ),
          );
          const desktopAgent = yield* configureAxiomDesktopSession(runtime, started.sessionId, {
            cwd: input.cwd,
            enabled: input.interactionMode !== "plan",
            permission: input.runtimeMode === "full-access" ? "full_access" : "approve_commands",
            ...(resume ? { expectedRevision: resume.agentRevision } : {}),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.timeout("15 seconds"),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                AcpErrors.AcpRequestError.invalidParams(
                  "Axiom Agent configuration did not complete.",
                ),
              ),
            ),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "desktop/agent/configure", error),
            ),
          );
          const mcp = yield* readMcpState(runtime, started.sessionId).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "desktop/mcp", error),
            ),
          );
          const configuration = yield* runtime.getConfigOptions;
          const modelOption = configuration.find((option) => option.category === "model");
          const modelId =
            modelOption?.type === "select" ? modelOption.currentValue : input.modelSelection?.model;
          if (!modelId || !modelList.models.some((model) => model.id === modelId))
            return yield* invalid("startSession", "Axiom did not select a supported model.");
          const timestamp = yield* now;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: instanceId,
            subagentRuntimeId: SubagentRuntimeId.make(identity.runtimeId),
            commandCatalogConfigurationKey:
              options.configurationKey ?? axiomConfigurationKey(settings),
            commandCatalog: { status: "loading", commands: [] },
            threadId: input.threadId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode ?? "default",
            cwd: input.cwd,
            model: modelId,
            modelSelection: {
              instanceId,
              model: modelId,
              ...(input.modelSelection?.options ? { options: input.modelSelection.options } : {}),
            },
            createdAt: timestamp,
            updatedAt: timestamp,
            resumeCursor: resumeCursor({
              identity,
              nativeId: started.sessionId,
              nativeCwd: desktopAgent.workingDirectory,
              agentRevision: desktopAgent.revision,
              nativeTurns: new Map(
                resume?.turns?.map(({ nativeId, cafeId }) => [nativeId, cafeId]),
              ),
            }),
            securityReport: {
              runtimeId: SubagentRuntimeId.make(identity.runtimeId),
              modelId,
              providerId: modelList.models.find((model) => model.id === modelId)!.providerId,
              observedAt: timestamp,
              attestation: { state: "unverified" },
              evidence: null,
              reply: { state: "none" },
            },
          };
          ctx = {
            session,
            runtime,
            scope,
            identity,
            nativeCwd: desktopAgent.workingDirectory,
            agentRevision: desktopAgent.revision,
            webEnabled: false,
            mcp,
            nativeId: started.sessionId,
            models: modelList.models,
            sequence: 0,
            nativeTurn: undefined,
            turn: undefined,
            closed: false,
            verificationBusy: false,
            replyChecked: false,
            replyFailed: false,
            replyRequests: new Map(),
            settledCosts: new Set(),
            approvals: new Map(),
            questions: new Map(),
            completion: undefined,
            cancelRequested: false,
            accountValid: true,
            localCommand: false,
            pendingItems: new Set(),
            admittedItems: new Set(),
            nativeTurns: new Map(resume?.turns?.map(({ nativeId, cafeId }) => [nativeId, cafeId])),
          };
          const owner = ctx;
          sessions.set(input.threadId, ctx);
          yield* Stream.runForEach(runtime.getEvents(), (event) =>
            Effect.gen(function* () {
              if (event._tag === "EventStreamBarrier") {
                yield* Deferred.succeed(event.acknowledge, undefined);
                return;
              }
              if (owner.closed || sessions.get(input.threadId) !== owner) return;
              if (event._tag === "AvailableCommandsChanged") {
                const commands = event.commands
                  .filter((command) => !OWNED_COMMANDS.has(command.name))
                  .slice(0, 512);
                const catalog = decodeCommandCatalog({
                  status: commands.length ? "available" : "empty",
                  commands,
                });
                owner.session = {
                  ...owner.session,
                  commandCatalog: Exit.isSuccess(catalog)
                    ? catalog.value
                    : { status: "unavailable", commands: [] },
                };
                yield* emit({
                  type: "session.configured",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  payload: { config: {}, commandCatalogChanged: true },
                });
                return;
              }

              if (!owner.turn) return;
              const base = {
                stamp: yield* stamp,
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: owner.turn,
              };
              switch (event._tag) {
                case "AssistantItemStarted":
                  if (owner.pendingItems.size < 128) owner.pendingItems.add(event.itemId);
                  break;
                case "AssistantItemCompleted":
                  if (!owner.admittedItems.has(event.itemId)) break;
                  yield* emit(
                    makeAcpAssistantItemEvent({
                      ...base,
                      itemId: event.itemId,
                      lifecycle: "item.completed",
                    }),
                  );
                  break;
                case "ContentDelta": {
                  const delivery = decodeMessageDelivery(event.rawPayload);
                  if (!Exit.isSuccess(delivery)) break;
                  const messageId = delivery.value.update.messageId;
                  if (
                    messageId
                      ? messageId !==
                        (event.streamKind === "reasoning_text" ? "reasoning:" : "assistant:") +
                          owner.nativeTurn
                      : !owner.localCommand
                  )
                    break;
                  if (event.itemId && owner.pendingItems.has(event.itemId)) {
                    owner.pendingItems.delete(event.itemId);
                    owner.admittedItems.add(event.itemId);
                    yield* emit(
                      makeAcpAssistantItemEvent({
                        ...base,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                  }
                  yield* emit(makeAcpContentDeltaEvent({ ...base, ...event }));
                  break;
                }
                case "ToolCallUpdated":
                  yield* emit(makeAcpToolCallEvent({ ...base, ...event }));
                  break;
                case "PlanUpdated":
                  yield* emit(
                    makeAcpPlanUpdatedEvent({
                      ...base,
                      ...event,
                      source: "acp.jsonrpc",
                      method: "session/update",
                    }),
                  );
                  break;
                default:
                  break;
              }
            }),
          ).pipe(Effect.forkIn(scope));
          yield* emit({
            type: "session.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: { resumed: resume !== undefined } },
          });
          yield* emit({
            type: "thread.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          yield* emit({
            type: "session.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready" },
          });
          transferred = true;
          yield* reconcileCosts(owner);
          // Prewarm carries only the selected model id. The native cache and
          // inference enforce freshness; a late answer cannot replace another
          // session/model's evidence. Failure here never replays a user prompt.
          yield* runtime.request("_axiom/security/prewarm", { modelId }).pipe(
            Effect.flatMap((value) => decodeAxiom(AxiomVerification, value)),
            Effect.flatMap((result) =>
              Effect.try({
                try: () => validateAxiomEvidence(result, modelId),
                catch: () =>
                  AcpErrors.AcpRequestError.invalidParams("Invalid public attestation evidence."),
              }).pipe(
                Effect.flatMap((evidence) =>
                  owner.session.model === modelId
                    ? updateReport(owner, { attestation: { state: result.status.state }, evidence })
                    : Effect.void,
                ),
              ),
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope),
          );
          if (runtime.awaitExit)
            yield* runtime.awaitExit.pipe(
              Effect.catchCause(() => Effect.succeed(-1)),
              Effect.flatMap(() =>
                lock(
                  input.threadId,
                  Effect.gen(function* () {
                    if (owner.closed || sessions.get(input.threadId) !== owner) return;
                    if (owner.turn) yield* settle(owner, owner.turn, "failed");
                    yield* cancelInteractions(owner);
                    owner.closed = true;
                    owner.session = { ...owner.session, status: "error", updatedAt: yield* now };
                    yield* Scope.close(scope, Exit.void);
                    if (sessions.get(input.threadId) === owner) sessions.delete(input.threadId);
                    yield* emit({
                      type: "session.exited",
                      ...(yield* stamp),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      payload: {
                        exitKind: "error",
                        recoverable: true,
                        reason: "The owned AxiomCLI process exited.",
                      },
                    });
                  }),
                ),
              ),
              Effect.forkIn(instanceScope),
            );
          return session;
        }).pipe(Effect.scoped),
      ),
    sendTurn: (input) =>
      lock(
        input.threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(input.threadId);
          if (
            !ctx.accountValid ||
            ctx.turn ||
            ctx.verificationBusy ||
            ctx.session.status === "error"
          )
            return yield* invalid(
              "sendTurn",
              "Axiom is busy or needs its native session re-established.",
            );
          if (input.modelSelection && input.modelSelection.instanceId !== instanceId)
            return yield* invalid(
              "sendTurn",
              "The selected Axiom account does not own this session.",
            );
          const command = /^\s*\/([^\s]+)/u.exec(input.input ?? "")?.[1];
          if (command && OWNED_COMMANDS.has(command))
            return yield* invalid(
              "sendTurn",
              "Use Cafe's provider, model or verification controls for this native command.",
            );
          yield* native(
            ctx,
            "session/config",
            applyAxiomSelection(ctx.runtime, input.modelSelection),
          );
          const modelId = input.modelSelection?.model ?? ctx.session.model!;
          const model = ctx.models.find((entry) => entry.id === modelId);
          if (!model || !["near", "tinfoil"].includes(model.providerId))
            return yield* invalid("sendTurn", "Select a model in Axiom's current catalog.");
          if (
            (input.attachments?.length ?? 0) > 8 ||
            (input.attachments ?? []).reduce((sum, attachment) => sum + attachment.sizeBytes, 0) >
              16 * 1024 * 1024 ||
            (input.attachments ?? []).some(
              (attachment) =>
                attachment.sizeBytes > (attachment.type === "image" ? 5 : 10) * 1024 * 1024,
            )
          )
            return yield* invalid(
              "sendTurn",
              "Axiom accepts up to eight attachments: 5 MiB per image, 10 MiB per file and 16 MiB in total.",
            );
          const attachments: Array<
            | { kind: "image"; name: string; image: { mimeType: string; data: string } }
            | { kind: "file"; name: string; file: { name: string; mimeType: string; data: string } }
          > = [];
          for (const attachment of input.attachments ?? []) {
            if (
              attachment.type === "image"
                ? !model.supportsImages
                : !model.fileMimeTypes.includes(attachment.mimeType)
            )
              return yield* invalid(
                "sendTurn",
                "The selected Axiom model does not accept this attachment type.",
              );
            const path = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!path)
              return yield* invalid("sendTurn", "The Cafe attachment identity is invalid.");
            const bytes =
              attachment.type === "file"
                ? (yield* Effect.tryPromise({
                    try: () =>
                      readStoredFileAttachment({
                        attachmentsDir: serverConfig.attachmentsDir,
                        attachment,
                        threadId: input.threadId,
                      }),
                    catch: () =>
                      invalid("sendTurn", "The exact chat-owned file attachment is unavailable."),
                  })).bytes
                : yield* fileSystem
                    .readFile(path)
                    .pipe(
                      Effect.mapError(() =>
                        invalid("sendTurn", "The Cafe attachment is unavailable."),
                      ),
                    );
            if (bytes.byteLength !== attachment.sizeBytes)
              return yield* invalid("sendTurn", "The attachment bytes changed before submission.");
            const content = {
              name: attachment.name,
              mimeType: attachment.mimeType,
              data: Buffer.from(bytes).toString("base64"),
            };
            attachments.push(
              attachment.type === "image"
                ? {
                    kind: "image",
                    name: attachment.name,
                    image: { mimeType: content.mimeType, data: content.data },
                  }
                : { kind: "file", name: attachment.name, file: content },
            );
          }
          if (!input.input?.trim() && attachments.length === 0)
            return yield* invalid("sendTurn", "A prompt or attachment is required.");
          const agent = yield* native(
            ctx,
            "desktop/agent/configure",
            configureAxiomDesktopSession(ctx.runtime, ctx.nativeId, {
              cwd: ctx.session.cwd!,
              enabled: (input.interactionMode ?? ctx.session.interactionMode) !== "plan",
              permission:
                ctx.session.runtimeMode === "full-access" ? "full_access" : "approve_commands",
              expectedRevision: ctx.agentRevision,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.timeout("15 seconds"),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  AcpErrors.AcpRequestError.invalidParams(
                    "Axiom Agent configuration did not complete.",
                  ),
                ),
              ),
            ),
          );
          ctx.agentRevision = agent.revision;
          ctx.nativeCwd = agent.workingDirectory;
          ctx.session = { ...ctx.session, resumeCursor: resumeCursor(ctx) };
          const mcp = yield* native(ctx, "desktop/mcp", readMcpState(ctx.runtime, ctx.nativeId));
          if (
            (input.interactionMode ?? ctx.session.interactionMode) !== "plan" &&
            (mcp.revision !== (input.axiomMcpRevision ?? ctx.mcp.revision) ||
              (input.axiomMcpRevision === undefined && mcp.selectedTools.length > 0))
          )
            return yield* invalid(
              "sendTurn",
              "Axiom MCP settings changed. Review the MCP control and resend this message.",
            );
          ctx.mcp = mcp;
          const webEnabled = input.axiomWebEnabled === true;
          ctx.webEnabled = webEnabled;
          const turn = TurnId.make(randomUUID());
          ctx.cancelRequested = false;
          ctx.completion = yield* Deferred.make<void>();
          ctx.pendingItems.clear();
          ctx.admittedItems.clear();
          ctx.localCommand = input.input?.trimStart().startsWith("/") ?? false;
          ctx.turn = turn;
          ctx.nativeTurn = undefined;
          ctx.replyChecked = false;
          ctx.replyFailed = false;
          ctx.replyRequests.clear();
          ctx.session = {
            ...ctx.session,
            model: modelId,
            modelSelection: {
              instanceId,
              model: modelId,
              ...(input.modelSelection?.options ? { options: input.modelSelection.options } : {}),
            },
            interactionMode: input.interactionMode ?? ctx.session.interactionMode,
            status: "running",
            activeTurnId: turn,
            updatedAt: yield* now,
          };
          yield* updateReport(ctx, {
            modelId,
            providerId: model.providerId,
            ...(ctx.session.securityReport?.modelId !== modelId
              ? { evidence: null, attestation: { state: "unverified" } }
              : {}),
            reply: { state: "verifying", turnId: turn, modelId },
          });
          yield* emit({
            type: "turn.started",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: turn,
            payload: { model: modelId },
          });
          const clientItemId = randomUUID();
          const run = Effect.gen(function* () {
            if (ctx.closed || ctx.turn !== turn || ctx.cancelRequested || !ctx.accountValid) {
              yield* lock(
                input.threadId,
                settle(ctx, turn, ctx.cancelRequested ? "cancelled" : "failed"),
              );
              return;
            }
            const result = yield* native(
              ctx,
              "session/prompt",
              ctx.runtime.prompt({
                prompt: input.input ? [{ type: "text", text: input.input }] : [],
                _meta: {
                  axiom: {
                    clientItemId,
                    attachments,
                    webEnabled,
                    agentRevision: ctx.agentRevision,
                    ...(ctx.session.interactionMode !== "plan"
                      ? { mcpRevision: ctx.mcp.revision }
                      : {}),
                  },
                },
              }),
            );
            yield* ctx.runtime.finishPromptEvents;
            yield* lock(
              input.threadId,
              settle(
                ctx,
                turn,
                result.stopReason === "cancelled" ? "cancelled" : "completed",
                result.stopReason,
              ),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : lock(input.threadId, settle(ctx, turn, "failed")),
            ),
            Effect.onInterrupt(() => Effect.void),
            Effect.ensuring(reconcileCosts(ctx)),
          );
          // Prompt response is completion, not admission. The exact session scope
          // outlives Cafe RPC/renderer connections and owns this generation fiber.
          yield* run.pipe(Effect.forkIn(ctx.scope));
          return { threadId: input.threadId, turnId: turn, resumeCursor: ctx.session.resumeCursor };
        }),
      ),
    steerTurn: (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        if (
          ctx.turn !== input.expectedTurnId ||
          !ctx.nativeTurn ||
          !input.input?.trim() ||
          new TextEncoder().encode(input.input).byteLength > 64 * 1024 ||
          input.attachments?.length
        )
          return yield* invalid(
            "steerTurn",
            "The exact active Axiom turn and text guidance are required.",
          );
        if (input.axiomMcpRevision !== undefined && input.axiomMcpRevision !== ctx.mcp.revision)
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "_axiom/turn/steer",
            detail: "Axiom MCP settings changed; deliver as a new turn.",
          });
        if ((input.axiomWebEnabled === true) !== ctx.webEnabled)
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "_axiom/turn/steer",
            detail: "Axiom web consent changed; deliver as a new turn.",
          });
        const turn = ctx.turn;
        const nativeTurn = ctx.nativeTurn;
        const clientItemId = createHash("sha256")
          .update(input.messageId ?? randomUUID())
          .digest("hex");
        const result = yield* native(
          ctx,
          "turn/steer",
          ctx.runtime
            .request("_axiom/turn/steer", {
              threadId: ctx.nativeId,
              expectedTurnId: nativeTurn,
              clientItemId,
              text: input.input,
              webEnabled: ctx.webEnabled,
              agentRevision: ctx.agentRevision,
            })
            .pipe(Effect.flatMap((value) => decodeAxiom(SteerResult, value))),
        );
        if (
          ctx.closed ||
          sessions.get(input.threadId) !== ctx ||
          result.turnId !== nativeTurn ||
          result.clientItemId !== clientItemId
        )
          return yield* invalid(
            "steerTurn",
            "Axiom's steering acknowledgment does not match the requested turn.",
          );
        return {
          threadId: input.threadId,
          turnId: turn,
          clientCorrelationId: clientItemId,
          resumeCursor: ctx.session.resumeCursor,
        };
      }),
    interruptTurn: (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!ctx.turn || (turnId && ctx.turn !== turnId)) return;
        ctx.cancelRequested = true;
        const completion = ctx.completion;
        yield* native(ctx, "session/cancel", ctx.runtime.cancel);
        yield* cancelInteractions(ctx);
        if (completion)
          yield* Deferred.await(completion).pipe(
            Effect.timeoutOrElse({ duration: 15_000, orElse: () => lock(threadId, close(ctx)) }),
          );
      }),
    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.approvals.get(requestId);
        if (
          !pending ||
          (decision !== "cancel" && !selectAxiomPermissionOption(pending.request, decision))
        )
          return yield* invalid(
            "respondToRequest",
            "That native approval choice is no longer offered.",
          );
        yield* Deferred.succeed(pending.deferred, decision);
      }),
    respondToUserInput: (threadId, requestId, answers) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.questions.get(requestId);
        if (!pending)
          return yield* invalid("respondToUserInput", "The Axiom question is no longer pending.");
        const content: Record<string, string | string[]> = Object.create(null);
        for (const [id, property] of Object.entries(
          pending.request.requestedSchema.properties ?? {},
        )) {
          const answer = Object.hasOwn(answers, id) ? answers[id] : undefined;
          const values =
            typeof answer === "string"
              ? [answer]
              : Array.isArray(answer)
                ? answer
                : answer &&
                    typeof answer === "object" &&
                    "answers" in answer &&
                    Array.isArray(answer.answers)
                  ? answer.answers
                  : [];
          if (
            !values.every(
              (value): value is string => typeof value === "string" && value.length <= 8192,
            )
          )
            return yield* invalid(
              "respondToUserInput",
              "Axiom questions require bounded text answers.",
            );
          const choices = axiomQuestionOptions(property);
          if (
            (choices.length && values.some((value) => !choices.includes(value))) ||
            (pending.request.requestedSchema.required?.includes(id) && values.length === 0) ||
            (property.type === "array" &&
              (values.length < (property.minItems ?? 0) ||
                values.length > (property.maxItems ?? 128)))
          )
            return yield* invalid(
              "respondToUserInput",
              "Select the native question’s offered choices and required answers.",
            );
          content[id] = property.type === "array" ? values : (values[0] ?? "");
        }
        yield* Deferred.succeed(pending.deferred, { action: "accept", content });
      }),
    compactThread: (threadId) =>
      lock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          if (ctx.turn || ctx.verificationBusy)
            return yield* invalid("compactThread", "Axiom compaction requires an idle session.");
          yield* native(
            ctx,
            "compaction/start",
            ctx.runtime.request("_axiom/compaction/start", { threadId: ctx.nativeId }).pipe(
              Effect.flatMap((value) =>
                decodeAxiom(
                  Schema.Struct({
                    messagesBefore: Schema.Number.check(
                      Schema.isInt(),
                      Schema.isGreaterThanOrEqualTo(0),
                      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
                    ),
                  }),
                  value,
                ),
              ),
            ),
          );
          yield* emit({
            type: "thread.state.changed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId,
            payload: { state: "compacted" },
          });
        }),
      ),
    stopSession: (threadId) =>
      lock(
        threadId,
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (ctx) yield* close(ctx);
        }),
      ),
    stopAll: () =>
      Effect.forEach([...sessions.values()], (ctx) => lock(ctx.session.threadId, close(ctx)), {
        discard: true,
      }),
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((ctx) => !ctx.closed)
          .map((ctx) => {
            const { securityReport: _report, ...session } = ctx.session;
            return session;
          }),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.closed),
    readThread: (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* reconcileCosts(ctx);
        const turns = new Map<TurnId, { id: TurnId; items: unknown[] }>();
        const head = yield* native(
          ctx,
          "thread/timeline",
          ctx.runtime
            .request("_axiom/thread/timeline", {
              threadId: ctx.nativeId,
              afterSequence: 0,
              limit: 1,
            })
            .pipe(Effect.flatMap((value) => decodeAxiom(NativeHistoryPage, value))),
        );
        if (head.thread.threadId !== ctx.nativeId)
          return yield* invalid("readThread", "The native history belongs to another session.");
        // Cafe already retains its transcript; this bounded provider snapshot
        // reads the recent native tail rather than returning an old prefix.
        let cursor: number | undefined = Math.max(0, head.thread.lastTimelineSequence - 4000);
        const revision = head.thread.revision;
        for (let pageIndex = 0; pageIndex < 8; pageIndex++) {
          const page: typeof NativeHistoryPage.Type = yield* native(
            ctx,
            "thread/timeline",
            ctx.runtime
              .request("_axiom/thread/timeline", {
                threadId: ctx.nativeId,
                limit: 500,
                ...(cursor !== undefined ? { afterSequence: cursor } : {}),
              })
              .pipe(Effect.flatMap((value) => decodeAxiom(NativeHistoryPage, value))),
          );
          if (
            ctx.closed ||
            sessions.get(threadId) !== ctx ||
            page.thread.threadId !== ctx.nativeId ||
            (revision !== undefined && page.thread.revision !== revision)
          )
            return yield* invalid("readThread", "The native history changed during this read.");
          for (const item of page.items) {
            const cafeId = item.turnId ? ctx.nativeTurns.get(item.turnId) : undefined;
            if (!cafeId || item.kind !== "assistant_message") continue;
            const entry = turns.get(cafeId) ?? { id: cafeId, items: [] };
            entry.items.push({ id: item.id, type: "agentMessage", text: item.content });
            turns.set(cafeId, entry);
          }
          if (page.nextCursor == null) break;
          if (cursor !== undefined && page.nextCursor <= cursor)
            return yield* invalid("readThread", "The native history cursor did not advance.");
          cursor = page.nextCursor;
        }
        return { threadId, turns: [...turns.values()] };
      }).pipe(
        Effect.timeout(30_000),
        Effect.mapError((error) =>
          error._tag === "TimeoutError"
            ? invalid(
                "readThread",
                "Native Axiom history did not respond within its bounded deadline.",
              )
            : error,
        ),
      ),
    rollbackThread: () =>
      Effect.fail(
        invalid("rollbackThread", "Axiom does not expose Cafe's transactional rewind contract."),
      ),
    streamEvents: Stream.fromPubSub(events),
  };
  return adapter;
});
