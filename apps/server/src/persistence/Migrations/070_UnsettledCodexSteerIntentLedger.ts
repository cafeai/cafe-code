import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Install a compact, append-time index of Codex steer intents that may still
 * need provider delivery.
 *
 * The orchestration journal can contain tens of millions of provider events.
 * A startup query that rediscovers unsettled steer intents by evaluating JSON
 * predicates and correlated subqueries over that journal blocks Node's single
 * event loop inside `StatementSync.all()`. This migration deliberately does
 * not backfill or index the historical journal. `MAX(sequence)` is an indexed
 * right-edge lookup; every event after that cutoff updates the compact ledger
 * atomically through the trigger below. A separately bounded runtime helper
 * considers only a small recent tail for pre-migration crash recovery.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Migration 66 originally created these JSON expression indexes before it
  // was retired to a no-op. Databases which already recorded migration 66 do
  // not rerun its rewritten source, so converge them here. DROP INDEX is a
  // schema-only operation and avoids rebuilding or scanning the 44M-row event
  // journal during the user's next startup.
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_thread_message_identity`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_thread_activity_message_identity`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_unsettled_codex_steer_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      legacy_cutoff_sequence INTEGER NOT NULL CHECK (legacy_cutoff_sequence >= 0)
    )
  `;

  yield* sql`
    INSERT INTO orchestration_unsettled_codex_steer_state (
      singleton_id,
      legacy_cutoff_sequence
    )
    SELECT 1, COALESCE(MAX(sequence), 0)
    FROM orchestration_events
    WHERE true
    ON CONFLICT (singleton_id) DO NOTHING
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_unsettled_codex_steer_intents (
      sequence INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      expected_turn_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (sequence)
        REFERENCES orchestration_events(sequence)
        ON DELETE CASCADE
    )
  `;

  // The ledger is intentionally tiny. These indexes serve exact per-thread
  // startup reads and outcome correlation without touching the large parent
  // event journal during migration.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_unsettled_codex_steer_thread_sequence
    ON orchestration_unsettled_codex_steer_intents(thread_id, sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_unsettled_codex_steer_thread_message_sequence
    ON orchestration_unsettled_codex_steer_intents(thread_id, message_id, sequence)
  `;

  // Keep exact post-migration settlement barriers even when the matching
  // legacy candidate has not been hydrated yet. Without this tiny companion
  // table, an outcome arriving between migration and a thread's first bounded
  // hydration could be forgotten and the old steer could be resurrected.
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_codex_steer_recovery_barriers (
      sequence INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT,
      candidate_sequence INTEGER,
      barrier_kind TEXT NOT NULL,
      activity_id TEXT,
      turn_id TEXT,
      accepted_turn_id TEXT,
      client_correlation_id TEXT,
      activity_created_at TEXT,
      FOREIGN KEY (sequence)
        REFERENCES orchestration_events(sequence)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_codex_steer_barrier_thread_message_sequence
    ON orchestration_codex_steer_recovery_barriers(thread_id, message_id, sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_codex_steer_barrier_thread_kind_sequence
    ON orchestration_codex_steer_recovery_barriers(thread_id, barrier_kind, sequence)
  `;

  /**
   * Accepted steers require a different recovery phase from intents which
   * have not reached provider I/O. Keep only acceptances that have not yet
   * produced exact processing or recovery evidence. This table is a compact
   * candidate set, not an acceptance history, so startup work is bounded by
   * genuinely pending side effects rather than application age.
   */
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_pending_codex_steer_acceptances (
      sequence INTEGER PRIMARY KEY,
      intent_sequence INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      accepted_turn_id TEXT NOT NULL,
      client_correlation_id TEXT,
      accepted_at TEXT NOT NULL,
      FOREIGN KEY (sequence)
        REFERENCES orchestration_events(sequence)
        ON DELETE CASCADE,
      FOREIGN KEY (intent_sequence)
        REFERENCES orchestration_events(sequence)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pending_codex_steer_acceptance_thread_sequence
    ON orchestration_pending_codex_steer_acceptances(thread_id, sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pending_codex_steer_acceptance_intent_sequence
    ON orchestration_pending_codex_steer_acceptances(intent_sequence)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_unsettled_codex_steer_hydration (
      thread_id TEXT PRIMARY KEY,
      tail_floor_sequence INTEGER NOT NULL CHECK (tail_floor_sequence >= 0),
      through_sequence INTEGER NOT NULL CHECK (through_sequence >= tail_floor_sequence)
    ) WITHOUT ROWID
  `;

  /**
   * Maintain the compact candidate set in the same SQLite transaction as the
   * authoritative event append. The trigger trusts only canonical Cafe event
   * tuples: authenticated client/server intents and exact server-authored
   * activity outcomes. Provider-authored lookalikes cannot add, supersede, or
   * settle a recovery candidate.
   *
   * Provider-runtime `task.progress` retains provider actor provenance, so the
   * trigger deliberately does not trust it to prune accepted recovery state.
   * Reconciliation derives Cafe's domain-separated correlation in TypeScript,
   * verifies the exact persisted acceptance/processing tuple, and only then
   * calls the compact ledger's exact-identity prune helper.
   */
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_orchestration_unsettled_codex_steer_event
    AFTER INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'thread'
      AND (
        NEW.event_type IN ('thread.turn-start-requested', 'thread.turn-steer-requested')
        OR NEW.event_type = 'thread.activity-appended'
      )
    BEGIN
      INSERT INTO orchestration_unsettled_codex_steer_intents (
        sequence,
        thread_id,
        message_id,
        expected_turn_id,
        created_at
      )
      SELECT
        NEW.sequence,
        NEW.stream_id,
        json_extract(NEW.payload_json, '$.messageId'),
        json_extract(NEW.payload_json, '$.expectedTurnId'),
        NEW.occurred_at
      WHERE NEW.event_type = 'thread.turn-steer-requested'
        AND NEW.actor_kind IN ('client', 'server')
        AND json_extract(NEW.payload_json, '$.threadId') = NEW.stream_id
        AND json_type(NEW.payload_json, '$.messageId') = 'text'
        AND (
          json_type(NEW.payload_json, '$.expectedTurnId') IS NULL
          OR json_type(NEW.payload_json, '$.expectedTurnId') IN ('text', 'null')
        )
        AND json_extract(NEW.payload_json, '$.createdAt') = NEW.occurred_at
      ON CONFLICT (sequence) DO NOTHING;

      -- Persist a compact exact barrier before deleting candidates. This also
      -- remembers outcomes for a pre-migration candidate whose bounded legacy
      -- hydration has not run yet. A NULL candidate_sequence settles all older
      -- generations of the MessageId; failed/attempted outcomes with an exact
      -- intent sequence settle only that generation. Every post-cutoff failed
      -- outcome is generation-bound; accepting NULL here would let an older
      -- acceptance failure erase a newer retry reusing the same MessageId.
      INSERT INTO orchestration_codex_steer_recovery_barriers (
        sequence,
        thread_id,
        message_id,
        candidate_sequence,
        barrier_kind,
        activity_id,
        turn_id,
        accepted_turn_id,
        client_correlation_id,
        activity_created_at
      )
      SELECT
        NEW.sequence,
        NEW.stream_id,
        CASE
          WHEN NEW.event_type <> 'thread.activity-appended'
          THEN json_extract(NEW.payload_json, '$.messageId')
          ELSE json_extract(NEW.payload_json, '$.activity.payload.messageId')
        END,
        CASE
          WHEN NEW.event_type = 'thread.activity-appended'
            AND json_extract(NEW.payload_json, '$.activity.kind') IN (
              'provider.turn.steer.accepted',
              'provider.turn.steer.failed',
              'provider.turn.steer.recovered',
              'provider.turn.steer.delivered',
              'provider.turn.steer.delivery-attempted'
            )
            AND json_type(
              NEW.payload_json,
              '$.activity.payload.intentSequence'
            ) = 'integer'
            AND EXISTS (
              SELECT 1
              FROM orchestration_events AS failed_intent
              WHERE failed_intent.sequence = json_extract(
                  NEW.payload_json,
                  '$.activity.payload.intentSequence'
                )
                AND failed_intent.aggregate_kind = 'thread'
                AND failed_intent.stream_id = NEW.stream_id
                AND failed_intent.event_type IN (
                  'thread.turn-start-requested',
                  'thread.turn-steer-requested'
                )
                AND failed_intent.actor_kind IN ('client', 'server')
                AND json_extract(failed_intent.payload_json, '$.threadId') = NEW.stream_id
                AND json_extract(failed_intent.payload_json, '$.messageId') =
                  json_extract(NEW.payload_json, '$.activity.payload.messageId')
              LIMIT 1
            )
          THEN json_extract(
            NEW.payload_json,
            '$.activity.payload.intentSequence'
          )
          ELSE NULL
        END,
        CASE
          WHEN NEW.event_type <> 'thread.activity-appended' THEN NEW.event_type
          ELSE json_extract(NEW.payload_json, '$.activity.kind')
        END,
        CASE
          WHEN NEW.event_type = 'thread.activity-appended'
          THEN json_extract(NEW.payload_json, '$.activity.id')
          ELSE NULL
        END,
        CASE
          WHEN NEW.event_type = 'thread.activity-appended'
          THEN json_extract(NEW.payload_json, '$.activity.turnId')
          ELSE NULL
        END,
        CASE
          WHEN NEW.event_type = 'thread.activity-appended'
            AND json_extract(NEW.payload_json, '$.activity.kind') =
              'provider.turn.steer.recovered'
          THEN json_extract(NEW.payload_json, '$.activity.payload.acceptedTurnId')
          ELSE NULL
        END,
        CASE
          WHEN NEW.event_type = 'thread.activity-appended'
          THEN json_extract(
            NEW.payload_json,
            '$.activity.payload.clientCorrelationId'
          )
          ELSE NULL
        END,
        CASE
          WHEN NEW.event_type = 'thread.activity-appended'
          THEN json_extract(NEW.payload_json, '$.activity.createdAt')
          ELSE NULL
        END
      WHERE ((
          NEW.event_type IN ('thread.turn-start-requested', 'thread.turn-steer-requested')
          AND NEW.actor_kind IN ('client', 'server')
          AND json_extract(NEW.payload_json, '$.threadId') = NEW.stream_id
          AND json_type(NEW.payload_json, '$.messageId') = 'text'
        )
        OR (
          NEW.event_type = 'thread.activity-appended'
          AND NEW.actor_kind = 'server'
          AND json_extract(NEW.payload_json, '$.threadId') = NEW.stream_id
          AND json_type(NEW.payload_json, '$.activity.id') = 'text'
          AND json_type(NEW.payload_json, '$.activity.kind') = 'text'
          AND (
          (
            json_extract(NEW.payload_json, '$.activity.kind') =
              'provider.turn.steer.accepted'
            AND json_extract(NEW.payload_json, '$.activity.payload.provider') = 'codex'
            AND json_type(NEW.payload_json, '$.activity.payload.messageId') = 'text'
            AND json_extract(NEW.payload_json, '$.activity.payload.acceptedTurnId') =
              json_extract(NEW.payload_json, '$.activity.turnId')
            AND json_type(
              NEW.payload_json,
              '$.activity.payload.intentSequence'
            ) = 'integer'
            AND (
              json_type(
                NEW.payload_json,
                '$.activity.payload.clientCorrelationId'
              ) IS NULL
              OR json_type(
                NEW.payload_json,
                '$.activity.payload.clientCorrelationId'
              ) IN ('text', 'null')
            )
          )
          OR (
            json_extract(NEW.payload_json, '$.activity.kind') =
              'provider.turn.steer.failed'
            AND json_type(NEW.payload_json, '$.activity.payload.messageId') = 'text'
            AND json_type(
              NEW.payload_json,
              '$.activity.payload.intentSequence'
            ) = 'integer'
          )
          OR (
            json_extract(NEW.payload_json, '$.activity.kind') =
              'provider.turn.steer.recovered'
            AND json_extract(NEW.payload_json, '$.activity.payload.provider') = 'codex'
            AND json_type(NEW.payload_json, '$.activity.payload.messageId') = 'text'
            AND json_type(
              NEW.payload_json,
              '$.activity.payload.acceptedTurnId'
            ) = 'text'
            AND json_extract(NEW.payload_json, '$.activity.payload.recoveredTurnId') =
              json_extract(NEW.payload_json, '$.activity.turnId')
            AND json_type(
              NEW.payload_json,
              '$.activity.payload.intentSequence'
            ) = 'integer'
            AND EXISTS (
              SELECT 1
              FROM orchestration_events AS recovered_intent
              WHERE recovered_intent.sequence = json_extract(
                  NEW.payload_json,
                  '$.activity.payload.intentSequence'
                )
                AND recovered_intent.aggregate_kind = 'thread'
                AND recovered_intent.stream_id = NEW.stream_id
                AND recovered_intent.event_type IN (
                  'thread.turn-start-requested',
                  'thread.turn-steer-requested'
                )
                AND recovered_intent.actor_kind IN ('client', 'server')
                AND json_extract(recovered_intent.payload_json, '$.threadId') = NEW.stream_id
                AND json_extract(recovered_intent.payload_json, '$.messageId') =
                  json_extract(NEW.payload_json, '$.activity.payload.messageId')
              LIMIT 1
            )
          )
          OR (
            json_extract(NEW.payload_json, '$.activity.kind') =
              'provider.turn.steer.delivered'
            AND json_extract(NEW.payload_json, '$.activity.payload.provider') = 'codex'
            AND json_type(NEW.payload_json, '$.activity.payload.messageId') = 'text'
            AND json_extract(NEW.payload_json, '$.activity.payload.deliveredTurnId') =
              json_extract(NEW.payload_json, '$.activity.turnId')
            AND json_extract(NEW.payload_json, '$.activity.payload.delivery') = 'next-turn'
            AND json_type(
              NEW.payload_json,
              '$.activity.payload.intentSequence'
            ) = 'integer'
            AND EXISTS (
              SELECT 1
              FROM orchestration_events AS delivered_intent
              WHERE delivered_intent.sequence = json_extract(
                  NEW.payload_json,
                  '$.activity.payload.intentSequence'
                )
                AND delivered_intent.aggregate_kind = 'thread'
                AND delivered_intent.stream_id = NEW.stream_id
                AND delivered_intent.event_type IN (
                  'thread.turn-start-requested',
                  'thread.turn-steer-requested'
                )
                AND delivered_intent.actor_kind IN ('client', 'server')
                AND json_extract(delivered_intent.payload_json, '$.threadId') = NEW.stream_id
                AND json_extract(delivered_intent.payload_json, '$.messageId') =
                  json_extract(NEW.payload_json, '$.activity.payload.messageId')
              LIMIT 1
            )
            AND json_extract(NEW.payload_json, '$.activity.payload.reason') IN (
              'turn-start-after-no-local-active-turn',
              'turn-start-after-missing-active-turn-id',
              'turn-start-after-provider-no-active-turn'
            )
          )
          OR (
            json_extract(NEW.payload_json, '$.activity.kind') =
              'provider.turn.steer.delivery-attempted'
            AND json_extract(NEW.payload_json, '$.activity.payload.provider') = 'codex'
            AND json_type(NEW.payload_json, '$.activity.payload.messageId') = 'text'
            AND json_type(
              NEW.payload_json,
              '$.activity.payload.intentSequence'
            ) = 'integer'
            AND json_extract(
              NEW.payload_json,
              '$.activity.payload.deliveryState'
            ) = 'attempted'
            AND (
              (
                json_extract(NEW.payload_json, '$.activity.payload.delivery') = 'live-steer'
                AND json_extract(NEW.payload_json, '$.activity.payload.reason') = 'live-steer'
                AND json_extract(
                  NEW.payload_json,
                  '$.activity.payload.expectedTurnId'
                ) = json_extract(NEW.payload_json, '$.activity.turnId')
              )
              OR (
                json_extract(NEW.payload_json, '$.activity.payload.delivery') = 'next-turn'
                AND json_extract(NEW.payload_json, '$.activity.payload.reason') IN (
                  'turn-start-after-no-local-active-turn',
                  'turn-start-after-missing-active-turn-id',
                  'turn-start-after-provider-no-active-turn',
                  'turn-start-after-terminal-unprocessed-steer'
                )
                AND json_extract(
                  NEW.payload_json,
                  '$.activity.payload.staleTurnId'
                ) IS json_extract(NEW.payload_json, '$.activity.turnId')
              )
            )
          )
          )
        ))
        AND (
          -- Normal post-cutoff events retain a barrier only when it can
          -- settle an existing older candidate. This prevents unrelated
          -- starts from becoming a second append-only history.
          EXISTS (
            SELECT 1
            FROM orchestration_unsettled_codex_steer_intents AS candidate
            WHERE candidate.thread_id = NEW.stream_id
              AND candidate.sequence < NEW.sequence
              AND candidate.message_id = CASE
                WHEN NEW.event_type = 'thread.activity-appended'
                THEN json_extract(NEW.payload_json, '$.activity.payload.messageId')
                ELSE json_extract(NEW.payload_json, '$.messageId')
              END
            LIMIT 1
          )
          OR EXISTS (
            SELECT 1
            FROM orchestration_pending_codex_steer_acceptances AS accepted
            WHERE NEW.event_type = 'thread.activity-appended'
              AND accepted.thread_id = NEW.stream_id
              AND accepted.sequence < NEW.sequence
              AND accepted.message_id =
                json_extract(NEW.payload_json, '$.activity.payload.messageId')
            LIMIT 1
          )
          OR (
            -- Before the one bounded legacy hydration, an outcome can arrive
            -- for a pre-cutoff intent which is not compact yet. Retain that
            -- narrow race only for a known Codex session that actually had a
            -- thread event at migration time. New/non-Codex threads never
            -- accumulate legacy barriers.
            NOT EXISTS (
              SELECT 1
              FROM orchestration_unsettled_codex_steer_hydration AS hydration
              WHERE hydration.thread_id = NEW.stream_id
              LIMIT 1
            )
            AND EXISTS (
              SELECT 1
              FROM projection_thread_sessions AS session
              WHERE session.thread_id = NEW.stream_id
                AND session.provider_name = 'codex'
              LIMIT 1
            )
            AND EXISTS (
              SELECT 1
              FROM orchestration_events AS legacy_event
              CROSS JOIN orchestration_unsettled_codex_steer_state AS state
              WHERE state.singleton_id = 1
                AND legacy_event.aggregate_kind = 'thread'
                AND legacy_event.stream_id = NEW.stream_id
                AND legacy_event.sequence <= state.legacy_cutoff_sequence
              LIMIT 1
            )
          )
        )
      ON CONFLICT (sequence) DO NOTHING;

      INSERT INTO orchestration_pending_codex_steer_acceptances (
        sequence,
        intent_sequence,
        thread_id,
        message_id,
        activity_id,
        accepted_turn_id,
        client_correlation_id,
        accepted_at
      )
      SELECT
        NEW.sequence,
        json_extract(NEW.payload_json, '$.activity.payload.intentSequence'),
        NEW.stream_id,
        json_extract(NEW.payload_json, '$.activity.payload.messageId'),
        json_extract(NEW.payload_json, '$.activity.id'),
        json_extract(NEW.payload_json, '$.activity.turnId'),
        json_extract(NEW.payload_json, '$.activity.payload.clientCorrelationId'),
        json_extract(NEW.payload_json, '$.activity.createdAt')
      WHERE NEW.event_type = 'thread.activity-appended'
        AND NEW.actor_kind = 'server'
        AND json_extract(NEW.payload_json, '$.threadId') = NEW.stream_id
        AND json_extract(NEW.payload_json, '$.activity.kind') =
          'provider.turn.steer.accepted'
        AND json_type(NEW.payload_json, '$.activity.id') = 'text'
        AND json_type(NEW.payload_json, '$.activity.turnId') = 'text'
        AND json_type(NEW.payload_json, '$.activity.createdAt') = 'text'
        AND json_extract(NEW.payload_json, '$.activity.payload.provider') = 'codex'
        AND json_type(NEW.payload_json, '$.activity.payload.messageId') = 'text'
        AND json_extract(NEW.payload_json, '$.activity.payload.acceptedTurnId') =
          json_extract(NEW.payload_json, '$.activity.turnId')
        AND json_type(NEW.payload_json, '$.activity.payload.intentSequence') = 'integer'
        AND json_extract(NEW.payload_json, '$.activity.payload.intentSequence') >= 0
        AND json_extract(NEW.payload_json, '$.activity.payload.intentSequence') < NEW.sequence
        AND EXISTS (
          SELECT 1
          FROM orchestration_events AS intent
          WHERE intent.sequence =
              json_extract(NEW.payload_json, '$.activity.payload.intentSequence')
            AND intent.aggregate_kind = 'thread'
            AND intent.stream_id = NEW.stream_id
            AND intent.event_type IN (
              'thread.turn-start-requested',
              'thread.turn-steer-requested'
            )
            AND intent.actor_kind IN ('client', 'server')
            AND json_extract(intent.payload_json, '$.threadId') = NEW.stream_id
            AND json_extract(intent.payload_json, '$.messageId') =
              json_extract(NEW.payload_json, '$.activity.payload.messageId')
            AND json_extract(intent.payload_json, '$.createdAt') = intent.occurred_at
          LIMIT 1
        )
        AND (
          json_type(
            NEW.payload_json,
            '$.activity.payload.clientCorrelationId'
          ) IS NULL
          OR json_type(
            NEW.payload_json,
            '$.activity.payload.clientCorrelationId'
          ) IN ('text', 'null')
        )
      ON CONFLICT (sequence) DO NOTHING;

      DELETE FROM orchestration_unsettled_codex_steer_intents
      WHERE EXISTS (
        SELECT 1
        FROM orchestration_codex_steer_recovery_barriers AS barrier
        WHERE barrier.sequence = NEW.sequence
          AND barrier.sequence > orchestration_unsettled_codex_steer_intents.sequence
          AND barrier.thread_id = orchestration_unsettled_codex_steer_intents.thread_id
          AND (
            barrier.message_id = orchestration_unsettled_codex_steer_intents.message_id
            AND (
              barrier.candidate_sequence IS NULL
              OR barrier.candidate_sequence =
                orchestration_unsettled_codex_steer_intents.sequence
            )
          )
        LIMIT 1
      );

      -- Accepted recovery candidates remain only until exact trusted evidence
      -- proves the provider has processed or Cafe has recovered that accepted
      -- message. Interrupt/session-stop intentionally do not settle them.
      DELETE FROM orchestration_pending_codex_steer_acceptances
      WHERE EXISTS (
        SELECT 1
        FROM orchestration_codex_steer_recovery_barriers AS barrier
        WHERE barrier.sequence = NEW.sequence
          AND barrier.sequence > orchestration_pending_codex_steer_acceptances.sequence
          AND barrier.thread_id = orchestration_pending_codex_steer_acceptances.thread_id
          AND (
            (
              barrier.barrier_kind = 'provider.turn.steer.recovered'
              AND barrier.message_id =
                orchestration_pending_codex_steer_acceptances.message_id
              AND barrier.accepted_turn_id =
                orchestration_pending_codex_steer_acceptances.accepted_turn_id
              AND barrier.candidate_sequence =
                orchestration_pending_codex_steer_acceptances.intent_sequence
              AND barrier.client_correlation_id IS
                orchestration_pending_codex_steer_acceptances.client_correlation_id
            )
          )
        LIMIT 1
      );

      -- Once a thread's bounded legacy hydration has committed, every current
      -- event can update the compact candidate sets directly. Retaining its
      -- barrier history would make startup cost grow with application age.
      DELETE FROM orchestration_codex_steer_recovery_barriers
      WHERE sequence = NEW.sequence
        AND EXISTS (
          SELECT 1
          FROM orchestration_unsettled_codex_steer_hydration AS hydration
          WHERE hydration.thread_id = NEW.stream_id
          LIMIT 1
        );
    END
  `;
});
