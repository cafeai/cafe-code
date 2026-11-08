import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

// These are deliberately historical fixture bytes, including malformed fields
// and JSON whitespace. They enter the real 104-era activity table and its
// normalized-pointer triggers; the fixture never manufactures a binding row.
const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const at = "2026-11-03T00:00:00.000Z";
const runtimeId = "10000000-0000-4000-8000-000000000105";
const foreignRuntimeId = "20000000-0000-4000-8000-000000000105";

function insertLaterStart(
  sql: SqlClient.SqlClient,
  activityId: string,
  turnId: string,
  payloadJson: string,
  sequence: number,
) {
  return sql`
    INSERT INTO projection_thread_activities(
      activity_id, thread_id, turn_id, tone, kind, summary,
      payload_json, created_at, sequence
    ) VALUES (
      ${activityId}, 'c-later-starts', ${turnId}, 'info', 'task.started',
      'Historical native start', ${payloadJson}, ${at}, ${sequence}
    )
  `;
}

it.effect(
  "backfills later qualified bindings and NULL owners after complete tombstoned and malformed pointer pages",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 104 });
      yield* sql`
        INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
        VALUES
          ('a-tombstoned-starts', NULL, 'Historical retired thread', ${at}, ${at}),
          ('b-malformed-starts', NULL, 'Historical malformed thread', ${at}, ${at}),
          ('c-later-starts', NULL, 'Historical current thread', ${at}, ${at})
      `;

      // Each group spans one complete 64-pointer page. The first page loses
      // every source to the permanent thread tombstone; the second has source
      // rows but no schema-qualified binding. Neither condition may stop the
      // keyset cursor before the later thread's valid independent work.
      for (const [threadId, malformed] of [
        ["a-tombstoned-starts", false],
        ["b-malformed-starts", true],
      ] as const) {
        const payload = encodeFixtureJson({
          taskId: "historical-agent",
          subagent: {
            threadId: "historical-agent",
            runtimeId,
            status: "active",
            ...(malformed ? { label: 7 } : {}),
          },
        });
        yield* sql`
          WITH RECURSIVE roots(index_value) AS (
            SELECT 0 UNION ALL SELECT index_value + 1 FROM roots WHERE index_value < 63
          )
          INSERT INTO projection_thread_activities(
            activity_id, thread_id, turn_id, tone, kind, summary,
            payload_json, created_at, sequence
          )
          SELECT ${threadId} || '-start-' || index_value, ${threadId},
            printf('root-%03d', index_value), 'info', 'task.started',
            'Historical native start', ${payload}, ${at}, index_value + 1
          FROM roots
        `;
      }
      yield* sql`
        INSERT INTO hard_deleted_threads(thread_id, deleted_at)
        VALUES ('a-tombstoned-starts', ${at})
      `;

      const sharedAgent = {
        taskId: "shared-agent",
        subagent: { threadId: "shared-agent", runtimeId, status: "active" },
      };
      // Canonical sequence, rather than pointer traversal or timestamp order,
      // selects this owner. Whitespace is part of its exact retained witness.
      const newestPayload = `  ${encodeFixtureJson(sharedAgent)}\n`;
      yield* insertLaterStart(sql, "latest-valid-start", "root-a", newestPayload, 30);
      yield* insertLaterStart(
        sql,
        "older-valid-start",
        "root-b",
        encodeFixtureJson(sharedAgent),
        20,
      );
      yield* insertLaterStart(
        sql,
        "newer-malformed-start",
        "root-c",
        encodeFixtureJson({
          ...sharedAgent,
          subagent: { ...sharedAgent.subagent, label: 7 },
        }),
        40,
      );
      yield* insertLaterStart(
        sql,
        "foreign-valid-start",
        "root-d",
        encodeFixtureJson({
          ...sharedAgent,
          subagent: { ...sharedAgent.subagent, runtimeId: foreignRuntimeId },
        }),
        50,
      );
      yield* insertLaterStart(
        sql,
        "mismatched-runtime-start",
        "root-e",
        encodeFixtureJson({
          ...sharedAgent,
          nativeWorkRuntimeId: runtimeId,
          subagent: { ...sharedAgent.subagent, runtimeId: foreignRuntimeId },
        }),
        60,
      );
      yield* insertLaterStart(
        sql,
        "missing-runtime-start",
        "root-f",
        encodeFixtureJson({
          taskId: "shared-agent",
          nativeWorkRuntimeId: runtimeId,
          subagent: { threadId: "shared-agent", status: "active" },
        }),
        70,
      );
      yield* insertLaterStart(
        sql,
        "oversized-start",
        "root-g",
        encodeFixtureJson({
          taskId: "oversized-agent",
          subagent: { threadId: "oversized-agent", runtimeId, status: "active" },
          historicalExtra: "x".repeat(1_024 * 1_024),
        }),
        80,
      );
      yield* insertLaterStart(
        sql,
        "invalid-date-start",
        "root-h",
        encodeFixtureJson({
          taskId: "invalid-date-agent",
          subagent: { threadId: "invalid-date-agent", runtimeId, status: "active" },
        }),
        85,
      );
      // Historical SQLite text fields can predate metadata admission. A bad
      // date must remain unqualified without aborting discovery of later work.
      yield* sql`
        UPDATE projection_thread_activities SET created_at = 'not-an-iso-date'
        WHERE activity_id = 'invalid-date-start'
      `;
      yield* insertLaterStart(
        sql,
        "last-valid-start",
        "root-z",
        encodeFixtureJson({
          taskId: "later-agent",
          subagent: { threadId: "later-agent", runtimeId, status: "active" },
        }),
        90,
      );
      // M082's normalized lifecycle pointers excluded NULL turns. A later
      // inter-root start must still replace the old root-a owner on upgrade,
      // even after its own descriptor-free native completion arrived.
      yield* sql`
        INSERT INTO projection_thread_activities(
          activity_id, thread_id, turn_id, tone, kind, summary,
          payload_json, created_at, sequence
        ) VALUES
          ('between-roots-start', 'c-later-starts', NULL, 'info', 'task.started',
            'Historical inter-root native start', ${newestPayload}, ${at}, 100),
          ('between-roots-completion', 'c-later-starts', NULL, 'info', 'task.completed',
            'Historical inter-root native completion',
            ${encodeFixtureJson({ taskId: "shared-agent", nativeWorkRuntimeId: runtimeId, status: "completed" })},
            ${at}, 101)
      `;
      assert.deepEqual(
        yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM projection_thread_activities`,
        [{ count: 139 }],
      );

      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 105 }), [
        [105, "CurrentNativeAgentBindings"],
      ]);
      assert.deepEqual(
        yield* sql<{
          threadId: string;
          runtimeId: string;
          workId: string;
          turnId: string | null;
          activityId: string;
          sequence: number;
          valid: number;
        }>`
          SELECT thread_id AS "threadId", runtime_id AS "runtimeId", work_id AS "workId",
            turn_id AS "turnId", activity_id AS "activityId", sequence, valid
          FROM projection_native_agent_bindings
          ORDER BY runtime_id, work_id
        `,
        [
          {
            threadId: "c-later-starts",
            runtimeId,
            workId: "later-agent",
            turnId: "root-z",
            activityId: "last-valid-start",
            sequence: 90,
            valid: 1,
          },
          {
            threadId: "c-later-starts",
            runtimeId,
            workId: "shared-agent",
            turnId: null,
            activityId: "between-roots-start",
            sequence: 100,
            valid: 1,
          },
          {
            threadId: "c-later-starts",
            runtimeId: foreignRuntimeId,
            workId: "shared-agent",
            turnId: "root-d",
            activityId: "foreign-valid-start",
            sequence: 50,
            valid: 1,
          },
        ],
      );
      assert.deepEqual(
        yield* sql<{ payload: string }>`
          SELECT payload_json AS payload FROM projection_native_agent_bindings
          WHERE thread_id = 'c-later-starts' AND runtime_id = ${runtimeId}
            AND work_id = 'shared-agent'
        `,
        [{ payload: newestPayload }],
      );
      assert.deepEqual(
        yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM projection_thread_activities`,
        [{ count: 139 }],
      );
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 105 }), []);
    }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
);
