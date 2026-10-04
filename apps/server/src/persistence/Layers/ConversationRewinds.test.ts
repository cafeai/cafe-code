import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeConversationRewindStore } from "./ConversationRewinds.ts";
import { isPendingConversationRewind } from "../Services/ConversationRewinds.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";

const timestamp = "2026-10-04T00:00:00.000Z";
const identity = {
  threadId: ThreadId.make("rewind-thread"),
  operationId: "2d157a02-7309-45ee-8b1c-4bf5da146a51",
};
const otherOperation = "8b1a0e40-9a0e-46f0-89c7-4d0657595275";
const original: ProviderSession = {
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claude-primary"),
  threadId: identity.threadId,
  subagentRuntimeId: "e1904de9-a6e5-42b6-80dc-ea37a03ab616",
  status: "ready",
  runtimeMode: "approval-required",
  cwd: "/synthetic-inert-workspace",
  resumeCursor: { resume: "synthetic-original", turnCount: 3 },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const candidate: ProviderSession = {
  provider: original.provider,
  providerInstanceId: original.providerInstanceId!,
  threadId: identity.threadId,
  status: "closed",
  runtimeMode: original.runtimeMode,
  cwd: original.cwd!,
  resumeCursor: { resume: "synthetic-retained", turnCount: 1 },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const prepareInput = {
  ...identity,
  numTurns: 2,
  firstRemovedTurnId: TurnId.make("first-removed-turn"),
  retainedTurnCount: 1,
  expectedControlSequence: 1,
};

// These helpers populate the real migrated schema. They contain no provider
// credentials, child processes or user data; all ids/cursors are synthetic.
const writeEvent = (
  sql: SqlClient.SqlClient,
  input: {
    sequence: number;
    streamId?: string;
    eventType?: string;
    actor?: string;
    commandId?: string;
    turnCount?: number;
  },
) => {
  const streamId = input.streamId ?? identity.threadId;
  const commandId = input.commandId ?? `command-${input.sequence}`;
  return sql`
    INSERT INTO orchestration_events
      (sequence,event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,
       command_id,actor_kind,payload_json,metadata_json)
    VALUES (${input.sequence},${`event-${input.sequence}`},'thread',${streamId},${input.sequence},
      ${input.eventType ?? "thread.checkpoint-revert-requested"},${timestamp},${commandId},
      ${input.actor ?? "server"},${JSON.stringify({ threadId: streamId, turnCount: input.turnCount ?? 1 })},'{}')
  `;
};
const seedRuntime = (sql: SqlClient.SqlClient) => sql`
  INSERT INTO provider_session_runtime
    (thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,
      resume_cursor_json,runtime_payload_json)
  VALUES (${identity.threadId},${original.provider},${original.providerInstanceId!},'adapter',
    ${original.runtimeMode},'ready',${timestamp},${JSON.stringify(original.resumeCursor)},
    ${JSON.stringify({ subagentRuntimeId: original.subagentRuntimeId, activeTurnId: null, retainedTag: "preserved" })})
`;
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* seedRuntime(sql);
  yield* writeEvent(sql, { sequence: 1 });
  return { sql, store: makeConversationRewindStore(sql) };
});
const runtimeRows = (sql: SqlClient.SqlClient) => sql<{
  status: string;
  cursor: string;
  payload: string;
}>`SELECT status,resume_cursor_json AS cursor,runtime_payload_json AS payload
   FROM provider_session_runtime WHERE thread_id=${identity.threadId}`;
const eventFor = (
  patch: Partial<Pick<ProviderRuntimeEvent, "subagentRuntimeId" | "providerInstanceId">> = {},
): ProviderRuntimeEvent => ({
  eventId: EventId.make("runtime-event"),
  provider: original.provider,
  providerInstanceId: original.providerInstanceId!,
  subagentRuntimeId: original.subagentRuntimeId!,
  threadId: identity.threadId,
  createdAt: timestamp,
  type: "session.started",
  payload: {},
  ...patch,
});

