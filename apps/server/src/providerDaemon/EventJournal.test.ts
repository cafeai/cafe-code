import {
  EventId,
  ProviderDaemonEventRecord,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent as ProviderRuntimeEventSchema,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import { PROVIDER_PIPELINE_POLICY, utf8ByteLength } from "@cafecode/shared/providerPipelinePolicy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { SqlitePersistenceTest } from "../persistence/Sqlite.test.fixture.ts";
import {
  createProviderDaemonEventJournal,
  makePersistentProviderDaemonEventJournal,
  TURN_DIFF_JOURNAL_COMPACT_THRESHOLD_CHARS,
} from "./EventJournal.ts";

const encodeProviderRuntimeEventJsonForTest = Schema.encodeSync(
  Schema.fromJsonString(ProviderRuntimeEventSchema),
);
const encodeDaemonEventRecordJsonForTest = Schema.encodeSync(
  Schema.fromJsonString(ProviderDaemonEventRecord),
);
const decodeDaemonEventRecordJsonForTest = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonEventRecord),
);

const assistantSourceFixtures = [
  { name: "trailing LF", chunks: ["The", " synthetic answer is complete.", "\n"] },
  {
    name: "leading spaces and split CRLF",
    chunks: [" \tThe", " synthetic answer", "\r", "\nretains its source. \r\n "],
  },
  {
    name: "split surrogate pair and trailing whitespace",
    chunks: [" \tBoth \ud83d", "\ude80 synthetic branches are complete.", "\r", "\n \t"],
  },
  {
    name: "unpaired high and low surrogate code units",
    // Text between the two units keeps them unpaired in the full completion,
    // not just in individual delta chunks. JSON must escape and round-trip
    // each original unit rather than substitute a Unicode replacement value.
    chunks: [
      " \tThe lone high \ud83d",
      " and lone low \ude80",
      " remain distinct source units.\r",
      "\n ",
    ],
  },
];

function makeAssistantSourceEvents(chunks: ReadonlyArray<string>): ProviderRuntimeEvent[] {
  const itemId = RuntimeItemId.make("synthetic-assistant-item");
  const base = {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId: ThreadId.make("synthetic-parent-thread"),
    turnId: TurnId.make("synthetic-parent-turn"),
    itemId,
    createdAt: "1970-01-01T00:00:00.000Z",
  };
  const events = chunks.map<ProviderRuntimeEvent>((delta, index) => ({
    ...base,
    eventId: EventId.make(`synthetic-assistant-delta-${index}`),
    type: "content.delta",
    payload: { streamKind: "assistant_text", delta },
    raw: {
      source: "codex.app-server.notification",
      method: "item/agentMessage/delta",
      payload: {
        threadId: "synthetic-native-child-thread",
        turnId: "synthetic-native-child-turn",
        itemId,
        delta,
      },
    },
  }));
  const text = chunks.join("");
  events.push({
    ...base,
    eventId: EventId.make("synthetic-assistant-completed"),
    type: "item.completed",
    payload: { itemType: "assistant_message", status: "completed", detail: text },
    raw: {
      source: "codex.app-server.notification",
      method: "item/completed",
      payload: {
        threadId: "synthetic-native-child-thread",
        turnId: "synthetic-native-child-turn",
        item: { id: itemId, type: "agentMessage", text },
      },
    },
  });
  return events;
}

function encodedRuntimeEventBytes(event: ProviderRuntimeEvent | undefined): number {
  return event === undefined ? 0 : utf8ByteLength(encodeProviderRuntimeEventJsonForTest(event));
}

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

function makeCommandEvent(id: string, output: string): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(id),
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    createdAt: "1970-01-01T00:00:00.000Z",
    type: "item.completed",
    payload: {
      itemType: "command_execution",
      status: "completed",
      data: {
        command: "generate-output",
        aggregatedOutput: output,
      },
    },
    raw: {
      source: "codex.app-server.notification",
      payload: { item: { result: { stdout: output } } },
    },
  };
}

