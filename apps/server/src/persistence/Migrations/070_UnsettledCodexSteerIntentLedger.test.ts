import { MessageId, ThreadId, TurnId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  CodexSteerIntentLedgerInvariantError,
  LEGACY_CODEX_STEER_RECOVERY_TAIL_EVENTS,
  hydrateAndReadUnsettledCodexSteerIntents,
  hydrateLegacyUnsettledCodexSteerIntentsForThread,
  pruneSettledAcceptedCodexSteerRecoveryCandidate,
  readAcceptedCodexSteerRecoveryBarriers,
  readUnsettledCodexSteerIntents,
} from "../../orchestration/codexSteerIntentLedger.ts";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import Migration0070 from "./070_UnsettledCodexSteerIntentLedger.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

interface SequenceRow {
  readonly sequence: number;
}

interface CountRow {
  readonly count: number;
}

interface HydrationRow {
  readonly tailFloorSequence: number;
  readonly throughSequence: number;
}

interface QueryPlanRow {
  readonly detail: string;
}

layer("070_UnsettledCodexSteerIntentLedger", (it) => {
  it.effect("indexes new intents and exact outcomes without a historical migration scan", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-steer-ledger");
      const createdAt = "2026-08-31T03:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'legacy-steer',
            'thread',
            ${threadId},
            0,
            'thread.turn-steer-requested',
            ${createdAt},
            'legacy-command',
            NULL,
            'legacy-command',
            'client',
            ${JSON.stringify({
              threadId,
              messageId: "message-legacy-steer",
              expectedTurnId: "turn-legacy-steer",
              createdAt,
            })},
            '{}'
          ),
          (
            'legacy-accepted',
            'thread',
            ${threadId},
            1,
            'thread.activity-appended',
            ${createdAt},
            'legacy-accepted-command',
            NULL,
            'legacy-command',
            'server',
            ${JSON.stringify({
              threadId,
              activity: {
                id: "activity-legacy-accepted",
                kind: "provider.turn.steer.accepted",
                turnId: "turn-legacy-steer",
                createdAt,
                payload: {
                  provider: "codex",
                  messageId: "message-legacy-steer",
                  acceptedTurnId: "turn-legacy-steer",
                  clientCorrelationId: "correlation-legacy-steer",
                },
              },
            })},
            '{}'
          ),
          (
            'legacy-accepted-processed',
            'thread',
            ${threadId},
            2,
            'thread.activity-appended',
            ${createdAt},
            'legacy-accepted-processed-command',
            NULL,
            'legacy-command',
            'server',
            ${JSON.stringify({
              threadId,
              activity: {
                id: "activity-legacy-accepted-processed",
                kind: "provider.turn.steer.accepted",
                turnId: "turn-legacy-processed",
                createdAt,
                payload: {
                  provider: "codex",
                  messageId: "message-legacy-processed",
                  acceptedTurnId: "turn-legacy-processed",
                  clientCorrelationId: null,
                },
              },
            })},
            '{}'
          ),
          (
            'legacy-processing',
            'thread',
            ${threadId},
            3,
            'thread.activity-appended',
            ${createdAt},
            'legacy-processing-command',
            NULL,
            'legacy-command',
            'server',
            ${JSON.stringify({
              threadId,
              activity: {
                id: "activity-legacy-processing",
                kind: "task.progress",
                turnId: "turn-legacy-processed",
                createdAt,
                payload: {
                  taskId: "codex-turn-steer-processing:message-legacy-processed",
                  usage: { messageId: "message-legacy-processed" },
                },
              },
            })},
            '{}'
          ),
          (
            'legacy-accepted-recovered',
            'thread',
            ${threadId},
            4,
            'thread.activity-appended',
            ${createdAt},
            'legacy-accepted-recovered-command',
            NULL,
            'legacy-command',
            'server',
            ${JSON.stringify({
              threadId,
              activity: {
                id: "activity-legacy-accepted-recovered",
                kind: "provider.turn.steer.accepted",
                turnId: "turn-legacy-accepted-before-recovery",
                createdAt,
                payload: {
                  provider: "codex",
                  messageId: "message-legacy-recovered",
                  acceptedTurnId: "turn-legacy-accepted-before-recovery",
                  clientCorrelationId: "correlation-legacy-recovered",
                },
              },
            })},
            '{}'
          ),
          (
            'legacy-recovered',
            'thread',
            ${threadId},
            5,
            'thread.activity-appended',
            ${createdAt},
            'legacy-recovered-command',
            NULL,
            'legacy-command',
            'server',
            ${JSON.stringify({
              threadId,
              activity: {
                id: "activity-legacy-recovered",
                kind: "provider.turn.steer.recovered",
                turnId: "turn-legacy-recovered",
                createdAt,
                payload: {
                  provider: "codex",
                  messageId: "message-legacy-recovered",
                  acceptedTurnId: "turn-legacy-accepted-before-recovery",
                  recoveredTurnId: "turn-legacy-recovered",
                  clientCorrelationId: "correlation-legacy-recovered",
                },
              },
            })},
            '{}'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 70 });
      // Migration 70 records only the indexed right edge. It does not backfill
      // either compact table until an explicitly selected active thread asks.
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS "count"
          FROM orchestration_unsettled_codex_steer_intents
        `,
        [{ count: 0 }],
      );
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS "count"
          FROM orchestration_codex_steer_recovery_barriers
        `,
        [{ count: 0 }],
      );

      assert.deepStrictEqual(yield* hydrateAndReadUnsettledCodexSteerIntents(sql, [threadId]), []);
      assert.deepStrictEqual(yield* readAcceptedCodexSteerRecoveryBarriers(sql, [threadId]), [
        {
          sequence: 2,
          intentSequence: 1,
          intentCreatedAt: createdAt,
          threadId,
          activityId: "activity-legacy-accepted",
          acceptedTurnId: TurnId.make("turn-legacy-steer"),
          clientCorrelationId: "correlation-legacy-steer",
          messageId: MessageId.make("message-legacy-steer"),
          acceptedAt: createdAt,
        },
      ]);

      const postMigrationCreatedAt = "2026-08-31T03:01:00.000Z";
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'post-migration-steer',
          'thread',
          ${threadId},
          6,
          'thread.turn-steer-requested',
          ${postMigrationCreatedAt},
          'post-migration-command',
          NULL,
          'post-migration-command',
          'client',
          ${JSON.stringify({
            threadId,
            messageId: "message-post-migration",
            expectedTurnId: "turn-post-migration",
            createdAt: postMigrationCreatedAt,
          })},
          '{}'
        )
      `;
      const [postMigrationEvent] = yield* sql<SequenceRow>`
        SELECT sequence
        FROM orchestration_events
        WHERE event_id = 'post-migration-steer'
      `;
      assert.isDefined(postMigrationEvent);
      assert.deepStrictEqual(yield* readUnsettledCodexSteerIntents(sql, [threadId]), [
        {
          sequence: postMigrationEvent!.sequence,
          threadId,
          messageId: MessageId.make("message-post-migration"),
          expectedTurnId: TurnId.make("turn-post-migration"),
          createdAt: postMigrationCreatedAt,
        },
      ]);

      // A provider-authored lookalike cannot supersede the authenticated
      // candidate even though every other payload field matches.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'forged-provider-start',
          'thread',
          ${threadId},
          7,
          'thread.turn-start-requested',
          ${postMigrationCreatedAt},
          'forged-provider-command',
          NULL,
          'forged-provider-command',
          'provider',
          ${JSON.stringify({
            threadId,
            messageId: "message-post-migration",
            createdAt: postMigrationCreatedAt,
          })},
          '{}'
        )
      `;
      assert.lengthOf(yield* readUnsettledCodexSteerIntents(sql, [threadId]), 1);

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'post-migration-attempted',
          'thread',
          ${threadId},
          8,
          'thread.activity-appended',
          ${postMigrationCreatedAt},
          'post-migration-attempted-command',
          NULL,
          'post-migration-command',
          'server',
          ${JSON.stringify({
            threadId,
            activity: {
              id: "activity-post-migration-attempted",
              kind: "provider.turn.steer.delivery-attempted",
              turnId: "turn-post-migration",
              createdAt: postMigrationCreatedAt,
              payload: {
                provider: "codex",
                messageId: "message-post-migration",
                intentSequence: postMigrationEvent!.sequence,
                delivery: "live-steer",
                deliveryState: "attempted",
                reason: "live-steer",
                expectedTurnId: "turn-post-migration",
              },
            },
          })},
          '{}'
        )
      `;
      assert.deepStrictEqual(yield* readUnsettledCodexSteerIntents(sql, [threadId]), []);

      // Append-time accepted candidates are removed by exact processing and
      // recovery evidence rather than accumulating as historical barriers.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        )
        VALUES
          (
            'post-migration-processing-intent', 'thread', ${threadId}, 9,
            'thread.turn-steer-requested', ${postMigrationCreatedAt},
            'post-migration-processing-intent-command', NULL, NULL, 'client',
            ${JSON.stringify({
              threadId,
              messageId: "message-post-migration-processed",
              expectedTurnId: "turn-post-migration-processed",
              createdAt: postMigrationCreatedAt,
            })},
            '{}'
          ),
          (
            'post-migration-recovered-intent', 'thread', ${threadId}, 10,
            'thread.turn-steer-requested', ${postMigrationCreatedAt},
            'post-migration-recovered-intent-command', NULL, NULL, 'client',
            ${JSON.stringify({
              threadId,
              messageId: "message-post-migration-recovered",
              expectedTurnId: "turn-post-migration-accepted-before-recovery",
              createdAt: postMigrationCreatedAt,
            })},
            '{}'
          )
      `;
      const [processedIntent] = yield* sql<SequenceRow>`
        SELECT sequence FROM orchestration_events
        WHERE event_id = 'post-migration-processing-intent'
      `;
      const [recoveredIntent] = yield* sql<SequenceRow>`
        SELECT sequence FROM orchestration_events
        WHERE event_id = 'post-migration-recovered-intent'
      `;
      assert.isDefined(processedIntent);
      assert.isDefined(recoveredIntent);
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES
          (
            'post-migration-accepted-processed', 'thread', ${threadId}, 11,
            'thread.activity-appended', ${postMigrationCreatedAt},
            'post-migration-accepted-processed-command', NULL, NULL, 'server',
            ${JSON.stringify({
              threadId,
              activity: {
                id: "activity-post-migration-accepted-processed",
                kind: "provider.turn.steer.accepted",
                turnId: "turn-post-migration-processed",
                createdAt: postMigrationCreatedAt,
                payload: {
                  provider: "codex",
                  messageId: "message-post-migration-processed",
                  acceptedTurnId: "turn-post-migration-processed",
                  intentSequence: processedIntent!.sequence,
                  clientCorrelationId: "correlation-post-migration-processed",
                },
              },
            })},
            '{}'
          ),
          (
            'post-migration-processing', 'thread', ${threadId}, 12,
            'thread.activity-appended', ${postMigrationCreatedAt},
            'provider:post-migration-processing-command', NULL, NULL, 'provider',
            ${JSON.stringify({
              threadId,
              activity: {
                id: "activity-post-migration-processing",
                kind: "task.progress",
                turnId: "turn-post-migration-processed",
                createdAt: postMigrationCreatedAt,
                payload: {
                  taskId: "codex-turn-steer-processing:correlation-post-migration-processed",
                  usage: {
                    clientCorrelationId: "correlation-post-migration-processed",
                    messageId: "message-post-migration-processed",
                  },
                },
              },
            })},
            '{}'
          ),
          (
            'post-migration-accepted-recovered', 'thread', ${threadId}, 13,
            'thread.activity-appended', ${postMigrationCreatedAt},
            'post-migration-accepted-recovered-command', NULL, NULL, 'server',
            ${JSON.stringify({
              threadId,
              activity: {
                id: "activity-post-migration-accepted-recovered",
                kind: "provider.turn.steer.accepted",
                turnId: "turn-post-migration-accepted-before-recovery",
                createdAt: postMigrationCreatedAt,
                payload: {
                  provider: "codex",
                  messageId: "message-post-migration-recovered",
                  acceptedTurnId: "turn-post-migration-accepted-before-recovery",
                  intentSequence: recoveredIntent!.sequence,
                  clientCorrelationId: "correlation-post-migration-recovered",
                },
              },
            })},
            '{}'
          ),
          (
            'post-migration-recovered', 'thread', ${threadId}, 14,
            'thread.activity-appended', ${postMigrationCreatedAt},
            'post-migration-recovered-command', NULL, NULL, 'server',
            ${JSON.stringify({
              threadId,
              activity: {
                id: "activity-post-migration-recovered",
                kind: "provider.turn.steer.recovered",
                turnId: "turn-post-migration-recovered",
                createdAt: postMigrationCreatedAt,
                payload: {
                  provider: "codex",
                  messageId: "message-post-migration-recovered",
                  acceptedTurnId: "turn-post-migration-accepted-before-recovery",
                  recoveredTurnId: "turn-post-migration-recovered",
                  intentSequence: recoveredIntent!.sequence,
                  clientCorrelationId: "correlation-post-migration-recovered",
                },
              },
            })},
            '{}'
          )
      `;
      const acceptedBeforeVerifiedPrune = yield* readAcceptedCodexSteerRecoveryBarriers(sql, [
        threadId,
      ]);
      const processedCandidate = acceptedBeforeVerifiedPrune.find(
        (candidate) => candidate.activityId === "activity-post-migration-accepted-processed",
      );
      assert.isDefined(processedCandidate);
      // Production calls this only after its exact projection/evidence query
      // verifies the provider-authored progress against Cafe's derived token.
      yield* pruneSettledAcceptedCodexSteerRecoveryCandidate(sql, processedCandidate!);
      const survivingAccepted = yield* readAcceptedCodexSteerRecoveryBarriers(sql, [threadId]);
      assert.deepStrictEqual(
        survivingAccepted.map((candidate) => candidate.activityId),
        ["activity-legacy-accepted"],
      );
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM orchestration_codex_steer_recovery_barriers
          WHERE thread_id = ${threadId}
        `,
        [{ count: 0 }],
      );

      // Barrier retention is a bounded pre-hydration race buffer, not an
      // append-only copy of every provider's turn history. An already
      // hydrated Codex thread, a non-Codex thread, and a Codex thread created
      // after the migration cutoff must retain no unrelated start barrier.
      const nonCodexThreadId = ThreadId.make("thread-non-codex-barrier");
      const newCodexThreadId = ThreadId.make("thread-new-codex-barrier");
      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id,
          provider_thread_id, active_turn_id, last_error, updated_at
        ) VALUES (
          ${newCodexThreadId}, 'idle', 'codex', NULL, NULL, NULL, NULL,
          ${postMigrationCreatedAt}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        ) VALUES
          (
            'hydrated-unrelated-start', 'thread', ${threadId}, 15,
            'thread.turn-start-requested', ${postMigrationCreatedAt},
            'hydrated-unrelated-start-command', NULL, NULL, 'client',
            ${JSON.stringify({
              threadId,
              messageId: "message-hydrated-unrelated",
              createdAt: postMigrationCreatedAt,
            })}, '{}'
          ),
          (
            'non-codex-unrelated-start', 'thread', ${nonCodexThreadId}, 0,
            'thread.turn-start-requested', ${postMigrationCreatedAt},
            'non-codex-unrelated-start-command', NULL, NULL, 'client',
            ${JSON.stringify({
              threadId: nonCodexThreadId,
              messageId: "message-non-codex-unrelated",
              createdAt: postMigrationCreatedAt,
            })}, '{}'
          ),
          (
            'new-codex-unrelated-start', 'thread', ${newCodexThreadId}, 0,
            'thread.turn-start-requested', ${postMigrationCreatedAt},
            'new-codex-unrelated-start-command', NULL, NULL, 'client',
            ${JSON.stringify({
              threadId: newCodexThreadId,
              messageId: "message-new-codex-unrelated",
              createdAt: postMigrationCreatedAt,
            })}, '{}'
          )
      `;
      assert.deepStrictEqual(
        yield* sql<CountRow>`
          SELECT COUNT(*) AS count
          FROM orchestration_codex_steer_recovery_barriers
          WHERE thread_id IN (${threadId}, ${nonCodexThreadId}, ${newCodexThreadId})
        `,
        [{ count: 0 }],
      );

      const candidatePlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT sequence
        FROM orchestration_unsettled_codex_steer_intents
        WHERE thread_id = ${threadId}
        ORDER BY sequence ASC
      `;
      const acceptedPlan = yield* sql<QueryPlanRow>`
        EXPLAIN QUERY PLAN
        SELECT sequence
        FROM orchestration_pending_codex_steer_acceptances
        WHERE thread_id = ${threadId}
        ORDER BY sequence ASC
      `;
      assert.match(
        candidatePlan.map((row) => row.detail).join("\n"),
        /idx_unsettled_codex_steer_thread_sequence/,
      );
      assert.match(
        acceptedPlan.map((row) => row.detail).join("\n"),
        /idx_pending_codex_steer_acceptance_thread_sequence/,
      );
    }),
  );

  it.effect(
    "keeps legacy recovery and progress settlement bound to the exact intent generation",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-legacy-generation-fence");
        const intentAt = "2026-08-31T04:00:00.000Z";
        let streamVersion = 0;
        const append = (input: {
          readonly eventId: string;
          readonly eventType: string;
          readonly occurredAt: string;
          readonly actorKind: "client" | "server" | "provider";
          readonly payload: Readonly<Record<string, unknown>>;
        }) =>
          Effect.gen(function* () {
            yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
              command_id, causation_event_id, correlation_id, actor_kind, payload_json,
              metadata_json
            ) VALUES (
              ${input.eventId}, 'thread', ${threadId}, ${streamVersion}, ${input.eventType},
              ${input.occurredAt}, ${`command:${input.eventId}`}, NULL, NULL,
              ${input.actorKind}, ${JSON.stringify(input.payload)}, '{}'
            )
          `;
            streamVersion += 1;
            const [row] = yield* sql<SequenceRow>`
            SELECT sequence FROM orchestration_events WHERE event_id = ${input.eventId}
          `;
            assert.isDefined(row);
            return row.sequence;
          });
        const intentPayload = (messageId: string, createdAt: string) => ({
          threadId,
          messageId,
          expectedTurnId: "turn-legacy-generation-fence",
          createdAt,
        });
        const acceptedPayload = (
          messageId: string,
          intentSequence: number,
          activityId: string,
        ) => ({
          threadId,
          activity: {
            id: activityId,
            kind: "provider.turn.steer.accepted",
            turnId: "turn-legacy-generation-fence",
            createdAt: intentAt,
            payload: {
              provider: "codex",
              messageId,
              acceptedTurnId: "turn-legacy-generation-fence",
              intentSequence,
              clientCorrelationId: `correlation:${messageId}`,
            },
          },
        });

        yield* runMigrations({ toMigrationInclusive: 69 });
        const reusedMessageId = "message-legacy-reused-recovery";
        const firstIntentSequence = yield* append({
          eventId: "legacy-reused-intent-first",
          eventType: "thread.turn-steer-requested",
          occurredAt: intentAt,
          actorKind: "client",
          payload: intentPayload(reusedMessageId, intentAt),
        });
        yield* append({
          eventId: "legacy-reused-accepted-first",
          eventType: "thread.activity-appended",
          occurredAt: intentAt,
          actorKind: "server",
          payload: acceptedPayload(
            reusedMessageId,
            firstIntentSequence,
            "activity-legacy-reused-accepted-first",
          ),
        });
        const secondIntentSequence = yield* append({
          eventId: "legacy-reused-intent-second",
          eventType: "thread.turn-steer-requested",
          occurredAt: intentAt,
          actorKind: "client",
          payload: intentPayload(reusedMessageId, intentAt),
        });
        yield* append({
          eventId: "legacy-reused-accepted-second",
          eventType: "thread.activity-appended",
          occurredAt: intentAt,
          actorKind: "server",
          payload: acceptedPayload(
            reusedMessageId,
            secondIntentSequence,
            "activity-legacy-reused-accepted-second",
          ),
        });
        yield* append({
          eventId: "legacy-reused-recovered-first-delayed",
          eventType: "thread.activity-appended",
          occurredAt: "2026-08-31T04:00:02.000Z",
          actorKind: "server",
          payload: {
            threadId,
            activity: {
              id: "activity-legacy-reused-recovered-first-delayed",
              kind: "provider.turn.steer.recovered",
              turnId: "turn-legacy-recovered-first",
              createdAt: "2026-08-31T04:00:02.000Z",
              payload: {
                provider: "codex",
                messageId: reusedMessageId,
                acceptedTurnId: "turn-legacy-generation-fence",
                recoveredTurnId: "turn-legacy-recovered-first",
                intentSequence: firstIntentSequence,
                clientCorrelationId: `correlation:${reusedMessageId}`,
              },
            },
          },
        });

        const staleProgressMessageId = "message-legacy-stale-progress";
        const staleProgressIntentAt = "2026-08-31T04:01:00.000Z";
        const staleProgressIntentSequence = yield* append({
          eventId: "legacy-stale-progress-intent",
          eventType: "thread.turn-steer-requested",
          occurredAt: staleProgressIntentAt,
          actorKind: "client",
          payload: intentPayload(staleProgressMessageId, staleProgressIntentAt),
        });
        yield* append({
          eventId: "legacy-stale-progress-accepted",
          eventType: "thread.activity-appended",
          occurredAt: staleProgressIntentAt,
          actorKind: "server",
          payload: acceptedPayload(
            staleProgressMessageId,
            staleProgressIntentSequence,
            "activity-legacy-stale-progress-accepted",
          ),
        });
        yield* append({
          eventId: "legacy-stale-progress-delayed",
          eventType: "thread.activity-appended",
          occurredAt: "2026-08-31T04:01:01.000Z",
          actorKind: "provider",
          payload: {
            threadId,
            activity: {
              id: "activity-legacy-stale-progress-delayed",
              kind: "task.progress",
              turnId: "turn-legacy-generation-fence",
              // The event arrived later, but the provider observation was made
              // before this intent and cannot settle its recovery authority.
              createdAt: "2026-08-31T03:59:59.000Z",
              payload: {
                taskId: `codex-turn-steer-processing:correlation:${staleProgressMessageId}`,
                usage: {
                  clientCorrelationId: `correlation:${staleProgressMessageId}`,
                  messageId: staleProgressMessageId,
                },
              },
            },
          },
        });

        const deliveryMessageId = "message-legacy-delivery-generation";
        const deliveryFirstSequence = yield* append({
          eventId: "legacy-delivery-intent-first",
          eventType: "thread.turn-steer-requested",
          occurredAt: intentAt,
          actorKind: "client",
          payload: intentPayload(deliveryMessageId, intentAt),
        });
        const deliverySecondSequence = yield* append({
          eventId: "legacy-delivery-intent-second",
          eventType: "thread.turn-steer-requested",
          occurredAt: intentAt,
          actorKind: "client",
          payload: intentPayload(deliveryMessageId, intentAt),
        });
        yield* append({
          eventId: "legacy-delivery-first-delayed",
          eventType: "thread.activity-appended",
          occurredAt: "2026-08-31T04:02:00.000Z",
          actorKind: "server",
          payload: {
            threadId,
            activity: {
              id: "activity-legacy-delivery-first-delayed",
              kind: "provider.turn.steer.delivered",
              turnId: "turn-legacy-delivered-first",
              createdAt: "2026-08-31T04:02:00.000Z",
              payload: {
                provider: "codex",
                messageId: deliveryMessageId,
                deliveredTurnId: "turn-legacy-delivered-first",
                intentSequence: deliveryFirstSequence,
                delivery: "next-turn",
                reason: "turn-start-after-provider-no-active-turn",
              },
            },
          },
        });

        const forgedAcceptanceMessageId = "message-legacy-forged-acceptance";
        const forgedAcceptanceIntentSequence = yield* append({
          eventId: "legacy-forged-acceptance-intent",
          eventType: "thread.turn-steer-requested",
          occurredAt: intentAt,
          actorKind: "client",
          payload: intentPayload(forgedAcceptanceMessageId, intentAt),
        });
        yield* append({
          eventId: "legacy-forged-provider-acceptance",
          eventType: "thread.activity-appended",
          occurredAt: "2026-08-31T04:03:00.000Z",
          actorKind: "provider",
          payload: acceptedPayload(
            forgedAcceptanceMessageId,
            forgedAcceptanceIntentSequence,
            "activity-legacy-forged-provider-acceptance",
          ),
        });

        yield* runMigrations({ toMigrationInclusive: 70 });
        const unsettled = yield* hydrateAndReadUnsettledCodexSteerIntents(sql, [threadId]);
        assert.deepStrictEqual(
          (yield* readAcceptedCodexSteerRecoveryBarriers(sql, [threadId])).map((row) => ({
            activityId: row.activityId,
            intentSequence: row.intentSequence,
          })),
          [
            {
              activityId: "activity-legacy-reused-accepted-second",
              intentSequence: secondIntentSequence,
            },
            {
              activityId: "activity-legacy-stale-progress-accepted",
              intentSequence: staleProgressIntentSequence,
            },
          ],
        );
        assert.deepStrictEqual(unsettled, [
          {
            sequence: deliverySecondSequence,
            threadId,
            messageId: MessageId.make(deliveryMessageId),
            expectedTurnId: TurnId.make("turn-legacy-generation-fence"),
            createdAt: intentAt,
          },
          {
            sequence: forgedAcceptanceIntentSequence,
            threadId,
            messageId: MessageId.make(forgedAcceptanceMessageId),
            expectedTurnId: TurnId.make("turn-legacy-generation-fence"),
            createdAt: intentAt,
          },
        ]);
      }),
  );

  it.effect("hydrates only the fixed recent per-thread tail and yields between threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const oldThreadId = ThreadId.make("thread-old-steer-tail");
      const recentThreadId = ThreadId.make("thread-recent-steer-tail");
      const pagedThreadId = ThreadId.make("thread-paged-steer-tail");
      const createdAt = "2026-08-31T03:10:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 69 });
      // The suite shares one in-memory layer. Remove the prior case's compact
      // projection and trigger so these rows genuinely model a pre-70 journal,
      // then invoke the migration effect directly after seeding.
      yield* sql`DROP TRIGGER IF EXISTS trg_orchestration_unsettled_codex_steer_event`;
      yield* sql`DELETE FROM orchestration_unsettled_codex_steer_hydration`;
      yield* sql`DELETE FROM orchestration_unsettled_codex_steer_intents`;
      yield* sql`DELETE FROM orchestration_codex_steer_recovery_barriers`;
      yield* sql`DELETE FROM orchestration_pending_codex_steer_acceptances`;
      yield* sql`DELETE FROM orchestration_unsettled_codex_steer_state`;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'too-old-steer',
          'thread',
          ${oldThreadId},
          0,
          'thread.turn-steer-requested',
          ${createdAt},
          'too-old-command',
          NULL,
          'too-old-command',
          'client',
          ${JSON.stringify({
            threadId: oldThreadId,
            messageId: "message-too-old",
            expectedTurnId: "turn-too-old",
            createdAt,
          })},
          '{}'
        )
      `;
      yield* sql`
        WITH RECURSIVE counter(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM counter WHERE value < 65
        )
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        SELECT
          'paged-tail-intent-' || value,
          'thread',
          ${pagedThreadId},
          value - 1,
          'thread.turn-start-requested',
          ${createdAt},
          'paged-tail-command-' || value,
          NULL,
          'paged-tail-command-' || value,
          'client',
          json_object(
            'threadId', ${pagedThreadId},
            'messageId', 'paged-tail-message-' || value
          ),
          '{}'
        FROM counter
      `;
      yield* sql`
        WITH RECURSIVE counter(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1
          FROM counter
          WHERE value <= ${LEGACY_CODEX_STEER_RECOVERY_TAIL_EVENTS}
        )
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        SELECT
          'old-tail-filler-' || value,
          'thread',
          ${oldThreadId},
          value,
          'thread.context-window-updated',
          ${createdAt},
          NULL,
          NULL,
          NULL,
          'server',
          '{}',
          '{}'
        FROM counter
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'recent-tail-steer',
          'thread',
          ${recentThreadId},
          0,
          'thread.turn-steer-requested',
          ${createdAt},
          'recent-tail-command',
          NULL,
          'recent-tail-command',
          'client',
          ${JSON.stringify({
            threadId: recentThreadId,
            messageId: "message-recent-tail",
            expectedTurnId: null,
            createdAt,
          })},
          '{}'
        )
      `;
      const [recentEvent] = yield* sql<SequenceRow>`
        SELECT sequence
        FROM orchestration_events
        WHERE event_id = 'recent-tail-steer'
      `;
      assert.isDefined(recentEvent);
      yield* Migration0070;

      let eventLoopAdvanced = false;
      setImmediate(() => {
        eventLoopAdvanced = true;
      });
      const [migrationState] = yield* sql<{ readonly cutoff: number }>`
        SELECT legacy_cutoff_sequence AS cutoff
        FROM orchestration_unsettled_codex_steer_state
        WHERE singleton_id = 1
      `;
      assert.isDefined(migrationState);
      yield* hydrateLegacyUnsettledCodexSteerIntentsForThread(
        sql,
        pagedThreadId,
        migrationState!.cutoff,
      );
      assert.isTrue(eventLoopAdvanced);

      eventLoopAdvanced = false;
      setImmediate(() => {
        eventLoopAdvanced = true;
      });
      const candidates = yield* hydrateAndReadUnsettledCodexSteerIntents(sql, [
        oldThreadId,
        recentThreadId,
      ]);
      assert.isTrue(eventLoopAdvanced);
      assert.deepStrictEqual(candidates, [
        {
          sequence: recentEvent!.sequence,
          threadId: recentThreadId,
          messageId: MessageId.make("message-recent-tail"),
          expectedTurnId: null,
          createdAt,
        },
      ]);

      const hydration = yield* sql<HydrationRow>`
        SELECT
          tail_floor_sequence AS "tailFloorSequence",
          through_sequence AS "throughSequence"
        FROM orchestration_unsettled_codex_steer_hydration
        WHERE thread_id = ${oldThreadId}
      `;
      assert.lengthOf(hydration, 1);
      assert.isAbove(hydration[0]!.tailFloorSequence, 1);
      const [hydratedEventCount] = yield* sql<CountRow>`
        SELECT COUNT(*) AS "count"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${oldThreadId}
          AND sequence >= ${hydration[0]!.tailFloorSequence}
          AND sequence <= ${hydration[0]!.throughSequence}
      `;
      assert.isAtMost(hydratedEventCount!.count, LEGACY_CODEX_STEER_RECOVERY_TAIL_EVENTS);
    }),
  );

  it.effect("fails closed for corrupt migration or candidate authority", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-corrupt-steer-ledger");
      const createdAt = "2026-08-31T03:20:00.000Z";
      yield* runMigrations({ toMigrationInclusive: 70 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'corrupt-ledger-steer',
          'thread',
          ${threadId},
          0,
          'thread.turn-steer-requested',
          ${createdAt},
          'corrupt-ledger-command',
          NULL,
          'corrupt-ledger-command',
          'client',
          ${JSON.stringify({
            threadId,
            messageId: "message-corrupt-ledger",
            expectedTurnId: null,
            createdAt,
          })},
          '{}'
        )
      `;
      yield* sql`
        UPDATE orchestration_unsettled_codex_steer_intents
        SET message_id = 'tampered-message-id'
        WHERE thread_id = ${threadId}
      `;
      const mismatch = yield* Effect.flip(readUnsettledCodexSteerIntents(sql, [threadId]));
      assert.instanceOf(mismatch, CodexSteerIntentLedgerInvariantError);
      assert.equal(mismatch.issue, "candidate-event-mismatch");

      yield* sql`
        DELETE FROM orchestration_unsettled_codex_steer_state
        WHERE singleton_id = 1
      `;
      const missingState = yield* Effect.flip(
        hydrateAndReadUnsettledCodexSteerIntents(sql, [threadId]),
      );
      assert.instanceOf(missingState, CodexSteerIntentLedgerInvariantError);
      assert.equal(missingState.issue, "missing-migration-state");
    }),
  );
});

const migration66ConvergenceLayer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

migration66ConvergenceLayer("070_Migration66IndexConvergence", (it) => {
  it.effect("removes retired migration-66 JSON indexes from already-upgraded databases", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 69 });
      // Simulate the exact schema left by the original migration 66 source.
      // Its durable migration row already exists, so only a later migration
      // can converge the database after migration 66 becomes a no-op.
      yield* sql`
        CREATE INDEX idx_orch_events_thread_message_identity
        ON orchestration_events(
          stream_id,
          json_extract(payload_json, '$.messageId'),
          sequence DESC
        )
        WHERE aggregate_kind = 'thread'
          AND event_type = 'thread.message-sent'
      `;
      yield* sql`
        CREATE INDEX idx_orch_events_thread_activity_message_identity
        ON orchestration_events(
          stream_id,
          json_extract(payload_json, '$.activity.payload.messageId'),
          sequence DESC
        )
        WHERE aggregate_kind = 'thread'
          AND event_type = 'thread.activity-appended'
      `;

      yield* runMigrations({ toMigrationInclusive: 70 });

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orch_events_thread_message_identity',
            'idx_orch_events_thread_activity_message_identity'
          )
        ORDER BY name ASC
      `;
      assert.deepStrictEqual(indexes, []);
    }),
  );
});