describe("ConversationRewinds", () => {
  it.effect(
    "reserves only the exact durable session owner, generation, cursor and control boundary",
    () =>
      Effect.gen(function* () {
        const { sql, store } = yield* fixture;
        for (const wrong of [
          { ...original, threadId: ThreadId.make("other-thread") },
          { ...original, provider: ProviderDriverKind.make("codex") },
          { ...original, providerInstanceId: ProviderInstanceId.make("other-account") },
          { ...original, subagentRuntimeId: "0ce6c0e7-dcdc-4d89-aacb-110610fca13c" },
          { ...original, resumeCursor: { resume: "changed-cursor", turnCount: 3 } },
          { ...original, status: "running" as const },
          { ...original, activeTurnId: TurnId.make("active-turn") },
        ])
          assert.isFalse(yield* store.reserve(prepareInput, wrong));
        assert.isNull(yield* store.read(identity.threadId));
        yield* writeEvent(sql, { sequence: 2, eventType: "thread.runtime-mode-set" });
        assert.isFalse(yield* store.reserve(prepareInput, original));
        assert.isTrue(
          yield* store.reserve({ ...prepareInput, expectedControlSequence: 2 }, original),
        );
        assert.isFalse(
          yield* store.reserve(
            { ...prepareInput, operationId: otherOperation, expectedControlSequence: 2 },
            original,
          ),
        );
        assert.equal((yield* store.read(identity.threadId))?.operationId, identity.operationId);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("rejects a candidate from another identity or a still-live native context", () =>
    Effect.gen(function* () {
      const { store } = yield* fixture;
      assert.isTrue(yield* store.reserve(prepareInput, original));
      for (const wrong of [
        { ...candidate, threadId: ThreadId.make("other-thread") },
        { ...candidate, provider: ProviderDriverKind.make("codex") },
        { ...candidate, providerInstanceId: ProviderInstanceId.make("other-account") },
        { ...candidate, cwd: "/different-inert-workspace" },
        { ...candidate, status: "ready" as const },
        { ...candidate, subagentRuntimeId: original.subagentRuntimeId! },
        { ...candidate, activeTurnId: TurnId.make("active-turn") },
      ])
        assert.isFalse(yield* store.prepared(identity, wrong));
      assert.equal((yield* store.read(identity.threadId))?.phase, "preparing");
      assert.isTrue(yield* store.prepared(identity, candidate));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "switches candidate cursor and committed fence atomically, preserving unrelated runtime metadata",
    () =>
      Effect.gen(function* () {
        const { sql, store } = yield* fixture;
        const before = yield* runtimeRows(sql);
        assert.isFalse(yield* store.commit(identity));
        assert.isTrue(yield* store.reserve(prepareInput, original));
        assert.isFalse(yield* store.commit(identity));
        assert.isFalse(
          yield* store.prepared({ ...identity, operationId: otherOperation }, candidate),
        );
        assert.isTrue(yield* store.prepared(identity, candidate));
        assert.isFalse(yield* store.prepared(identity, candidate));
        assert.isFalse(
          yield* store.finish({ ...identity, outcome: "committed", completionCommandId: "absent" }),
        );
        assert.deepEqual(yield* runtimeRows(sql), before);
        assert.isTrue(yield* store.commit(identity));
        const rows = yield* runtimeRows(sql);
        assert.equal(rows[0]?.status, "stopped");
        assert.deepEqual(JSON.parse(rows[0]!.cursor), candidate.resumeCursor);
        const payload = JSON.parse(rows[0]!.payload);
        assert.equal(payload.retainedTag, "preserved");
        assert.isUndefined(payload.subagentRuntimeId);
        assert.isUndefined(payload.activeTurnId);
        assert.equal((yield* store.read(identity.threadId))?.phase, "committed");
        assert.isFalse(yield* store.commit(identity));
        assert.isFalse(yield* store.finish({ ...identity, outcome: "aborted" }));
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "retains the original cursor and prepared fence when a newer user control rejects commit",
    () =>
      Effect.gen(function* () {
        const { sql, store } = yield* fixture;
        yield* store.reserve(prepareInput, original);
        yield* store.prepared(identity, candidate);
        yield* writeEvent(sql, { sequence: 2, eventType: "thread.runtime-mode-set" });
        assert.isFalse(yield* store.commit(identity));
        assert.equal((yield* store.read(identity.threadId))?.phase, "prepared");
        assert.deepEqual(JSON.parse((yield* runtimeRows(sql))[0]!.cursor), original.resumeCursor);
        assert.isTrue(yield* store.finish({ ...identity, outcome: "aborted" }));
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  for (const phase of ["preparing", "prepared", "committed"] as const) {
    it.effect(`blocks ordinary runtime writers and deletion while ${phase}`, () =>
      Effect.gen(function* () {
        const { sql, store } = yield* fixture;
        yield* store.reserve(prepareInput, original);
        if (phase !== "preparing") yield* store.prepared(identity, candidate);
        if (phase === "committed") yield* store.commit(identity);
        for (const mutation of [
          sql`UPDATE provider_session_runtime SET status='ready' WHERE thread_id=${identity.threadId}`,
          sql`DELETE FROM provider_session_runtime WHERE thread_id=${identity.threadId}`,
        ])
          assert.equal((yield* Effect.exit(mutation))._tag, "Failure");
        assert.equal((yield* store.read(identity.threadId))?.phase, phase);
        // Only permanent hard-delete authority may remove a pending binding.
        yield* sql`INSERT INTO hard_deleted_threads (thread_id,deleted_at) VALUES (${identity.threadId},${timestamp})`;
        yield* sql`DELETE FROM provider_session_runtime WHERE thread_id=${identity.threadId}`;
        assert.isNull(yield* store.read(identity.threadId));
        assert.isFalse(yield* store.reserve(prepareInput, original));
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );
  }

  it.effect(
    "releases only the exact refused reservation while preserving generation replay guards",
    () =>
      Effect.gen(function* () {
        const { store } = yield* fixture;
        yield* store.reserve(prepareInput, original);
        assert.isFalse(yield* store.refuse({ ...identity, operationId: otherOperation }));
        assert.isTrue(yield* store.refuse(identity));
        assert.equal((yield* store.read(identity.threadId))?.phase, "refused");
        assert.isFalse(isPendingConversationRewind(yield* store.read(identity.threadId)));
        assert.isTrue(yield* store.acceptsEvent(eventFor()));
        assert.isFalse(
          yield* store.acceptsEvent(
            eventFor({ subagentRuntimeId: "0ce6c0e7-dcdc-4d89-aacb-110610fca13c" }),
          ),
        );
        yield* store.reserve(prepareInput, original);
        yield* store.prepared(identity, candidate);
        assert.isFalse(yield* store.refuse(identity));
        assert.isTrue(isPendingConversationRewind(yield* store.read(identity.threadId)));
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "admits only the exact original preparing generation and classifies proven retirement separately",
    () =>
      Effect.gen(function* () {
        const { store } = yield* fixture;
        yield* store.reserve(prepareInput, original);
        assert.equal(yield* store.classifyEvent(eventFor()), "accepted");
        const { subagentRuntimeId: _generation, ...legacyEvent } = eventFor();
        for (const event of [
          legacyEvent,
          eventFor({ subagentRuntimeId: "0ce6c0e7-dcdc-4d89-aacb-110610fca13c" }),
          eventFor({ providerInstanceId: ProviderInstanceId.make("other-account") }),
          { ...eventFor(), provider: ProviderDriverKind.make("codex") },
        ]) {
          assert.equal(yield* store.classifyEvent(event), "pending");
          assert.isFalse(yield* store.acceptsEvent(event));
        }
        yield* store.prepared(identity, candidate);
        assert.equal(yield* store.classifyEvent(eventFor()), "retired");
        assert.equal(yield* store.classifyEvent(legacyEvent), "pending");
        assert.isFalse(yield* store.refuse(identity));
        yield* store.commit(identity);
        assert.equal(yield* store.classifyEvent(eventFor()), "retired");
        assert.equal(yield* store.classifyEvent(legacyEvent), "pending");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  for (const failurePoint of ["cursor-write", "commit-publication"] as const) {
    it.effect(`rolls back the cursor and phase together after ${failurePoint} failure`, () =>
      Effect.gen(function* () {
        const { sql, store } = yield* fixture;
        yield* store.reserve(prepareInput, original);
        yield* store.prepared(identity, candidate);
        const before = yield* runtimeRows(sql);
        if (failurePoint === "cursor-write")
          yield* sql`
          CREATE TRIGGER synthetic_rewind_failure BEFORE UPDATE ON provider_session_runtime
          WHEN NEW.status='stopped' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END
        `;
        else
          yield* sql`
          CREATE TRIGGER synthetic_rewind_failure BEFORE UPDATE ON provider_conversation_rewinds
          WHEN NEW.phase='committed' BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END
        `;
        assert.equal((yield* Effect.exit(store.commit(identity)))._tag, "Failure");
        assert.deepEqual(yield* runtimeRows(sql), before);
        assert.equal((yield* store.read(identity.threadId))?.phase, "prepared");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );
  }

  for (const mismatch of [
    "missing-proof",
    "missing-event",
    "wrong-stream",
    "wrong-turn-count",
    "rejected-receipt",
    "wrong-result-sequence",
    "wrong-receipt-owner",
    "wrong-receipt-kind",
    "nonserver-event",
    "wrong-event-type",
  ] as const) {
    it.effect(`rejects ${mismatch} as proof that reverted projection was accepted`, () =>
      Effect.gen(function* () {
        const { sql, store } = yield* fixture;
        yield* store.reserve(prepareInput, original);
        yield* store.prepared(identity, candidate);
        yield* store.commit(identity);
        const commandId = "completion-proof";
        if (mismatch !== "missing-event")
          yield* writeEvent(sql, {
            sequence: 2,
            commandId,
            streamId: mismatch === "wrong-stream" ? "other-thread" : identity.threadId,
            eventType: mismatch === "wrong-event-type" ? "thread.meta-updated" : "thread.reverted",
            turnCount: mismatch === "wrong-turn-count" ? 2 : 1,
            actor: mismatch === "nonserver-event" ? "provider" : "server",
          });
        yield* sql`INSERT INTO orchestration_command_receipts
          (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status)
          VALUES (${commandId},${mismatch === "wrong-receipt-kind" ? "project" : "thread"},
            ${mismatch === "wrong-receipt-owner" ? "other-thread" : identity.threadId},${timestamp},
            ${mismatch === "wrong-result-sequence" ? 3 : 2},${mismatch === "rejected-receipt" ? "rejected" : "accepted"})`;
        assert.isFalse(
          yield* store.finish({
            ...identity,
            outcome: "committed",
            ...(mismatch === "missing-proof" ? {} : { completionCommandId: commandId }),
          }),
        );
        assert.equal((yield* store.read(identity.threadId))?.phase, "committed");
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );
  }

  it.effect(
    "releases only a matching accepted completion and keeps old generation events fenced",
    () =>
      Effect.gen(function* () {
        const { sql, store } = yield* fixture;
        assert.isTrue(yield* store.acceptsEvent(eventFor()));
        yield* store.reserve(prepareInput, original);
        assert.equal(yield* store.classifyEvent(eventFor()), "accepted");
        yield* store.prepared(identity, candidate);
        assert.equal(yield* store.classifyEvent(eventFor()), "retired");
        assert.isFalse(yield* store.acceptsEvent(eventFor()));
        yield* store.commit(identity);
        assert.isFalse(yield* store.acceptsEvent(eventFor()));
        yield* writeEvent(sql, {
          sequence: 2,
          eventType: "thread.reverted",
          commandId: "completion-proof",
        });
        yield* sql`INSERT INTO orchestration_command_receipts
        (command_id,aggregate_kind,aggregate_id,accepted_at,result_sequence,status)
        VALUES ('completion-proof','thread',${identity.threadId},${timestamp},2,'accepted')`;
        assert.isFalse(
          yield* store.finish({
            ...identity,
            operationId: otherOperation,
            outcome: "committed",
            completionCommandId: "completion-proof",
          }),
        );
        assert.isTrue(
          yield* store.finish({
            ...identity,
            outcome: "committed",
            completionCommandId: "completion-proof",
          }),
        );
        assert.isFalse(isPendingConversationRewind(yield* store.read(identity.threadId)));
        assert.isFalse(
          yield* store.finish({
            ...identity,
            outcome: "committed",
            completionCommandId: "completion-proof",
          }),
        );
        const current = "0ce6c0e7-dcdc-4d89-aacb-110610fca13c";
        yield* sql`UPDATE provider_session_runtime SET runtime_payload_json=${JSON.stringify({ subagentRuntimeId: current })}
        WHERE thread_id=${identity.threadId}`;
        const before = yield* store.read(identity.threadId);
        assert.isFalse(yield* store.acceptsEvent(eventFor()));
        const missingGeneration = eventFor();
        const { subagentRuntimeId: _retiredGeneration, ...legacyEvent } = missingGeneration;
        assert.isFalse(yield* store.acceptsEvent(legacyEvent));
        assert.isFalse(
          yield* store.acceptsEvent(
            eventFor({
              subagentRuntimeId: current,
              providerInstanceId: ProviderInstanceId.make("other-account"),
            }),
          ),
        );
        assert.isTrue(yield* store.acceptsEvent(eventFor({ subagentRuntimeId: current })));
        assert.deepEqual(yield* store.read(identity.threadId), before);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "reconstructs the pending fence from a closed and reopened isolated SQLite database",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-rewind-store-" });
        const dbPath = path.join(directory, "rewind.sqlite");
        yield* Effect.gen(function* () {
          const { store } = yield* fixture;
          yield* store.reserve(prepareInput, original);
          yield* store.prepared(identity, candidate);
        }).pipe(Effect.provide(makeSqlitePersistenceLive(dbPath)), Effect.scoped);
        // This is a new client/store after the first client scope has retired.
        // No daemon process or provider is needed to establish durable fencing.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = makeConversationRewindStore(sql);
          const state = yield* store.read(identity.threadId);
          assert.equal(state?.phase, "prepared");
          assert.deepEqual(state?.candidate, candidate);
          assert.isTrue(isPendingConversationRewind(state));
          assert.isFalse(
            yield* store.reserve({ ...prepareInput, operationId: otherOperation }, original),
          );
          assert.equal(
            (yield* Effect.exit(
              sql`UPDATE provider_session_runtime SET status='ready' WHERE thread_id=${identity.threadId}`,
            ))._tag,
            "Failure",
          );
          assert.isTrue(yield* store.commit(identity));
        }).pipe(Effect.provide(makeSqlitePersistenceLive(dbPath)), Effect.scoped);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const store = makeConversationRewindStore(sql);
          assert.equal((yield* store.read(identity.threadId))?.phase, "committed");
          assert.deepEqual(
            JSON.parse((yield* runtimeRows(sql))[0]!.cursor),
            candidate.resumeCursor,
          );
          assert.isFalse(yield* store.finish({ ...identity, outcome: "committed" }));
        }).pipe(Effect.provide(makeSqlitePersistenceLive(dbPath)), Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
