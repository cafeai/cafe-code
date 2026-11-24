import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceTest } from "../persistence/Sqlite.test.fixture.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as TestSqliteClient from "../persistence/TestSqliteClient.ts";
import {
  makeMcpOperations,
  MAX_MCP_OPERATIONS,
  operationInputHash,
  operationScopeId,
} from "./operations.ts";

const owner = { sessionId: "exact-owner", expiresAt: "2099-01-01T00:00:00.000Z" };
const requestId = "3086ad13-3fab-4e04-885a-c271f8a5be11";
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

describe("durable MCP operation receipts", () => {
  it.effect(
    "admits one exact intent and retains its receipt across service recreation without storing inputs",
    () =>
      Effect.gen(function* () {
        const first = yield* makeMcpOperations;
        const hash = operationInputHash(owner, "send_message", {
          threadId: "chat",
          message: "PRIVATE_INPUT",
        });
        expect((yield* first.reserve(owner, requestId, "send_message", hash)).fresh).toBe(true);
        yield* first.settle(owner, requestId, "recorded", {
          messageId: "durable-message",
          sequence: 12,
        });
        const second = yield* makeMcpOperations;
        const replay = yield* second.reserve(
          owner,
          requestId,
          "send_message",
          operationInputHash(owner, "send_message", { message: "PRIVATE_INPUT", threadId: "chat" }),
        );
        expect(replay).toMatchObject({
          fresh: false,
          operation: { state: "recorded", result: { messageId: "durable-message", sequence: 12 } },
        });
        expect(yield* second.get({ ...owner, sessionId: "foreign-owner" }, requestId)).toBeNull();
        const conflict = yield* second
          .reserve(
            owner,
            requestId,
            "send_message",
            operationInputHash(owner, "send_message", {
              threadId: "other",
              message: "PRIVATE_INPUT",
            }),
          )
          .pipe(Effect.flip);
        expect(conflict.code).toBe("conflict");
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT * FROM mcp_operations`;
        expect(rows).toHaveLength(1);
        expect(encodeJson(rows)).not.toContain("PRIVATE_INPUT");
        expect(encodeJson(rows)).not.toContain("exact-owner");
      }).pipe(Effect.provide(SqlitePersistenceTest)),
  );

  it.effect(
    "preserves unconfirmed admission and never downgrades a completed restart to scheduled",
    () =>
      Effect.gen(function* () {
        const first = yield* makeMcpOperations;
        const emptyStorage = yield* first.storageStatus;
        expect(emptyStorage).toMatchObject({
          scope: "global",
          policyVersion: 1,
          receiptCount: 0,
          chargedBytes: 0,
        });
        expect(emptyStorage.availableBytes).toBe(emptyStorage.budgetBytes);
        const hash = operationInputHash(owner, "restart_provider", { instanceId: "codex" });
        yield* first.reserve(owner, requestId, "restart_provider", hash);
        const pendingStorage = yield* first.storageStatus;
        expect(pendingStorage.receiptCount).toBe(1);
        const second = yield* makeMcpOperations;
        expect(yield* second.get(owner, requestId)).toMatchObject({
          state: "unconfirmed",
          result: null,
        });
        expect((yield* second.reserve(owner, requestId, "restart_provider", hash)).fresh).toBe(
          false,
        );
        yield* second.settle(owner, requestId, "completed");
        const completedStorage = yield* second.storageStatus;
        expect(completedStorage.receiptCount).toBe(1);
        expect(pendingStorage.chargedBytes - completedStorage.chargedBytes).toBe(65_536);
        yield* first.settle(owner, requestId, "scheduled", { scheduled: true });
        expect(yield* first.get(owner, requestId)).toMatchObject({
          state: "completed",
          result: { scheduled: true },
        });
        const finalStorage = yield* first.storageStatus;
        expect(finalStorage.receiptCount).toBe(1);
        // The delayed acknowledgement adds only its retained JSON bytes. Its
        // requested stage cannot reclaim a completed row's full reservation.
        expect(finalStorage.chargedBytes - completedStorage.chargedBytes).toBe(
          Buffer.byteLength(encodeJson({ scheduled: true }), "utf8"),
        );
        expect(finalStorage.availableBytes).toBe(
          finalStorage.budgetBytes - finalStorage.chargedBytes,
        );
      }).pipe(Effect.provide(SqlitePersistenceTest)),
  );

  it.effect("keeps failed/partial attempts reserved and refuses oversized receipts", () =>
    Effect.gen(function* () {
      const operations = yield* makeMcpOperations;
      const hash = operationInputHash(owner, "update_thread", {
        threadId: "chat",
        title: "Title",
        runtimeMode: "full-access",
      });
      yield* operations.reserve(owner, requestId, "update_thread", hash);
      yield* operations.settle(owner, requestId, "failed");
      const replay = yield* operations.reserve(owner, requestId, "update_thread", hash);
      expect(replay).toMatchObject({ fresh: false, operation: { state: "failed" } });
      const oversized = yield* operations
        .settle(owner, requestId, "recorded", { detail: "x".repeat(65_536) })
        .pipe(Effect.flip);
      expect(oversized.code).toBe("capacity");
      expect(yield* operations.get(owner, requestId)).toMatchObject({
        state: "failed",
        result: null,
      });
    }).pipe(Effect.provide(SqlitePersistenceTest)),
  );

  it.effect(
    "admits new work alongside 10000 retained receipts without releasing live request IDs",
    () =>
      Effect.gen(function* () {
        const first = yield* makeMcpOperations;
        const sql = yield* SqlClient.SqlClient;
        const input = { threadId: "chat", message: "PRIVATE_CAPACITY_INPUT" };
        const hash = operationInputHash(owner, "send_message", input);
        const retained = [
          { requestId, state: "recorded", result: { messageId: "durable-message" } },
          {
            requestId: "3086ad13-3fab-4e04-885a-c271f8a5be12",
            state: "completed",
            result: { messageId: "completed-message" },
          },
          {
            requestId: "3086ad13-3fab-4e04-885a-c271f8a5be13",
            state: "failed",
            result: null,
          },
          {
            requestId: "3086ad13-3fab-4e04-885a-c271f8a5be14",
            state: "unconfirmed",
            result: null,
          },
          {
            requestId: "3086ad13-3fab-4e04-885a-c271f8a5be15",
            state: "scheduled",
            result: { scheduled: true },
          },
        ] as const;
        for (const entry of retained) {
          yield* first.reserve(owner, entry.requestId, "send_message", hash);
          if (entry.state !== "unconfirmed")
            yield* first.settle(owner, entry.requestId, entry.state, entry.result ?? undefined);
        }
        // Fill the former row limit with small historical outcomes. The live
        // sentinel claims above use ordinary admission and settlement; this
        // bulk insert avoids thousands of unrelated Effect round trips.
        yield* sql`WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n < ${10_000 - retained.length})
      INSERT INTO mcp_operations (owner_hash, request_id, tool, input_hash, state, result_json, created_at, updated_at, expires_at)
      SELECT ${operationScopeId(owner)}, printf('00000000-0000-4000-8000-%012d', n), 'send_message', ${"a".repeat(64)},
        CASE n % 3 WHEN 0 THEN 'recorded' WHEN 1 THEN 'completed' ELSE 'failed' END,
        '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${owner.expiresAt} FROM slots`;

        const recovered = yield* makeMcpOperations;
        const admitted = yield* recovered.reserve(
          owner,
          "3086ad13-3fab-4e04-885a-c271f8a5be16",
          "send_message",
          hash,
        );
        expect(admitted.fresh).toBe(true);
        for (const entry of retained) {
          const replay = yield* recovered.reserve(owner, entry.requestId, "send_message", hash);
          expect(replay).toMatchObject({
            fresh: false,
            operation: { state: entry.state, result: entry.result },
          });
        }
        const conflict = yield* recovered
          .reserve(
            owner,
            requestId,
            "send_message",
            operationInputHash(owner, "send_message", { ...input, threadId: "other-chat" }),
          )
          .pipe(Effect.flip);
        expect(conflict.code).toBe("conflict");
        const count = yield* sql<{ count: number }>`SELECT count(*) AS count FROM mcp_operations`;
        expect(count[0]?.count).toBe(10_001);
        const rows = yield* sql`SELECT * FROM mcp_operations WHERE input_hash = ${hash}`;
        expect(encodeJson(rows)).not.toContain(input.message);
        expect(encodeJson(rows)).not.toContain(owner.sessionId);
      }).pipe(Effect.provide(SqlitePersistenceTest)),
  );

  it.effect(
    "commits bounded expiry batches after capacity refusal until legacy admission can recover",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 108 });
        const hash = operationInputHash(owner, "send_message", { threadId: "live-chat" });
        const expired = {
          sessionId: "expired-owner",
          expiresAt: DateTime.formatIso(yield* DateTime.now),
        };
        // The legacy table has no SQL row limit. Migration must preserve even
        // an overbudget legacy database, while each failed admission retires
        // only one finite expired batch instead of rolling its cleanup back.
        yield* sql`WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n < 9900)
      INSERT INTO mcp_operations (owner_hash, request_id, tool, input_hash, state, created_at, updated_at, expires_at)
      SELECT ${operationScopeId(owner)}, printf('00000000-0000-4000-8000-%012d', n), 'send_message', ${"a".repeat(64)},
        'unconfirmed', ${expired.expiresAt}, ${expired.expiresAt}, ${owner.expiresAt} FROM slots`;
        yield* sql`WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n < 700)
      INSERT INTO mcp_operations (owner_hash, request_id, tool, input_hash, state, created_at, updated_at, expires_at)
      SELECT ${operationScopeId(expired)}, printf('00000000-0000-4000-8000-%012d', n), 'send_message', ${"a".repeat(64)},
        'unconfirmed', ${expired.expiresAt}, ${expired.expiresAt}, ${expired.expiresAt} FROM slots`;
        yield* runMigrations({ toMigrationInclusive: 109 });
        const operations = yield* makeMcpOperations;
        expect((yield* operations.storageStatus).receiptCount).toBe(10_600);

        for (const remaining of [10_344, 10_088]) {
          const refused = yield* operations
            .reserve(owner, requestId, "send_message", hash)
            .pipe(Effect.flip);
          expect(refused.code).toBe("capacity");
          expect((yield* operations.storageStatus).receiptCount).toBe(remaining);
        }

        const admitted = yield* operations.reserve(owner, requestId, "send_message", hash);
        expect(admitted.fresh).toBe(true);
        const remaining = yield* sql<{ count: number }>`SELECT count(*) AS count
          FROM mcp_operations WHERE owner_hash = ${operationScopeId(expired)}`;
        expect(remaining[0]?.count).toBe(0);
        expect((yield* operations.storageStatus).receiptCount).toBe(9901);
        const replay = yield* operations.reserve(
          owner,
          "00000000-0000-4000-8000-000000000001",
          "send_message",
          "a".repeat(64),
        );
        expect(replay).toMatchObject({
          fresh: false,
          operation: { state: "unconfirmed", result: null },
        });
        const live = yield* sql<{ count: number }>`SELECT count(*) AS count
          FROM mcp_operations WHERE owner_hash = ${operationScopeId(owner)}`;
        expect(live[0]?.count).toBe(9901);
        expect(yield* operations.get(owner, "00000000-0000-4000-8000-000000009900")).toMatchObject({
          state: "unconfirmed",
          inputHash: "a".repeat(64),
        });
      }).pipe(Effect.provide(TestSqliteClient.layerMemory())),
  );

  it.effect("refuses new admission with missing accounting while retaining known outcomes", () =>
    Effect.gen(function* () {
      const operations = yield* makeMcpOperations;
      const sql = yield* SqlClient.SqlClient;
      const hash = operationInputHash(owner, "send_message", { threadId: "chat" });
      yield* operations.reserve(owner, requestId, "send_message", hash);
      yield* operations.settle(owner, requestId, "recorded", { messageId: "durable-message" });
      yield* sql`DELETE FROM mcp_operation_storage_budget`;

      expect((yield* operations.storageStatus.pipe(Effect.flip)).code).toBe("unavailable");
      const refused = yield* operations
        .reserve(owner, "3086ad13-3fab-4e04-885a-c271f8a5be12", "send_message", hash)
        .pipe(Effect.flip);
      expect(refused.code).toBe("unavailable");
      const replay = yield* operations.reserve(owner, requestId, "send_message", hash);
      expect(replay).toMatchObject({
        fresh: false,
        operation: { state: "recorded", result: { messageId: "durable-message" } },
      });
      const count = yield* sql<{ count: number }>`SELECT count(*) AS count FROM mcp_operations`;
      expect(count[0]?.count).toBe(1);
    }).pipe(Effect.provide(SqlitePersistenceTest)),
  );

  it.effect(
    "bounds the receipt table and refuses new work instead of evicting live deduplication evidence",
    () =>
      Effect.gen(function* () {
        const operations = yield* makeMcpOperations;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n < ${MAX_MCP_OPERATIONS})
      INSERT INTO mcp_operations (owner_hash, request_id, tool, input_hash, state, created_at, updated_at, expires_at)
      SELECT ${operationScopeId(owner)}, printf('slot-%d', n), 'send_message', ${"a".repeat(64)}, 'unconfirmed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${owner.expiresAt} FROM slots`;
        const failure = yield* operations
          .reserve(owner, requestId, "send_message", "b".repeat(64))
          .pipe(Effect.flip);
        expect(failure.code).toBe("capacity");
        expect(yield* operations.get(owner, "slot-1")).toMatchObject({ state: "unconfirmed" });
        const count = yield* sql<{ count: number }>`SELECT count(*) AS count FROM mcp_operations`;
        expect(count[0]?.count).toBe(MAX_MCP_OPERATIONS);
      }).pipe(Effect.provide(SqlitePersistenceTest)),
  );
});
