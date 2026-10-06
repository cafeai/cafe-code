import { ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

it.effect(
  "reads exact indexed context admission and fails closed for corruption or missing storage",
  () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const source = ThreadId.make("bootstrap-query-source");
      const other = ThreadId.make("bootstrap-query-other");
      assert.equal(yield* query.hasPendingContextBootstrap(source), false);
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
      VALUES (${source}, NULL, 'Copied chat', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_context_bootstraps VALUES (${source}, 1)`;
      assert.equal(yield* query.hasPendingContextBootstrap(source), true);
      assert.equal(yield* query.hasPendingContextBootstrap(other), false);
      const plan =
        yield* sql`EXPLAIN QUERY PLAN SELECT pending FROM projection_thread_context_bootstraps WHERE thread_id = ${source}`;
      assert.match(String(plan[0]?.detail), /SEARCH .* USING PRIMARY KEY/);
      yield* sql`UPDATE projection_thread_context_bootstraps SET pending = 0 WHERE thread_id = ${source}`;
      assert.equal(yield* query.hasPendingContextBootstrap(source), false);
      yield* sql`PRAGMA ignore_check_constraints = ON`;
      yield* sql`UPDATE projection_thread_context_bootstraps SET pending = 2 WHERE thread_id = ${source}`;
      assert.equal(
        (yield* query.hasPendingContextBootstrap(source).pipe(Effect.flip))._tag,
        "PersistenceDecodeError",
      );
      yield* sql`PRAGMA ignore_check_constraints = OFF`;
      yield* sql`DROP TABLE projection_thread_context_bootstraps`;
      assert.equal(
        (yield* query.hasPendingContextBootstrap(source).pipe(Effect.flip))._tag,
        "PersistenceSqlError",
      );
    }).pipe(
      Effect.provide(
        OrchestrationProjectionSnapshotQueryLive.pipe(
          Layer.provideMerge(RepositoryIdentityResolverLive),
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
