import {
  type ChatAttachment,
  CommandId,
  EventId,
  type MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  type OrchestrationThread,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@cafecode/contracts";
import {
  isTemporaryWorktreeBranch,
  LEGACY_WORKTREE_BRANCH_PREFIX,
  WORKTREE_BRANCH_PREFIX,
} from "@cafecode/shared/git";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@cafecode/shared/DrainableWorker";

import {
  resolveThreadWorkspaceCwd,
  resolveThreadWorkspaceDirectories,
} from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.turn-steer-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

function areStringArraysEqual(
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean {
  const normalizedLeft = left ?? [];
  const normalizedRight = right ?? [];
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((entry, index) => entry === normalizedRight[index])
  );
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";
const ORPHANED_TURN_START_RESTART_DETAIL =
  "Turn start was interrupted by application restart before a provider turn started. The prompt was not resent automatically to avoid duplicate provider work; resend the message to continue.";

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

type CodexNonSteerableTurnKind = "review" | "compact";

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCodexNonSteerableTurnKindFromData(
  value: unknown,
): CodexNonSteerableTurnKind | undefined {
  const data = readRecord(value);
  const codexErrorInfo = readRecord(data?.codexErrorInfo ?? data?.codex_error_info);
  const activeTurnNotSteerable = readRecord(
    codexErrorInfo?.activeTurnNotSteerable ?? codexErrorInfo?.active_turn_not_steerable,
  );
  const turnKind = activeTurnNotSteerable?.turnKind ?? activeTurnNotSteerable?.turn_kind;
  return turnKind === "review" || turnKind === "compact" ? turnKind : undefined;
}

function readNestedCodexNonSteerableTurnKind(
  value: unknown,
  seen = new WeakSet<object>(),
): CodexNonSteerableTurnKind | undefined {
  const structured = readCodexNonSteerableTurnKindFromData(value);
  if (structured !== undefined) {
    return structured;
  }

  const record = readRecord(value);
  if (record === undefined) {
    return undefined;
  }
  if (seen.has(record)) {
    return undefined;
  }
  seen.add(record);

  return (
    readNestedCodexNonSteerableTurnKind(record.data, seen) ??
    readNestedCodexNonSteerableTurnKind(record.cause, seen)
  );
}

function detectCodexNonSteerableTurnKind(
  cause: Cause.Cause<ProviderServiceError>,
): CodexNonSteerableTurnKind | undefined {
  const providerError = findProviderAdapterRequestError(cause);
  const structured = readNestedCodexNonSteerableTurnKind(providerError?.cause);
  if (structured !== undefined) {
    return structured;
  }

  const detail = `${providerError?.detail ?? ""}\n${Cause.pretty(cause)}`.toLowerCase();
  if (detail.includes("cannot steer a review turn")) {
    return "review";
  }
  if (detail.includes("cannot steer a compact turn")) {
    return "compact";
  }
  return undefined;
}

function isUnsupportedLiveSteerFailure(cause: Cause.Cause<ProviderServiceError>): boolean {
  const providerError = findProviderAdapterRequestError(cause);
  const detail = `${providerError?.detail ?? ""}\n${Cause.pretty(cause)}`.toLowerCase();
  return detail.includes("does not support live steering");
}

function isCodexNoActiveTurnToSteerFailure(cause: Cause.Cause<ProviderServiceError>): boolean {
  const providerError = findProviderAdapterRequestError(cause);
  const detail = `${providerError?.detail ?? ""}\n${Cause.pretty(cause)}`.toLowerCase();
  return detail.includes("turn/steer") && detail.includes("no active turn to steer");
}

function codexNonSteerableDetail(turnKind: CodexNonSteerableTurnKind): string {
  return `Codex reported a ${turnKind} active turn. Cafe Code preserved this follow-up for automatic delivery after the active turn is ready.`;
}

function retryableFollowUpDetail(): string {
  return "Cafe Code preserved this follow-up for automatic delivery after the active turn is ready.";
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = [WORKTREE_BRANCH_PREFIX, LEGACY_WORKTREE_BRANCH_PREFIX].reduce(
    (value, prefix) => (value.startsWith(`${prefix}/`) ? value.slice(`${prefix}/`.length) : value),
    normalized,
  );

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.steer.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly messageId?: MessageId;
    readonly retryableFollowUp?: boolean;
    readonly retryAfter?: "active-turn";
    readonly codexNonSteerableTurnKind?: CodexNonSteerableTurnKind;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.messageId ? { messageId: input.messageId } : {}),
          ...(input.retryableFollowUp !== undefined
            ? { retryableFollowUp: input.retryableFollowUp }
            : {}),
          ...(input.retryAfter ? { retryAfter: input.retryAfter } : {}),
          ...(input.codexNonSteerableTurnKind
            ? { codexNonSteerableTurnKind: input.codexNonSteerableTurnKind }
            : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendProviderDiagnosticActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly tone?: "info" | "tool" | "approval" | "error";
    readonly payload?: Record<string, unknown>;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-diagnostic-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: input.tone ?? "info",
        kind: input.kind,
        summary: input.summary,
        payload: {
          message: input.summary,
          detail: input.detail,
          ...input.payload,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const session = thread?.session;
    if (!session) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        status: session.status === "stopped" ? "stopped" : "ready",
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const recoverInterruptedTurnStartsOnStartup = Effect.fn("recoverInterruptedTurnStartsOnStartup")(
    function* () {
      const snapshot = yield* projectionSnapshotQuery.getSnapshot();
      const activeProviderSessions = yield* providerService.listSessions();
      const runningProviderThreadIds = new Set(
        activeProviderSessions
          .filter((session) => session.status === "running")
          .map((session) => String(session.threadId)),
      );
      const interruptedThreads = snapshot.threads.filter(
        (thread) =>
          thread.session?.status === "starting" &&
          thread.session.activeTurnId === null &&
          !runningProviderThreadIds.has(thread.id),
      );
      if (interruptedThreads.length === 0) {
        return;
      }
      const recoveredAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
      yield* Effect.forEach(
        interruptedThreads,
        (thread) =>
          Effect.gen(function* () {
            const session = thread.session;
            if (session === null) {
              return;
            }
            yield* setThreadSession({
              threadId: thread.id,
              session: {
                ...session,
                status: "ready",
                activeTurnId: null,
                lastError: ORPHANED_TURN_START_RESTART_DETAIL,
                updatedAt: recoveredAt,
              },
              createdAt: recoveredAt,
            });
            yield* appendProviderFailureActivity({
              threadId: thread.id,
              kind: "provider.turn.start.failed",
              summary: "Provider turn start interrupted",
              detail: ORPHANED_TURN_START_RESTART_DETAIL,
              turnId: null,
              createdAt: recoveredAt,
            });
          }),
        { concurrency: 1 },
      );
      yield* Effect.logWarning(
        "provider command reactor cleared interrupted turn starts after restart",
        { threadCount: interruptedThreads.length },
      );
    },
  );

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly thread?: OrchestrationThread;
      readonly project?: OrchestrationProjectShell;
      readonly activeSession?: ProviderSession | undefined;
      readonly activeSessionResolved?: boolean;
      readonly interactionMode?: "default" | "plan";
    },
  ) {
    const thread = options?.thread ?? (yield* resolveThread(threadId));
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession =
      options?.activeSessionResolved === true
        ? options.activeSession
        : yield* resolveActiveSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.session?.providerInstanceId !== undefined
          ? thread.session.providerInstanceId
          : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = options?.project ?? (yield* resolveProject(thread.projectId));
    const workspaceDirectories = resolveThreadWorkspaceDirectories({
      thread,
      projects: project ? [project] : [],
    });
    const effectiveCwd = workspaceDirectories.cwd;
    const effectiveAdditionalDirectories = workspaceDirectories.additionalDirectories;

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        providerInstanceId: desiredInstanceId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(effectiveAdditionalDirectories.length > 0
          ? { additionalDirectories: effectiveAdditionalDirectories }
          : {}),
        modelSelection: desiredModelSelection,
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        ...(options?.interactionMode !== undefined
          ? { interactionMode: options.interactionMode }
          : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              thread.session?.status === "starting" && thread.session.activeTurnId === null
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId && activeSession !== undefined) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const additionalDirectoriesChanged = !areStringArraysEqual(
        effectiveAdditionalDirectories,
        activeSession?.additionalDirectories,
      );
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !additionalDirectoriesChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return activeSession;
      }

      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        previousAdditionalDirectories: activeSession?.additionalDirectories ?? [],
        desiredAdditionalDirectories: effectiveAdditionalDirectories,
        additionalDirectoriesChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
        additionalDirectories: restartedSession.additionalDirectories,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
    readonly thread?: OrchestrationThread;
    readonly project?: OrchestrationProjectShell;
  }) {
    const thread = input.thread ?? (yield* resolveThread(input.threadId));
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const ensuredSession = yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      thread,
      ...(input.project !== undefined ? { project: input.project } : {}),
      activeSession,
      activeSessionResolved: true,
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const sessionModelSwitch =
      ensuredSession.providerInstanceId === undefined
        ? yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(ensuredSession.provider),
            method: "thread.turn.start",
            detail: `Active provider session '${ensuredSession.threadId}' is missing a provider instance id.`,
          })
        : (yield* providerService.getCapabilities(ensuredSession.providerInstanceId))
            .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? ensuredSession.model !== undefined
          ? {
              ...requestedModelSelection,
              model: ensuredSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const markThreadRunningFromSendTurnResult = Effect.fn("markThreadRunningFromSendTurnResult")(
    function* (input: { readonly threadId: ThreadId; readonly turnId: TurnId }) {
      const thread = yield* resolveThread(input.threadId);
      const providerSessions = yield* providerService
        .listSessions()
        .pipe(Effect.catchCause(() => Effect.succeed<ReadonlyArray<ProviderSession>>([])));
      const activeProviderSession = providerSessions.find(
        (session) => session.threadId === input.threadId,
      );
      const currentSession = thread?.session ?? null;

      if (
        currentSession?.status === "running" &&
        currentSession.activeTurnId !== null &&
        currentSession.activeTurnId !== input.turnId
      ) {
        yield* Effect.logWarning("provider command reactor skipped stale sendTurn running marker", {
          threadId: input.threadId,
          currentActiveTurnId: currentSession.activeTurnId,
          sendTurnActiveTurnId: input.turnId,
        });
        return;
      }

      const providerName = activeProviderSession?.provider ?? currentSession?.providerName;
      if (providerName === undefined) {
        yield* Effect.logWarning(
          "provider command reactor could not mark sendTurn result running",
          {
            threadId: input.threadId,
            turnId: input.turnId,
            reason: "missing-provider-session",
          },
        );
        return;
      }

      const providerInstanceId =
        activeProviderSession?.providerInstanceId ?? currentSession?.providerInstanceId;
      const runtimeMode =
        activeProviderSession?.runtimeMode ??
        currentSession?.runtimeMode ??
        thread?.runtimeMode ??
        DEFAULT_RUNTIME_MODE;
      const updatedAt = DateTime.formatIso(yield* DateTime.now);

      yield* setThreadSession({
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: "running",
          providerName,
          ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
          runtimeMode,
          activeTurnId: input.turnId,
          lastError: null,
          updatedAt,
        },
        createdAt: updatedAt,
      });
    },
  );

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const project = yield* resolveProject(thread.projectId);

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: project ? [project] : [],
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return setThreadSessionErrorOnTurnStartFailure({
        threadId: event.payload.threadId,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
      thread,
      ...(project !== undefined ? { project } : {}),
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    yield* providerService.sendTurn(sendTurnRequest.value).pipe(
      Effect.tap((turn) =>
        markThreadRunningFromSendTurnResult({
          threadId: event.payload.threadId,
          turnId: turn.turnId,
        }),
      ),
      Effect.catchCause(recoverTurnStartFailure),
      Effect.forkScoped,
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Cafe persists the provider runtime turn id on the thread session once the
    // provider accepts a turn. Keep passing it through the interrupt boundary:
    // upstream Codex requires `turn/interrupt` to name the exact active turn id
    // and rejects session-only interrupts.
    const activeTurnId = event.payload.turnId ?? thread.session?.activeTurnId ?? undefined;
    yield* providerService
      .interruptTurn({
        threadId: event.payload.threadId,
        ...(activeTurnId !== undefined ? { turnId: activeTurnId } : {}),
      })
      .pipe(
        Effect.flatMap(() =>
          Effect.gen(function* () {
            const interruptedAt = DateTime.formatIso(yield* DateTime.now);
            yield* appendProviderDiagnosticActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.interrupt.completed",
              summary: "Provider turn interrupt completed",
              detail:
                "Provider accepted the active turn interrupt; pending Codex steers may now be replayed safely as a new turn.",
              turnId: activeTurnId ?? null,
              createdAt: interruptedAt,
              payload: {
                requestedAt: event.payload.createdAt,
              },
            });
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const failedAt = DateTime.formatIso(yield* DateTime.now);
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.interrupt.failed",
              summary: "Provider turn interrupt failed",
              detail: formatFailureDetail(cause),
              turnId: activeTurnId ?? null,
              createdAt: failedAt,
            });
          }),
        ),
      );
  });

  const processTurnSteerRequested = Effect.fn("processTurnSteerRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-steer-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: `User message '${event.payload.messageId}' was not found for steer request.`,
        turnId: thread.session?.activeTurnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }
    if (thread.session?.status !== "running") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: "No active running provider turn is bound to this thread.",
        turnId: thread.session?.activeTurnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }
    const activeSession = thread.session;
    if (!activeSession.activeTurnId) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: "The active provider session is missing an active turn id.",
        turnId: null,
        createdAt: event.payload.createdAt,
      });
    }
    const providerInstanceId = activeSession.providerInstanceId;
    if (providerInstanceId === undefined) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: "The active provider session is missing a provider instance id.",
        turnId: activeSession.activeTurnId,
        createdAt: event.payload.createdAt,
      });
    }
    const capabilities = yield* providerService.getCapabilities(providerInstanceId);
    if (capabilities.liveSteer !== "supported") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: retryableFollowUpDetail(),
        turnId: activeSession.activeTurnId,
        createdAt: event.payload.createdAt,
        messageId: event.payload.messageId,
        retryableFollowUp: true,
        retryAfter: "active-turn",
      });
    }

    const normalizedInput = toNonEmptyProviderInput(message.text);
    const normalizedAttachments = message.attachments ?? [];
    if (!normalizedInput && normalizedAttachments.length === 0) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.steer.failed",
        summary: "Provider steer failed",
        detail: "Either input text or at least one attachment is required.",
        turnId: activeSession.activeTurnId,
        createdAt: event.payload.createdAt,
      });
    }

    const recoverStaleCodexSteerAsTurnStart = (cause: Cause.Cause<ProviderServiceError>) =>
      Effect.gen(function* () {
        const observedAt = DateTime.formatIso(yield* DateTime.now);
        const staleTurnId = activeSession.activeTurnId;

        // Upstream Codex TUI handles this exact app-server race in
        // `active_turn_steer_race`: if `turn/steer` says there is no active
        // turn, it clears the cached active turn and immediately falls through
        // to `turn/start` with the same user input. Cafe must do the same at the
        // server boundary so the renderer never has to surface a recoverable
        // provider race as a failed send.
        yield* appendProviderDiagnosticActivity({
          threadId: event.payload.threadId,
          kind: "runtime.warning",
          summary: "Steer retried as next turn",
          detail:
            "Codex reported that the cached active turn had already ended. Cafe Code cleared the stale active-turn pointer and submitted this message as the next turn, matching upstream Codex CLI/TUI active-turn race handling.",
          turnId: staleTurnId,
          createdAt: observedAt,
          payload: {
            provider: "codex",
            method: "turn/steer",
            recovery: "turn-start-after-no-active-turn",
            messageId: event.payload.messageId,
            staleTurnId,
          },
        });

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...activeSession,
            status: "ready",
            activeTurnId: null,
            lastError: null,
            updatedAt: observedAt,
          },
          createdAt: observedAt,
        });

        yield* orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: serverCommandId("codex-stale-steer-retry-turn-start"),
          threadId: event.payload.threadId,
          message: {
            messageId: event.payload.messageId,
            role: "user",
            text: message.text,
            attachments: normalizedAttachments,
          },
          ...(thread.modelSelection !== undefined ? { modelSelection: thread.modelSelection } : {}),
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: observedAt,
        });
      }).pipe(
        Effect.catchCause((recoveryCause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail: `Automatic stale Codex steer recovery failed after ${formatFailureDetail(cause)}: ${Cause.pretty(recoveryCause)}`,
            turnId: activeSession.activeTurnId,
            createdAt: event.payload.createdAt,
            messageId: event.payload.messageId,
          }),
        ),
      );

    // Codex app-server's `turn/steer` is intentionally not a second
    // `turn/start`: upstream requires the expected active turn id, rejects
    // mismatches, does not accept turn-level overrides, and does not emit a new
    // `turn/started` notification. Keep this operation separate so a follow-up
    // typed during an active turn cannot violate Codex's one-active-turn
    // invariant by starting another turn.
    yield* providerService
      .steerTurn({
        threadId: event.payload.threadId,
        expectedTurnId: activeSession.activeTurnId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      })
      .pipe(
        Effect.catchCause((cause) => {
          if (isCodexNoActiveTurnToSteerFailure(cause)) {
            return recoverStaleCodexSteerAsTurnStart(cause);
          }
          const codexNonSteerableTurnKind = detectCodexNonSteerableTurnKind(cause);
          const unsupportedLiveSteer = isUnsupportedLiveSteerFailure(cause);
          const retryableFollowUp = codexNonSteerableTurnKind !== undefined || unsupportedLiveSteer;
          return appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.steer.failed",
            summary: "Provider steer failed",
            detail:
              codexNonSteerableTurnKind !== undefined
                ? codexNonSteerableDetail(codexNonSteerableTurnKind)
                : unsupportedLiveSteer
                  ? retryableFollowUpDetail()
                  : formatFailureDetail(cause),
            turnId: thread.session?.activeTurnId ?? null,
            createdAt: event.payload.createdAt,
            messageId: event.payload.messageId,
            ...(retryableFollowUp
              ? {
                  retryableFollowUp: true,
                  retryAfter: "active-turn" as const,
                  ...(codexNonSteerableTurnKind !== undefined ? { codexNonSteerableTurnKind } : {}),
                }
              : {}),
          });
        }),
        Effect.forkScoped,
      );
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const project = yield* resolveProject(thread.projectId);
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
          ...(cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {}),
          thread,
          ...(project !== undefined ? { project } : {}),
        });
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.turn-steer-requested":
        yield* processTurnSteerRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    yield* recoverInterruptedTurnStartsOnStartup().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "provider command reactor failed to clear interrupted turn starts after restart",
          { cause: Cause.pretty(cause) },
        ),
      ),
    );

    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.turn-steer-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
