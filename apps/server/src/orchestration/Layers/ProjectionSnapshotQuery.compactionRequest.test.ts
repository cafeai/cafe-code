import { ThreadId, ProviderInstanceId, SubagentRuntimeId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceTest } from "../../persistence/Sqlite.test.fixture.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

it.effect(
  "hydrates only received request proof through repository, command, shell and detail queries",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* ProjectionThreadSessionRepository;
      const query = yield* ProjectionSnapshotQuery;
      const threadId = ThreadId.make("paired-request-query");
      const now = "2026-10-14T00:00:00.000Z";
      yield* sql`INSERT INTO projection_threads(thread_id, project_id, title,
      model_selection_json, created_at, updated_at)
      VALUES (${threadId}, NULL, 'Received request',
        '{"instanceId":"codex","model":"gpt-6.1-sol"}', ${now}, ${now})`;
      const base = {
        threadId,
        status: "ready" as const,
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access" as const,
        subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000063"),
        codexContextWindowOverride: 800_000,
        activeTurnId: null,
        lastError: null,
        updatedAt: now,
      };
      for (const value of [undefined, 800_000, null, undefined]) {
        yield* sessions.upsert({
          ...base,
          ...(value !== undefined ? { codexAutoCompactTokenLimit: value } : {}),
        });
        const received = Option.getOrThrow(yield* sessions.getByThreadId({ threadId }));
        assert.equal(Object.hasOwn(received, "codexAutoCompactTokenLimit"), value !== undefined);
        assert.equal(received.codexAutoCompactTokenLimit, value);
        const command = yield* query.getCommandReadModel();
        const full = yield* query.getSnapshot();
        const shell = yield* query.getShellSnapshot();
        const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        for (const session of [
          command.threads.find((row) => row.id === threadId)?.session,
          full.threads.find((row) => row.id === threadId)?.session,
          shell.threads.find((row) => row.id === threadId)?.session,
          detail.session,
        ]) {
          assert.ok(session);
          assert.equal(Object.hasOwn(session, "codexAutoCompactTokenLimit"), value !== undefined);
          assert.equal(session.codexAutoCompactTokenLimit, value);
        }
      }
      yield* sessions.upsert({ ...base, codexAutoCompactTokenLimit: 600_000 });
      yield* sql`UPDATE projection_threads SET archived_at = ${now} WHERE thread_id = ${threadId}`;
      const archived = yield* query.getArchivedShellSnapshot();
      assert.equal(
        archived.threads.find((row) => row.id === threadId)?.session?.codexAutoCompactTokenLimit,
        600_000,
      );
      yield* sql`UPDATE projection_threads SET deleted_at = ${now} WHERE thread_id = ${threadId}`;
      const deleted = yield* query.getDeletedShellSnapshot();
      assert.equal(
        deleted.threads.find((row) => row.id === threadId)?.session?.codexAutoCompactTokenLimit,
        600_000,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          OrchestrationProjectionSnapshotQueryLive,
          ProjectionThreadSessionRepositoryLive,
        ).pipe(
          Layer.provideMerge(RepositoryIdentityResolverLive),
          Layer.provideMerge(SqlitePersistenceTest),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
