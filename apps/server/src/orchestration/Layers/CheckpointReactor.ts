import {
  type CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  type ProjectId,
  type ProviderDriverKind,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeDrainableWorker } from "@cafecode/shared/DrainableWorker";

import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  isThreadOwnedHiddenCheckpointRef,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  isProviderRewindOutcomeUnknown,
  ProviderAdapterRewindOutcomeUnknownError,
} from "../../provider/Errors.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { makeConversationRewindStore } from "../../persistence/Layers/ConversationRewinds.ts";
import {
  CheckpointInvariantError,
  CheckpointUnavailableError,
  type CheckpointStoreError,
} from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { WorkspaceEntries } from "../../workspace/Services/WorkspaceEntries.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const CHECKPOINT_REFS_RETAINED_PER_THREAD = 3;
const CHECKPOINT_REF_PRUNE_WARNING_SAMPLE_SIZE = 20;
const PROVIDER_TURN_INGESTION_QUIESCENCE_TIMEOUT = "30 seconds";
const CHECKPOINT_REVERT_RECOVERY_TURN = Number.MAX_SAFE_INTEGER;
const CHECKPOINT_REVERT_RECOVERY_REQUIRED_MESSAGE =
  "A previous checkpoint recovery snapshot is still present. Stop this thread and inspect its provider history and saved workspace before retrying; the existing recovery snapshot was not changed.";

