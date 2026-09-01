import { DatabaseSync } from "node:sqlite";

let database = null;

function closeDatabase() {
  if (database === null) return;
  try {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
  } catch {
    // Fixture cleanup must continue to close the handle after a failed write.
  }
  try {
    database.close();
  } catch {
    // The parent still owns a bounded forced-termination backstop.
  }
  database = null;
}

function disconnect() {
  if (process.connected) {
    process.disconnect();
  }
}

function replyAndDisconnect(message) {
  if (typeof process.send !== "function" || !process.connected) {
    disconnect();
    return;
  }
  process.send(message, disconnect);
}

function replyAndExit(message) {
  if (typeof process.send !== "function" || !process.connected) {
    process.exit(0);
  }
  // The parent can begin cleanup as soon as it receives the terminal reply.
  // Bound the IPC callback race so this process-backed fixture never retains a
  // closed SQLite handle merely because both sides disconnected concurrently.
  const forcedExit = setTimeout(() => process.exit(0), 250);
  process.send(message, () => {
    clearTimeout(forcedExit);
    disconnect();
    process.exit(0);
  });
}

function isRetireThreadCommand(command) {
  return (
    typeof command === "object" &&
    command !== null &&
    command.type === "retire-thread" &&
    typeof command.threadId === "string" &&
    command.threadId.length > 0 &&
    command.threadId.length <= 512 &&
    typeof command.deletedAt === "string" &&
    command.deletedAt.length > 0 &&
    command.deletedAt.length <= 128
  );
}

function isHeldWriteCommand(command) {
  if (
    typeof command !== "object" ||
    command === null ||
    command.type !== "hold-write" ||
    (command.operation !== "write" && command.operation !== "retire-thread") ||
    !Number.isSafeInteger(command.holdMs) ||
    command.holdMs < 1 ||
    command.holdMs > 1_000 ||
    (command.announceAttempt !== undefined && typeof command.announceAttempt !== "boolean")
  ) {
    return false;
  }
  return (
    command.operation === "write" ||
    isRetireThreadCommand({
      type: "retire-thread",
      threadId: command.threadId,
      deletedAt: command.deletedAt,
    })
  );
}

// Parent-side failures can close IPC before the write command arrives. Always
// release the native SQLite handle so Windows does not retain WAL files after
// the process has otherwise become unreachable.
process.once("disconnect", closeDatabase);

process.once("message", (input) => {
  if (typeof input !== "object" || input === null || typeof input.filename !== "string") {
    replyAndDisconnect("invalid-input");
    return;
  }

  try {
    database = new DatabaseSync(input.filename);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  } catch {
    closeDatabase();
    replyAndDisconnect("failed");
    return;
  }

  process.send?.("ready");
  process.once("message", (command) => {
    if (command !== "write" && !isRetireThreadCommand(command) && !isHeldWriteCommand(command)) {
      closeDatabase();
      replyAndDisconnect("invalid-command");
      return;
    }

    try {
      const operation = isHeldWriteCommand(command) ? command.operation : command;
      if (isHeldWriteCommand(command) && command.announceAttempt === true) {
        // This bounded control reply lets the parent prove ordering without a
        // timing guess: after it arrives, this process immediately blocks in
        // BEGIN IMMEDIATE until the parent's already-owned writer commits.
        // No database value or path crosses the fixture IPC boundary.
        process.send?.("attempting");
      }
      database.exec("BEGIN IMMEDIATE;");
      if (operation === "write") {
        database.exec("INSERT INTO cafe_snapshot_retry_probe(value) VALUES (1);");
      } else {
        // Keep values bound even in a test fixture. Thread ids are opaque input
        // and must never be interpolated into SQL in production-shaped tests.
        database
          .prepare("INSERT INTO hard_deleted_threads(thread_id, deleted_at) VALUES (?, ?)")
          .run(command.threadId, command.deletedAt);
      }

      if (isHeldWriteCommand(command)) {
        // Keep the writer transaction open in this separate process while the
        // parent exercises node:sqlite's busy timeout. The parent process can
        // block synchronously in StatementSync without delaying this timer.
        process.send?.("locked");
        setTimeout(() => {
          try {
            database.exec("COMMIT;");
            const reply = command.operation === "write" ? "committed" : "retired";
            closeDatabase();
            replyAndExit(reply);
          } catch {
            closeDatabase();
            replyAndExit("failed");
          }
        }, command.holdMs);
        return;
      }

      database.exec("COMMIT;");
      const reply = command === "write" ? "committed" : "retired";
      closeDatabase();
      replyAndDisconnect(reply);
    } catch {
      closeDatabase();
      replyAndDisconnect("failed");
    }
  });
});
