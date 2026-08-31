import { MessageId, ThreadId } from "@cafecode/contracts";
import { assert, it } from "@effect/vitest";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as vitestIt } from "vitest";

import {
  hydrateLegacyMessageIdentitiesForThread,
  readLatestMessageIdentity,
} from "../../orchestration/messageIdentityLedger.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

const SQLITE_WRITER_FIXTURE_REPLY_TIMEOUT_MS = 5_000;
const SQLITE_WRITER_FIXTURE_GRACEFUL_EXIT_MS = 500;
const SQLITE_WRITER_FIXTURE_FORCED_EXIT_MS = 5_000;
const WINDOWS_CLEANUP_RETRY_DELAY_MS = 250;
const WINDOWS_CLEANUP_RETRY_ATTEMPTS = 40;

type ChildTermination = Promise<void>;

function observeChildTermination(child: ChildProcess): ChildTermination {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.off("close", finish);
      resolve();
    };

    // `error` is not terminal: Node may emit it for a failed IPC send or kill
    // while the child is still alive. `close` follows both normal exit and a
    // failed spawn after stdio/IPC are closed, so it is the only safe point at
    // which the SQLite handle can no longer remain live in this fixture.
    child.once("close", finish);
  });
}

function waitForPromiseWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);

    void promise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function stopSqliteWriterFixture(
  child: ChildProcess,
  termination: ChildTermination,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await termination;
    return;
  }

  // Closing IPC lets a healthy fixture close its DatabaseSync handle and exit
  // without a signal. The fixture also installs a disconnect cleanup hook for
  // failure paths where the expected command was never delivered.
  if (child.connected) {
    try {
      child.disconnect();
    } catch {
      // A concurrent child-side disconnect is equivalent to the desired state.
    }
  }
  if (await waitForPromiseWithin(termination, SQLITE_WRITER_FIXTURE_GRACEFUL_EXIT_MS)) {
    return;
  }

  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
  if (!(await waitForPromiseWithin(termination, SQLITE_WRITER_FIXTURE_FORCED_EXIT_MS))) {
    throw new Error("SQLite writer fixture did not exit after forced termination.");
  }
}

