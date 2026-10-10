import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";
import liveWork from "./092_LiveWork.ts";

const at = "2026-10-10T00:00:00.000Z";
const runtimeId = "10000000-0000-4000-8000-000000000001";
const workflowIdentity = `sha256:workflow:${"a".repeat(64)}`;

const assertWorkflowRetention = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`
      INSERT INTO projection_threads(thread_id, project_id, title, created_at, updated_at)
      VALUES ('workflow-092', NULL, 'Migration fixture', ${at}, ${at})
    `;
    yield* sql`
      INSERT INTO projection_thread_activities(
        activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
      ) VALUES (
        'workflow-092-start', 'workflow-092', 'turn-092', 'info', 'task.started', 'Workflow',
        ${JSON.stringify({
          taskId: "native-root",
          workflow: { runtimeId, providerInstanceId: "claude-account" },
          workflowRetentionId: workflowIdentity,
        })}, ${at}, 1
      )
    `;
    assert.deepEqual(
      yield* sql<{ childId: string }>`
        SELECT child_id AS "childId" FROM projection_subagent_lifecycle_sources
        WHERE activity_id = 'workflow-092-start'
      `,
      [{ childId: workflowIdentity }],
    );
  });

it.layer(TestSqliteClient.layerMemory())("092_LiveWork", (it) => {
  it.effect("adds live work after the upstream migrations and preserves workflow retention", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      const ran = yield* runMigrations();
      assert.deepEqual(ran, [[92, "LiveWork"]]);
      assert.deepEqual(
        yield* sql<{ name: string }>`
          SELECT name FROM effect_sql_migrations WHERE migration_id IN (90, 91, 92)
          ORDER BY migration_id
        `,
        [
          { name: "WorkflowLifecycleRetention" },
          { name: "CodexTransientRecoveryIntents" },
          { name: "LiveWork" },
        ],
      );
      assert.deepEqual(yield* sql`SELECT * FROM projection_live_work`, []);
      yield* assertWorkflowRetention(sql);
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );

  it.effect("repairs the local id collision without changing the ledger or existing work", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 89 });
      // Materialize the same table as the former local id 90, then record that
      // exact legacy name. No real application database participates here.
      yield* liveWork;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (90, 'LiveWork')`;
      yield* sql`
        INSERT INTO projection_live_work(
          thread_id, runtime_id, turn_id, lane, work_id, is_agent, active,
          sequence, created_at, activity_id
        ) VALUES ('local-thread', ${runtimeId}, 'local-turn', 'task', 'local-work', 0, 0,
          42, ${at}, 'local-terminal')
      `;
      const before = yield* sql`SELECT * FROM projection_live_work`;
      assert.deepEqual(yield* runMigrations(), [
        [91, "CodexTransientRecoveryIntents"],
        [92, "LiveWork"],
      ]);
      assert.deepEqual(yield* sql`SELECT * FROM projection_live_work`, before);
      assert.deepEqual(
        yield* sql<{ name: string }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 90`,
        [{ name: "LiveWork" }],
      );
      yield* assertWorkflowRetention(sql);
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(yield* sql`SELECT * FROM projection_live_work`, before);
    }),
  );
});
