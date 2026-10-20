// @effect-diagnostics nodeBuiltinImport:off
import * as Schema from "effect/Schema";
import {
  EventId,
  ThreadId,
  TurnId,
  type OrchestrationThreadActivityDiagnosticInput,
  type ProviderDiagnostic,
} from "@cafecode/contracts";
import { makeProviderDiagnostic } from "@cafecode/shared/providerDiagnostic";
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceSqlError } from "../Errors.ts";
import {
  makeProviderActivityDiagnosticStore,
  providerDiagnosticOccurrenceKey,
} from "./ProviderActivityDiagnostics.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

// Preserve deliberately malformed/historical fixture values and exact native JSON bytes;
// this codec does not replace production admission or grant received-data authority.
const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFixtureJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Record(Schema.String, Schema.Unknown) })),
);

const observedAt = "2026-10-12T00:00:00.000Z";
const input = (name: string, turnId: string | null = "turn") => ({
  threadId: ThreadId.make(`diagnostic-thread-${name}`),
  turnId: turnId === null ? null : TurnId.make(`${name}-${turnId}`),
  activityId: EventId.make(`diagnostic-activity-${name}`),
});
const diagnostic = (eventId = "native-event", terminal = false): ProviderDiagnostic => {
  const error = {
    message: "Connection interrupted; request ID debug-request",
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
  };
  return makeProviderDiagnostic({
    observedAt,
    source: "codex.app-server.notification",
    method: terminal ? "turn/completed" : "error",
    status: "error",
    subject: { kind: "root" },
    native: {
      eventId,
      threadId: "native-root",
      turnId: "native-turn",
      subagentRuntimeId: "b9c6b24c-3323-4d5e-bc74-9df5b7806108",
    },
    message: error.message,
    payload: terminal
      ? { threadId: "native-root", turn: { id: "native-turn", status: "failed", error } }
      : { threadId: "native-root", turnId: "native-turn", willRetry: false, error },
  });
};
const createThread = (
  sql: SqlClient.SqlClient,
  owner: OrchestrationThreadActivityDiagnosticInput,
) =>
  sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
    VALUES (${owner.threadId}, NULL, 'Synthetic diagnostic owner', ${observedAt}, ${observedAt})`;
const createActivity = (
  sql: SqlClient.SqlClient,
  owner: OrchestrationThreadActivityDiagnosticInput,
  kind = "runtime.error",
) =>
  sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at)
    VALUES (${owner.activityId}, ${owner.threadId}, ${owner.turnId}, 'error', ${kind}, 'Provider error', '{}', ${observedAt})`;

