import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Private visualization bytes are never orchestration events or replay rows. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE visualization_session_runtime (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), generation TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE visualization_session_capabilities (
    thread_id TEXT PRIMARY KEY NOT NULL, provider_instance_id TEXT NOT NULL,
    session_generation TEXT NOT NULL, runtime_generation TEXT NOT NULL,
    token_digest TEXT NOT NULL, server_name TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1))
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE visualization_artifacts (
    revision_id TEXT PRIMARY KEY NOT NULL, artifact_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('generated-visualization', 'mcp-app')),
    thread_id TEXT NOT NULL, provider_instance_id TEXT NOT NULL,
    session_generation TEXT NOT NULL, request_id TEXT NOT NULL,
    input_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, content_sha256 TEXT NOT NULL,
    source TEXT NOT NULL CHECK (length(CAST(source AS BLOB)) BETWEEN 1 AND 524288),
    assets_json TEXT NOT NULL CHECK (length(CAST(assets_json AS BLOB)) <= 17825792),
    reference_json TEXT NOT NULL CHECK (length(CAST(reference_json AS BLOB)) <= 8192),
    diagnostics_json TEXT NOT NULL CHECK (length(CAST(diagnostics_json AS BLOB)) <= 16384),
    private_json TEXT NOT NULL CHECK (length(CAST(private_json AS BLOB)) <= 8388608),
    poster BLOB, poster_sha256 TEXT,
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 33554432),
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'retired')),
    created_at TEXT NOT NULL,
    failure_reason TEXT CHECK(failure_reason IS NULL OR failure_reason = 'capture-unavailable'),
    UNIQUE (thread_id, session_generation, request_id)
  )`;
  yield* sql`CREATE INDEX idx_visualization_artifacts_owner
    ON visualization_artifacts(thread_id, state, created_at, revision_id)`;
  // Constant-time admission accounting avoids rescanning historical private
  // blobs for every tool call. Trigger updates share the mutation transaction.
  yield* sql`CREATE TABLE visualization_storage_quota (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), bytes INTEGER NOT NULL CHECK(bytes >= 0),
    artifacts INTEGER NOT NULL CHECK(artifacts >= 0), history INTEGER NOT NULL CHECK(history >= 0)
  )`;
  yield* sql`INSERT INTO visualization_storage_quota VALUES(1,0,0,0)`;
  yield* sql`CREATE TABLE visualization_thread_quota (
    thread_id TEXT PRIMARY KEY NOT NULL, bytes INTEGER NOT NULL CHECK(bytes >= 0)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TRIGGER visualization_quota_insert AFTER INSERT ON visualization_artifacts
    BEGIN
      UPDATE visualization_storage_quota SET bytes = bytes + NEW.byte_length, artifacts = artifacts + 1 WHERE singleton = 1;
      INSERT INTO visualization_thread_quota VALUES(NEW.thread_id,NEW.byte_length)
        ON CONFLICT(thread_id) DO UPDATE SET bytes = bytes + NEW.byte_length;
    END`;
  yield* sql`CREATE TRIGGER visualization_quota_admission BEFORE INSERT ON visualization_artifacts
    WHEN (SELECT bytes + NEW.byte_length > 268435456 OR artifacts >= 2048 FROM visualization_storage_quota WHERE singleton = 1)
      OR COALESCE((SELECT bytes FROM visualization_thread_quota WHERE thread_id = NEW.thread_id),0) + NEW.byte_length > 67108864
    BEGIN SELECT RAISE(ABORT,'visualization storage capacity'); END`;
  yield* sql`CREATE TRIGGER visualization_quota_update AFTER UPDATE OF byte_length ON visualization_artifacts
    BEGIN
      UPDATE visualization_storage_quota SET bytes = bytes + NEW.byte_length - OLD.byte_length WHERE singleton = 1;
      UPDATE visualization_thread_quota SET bytes = bytes + NEW.byte_length - OLD.byte_length WHERE thread_id = NEW.thread_id;
    END`;
  yield* sql`CREATE TRIGGER visualization_quota_delete AFTER DELETE ON visualization_artifacts
    BEGIN
      UPDATE visualization_storage_quota SET bytes = bytes - OLD.byte_length, artifacts = artifacts - 1 WHERE singleton = 1;
      UPDATE visualization_thread_quota SET bytes = bytes - OLD.byte_length WHERE thread_id = OLD.thread_id;
    END`;
  yield* sql`CREATE TABLE visualization_invocations (
    invocation_id TEXT PRIMARY KEY NOT NULL, proof_digest TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL, provider_instance_id TEXT NOT NULL,
    session_generation TEXT NOT NULL, runtime_generation TEXT NOT NULL,
    server_name TEXT NOT NULL, tool_name TEXT NOT NULL,
    input_sha256 TEXT NOT NULL, revision_id TEXT NOT NULL,
    native_call_key TEXT, expires_at INTEGER NOT NULL,
    FOREIGN KEY(revision_id) REFERENCES visualization_artifacts(revision_id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX idx_visualization_invocations_expiry
    ON visualization_invocations(expires_at, invocation_id)`;
  yield* sql`CREATE INDEX idx_visualization_invocations_owner ON visualization_invocations(thread_id,native_call_key)`;
  // Receipts remain bounded even when a caller repeatedly reuses one ready
  // artifact. Compact successful history is not an unlimited proof ledger.
  yield* sql`CREATE TRIGGER visualization_invocation_capacity BEFORE INSERT ON visualization_invocations
    WHEN (SELECT COUNT(*) FROM visualization_invocations) >= 8192
      OR (SELECT COUNT(*) FROM visualization_invocations WHERE thread_id = NEW.thread_id) >= 512
    BEGIN SELECT RAISE(ABORT,'visualization invocation capacity'); END`;
  yield* sql`CREATE TABLE visualization_viewer_tickets (
    ticket_digest TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL, revision_id TEXT NOT NULL,
    host_generation TEXT NOT NULL, expires_at INTEGER NOT NULL,
    FOREIGN KEY(revision_id) REFERENCES visualization_artifacts(revision_id) ON DELETE CASCADE
  ) WITHOUT ROWID`;
  yield* sql`CREATE INDEX idx_visualization_viewer_tickets_expiry ON visualization_viewer_tickets(expires_at,ticket_digest)`;
  yield* sql`CREATE INDEX idx_visualization_viewer_tickets_owner ON visualization_viewer_tickets(thread_id)`;
  yield* sql`CREATE TRIGGER visualization_viewer_capacity BEFORE INSERT ON visualization_viewer_tickets
    WHEN (SELECT COUNT(*) FROM visualization_viewer_tickets) >= 256
      OR (SELECT COUNT(*) FROM visualization_viewer_tickets WHERE thread_id = NEW.thread_id) >= 32
    BEGIN SELECT RAISE(ABORT,'visualization viewer capacity'); END`;
  yield* sql`CREATE TABLE visualization_history (
    id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL, message_id TEXT NOT NULL, origin_item_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL, actor_json TEXT NOT NULL CHECK(length(actor_json) <= 1024),
    reference_json TEXT NOT NULL CHECK(length(CAST(reference_json AS BLOB)) <= 8192),
    revision_id TEXT NOT NULL, native_call_key TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 16384),
    UNIQUE(thread_id, native_call_key),
    FOREIGN KEY(revision_id) REFERENCES visualization_artifacts(revision_id) ON DELETE RESTRICT
  )`;
  yield* sql`CREATE INDEX idx_visualization_history_window
    ON visualization_history(thread_id, occurred_at DESC, id DESC)`;
  yield* sql`CREATE INDEX idx_visualization_history_revision
    ON visualization_history(revision_id, thread_id)`;
  yield* sql`CREATE TRIGGER visualization_history_quota_admission BEFORE INSERT ON visualization_history
    WHEN (SELECT bytes + NEW.byte_length > 268435456 OR history >= 20000 FROM visualization_storage_quota WHERE singleton = 1)
      OR COALESCE((SELECT bytes FROM visualization_thread_quota WHERE thread_id = NEW.thread_id),0) + NEW.byte_length > 67108864
    BEGIN SELECT RAISE(ABORT,'visualization history capacity'); END`;
  yield* sql`CREATE TRIGGER visualization_history_quota_insert AFTER INSERT ON visualization_history
    BEGIN
      UPDATE visualization_storage_quota SET bytes = bytes + NEW.byte_length, history = history + 1 WHERE singleton = 1;
      INSERT INTO visualization_thread_quota VALUES(NEW.thread_id,NEW.byte_length) ON CONFLICT(thread_id) DO UPDATE SET bytes = bytes + NEW.byte_length;
    END`;
  yield* sql`CREATE TRIGGER visualization_history_quota_delete AFTER DELETE ON visualization_history
    BEGIN
      UPDATE visualization_storage_quota SET bytes = bytes - OLD.byte_length, history = history - 1 WHERE singleton = 1;
      UPDATE visualization_thread_quota SET bytes = bytes - OLD.byte_length WHERE thread_id = OLD.thread_id;
    END`;
  yield* sql`CREATE INDEX idx_visualization_artifacts_sweep ON visualization_artifacts(created_at,revision_id)`;
  yield* sql`CREATE TRIGGER visualization_artifact_tombstone
    BEFORE INSERT ON visualization_artifacts
    WHEN EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'retired visualization owner'); END`;
  yield* sql`CREATE TRIGGER visualization_history_tombstone
    BEFORE INSERT ON visualization_history
    WHEN EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN SELECT RAISE(ABORT, 'retired visualization owner'); END`;
  // Ready source, poster and metadata are immutable. Retirement changes only
  // lifecycle state; no replacement or rebind can rewrite published bytes.
  yield* sql`CREATE TRIGGER visualization_artifact_immutable
    BEFORE UPDATE ON visualization_artifacts WHEN OLD.state IN ('ready','retired')
      AND ((NEW.state != OLD.state AND NOT(OLD.state = 'ready' AND NEW.state = 'retired'))
        OR NEW.revision_id != OLD.revision_id OR NEW.artifact_id != OLD.artifact_id
        OR NEW.kind != OLD.kind OR NEW.thread_id != OLD.thread_id
        OR NEW.provider_instance_id != OLD.provider_instance_id
        OR NEW.session_generation != OLD.session_generation OR NEW.request_id != OLD.request_id
        OR NEW.input_sha256 != OLD.input_sha256 OR NEW.manifest_sha256 != OLD.manifest_sha256
        OR NEW.content_sha256 != OLD.content_sha256
        OR NEW.source != OLD.source OR NEW.assets_json != OLD.assets_json
        OR NEW.reference_json != OLD.reference_json OR NEW.diagnostics_json != OLD.diagnostics_json
        OR NEW.private_json != OLD.private_json OR NEW.poster IS NOT OLD.poster
        OR NEW.poster_sha256 IS NOT OLD.poster_sha256 OR NEW.byte_length != OLD.byte_length
        OR NEW.created_at != OLD.created_at OR NEW.failure_reason IS NOT OLD.failure_reason)
    BEGIN SELECT RAISE(ABORT, 'immutable visualization revision'); END`;
  yield* sql`CREATE TRIGGER visualization_history_immutable
    BEFORE UPDATE ON visualization_history
    BEGIN SELECT RAISE(ABORT, 'immutable visualization reference'); END`;
  // Explicit deletion revokes producer and read authority atomically. Physical
  // byte reclamation is a separate bounded sweep, after the final reference dies.
  yield* sql`CREATE TRIGGER visualization_hard_delete
    AFTER INSERT ON hard_deleted_threads
    BEGIN
      UPDATE visualization_session_capabilities SET active = 0 WHERE thread_id = NEW.thread_id;
      DELETE FROM visualization_history WHERE thread_id = NEW.thread_id;
      DELETE FROM visualization_invocations WHERE thread_id = NEW.thread_id;
      DELETE FROM visualization_viewer_tickets WHERE thread_id = NEW.thread_id;
      UPDATE visualization_artifacts SET state = 'retired'
        WHERE state = 'ready'
          AND NOT EXISTS(SELECT 1 FROM visualization_history h WHERE h.revision_id = visualization_artifacts.revision_id)
          AND NOT EXISTS(SELECT 1 FROM visualization_invocations i WHERE i.revision_id = visualization_artifacts.revision_id AND i.native_call_key IS NULL);
    END`;
});