describe("ProviderDaemonEventJournal", () => {
  it("retains current and legacy Claude task history roots through SQLite append and replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const historySessionId = "00000000-0000-4000-8000-000000000961";
        const base = {
          provider: "claudeAgent",
          providerInstanceId: "claude_history_account",
          createdAt: "2026-10-11T00:00:00Z",
          threadId: "claude-history-parent",
          turnId: "claude-history-turn",
          subagentRuntimeId: "00000000-0000-4000-8000-000000000962",
        };
        const tasks = [
          { type: "task.started", payload: { taskId: "native-task" } },
          {
            type: "task.progress",
            payload: { taskId: "native-task", description: "Reviewing files" },
          },
          { type: "task.completed", payload: { taskId: "native-task", status: "completed" } },
        ];
        const inputs = tasks.flatMap((task, index) => [
          { ...base, ...task, eventId: `claude-history-legacy-${index}` },
          {
            ...base,
            ...task,
            eventId: `claude-history-current-${index}`,
            claudeSubagentHistorySessionId: historySessionId,
          },
        ]);
        const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEventSchema);
        const events = inputs.map((input) => decodeEvent(input));
        // Compare against unencoded input before publication, then inspect
        // actual SQLite bytes. A shared lossy task codec must not conceal
        // history-root loss by producing equal live and replayed records.
        expect(events).toEqual(inputs);
        const ownerKey = "synthetic-claude-task-history";
        const journal = yield* makePersistentProviderDaemonEventJournal({ capacity: 10, ownerKey });
        const delivered: ProviderDaemonEventRecord[] = [];
        const subscription = yield* journal.subscribeWithReplayBoundary((record) => {
          delivered.push(record);
        });
        yield* Effect.addFinalizer(() => Effect.sync(subscription.unsubscribe));
        const published = yield* Effect.forEach(events, (event) => journal.publish(event), {
          concurrency: 1,
        });
        expect(subscription.replayBoundaryCursor).toBe(0);
        expect(published.map((record) => record.event)).toEqual(inputs);
        expect(delivered).toEqual(published);
        const replayJournal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey,
        });
        const replayed = yield* replayJournal.replayAfter(0);
        expect(replayed).toEqual(published);
        expect(replayed.map((record) => record.cursor)).toEqual([1, 2, 3, 4, 5, 6]);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly eventJson: string }>`
          SELECT event_json AS "eventJson"
          FROM provider_daemon_events
          WHERE owner_key = ${ownerKey}
          ORDER BY cursor
        `;
        expect(rows.map((row) => JSON.parse(row.eventJson))).toEqual(inputs);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it.each(assistantSourceFixtures)(
    "preserves exact assistant source through persistent publish, live delivery and replay: $name",
    async ({ chunks }) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const events = makeAssistantSourceEvents(chunks);
          const journal = yield* makePersistentProviderDaemonEventJournal({
            capacity: 10,
            ownerKey: "synthetic-assistant-source",
          });
          const delivered: ProviderDaemonEventRecord[] = [];
          const subscription = yield* journal.subscribeWithReplayBoundary((record) => {
            delivered.push(record);
          });
          yield* Effect.addFinalizer(() => Effect.sync(subscription.unsubscribe));
          const published = yield* Effect.forEach(events, (event) => journal.publish(event), {
            concurrency: 1,
          });

          // This is the real SQLite publication boundary, not the in-memory
          // adapter object. Publication decodes its newly stored row before
          // live fanout, so a schema transform can corrupt both live and replay
          // even when native raw text and adapter completion were exact.
          expect(subscription.replayBoundaryCursor).toBe(0);
          expect(published.map((record) => record.event)).toEqual(events);
          expect(delivered).toEqual(published);
          expect(delivered.map((record) => record.event)).toEqual(events);

          const replayJournal = yield* makePersistentProviderDaemonEventJournal({
            capacity: 10,
            ownerKey: "synthetic-assistant-source",
          });
          const replayed = yield* replayJournal.replayAfter(0);
          expect(replayed).toEqual(published);
          expect(replayed.map((record) => record.event)).toEqual(events);
          expect(replayed.map((record) => record.cursor)).toEqual(
            events.map((_, index) => index + 1),
          );

          // Inspect only this fixture's in-memory rows to distinguish source
          // loss during encode from a later decode-only normalization. Raw
          // child identity is intentionally distinct from canonical ownership;
          // neither identity authorizes normalization of assistant source.
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{ readonly eventJson: string }>`
            SELECT event_json AS "eventJson"
            FROM provider_daemon_events
            WHERE owner_key = ${"synthetic-assistant-source"}
            ORDER BY cursor
          `;
          expect(rows.map((row) => JSON.parse(row.eventJson))).toEqual(events);
        }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
      );
    },
  );

  it.each(assistantSourceFixtures)(
    "preserves exact assistant source through daemon-record JSON encode and decode: $name",
    ({ chunks }) => {
      const events = makeAssistantSourceEvents(chunks);
      for (const [index, event] of events.entries()) {
        const record: ProviderDaemonEventRecord = {
          cursor: index + 1,
          emittedAt: "1970-01-01T00:00:00.000Z",
          event,
        };
        // These are the same record contracts used by daemon SSE encoding and
        // the remote backend decoder. Check each direction independently so
        // two matching lossy transforms cannot conceal the original source.
        const encoded = encodeDaemonEventRecordJsonForTest(record);
        expect(JSON.parse(encoded)).toEqual(record);
        expect(decodeDaemonEventRecordJsonForTest(JSON.stringify(record))).toEqual(record);
        expect(decodeDaemonEventRecordJsonForTest(encoded)).toEqual(record);
      }
    },
  );

  it("keeps a committed event and later listeners when one listener throws", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
        });
        const delivered: string[] = [];
        journal.subscribe(() => {
          throw new Error("private client state");
        });
        journal.subscribe((record) => {
          delivered.push(record.event.eventId);
        });
        const first = yield* journal.publish(makeRuntimeEvent("listener-failure-1"));
        const second = yield* journal.publish(makeRuntimeEvent("listener-failure-2"));
        expect(first.cursor).toBeLessThan(second.cursor);
        expect(delivered).toEqual(["listener-failure-1", "listener-failure-2"]);
        expect((yield* journal.replayAfter(0)).map((record) => record.event.eventId)).toEqual(
          delivered,
        );
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });
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

  it("compacts oversized command events before they enter the in-memory journal", () => {
    const journal = createProviderDaemonEventJournal();
    journal.publish(makeCommandEvent("event-large-memory-command", "x".repeat(2_000_000)));

    const event = journal.replayAfter(0)[0]?.event;
    expect(event?.eventId).toBe(EventId.make("event-large-memory-command"));
    expect(event?.compaction?.originalEncodedBytes).toBeGreaterThan(1_000_000);
    expect(encodedRuntimeEventBytes(event)).toBeLessThanOrEqual(
      PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
    );
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("captures a replay high-water boundary and never extends bounded replay into live records", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 20,
          ownerKey: "provider-daemon",
        });
        yield* journal.publish(makeRuntimeEvent("event-before-1"));
        yield* journal.publish(makeRuntimeEvent("event-before-2"));

        const liveCursors: number[] = [];
        const subscription = yield* journal.subscribeWithReplayBoundary((record) => {
          liveCursors.push(record.cursor);
        });
        const firstLive = yield* journal.publish(makeRuntimeEvent("event-live-1"));
        const secondLive = yield* journal.publish(makeRuntimeEvent("event-live-2"));
        const replay = yield* journal.replayPageThrough(0, subscription.replayBoundaryCursor, 20);
        subscription.unsubscribe();

        expect(subscription.replayBoundaryCursor).toBe(2);
        expect(replay.map((record) => record.cursor)).toEqual([1, 2]);
        expect(liveCursors).toEqual([firstLive.cursor, secondLive.cursor]);
        expect(replay.some((record) => record.cursor > subscription.replayBoundaryCursor)).toBe(
          false,
        );
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("repairs only the finite replay page and examines a long retained suffix linearly", async () => {
    // Observe the actual isolated SQLite engine, not a mocked journal. Counting
    // its length predicate is deterministic under slow CI and proves that page
    // repair does not revisit the whole suffix. This local ASCII fixture keeps
    // the overridden SQL BLOB length semantics identical; the production client and
    // database are never changed, and the prototype observer is always restored.
    const observedDatabase: { current: DatabaseSync | undefined } = { current: undefined };
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareObserver = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, query: string) {
        observedDatabase.current = this;
        return originalPrepare.call(this, query);
      });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const ownerKey = "synthetic-bounded-replay";
          const expectedCursors: number[] = [];
          const expectedIds: EventId[] = [];
          const futureOversized = makeCommandEvent(
            "synthetic-future-oversized",
            "x".repeat(300_000),
          );
          const futureJson = encodeProviderRuntimeEventJsonForTest(futureOversized);
          const malformedJson = `{"invalid":"${"z".repeat(300_000)}"}`;
          for (let index = 0; index < 256; index += 1) {
            const event =
              index === 16 ? futureOversized : makeRuntimeEvent(`synthetic-replay-${index}`);
            const json =
              index === 24 ? malformedJson : encodeProviderRuntimeEventJsonForTest(event);
            const inserted = (yield* sql`
              INSERT INTO provider_daemon_events (owner_key, emitted_at, event_json)
              VALUES (${ownerKey}, ${event.createdAt}, ${json})
              RETURNING cursor
            `) as unknown as ReadonlyArray<{ readonly cursor: number }>;
            expectedCursors.push(inserted[0]!.cursor);
            expectedIds.push(event.eventId);
            // Interleaved foreign-owner cursors must not enlarge the page or
            // become repair authority for this exact journal owner.
            if (index % 32 === 0) {
              yield* sql`
                INSERT INTO provider_daemon_events (owner_key, emitted_at, event_json)
                VALUES (${"synthetic-foreign-owner"}, ${event.createdAt}, ${malformedJson})
              `;
            }
          }
          const journal = yield* makePersistentProviderDaemonEventJournal({
            capacity: 512,
            ownerKey,
            startupPruneDelayMs: 60_000,
          });
          let lengthEvaluations = 0;
          expect(observedDatabase.current).toBeDefined();
          observedDatabase.current!.function("length", (value) => {
            lengthEvaluations += 1;
            return value instanceof Uint8Array ? value.byteLength : null;
          });
          const liveCursors: number[] = [];
          const subscription = yield* journal.subscribeWithReplayBoundary((record) => {
            liveCursors.push(record.cursor);
          });
          // An inherited row beyond the captured high-water mark must remain
          // untouched even though it shares this owner and is oversized.
          const beyondBoundary = (yield* sql`
            INSERT INTO provider_daemon_events (owner_key, emitted_at, event_json)
            VALUES (${ownerKey}, ${futureOversized.createdAt}, ${futureJson})
            RETURNING cursor
          `) as unknown as ReadonlyArray<{ readonly cursor: number }>;
          const live = yield* journal.publish(makeRuntimeEvent("synthetic-live-after-boundary"));
          const firstPage = yield* journal.replayPageThrough(0, subscription.replayBoundaryCursor);
          expect(firstPage.map((record) => record.cursor)).toEqual(expectedCursors.slice(0, 8));
          expect(lengthEvaluations).toBe(8);
          const futureRows = (yield* sql`
            SELECT event_json AS "eventJson"
            FROM provider_daemon_events
            WHERE owner_key = ${ownerKey} AND cursor = ${expectedCursors[16]!}
          `) as unknown as ReadonlyArray<{ readonly eventJson: string }>;
          expect(futureRows[0]?.eventJson).toBe(futureJson);
          const prematureQuarantine = yield* sql`
            SELECT cursor FROM provider_daemon_event_quarantine WHERE owner_key = ${ownerKey}
          `;
          expect(prematureQuarantine).toEqual([]);
          const replayed = [...firstPage];
          while (true) {
            const page = yield* journal.replayPageThrough(
              replayed.at(-1)!.cursor,
              subscription.replayBoundaryCursor,
            );
            if (page.length === 0) break;
            expect(page.length).toBeLessThanOrEqual(8);
            expect(
              page.reduce((bytes, record) => bytes + encodedRuntimeEventBytes(record.event), 0),
            ).toBeLessThanOrEqual(PROVIDER_PIPELINE_POLICY.daemonReplayPageBytes);
            replayed.push(...page);
          }
          subscription.unsubscribe();
          expect(replayed.map((record) => record.cursor)).toEqual(expectedCursors);
          expect(
            replayed.filter((_, index) => index !== 24).map((record) => record.event.eventId),
          ).toEqual(expectedIds.filter((_, index) => index !== 24));
          expect(replayed[24]?.event.type).toBe("runtime.warning");
          expect(encodedRuntimeEventBytes(replayed[16]?.event)).toBeLessThanOrEqual(
            PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
          );
          // Two historical repairs can rescan only their own eight-row pages.
          // The old suffix repair evaluates thousands of predicates here.
          expect(lengthEvaluations).toBeLessThanOrEqual(256 + 2 * 8);
          expect(liveCursors).toEqual([live.cursor]);
          expect(replayed.some((record) => record.cursor > subscription.replayBoundaryCursor)).toBe(
            false,
          );
          const foreignRows = (yield* sql`
            SELECT event_json AS "eventJson" FROM provider_daemon_events
            WHERE owner_key = ${"synthetic-foreign-owner"}
          `) as unknown as ReadonlyArray<{ readonly eventJson: string }>;
          expect(foreignRows).toHaveLength(8);
          expect(foreignRows.every((row) => row.eventJson === malformedJson)).toBe(true);
          const beyondBoundaryRows = (yield* sql`
            SELECT event_json AS "eventJson" FROM provider_daemon_events
            WHERE owner_key = ${ownerKey} AND cursor = ${beyondBoundary[0]!.cursor}
          `) as unknown as ReadonlyArray<{ readonly eventJson: string }>;
          expect(beyondBoundaryRows[0]?.eventJson).toBe(futureJson);
        }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
      );
    } finally {
      prepareObserver.mockRestore();
    }
  });

  it("enforces the existing byte bound for inherited multibyte rows smaller than the character limit", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ownerKey = "synthetic-multibyte-replay";
        const events = Array.from({ length: 8 }, (_, index) =>
          makeCommandEvent(`synthetic-unicode-${index}`, "漢".repeat(50_000)),
        );
        for (const event of events) {
          const json = encodeProviderRuntimeEventJsonForTest(event);
          expect(json.length).toBeLessThan(PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes);
          expect(utf8ByteLength(json)).toBeGreaterThan(
            PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
          );
          yield* sql`
            INSERT INTO provider_daemon_events (owner_key, emitted_at, event_json)
            VALUES (${ownerKey}, ${event.createdAt}, ${json})
          `;
        }
        const journal = yield* makePersistentProviderDaemonEventJournal({
          ownerKey,
          capacity: 16,
          startupPruneDelayMs: 60_000,
        });
        const replayed = yield* journal.replayPageThrough(0, 8);
        expect(replayed.map((record) => record.cursor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(replayed.map((record) => record.event.eventId)).toEqual(
          events.map((event) => event.eventId),
        );
        for (const record of replayed) {
          expect(record.event.compaction?.originalEncodedBytes).toBeGreaterThan(
            PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
          );
          expect(encodedRuntimeEventBytes(record.event)).toBeLessThanOrEqual(
            PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
          );
        }
        expect(
          replayed.reduce((bytes, record) => bytes + encodedRuntimeEventBytes(record.event), 0),
        ).toBeLessThanOrEqual(PROVIDER_PIPELINE_POLICY.daemonReplayPageBytes);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("continues bounded replay when retention removes a probed page before decoding", async () => {
    let pruneNextProbe = false;
    const ownerKey = "synthetic-retention-between-probe-and-fetch";
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareObserver = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, query: string) {
        const statement = originalPrepare.call(this, query);
        if (
          /SELECT\s+cursor\s+FROM provider_daemon_events/u.test(query) &&
          query.includes("LIMIT")
        ) {
          const originalAll = statement.all;
          vi.spyOn(statement, "all").mockImplementation((...bindings) => {
            const rows = originalAll.apply(statement, bindings);
            const firstBinding: unknown = bindings[0];
            if (pruneNextProbe && firstBinding === ownerKey && rows.length > 0) {
              pruneNextProbe = false;
              // Inject only the real retention race: the metadata query has
              // returned, but its complete finite range disappears before the
              // repair/fetch. A later retained event must not be mistaken for
              // exhausted replay. No production retention or deadline changes.
              const first = rows[0]!.cursor;
              const last = rows.at(-1)!.cursor;
              this.prepare(
                "DELETE FROM provider_daemon_events WHERE owner_key = ? AND cursor >= ? AND cursor <= ?",
              ).run(ownerKey, first!, last!);
            }
            return rows;
          });
        }
        return statement;
      });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const journal = yield* makePersistentProviderDaemonEventJournal({
            ownerKey,
            capacity: 32,
            startupPruneDelayMs: 60_000,
          });
          const published: ProviderDaemonEventRecord[] = [];
          for (let index = 0; index < 12; index += 1) {
            published.push(yield* journal.publish(makeRuntimeEvent(`synthetic-retained-${index}`)));
          }
          pruneNextProbe = true;
          const replayed = yield* journal.replayPageThrough(0, published.at(-1)!.cursor);
          expect(pruneNextProbe).toBe(false);
          expect(replayed.map((record) => record.cursor)).toEqual(
            published.slice(8).map((record) => record.cursor),
          );
          expect(replayed.map((record) => record.event.eventId)).toEqual(
            published.slice(8).map((record) => record.event.eventId),
          );
          expect(
            yield* journal.replayPageThrough(replayed.at(-1)!.cursor, published.at(-1)!.cursor),
          ).toEqual([]);
        }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
      );
    } finally {
      prepareObserver.mockRestore();
    }
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
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
        yield* journal.startupMaintenance;
        const first = yield* journal.publish(makeRuntimeEvent("event-replayed"));
        const duplicate = yield* journal.publish(makeRuntimeEvent("event-replayed"));
        const replayed = yield* journal.replayAfter(0);
        const snapshot = yield* journal.snapshot;

        expect(duplicate.cursor).toBe(first.cursor);
        expect(replayed.map((record) => record.event.eventId)).toEqual([
          EventId.make("event-replayed"),
        ]);
        expect(snapshot.retainedEventCount).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("compacts large turn diff events before persistent journal replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
        });
        const largeDiff = "+".repeat(TURN_DIFF_JOURNAL_COMPACT_THRESHOLD_CHARS + 1);

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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("compacts oversized command events before persistent journal replay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
        });
        yield* journal.publish(
          makeCommandEvent("event-large-persistent-command", "x".repeat(2_000_000)),
        );

        const event = (yield* journal.replayAfter(0))[0]?.event;
        expect(event?.eventId).toBe(EventId.make("event-large-persistent-command"));
        expect(event?.compaction?.originalEncodedBytes).toBeGreaterThan(1_000_000);
        expect(encodedRuntimeEventBytes(event)).toBeLessThanOrEqual(
          PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
        );
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("compacts inherited large turn diff rows during startup maintenance", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const largeDiff = "+".repeat(TURN_DIFF_JOURNAL_COMPACT_THRESHOLD_CHARS + 1);
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
        yield* journal.startupMaintenance;
        const compacted = (yield* journal.replayAfter(0))[0]?.event;

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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("compacts inherited oversized command rows before replay decodes them", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const event = makeCommandEvent("event-inherited-large-command", "x".repeat(2_000_000));
        yield* sql`
          INSERT INTO provider_daemon_events (owner_key, emitted_at, event_json)
          VALUES (
            ${"provider-daemon"},
            ${"1970-01-01T00:00:00.000Z"},
            ${encodeProviderRuntimeEventJsonForTest(event)}
          )
        `;

        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
          startupPruneDelayMs: 60_000,
        });
        const compacted = (yield* journal.replayAfter(0))[0]?.event;

        expect(compacted?.eventId).toBe(EventId.make("event-inherited-large-command"));
        expect(compacted?.compaction?.originalEncodedBytes).toBeGreaterThan(1_000_000);
        expect(encodedRuntimeEventBytes(compacted)).toBeLessThanOrEqual(
          PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
        );
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });

  it("durably quarantines an incompatible row and advances replay with a safe tombstone", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const malformed = '{"eventId":"broken"';
        yield* sql`
          INSERT INTO provider_daemon_events (owner_key, emitted_at, event_json)
          VALUES (
            ${"provider-daemon"},
            ${"1970-01-01T00:00:00.000Z"},
            ${malformed}
          )
        `;

        const journal = yield* makePersistentProviderDaemonEventJournal({
          capacity: 10,
          ownerKey: "provider-daemon",
          startupPruneDelayMs: 60_000,
        });
        const replayed = yield* journal.replayAfter(0);
        const tombstone = replayed[0]?.event;
        const quarantineRows = (yield* sql`
          SELECT
            cursor,
            encoded_bytes AS "encodedBytes",
            sha256,
            category
          FROM provider_daemon_event_quarantine
          WHERE owner_key = ${"provider-daemon"}
        `) as unknown as ReadonlyArray<{
          readonly cursor: number;
          readonly encodedBytes: number;
          readonly sha256: string;
          readonly category: string;
        }>;

        expect(replayed).toHaveLength(1);
        expect(replayed[0]?.cursor).toBe(1);
        expect(tombstone?.type).toBe("runtime.warning");
        expect(quarantineRows).toEqual([
          {
            cursor: 1,
            encodedBytes: utf8ByteLength(malformed),
            sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            category: "schema-decode-failed",
          },
        ]);
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
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
        yield* adoptedJournal.startupMaintenance;
        const snapshot = yield* adoptedJournal.snapshot;
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
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
      }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceTest)),
    );
  });
});
