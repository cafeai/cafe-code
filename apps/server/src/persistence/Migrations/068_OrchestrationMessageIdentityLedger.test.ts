import { MessageId, ThreadId } from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
// SQLite fixture retains exact child IPC/exit ownership and bounded native retirement.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { fork, type ChildProcess } from "node:child_process";
// SQLite fixture retains actual native descriptors, file identity and namespace cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync } from "node:fs";
// SQLite fixture retains actual native descriptors, file identity and namespace cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// SQLite fixture paths retain actual host drive and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";
import { expect, it as vitestIt } from "vitest";

import {
  hydrateLegacyMessageIdentitiesForThread,
  readLatestMessageIdentity,
} from "../../orchestration/messageIdentityLedger.ts";
import { purgeHardDeletedThreadPersistence } from "../../orchestration/threadHardDelete.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import * as TestSqliteClient from "../TestSqliteClient.ts";

// Preserve deliberately malformed/historical fixture values and exact native JSON bytes;
// this codec does not replace production admission or grant received-data authority.
const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const layer = it.layer(Layer.mergeAll(TestSqliteClient.layerMemory()));

const SQLITE_WRITER_FIXTURE_REPLY_TIMEOUT_MS = 5_000;
const SQLITE_WRITER_FIXTURE_GRACEFUL_EXIT_MS = 500;
const SQLITE_WRITER_FIXTURE_FORCED_EXIT_MS = 5_000;
const WINDOWS_CLEANUP_RETRY_DELAY_MS = 250;
const WINDOWS_CLEANUP_RETRY_ATTEMPTS = 40;
const HYDRATION_ORDERING_BUSY_TIMEOUT_MS = 1_000;
// Both ordering fixtures deliberately keep the writer longer than the old
// synchronous busy budget. Their terminal acknowledgement, not a short child
// timer or a lucky scheduling interval, must permit the parent's first write.
const SQLITE_WRITER_ORDERING_RELEASE_DELAY_MS = HYDRATION_ORDERING_BUSY_TIMEOUT_MS + 200;

type ChildTermination = Promise<void>;

interface SqliteWriterFixtureReplies {
  readonly read: (phase: string) => Promise<string>;
  readonly drain: () => Promise<void>;
}

function createSqliteWriterFixtureReplies(child: ChildProcess): SqliteWriterFixtureReplies {
  const replies = new Set<Promise<string>>();
  return {
    read(phase) {
      const reply = readSqliteWriterFixtureReply(child, phase);
      replies.add(reply);
      // Register an observer immediately: an assertion can fail between reply
      // registration and its normal await, and cleanup then makes the child
      // exit. Preserve the original rejecting promise so an awaited protocol
      // failure still fails the test instead of being converted into success.
      void reply.catch(() => undefined);
      return reply;
    },
    async drain() {
      // Cleanup may reject replies which the primary failure prevented us
      // from awaiting. Drain those observers without replacing that primary
      // assertion or protocol failure with a secondary child-exit error.
      await Promise.allSettled(replies);
    },
  };
}

function startSqliteWriterFixture() {
  const child = fork(
    fileURLToPath(new URL("../../../test-fixtures/sqlite-writer-lock-child.mjs", import.meta.url)),
    [],
    {
      execPath: process.execPath,
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  return {
    child,
    termination: observeChildTermination(child),
    replies: createSqliteWriterFixtureReplies(child),
  };
}

function observeChildTermination(child: ChildProcess): ChildTermination {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.off("exit", finish);
      child.off("close", finish);
      resolve();
    };

    // `error` is not terminal: Node may emit it for a failed IPC send or kill
    // while the child is still alive. Process `exit` is sufficient for this
    // fixture because the operating system has closed every native SQLite file
    // handle at that point; `close` remains the failed-spawn/stdio fallback.
    // Some Vitest worker configurations observe `exit` without a later `close`
    // for an IPC child, so waiting exclusively for `close` would manufacture a
    // five-second cleanup failure after a healthy child already returned zero.
    child.once("exit", finish);
    child.once("close", finish);
  });
}

function waitForPromiseWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    // Native SQLite peer deadline/release retains its actual wall clock and exact child cleanup.
    // @effect-diagnostics-next-line globalTimers:off
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
  replies: SqliteWriterFixtureReplies,
): Promise<void> {
  try {
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
      throw new Error(
        `SQLite writer fixture did not exit after forced termination ` +
          `(pid=${String(child.pid)}, connected=${String(child.connected)}, ` +
          `killed=${String(child.killed)}, exitCode=${String(child.exitCode)}, ` +
          `signalCode=${String(child.signalCode)}).`,
      );
    }
  } finally {
    await replies.drain();
  }
}

function readSqliteWriterFixtureReply(child: ChildProcess, phase: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // Native SQLite peer deadline/release retains its actual wall clock and exact child cleanup.
    // @effect-diagnostics-next-line globalTimers:off
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
      // Native SQLite peer deadline/release retains its actual wall clock and exact child cleanup.
      // @effect-diagnostics-next-line globalTimers:off
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
          ${encodeFixtureJson({
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
          ${encodeFixtureJson({
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
          ${encodeFixtureJson({
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

type HydrationContentionScenario =
  | "advance-wal"
  | "retire-thread"
  | "writer-timeout"
  | "hydrate-then-purge"
  | "writer-exhausted";

const hydrationContentionSuffixes = {
  "advance-wal": "write-first",
  "retire-thread": "retire-first",
  "writer-timeout": "retry",
  "hydrate-then-purge": "hydrate-first",
  "writer-exhausted": "retry-exhausted",
} as const satisfies Record<HydrationContentionScenario, string>;

async function runHydrationContentionScenario(
  scenario: HydrationContentionScenario,
  options: { readonly readBeforeFirstCompactWrite?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "cafecode-identity-hydration-lock-"));
  const filename = join(directory, "state.sqlite");
  const suffix = hydrationContentionSuffixes[scenario];

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
              ${encodeFixtureJson({
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
          if (scenario === "hydrate-then-purge") {
            // The production purge spans every current persistence table. Keep
            // the legacy row/migration-68 setup above intact, then install the
            // remaining schema before invoking that real purge implementation.
            yield* runMigrations();
          }
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
          const {
            child: lockOwner,
            termination: childTermination,
            replies,
          } = startSqliteWriterFixture();

          // Keep the lifecycle guard immediately adjacent to `fork`. Setup,
          // readiness, assertions, and hydration can all fail independently;
          // none may leave an IPC child or SQLite handle behind.
          try {
            const ready = replies.read("startup");
            lockOwner.send({ filename });
            assert.equal(yield* Effect.promise(() => ready), "ready");

            let contentionIntercepted = false;
            let compactWriteAttemptCount = 0;
            let writerLockReply: Promise<string> | undefined;
            let terminalWriterReply: Promise<string> | undefined;
            const contendedSql = new Proxy(sql, {
              apply(target, thisArg, argumentList) {
                // Reflect invokes the exact real SQL client's template call.
                // Retain its actual SqlError channel and service-free Statement contract.
                const statement = Reflect.apply(
                  target,
                  thisArg,
                  argumentList,
                ) as Statement.Statement<unknown>;
                const [segments] = argumentList;
                let waitForReleasedWriter = false;
                const isIdentityWrite =
                  Array.isArray(segments) &&
                  segments.every((segment) => typeof segment === "string") &&
                  segments.join(" ").includes("INSERT INTO orchestration_message_identities");
                const isHydrationWrite =
                  Array.isArray(segments) &&
                  segments.every((segment) => typeof segment === "string") &&
                  segments
                    .join(" ")
                    .includes("INSERT INTO orchestration_message_identity_hydration");
                if (isIdentityWrite) {
                  compactWriteAttemptCount += 1;
                  if (scenario === "writer-timeout" && compactWriteAttemptCount === 2) {
                    // The child deliberately holds the WAL writer until this
                    // second transaction attempt is constructed. Releasing it
                    // here proves the first bounded busy timeout occurred while
                    // avoiding an inherently flaky wall-clock race between the
                    // retry backoff and a child-process timer.
                    lockOwner.send({ type: "release-write" });
                    waitForReleasedWriter = true;
                  }
                }

                const shouldIntercept =
                  scenario === "hydrate-then-purge" ? isHydrationWrite : isIdentityWrite;
                if (!shouldIntercept || contentionIntercepted) {
                  if (waitForReleasedWriter) {
                    // Sending an IPC message proves which retry released the
                    // child, but it does not prove Windows has scheduled that
                    // child, committed SQLite, and published the reply before
                    // this process enters another synchronous 25 ms busy
                    // wait. Under full CI load the second attempt could exhaust
                    // that artificial timeout, start the third attempt, and
                    // fail even though retry behavior was correct. Gate only
                    // this test statement on the already-registered terminal
                    // reply. Reaching this branch still proves attempt one
                    // timed out (attempt two cannot be constructed otherwise),
                    // while the production retry timing remains untouched.
                    return Effect.promise(async () => {
                      assert.ok(terminalWriterReply);
                      assert.equal(await terminalWriterReply, "committed");
                    }).pipe(Effect.andThen(statement));
                  }
                  return statement;
                }

                contentionIntercepted = true;
                const synchronizeWriter = Effect.promise(async () => {
                  if (scenario === "hydrate-then-purge") {
                    const attempting = replies.read("post-hydration retirement attempt");
                    lockOwner.send({
                      type: "hold-write",
                      operation: "retire-thread",
                      holdMs: 250,
                      releaseOnCommand: true,
                      announceAttempt: true,
                      threadId,
                      deletedAt: "2026-09-01T00:01:00.000Z",
                    });
                    assert.equal(await attempting, "attempting");
                    // Register before the parent watermark write and commit
                    // release SQLite's writer. The child cannot publish this
                    // reply until BEGIN IMMEDIATE has acquired that writer.
                    writerLockReply = replies.read("post-hydration retirement lock");
                    return;
                  }

                  const locked = replies.read("writer lock");
                  lockOwner.send({
                    type: "hold-write",
                    operation: scenario === "retire-thread" ? "retire-thread" : "write",
                    holdMs: scenario === "writer-exhausted" ? 500 : 50,
                    releaseOnCommand: true,
                    ...(scenario === "retire-thread"
                      ? {
                          threadId,
                          deletedAt: "2026-09-01T00:01:00.000Z",
                        }
                      : {}),
                  });
                  assert.equal(await locked, "locked");
                  terminalWriterReply = replies.read(
                    scenario === "retire-thread" ? "thread retirement" : "WAL advance",
                  );
                  if (scenario === "advance-wal" || scenario === "retire-thread") {
                    // Ordering-only cases need a committed WAL generation,
                    // not an artificial busy timeout. In particular, a loaded
                    // child can miss a 50 ms timer by more than the parent's
                    // 1 s timeout. Delay release beyond that old budget, then
                    // require the terminal IPC acknowledgement before the
                    // intercepted first INSERT executes. This remains inside
                    // the parent's transaction: a preceding SELECT would pin
                    // a stale snapshot and still fail its read-to-write upgrade.
                    await new Promise((resolve) =>
                      // Native SQLite peer deadline/release retains its actual wall clock and exact child cleanup.
                      // @effect-diagnostics-next-line globalTimers:off
                      setTimeout(resolve, SQLITE_WRITER_ORDERING_RELEASE_DELAY_MS),
                    );
                    lockOwner.send({ type: "release-write" });
                    assert.equal(
                      await terminalWriterReply,
                      scenario === "retire-thread" ? "retired" : "committed",
                    );
                  }
                });

                // The negative control deliberately pins a real table read
                // before the child commits. Compose it into the current Effect
                // transaction instead of creating a separate runPromise/sql
                // context, which would lose the very snapshot being tested.
                const synchronizedWrite =
                  options.readBeforeFirstCompactWrite === true && isIdentityWrite
                    ? sql`SELECT value FROM cafe_snapshot_retry_probe LIMIT 1`.pipe(
                        Effect.andThen(synchronizeWriter),
                      )
                    : synchronizeWriter;
                return synchronizedWrite.pipe(Effect.andThen(statement));
              },
            }) as unknown as SqlClient.SqlClient;

            if (scenario === "writer-exhausted") {
              const failure = yield* Effect.flip(
                hydrateLegacyMessageIdentitiesForThread(contendedSql, threadId),
              );
              assert.equal(failure._tag, "SqlError");
              if (failure._tag === "SqlError") {
                assert.equal(failure.reason._tag, "LockTimeoutError");
              }
              // All three bounded attempts have now failed. Release the child
              // only after observing that typed terminal error so the test
              // cannot accidentally turn into a late successful retry under
              // runner scheduling pressure.
              lockOwner.send({ type: "release-write" });
            } else {
              yield* hydrateLegacyMessageIdentitiesForThread(contendedSql, threadId);
            }
            assert.isTrue(contentionIntercepted);
            // A transaction that reads before the child commits fails its
            // first compact write with native SQLITE_BUSY_SNAPSHOT even after
            // the terminal acknowledgement releases the child's writer. The
            // production write-first transaction finishes in one attempt. The
            // writer-timeout scenario deliberately exceeds that tiny test
            // timeout and proves that only the idempotent page is retried.
            assert.equal(
              compactWriteAttemptCount,
              scenario === "writer-exhausted" ? 3 : scenario === "writer-timeout" ? 2 : 1,
              "Unexpected compact identity write attempt count.",
            );

            if (scenario === "hydrate-then-purge") {
              assert.equal(
                yield* Effect.promise(() => {
                  assert.ok(writerLockReply);
                  return writerLockReply!;
                }),
                "locked",
              );
              terminalWriterReply = replies.read("post-hydration thread retirement");

              // While the child owns the later, still-uncommitted tombstone
              // transaction, WAL readers must already observe both rows from
              // the parent's committed hydration transaction. This proves the
              // intended hydration-first ordering without relying on sleeps.
              const committedIdentities = yield* sql<IdentityRow>`
                SELECT
                  message_id AS "messageId",
                  first_sequence AS "firstSequence",
                  latest_sequence AS "latestSequence"
                FROM orchestration_message_identities
                WHERE thread_id = ${threadId}
              `;
              const [committedHydration] = yield* sql<{ readonly throughSequence: number }>`
                SELECT through_sequence AS "throughSequence"
                FROM orchestration_message_identity_hydration
                WHERE thread_id = ${threadId}
              `;
              const [committedTombstone] = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM hard_deleted_threads
                WHERE thread_id = ${threadId}
              `;
              assert.deepStrictEqual(committedIdentities, [
                {
                  messageId,
                  firstSequence: state!.cutoff,
                  latestSequence: state!.cutoff,
                },
              ]);
              assert.equal(committedHydration?.throughSequence, state!.cutoff);
              assert.equal(committedTombstone?.count, 0);
              // Keep retirement uncommitted until these WAL-reader assertions
              // have actually run. A short child timer could otherwise commit
              // the tombstone before a loaded parent observes the locked reply.
              lockOwner.send({ type: "release-write" });
            }

            if (scenario === "writer-exhausted") {
              // All three write-first attempts rolled back before the child
              // releases its writer. Neither the identity nor its watermark
              // may leak from a failed transaction.
              assert.deepStrictEqual(
                yield* sql`
                  SELECT *
                  FROM orchestration_message_identities
                  WHERE thread_id = ${threadId}
                `,
                [],
              );
              assert.deepStrictEqual(
                yield* sql`
                  SELECT *
                  FROM orchestration_message_identity_hydration
                  WHERE thread_id = ${threadId}
                `,
                [],
              );
            }

            assert.equal(
              yield* Effect.promise(() => {
                assert.ok(terminalWriterReply);
                return terminalWriterReply!;
              }),
              scenario === "retire-thread" || scenario === "hydrate-then-purge"
                ? "retired"
                : "committed",
            );

            if (scenario === "hydrate-then-purge") {
              // Exercise the real production purge after the later tombstone
              // commits. It must remove both compact rows while preserving the
              // permanent hard-delete fence.
              yield* purgeHardDeletedThreadPersistence({ threadId }).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
            }

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

            if (
              scenario !== "retire-thread" &&
              scenario !== "hydrate-then-purge" &&
              scenario !== "writer-exhausted"
            ) {
              assert.deepStrictEqual(identities, [
                {
                  messageId,
                  firstSequence: state!.cutoff,
                  latestSequence: state!.cutoff,
                },
              ]);
              assert.equal(hydration?.throughSequence, state!.cutoff);
              assert.equal(tombstone?.count, 0);
            } else if (scenario === "retire-thread" || scenario === "hydrate-then-purge") {
              // Whether retirement acquired the writer first or waited behind
              // hydration, the permanent tombstone and purge must win. A stale
              // backend may neither recreate the identity row nor leave a
              // standalone hydration watermark after hard deletion.
              assert.deepStrictEqual(identities, []);
              assert.isUndefined(hydration);
              assert.equal(tombstone?.count, 1);
            } else {
              assert.deepStrictEqual(identities, []);
              assert.isUndefined(hydration);
              assert.equal(tombstone?.count, 0);
            }
          } finally {
            yield* Effect.promise(() =>
              stopSqliteWriterFixture(lockOwner, childTermination, replies),
            );
          }
        }).pipe(
          Effect.provide(
            NodeSqliteClient.layer({
              filename,
              busyTimeoutMs:
                scenario === "writer-timeout" || scenario === "writer-exhausted"
                  ? 25
                  : HYDRATION_ORDERING_BUSY_TIMEOUT_MS,
            }),
          ),
        ),
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
  "admits a legacy hydration page after a writer release delayed beyond the busy budget",
  () => runHydrationContentionScenario("advance-wal"),
  HYDRATION_CONTENTION_TEST_TIMEOUT_MS,
);

vitestIt(
  "honors a permanent tombstone after retirement delayed beyond the busy budget",
  () => runHydrationContentionScenario("retire-thread"),
  HYDRATION_CONTENTION_TEST_TIMEOUT_MS,
);

vitestIt(
  "detects a deferred snapshot upgrade even after awaiting the writer's commit",
  async () => {
    await expect(
      runHydrationContentionScenario("advance-wal", { readBeforeFirstCompactWrite: true }),
    ).rejects.toThrow(/Unexpected compact identity write attempt count.*expected 2 to equal 1/);
  },
  HYDRATION_CONTENTION_TEST_TIMEOUT_MS,
);

vitestIt(
  "drains a pending child reply without hiding the primary assertion failure",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "cafecode-identity-fixture-failure-"));
    const { child, termination, replies } = startSqliteWriterFixture();
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    try {
      process.on("unhandledRejection", onUnhandledRejection);
      let primaryFailure: unknown;
      let pendingReply: Promise<string> | undefined;
      const guardedFailure = async () => {
        try {
          const ready = replies.read("failure-cleanup startup");
          child.send({ filename: join(directory, "state.sqlite") });
          assert.equal(await ready, "ready");

          // No terminal command is sent. The deliberate assertion failure
          // leaves this reply pending, and cleanup must reject it on the real
          // child's exit without producing an unhandled rejection first.
          pendingReply = replies.read("primary assertion failure cleanup");
          assert.fail("Injected primary fixture assertion failure.");
        } catch (error) {
          primaryFailure = error;
          throw error;
        } finally {
          await stopSqliteWriterFixture(child, termination, replies);
        }
      };
      const actualFailure = await guardedFailure().catch((error: unknown) => error);
      assert.ok(actualFailure instanceof Error);
      assert.strictEqual(actualFailure, primaryFailure);
      assert.match(actualFailure.message, /Injected primary fixture assertion failure/);
      assert.ok(pendingReply);
      // The immediate observer must retain the original rejecting promise:
      // normal callers still see the concrete protocol failure when awaiting.
      await expect(pendingReply).rejects.toThrow(
        /SQLite writer fixture exited during primary assertion failure cleanup/,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(unhandledRejections, []);
      assert.equal(child.connected, false);
      // A loaded runner may need the existing bounded forced-exit backstop.
      // Prove the process was reaped without assuming it received its normal
      // disconnect cleanup within the short graceful interval.
      assert.isTrue(child.exitCode !== null || child.signalCode !== null);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      try {
        await stopSqliteWriterFixture(child, termination, replies);
      } finally {
        await removeTemporaryDirectory(directory);
      }
    }
  },
  HYDRATION_CONTENTION_TEST_TIMEOUT_MS,
);

vitestIt(
  "retries only the idempotent hydration page after a bounded writer timeout",
  () => runHydrationContentionScenario("writer-timeout"),
  HYDRATION_CONTENTION_TEST_TIMEOUT_MS,
);

vitestIt(
  "purges identity and watermark rows when retirement commits after hydration",
  () => runHydrationContentionScenario("hydrate-then-purge"),
  HYDRATION_CONTENTION_TEST_TIMEOUT_MS,
);

vitestIt(
  "fails with a typed lock timeout and no partial rows after exhausting hydration retries",
  () => runHydrationContentionScenario("writer-exhausted"),
  HYDRATION_CONTENTION_TEST_TIMEOUT_MS,
);
