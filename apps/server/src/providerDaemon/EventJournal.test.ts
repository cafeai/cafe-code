import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent as ProviderRuntimeEventSchema,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  createProviderDaemonEventJournal,
  type ProviderDaemonPersistentEventJournal,
  type ProviderDaemonEventJournalSnapshot,
  makePersistentProviderDaemonEventJournal,
} from "./EventJournal.ts";

const encodeProviderRuntimeEventJsonForTest = Schema.encodeSync(
  Schema.fromJsonString(ProviderRuntimeEventSchema),
);

function makeRuntimeEvent(id: string): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(id),
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId: ThreadId.make("thread-1"),
    createdAt: "1970-01-01T00:00:00.000Z",
    type: "session.started",
    payload: {
      message: id,
    },
  };
}

function makeTurnDiffEvent(id: string, diff: string): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(id),
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    createdAt: "1970-01-01T00:00:00.000Z",
    type: "turn.diff.updated",
    raw: {
      source: "codex.app-server.notification",
      method: "turn/diff/updated",
      payload: {
        threadId: "provider-thread-1",
        turnId: "turn-1",
        diff,
      },
    },
    payload: {
      unifiedDiff: diff,
    },
  };
}

const waitForPersistentJournalCount = (
  journal: ProviderDaemonPersistentEventJournal,
  expectedCount: number,
): Effect.Effect<ProviderDaemonEventJournalSnapshot> =>
  Effect.gen(function* () {
    let snapshot = yield* journal.snapshot;
    for (
      let attempt = 0;
      attempt < 50 && snapshot.retainedEventCount !== expectedCount;
      attempt += 1
    ) {
      yield* Effect.sleep("10 millis");
      snapshot = yield* journal.snapshot;
    }
    return snapshot;
  });

const waitForPersistentEventIdIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const rows = yield* sql<{ readonly exists: number }>`
      SELECT 1 AS "exists"
      FROM sqlite_master
      WHERE type = 'index'
        AND name = 'idx_provider_daemon_events_owner_event_id'
      LIMIT 1
    `;
    if (rows.length > 0) {
      return;
    }
    yield* Effect.sleep("10 millis");
  }
  return yield* Effect.die(new Error("provider daemon event id index was not created"));
});

const waitForCompactedTurnDiffReplay = (
  journal: ProviderDaemonPersistentEventJournal,
): Effect.Effect<ProviderRuntimeEvent> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const replayed = yield* journal.replayAfter(0);
      const event = replayed[0]?.event;
      if (
        event?.type === "turn.diff.updated" &&
        event.payload.unifiedDiff.length === 4_096 &&
        ((event.raw?.payload as Record<string, unknown> | undefined)?.diff as unknown) === undefined
      ) {
        return event;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("turn diff event was not compacted"));
  });

