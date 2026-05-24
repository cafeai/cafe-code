import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  createProviderDaemonEventJournal,
  makePersistentProviderDaemonEventJournal,
} from "./EventJournal.ts";

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
