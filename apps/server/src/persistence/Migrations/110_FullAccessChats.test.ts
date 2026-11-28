import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { seedScheduledFollowUp } from "../../orchestration/scheduledFollowUp.testSupport.ts";
import { runMigrations } from "../Migrations.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const encodeModelSelection = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

it.effect("upgrades current chat intent while preserving native and attempted work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 109 });
    const now = "2026-11-25T00:00:00.000Z";
    const modelSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "fixture" };
    for (const [id, runtimeMode, interactionMode] of [
      ["restricted", "approval-required", "default"],
      ["auto", "full-access", "auto"],
      ["plan", "full-access", "plan"],
    ] as const) {
      const threadId = ThreadId.make(id);
      yield* sql`INSERT INTO projection_threads
        (thread_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
        VALUES (${threadId}, 'Fixture', ${encodeModelSelection(modelSelection)}, ${runtimeMode},
          ${interactionMode}, ${now}, ${now})`;
      yield* seedScheduledFollowUp(sql, { threadId, modelSelection, runtimeMode, createdAt: now });
    }
    yield* sql`INSERT INTO projection_thread_sessions
      (thread_id, status, provider_name, provider_instance_id, runtime_mode, active_turn_id, updated_at)
      VALUES ('restricted', 'running', 'claudeAgent', 'claudeAgent', 'approval-required', 'native-turn', ${now})`;
    yield* sql`UPDATE scheduled_followup_runs
      SET state = 'dispatching', attempt_at = ${now}
      WHERE thread_id = 'auto'`;
    yield* runMigrations({ toMigrationInclusive: 110 });
    assert.deepEqual(
      yield* sql`SELECT thread_id, runtime_mode, interaction_mode, updated_at
        FROM projection_threads ORDER BY thread_id`,
      [
        {
          thread_id: "auto",
          runtime_mode: "full-access",
          interaction_mode: "default",
          updated_at: now,
        },
        {
          thread_id: "plan",
          runtime_mode: "full-access",
          interaction_mode: "plan",
          updated_at: now,
        },
        {
          thread_id: "restricted",
          runtime_mode: "full-access",
          interaction_mode: "default",
          updated_at: now,
        },
      ],
    );
    assert.deepEqual(
      yield* sql`SELECT runtime_mode, status, active_turn_id FROM projection_thread_sessions`,
      [{ runtime_mode: "approval-required", status: "running", active_turn_id: "native-turn" }],
    );
    assert.deepEqual(
      yield* sql`SELECT thread_id, state, revision, permission_ceiling
        FROM scheduled_followups ORDER BY thread_id`,
      [
        {
          thread_id: "auto",
          state: "needs_attention",
          revision: 2,
          permission_ceiling: "full-access",
        },
        { thread_id: "plan", state: "active", revision: 1, permission_ceiling: "full-access" },
        {
          thread_id: "restricted",
          state: "needs_attention",
          revision: 2,
          permission_ceiling: "approval-required",
        },
      ],
    );
    assert.deepEqual(
      yield* sql`SELECT thread_id, state, error_code, attempt_at FROM scheduled_followup_runs
        ORDER BY thread_id`,
      [
        { thread_id: "auto", state: "dispatching", error_code: null, attempt_at: now },
        { thread_id: "plan", state: "waiting", error_code: null, attempt_at: null },
        {
          thread_id: "restricted",
          state: "skipped",
          error_code: "settings-changed",
          attempt_at: null,
        },
      ],
    );
    const attemptedPlanThreadId = ThreadId.make("plan-attempted");
    yield* sql`INSERT INTO projection_threads
      (thread_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${attemptedPlanThreadId}, 'Fixture', ${encodeModelSelection(modelSelection)},
        'full-access', 'plan', ${now}, ${now})`;
    yield* seedScheduledFollowUp(sql, {
      threadId: attemptedPlanThreadId,
      modelSelection,
      createdAt: now,
    });
    yield* sql`UPDATE scheduled_followup_runs
      SET state = 'dispatching', attempt_at = ${now}
      WHERE thread_id = ${attemptedPlanThreadId}`;
    yield* runMigrations({ toMigrationInclusive: 111 });
    assert.deepEqual(
      yield* sql`SELECT thread_id, runtime_mode, interaction_mode, updated_at
        FROM projection_threads WHERE thread_id IN ('plan', ${attemptedPlanThreadId})
        ORDER BY thread_id`,
      [
        {
          thread_id: "plan",
          runtime_mode: "full-access",
          interaction_mode: "default",
          updated_at: now,
        },
        {
          thread_id: attemptedPlanThreadId,
          runtime_mode: "full-access",
          interaction_mode: "default",
          updated_at: now,
        },
      ],
    );
    assert.deepEqual(
      yield* sql`SELECT state, revision, permission_ceiling, next_run_at
        FROM scheduled_followups WHERE thread_id IN ('plan', ${attemptedPlanThreadId})
        ORDER BY thread_id`,
      [
        {
          state: "needs_attention",
          revision: 2,
          permission_ceiling: "full-access",
          next_run_at: null,
        },
        {
          state: "needs_attention",
          revision: 2,
          permission_ceiling: "full-access",
          next_run_at: null,
        },
      ],
    );
    assert.deepEqual(
      yield* sql`SELECT thread_id, state, error_code, attempt_at FROM scheduled_followup_runs
        WHERE thread_id IN ('plan', ${attemptedPlanThreadId}) ORDER BY thread_id`,
      [
        { thread_id: "plan", state: "skipped", error_code: "settings-changed", attempt_at: null },
        {
          thread_id: attemptedPlanThreadId,
          state: "dispatching",
          error_code: null,
          attempt_at: now,
        },
      ],
    );
  }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
);
