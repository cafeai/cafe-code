import { isDeepStrictEqual } from "node:util";

import type { OrchestrationEvent, OrchestrationCommand } from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";

type StartEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
type StartCommand = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

/**
 * Called INSIDE the engine's event/receipt transaction, before decision. The
 * first statement is a conditional write: a concurrent pause cannot slip
 * between validation and receipt publication, including SQLite WAL readers.
 * A supplied schedule ID is never authority by itself. The immutable minted
 * run, revision, thread and exact command/message IDs must all agree.
 */
export const verifyScheduledFollowUpAdmission = (command: StartCommand) =>
  Effect.gen(function* () {
    const guard = command.scheduledFollowUp;
    if (!guard) return false;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ id: string }>`UPDATE scheduled_followup_runs SET state = 'dispatching'
      WHERE id = ${guard.runId} AND schedule_id = ${guard.scheduleId}
        AND revision = ${guard.revision} AND thread_id = ${command.threadId}
        AND command_id = ${command.commandId} AND message_id = ${command.message.messageId}
        AND state = 'waiting' AND attempt_at IS NULL
        AND EXISTS (SELECT 1 FROM scheduled_followups s
          JOIN projection_threads t ON t.thread_id = s.thread_id
          WHERE s.id = scheduled_followup_runs.schedule_id AND s.revision = scheduled_followup_runs.revision
            AND s.state = 'active' AND t.deleted_at IS NULL AND t.archived_at IS NULL
            AND s.authorized_instance_id = ${command.modelSelection?.instanceId ?? ""}
            AND s.authorized_instance_id = json_extract(t.model_selection_json,'$.instanceId')
            AND s.permission_ceiling = ${command.runtimeMode}
            AND t.runtime_mode = s.permission_ceiling)
      RETURNING id`;
    if (rows.length !== 1) return false;
    const [settings] = yield* sql<{ model_selection_json: string; interaction_mode: string }>`
      SELECT model_selection_json, interaction_mode FROM projection_threads
      WHERE thread_id = ${command.threadId}`;
    let settingsMatch = false;
    try {
      settingsMatch =
        settings !== undefined &&
        isDeepStrictEqual(
          JSON.parse(settings.model_selection_json),
          guard.expectedModelSelection,
        ) &&
        settings.interaction_mode === guard.expectedInteractionMode;
    } catch {
      // Malformed persisted settings are not permission to substitute defaults.
    }
    if (!settingsMatch) return false;
    // The engine's command read model is process-local. This authoritative
    // writer-locked read also fences an independently connected backend which
    // admitted interactive work or a different schedule after that snapshot.
    // Authority is checked before this branch so a forged occurrence cannot
    // obtain the special definitive "wait and retry" outcome. Throwing rolls
    // back the provisional claim with the enclosing event/receipt transaction.
    const [busy] = yield* sql<{ busy: number }>`SELECT (
      EXISTS (SELECT 1 FROM scheduled_followup_runs other
        WHERE other.thread_id = ${command.threadId} AND other.id <> ${guard.runId}
          AND other.state IN ('dispatching','running','unknown'))
      OR EXISTS (SELECT 1 FROM projection_thread_sessions session
        WHERE session.thread_id = ${command.threadId}
          AND (session.active_turn_id IS NOT NULL OR session.status IN ('starting','running')))
      OR EXISTS (SELECT 1 FROM projection_threads thread
        WHERE thread.thread_id = ${command.threadId}
          AND (thread.pending_approval_count > 0 OR thread.pending_user_input_count > 0))
      OR EXISTS (SELECT 1 FROM projection_pending_approvals approval
        WHERE approval.thread_id = ${command.threadId} AND approval.status = 'pending')
      OR EXISTS (SELECT 1 FROM projection_threads thread
        JOIN projection_turns turn ON turn.thread_id = thread.thread_id
          AND turn.turn_id = thread.latest_turn_id
        LEFT JOIN projection_thread_sessions session ON session.thread_id = thread.thread_id
        WHERE thread.thread_id = ${command.threadId} AND turn.state IN ('pending','running')
          AND turn.completed_at IS NULL
          AND (session.status IS NULL OR session.status NOT IN ('stopped','interrupted','error')))
    ) AS busy`;
    if (busy?.busy === 1) {
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Scheduled follow-up is waiting for an idle chat.",
      });
    }
    return true;
  });

