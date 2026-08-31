import { MessageId, ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  hydrateLegacyMessageIdentitiesForThread,
  readLatestMessageIdentity,
} from "../../orchestration/messageIdentityLedger.ts";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

interface IdentityRow {
  readonly messageId: string;
  readonly firstSequence: number;
  readonly latestSequence: number;
}

layer("068_OrchestrationMessageIdentityLedger", (it) => {
  it.effect("records new identities atomically and lazily hydrates legacy thread rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-message-ledger-upgrade");

      yield* runMigrations({ toMigrationInclusive: 67 });
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
          'event-legacy-message',
          'thread',
          ${threadId},
          0,
          'thread.message-sent',
          '2026-08-31T00:00:00.000Z',
          'command-legacy-message',
          NULL,
          NULL,
          'client',
          ${JSON.stringify({
            threadId,
            messageId: "message-legacy",
            role: "user",
            text: "legacy",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
          })},
          '{}'
        )
      `;
      const [legacyEvent] = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE event_id = 'event-legacy-message'
      `;

      yield* runMigrations({ toMigrationInclusive: 68 });

      const [state] = yield* sql<{ readonly cutoff: number }>`
        SELECT legacy_cutoff_sequence AS cutoff
        FROM orchestration_message_identity_state
        WHERE singleton_id = 1
      `;
      assert.equal(state?.cutoff, legacyEvent?.sequence);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_message_identities`, []);

      yield* hydrateLegacyMessageIdentitiesForThread(sql, threadId);
      assert.deepStrictEqual(
        yield* sql<IdentityRow>`
        SELECT
          message_id AS "messageId",
          first_sequence AS "firstSequence",
          latest_sequence AS "latestSequence"
        FROM orchestration_message_identities
      `,
        [
          {
            messageId: "message-legacy",
            firstSequence: legacyEvent!.sequence,
            latestSequence: legacyEvent!.sequence,
          },
        ],
      );

      // The trigger covers every post-migration generation without a scan.
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
          'event-new-message',
          'thread',
          ${threadId},
          1,
          'thread.message-sent',
          '2026-08-31T00:00:01.000Z',
          'command-new-message',
          NULL,
          NULL,
          'client',
          ${JSON.stringify({
            threadId,
            messageId: "message-new",
            role: "user",
            text: "new",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-08-31T00:00:01.000Z",
            updatedAt: "2026-08-31T00:00:01.000Z",
          })},
          '{}'
        )
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
          'event-new-message-retry',
          'thread',
          ${threadId},
          2,
          'thread.message-sent',
          '2026-08-31T00:00:02.000Z',
          'command-new-message-retry',
          NULL,
          NULL,
          'server',
          ${JSON.stringify({
            threadId,
            messageId: "message-new",
            role: "user",
            text: "new",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-08-31T00:00:02.000Z",
            updatedAt: "2026-08-31T00:00:02.000Z",
          })},
          '{}'
        )
      `;

      const identities = yield* sql<IdentityRow>`
        SELECT
          message_id AS "messageId",
          first_sequence AS "firstSequence",
          latest_sequence AS "latestSequence"
        FROM orchestration_message_identities
        ORDER BY message_id ASC
      `;
      assert.equal(identities.length, 2);
      const newIdentity = identities.find((identity) => identity.messageId === "message-new");
      assert.ok(newIdentity);
      assert.ok(newIdentity.latestSequence > newIdentity.firstSequence);
      const cutoff = state!.cutoff;

      const [hydration] = yield* sql<{ readonly throughSequence: number }>`
        SELECT through_sequence AS "throughSequence"
        FROM orchestration_message_identity_hydration
        WHERE thread_id = ${threadId}
      `;
      assert.equal(hydration?.throughSequence, legacyEvent?.sequence);

      // A present compact row does not bypass singleton or hydration
      // authority validation. These checks are intentionally before event
      // tampering so each failure is attributable to the state invariant.
      yield* sql`DELETE FROM orchestration_message_identity_state WHERE singleton_id = 1`;
      const presentMissingState = yield* Effect.flip(
        readLatestMessageIdentity(sql, {
          threadId,
          messageId: MessageId.make("message-new"),
        }),
      );
      assert.equal(presentMissingState._tag, "MessageIdentityLedgerInvariantError");
      if (presentMissingState._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(presentMissingState.issue, "missing-migration-state");
      }
      yield* sql`
        INSERT INTO orchestration_message_identity_state (
          singleton_id,
          legacy_cutoff_sequence
        ) VALUES (1, ${cutoff})
      `;
      yield* sql`
        UPDATE orchestration_message_identity_hydration
        SET through_sequence = 0.5
        WHERE thread_id = ${threadId}
      `;
      const presentInvalidHydration = yield* Effect.flip(
        readLatestMessageIdentity(sql, {
          threadId,
          messageId: MessageId.make("message-new"),
        }),
      );
      assert.equal(presentInvalidHydration._tag, "MessageIdentityLedgerInvariantError");
      if (presentInvalidHydration._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(presentInvalidHydration.issue, "invalid-hydration-state");
      }
      yield* sql`
        UPDATE orchestration_message_identity_hydration
        SET through_sequence = ${legacyEvent!.sequence}
        WHERE thread_id = ${threadId}
      `;

      // The compact pointer is not authoritative by itself. If its referenced
      // event is later corrupted, identity admission must fail closed instead
      // of treating the MessageId as available for reuse.
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = '{"messageId":"message-tampered","role":"user","text":"new","attachments":[]}'
        WHERE event_id = 'event-new-message-retry'
      `;
      const mismatch = yield* Effect.flip(
        readLatestMessageIdentity(sql, {
          threadId,
          messageId: MessageId.make("message-new"),
        }),
      );
      assert.equal(mismatch._tag, "MessageIdentityLedgerInvariantError");
      if (mismatch._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(mismatch.issue, "identity-event-mismatch");
      }

      // Missing or malformed migration state must likewise block legacy
      // admission. A zero fallback would silently bypass all historical ids.
      yield* sql`DELETE FROM orchestration_message_identity_state WHERE singleton_id = 1`;
      const missingState = yield* Effect.flip(
        hydrateLegacyMessageIdentitiesForThread(sql, threadId),
      );
      assert.equal(missingState._tag, "MessageIdentityLedgerInvariantError");
      if (missingState._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(missingState.issue, "missing-migration-state");
      }
      yield* sql`
        INSERT INTO orchestration_message_identity_state (
          singleton_id,
          legacy_cutoff_sequence
        ) VALUES (1, ${cutoff})
      `;
      yield* sql`
        UPDATE orchestration_message_identity_state
        SET legacy_cutoff_sequence = 0.5
        WHERE singleton_id = 1
      `;
      const invalidState = yield* Effect.flip(
        hydrateLegacyMessageIdentitiesForThread(sql, threadId),
      );
      assert.equal(invalidState._tag, "MessageIdentityLedgerInvariantError");
      if (invalidState._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(invalidState.issue, "invalid-migration-state");
      }
    }),
  );
});

const multiPageLayer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

multiPageLayer("068 legacy hydration scheduling", (it) => {
  it.effect("crosses the Node event loop between bounded legacy pages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-multi-page-hydration");

      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`
        WITH RECURSIVE event_number(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM event_number WHERE value < 513
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
          'event-legacy-page-' || value,
          'thread',
          ${threadId},
          value - 1,
          'thread.message-sent',
          '2026-08-31T00:00:00.000Z',
          'command-legacy-page-' || value,
          NULL,
          NULL,
          'client',
          json_object(
            'threadId', ${threadId},
            'messageId', 'message-legacy-page-' || value,
            'role', 'user',
            'text', 'legacy',
            'attachments', json('[]'),
            'turnId', NULL,
            'streaming', json('false'),
            'createdAt', '2026-08-31T00:00:00.000Z',
            'updatedAt', '2026-08-31T00:00:00.000Z'
          ),
          '{}'
        FROM event_number
      `;
      yield* runMigrations({ toMigrationInclusive: 68 });

      let eventLoopAdvanced = false;
      const probe = setImmediate(() => {
        eventLoopAdvanced = true;
      });
      try {
        yield* hydrateLegacyMessageIdentitiesForThread(sql, threadId);
      } finally {
        clearImmediate(probe);
      }

      assert.isTrue(eventLoopAdvanced);
      const [count] = yield* sql<{ readonly value: number }>`
        SELECT COUNT(*) AS value
        FROM orchestration_message_identities
        WHERE thread_id = ${threadId}
      `;
      assert.equal(count?.value, 513);
    }),
  );
});