const layer = it.layer(SqlitePersistenceMemory);
layer("ProviderActivityDiagnostics", (it) => {
  it.effect("requires the exact canonical thread, nullable turn and activity tuple", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeProviderActivityDiagnosticStore(sql);
      const owner = input("exact");
      const received = diagnostic();
      yield* createThread(sql, owner);
      yield* createActivity(sql, owner);
      assert.equal(yield* store.persist(owner, received), true);
      assert.deepEqual(yield* store.read(owner), { ...owner, diagnostic: received.snapshot });
      for (const other of [
        { ...owner, threadId: ThreadId.make("foreign-thread") },
        { ...owner, turnId: null },
        { ...owner, turnId: TurnId.make("foreign-turn") },
        { ...owner, activityId: EventId.make("foreign-activity") },
      ])
        assert.deepEqual(yield* store.read(other), { ...other, diagnostic: null });
      const nullOwner = input("nullable", null);
      yield* createThread(sql, nullOwner);
      yield* createActivity(sql, nullOwner);
      assert.equal(yield* store.persist(nullOwner, received), true);
      assert.deepEqual(yield* store.read(nullOwner), {
        ...nullOwner,
        diagnostic: received.snapshot,
      });
      assert.equal(
        (yield* store.read({ ...nullOwner, turnId: TurnId.make("not-null") })).diagnostic,
        null,
      );
    }),
  );

  it.effect(
    "an orphan private copy stays unreadable until its exact canonical activity exists",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = makeProviderActivityDiagnosticStore(sql);
        const owner = input("orphan");
        const received = diagnostic();
        yield* createThread(sql, owner);
        assert.equal(yield* store.persist(owner, received), true);
        assert.equal((yield* store.read(owner)).diagnostic, null);
        assert.equal(
          yield* store.hasTerminalEcho(owner, diagnostic("terminal-event", true)),
          false,
        );
        yield* createActivity(sql, owner);
        assert.deepEqual((yield* store.read(owner)).diagnostic, received.snapshot);
        assert.equal(yield* store.hasTerminalEcho(owner, diagnostic("terminal-event", true)), true);
      }),
  );

  it.effect(
    "neither foreign activity collisions nor later captures can rebind or replace first bytes",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = makeProviderActivityDiagnosticStore(sql);
        const owner = input("immutable");
        const foreign = { ...input("foreign"), activityId: owner.activityId };
        const received = diagnostic();
        yield* createThread(sql, owner);
        yield* createThread(sql, foreign);
        yield* createActivity(sql, owner);
        assert.equal(yield* store.persist(owner, received), true);
        assert.equal(yield* store.persist(owner, received), true);
        assert.equal(yield* store.persist(foreign, received), false);
        assert.equal(yield* store.persist(owner, diagnostic("later-event")), false);
        assert.equal((yield* store.read(foreign)).diagnostic, null);
        assert.deepEqual((yield* store.read(owner)).diagnostic, received.snapshot);
        const mutation =
          yield* sql`UPDATE provider_activity_diagnostics SET thread_id = ${foreign.threadId} WHERE activity_id = ${owner.activityId}`.pipe(
            Effect.exit,
          );
        assert.equal(Exit.isFailure(mutation), true);
        yield* sql`DELETE FROM projection_thread_activities WHERE activity_id = ${owner.activityId}`;
        yield* createActivity(sql, foreign);
        assert.equal((yield* store.read(owner)).diagnostic, null);
        assert.equal((yield* store.read(foreign)).diagnostic, null);
      }),
  );

  it.effect(
    "keeps a diagnostic insert SQL failure typed and free of private bound JSON or error prose",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = makeProviderActivityDiagnosticStore(sql);
        const owner = input("sql-failure");
        const privateProse = "synthetic-private-error-prose-do-not-log";
        const privateJson = "synthetic-private-json-do-not-log";
        const received = diagnostic();
        const privateCopy: ProviderDiagnostic = {
          ...received,
          snapshot: {
            ...received.snapshot,
            message: privateProse,
            json: encodeFixtureJson({
              error: { message: privateProse, additionalDetails: privateJson },
            }),
          },
        };
        yield* createThread(sql, owner);
        yield* createActivity(sql, owner);
        // Fail in the real isolated SQLite statement, after bound diagnostic
        // bytes were supplied. Both a driver cause and its SQL parameters can
        // be private; the public typed persistence failure must retain neither.
        yield* sql`CREATE TRIGGER provider_activity_diagnostics_test_failure
          BEFORE INSERT ON provider_activity_diagnostics
          BEGIN SELECT RAISE(ABORT, 'synthetic-private-error-prose-do-not-log'); END`;
        yield* Effect.gen(function* () {
          const result = yield* store.persist(owner, privateCopy).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            // Keep actual producer class identity, not merely structural schema/tag compatibility.
            // @effect-diagnostics-next-line instanceOfSchema:off
            assert.ok(result.failure instanceof PersistenceSqlError);
            assert.equal(result.failure._tag, "PersistenceSqlError");
            assert.equal(result.failure.operation, "ProviderActivityDiagnostics.persist");
            assert.equal(result.failure.detail, "Private diagnostic operation failed");
            assert.equal(result.failure.cause, undefined);
            for (const serialized of [
              encodeFixtureJson(result.failure),
              String(result.failure),
              result.failure.stack ?? "",
            ]) {
              assert.equal(serialized.includes(privateProse), false);
              assert.equal(serialized.includes(privateJson), false);
              assert.equal(serialized.includes(privateCopy.snapshot.json), false);
            }
          }
          assert.equal((yield* store.read(owner)).diagnostic, null);
          const activities =
            yield* sql`SELECT activity_id FROM projection_thread_activities WHERE activity_id = ${owner.activityId}`;
          assert.equal(activities.length, 1);
        }).pipe(
          Effect.ensuring(
            sql`DROP TRIGGER provider_activity_diagnostics_test_failure`.pipe(Effect.orDie),
          ),
        );
      }),
  );

  it.effect(
    "rejects oversized/invalid copies before persistence and keeps corrupt reads content-free",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = makeProviderActivityDiagnosticStore(sql);
        const owner = input("invalid");
        yield* createThread(sql, owner);
        yield* createActivity(sql, owner);
        for (const malformed of [
          { ...diagnostic(), snapshot: { ...diagnostic().snapshot, json: "x".repeat(32_769) } },
          { ...diagnostic(), snapshot: { ...diagnostic().snapshot, message: "x".repeat(4_097) } },
          { ...diagnostic(), snapshot: { ...diagnostic().snapshot, json: "x".repeat(70_000) } },
        ])
          assert.equal(yield* store.persist(owner, malformed), false);
        const rows =
          yield* sql`SELECT activity_id FROM provider_activity_diagnostics WHERE activity_id = ${owner.activityId}`;
        assert.equal(rows.length, 0);
        yield* sql`INSERT INTO provider_activity_diagnostics (activity_id, thread_id, turn_id, snapshot_json, occurrence_key, created_at)
      VALUES (${owner.activityId}, ${owner.threadId}, ${owner.turnId}, '{"private":"secret-corrupt-diagnostic"', NULL, ${observedAt})`;
        const result = yield* store.read(owner).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.equal(result.failure._tag, "PersistenceDecodeError");
          assert.doesNotMatch(
            encodeFixtureJson(result.failure),
            /secret-corrupt-diagnostic|\{"private"/,
          );
        }
      }),
  );

  it.effect(
    "tombstones hide, clean and fence all private copies without admitting stale insert replay",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = makeProviderActivityDiagnosticStore(sql);
        const owner = input("deleted");
        yield* createThread(sql, owner);
        yield* createActivity(sql, owner);
        assert.equal(yield* store.persist(owner, diagnostic()), true);
        yield* sql`INSERT INTO hard_deleted_threads (thread_id, deleted_at) VALUES (${owner.threadId}, ${observedAt})`;
        assert.equal((yield* store.read(owner)).diagnostic, null);
        assert.equal(yield* store.hasTerminalEcho(owner, diagnostic("terminal", true)), false);
        const after =
          yield* sql`SELECT activity_id FROM provider_activity_diagnostics WHERE thread_id = ${owner.threadId}`;
        assert.equal(after.length, 0);
        const stale = { ...owner, activityId: EventId.make("stale-after-delete") };
        assert.equal(yield* store.persist(stale, diagnostic()), false);
        const direct =
          yield* sql`INSERT INTO provider_activity_diagnostics (activity_id, thread_id, turn_id, snapshot_json, occurrence_key, created_at)
      VALUES (${stale.activityId}, ${stale.threadId}, ${stale.turnId}, '{}', NULL, ${observedAt})`.pipe(
            Effect.exit,
          );
        assert.equal(Exit.isFailure(direct), true);
      }),
  );

  it.effect(
    "folds only complete equal native error bodies with the exact canonical and native owner",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = makeProviderActivityDiagnosticStore(sql);
        const owner = input("echo");
        yield* createThread(sql, owner);
        yield* createActivity(sql, owner);
        const received = diagnostic();
        assert.equal(yield* store.persist(owner, received), true);
        const terminal = diagnostic("different-envelope-id", true);
        assert.equal(
          providerDiagnosticOccurrenceKey(received),
          providerDiagnosticOccurrenceKey(terminal),
        );
        assert.equal(yield* store.hasTerminalEcho(owner, terminal), true);
        // Envelope-level flags describe unrelated omitted turn data; they
        // cannot change the copied error both observations report.
        for (const flagged of [
          { ...terminal, snapshot: { ...terminal.snapshot, omittedFields: true } },
          { ...terminal, snapshot: { ...terminal.snapshot, redacted: true } },
        ])
          assert.equal(yield* store.hasTerminalEcho(owner, flagged), true);
        const withErrorJson = (error: Record<string, unknown>) => ({
          ...terminal,
          snapshot: {
            ...terminal.snapshot,
            json: encodeFixtureJson({ turn: { id: "native-turn", status: "failed", error } }),
          },
        });
        const receivedError = decodeFixtureJson(received.snapshot.json).error;
        for (const changed of [
          // A capture marker inside the error object makes the copy ambiguous.
          withErrorJson({ ...receivedError, message: "[Redacted: credential material]" }),
          withErrorJson({ ...receivedError, detail: "[Omitted: unrelated or unsupported data]" }),
          withErrorJson({
            ...receivedError,
            message: "Connection[Truncated: diagnostic capture limit]",
          }),
          {
            ...terminal,
            snapshot: {
              ...terminal.snapshot,
              native: { ...terminal.snapshot.native, threadId: "other-native-root" },
            },
          },
          {
            ...terminal,
            snapshot: {
              ...terminal.snapshot,
              native: { ...terminal.snapshot.native, turnId: "other-native-turn" },
            },
          },
          {
            ...terminal,
            snapshot: {
              ...terminal.snapshot,
              native: { ...terminal.snapshot.native, subagentRuntimeId: "other-native-generation" },
            },
          },
          {
            ...terminal,
            snapshot: {
              ...terminal.snapshot,
              native: { threadId: "native-root", turnId: "native-turn" },
            },
          },
          {
            ...terminal,
            snapshot: { ...terminal.snapshot, json: '{"error":{"message":"Different failure"}}' },
          },
        ])
          assert.equal(yield* store.hasTerminalEcho(owner, changed), false);
        assert.equal(yield* store.hasTerminalEcho({ ...owner, turnId: null }, terminal), false);
        assert.equal(
          yield* store.hasTerminalEcho(
            { ...owner, turnId: TurnId.make("foreign-canonical-turn") },
            terminal,
          ),
          false,
        );
        assert.equal(
          yield* store.hasTerminalEcho(
            { ...owner, threadId: ThreadId.make("foreign-canonical-thread") },
            terminal,
          ),
          false,
        );
        const retry = { ...received, summary: { ...received.summary, status: "retry" as const } };
        assert.equal(providerDiagnosticOccurrenceKey(retry), null);
      }),
  );

  it.effect("folds a Codex terminal turn whose envelope omits items and native timing fields", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeProviderActivityDiagnosticStore(sql);
      const owner = input("codex-terminal-shape");
      yield* createThread(sql, owner);
      yield* createActivity(sql, owner);
      const error = {
        message: "This content was flagged for possible cybersecurity risk.",
        codexErrorInfo: "cyberPolicy",
        additionalDetails: null,
        misalignment: null,
      };
      const native = {
        threadId: "native-root",
        turnId: "native-turn",
        subagentRuntimeId: "b9c6b24c-3323-4d5e-bc74-9df5b7806108",
      };
      const notification = makeProviderDiagnostic({
        observedAt,
        source: "codex.app-server.notification",
        method: "error",
        status: "error",
        subject: { kind: "root" },
        native: { eventId: "notification", ...native },
        message: error.message,
        payload: { threadId: "native-root", turnId: "native-turn", willRetry: false, error },
      });
      // Codex 0.157+ terminal turns carry items and timing; the adapter
      // copies only the error envelope and marks the rest omitted.
      const terminal = makeProviderDiagnostic({
        observedAt,
        source: "codex.app-server.notification",
        method: "turn/completed",
        status: "error",
        subject: { kind: "root" },
        native: { eventId: "terminal", ...native },
        message: error.message,
        payload: { threadId: "native-root", turn: { id: "native-turn", status: "failed", error } },
        omittedFields: true,
      });
      assert.equal(terminal.snapshot.omittedFields, true);
      assert.equal(yield* store.persist(owner, notification), true);
      assert.equal(yield* store.hasTerminalEcho(owner, terminal), true);
    }),
  );

  it.effect("folds a message-only terminal copy into the same runtime's exact error", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeProviderActivityDiagnosticStore(sql);
      const owner = input("message-echo");
      yield* createThread(sql, owner);
      yield* createActivity(sql, owner);
      const runtimeId = "c5f0aa3a-8c0d-4a7f-9a8a-3d4d9a0c1e22";
      const message = "Not logged in · Please run /login";
      const runtimeError = makeProviderDiagnostic({
        observedAt,
        source: "claudeAgent",
        method: "claude/result/error",
        status: "error",
        subject: { kind: "root" },
        native: { eventId: "runtime-error", turnId: "cafe-turn", subagentRuntimeId: runtimeId },
        message,
        payload: { error: { message, errorType: "authentication_failed" } },
      });
      const terminal = (text: string, subagentRuntimeId = runtimeId) =>
        makeProviderDiagnostic({
          observedAt,
          source: "claudeAgent",
          status: "error",
          subject: { kind: "unknown" },
          native: { eventId: "terminal", turnId: "cafe-turn", subagentRuntimeId },
          message: text,
          payload: { error: { message: text } },
        });
      assert.equal(yield* store.persist(owner, runtimeError), true);
      assert.equal(yield* store.hasTerminalEcho(owner, terminal(message)), true);
      assert.equal(yield* store.hasTerminalEcho(owner, terminal("A different failure")), false);
      assert.equal(
        yield* store.hasTerminalEcho(
          owner,
          terminal(message, "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
        ),
        false,
      );
      // Additional fields are evidence that could be lost; keep them distinct.
      const richer = makeProviderDiagnostic({
        observedAt,
        source: "claudeAgent",
        status: "error",
        subject: { kind: "unknown" },
        native: { eventId: "terminal", turnId: "cafe-turn", subagentRuntimeId: runtimeId },
        message,
        payload: { error: { message, detail: "more" } },
      });
      assert.equal(yield* store.hasTerminalEcho(owner, richer), false);
      assert.equal(
        yield* store.hasTerminalEcho({ ...owner, turnId: null }, terminal(message)),
        false,
      );
    }),
  );
});