/** Binds the occurrence to the exact durable start intent in the same commit. */
export const markScheduledFollowUpAdmitted = (event: StartEvent) =>
  Effect.gen(function* () {
    const guard = event.payload.scheduledFollowUp;
    if (!guard) return;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE scheduled_followup_runs SET intent_sequence = ${event.sequence},
      model_json = ${JSON.stringify(event.payload.modelSelection)}
      WHERE id = ${guard.runId} AND schedule_id = ${guard.scheduleId}
        AND revision = ${guard.revision} AND state = 'dispatching'
        AND message_id = ${event.payload.messageId} AND attempt_at IS NULL`;
  });

/**
 * An indexed exact-intent check, not a transcript scan. New user input, Stop,
 * workspace/account/permission changes or another turn win before submission.
 * The immutable server-authored event must bind the run as well as the row.
 */
export const isScheduledFollowUpAuthorized = (event: StartEvent) =>
  Effect.gen(function* () {
    const guard = event.payload.scheduledFollowUp;
    if (!guard) return false;
    const sql = yield* SqlClient.SqlClient;
    const now = DateTime.formatIso(yield* DateTime.now);
    const [row] = yield* sql<{ allowed: number }>`SELECT EXISTS (
      SELECT 1 FROM scheduled_followup_runs r
      JOIN scheduled_followups s ON s.id = r.schedule_id
      JOIN projection_threads t ON t.thread_id = r.thread_id
      JOIN orchestration_events e ON e.sequence = r.intent_sequence
      WHERE r.id = ${guard.runId} AND r.schedule_id = ${guard.scheduleId}
        AND r.thread_id = ${event.payload.threadId} AND r.revision = ${guard.revision}
        AND r.intent_sequence = ${event.sequence} AND r.message_id = ${event.payload.messageId}
        AND r.state = 'dispatching' AND r.attempt_at IS NULL
        AND s.state = 'active' AND s.revision = r.revision
        AND (json_extract(s.definition_json,'$.endAt') IS NULL
          OR ${now} <= json_extract(s.definition_json,'$.endAt'))
        AND (json_extract(s.definition_json,'$.maxRuns') IS NULL
          OR s.run_count < json_extract(s.definition_json,'$.maxRuns'))
        AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND t.pending_approval_count = 0 AND t.pending_user_input_count = 0
        AND NOT EXISTS (SELECT 1 FROM projection_pending_approvals approval
          WHERE approval.thread_id = r.thread_id AND approval.status = 'pending')
        AND s.authorized_instance_id = json_extract(t.model_selection_json,'$.instanceId')
        AND s.authorized_instance_id = ${event.payload.modelSelection?.instanceId ?? ""}
        AND t.runtime_mode = s.permission_ceiling AND t.runtime_mode = ${event.payload.runtimeMode}
        AND e.event_type = 'thread.turn-start-requested' AND e.actor_kind = 'server'
        AND e.stream_id = r.thread_id AND json_extract(e.payload_json,'$.scheduledFollowUp.runId') = r.id
        AND json_extract(e.payload_json,'$.scheduledFollowUp.scheduleId') = s.id
        AND json_extract(e.payload_json,'$.scheduledFollowUp.revision') = r.revision
        AND (SELECT sequence FROM orchestration_runtime_recovery_controls
          WHERE thread_id = r.thread_id ORDER BY sequence DESC LIMIT 1) = r.intent_sequence
    ) AS allowed`;
    return row?.allowed === 1;
  });

/**
 * An immutable paid-submission marker. Never clear it on timeout, restart, or
 * missing ACK. Holding only the short SQLite transaction (not provider I/O)
 * makes this the dispatch authorization linearization boundary.
 */
export const verifyScheduledFollowUpDispatch = (event: StartEvent) =>
  Effect.gen(function* () {
    const guard = event.payload.scheduledFollowUp;
    if (!guard) return false;
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // Acquire the writer before the authority read so revocation and this
        // attempt have a single order across independent SQLite connections.
        yield* sql`UPDATE scheduled_followup_runs SET id = id WHERE id = ${guard.runId}`;
        if (!(yield* isScheduledFollowUpAuthorized(event))) return false;
        // Preparation may outlive the owner's expiry/run budget. The
        // writer-locked authority read above includes both limits, so neither
        // an elapsed deadline nor another counted attempt can slip past it.
        const now = DateTime.formatIso(yield* DateTime.now);
        const rows = yield* sql<{ id: string }>`UPDATE scheduled_followup_runs
        SET attempt_at = ${now}
        WHERE id = ${guard.runId} AND state = 'dispatching' AND attempt_at IS NULL RETURNING id`;
        if (rows.length === 1)
          yield* sql`UPDATE scheduled_followups SET run_count = run_count + 1 WHERE id = ${guard.scheduleId}`;
        return rows.length === 1;
      }),
    );
  });