export function computeCheckpointRefPrunePlan(input: {
  readonly threadId: ThreadId;
  readonly currentTurnCount: number;
  readonly checkpoints: ReadonlyArray<{
    readonly checkpointTurnCount: number;
    readonly checkpointRef: CheckpointRef;
  }>;
  readonly baseline?: {
    readonly checkpointTurnCount: number;
    readonly checkpointRef: CheckpointRef;
  };
}): {
  readonly retainedTurnCounts: ReadonlyArray<number>;
  readonly checkpointRefsToDelete: ReadonlyArray<CheckpointRef>;
  readonly skippedNonHiddenCheckpointRefs: number;
} {
  const skippedNonHiddenCheckpointRefs = input.checkpoints.filter(
    (checkpoint) => !isThreadOwnedHiddenCheckpointRef(input.threadId, checkpoint.checkpointRef),
  ).length;
  const checkpointCandidates = [
    ...input.checkpoints.filter((checkpoint) =>
      isThreadOwnedHiddenCheckpointRef(input.threadId, checkpoint.checkpointRef),
    ),
    input.baseline ?? {
      checkpointTurnCount: 0,
      checkpointRef: checkpointRefForThreadTurn(input.threadId, 0),
    },
  ];
  const retainedTurnCounts = [
    ...new Set(
      [
        ...checkpointCandidates.map((checkpoint) => checkpoint.checkpointTurnCount),
        input.currentTurnCount,
      ]
        .toSorted((left, right) => right - left)
        .slice(0, CHECKPOINT_REFS_RETAINED_PER_THREAD),
    ),
  ];
  const retainedTurnCountSet = new Set(retainedTurnCounts);
  const checkpointRefsToDelete = [
    ...new Set(
      checkpointCandidates
        .filter((checkpoint) => !retainedTurnCountSet.has(checkpoint.checkpointTurnCount))
        .map((checkpoint) => checkpoint.checkpointRef),
    ),
  ];

  return {
    retainedTurnCounts,
    checkpointRefsToDelete,
    skippedNonHiddenCheckpointRefs,
  };
}

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const providerRuntimeIngestion = yield* ProviderRuntimeIngestionService;
  const sql = yield* SqlClient.SqlClient;
  const conversationRewinds = makeConversationRewindStore(sql);
  const checkpointStore = yield* CheckpointStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const resolveWorkspaceFence = (threadId: ThreadId, checkpointTurnId?: TurnId) =>
    projectionSnapshotQuery
      .getThreadCheckpointContext(threadId, checkpointTurnId)
      .pipe(Effect.map((context) => Option.getOrUndefined(context)?.workspaceFence));
  const cleanupScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-revert-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.revert.failed",
        summary: "Checkpoint revert failed",
        payload: {
          turnCount: input.turnCount,
          detail: input.detail,
        },
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-capture-failure"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: "checkpoint.capture.failed",
        summary: "Checkpoint capture failed",
        payload: {
          detail: input.detail,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<
    Option.Option<{
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly provider: ProviderDriverKind;
    }>
  > {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd, provider: session.provider })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId | null,
  ) {
    if (projectId === null) return [];
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  const isGitWorkspace = (cwd: string) => isGitRepository(cwd);

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId | null; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined> {
    // Provider cwd is an execution detail, not project authority. In
    // particular a moved chat may still have a dormant former-project binding.
    if (input.thread.projectId === null) return undefined;
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!isGitWorkspace(cwd)) {
      return undefined;
    }
    return cwd;
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const pruneOldCheckpointRefs = Effect.fn("CheckpointReactor.pruneOldCheckpointRefs")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly currentTurnCount: number;
      readonly checkpoints: ReadonlyArray<{
        readonly checkpointTurnCount: number;
        readonly checkpointRef: CheckpointRef;
      }>;
      readonly baseline?: {
        readonly checkpointTurnCount: number;
        readonly checkpointRef: CheckpointRef;
      };
    }) {
      const prunePlan = computeCheckpointRefPrunePlan(input);
      const { checkpointRefsToDelete, retainedTurnCounts, skippedNonHiddenCheckpointRefs } =
        prunePlan;

      if (checkpointRefsToDelete.length === 0) {
        if (skippedNonHiddenCheckpointRefs > 0) {
          yield* Effect.logDebug("skipped non-hidden checkpoint refs during prune", {
            threadId: input.threadId,
            cwd: input.cwd,
            skippedNonHiddenCheckpointRefs,
          });
        }
        return;
      }

      yield* checkpointStore
        .deleteCheckpointRefs({
          cwd: input.cwd,
          checkpointRefs: checkpointRefsToDelete,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to prune old checkpoint refs", {
              threadId: input.threadId,
              cwd: input.cwd,
              retainedTurnCounts,
              checkpointRefDeleteCount: checkpointRefsToDelete.length,
              skippedNonHiddenCheckpointRefs,
              checkpointRefsToDeleteSample: checkpointRefsToDelete.slice(
                0,
                CHECKPOINT_REF_PRUNE_WARNING_SAMPLE_SIZE,
              ),
              checkpointRefsToDeleteOmitted: Math.max(
                0,
                checkpointRefsToDelete.length - CHECKPOINT_REF_PRUNE_WARNING_SAMPLE_SIZE,
              ),
              detail: error.message,
            }),
          ),
        );
    },
  );

  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly projectId: ProjectId | null;
      readonly worktreePath: string | null;
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
      readonly checkpoints: ReadonlyArray<{
        readonly checkpointTurnCount: number;
        readonly checkpointRef: CheckpointRef;
      }>;
    };
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(
      input.threadId,
      input.turnId,
    );
    if (Option.isNone(context)) return;
    // The cwd was resolved before entering this function. Bind its canonical
    // association metadata to this read as well; a move between resolution
    // and admission must not relabel old-cwd capture with a new ref epoch.
    if (
      context.value.projectId !== input.thread.projectId ||
      context.value.worktreePath !== input.thread.worktreePath
    )
      return;
    const workspaceFence = context.value.workspaceFence;
    // Delayed placeholder/backfill events retain transcript history but may
    // never capture today's destination files as yesterday's checkpoint.
    if (
      workspaceFence &&
      (input.turnCount <= workspaceFence.invalidThroughTurnCount ||
        workspaceFence.retiredTurn === true ||
        workspaceFence.eligibleTurn === false)
    )
      return;
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(
      input.threadId,
      fromTurnCount,
      workspaceFence?.associationSequence,
    );
    const targetCheckpointRef = checkpointRefForThreadTurn(
      input.threadId,
      input.turnCount,
      workspaceFence?.associationSequence,
    );

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Invalidate the workspace entry cache so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.invalidate(input.cwd);

    const files = yield* checkpointStore
      .diffCheckpoints({
        cwd: input.cwd,
        fromCheckpointRef,
        toCheckpointRef: targetCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace: false,
      })
      .pipe(
        Effect.map((diff) =>
          parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
            path: file.path,
            kind: "modified" as const,
            additions: file.additions,
            deletions: file.deletions,
          })),
        ),
        Effect.tapError((error) =>
          appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
            createdAt: input.createdAt,
          }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("failed to derive checkpoint file summary", {
            threadId: input.threadId,
            turnId: input.turnId,
            turnCount: input.turnCount,
            detail: error.message,
          }).pipe(Effect.as([])),
        ),
      );

    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    // Git I/O is outside SQLite. A project move can commit while capture or
    // diff runs; retain the old ref in its original cwd but never publish it
    // as a destination checkpoint. Epoch equality, not clocks, fences replay.
    const latestContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(
      input.threadId,
      input.turnId,
    );
    if (
      Option.isNone(latestContext) ||
      latestContext.value.projectId !== context.value.projectId ||
      latestContext.value.workspaceRoot !== context.value.workspaceRoot ||
      latestContext.value.worktreePath !== context.value.worktreePath ||
      latestContext.value.workspaceFence?.associationSequence !==
        workspaceFence?.associationSequence ||
      latestContext.value.workspaceFence?.retiredTurn === true ||
      latestContext.value.workspaceFence?.eligibleTurn === false
    )
      return;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

    // Pruning old refs is cleanup, not provider-turn completion truth. Keep it
    // out of the synchronous completion path: traces from long-running Cafe
    // sessions showed ref deletion taking multiple seconds, which delayed
    // projection/receipt processing even though the current checkpoint had
    // already been captured and published.
    yield* pruneOldCheckpointRefs({
      threadId: input.threadId,
      cwd: input.cwd,
      currentTurnCount: input.turnCount,
      checkpoints: workspaceFence
        ? input.thread.checkpoints.filter(
            (checkpoint) =>
              checkpoint.checkpointTurnCount > workspaceFence.invalidThroughTurnCount &&
              checkpoint.checkpointRef ===
                checkpointRefForThreadTurn(
                  input.threadId,
                  checkpoint.checkpointTurnCount,
                  workspaceFence.associationSequence,
                ),
          )
        : input.thread.checkpoints,
      ...(workspaceFence
        ? {
            baseline: {
              checkpointTurnCount: workspaceFence.invalidThroughTurnCount,
              checkpointRef: checkpointRefForThreadTurn(
                input.threadId,
                workspaceFence.invalidThroughTurnCount,
                workspaceFence.associationSequence,
              ),
            },
          }
        : {}),
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(cleanupScope), Effect.asVoid);
  });

  // Captures a real git checkpoint when a turn completes via a runtime event.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );
      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        thread,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status: checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: undefined,
        createdAt: event.createdAt,
      });
    },
  );

  // Captures a real git checkpoint when a placeholder checkpoint (status "missing")
  // is detected via a domain event. This replaces the placeholder with a real
  // git-ref-based checkpoint.
  //
  // ProviderRuntimeIngestion creates placeholder checkpoints on turn.diff.updated
  // events from the Codex runtime. This handler fires when the corresponding
  // domain event arrives, allowing the reactor to capture the actual filesystem
  // state into a git ref and dispatch a replacement checkpoint.
  const captureCheckpointFromPlaceholder = Effect.fn("captureCheckpointFromPlaceholder")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    const { threadId, turnId, checkpointTurnCount, status } = event.payload;

    // Only replace placeholders; skip events from our own real captures.
    if (status !== "missing") {
      return;
    }

    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      yield* Effect.logWarning("checkpoint capture from placeholder skipped: thread not found", {
        threadId,
      });
      return;
    }

    // Ingestion can enqueue a placeholder before a rewind fence is installed,
    // while this reactor is still performing that rewind. The durable current
    // projection must continue to authorize the exact placeholder after the
    // queued event reaches us; otherwise it would resurrect removed history.
    if (
      !thread.checkpoints.some(
        (checkpoint) =>
          checkpoint.turnId === turnId &&
          checkpoint.checkpointTurnCount === checkpointTurnCount &&
          checkpoint.status === "missing",
      )
    ) {
      return;
    }

    const latestTurnForPlaceholder =
      thread.latestTurn?.turnId === turnId ? thread.latestTurn : null;
    if (thread.session?.activeTurnId === turnId || latestTurnForPlaceholder?.state === "running") {
      return;
    }

    // If a real checkpoint already exists for this turn, skip.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      yield* Effect.logDebug(
        "checkpoint capture from placeholder skipped: real checkpoint already exists",
        { threadId, turnId },
      );
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId,
      turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: checkpointTurnCount,
      status: "ready",
      assistantMessageId: event.payload.assistantMessageId ?? undefined,
      createdAt: event.payload.completedAt,
    });
  });

  const captureCheckpointFromSettledLatestTurnPlaceholder = Effect.fn(
    "captureCheckpointFromSettledLatestTurnPlaceholder",
  )(function* (event: Extract<OrchestrationEvent, { type: "thread.session-set" }>) {
    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread?.latestTurn) {
      return;
    }
    const latestTurn = thread.latestTurn;
    if (latestTurn.state === "running" || latestTurn.completedAt === null) {
      return;
    }

    const existingPlaceholder = thread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === latestTurn.turnId && checkpoint.status === "missing",
    );
    if (!existingPlaceholder) {
      return;
    }

    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === latestTurn.turnId && checkpoint.status !== "missing",
      )
    ) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId: thread.id,
      thread,
      projects,
      preferSessionRuntime: true,
    });
    if (!checkpointCwd) {
      return;
    }

    yield* captureAndDispatchCheckpoint({
      threadId: thread.id,
      turnId: latestTurn.turnId,
      thread,
      cwd: checkpointCwd,
      turnCount: existingPlaceholder.checkpointTurnCount,
      status:
        latestTurn.state === "error"
          ? "error"
          : latestTurn.state === "interrupted"
            ? "missing"
            : "ready",
      assistantMessageId:
        latestTurn.assistantMessageId ?? existingPlaceholder.assistantMessageId ?? undefined,
      createdAt: latestTurn.completedAt,
    });
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const projects = yield* resolveThreadProjects(thread.projectId);
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });
      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const workspaceFence = yield* resolveWorkspaceFence(thread.id);
      const baselineCheckpointRef = checkpointRefForThreadTurn(
        thread.id,
        currentTurnCount,
        workspaceFence?.associationSequence,
      );
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  const refreshGitStatusFromProviderInvalidation = Effect.fn(
    "refreshGitStatusFromProviderInvalidation",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "vcs.state.changed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    // Claude's vcs_state_changed payload contains a cwd, but upstream defines
    // the event as a cache-invalidation hint rather than authoritative state.
    // Resolve the filesystem target exclusively from Cafe's established
    // session binding. This prevents a compromised or malformed provider frame
    // from making the server inspect an arbitrary repository.
    const refresh =
      event.payload.kind === "push"
        ? vcsStatusBroadcaster.refreshStatus(sessionRuntime.value.cwd)
        : vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd);
    yield* refresh.pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh git status after provider VCS invalidation", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          kind: event.payload.kind,
          detail: error.message,
        }),
      ),
    );
  });

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const workspaceFence = yield* resolveWorkspaceFence(threadId);
    const baselineCheckpointRef = checkpointRefForThreadTurn(
      threadId,
      currentTurnCount,
      workspaceFence?.associationSequence,
    );
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const workspaceFence = yield* resolveWorkspaceFence(thread.id);
    if (
      thread.projectId === null ||
      (workspaceFence && event.payload.turnCount < workspaceFence.invalidThroughTurnCount)
    ) {
      yield* appendRevertFailureActivity({
        threadId: thread.id,
        turnCount: event.payload.turnCount,
        detail:
          "This checkpoint belongs to an earlier project association or a standalone chat and cannot be restored into the current workspace.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.payload.threadId);
    if (Option.isNone(sessionRuntime)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "No active provider session with workspace cwd is bound to this thread.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (!isGitWorkspace(sessionRuntime.value.cwd)) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Checkpoints are unavailable because this project is not a git repository.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const targetCheckpointRef =
      workspaceFence && event.payload.turnCount === workspaceFence.invalidThroughTurnCount
        ? checkpointRefForThreadTurn(
            thread.id,
            workspaceFence.invalidThroughTurnCount,
            workspaceFence.associationSequence,
          )
        : event.payload.turnCount === 0
          ? checkpointRefForThreadTurn(event.payload.threadId, 0)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
            )?.checkpointRef;

    if (!targetCheckpointRef) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }
    if (
      workspaceFence &&
      targetCheckpointRef !==
        checkpointRefForThreadTurn(
          thread.id,
          event.payload.turnCount,
          workspaceFence.associationSequence,
        )
    ) {
      yield* appendRevertFailureActivity({
        threadId: thread.id,
        turnCount: event.payload.turnCount,
        createdAt: now,
        detail: "This checkpoint is not bound to the current project association.",
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    // Capture the exact pre-revert workspace/index state before touching the
    // filesystem. Provider rewind is a second independent transaction; if it
    // definitely fails, restoring this private recovery ref prevents Cafe's
    // workspace from moving behind a provider conversation that stayed ahead.
    // An uncertain mutation must preserve both the target files and recovery
    // ref instead: the provider may already have discarded the later history.
    const recoveryCheckpointRef = checkpointRefForThreadTurn(
      event.payload.threadId,
      CHECKPOINT_REVERT_RECOVERY_TURN,
      workspaceFence?.associationSequence,
    );
    // This exact ref can survive an inconclusive native mutation or a process
    // crash. It may contain edits absent from every ordinary turn checkpoint.
    // Never overwrite that evidence on retry, or infer that either side of the
    // two independent transactions committed. Explicit inspection/recovery is
    // required before another rewind can safely claim this reserved ref.
    if (
      yield* checkpointStore.hasCheckpointRef({
        cwd: sessionRuntime.value.cwd,
        checkpointRef: recoveryCheckpointRef,
      })
    ) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: CHECKPOINT_REVERT_RECOVERY_REQUIRED_MESSAGE,
        createdAt: now,
      });
      return;
    }
    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    const cwd = sessionRuntime.value.cwd;
    const prepareRollback = providerService.prepareConversationRollback;
    const commitRollback = providerService.commitConversationRollback;
    const finishRollback = providerService.finishConversationRollback;
    const usesPreparedRollback = sessionRuntime.value.provider === "claudeAgent";
    const operation = { threadId: sessionRuntime.value.threadId, operationId: crypto.randomUUID() };

    if (usesPreparedRollback) {
      // A count alone cannot identify the native prefix. Bind the first removed
      // turn to the exact checkpoint ordinal, never array order or the latest
      // turn. Missing/ambiguous legacy metadata is not authority to truncate.
      const firstRemovedCheckpoints = thread.checkpoints.filter(
        (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount + 1,
      );
      const firstRemoved = firstRemovedCheckpoints[0];
      if (rolledBackTurns === 0 || firstRemovedCheckpoints.length !== 1 || !firstRemoved) {
        return yield* Effect.fail(
          new CheckpointInvariantError({
            operation: "prepare conversation rewind",
            detail:
              rolledBackTurns === 0
                ? "There is no conversation history to remove. The current checkpoint cannot be safely restored through conversation rewind."
                : "The first removed turn has no unambiguous checkpoint identity. No files or provider history were changed.",
          }),
        );
      }
      if (!prepareRollback || !commitRollback || !finishRollback) {
        return yield* Effect.fail(
          new CheckpointInvariantError({
            operation: "prepare conversation rewind",
            detail:
              "This provider runtime does not support safe prepared conversation rewind. No files or provider history were changed.",
          }),
        );
      }
      // The service durably reserves this exact control sequence and retires
      // the proven-idle whole native tree before any recovery capture or file
      // mutation. It retains the source and a closed candidate until finish.
      yield* prepareRollback({
        ...operation,
        numTurns: rolledBackTurns,
        firstRemovedTurnId: firstRemoved.turnId,
        retainedTurnCount: event.payload.turnCount,
        expectedControlSequence: event.sequence,
      }).pipe(
        Effect.mapError((error) =>
          isProviderRewindOutcomeUnknown(error)
            ? new ProviderAdapterRewindOutcomeUnknownError({})
            : error,
        ),
      );
      // Admission is now durably fenced and the native source tree is retired.
      // Drain any event whose ingestion began before that fence, so it cannot
      // append old-generation history across the upcoming checkpoint restore.
      yield* providerRuntimeIngestion.drain.pipe(
        Effect.timeoutOrElse({
          duration: "30 seconds",
          orElse: () => Effect.fail(new ProviderAdapterRewindOutcomeUnknownError({})),
        }),
      );
    }

    let recoveryCaptured = false;
    let restoreAttempted = false;
    yield* Effect.gen(function* () {
      yield* checkpointStore.captureCheckpoint({ cwd, checkpointRef: recoveryCheckpointRef });
      recoveryCaptured = true;
      // A restore can mutate files before reporting an error. Record the attempt
      // first, and compensate even a false/failed target restore from the exact
      // pre-operation snapshot; never assume that an error implies no mutation.
      restoreAttempted = true;
      const restored = yield* checkpointStore.restoreCheckpoint({
        cwd,
        checkpointRef: targetCheckpointRef,
        fallbackToHead: event.payload.turnCount === 0,
      });
      if (!restored) {
        return yield* Effect.fail(
          new CheckpointUnavailableError({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: "The filesystem checkpoint could not be restored.",
          }),
        );
      }
      yield* workspaceEntries.invalidate(cwd);

      if (usesPreparedRollback && commitRollback) {
        yield* commitRollback(operation);
      } else if (rolledBackTurns > 0) {
        yield* providerService.rollbackConversation({
          threadId: operation.threadId,
          numTurns: rolledBackTurns,
        });
      }
    }).pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          // Lost acknowledgements may conceal a committed native cursor. Do not
          // restore newer files or release the durable reservation in that case.
          // Defects/interruption also bypass this typed-error compensation path
          // and leave the recovery evidence for explicit inspection.
          if (isProviderRewindOutcomeUnknown(error)) return;
          if (recoveryCaptured && restoreAttempted) {
            const recovered = yield* checkpointStore
              .restoreCheckpoint({
                cwd,
                checkpointRef: recoveryCheckpointRef,
                fallbackToHead: false,
              })
              .pipe(
                Effect.catch(() =>
                  Effect.fail(
                    new CheckpointInvariantError({
                      operation: "compensate conversation rewind",
                      detail:
                        "The original workspace could not be restored. The recovery checkpoint was retained; inspect the saved workspace and provider history before continuing.",
                    }),
                  ),
                ),
              );
            if (!recovered) {
              return yield* Effect.fail(
                new CheckpointInvariantError({
                  operation: "compensate conversation rewind",
                  detail:
                    "The original workspace restore was not confirmed. The recovery checkpoint was retained; inspect the saved workspace and provider history before continuing.",
                }),
              );
            }
            yield* workspaceEntries.invalidate(cwd);
          }
          // Only a confirmed compensation (or no attempted filesystem mutation)
          // permits restoring the source binding and clearing the reservation.
          // If abort itself fails, retain the ref as durable recovery evidence.
          if (usesPreparedRollback && finishRollback) {
            yield* finishRollback({ ...operation, outcome: "aborted" });
          }
          if (recoveryCaptured) {
            yield* checkpointStore
              .deleteCheckpointRefs({ cwd, checkpointRefs: [recoveryCheckpointRef] })
              .pipe(Effect.ignore);
          }
        }),
      ),
      Effect.mapError((error) =>
        isProviderRewindOutcomeUnknown(error)
          ? new ProviderAdapterRewindOutcomeUnknownError({})
          : error,
      ),
    );

    // Provider commit, the durable conversation projection and native admission
    // release are separate acknowledgements. A failure after provider commit
    // must not compensate files or discard either recovery evidence or the
    // newer checkpoint refs. The still-held reservation blocks new turns.
    const completionCommandId = serverCommandId("checkpoint-revert-complete");
    yield* orchestrationEngine.dispatch({
      type: "thread.revert.complete",
      commandId: completionCommandId,
      threadId: event.payload.threadId,
      turnCount: event.payload.turnCount,
      createdAt: now,
      ...(usesPreparedRollback ? { expectedControlSequence: event.sequence } : {}),
    });
    if (usesPreparedRollback && finishRollback) {
      yield* finishRollback({ ...operation, outcome: "committed", completionCommandId }).pipe(
        Effect.mapError((error) =>
          isProviderRewindOutcomeUnknown(error)
            ? new ProviderAdapterRewindOutcomeUnknownError({})
            : error,
        ),
      );
    }

    const staleCheckpointRefs = thread.checkpoints
      .filter(
        (checkpoint) =>
          checkpoint.checkpointTurnCount > event.payload.turnCount &&
          isThreadOwnedHiddenCheckpointRef(thread.id, checkpoint.checkpointRef) &&
          (!workspaceFence ||
            checkpoint.checkpointRef ===
              checkpointRefForThreadTurn(
                thread.id,
                checkpoint.checkpointTurnCount,
                workspaceFence.associationSequence,
              )),
      )
      .map((checkpoint) => checkpoint.checkpointRef);

    if (staleCheckpointRefs.length > 0) {
      yield* checkpointStore.deleteCheckpointRefs({
        cwd,
        checkpointRefs: staleCheckpointRefs,
      });
    }

    // This is intentionally last, not an unconditional finalizer: failure to
    // restore/commit/project/release must never delete the only original state.
    yield* checkpointStore
      .deleteCheckpointRefs({ cwd, checkpointRefs: [recoveryCheckpointRef] })
      .pipe(Effect.ignore);
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }

    // When ProviderRuntimeIngestion creates a placeholder checkpoint (status "missing")
    // from a turn.diff.updated runtime event, capture the real git checkpoint to
    // replace it. The providerService.streamEvents PubSub does not reliably deliver
    // turn.completed runtime events to this reactor (shared subscription), so
    // reacting to the domain event is the reliable path.
    if (event.type === "thread.turn-diff-completed") {
      yield* captureCheckpointFromPlaceholder(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }

    if (
      event.type === "thread.session-set" &&
      (event.payload.session.status === "ready" ||
        event.payload.session.status === "error" ||
        event.payload.session.status === "interrupted" ||
        event.payload.session.status === "stopped")
    ) {
      yield* captureCheckpointFromSettledLatestTurnPlaceholder(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.payload.threadId,
              turnId: null,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    // This reactor consumes raw provider events independently of ingestion.
    // Even an old terminal ingestion receipt is not authority to recreate a
    // removed checkpoint after rewind. Recheck the durable native-generation
    // fence when dequeuing, including events queued before the rewind began.
    const accepted = yield* conversationRewinds.acceptsEvent(event).pipe(
      Effect.catch(() =>
        Effect.logWarning("checkpoint runtime event admission could not verify the rewind fence", {
          threadId: event.threadId,
        }).pipe(Effect.as(false)),
      ),
    );
    if (!accepted) return;
    if (event.type === "turn.started") {
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "vcs.state.changed") {
      yield* refreshGitStatusFromProviderInvalidation(event);
      return;
    }

    if (event.type === "turn.completed") {
      const turnId = toTurnId(event.turnId);
      if (turnId) {
        // `CheckpointReactor` and `ProviderRuntimeIngestion` consume the same
        // provider stream independently. A long assistant answer can leave
        // ingestion processing earlier content while this reactor already sees
        // `turn.completed`; waiting for the ingestion receipt prevents terminal
        // checkpoint/diff state from closing still-flushing assistant text.
        const ingestionReceipt = yield* receiptBus
          .awaitTurnIngestionQuiesced({
            threadId: event.threadId,
            turnId,
            provider: event.provider,
            ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
          })
          .pipe(Effect.timeoutOption(PROVIDER_TURN_INGESTION_QUIESCENCE_TIMEOUT));

        if (Option.isNone(ingestionReceipt)) {
          yield* Effect.logWarning(
            "checkpoint reactor skipped terminal checkpoint capture because provider ingestion did not quiesce",
            {
              threadId: event.threadId,
              turnId,
              provider: event.provider,
              providerInstanceId: event.providerInstanceId,
              eventId: event.eventId,
            },
          );
          return;
        }
      }

      yield* refreshLocalGitStatusFromTurnCompletion(event);
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<void, CheckpointStoreError | OrchestrationDispatchError, never> =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.turn-diff-completed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "vcs.state.changed"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
