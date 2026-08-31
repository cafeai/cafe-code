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
    database.exec("PRAGMA journal_mode = WAL;");
  } catch {
    closeDatabase();
    replyAndDisconnect("failed");
    return;
  }

  process.send?.("ready");
  process.once("message", (command) => {
    if (command !== "write" && !isRetireThreadCommand(command)) {
      closeDatabase();
      replyAndDisconnect("invalid-command");
      return;
    }

    try {
      database.exec("BEGIN IMMEDIATE;");
      if (command === "write") {
        database.exec("INSERT INTO cafe_snapshot_retry_probe(value) VALUES (1);");
      } else {
        // Keep values bound even in a test fixture. Thread ids are opaque input
        // and must never be interpolated into SQL in production-shaped tests.
        database
          .prepare("INSERT INTO hard_deleted_threads(thread_id, deleted_at) VALUES (?, ?)")
          .run(command.threadId, command.deletedAt);
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
