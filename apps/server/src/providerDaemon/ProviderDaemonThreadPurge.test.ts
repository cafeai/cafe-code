import {
  EventId,
  ProviderDaemonRpcRequest,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ProviderDaemonRpcRequest as ProviderDaemonRpcRequestValue,
  type ProviderRuntimeEvent as ProviderRuntimeEventValue,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeProviderDaemonCommandLedger } from "./CommandLedger.ts";
import { makePersistentProviderDaemonEventJournal } from "./EventJournal.ts";
import { purgeProviderDaemonThreadPersistence } from "./ProviderDaemonThreadPurge.ts";

const encodeRequestJson = Schema.encodeSync(Schema.fromJsonString(ProviderDaemonRpcRequest));
const encodeEventJson = Schema.encodeSync(Schema.fromJsonString(ProviderRuntimeEvent));

function runtimeEvent(
  eventId: string,
  threadId: ThreadId,
  message: string,
): ProviderRuntimeEventValue {
  return {
    eventId: EventId.make(eventId),
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId,
    createdAt: "2026-08-31T00:00:00.000Z",
    type: "session.started",
    payload: { message },
  };
}

function sendRequest(
  commandId: string,
  threadId: ThreadId,
  input: string,
): ProviderDaemonRpcRequestValue {
  return {
    method: "sendTurn",
    commandId,
    payload: { threadId, input, attachments: [] },
  };
}

function steerRequest(
  commandId: string,
  threadId: ThreadId,
  input: string,
): ProviderDaemonRpcRequestValue {
  return {
    method: "steerTurn",
    commandId,
    payload: {
      threadId,
      expectedTurnId: TurnId.make("turn-active"),
      input,
      attachments: [],
    },
  };
}

function discardForkRequest(
  commandId: string,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  secretTitle: string,
): ProviderDaemonRpcRequestValue {
  return {
    method: "discardSessionFork",
    commandId,
    payload: {
      fork: {
        operationId: `operation-${commandId}`,
        sourceThreadId,
        targetThreadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        resumeCursor: {
          threadId: `provider-${secretTitle}`,
        },
      },
    },
  };
}

