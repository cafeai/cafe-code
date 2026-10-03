import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import initializeEventJournal from "../persistence/Migrations/001_OrchestrationEvents.ts";
import {
  enrichLegacyActivityOrder,
  LEGACY_ACTIVITY_ORDER_BATCH_SIZE,
  type LegacyActivityOrderRow,
} from "./legacyActivityOrder.ts";

const memoryJournal = Layer.effectDiscard(initializeEventJournal).pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
let fixtureIdentity = 0;

function rowFixture(overrides: Partial<LegacyActivityOrderRow> = {}): LegacyActivityOrderRow {
  const id = ++fixtureIdentity;
  return {
    threadId: `order-thread-${id}`,
    activityId: `order-activity-${id}`,
    turnId: `order-parent-${id}`,
    kind: "task.started",
    createdAt: "2026-10-03T15:10:36.745Z",
    sequence: null,
    ...overrides,
  };
}

interface JournalOverrides {
  readonly driver?: string;
  readonly commandId?: string;
  readonly aggregateKind?: string;
  readonly streamId?: string;
  readonly eventType?: string;
  readonly actorKind?: string;
  readonly occurredAt?: string;
  readonly payloadJson?: string;
  readonly payload?: Record<string, unknown>;
}

function insertEvent(
  sql: SqlClient.SqlClient,
  row: LegacyActivityOrderRow,
  overrides: JournalOverrides = {},
) {
  const id = ++fixtureIdentity;
  const payload = overrides.payload ?? {
    threadId: row.threadId,
    activity: {
      id: row.activityId,
      kind: row.kind,
      turnId: row.turnId,
      createdAt: row.createdAt,
      // Synthetic private-looking fixture content is deliberately not selected
      // by the helper. Only exact scalar identity/order fields leave SQLite.
      payload: { privatePrompt: "Do not return this synthetic fixture content" },
    },
  };
  return sql<{ readonly sequence: number }>`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type,
      occurred_at, command_id, causation_event_id, correlation_id,
      actor_kind, payload_json, metadata_json
    ) VALUES (
      ${`order-event-${id}`}, ${overrides.aggregateKind ?? "thread"},
      ${overrides.streamId ?? row.threadId}, ${id},
      ${overrides.eventType ?? "thread.activity-appended"},
      ${overrides.occurredAt ?? row.createdAt},
      ${overrides.commandId ?? `provider:${overrides.driver ?? "codex"}:${row.threadId}:${row.activityId}:thread-activity-append:${row.activityId}`},
      NULL, NULL, ${overrides.actorKind ?? "provider"},
      ${overrides.payloadJson ?? JSON.stringify(payload)}, ${"{}"}
    ) RETURNING sequence
  `.pipe(Effect.map((rows) => rows[0]!.sequence));
}

