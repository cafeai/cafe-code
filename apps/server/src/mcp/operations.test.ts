import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceTest } from "../persistence/Sqlite.test.fixture.ts";
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
        const hash = operationInputHash(owner, "restart_provider", { instanceId: "codex" });
        yield* first.reserve(owner, requestId, "restart_provider", hash);
        const second = yield* makeMcpOperations;
        expect(yield* second.get(owner, requestId)).toMatchObject({
          state: "unconfirmed",
          result: null,
        });
        expect((yield* second.reserve(owner, requestId, "restart_provider", hash)).fresh).toBe(
          false,
        );
        yield* second.settle(owner, requestId, "completed");
        yield* first.settle(owner, requestId, "scheduled", { scheduled: true });
        expect(yield* first.get(owner, requestId)).toMatchObject({
          state: "completed",
          result: { scheduled: true },
        });
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
