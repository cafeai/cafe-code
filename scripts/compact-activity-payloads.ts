#!/usr/bin/env node
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  sanitizeActivityPayload,
  sanitizeThreadActivityAppendedEventPayload,
} from "@cafecode/shared/activityPayloadSanitizer";

interface Options {
  readonly dbPath: string;
  readonly write: boolean;
  readonly vacuum: boolean;
  readonly minBytes: number;
}

interface ActivityRow {
  readonly activity_id: string;
  readonly payload_json: string;
}

interface EventRow {
  readonly sequence: number;
  readonly payload_json: string;
}

class CompactActivityPayloadsError extends Data.TaggedError("CompactActivityPayloadsError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

/** A maintenance target must be deliberate even for read-only estimates. No
 * profile, home directory, settings or SQLite handle is inspected to guess it. */
export function parseOptions(
  argv: ReadonlyArray<string>,
  resolvePath: (value: string) => string = resolve,
): Options {
  let dbPath: string | undefined;
  let write = false;
  let vacuum = false;
  let minBytes = 2_048;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--vacuum") {
      vacuum = true;
      continue;
    }
    if (arg === "--db") {
      const next = argv[index + 1];
      if (!next || next.trim().length === 0 || next.startsWith("--")) {
        throw new CompactActivityPayloadsError({
          detail: "--db requires an explicit database path. No database was opened.",
        });
      }
      dbPath = next;
      index += 1;
      continue;
    }
    if (arg === "--min-bytes") {
      const next = argv[index + 1];
      if (!next || !/^\d+$/u.test(next)) {
        throw new CompactActivityPayloadsError({
          detail: "--min-bytes requires a non-negative integer",
        });
      }
      minBytes = Number.parseInt(next, 10);
      index += 1;
      continue;
    }
    throw new CompactActivityPayloadsError({ detail: `Unknown argument: ${arg}` });
  }

  if (dbPath === undefined) {
    throw new CompactActivityPayloadsError({
      detail:
        "An explicit --db <path> is required, including for a dry run. No database was opened.",
    });
  }

  return {
    dbPath: resolvePath(dbPath),
    write,
    vacuum,
    minBytes,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function compactJson(value: string, sanitizer: (payload: unknown) => unknown): string | null {
  const parsed = parseJson(value);
  if (parsed === null) {
    return null;
  }
  const compacted = JSON.stringify(sanitizer(parsed));
  return compacted.length < value.length ? compacted : null;
}

const main = Effect.gen(function* () {
  const options = yield* Effect.try({
    try: () => parseOptions(process.argv.slice(2)),
    catch: (cause) =>
      cause instanceof CompactActivityPayloadsError
        ? cause
        : new CompactActivityPayloadsError({
            detail: "Invalid activity-payload maintenance options.",
            cause,
          }),
  });
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(options.dbPath))) {
    return yield* new CompactActivityPayloadsError({
      detail: `SQLite database not found: ${options.dbPath}`,
    });
  }

  const db = new DatabaseSync(options.dbPath);
  const activityRows = db
    .prepare(
      `
        SELECT activity_id, payload_json
        FROM projection_thread_activities
        WHERE kind IN ('tool.updated', 'tool.completed')
          AND length(payload_json) >= ?
      `,
    )
    .all(options.minBytes) as unknown as ActivityRow[];
  const eventRows = db
    .prepare(
      `
        SELECT sequence, payload_json
        FROM orchestration_events
        WHERE event_type = 'thread.activity-appended'
          AND length(payload_json) >= ?
      `,
    )
    .all(options.minBytes) as unknown as EventRow[];

  const compactedActivities = activityRows
    .map((row) => ({
      id: row.activity_id,
      payload: compactJson(row.payload_json, sanitizeActivityPayload),
      beforeBytes: row.payload_json.length,
    }))
    .filter((row): row is typeof row & { readonly payload: string } => row.payload !== null);
  const compactedEvents = eventRows
    .map((row) => ({
      sequence: row.sequence,
      payload: compactJson(row.payload_json, sanitizeThreadActivityAppendedEventPayload),
      beforeBytes: row.payload_json.length,
    }))
    .filter((row): row is typeof row & { readonly payload: string } => row.payload !== null);

  const activitySavedBytes = compactedActivities.reduce(
    (total, row) => total + row.beforeBytes - row.payload.length,
    0,
  );
  const eventSavedBytes = compactedEvents.reduce(
    (total, row) => total + row.beforeBytes - row.payload.length,
    0,
  );

  yield* Console.log(
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    JSON.stringify(
      {
        dbPath: options.dbPath,
        mode: options.write ? "write" : "dry-run",
        activityRowsScanned: activityRows.length,
        activityRowsCompacted: compactedActivities.length,
        eventRowsScanned: eventRows.length,
        eventRowsCompacted: compactedEvents.length,
        estimatedSavedBytes: activitySavedBytes + eventSavedBytes,
        vacuum: options.write && options.vacuum,
      },
      null,
      2,
    ),
  );

  if (!options.write) {
    db.close();
    return;
  }

  yield* Effect.try({
    try: () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const updateActivity = db.prepare(
          "UPDATE projection_thread_activities SET payload_json = ? WHERE activity_id = ?",
        );
        for (const row of compactedActivities) {
          updateActivity.run(row.payload, row.id);
        }

        const updateEvent = db.prepare(
          "UPDATE orchestration_events SET payload_json = ? WHERE sequence = ?",
        );
        for (const row of compactedEvents) {
          updateEvent.run(row.payload, row.sequence);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    catch: (cause) =>
      new CompactActivityPayloadsError({
        detail: "Failed to compact SQLite activity payloads.",
        cause,
      }),
  });

  if (options.vacuum) {
    db.exec("VACUUM");
  }
  db.close();
});

// Importing the option parser must not run a maintenance operation. This guard
// compares lexical module/entry names only and does not inspect either DB.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