describe("ProviderDaemonEventJournal", () => {
  it("assigns monotonic cursors and replays events after a cursor", () => {
    const journal = createProviderDaemonEventJournal({ capacity: 10 });
    const first = journal.publish(makeRuntimeEvent("event-1"));
    const second = journal.publish(makeRuntimeEvent("event-2"));

    expect(first.cursor).toBe(1);
    expect(second.cursor).toBe(2);
    expect(journal.replayAfter(1)).toEqual([second]);
    expect(journal.snapshot()).toMatchObject({
      eventCursor: 2,
      retainedEventCount: 2,
      oldestCursor: 1,
      newestCursor: 2,
    });
  });

  it("retains only the configured capacity while preserving cursor sequence", () => {
    const journal = createProviderDaemonEventJournal({ capacity: 2 });
    journal.publish(makeRuntimeEvent("event-1"));
    const second = journal.publish(makeRuntimeEvent("event-2"));
    const third = journal.publish(makeRuntimeEvent("event-3"));

    expect(journal.replayAfter(0)).toEqual([second, third]);
    expect(journal.snapshot()).toMatchObject({
      eventCursor: 3,
      retainedEventCount: 2,
      oldestCursor: 2,
      newestCursor: 3,
    });
  });

  it("stops notifying listeners after unsubscribe", () => {
    const journal = createProviderDaemonEventJournal();
    const received: number[] = [];
    const unsubscribe = journal.subscribe((record) => {
      received.push(record.cursor);
    });

    journal.publish(makeRuntimeEvent("event-1"));
    unsubscribe();
    journal.publish(makeRuntimeEvent("event-2"));

    expect(received).toEqual([1]);
  });

  it("persists events for replay from a fresh journal instance", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const firstJournal = yield* makePersistentProviderDaemonEventJournal({ capacity: 10 });
        const first = yield* firstJournal.publish(makeRuntimeEvent("event-1"));
        yield* firstJournal.publish(makeRuntimeEvent("event-2"));

        const secondJournal = yield* makePersistentProviderDaemonEventJournal({ capacity: 10 });
        const replayed = yield* secondJournal.replayAfter(first.cursor);
        const snapshot = yield* secondJournal.snapshot;

        expect(replayed.map((record) => record.event.eventId)).toEqual([EventId.make("event-2")]);
        expect(snapshot.eventCursor).toBe(2);
        expect(snapshot.retainedEventCount).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("prunes the persistent journal to its configured owner capacity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const daemonJournal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 2,
          ownerKey: "provider-daemon",
        });
        const supervisorJournal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-supervisor",
        });

        const first = yield* daemonJournal.publish(makeRuntimeEvent("event-daemon-1"));
        const second = yield* daemonJournal.publish(makeRuntimeEvent("event-daemon-2"));
        const third = yield* daemonJournal.publish(makeRuntimeEvent("event-daemon-3"));
        yield* supervisorJournal.publish(makeRuntimeEvent("event-supervisor-1"));

        expect(first.cursor).toBe(1);
        expect(second.cursor).toBe(2);
        expect(third.cursor).toBe(3);

        const replayed = yield* daemonJournal.replayAfter(0);
        const daemonSnapshot = yield* daemonJournal.snapshot;
        const supervisorSnapshot = yield* supervisorJournal.snapshot;

        expect(replayed.map((record) => record.event.eventId)).toEqual([
          EventId.make("event-daemon-2"),
          EventId.make("event-daemon-3"),
        ]);
        expect(daemonSnapshot).toMatchObject({
          eventCursor: 3,
          retainedEventCount: 2,
          oldestCursor: 2,
          newestCursor: 3,
        });
        expect(supervisorSnapshot.retainedEventCount).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("treats repeated persistent runtime event ids as idempotent replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
          startupPruneDelayMs: 0,
        });
        yield* waitForPersistentEventIdIndex;
        const first = yield* journal.publish(makeRuntimeEvent("event-replayed"));
        const duplicate = yield* journal.publish(makeRuntimeEvent("event-replayed"));
        const replayed = yield* journal.replayAfter(0);
        const snapshot = yield* journal.snapshot;

        expect(duplicate.cursor).toBe(first.cursor);
        expect(replayed.map((record) => record.event.eventId)).toEqual([
          EventId.make("event-replayed"),
        ]);
        expect(snapshot.retainedEventCount).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("compacts large turn diff events before persistent journal replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
        });
        const largeDiff = `diff --git a/file.txt b/file.txt\n${"+".repeat(300_000)}`;

        yield* journal.publish(makeTurnDiffEvent("event-large-diff", largeDiff));
        const replayed = yield* journal.replayAfter(0);
        const event = replayed[0]?.event;

        expect(event?.type).toBe("turn.diff.updated");
        if (event?.type !== "turn.diff.updated") {
          return;
        }

        const rawPayload = event.raw?.payload as Record<string, unknown> | undefined;
        expect(event.payload.unifiedDiff).toHaveLength(4_096);
        expect(rawPayload?.diff).toBeUndefined();
        expect(rawPayload?.diffPreview).toHaveLength(4_096);
        expect(rawPayload?.diffCharLength).toBe(largeDiff.length);
        expect(rawPayload?.diffTruncated).toBe(true);
        expect(rawPayload?.compactedForProviderJournal).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("compacts inherited large turn diff rows during startup maintenance", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const largeDiff = `diff --git a/file.txt b/file.txt\n${"+".repeat(300_000)}`;
        const event = makeTurnDiffEvent("event-inherited-large-diff", largeDiff);
        yield* sql`
          INSERT INTO provider_daemon_events (
            owner_key,
            emitted_at,
            event_json
          )
          VALUES (
            ${"provider-daemon"},
            ${"1970-01-01T00:00:00.000Z"},
            ${encodeProviderRuntimeEventJsonForTest(event)}
          )
        `;

        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
          startupPruneDelayMs: 0,
        });
        const compacted = yield* waitForCompactedTurnDiffReplay(journal);

        expect(compacted.type).toBe("turn.diff.updated");
        if (compacted.type !== "turn.diff.updated") {
          return;
        }
        const rawPayload = compacted.raw?.payload as Record<string, unknown> | undefined;
        expect(compacted.payload.unifiedDiff).toHaveLength(4_096);
        expect(rawPayload?.diff).toBeUndefined();
        expect(rawPayload?.diffPreview).toHaveLength(4_096);
        expect(rawPayload?.diffCharLength).toBe(largeDiff.length);
        expect(rawPayload?.diffTruncated).toBe(true);
        expect(rawPayload?.compactedForProviderJournal).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("compacts inherited large turn diff rows before replay decodes them", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const largeDiff = `diff --git a/file.txt b/file.txt\n${"+".repeat(300_000)}`;
        const before = makeRuntimeEvent("event-before-large-diff");
        const large = makeTurnDiffEvent("event-replay-large-diff", largeDiff);
        const after = makeRuntimeEvent("event-after-large-diff");
        for (const event of [before, large, after]) {
          yield* sql`
            INSERT INTO provider_daemon_events (
              owner_key,
              emitted_at,
              event_json
            )
            VALUES (
              ${"provider-daemon"},
              ${"1970-01-01T00:00:00.000Z"},
              ${encodeProviderRuntimeEventJsonForTest(event)}
            )
          `;
        }

        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
          startupPruneDelayMs: 60_000,
        });
        const replayed = yield* journal.replayAfter(0);
        const compacted = replayed[1]?.event;

        expect(replayed.map((record) => record.event.eventId)).toEqual([
          EventId.make("event-before-large-diff"),
          EventId.make("event-replay-large-diff"),
          EventId.make("event-after-large-diff"),
        ]);
        expect(compacted?.type).toBe("turn.diff.updated");
        if (compacted?.type !== "turn.diff.updated") {
          return;
        }
        const rawPayload = compacted.raw?.payload as Record<string, unknown> | undefined;
        expect(compacted.payload.unifiedDiff).toHaveLength(4_096);
        expect(rawPayload?.diff).toBeUndefined();
        expect(rawPayload?.diffPreview).toHaveLength(4_096);
        expect(rawPayload?.diffCharLength).toBe(largeDiff.length);
        expect(rawPayload?.diffTruncated).toBe(true);
        expect(rawPayload?.compactedForProviderJournal).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("prunes oversized persistent owner history when a journal is adopted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const firstJournal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
        });
        yield* firstJournal.publish(makeRuntimeEvent("event-daemon-1"));
        yield* firstJournal.publish(makeRuntimeEvent("event-daemon-2"));
        yield* firstJournal.publish(makeRuntimeEvent("event-daemon-3"));

        const adoptedJournal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 1,
          ownerKey: "provider-daemon",
          startupPruneDelayMs: 0,
        });
        const snapshot = yield* waitForPersistentJournalCount(adoptedJournal, 1);
        const replayed = yield* adoptedJournal.replayAfter(0);

        expect(replayed.map((record) => record.event.eventId)).toEqual([
          EventId.make("event-daemon-3"),
        ]);
        expect(snapshot).toMatchObject({
          eventCursor: 3,
          retainedEventCount: 1,
          oldestCursor: 3,
          newestCursor: 3,
        });
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });

  it("keeps daemon and supervisor event streams isolated in the same database", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const daemonJournal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
        });
        const supervisorJournal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-supervisor",
        });

        yield* daemonJournal.publish(makeRuntimeEvent("event-daemon"));
        yield* supervisorJournal.publish(makeRuntimeEvent("event-supervisor"));

        const daemonReplay = yield* daemonJournal.replayAfter(0);
        const supervisorReplay = yield* supervisorJournal.replayAfter(0);

        expect(daemonReplay.map((record) => record.event.eventId)).toEqual([
          EventId.make("event-daemon"),
        ]);
        expect(supervisorReplay.map((record) => record.event.eventId)).toEqual([
          EventId.make("event-supervisor"),
        ]);
        expect((yield* daemonJournal.snapshot).retainedEventCount).toBe(1);
        expect((yield* supervisorJournal.snapshot).retainedEventCount).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
    );
  });
});