function captureEnrichmentStatements(sql: SqlClient.SqlClient) {
  const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
  const observed = new Proxy(sql, {
    apply(target, thisArg, argumentsList) {
      const statement = Reflect.apply(
        target,
        thisArg,
        argumentsList,
      ) as Statement.Statement<unknown>;
      const compiled = statement.compile();
      if (/WITH selected\(/u.test(compiled[0])) statements.push(compiled);
      return statement;
    },
  });
  return { sql: observed, statements };
}

it.layer(memoryJournal)("Selected legacy activity order", (it) => {
  it.effect(
    "recovers all actual provider driver keys and replaces null or local counters without reordering input",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = ["codex", "claudeAgent", "opencode", "grok"].map((driver, index) =>
          Object.assign(rowFixture({ sequence: index === 0 ? null : 900 + index }), { driver }),
        );
        const expected = [];
        for (const row of rows) expected.push(yield* insertEvent(sql, row, { driver: row.driver }));
        const [before] = yield* sql<{
          readonly changes: number;
        }>`SELECT total_changes() AS changes`;
        const enriched = yield* enrichLegacyActivityOrder(sql, rows);
        const [after] = yield* sql<{ readonly changes: number }>`SELECT total_changes() AS changes`;
        assert.equal(after?.changes, before?.changes);
        assert.deepEqual(
          enriched.map((row) => row.sequence),
          expected,
        );
        assert.deepEqual(
          enriched.map((row) => row.activityId),
          rows.map((row) => row.activityId),
        );
        assert.deepEqual(
          rows.map((row) => row.sequence),
          [null, 901, 902, 903],
        );
        assert.deepEqual(
          enriched.map((row) => row.driver),
          ["codex", "claudeAgent", "opencode", "grok"],
        );
      }),
  );

  it.effect("qualifies every stream, actor, activity, turn and timestamp scalar byte-exactly", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const changes: ReadonlyArray<(row: LegacyActivityOrderRow) => JournalOverrides> = [
        () => ({ aggregateKind: "project" }),
        () => ({ streamId: "different-thread" }),
        () => ({ eventType: "thread.message-sent" }),
        () => ({ actorKind: "client" }),
        () => ({ actorKind: "server" }),
        () => ({ occurredAt: "2026-10-03T15:10:36.746Z" }),
        (row) => ({
          payload: {
            threadId: `${row.threadId} `,
            activity: {
              id: row.activityId,
              turnId: row.turnId,
              kind: row.kind,
              createdAt: row.createdAt,
            },
          },
        }),
        (row) => ({
          payload: {
            threadId: row.threadId,
            activity: {
              id: `${row.activityId} `,
              turnId: row.turnId,
              kind: row.kind,
              createdAt: row.createdAt,
            },
          },
        }),
        (row) => ({
          payload: {
            threadId: row.threadId,
            activity: {
              id: row.activityId,
              turnId: `${row.turnId} `,
              kind: row.kind,
              createdAt: row.createdAt,
            },
          },
        }),
        (row) => ({
          payload: {
            threadId: row.threadId,
            activity: {
              id: row.activityId,
              turnId: row.turnId,
              kind: "task.completed",
              createdAt: row.createdAt,
            },
          },
        }),
        (row) => ({
          payload: {
            threadId: row.threadId,
            activity: {
              id: row.activityId,
              turnId: row.turnId,
              kind: row.kind,
              createdAt: `${row.createdAt} `,
            },
          },
        }),
        () => ({ payloadJson: "{invalid-json" }),
      ];
      for (const change of changes) {
        const row = rowFixture({ sequence: 999 });
        yield* insertEvent(sql, row, change(row));
        const original = [row];
        assert.equal(yield* enrichLegacyActivityOrder(sql, original), original);
      }
    }),
  );

  it.effect("distinguishes a real null turn from a missing or textual null turn", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const valid = rowFixture({ turnId: null });
      const expected = yield* insertEvent(sql, valid);
      assert.equal((yield* enrichLegacyActivityOrder(sql, [valid]))[0]?.sequence, expected);
      for (const turn of [undefined, "null"]) {
        const row = rowFixture({ turnId: null, sequence: 55 });
        yield* insertEvent(sql, row, {
          payload: {
            threadId: row.threadId,
            activity: {
              id: row.activityId,
              kind: row.kind,
              createdAt: row.createdAt,
              ...(turn === undefined ? {} : { turnId: turn }),
            },
          },
        });
        const original = [row];
        assert.equal(yield* enrichLegacyActivityOrder(sql, original), original);
      }
    }),
  );

  it.effect("rejects ambiguous commands even when only one duplicate is otherwise valid", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      for (const duplicate of [{ actorKind: "client" }, { payloadJson: "{invalid-json" }, {}]) {
        const row = rowFixture({ sequence: 44 });
        yield* insertEvent(sql, row);
        yield* insertEvent(sql, row, duplicate);
        const original = [row];
        assert.equal(yield* enrichLegacyActivityOrder(sql, original), original);
      }
      const crossDriver = rowFixture({ sequence: 45 });
      yield* insertEvent(sql, crossDriver, { driver: "codex" });
      yield* insertEvent(sql, crossDriver, { driver: "grok" });
      const original = [crossDriver];
      assert.equal(yield* enrichLegacyActivityOrder(sql, original), original);
    }),
  );

  it.effect(
    "does not guess retired/display/extension driver commands or non-task event identity",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const driver of ["cursor", "claude", "extension-provider"]) {
          const row = rowFixture({ sequence: 50 });
          yield* insertEvent(sql, row, { driver });
          const original = [row];
          assert.equal(yield* enrichLegacyActivityOrder(sql, original), original);
        }
        const observed = captureEnrichmentStatements(sql);
        const nonTask = rowFixture({ kind: "tool.completed" });
        yield* insertEvent(sql, nonTask);
        const hugeId = rowFixture({ activityId: "x".repeat(4_097) });
        const original = [nonTask, hugeId];
        assert.equal(yield* enrichLegacyActivityOrder(observed.sql, original), original);
        assert.equal(observed.statements.length, 0);
      }),
  );

  it.effect(
    "parameterizes opaque IDs and proves indexed bounded probes with no payload returned",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const row = rowFixture({
          threadId: "thread:';SELECT secret;--",
          activityId: "activity:');DROP TABLE x;--",
          turnId: "turn:opaque",
        });
        const expected = yield* insertEvent(sql, row);
        const observed = captureEnrichmentStatements(sql);
        const result = yield* enrichLegacyActivityOrder(observed.sql, [row]);
        assert.equal(result[0]?.sequence, expected);
        const [query, parameters] = observed.statements[0]!;
        assert.equal(query.includes(row.threadId), false);
        assert.equal(query.includes(row.activityId), false);
        assert.equal(query.includes("payload_json AS"), false);
        assert.match(query, /INDEXED BY idx_orch_events_command_id/u);
        assert.match(query, /LIMIT 2/u);
        // This SQL is the compiler's fixed query plus structured parameters, not
        // test/user text inserted into executable SQL syntax.
        const plan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${query}`,
          parameters,
        );
        assert.equal(
          plan.some((entry) =>
            /SEARCH candidate USING.*idx_orch_events_command_id/u.test(entry.detail),
          ),
          true,
        );
        assert.equal(
          plan.some((entry) => /SCAN (?:candidate|orchestration_events)/u.test(entry.detail)),
          false,
        );
        assert.equal(
          plan.some((entry) => /SEARCH event USING.*idx_orch_events_stream/u.test(entry.detail)),
          false,
        );
      }),
  );

  it.effect(
    "keeps one, partial and full batches on exact event keys under mature stream statistics",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fixture = rowFixture();
        // A populated stream and ANALYZE represent the planner environment that
        // a tiny pristine journal did not exercise. No private/live DB or native
        // provider is used. Every unrelated command remains absent from lookup.
        yield* sql`
        WITH RECURSIVE stream_events(index_value) AS (
          SELECT 1 UNION ALL SELECT index_value + 1 FROM stream_events WHERE index_value < 10000
        )
        INSERT INTO orchestration_events(
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        )
        SELECT
          ${fixture.activityId} || '-stream-event-' || index_value,
          'thread', ${fixture.threadId}, index_value + 1000000,
          'thread.activity-appended', '2026-10-04T00:00:00.000Z',
          ${fixture.activityId} || '-unrelated-command-' || index_value,
          NULL, NULL, 'provider', '{}', '{}'
        FROM stream_events
      `;
        // Many small neighboring streams keep the average stream selectivity
        // low even though this selected stream is long. That is the mature,
        // skewed catalog shape in which the unfenced one-row join chose a range
        // walk rather than consulting its already-bounded unique witness first.
        yield* sql`
        WITH RECURSIVE sparse_streams(index_value) AS (
          SELECT 1 UNION ALL SELECT index_value + 1 FROM sparse_streams WHERE index_value < 1000
        )
        INSERT INTO orchestration_events(
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        )
        SELECT
          ${fixture.activityId} || '-sparse-event-' || index_value,
          'thread', ${fixture.threadId} || '-sparse-stream-' || index_value, 1,
          'thread.activity-appended', '2026-10-04T00:00:00.000Z',
          ${fixture.activityId} || '-sparse-command-' || index_value,
          NULL, NULL, 'provider', '{}', '{}'
        FROM sparse_streams
      `;
        const rows = Array.from({ length: LEGACY_ACTIVITY_ORDER_BATCH_SIZE }, () =>
          rowFixture({ threadId: fixture.threadId }),
        );
        const expected: number[] = [];
        for (const row of rows) expected.push(yield* insertEvent(sql, row));
        const absent = rowFixture({ threadId: fixture.threadId, sequence: 777 });
        yield* sql`ANALYZE orchestration_events`;
        const statistics = yield* sql<{ readonly idx: string; readonly stat: string }>`
        SELECT idx, stat FROM sqlite_stat1
        WHERE tbl = 'orchestration_events' AND idx = 'idx_orch_events_stream_sequence'
      `;
        assert.equal(statistics.length, 1);
        assert.equal(Number(statistics[0]!.stat.split(" ")[0]) >= 10000, true);
        for (const count of [1, 39, LEGACY_ACTIVITY_ORDER_BATCH_SIZE]) {
          for (const batch of [rows.slice(0, count), [absent, ...rows.slice(0, count - 1)]]) {
            const observed = captureEnrichmentStatements(sql);
            const result = yield* enrichLegacyActivityOrder(observed.sql, batch);
            assert.equal(observed.statements.length, 1);
            if (batch[0] === absent) assert.equal(result[0], absent);
            else
              assert.deepEqual(
                result.map((row) => row.sequence),
                expected.slice(0, count),
              );
            const [query, parameters] = observed.statements[0]!;
            const plan = yield* sql.unsafe<{ readonly detail: string }>(
              `EXPLAIN QUERY PLAN ${query}`,
              parameters,
            );
            const eventLookups = plan.filter((entry) =>
              /(?:SCAN|SEARCH) event\b/u.test(entry.detail),
            );
            // Both the two-row witness probe join and final qualification must
            // use rowid/INTEGER PRIMARY KEY, never a complete thread stream range.
            assert.equal(eventLookups.length, 2);
            assert.equal(
              eventLookups.every((entry) =>
                /SEARCH event USING INTEGER PRIMARY KEY \(rowid=\?\)/u.test(entry.detail),
              ),
              true,
            );
            assert.equal(
              plan.some((entry) =>
                /SCAN (?:candidate|orchestration_events)|SEARCH event USING.*idx_orch_events_stream/u.test(
                  entry.detail,
                ),
              ),
              false,
            );
            assert.equal(
              plan.some((entry) =>
                /SEARCH candidate USING.*idx_orch_events_command_id/u.test(entry.detail),
              ),
              true,
            );
            if (count === 1 && batch[0] === absent) {
              // Prove this statistics-backed fixture is red for the historical
              // join shape without changing production or touching a live DB.
              // An absent witness must not cause a 10,000-row stream walk.
              const historicalQuery = query.replace(
                /FROM unique_event\s+CROSS JOIN selected ON selected.row_index = unique_event.row_index\s+CROSS JOIN orchestration_events AS event ON event.sequence = unique_event.sequence/u,
                "FROM selected JOIN unique_event ON unique_event.row_index = selected.row_index JOIN orchestration_events AS event ON event.sequence = unique_event.sequence",
              );
              assert.notEqual(historicalQuery, query);
              const historicalPlan = yield* sql.unsafe<{ readonly detail: string }>(
                `EXPLAIN QUERY PLAN ${historicalQuery}`,
                parameters,
              );
              assert.equal(
                historicalPlan.some((entry) =>
                  /SEARCH event USING INDEX idx_orch_events_stream_sequence \(aggregate_kind=\? AND stream_id=\?\)/u.test(
                    entry.detail,
                  ),
                ),
                true,
              );
            }
          }
        }
      }),
  );

  it.effect("bounds batches at 64 selected rows and yields a real Node turn between batches", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = Array.from({ length: LEGACY_ACTIVITY_ORDER_BATCH_SIZE * 2 + 1 }, () =>
        rowFixture(),
      );
      const expected = [];
      for (const row of rows) expected.push(yield* insertEvent(sql, row));
      const observed = captureEnrichmentStatements(sql);
      let unrelatedWorkObserved = false;
      setImmediate(() => {
        unrelatedWorkObserved = true;
      });
      const result = yield* enrichLegacyActivityOrder(observed.sql, rows);
      assert.equal(unrelatedWorkObserved, true);
      assert.equal(observed.statements.length, 3);
      // Each selected row has six bound fields and four two-field command
      // probes. The final scalar LIMIT is the only remaining parameter.
      assert.deepEqual(
        observed.statements.map(([, parameters]) => parameters.length),
        [64 * 14 + 1, 64 * 14 + 1, 14 + 1],
      );
      assert.equal(
        observed.statements.every(
          ([, parameters]) => parameters.at(-1) === LEGACY_ACTIVITY_ORDER_BATCH_SIZE,
        ),
        true,
      );
      assert.deepEqual(
        result.map((row) => row.sequence),
        expected,
      );
    }),
  );

  it.effect(
    "repairs same-millisecond restart order while preserving absent witnesses and original row identity",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const terminal = rowFixture({
          activityId: "z-old-terminal",
          kind: "task.progress",
          sequence: 999,
        });
        const start = rowFixture({
          threadId: terminal.threadId,
          activityId: "a-new-start",
          turnId: terminal.turnId,
          sequence: null,
        });
        const terminalSequence = yield* insertEvent(sql, terminal);
        const startSequence = yield* insertEvent(sql, start);
        const unknown = rowFixture({ sequence: 111 });
        const result = yield* enrichLegacyActivityOrder(sql, [start, unknown, terminal]);
        assert.deepEqual(
          result.map((row) => row.sequence),
          [startSequence, 111, terminalSequence],
        );
        assert.equal(result[1], unknown);
        assert.equal(result[0]?.createdAt, result[2]?.createdAt);
        assert.equal(terminalSequence < startSequence, true);
        const sortedKnown = [result[0]!, result[2]!].toSorted(
          (left, right) => left.sequence! - right.sequence!,
        );
        assert.deepEqual(
          sortedKnown.map((row) => row.activityId),
          ["z-old-terminal", "a-new-start"],
        );
        const again = yield* enrichLegacyActivityOrder(sql, sortedKnown);
        assert.equal(again[0], sortedKnown[0]);
        assert.equal(again[1], sortedKnown[1]);
      }),
  );
});