function readSqliteWriterFixtureReply(child: ChildProcess, phase: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for SQLite writer fixture during ${phase}.`));
    }, SQLITE_WRITER_FIXTURE_REPLY_TIMEOUT_MS);
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(String(message));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(`SQLite writer fixture exited during ${phase} (code ${code}, signal ${signal}).`),
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function isRetryableWindowsCleanupError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

async function removeTemporaryDirectory(directory: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !isRetryableWindowsCleanupError(error) ||
        attempt >= WINDOWS_CLEANUP_RETRY_ATTEMPTS - 1
      ) {
        throw error;
      }
      // Windows can report child exit before SQLite releases the final WAL or
      // shared-memory handle. Match the bounded retry policy used by native
      // artifact cleanup instead of making this process-backed test flaky.
      await new Promise((resolve) => setTimeout(resolve, WINDOWS_CLEANUP_RETRY_DELAY_MS));
    }
  }
}

interface IdentityRow {
  readonly messageId: string;
  readonly firstSequence: number;
  readonly latestSequence: number;
}

layer("068_OrchestrationMessageIdentityLedger", (it) => {
  it.effect("records new identities atomically and lazily hydrates legacy thread rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-message-ledger-upgrade");

      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-legacy-message',
          'thread',
          ${threadId},
          0,
          'thread.message-sent',
          '2026-08-31T00:00:00.000Z',
          'command-legacy-message',
          NULL,
          NULL,
          'client',
          ${JSON.stringify({
            threadId,
            messageId: "message-legacy",
            role: "user",
            text: "legacy",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-08-31T00:00:00.000Z",
            updatedAt: "2026-08-31T00:00:00.000Z",
          })},
          '{}'
        )
      `;
      const [legacyEvent] = yield* sql<{ readonly sequence: number }>`
        SELECT sequence
        FROM orchestration_events
        WHERE event_id = 'event-legacy-message'
      `;

      yield* runMigrations({ toMigrationInclusive: 68 });

      const [state] = yield* sql<{ readonly cutoff: number }>`
        SELECT legacy_cutoff_sequence AS cutoff
        FROM orchestration_message_identity_state
        WHERE singleton_id = 1
      `;
      assert.equal(state?.cutoff, legacyEvent?.sequence);
      assert.deepStrictEqual(yield* sql`SELECT * FROM orchestration_message_identities`, []);

      yield* hydrateLegacyMessageIdentitiesForThread(sql, threadId);
      assert.deepStrictEqual(
        yield* sql<IdentityRow>`
        SELECT
          message_id AS "messageId",
          first_sequence AS "firstSequence",
          latest_sequence AS "latestSequence"
        FROM orchestration_message_identities
      `,
        [
          {
            messageId: "message-legacy",
            firstSequence: legacyEvent!.sequence,
            latestSequence: legacyEvent!.sequence,
          },
        ],
      );

      // The trigger covers every post-migration generation without a scan.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-new-message',
          'thread',
          ${threadId},
          1,
          'thread.message-sent',
          '2026-08-31T00:00:01.000Z',
          'command-new-message',
          NULL,
          NULL,
          'client',
          ${JSON.stringify({
            threadId,
            messageId: "message-new",
            role: "user",
            text: "new",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-08-31T00:00:01.000Z",
            updatedAt: "2026-08-31T00:00:01.000Z",
          })},
          '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-new-message-retry',
          'thread',
          ${threadId},
          2,
          'thread.message-sent',
          '2026-08-31T00:00:02.000Z',
          'command-new-message-retry',
          NULL,
          NULL,
          'server',
          ${JSON.stringify({
            threadId,
            messageId: "message-new",
            role: "user",
            text: "new",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: "2026-08-31T00:00:02.000Z",
            updatedAt: "2026-08-31T00:00:02.000Z",
          })},
          '{}'
        )
      `;

      const identities = yield* sql<IdentityRow>`
        SELECT
          message_id AS "messageId",
          first_sequence AS "firstSequence",
          latest_sequence AS "latestSequence"
        FROM orchestration_message_identities
        ORDER BY message_id ASC
      `;
      assert.equal(identities.length, 2);
      const newIdentity = identities.find((identity) => identity.messageId === "message-new");
      assert.ok(newIdentity);
      assert.ok(newIdentity.latestSequence > newIdentity.firstSequence);
      const cutoff = state!.cutoff;

      const [hydration] = yield* sql<{ readonly throughSequence: number }>`
        SELECT through_sequence AS "throughSequence"
        FROM orchestration_message_identity_hydration
        WHERE thread_id = ${threadId}
      `;
      assert.equal(hydration?.throughSequence, legacyEvent?.sequence);

      // A present compact row does not bypass singleton or hydration
      // authority validation. These checks are intentionally before event
      // tampering so each failure is attributable to the state invariant.
      yield* sql`DELETE FROM orchestration_message_identity_state WHERE singleton_id = 1`;
      const presentMissingState = yield* Effect.flip(
        readLatestMessageIdentity(sql, {
          threadId,
          messageId: MessageId.make("message-new"),
        }),
      );
      assert.equal(presentMissingState._tag, "MessageIdentityLedgerInvariantError");
      if (presentMissingState._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(presentMissingState.issue, "missing-migration-state");
      }
      yield* sql`
        INSERT INTO orchestration_message_identity_state (
          singleton_id,
          legacy_cutoff_sequence
        ) VALUES (1, ${cutoff})
      `;
      yield* sql`
        UPDATE orchestration_message_identity_hydration
        SET through_sequence = 0.5
        WHERE thread_id = ${threadId}
      `;
      const presentInvalidHydration = yield* Effect.flip(
        readLatestMessageIdentity(sql, {
          threadId,
          messageId: MessageId.make("message-new"),
        }),
      );
      assert.equal(presentInvalidHydration._tag, "MessageIdentityLedgerInvariantError");
      if (presentInvalidHydration._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(presentInvalidHydration.issue, "invalid-hydration-state");
      }
      yield* sql`
        UPDATE orchestration_message_identity_hydration
        SET through_sequence = ${legacyEvent!.sequence}
        WHERE thread_id = ${threadId}
      `;

      // The compact pointer is not authoritative by itself. If its referenced
      // event is later corrupted, identity admission must fail closed instead
      // of treating the MessageId as available for reuse.
      yield* sql`
        UPDATE orchestration_events
        SET payload_json = '{"messageId":"message-tampered","role":"user","text":"new","attachments":[]}'
        WHERE event_id = 'event-new-message-retry'
      `;
      const mismatch = yield* Effect.flip(
        readLatestMessageIdentity(sql, {
          threadId,
          messageId: MessageId.make("message-new"),
        }),
      );
      assert.equal(mismatch._tag, "MessageIdentityLedgerInvariantError");
      if (mismatch._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(mismatch.issue, "identity-event-mismatch");
      }

      // Missing or malformed migration state must likewise block legacy
      // admission. A zero fallback would silently bypass all historical ids.
      yield* sql`DELETE FROM orchestration_message_identity_state WHERE singleton_id = 1`;
      const missingState = yield* Effect.flip(
        hydrateLegacyMessageIdentitiesForThread(sql, threadId),
      );
      assert.equal(missingState._tag, "MessageIdentityLedgerInvariantError");
      if (missingState._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(missingState.issue, "missing-migration-state");
      }
      yield* sql`
        INSERT INTO orchestration_message_identity_state (
          singleton_id,
          legacy_cutoff_sequence
        ) VALUES (1, ${cutoff})
      `;
      yield* sql`
        UPDATE orchestration_message_identity_state
        SET legacy_cutoff_sequence = 0.5
        WHERE singleton_id = 1
      `;
      const invalidState = yield* Effect.flip(
        hydrateLegacyMessageIdentitiesForThread(sql, threadId),
      );
      assert.equal(invalidState._tag, "MessageIdentityLedgerInvariantError");
      if (invalidState._tag === "MessageIdentityLedgerInvariantError") {
        assert.equal(invalidState.issue, "invalid-migration-state");
      }
    }),
  );
});

const multiPageLayer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

multiPageLayer("068 legacy hydration scheduling", (it) => {
  it.effect("crosses the Node event loop between bounded legacy pages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-multi-page-hydration");

      yield* runMigrations({ toMigrationInclusive: 67 });
      yield* sql`
        WITH RECURSIVE event_number(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM event_number WHERE value < 513
        )
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        SELECT
          'event-legacy-page-' || value,
          'thread',
          ${threadId},
          value - 1,
          'thread.message-sent',
          '2026-08-31T00:00:00.000Z',
          'command-legacy-page-' || value,
          NULL,
          NULL,
          'client',
          json_object(
            'threadId', ${threadId},
            'messageId', 'message-legacy-page-' || value,
            'role', 'user',
            'text', 'legacy',
            'attachments', json('[]'),
            'turnId', NULL,
            'streaming', json('false'),
            'createdAt', '2026-08-31T00:00:00.000Z',
            'updatedAt', '2026-08-31T00:00:00.000Z'
          ),
          '{}'
        FROM event_number
      `;
      yield* runMigrations({ toMigrationInclusive: 68 });

      let eventLoopAdvanced = false;
      const probe = setImmediate(() => {
        eventLoopAdvanced = true;
      });
      try {
        yield* hydrateLegacyMessageIdentitiesForThread(sql, threadId);
      } finally {
        clearImmediate(probe);
      }

      assert.isTrue(eventLoopAdvanced);
      const [count] = yield* sql<{ readonly value: number }>`
        SELECT COUNT(*) AS value
        FROM orchestration_message_identities
        WHERE thread_id = ${threadId}
      `;
      assert.equal(count?.value, 513);
    }),
  );
});

type HydrationContentionScenario = "advance-wal" | "retire-thread";

async function runHydrationContentionScenario(scenario: HydrationContentionScenario) {
  const directory = mkdtempSync(join(tmpdir(), "cafecode-identity-hydration-lock-"));
  const filename = join(directory, "state.sqlite");
  const suffix = scenario === "advance-wal" ? "retry" : "retire";

  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threadId = ThreadId.make(`thread-hydration-lock-${suffix}`);
          const messageId = `message-hydration-lock-${suffix}`;

          yield* sql`PRAGMA journal_mode = WAL`;
          yield* runMigrations({ toMigrationInclusive: 67 });
          yield* sql`
            INSERT INTO orchestration_events (
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json
            )
            VALUES (
              ${`event-hydration-lock-${suffix}`},
              'thread',
              ${threadId},
              0,
              'thread.message-sent',
              '2026-09-01T00:00:00.000Z',
              ${`command-hydration-lock-${suffix}`},
              NULL,
              NULL,
              'client',
              ${JSON.stringify({
                threadId,
                messageId,
                role: "user",
                text: "legacy",
                attachments: [],
                turnId: null,
                streaming: false,
                createdAt: "2026-09-01T00:00:00.000Z",
                updatedAt: "2026-09-01T00:00:00.000Z",
              })},
              '{}'
            )
          `;
          yield* runMigrations({ toMigrationInclusive: 68 });
          yield* sql`CREATE TABLE cafe_snapshot_retry_probe(value INTEGER NOT NULL)`;

          const [state] = yield* sql<{ readonly cutoff: number }>`
            SELECT legacy_cutoff_sequence AS cutoff
            FROM orchestration_message_identity_state
            WHERE singleton_id = 1
          `;
          assert.ok(state);

          // A separate process is required here: both Cafe runtimes own their
          // own node:sqlite connection, and the production failure occurs when
          // one process advances the WAL after the other's deferred read.
          const lockOwner = fork(
            fileURLToPath(
              new URL("../../../test-fixtures/sqlite-writer-lock-child.mjs", import.meta.url),
            ),
            [],
            {
              execPath: process.execPath,
              execArgv: [],
              stdio: ["ignore", "ignore", "ignore", "ipc"],
            },
          );
          const childTermination = observeChildTermination(lockOwner);

          // Keep the lifecycle guard immediately adjacent to `fork`. Setup,
          // readiness, assertions, and hydration can all fail independently;
          // none may leave an IPC child or SQLite handle behind.
          try {
            const ready = readSqliteWriterFixtureReply(lockOwner, "startup");
            lockOwner.send({ filename });
            assert.equal(yield* Effect.promise(() => ready), "ready");

            let snapshotAdvanced = false;
            let tombstoneLookupCount = 0;
            const contendedSql = new Proxy(sql, {
              apply(target, thisArg, argumentList) {
                const statement = Reflect.apply(target, thisArg, argumentList);
                const [segments] = argumentList;
                const isTombstoneLookup =
                  Array.isArray(segments) &&
                  segments.every((segment) => typeof segment === "string") &&
                  segments.join(" ").includes("FROM hard_deleted_threads");
                if (!isTombstoneLookup) {
                  return statement;
                }

                tombstoneLookupCount += 1;
                if (snapshotAdvanced) {
                  return statement;
                }
                snapshotAdvanced = true;
                return (statement as Effect.Effect<unknown, unknown, unknown>).pipe(
                  Effect.tap(() =>
                    Effect.promise(async () => {
                      const committed = readSqliteWriterFixtureReply(
                        lockOwner,
                        scenario === "advance-wal" ? "WAL advance" : "thread retirement",
                      );
                      lockOwner.send(
                        scenario === "advance-wal"
                          ? "write"
                          : {
                              type: "retire-thread",
                              threadId,
                              deletedAt: "2026-09-01T00:01:00.000Z",
                            },
                      );
                      assert.equal(
                        await committed,
                        scenario === "advance-wal" ? "committed" : "retired",
                      );
                    }),
                  ),
                );
              },
            }) as unknown as SqlClient.SqlClient;

            yield* hydrateLegacyMessageIdentitiesForThread(contendedSql, threadId);
            // The first transaction must fail after its deferred snapshot is
            // invalidated, and the fresh retry must re-read the tombstone.
            assert.isAtLeast(tombstoneLookupCount, 2);

            const identities = yield* sql<IdentityRow>`
              SELECT
                message_id AS "messageId",
                first_sequence AS "firstSequence",
                latest_sequence AS "latestSequence"
              FROM orchestration_message_identities
              WHERE thread_id = ${threadId}
            `;
            const [hydration] = yield* sql<{ readonly throughSequence: number }>`
              SELECT through_sequence AS "throughSequence"
              FROM orchestration_message_identity_hydration
              WHERE thread_id = ${threadId}
            `;
            const [tombstone] = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count
              FROM hard_deleted_threads
              WHERE thread_id = ${threadId}
            `;

            if (scenario === "advance-wal") {
              assert.deepStrictEqual(identities, [
                {
                  messageId,
                  firstSequence: state!.cutoff,
                  latestSequence: state!.cutoff,
                },
              ]);
              assert.equal(hydration?.throughSequence, state!.cutoff);
              assert.equal(tombstone?.count, 0);
            } else {
              // A permanent tombstone committed between attempts must win. A
              // stale backend may neither recreate the compact identity row nor
              // leave a standalone hydration watermark after hard deletion.
              assert.deepStrictEqual(identities, []);
              assert.isUndefined(hydration);
              assert.equal(tombstone?.count, 1);
            }
          } finally {
            yield* Effect.promise(() => stopSqliteWriterFixture(lockOwner, childTermination));
          }
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename, busyTimeoutMs: 25 }))),
      ),
    );
  } finally {
    await removeTemporaryDirectory(directory);
  }
}

// Leave enough headroom for the reply deadline plus graceful/forced cleanup on
// an intentionally broken fixture. Windows also reserves time for delayed WAL
// handle release and its bounded directory-removal retries.
const HYDRATION_CONTENTION_TEST_TIMEOUT_MS = process.platform === "win32" ? 40_000 : 25_000;

vitestIt(
  "retries one legacy hydration page after transient WAL writer contention",
  () => runHydrationContentionScenario("advance-wal"),
  HYDRATION_CONTENTION_TEST_TIMEOUT_MS,
);

vitestIt(
  "honors a permanent tombstone committed between a failed snapshot and its retry",
  () => runHydrationContentionScenario("retire-thread"),
  HYDRATION_CONTENTION_TEST_TIMEOUT_MS,
);
