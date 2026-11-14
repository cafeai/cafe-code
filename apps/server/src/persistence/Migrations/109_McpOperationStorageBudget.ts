import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  MCP_OPERATION_STORAGE_BUDGET_BYTES,
  MCP_OPERATION_STORAGE_BYTES_SQL,
  MCP_OPERATION_STORAGE_POLICY_VERSION,
} from "../../mcp/operationStorage.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // VIRTUAL avoids rewriting every legacy result blob merely to add accounting.
  // The old table and all request identities/results remain in place. This is a
  // generated column, not a writable caller estimate or a reconstructed outcome.
  yield* sql.unsafe(`ALTER TABLE mcp_operations ADD COLUMN storage_bytes INTEGER
    GENERATED ALWAYS AS (${MCP_OPERATION_STORAGE_BYTES_SQL}) VIRTUAL`);

  // Existing databases may already exceed the new logical budget because the
  // old row cap did not account for unusually large metadata. Preserve that
  // evidence and allow later shrink/deletion; only positive growth is refused.
  // Safe integer bounds keep native SQL and the JS admission/diagnostic readers
  // in the same exact domain. There is deliberately no <= budget CHECK here.
  yield* sql`CREATE TABLE mcp_operation_storage_budget (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    policy_version INTEGER NOT NULL CHECK (typeof(policy_version) = 'integer' AND policy_version = 1),
    bytes INTEGER NOT NULL CHECK (typeof(bytes) = 'integer' AND bytes >= 0 AND bytes <= 9007199254740991),
    entry_count INTEGER NOT NULL CHECK (typeof(entry_count) = 'integer' AND entry_count >= 0 AND entry_count <= 9007199254740991)
  )`;
  yield* sql`INSERT INTO mcp_operation_storage_budget (singleton, policy_version, bytes, entry_count)
    SELECT 1, 1, coalesce(sum(storage_bytes), 0), count(*) FROM mcp_operations`;

  // Each mutation checks the singleton explicitly before relying on it. A
  // missing/NULL/corrupt counter must not make SQL's three-valued WHEN condition
  // silently skip capacity enforcement. No trigger rebuilds missing evidence.
  const validCounter = `EXISTS (
    SELECT 1 FROM mcp_operation_storage_budget
    WHERE singleton = 1 AND policy_version = ${MCP_OPERATION_STORAGE_POLICY_VERSION}
      AND typeof(policy_version) = 'integer'
      AND typeof(bytes) = 'integer' AND bytes >= 0 AND bytes <= 9007199254740991
      AND typeof(entry_count) = 'integer' AND entry_count >= 0 AND entry_count <= 9007199254740991
      AND ((entry_count = 0 AND bytes = 0)
        OR (entry_count > 0 AND bytes >= entry_count * 1024))
  )`;
  // REPLACE may erase a conflicting row without firing its DELETE triggers
  // under SQLite's ordinary recursive_triggers setting. Refuse the conflict
  // before that deletion; current exact-ID retries return the existing receipt
  // before INSERT and never require an overwrite. Do not change global pragmas.
  yield* sql.unsafe(`CREATE TRIGGER mcp_operation_storage_insert_guard
    BEFORE INSERT ON mcp_operations
    BEGIN
      SELECT CASE WHEN EXISTS (SELECT 1 FROM mcp_operations
        WHERE owner_hash = NEW.owner_hash AND request_id = NEW.request_id)
        THEN RAISE(ABORT, 'MCP operation receipt already reserved') END;
    END`);
  // SQLite can leave a virtual generated NEW value unmaterialized in BEFORE
  // UPDATE. Observe the actual stored row in AFTER triggers instead. Guard and
  // counter write share this one trigger, so no trigger ordering can double
  // charge it. ABORT restores both the receipt statement and all its counters.
  yield* sql.unsafe(`CREATE TRIGGER mcp_operation_storage_insert_account
    AFTER INSERT ON mcp_operations
    BEGIN
      SELECT CASE WHEN NOT (${validCounter})
        THEN RAISE(ABORT, 'MCP operation storage unavailable') END;
      SELECT CASE WHEN NEW.storage_bytes > ${MCP_OPERATION_STORAGE_BUDGET_BYTES}
        OR (SELECT bytes FROM mcp_operation_storage_budget WHERE singleton = 1)
          > ${MCP_OPERATION_STORAGE_BUDGET_BYTES} - NEW.storage_bytes
        THEN RAISE(ABORT, 'MCP operation storage capacity') END;
      UPDATE mcp_operation_storage_budget SET bytes = bytes + NEW.storage_bytes,
        entry_count = entry_count + 1 WHERE singleton = 1;
    END`);

  // NEW is the actual final generated charge, after the existing settlement SQL
  // preserves terminal state and merges the exact retained result. A delayed
  // scheduled ACK cannot reserve room again after completion has won that race.
  // Every guard/account update shares the receipt statement's transaction; a
  // failed growth leaves both the old outcome and its old charge untouched.
  yield* sql.unsafe(`CREATE TRIGGER mcp_operation_storage_update_guard
    BEFORE UPDATE ON mcp_operations
    BEGIN
      SELECT CASE WHEN (NEW.owner_hash != OLD.owner_hash OR NEW.request_id != OLD.request_id)
        AND EXISTS (SELECT 1 FROM mcp_operations
          WHERE owner_hash = NEW.owner_hash AND request_id = NEW.request_id)
        THEN RAISE(ABORT, 'MCP operation receipt already reserved') END;
    END`);
  yield* sql.unsafe(`CREATE TRIGGER mcp_operation_storage_update_account
    AFTER UPDATE ON mcp_operations
    BEGIN
      SELECT CASE WHEN NOT (${validCounter})
        OR NOT EXISTS (SELECT 1 FROM mcp_operation_storage_budget
          WHERE singleton = 1 AND entry_count >= 1 AND bytes >= OLD.storage_bytes)
        THEN RAISE(ABORT, 'MCP operation storage unavailable') END;
      SELECT CASE WHEN NEW.storage_bytes > OLD.storage_bytes
        AND (NEW.storage_bytes > ${MCP_OPERATION_STORAGE_BUDGET_BYTES}
          OR (SELECT bytes FROM mcp_operation_storage_budget WHERE singleton = 1)
            > ${MCP_OPERATION_STORAGE_BUDGET_BYTES} - (NEW.storage_bytes - OLD.storage_bytes))
        THEN RAISE(ABORT, 'MCP operation storage capacity') END;
      UPDATE mcp_operation_storage_budget SET bytes = bytes + NEW.storage_bytes - OLD.storage_bytes
        WHERE singleton = 1;
    END`);

  // Only the existing expiry path removes rows. Account for the exact deleted
  // row, including a full outstanding reservation, without resurrecting any ID.
  yield* sql.unsafe(`CREATE TRIGGER mcp_operation_storage_delete_account
    AFTER DELETE ON mcp_operations
    BEGIN
      SELECT CASE WHEN NOT (${validCounter})
        OR NOT EXISTS (SELECT 1 FROM mcp_operation_storage_budget
          WHERE singleton = 1 AND entry_count >= 1 AND bytes >= OLD.storage_bytes)
        THEN RAISE(ABORT, 'MCP operation storage unavailable') END;
      UPDATE mcp_operation_storage_budget SET bytes = bytes - OLD.storage_bytes,
        entry_count = entry_count - 1 WHERE singleton = 1;
    END`);
});
