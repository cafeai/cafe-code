// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId } from "@cafecode/contracts";
import { it, assert } from "@effect/vitest";
import { assertSome } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  MAX_SUBAGENT_HISTORY_ROOT_BYTES_PER_THREAD,
  ProviderSessionRuntimeRepositoryLive,
} from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
  );
  return Layer.mergeAll(
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
    NodeServices.layer,
  );
}

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))("ProviderSessionDirectoryLive", (it) => {
  it("upserts and reads thread bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const initialThreadId = ThreadId.make("thread-1");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId: initialThreadId,
      });

      const provider = yield* directory.getProvider(initialThreadId);
      assert.equal(provider, "codex");
      const resolvedBinding = yield* directory.getBinding(initialThreadId);
      assertSome(resolvedBinding, {
        threadId: initialThreadId,
        provider: ProviderDriverKind.make("codex"),
      });
      if (Option.isSome(resolvedBinding)) {
        assert.equal(resolvedBinding.value.threadId, initialThreadId);
      }

      const nextThreadId = ThreadId.make("thread-2");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId: nextThreadId,
      });
      const updatedBinding = yield* directory.getBinding(nextThreadId);
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.threadId, nextThreadId);
      }

      const runtime = yield* runtimeRepository.getByThreadId({ threadId: nextThreadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, nextThreadId);
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.providerName, "codex");
      }

      const threadIds = yield* directory.listThreadIds();
      assert.deepEqual(threadIds, [nextThreadId]);
    }));

  it("persists runtime fields and merges payload updates", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const threadId = ThreadId.make("thread-runtime");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        status: "starting",
        resumeCursor: {
          threadId: "provider-thread-runtime",
        },
        runtimePayload: {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
        },
      });

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        status: "running",
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, threadId);
        assert.equal(runtime.value.status, "running");
        assert.deepEqual(runtime.value.resumeCursor, {
          threadId: "provider-thread-runtime",
        });
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
          activeTurnId: "turn-1",
        });
      }
    }));

  it("keeps nested-agent history provenance immutable across provider replacement", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-subagent-history-binding");
      const turnId = TurnId.make("turn-subagent-history-binding");

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at
        ) VALUES (
          ${threadId},
          'project-subagent-history-binding',
          'Subagent history binding',
          NULL,
          NULL,
          ${turnId},
          '2026-08-25T00:00:00.000Z',
          '2026-08-25T00:00:00.000Z'
        )
      `;

      yield* directory.upsertSubagentHistoryBinding({
        threadId,
        turnId,
        subagentId: "child-1",
        historyId: "history-1",
        providerName: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-primary"),
        resumeCursor: { threadId: "provider-root-1" },
        cwd: "/tmp/original-root",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
      });

      // An exact-key conflict cannot rewrite routing provenance. This is a
      // first-writer-wins security boundary, not mutable lifecycle state.
      const conflict = yield* directory
        .upsertSubagentHistoryBinding({
          threadId,
          turnId,
          subagentId: "child-1",
          historyId: "history-1",
          providerName: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claude-secondary"),
          resumeCursor: { resume: "different-root" },
          cwd: "/tmp/replacement-root",
          createdAt: "2026-08-25T00:01:00.000Z",
          updatedAt: "2026-08-25T00:01:00.000Z",
        })
        .pipe(Effect.result);
      assert.equal(conflict._tag, "Failure");
      if (conflict._tag === "Failure") {
        assert.equal(conflict.failure._tag, "ProviderSubagentHistoryBindingConflictError");
        assert.equal(conflict.failure.message.includes("different-root"), false);
        assert.equal(conflict.failure.message.includes("replacement-root"), false);
      }

      const binding = yield* directory.getSubagentHistoryBinding({
        threadId,
        turnId,
        subagentId: "child-1",
        historyId: "history-1",
      });
      assertSome(binding, {
        threadId,
        turnId,
        subagentId: "child-1",
        historyId: "history-1",
        providerName: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-primary"),
        resumeCursor: { threadId: "provider-root-1" },
        cwd: "/tmp/original-root",
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
      });

      // The same turn root is not a wildcard. A caller that proved a different
      // child/history tuple receives no routing provenance.
      assert.equal(
        Option.isNone(
          yield* directory.getSubagentHistoryBinding({
            threadId,
            turnId,
            subagentId: "child-not-persisted",
            historyId: "history-not-persisted",
          }),
        ),
        true,
      );

      yield* directory.remove(threadId);
      assert.equal(
        Option.isNone(
          yield* directory.getSubagentHistoryBinding({
            threadId,
            turnId,
            subagentId: "child-1",
            historyId: "history-1",
          }),
        ),
        true,
      );
    }));

  it("stores one private history root for every exact child tuple in a turn", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-normalized-subagent-history");
      const turnId = TurnId.make("turn-normalized-subagent-history");

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at
        ) VALUES (
          ${threadId},
          'project-normalized-subagent-history',
          'Normalized subagent history',
          NULL,
          NULL,
          ${turnId},
          '2026-08-25T01:00:00.000Z',
          '2026-08-25T01:00:00.000Z'
        )
      `;

      for (const index of [1, 2, 3]) {
        yield* directory.upsertSubagentHistoryBinding({
          threadId,
          turnId,
          subagentId: `child-${index}`,
          historyId: `history-${index}`,
          providerName: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex-primary"),
          resumeCursor: { threadId: "provider-root-shared" },
          cwd: "/tmp/shared-root",
          createdAt: `2026-08-25T01:00:0${index}.000Z`,
          updatedAt: `2026-08-25T01:00:0${index}.000Z`,
        });
      }

      const counts = yield* sql<{
        readonly rootCount: number;
        readonly childCount: number;
        readonly cursorCopies: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM provider_subagent_history_roots WHERE thread_id = ${threadId}) AS "rootCount",
          (SELECT COUNT(*) FROM provider_subagent_history_bindings WHERE thread_id = ${threadId}) AS "childCount",
          (
            SELECT COUNT(*)
            FROM provider_subagent_history_roots
            WHERE thread_id = ${threadId}
              AND resume_cursor_json = '{"threadId":"provider-root-shared"}'
          ) AS "cursorCopies"
      `;
      assert.deepEqual(counts, [{ rootCount: 1, childCount: 3, cursorCopies: 1 }]);

      for (const index of [1, 2, 3]) {
        assertSome(
          yield* directory.getSubagentHistoryBinding({
            threadId,
            turnId,
            subagentId: `child-${index}`,
            historyId: `history-${index}`,
          }),
          {
            threadId,
            turnId,
            subagentId: `child-${index}`,
            historyId: `history-${index}`,
            providerName: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex-primary"),
            resumeCursor: { threadId: "provider-root-shared" },
            cwd: "/tmp/shared-root",
            createdAt: `2026-08-25T01:00:0${index}.000Z`,
            updatedAt: `2026-08-25T01:00:0${index}.000Z`,
          },
        );
      }
    }));

  it("prunes private history roots to the aggregate per-thread byte budget", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-bounded-subagent-history");
      const rootPayload = "x".repeat(60 * 1024);
      const rootCountToWrite =
        Math.ceil(MAX_SUBAGENT_HISTORY_ROOT_BYTES_PER_THREAD / rootPayload.length) + 8;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at
        ) VALUES (
          ${threadId},
          'project-bounded-subagent-history',
          'Bounded subagent history',
          NULL,
          NULL,
          NULL,
          '2026-08-25T02:00:00.000Z',
          '2026-08-25T02:00:00.000Z'
        )
      `;

      for (let index = 0; index < rootCountToWrite; index += 1) {
        const timestamp = new Date(Date.UTC(2026, 7, 25, 2, 0, 0) + index * 1_000).toISOString();
        yield* directory.upsertSubagentHistoryBinding({
          threadId,
          turnId: TurnId.make(`turn-bounded-subagent-history-${index}`),
          subagentId: `child-bounded-${index}`,
          historyId: `history-bounded-${index}`,
          providerName: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex-primary"),
          resumeCursor: { opaque: rootPayload },
          cwd: `/tmp/bounded-root-${index}`,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      }

      const retained = yield* sql<{
        readonly rootCount: number;
        readonly childCount: number;
        readonly privateBytes: number;
      }>`
        SELECT
          (SELECT COUNT(*) FROM provider_subagent_history_roots WHERE thread_id = ${threadId}) AS "rootCount",
          (SELECT COUNT(*) FROM provider_subagent_history_bindings WHERE thread_id = ${threadId}) AS "childCount",
          (
            SELECT COALESCE(
              SUM(
                COALESCE(length(CAST(resume_cursor_json AS BLOB)), 0) +
                COALESCE(length(CAST(cwd AS BLOB)), 0)
              ),
              0
            )
            FROM provider_subagent_history_roots
            WHERE thread_id = ${threadId}
          ) AS "privateBytes"
      `;
      assert.equal(retained.length, 1);
      assert.ok((retained[0]?.rootCount ?? rootCountToWrite) < rootCountToWrite);
      assert.equal(retained[0]?.childCount, retained[0]?.rootCount);
      assert.ok(
        (retained[0]?.privateBytes ?? Number.POSITIVE_INFINITY) <=
          MAX_SUBAGENT_HISTORY_ROOT_BYTES_PER_THREAD,
      );
    }));

  it("lists persisted bindings with metadata in oldest-first order", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const olderThreadId = ThreadId.make("thread-runtime-older");
      const newerThreadId = ThreadId.make("thread-runtime-newer");

      yield* runtimeRepository.upsert({
        threadId: newerThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T12:05:00.000Z",
        resumeCursor: {
          opaque: "resume-newer",
        },
        runtimePayload: {
          cwd: "/tmp/newer",
        },
      });

      yield* runtimeRepository.upsert({
        threadId: olderThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "approval-required",
        status: "starting",
        lastSeenAt: "2026-04-14T12:00:00.000Z",
        resumeCursor: {
          opaque: "resume-older",
        },
        runtimePayload: {
          cwd: "/tmp/older",
        },
      });

      const bindings = yield* directory.listBindings();

      assert.deepEqual(bindings, [
        {
          threadId: olderThreadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          adapterKey: "claudeAgent",
          runtimeMode: "approval-required",
          status: "starting",
          lastSeenAt: "2026-04-14T12:00:00.000Z",
          resumeCursor: {
            opaque: "resume-older",
          },
          runtimePayload: {
            cwd: "/tmp/older",
          },
        },
        {
          threadId: newerThreadId,
          provider: ProviderDriverKind.make("codex"),
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: "2026-04-14T12:05:00.000Z",
          resumeCursor: {
            opaque: "resume-newer",
          },
          runtimePayload: {
            cwd: "/tmp/newer",
          },
        },
      ]);
    }));

  it("resets adapterKey to the new provider when provider changes without an explicit adapter key", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-provider-change");

      yield* runtimeRepository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        resumeCursor: null,
        runtimePayload: null,
      });

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        threadId,
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.providerName, "codex");
        assert.equal(runtime.value.adapterKey, "codex");
      }
    }));

  it("rehydrates persisted mappings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-directory-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      const threadId = ThreadId.make("thread-restart");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: ProviderDriverKind.make("codex"),
          threadId,
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        const provider = yield* directory.getProvider(threadId);
        assert.equal(provider, "codex");

        const resolvedBinding = yield* directory.getBinding(threadId);
        assertSome(resolvedBinding, {
          threadId,
          provider: ProviderDriverKind.make("codex"),
        });
        if (Option.isSome(resolvedBinding)) {
          assert.equal(resolvedBinding.value.threadId, threadId);
        }

        const legacyTableRows = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'provider_sessions'
        `;
        assert.equal(legacyTableRows.length, 0);
      }).pipe(Effect.provide(directoryLayer));

      fs.rmSync(tempDir, { recursive: true, force: true });
    }));
});