describe("ProviderDaemonThreadPurge", () => {
  it("purges typed event/send/steer bodies and permanently fences recreation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* makeProviderDaemonCommandLedger();
        const journal = yield* makePersistentProviderDaemonEventJournal({
          ownerKey: "provider-daemon",
          capacity: 100,
          startupPruneDelayMs: 60_000,
        });
        const target = ThreadId.make("thread-private-purge");
        const survivor = ThreadId.make("thread-survivor-purge");
        const executeCount = yield* Ref.make(0);
        const execute = Ref.update(executeCount, (count) => count + 1).pipe(
          Effect.as({ ok: true, value: null } as const),
        );
        const executeWithPrivateResponse = Ref.update(executeCount, (count) => count + 1).pipe(
          Effect.as({ ok: true, value: "private command response sentinel" } as const),
        );

        yield* ledger.runOnce(
          sendRequest(
            "command-private-send-000000000000000",
            target,
            "private send prompt sentinel",
          ),
          executeWithPrivateResponse,
        );
        yield* ledger.runOnce(
          steerRequest(
            "command-private-steer-00000000000000",
            target,
            "private steer prompt sentinel",
          ),
          execute,
        );
        yield* ledger.runOnce(
          sendRequest("command-survivor-send-0000000000000", survivor, "survivor prompt sentinel"),
          execute,
        );
        yield* journal.publish(
          runtimeEvent("event-private-output", target, "private output sentinel"),
        );
        yield* journal.publish(
          runtimeEvent("event-survivor-output", survivor, "survivor output sentinel"),
        );

        yield* purgeProviderDaemonThreadPersistence({ threadId: target });

        const bodies = yield* sql<{ readonly body: string }>`
          SELECT event_json AS body FROM provider_daemon_events
          UNION ALL
          SELECT request_json AS body FROM provider_daemon_commands
          UNION ALL
          SELECT COALESCE(response_json, '') AS body FROM provider_daemon_commands
        `;
        const persistedText = bodies.map((row) => row.body).join("\n");
        expect(persistedText).not.toContain("private send prompt sentinel");
        expect(persistedText).not.toContain("private steer prompt sentinel");
        expect(persistedText).not.toContain("private output sentinel");
        expect(persistedText).not.toContain("private command response sentinel");
        expect(persistedText).toContain("survivor prompt sentinel");
        expect(persistedText).toContain("survivor output sentinel");

        const rejectedSend = yield* ledger.runOnce(
          sendRequest(
            "command-late-send-00000000000000000",
            target,
            "must never persist late send",
          ),
          execute,
        );
        const rejectedSteer = yield* ledger.runOnce(
          steerRequest(
            "command-late-steer-0000000000000000",
            target,
            "must never persist late steer",
          ),
          execute,
        );
        expect(rejectedSend).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonThreadRetired" },
        });
        expect(rejectedSteer).toMatchObject({
          ok: false,
          error: { tag: "ProviderDaemonThreadRetired" },
        });
        expect(yield* Ref.get(executeCount)).toBe(3);

        const lateEventExit = yield* Effect.exit(
          journal.publish(
            runtimeEvent("event-late-private", target, "must never persist late event"),
          ),
        );
        expect(lateEventExit._tag).toBe("Failure");
        const lateBodies = yield* sql<{ readonly matches: number }>`
          SELECT
            (SELECT COUNT(*) FROM provider_daemon_commands
             WHERE request_json LIKE '%must never persist%')
            +
            (SELECT COUNT(*) FROM provider_daemon_events
             WHERE event_json LIKE '%must never persist%') AS matches
        `;
        // LIKE is acceptable only as a test assertion. Production deletion
        // authority is exclusively typed sidecar identity.
        expect(lateBodies[0]?.matches).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("strictly decodes retained pre-071 rows on demand and preserves other threads", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const target = ThreadId.make("thread-legacy-private");
        const survivor = ThreadId.make("thread-legacy-survivor");
        const targetRequest = sendRequest(
          "command-legacy-private-0000000000000",
          target,
          "legacy private prompt",
        );
        const survivorRequest = sendRequest(
          "command-legacy-survivor-00000000000",
          survivor,
          "legacy survivor prompt",
        );

        yield* sql`
          INSERT INTO provider_daemon_events (owner_key, emitted_at, event_json)
          VALUES
            ('provider-daemon', '2026-08-31T00:00:00.000Z', ${encodeEventJson(
              runtimeEvent("event-legacy-private", target, "legacy private output"),
            )}),
            ('provider-daemon', '2026-08-31T00:00:01.000Z', ${encodeEventJson(
              runtimeEvent("event-legacy-survivor", survivor, "legacy survivor output"),
            )})
        `;
        const legacyEventRows = yield* sql<{ readonly cursor: number }>`
          SELECT cursor
          FROM provider_daemon_events
          ORDER BY cursor ASC
        `;
        const legacyTargetCursor = legacyEventRows[0]?.cursor;
        const legacySurvivorCursor = legacyEventRows[1]?.cursor;
        if (legacyTargetCursor === undefined || legacySurvivorCursor === undefined) {
          throw new Error("legacy event fixture did not return both cursors");
        }
        yield* sql`
          INSERT INTO provider_daemon_event_quarantine (
            owner_key, cursor, emitted_at, encoded_bytes,
            sha256, category, quarantined_at
          ) VALUES
            ('provider-daemon', ${legacyTargetCursor}, '2026-08-31T00:00:00.000Z',
             10, 'legacy-private-sha', 'schema-decode-failed', '2026-08-31T00:00:00.000Z'),
            ('provider-daemon', ${legacySurvivorCursor}, '2026-08-31T00:00:01.000Z',
             10, 'legacy-survivor-sha', 'schema-decode-failed', '2026-08-31T00:00:01.000Z')
        `;
        yield* sql`
          INSERT INTO provider_daemon_commands (
            command_id, method, status, request_json, response_json, created_at, updated_at
          ) VALUES
            (
              'provider-daemon:legacy-private', 'sendTurn', 'completed',
              ${encodeRequestJson(targetRequest)}, '{"ok":true,"value":"legacy private response"}',
              '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z'
            ),
            (
              'provider-daemon:legacy-survivor', 'sendTurn', 'completed',
              ${encodeRequestJson(survivorRequest)}, '{"ok":true,"value":null}',
              '2026-08-31T00:00:01.000Z', '2026-08-31T00:00:01.000Z'
            )
        `;

        yield* purgeProviderDaemonThreadPersistence({ threadId: target });

        const bodies = yield* sql<{ readonly body: string }>`
          SELECT event_json AS body FROM provider_daemon_events
          UNION ALL
          SELECT request_json AS body FROM provider_daemon_commands
        `;
        const persistedText = bodies.map((row) => row.body).join("\n");
        expect(persistedText).not.toContain("legacy private");
        expect(persistedText).toContain("legacy survivor prompt");
        expect(persistedText).toContain("legacy survivor output");
        const quarantineRows = yield* sql<{ readonly cursor: number }>`
          SELECT cursor
          FROM provider_daemon_event_quarantine
          ORDER BY cursor ASC
        `;
        expect(quarantineRows).toEqual([{ cursor: legacySurvivorCursor }]);

        const identities = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId" FROM provider_daemon_event_threads
          UNION ALL
          SELECT thread_id AS "threadId" FROM provider_daemon_command_threads
        `;
        expect(identities.map((row) => row.threadId)).toEqual([survivor, survivor]);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("binds fork-discard bodies to both source and target identities", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ledger = yield* makeProviderDaemonCommandLedger();
        const deleteSource = ThreadId.make("thread-discard-delete-source");
        const deleteTarget = ThreadId.make("thread-discard-delete-target");
        const retainedSource = ThreadId.make("thread-discard-retained-source");
        const retainedTarget = ThreadId.make("thread-discard-retained-target");
        const unrelatedSource = ThreadId.make("thread-discard-unrelated-source");
        const unrelatedTarget = ThreadId.make("thread-discard-unrelated-target");
        const execute = Effect.succeed({ ok: true, value: null } as const);

        yield* ledger.runOnce(
          discardForkRequest(
            "command-discard-source-00000000000000",
            deleteSource,
            retainedTarget,
            "private-source-discard",
          ),
          execute,
        );
        yield* ledger.runOnce(
          discardForkRequest(
            "command-discard-target-00000000000000",
            retainedSource,
            deleteTarget,
            "private-target-discard",
          ),
          execute,
        );
        yield* ledger.runOnce(
          discardForkRequest(
            "command-discard-unrelated-00000000000",
            unrelatedSource,
            unrelatedTarget,
            "unrelated-discard",
          ),
          execute,
        );

        yield* purgeProviderDaemonThreadPersistence({ threadId: deleteSource });
        yield* purgeProviderDaemonThreadPersistence({ threadId: deleteTarget });

        const rows = yield* sql<{ readonly requestJson: string }>`
          SELECT request_json AS "requestJson"
          FROM provider_daemon_commands
          ORDER BY command_id ASC
        `;
        const bodies = rows.map((row) => row.requestJson).join("\n");
        expect(bodies).not.toContain("private-source-discard");
        expect(bodies).not.toContain("private-target-discard");
        expect(bodies).toContain("unrelated-discard");
        const identities = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM provider_daemon_command_threads
          ORDER BY thread_id ASC
        `;
        expect(identities.map((row) => row.threadId)).toEqual(
          [unrelatedSource, unrelatedTarget].toSorted(),
        );
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("purges provider-private rows from an independently owned daemon store", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const target = ThreadId.make("thread-separate-daemon-private");
        const survivor = ThreadId.make("thread-separate-daemon-survivor");
        const journal = yield* makePersistentProviderDaemonEventJournal({
          ownerKey: "provider-daemon",
          capacity: 100,
          startupPruneDelayMs: 60_000,
        });
        const targetEvent = yield* journal.publish(
          runtimeEvent("event-separate-daemon-private", target, "daemon private event"),
        );
        const survivorEvent = yield* journal.publish(
          runtimeEvent("event-separate-daemon-survivor", survivor, "daemon survivor event"),
        );

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, branch, worktree_path,
            latest_turn_id, created_at, updated_at
          ) VALUES
            (${target}, 'project-daemon-purge', 'Private', NULL, NULL, NULL,
             '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z'),
            (${survivor}, 'project-daemon-purge', 'Survivor', NULL, NULL, NULL,
             '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO provider_session_runtime (
            thread_id, provider_name, adapter_key, runtime_mode, status,
            last_seen_at, resume_cursor_json, runtime_payload_json
          ) VALUES
            (${target}, 'codex', 'codex:default', 'full-access', 'running',
             '2026-08-31T00:00:00.000Z', '{"secret":"private resume cursor"}',
             '{"secret":"private runtime payload"}'),
            (${survivor}, 'codex', 'codex:default', 'full-access', 'running',
             '2026-08-31T00:00:00.000Z', '{"secret":"survivor resume cursor"}',
             '{"secret":"survivor runtime payload"}')
        `;
        yield* sql`
          INSERT INTO provider_subagent_history_roots (
            thread_id, turn_id, provider_name, provider_instance_id,
            resume_cursor_json, cwd, created_at, updated_at
          ) VALUES
            (${target}, 'turn-private', 'codex', 'codex',
             '{"secret":"private subagent cursor"}', '/private/workspace',
             '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z'),
            (${survivor}, 'turn-survivor', 'codex', 'codex',
             '{"secret":"survivor subagent cursor"}', '/survivor/workspace',
             '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO provider_subagent_history_bindings (
            thread_id, turn_id, subagent_id, history_id, created_at, updated_at
          ) VALUES
            (${target}, 'turn-private', 'child-private', 'history-private',
             '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z'),
            (${survivor}, 'turn-survivor', 'child-survivor', 'history-survivor',
             '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO provider_supervisor_sessions (
            session_id, supervisor_id, owner_id, owner_kind, thread_id,
            provider_instance_id, provider_kind, provider_pid, command_display,
            cwd, socket_path, protocol_version, io_generation, raw_byte_cursor,
            parser_cursor, transfer_state, created_at, updated_at
          ) VALUES
            ('session-private', 'supervisor', 'owner-private', 'daemon', ${target},
             'codex', 'codex', 100, 'private command display', '/private/cwd',
             '/private/socket', 1, 1, 0, 0, 'attached',
             '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z'),
            ('session-survivor', 'supervisor', 'owner-survivor', 'daemon', ${survivor},
             'codex', 'codex', 101, 'survivor command display', '/survivor/cwd',
             '/survivor/socket', 1, 1, 0, 0, 'attached',
             '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z')
        `;
        yield* sql`
          INSERT INTO provider_supervisor_ownership_events (
            session_id, event_type, owner_id, previous_owner_id,
            io_generation, transfer_state, emitted_at, detail_json
          ) VALUES
            ('session-private', 'attached', 'owner-private', NULL, 1, 'attached',
             '2026-08-31T00:00:00.000Z', '{"secret":"private supervisor detail"}'),
            ('session-survivor', 'attached', 'owner-survivor', NULL, 1, 'attached',
             '2026-08-31T00:00:00.000Z', '{"secret":"survivor supervisor detail"}')
        `;
        yield* sql`
          INSERT INTO provider_supervisor_io_events (
            session_id, stream_kind, byte_offset, byte_length, emitted_at, sha256
          ) VALUES
            ('session-private', 'stdout', 0, 10, '2026-08-31T00:00:00.000Z', 'private-sha'),
            ('session-survivor', 'stdout', 0, 10, '2026-08-31T00:00:00.000Z', 'survivor-sha')
        `;
        yield* sql`
          INSERT INTO provider_daemon_event_quarantine (
            owner_key, cursor, emitted_at, encoded_bytes,
            sha256, category, quarantined_at
          ) VALUES
            ('provider-daemon', ${targetEvent.cursor}, '2026-08-31T00:00:00.000Z',
             10, 'private-event-sha', 'schema-decode-failed', '2026-08-31T00:00:00.000Z'),
            ('provider-daemon', ${survivorEvent.cursor}, '2026-08-31T00:00:00.000Z',
             10, 'survivor-event-sha', 'schema-decode-failed', '2026-08-31T00:00:00.000Z')
        `;

        // This invokes only the daemon-owned purge, deliberately omitting the
        // orchestration hard-delete cleanup to model a distinct daemon DB.
        yield* purgeProviderDaemonThreadPersistence({ threadId: target });

        const counts = yield* sql<{
          readonly targetRows: number;
          readonly survivorRows: number;
          readonly targetProjection: number;
        }>`
          SELECT
            (SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = ${target})
            + (SELECT COUNT(*) FROM provider_subagent_history_roots WHERE thread_id = ${target})
            + (SELECT COUNT(*) FROM provider_subagent_history_bindings WHERE thread_id = ${target})
            + (SELECT COUNT(*) FROM provider_supervisor_sessions WHERE thread_id = ${target})
            + (SELECT COUNT(*) FROM provider_supervisor_ownership_events WHERE session_id = 'session-private')
            + (SELECT COUNT(*) FROM provider_supervisor_io_events WHERE session_id = 'session-private')
            + (SELECT COUNT(*) FROM provider_daemon_event_quarantine WHERE cursor = ${targetEvent.cursor})
              AS "targetRows",
            (SELECT COUNT(*) FROM provider_session_runtime WHERE thread_id = ${survivor})
            + (SELECT COUNT(*) FROM provider_subagent_history_roots WHERE thread_id = ${survivor})
            + (SELECT COUNT(*) FROM provider_subagent_history_bindings WHERE thread_id = ${survivor})
            + (SELECT COUNT(*) FROM provider_supervisor_sessions WHERE thread_id = ${survivor})
            + (SELECT COUNT(*) FROM provider_supervisor_ownership_events WHERE session_id = 'session-survivor')
            + (SELECT COUNT(*) FROM provider_supervisor_io_events WHERE session_id = 'session-survivor')
            + (SELECT COUNT(*) FROM provider_daemon_event_quarantine WHERE cursor = ${survivorEvent.cursor})
              AS "survivorRows",
            (SELECT COUNT(*) FROM projection_threads WHERE thread_id = ${target})
              AS "targetProjection"
        `;
        expect(counts).toEqual([{ targetRows: 0, survivorRows: 7, targetProjection: 1 }]);

        // Migration 071's parent trigger is the FK-off backstop. A stale
        // supervisor callback cannot recreate detail/output metadata after
        // the thread-keyed parent session has been purged.
        yield* sql`PRAGMA foreign_keys = OFF`;
        const lateSupervisorChild = yield* Effect.result(sql`
          INSERT INTO provider_supervisor_ownership_events (
            session_id, event_type, owner_id, previous_owner_id,
            io_generation, transfer_state, emitted_at, detail_json
          ) VALUES (
            'session-private', 'late', 'owner-private', NULL,
            2, 'detached', '2026-08-31T00:01:00.000Z',
            '{"secret":"must not recreate private supervisor detail"}'
          )
        `);
        expect(lateSupervisorChild._tag).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });
});
