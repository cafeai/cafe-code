/**
 * ProjectionSnapshotQuery - Read-model snapshot query service interface.
 *
 * Exposes the current orchestration projection snapshot for read-only API
 * access.
 *
 * @module ProjectionSnapshotQuery
 */
import type {
  ChatAttachment,
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationProject,
  OrchestrationProjectShell,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadTurnActivityPage,
  OrchestrationThreadTurnActivityPageInput,
  OrchestrationThreadTurnSubagentDetailInput,
  OrchestrationThreadTurnWorkLogPresenceInput,
  OrchestrationThreadTurnWorkLogPresenceResult,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface ProjectionSnapshotCounts {
  readonly projectCount: number;
  readonly threadCount: number;
}

export interface ProjectionSnapshotSequence {
  readonly snapshotSequence: number;
}

export interface ProjectionThreadCheckpointContext {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

/**
 * Optional exact filters for the durable Codex steer-acceptance evidence
 * query. Leaving every field undefined intentionally returns the complete
 * projection history; callers that already know one identity should bind it
 * so SQLite can stop at the narrowest available thread/turn/message scope.
 */
export interface ProjectionCodexSteerAcceptanceEvidenceInput {
  readonly threadId?: ThreadId;
  readonly acceptedTurnId?: TurnId;
  readonly messageId?: MessageId;
  /**
   * Startup recovery already has this authenticated compact-ledger identity.
   * Supplying it selects the accepted activity and its source event by their
   * primary keys instead of joining every acceptance in a long-lived thread.
   */
  readonly exactAcceptedBarrier?: ProjectionAcceptedCodexSteerCandidate;
}

/** Exact compact-ledger identity for one trusted Codex steer acceptance. */
export interface ProjectionAcceptedCodexSteerCandidate {
  readonly _tag: "accepted";
  readonly threadId: ThreadId;
  readonly eventSequence: number;
  readonly intentSequence: number;
  readonly intentCreatedAt: string;
  readonly activityId: string;
  readonly acceptedTurnId: TurnId;
  readonly clientCorrelationId: string | null;
  readonly messageId: MessageId;
  readonly acceptedAt: string;
}

/** Legacy latest-turn stale-message work has no historical acceptance. */
export interface ProjectionLegacyCodexSteerCandidate {
  readonly _tag: "legacy";
  readonly threadId: ThreadId;
}

export type ProjectionPostTerminalCodexSteerCandidate =
  | ProjectionAcceptedCodexSteerCandidate
  | ProjectionLegacyCodexSteerCandidate;

/**
 * Durable facts needed to reconcile an acknowledged Codex steer without
 * hydrating the bounded thread-detail message/activity tails.
 */
export interface ProjectionCodexSteerAcceptanceEvidence {
  readonly threadId: ThreadId;
  readonly acceptedTurnId: TurnId;
  readonly intentSequence: number;
  /** Opaque provider correlation metadata; never prompt or attachment data. */
  readonly clientCorrelationId: string | null;
  readonly messageId: MessageId;
  /** The message may have been retargeted after acceptance. */
  readonly messageTurnId: TurnId | null;
  readonly messageText: string;
  readonly messageAttachments: ReadonlyArray<ChatAttachment>;
  readonly acceptedAt: string;
  readonly turnState: "running" | "completed" | "error" | "interrupted";
  readonly turnCompletedAt: string | null;
  readonly processingObserved: boolean;
  /** A trusted server-authored terminal-recovery delivery receipt exists. */
  readonly recoveryObserved: boolean;
  readonly interruptRequested: boolean;
  readonly sessionStopRequested: boolean;
}

/**
 * Minimal identity for a durable authenticated client/server Codex steer
 * intent that has no later delivery, processing, failure, or superseding
 * intent outcome.
 * Callers can use `sequence` to reload and enqueue the exact persisted event
 * without copying prompt content through startup discovery.
 */
export interface ProjectionUnsettledCodexSteerIntentEvent {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** The immutable provider turn target persisted with the steer intent. */
  readonly expectedTurnId: TurnId | null;
  readonly createdAt: string;
}

export interface ProjectionUnsettledCodexSteerIntentInput {
  /**
   * Live provider ingestion always knows the owning thread. Supplying it keeps
   * one processing notification from scanning every historical Codex intent
   * in the workspace; startup reconciliation intentionally omits the filter.
   */
  readonly threadId?: ThreadId;
  /**
   * Startup reconciliation must prove whether a durable provider-processing
   * receipt already settled each candidate before replaying provider I/O.
   * Live provider ingestion already holds the exact authenticated runtime
   * correlation and performs its own post-dispatch, generation-bound prune;
   * it may disable this historical read to keep the hot event path bounded.
   * Defaults to true for every caller that does not opt out explicitly.
   */
  readonly reconcileDurableProcessing?: boolean;
}

export interface ProjectionCodexSteerIntentRecoveryBarrierInput {
  readonly sequence: number;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly expectedTurnId: TurnId | null;
}

/**
 * Exact event-store barriers that appeared after one authenticated steer
 * intent. `intentVerified` prevents a caller-supplied tuple from turning an
 * unrelated sequence into replay authority.
 */
export interface ProjectionCodexSteerIntentRecoveryBarriers {
  readonly intentVerified: boolean;
  readonly newerTurnRequested: boolean;
  readonly interruptRequested: boolean;
  readonly sessionStopRequested: boolean;
}

/**
 * ProjectionSnapshotQueryShape - Service API for read-model snapshots.
 */
export interface ProjectionSnapshotQueryShape {
  /**
   * Read the lightweight command snapshot used to bootstrap the in-memory
   * orchestration engine without hydrating message/activity/checkpoint bodies.
   */
  readonly getCommandReadModel: () => Effect.Effect<
    OrchestrationReadModel,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest orchestration projection snapshot.
   *
   * Rehydrates from projection tables and derives snapshot sequence from
   * projector cursor state.
   */
  readonly getSnapshot: () => Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>;

  /**
   * Read the latest orchestration shell snapshot.
   *
   * Returns only projects and thread shell summaries so clients can bootstrap
   * lightweight navigation state without hydrating every thread body.
   */
  readonly getShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read archived thread shell summaries for the archive page.
   *
   * This query is separate from the main shell snapshot so archived threads
   * are never bootstrapped into normal navigation state.
   */
  readonly getArchivedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read soft-deleted thread shell summaries for the Recently Deleted page.
   *
   * Deleted threads stay outside normal navigation and archive snapshots.
   */
  readonly getDeletedShellSnapshot: () => Effect.Effect<
    OrchestrationShellSnapshot,
    ProjectionRepositoryError
  >;

  /**
   * Read the latest projection snapshot sequence without hydrating read-model
   * entities.
   */
  readonly getSnapshotSequence: () => Effect.Effect<
    ProjectionSnapshotSequence,
    ProjectionRepositoryError
  >;

  /**
   * Read aggregate projection counts without hydrating the full read model.
   */
  readonly getCounts: () => Effect.Effect<ProjectionSnapshotCounts, ProjectionRepositoryError>;

  /**
   * Read the active project for an exact workspace root match.
   */
  readonly getActiveProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, ProjectionRepositoryError>;

  /**
   * Read a single active project shell row by id.
   */
  readonly getProjectShellById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ProjectionRepositoryError>;

  /**
   * Read the earliest active thread for a project.
   */
  readonly getFirstActiveThreadIdByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<ThreadId>, ProjectionRepositoryError>;

  /**
   * Read the checkpoint context needed to resolve a single thread diff.
   */
  readonly getThreadCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProjectionThreadCheckpointContext>, ProjectionRepositoryError>;

  /**
   * Read a single active thread shell row by id.
   */
  readonly getThreadShellById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadShell>, ProjectionRepositoryError>;

  /**
   * Find active Codex threads with either a shell-proven legacy latest-turn
   * stale-message shape or trusted, unprocessed acceptance evidence on any
   * historical terminal turn. Manual-interrupt candidates remain included so
   * startup can settle them into the retryable queue instead of silently
   * losing them.
   */
  readonly getPostTerminalStaleSteerCandidateThreadIds: (
    /**
     * Startup already owns a lightweight shell snapshot. Passing its active
     * Codex thread ids avoids rediscovering that bounded set. Other callers
     * may omit the list; the implementation then reads only active Codex ids.
     */
    activeCodexThreadIds?: ReadonlyArray<ThreadId>,
    /**
     * Legacy recovery predates the compact acceptance ledger. Startup derives
     * this small set from `latestUserMessageAt` and the latest terminal turn
     * already present in its shell snapshot, avoiding a per-thread scan of
     * historical messages and activities during backend bootstrap.
     */
    legacyCandidateThreadIds?: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>;

  /**
   * Return the exact compact identities behind post-terminal recovery. The
   * accepted variant is deliberately richer than the compatibility thread-id
   * view above so startup never has to rediscover an accepted activity by
   * scanning the thread's complete history.
   */
  readonly getPostTerminalStaleSteerCandidates: (
    activeCodexThreadIds?: ReadonlyArray<ThreadId>,
    legacyCandidateThreadIds?: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionPostTerminalCodexSteerCandidate>,
    ProjectionRepositoryError
  >;

  /**
   * Read the complete trusted Codex steer-acceptance evidence set, optionally
   * narrowed by exact identities. This path is deliberately unbounded by the
   * thread-detail history caps because terminal reconciliation must work after
   * arbitrarily long provider turns and after newer turns become latest.
   */
  readonly getCodexSteerAcceptanceEvidence: (
    input?: ProjectionCodexSteerAcceptanceEvidenceInput,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionCodexSteerAcceptanceEvidence>,
    ProjectionRepositoryError
  >;

  /**
   * Read durable Codex steer intents that crashed before a terminal delivery
   * outcome from the compact append-time ledger. The first read after the
   * ledger migration inspects only a fixed recent tail for each active Codex
   * thread; results contain identifiers only and remain ordered by the
   * original event-store sequence for deterministic startup replay.
   */
  readonly getUnsettledCodexSteerIntentEvents: (
    input?: ProjectionUnsettledCodexSteerIntentInput,
  ) => Effect.Effect<
    ReadonlyArray<ProjectionUnsettledCodexSteerIntentEvent>,
    ProjectionRepositoryError
  >;

  /**
   * Revalidate one exact persisted steer intent immediately before recovery
   * performs provider I/O. Only authenticated client/server event rows count.
   */
  readonly getCodexSteerIntentRecoveryBarriers: (
    input: ProjectionCodexSteerIntentRecoveryBarrierInput,
  ) => Effect.Effect<ProjectionCodexSteerIntentRecoveryBarriers, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot by id.
   */
  readonly getThreadDetailById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, ProjectionRepositoryError>;

  /**
   * Read a single active thread detail snapshot and the projection sequence
   * from the same read transaction.
   *
   * WebSocket subscriptions use this cursor as the replay boundary. Reading
   * detail and sequence separately can stamp an older detail payload with a
   * newer cursor, causing the client to skip exactly the events it needs after
   * a reconnect or renderer stall.
   */
  readonly getThreadDetailSnapshotById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>, ProjectionRepositoryError>;

  /**
   * Read a bounded page of raw persisted activity for one turn.
   *
   * Thread detail snapshots intentionally carry only the recent activity cap.
   * Historical work-log rows use this query to hydrate older turn activity on
   * demand without expanding the hot subscription payload for every thread.
   */
  readonly getThreadTurnActivityPage: (
    input: OrchestrationThreadTurnActivityPageInput,
  ) => Effect.Effect<OrchestrationThreadTurnActivityPage, ProjectionRepositoryError>;

  /**
   * Test whether bounded historical turns contain displayable work-log rows.
   *
   * This is deliberately an existence query rather than a count/page query so
   * scrolling through a long conversation does not scan every activity in a
   * multi-hour turn merely to decide whether a collapsed row should exist.
   */
  readonly getThreadTurnWorkLogPresence: (
    input: OrchestrationThreadTurnWorkLogPresenceInput,
  ) => Effect.Effect<OrchestrationThreadTurnWorkLogPresenceResult, ProjectionRepositoryError>;

  /**
   * Prove that a provider child id was durably associated with one exact Cafe
   * thread and turn before a provider-native transcript read is attempted.
   */
  readonly hasThreadTurnSubagentActivity: (
    input: OrchestrationThreadTurnSubagentDetailInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

/**
 * ProjectionSnapshotQuery - Service tag for projection snapshot queries.
 */
export class ProjectionSnapshotQuery extends Context.Service<
  ProjectionSnapshotQuery,
  ProjectionSnapshotQueryShape
>()("cafecode/orchestration/Services/ProjectionSnapshotQuery") {}
