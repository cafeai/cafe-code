import { ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceTest } from "../../persistence/Sqlite.test.fixture.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceTest),
    Layer.provideMerge(NodeServices.layer),
  ),
)("context report projection", (it) => {
  it.effect(
    "reads the exact thread's newest sequenced report despite newer unrelated activity",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const query = yield* ProjectionSnapshotQuery;
        yield* sql`DELETE FROM projection_thread_activities`;
        const rows = [
          [
            "legacy",
            "usage-thread",
            "context-window.updated",
            null,
            "2026-10-31T12:00:00.000Z",
            99,
          ],
          ["older", "usage-thread", "context-window.updated", 10, "2026-10-31T11:00:00.000Z", 100],
          ["newest", "usage-thread", "context-window.updated", 11, "2026-10-31T10:00:00.000Z", 200],
          ["ordinary", "usage-thread", "tool.completed", 12, "2026-10-31T12:00:00.000Z", 999],
          [
            "foreign",
            "foreign-thread",
            "context-window.updated",
            99,
            "2026-10-31T12:00:00.000Z",
            999,
          ],
        ] as const;
        for (const [id, threadId, kind, sequence, createdAt, usedTokens] of rows) {
          yield* sql`INSERT INTO projection_thread_activities
          (activity_id,thread_id,turn_id,tone,kind,summary,payload_json,sequence,created_at)
          VALUES (${id},${threadId},NULL,'info',${kind},'Report',${encodePayload({ usedTokens })},${sequence},${createdAt})`;
        }
        const report = yield* query.getThreadContextWindowActivity(ThreadId.make("usage-thread"));
        assert(Option.isSome(report));
        assert.equal(report.value.id, "newest");
        assert.deepStrictEqual(report.value.payload, { usedTokens: 200 });
        assert.equal(report.value.sequence, 11);
        assert(Option.isNone(yield* query.getThreadContextWindowActivity(ThreadId.make("absent"))));
      }),
  );
});
