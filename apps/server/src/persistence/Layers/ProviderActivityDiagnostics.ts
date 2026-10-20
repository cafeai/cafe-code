import {
  ProviderDiagnosticSnapshot,
  type OrchestrationThreadActivityDiagnosticInput,
  type ProviderDiagnostic,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { createHash } from "node:crypto";
import {
  providerDiagnosticTextHasCaptureMarker,
  readProviderDiagnosticErrorBody,
} from "@cafecode/shared/providerDiagnostic";
import { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

const decodeSnapshot = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderDiagnosticSnapshot));
const validateSnapshot = Schema.decodeUnknownSync(ProviderDiagnosticSnapshot);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(ProviderDiagnosticSnapshot));
// SQL causes can quote bound JSON. Keep all ordinary ingestion/RPC logs
// content-free even when the private database operation itself fails.
const privateSqlError = (operation: string) => () =>
  new PersistenceSqlError({ operation, detail: "Private diagnostic operation failed" });

/**
 * Only equal, fully captured native error bodies may coalesce a terminal echo.
 *
 * Completeness is judged on the copied error object itself. Terminal envelopes
 * deliberately leave out unrelated turn data (items, native timestamps such as
 * `startedAt`/`completedAt`/`durationMs`, `itemsView`, `rootTurnId`), which
 * sets the snapshot-wide `omittedFields` flag but cannot change the error that
 * both observations report. Codex 0.157+ always sends those turn fields, so
 * the old snapshot-wide check made every failed turn render twice. A capture
 * marker inside the error object (redaction, omission, truncation) still makes
 * the copy ambiguous, so it keeps a distinct occurrence.
 */
export function providerDiagnosticOccurrenceKey(diagnostic: ProviderDiagnostic): string | null {
  const { snapshot, summary } = diagnostic;
  if (
    summary.status !== "error" ||
    !snapshot.native.threadId ||
    !snapshot.native.turnId ||
    !snapshot.native.subagentRuntimeId
  )
    return null;
  // This is our already bounded inert JSON copy, never a provider object.
  const error = readProviderDiagnosticErrorBody(snapshot.json);
  if (!error) return null;
  const encodedError = JSON.stringify(error);
  if (providerDiagnosticTextHasCaptureMarker(encodedError)) return null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        snapshot.native.threadId,
        snapshot.native.turnId,
        snapshot.native.subagentRuntimeId,
        error,
      ]),
    )
    .digest("hex");
}

function messageOnlyTerminalCopy(diagnostic: ProviderDiagnostic): string | undefined {
  const { snapshot, summary } = diagnostic;
  if (summary.status !== "error" || snapshot.truncated || snapshot.message === undefined)
    return undefined;
  const error = readProviderDiagnosticErrorBody(snapshot.json);
  if (!error) return undefined;
  const keys = Object.keys(error);
  return keys.length === 1 &&
    keys[0] === "message" &&
    error.message === snapshot.message &&
    snapshot.message.length > 0 &&
    !providerDiagnosticTextHasCaptureMarker(snapshot.message)
    ? snapshot.message
    : undefined;
}

/** Private store: no transcript snapshots, activity scans, or native provider reads. */
export function makeProviderActivityDiagnosticStore(sql: SqlClient.SqlClient) {
  const read = (input: OrchestrationThreadActivityDiagnosticInput) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly snapshot: string }>`
      SELECT diagnostic.snapshot_json AS snapshot
      FROM provider_activity_diagnostics AS diagnostic
      INNER JOIN projection_thread_activities AS activity
        ON activity.activity_id = diagnostic.activity_id
        AND activity.thread_id = diagnostic.thread_id
        AND activity.turn_id IS diagnostic.turn_id
      INNER JOIN projection_threads AS thread ON thread.thread_id = diagnostic.thread_id
      WHERE diagnostic.activity_id = ${input.activityId}
        AND diagnostic.thread_id = ${input.threadId}
        AND diagnostic.turn_id IS ${input.turnId}
        AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = diagnostic.thread_id)
      LIMIT 1
    `.pipe(Effect.mapError(privateSqlError("ProviderActivityDiagnostics.read")));
      const encoded = rows[0]?.snapshot;
      const diagnostic =
        encoded === undefined
          ? null
          : yield* Effect.try({
              try: () => decodeSnapshot(encoded),
              // Neither corrupt JSON nor schema diagnostics are returned/logged as a
              // cause: they may contain private provider data.
              catch: () =>
                new PersistenceDecodeError({
                  operation: "ProviderActivityDiagnostics.read",
                  issue: "invalid-private-diagnostic",
                }),
            });
      return { ...input, diagnostic };
    });
  const persist = (
    input: OrchestrationThreadActivityDiagnosticInput,
    diagnostic: ProviderDiagnostic,
  ) =>
    Effect.gen(function* () {
      let encoded: string;
      try {
        encoded = encodeSnapshot(validateSnapshot(diagnostic.snapshot));
      } catch {
        return false;
      }
      // Transport schemas bound scalars; enforce the complete encoded copy too.
      if (Buffer.byteLength(encoded, "utf8") > 65_536) return false;
      const rows = yield* sql<{
        readonly activityId: string;
        readonly threadId: string;
        readonly turnId: string | null;
        readonly snapshot: string;
      }>`
        SELECT activity_id AS activityId, thread_id AS threadId, turn_id AS turnId, snapshot_json AS snapshot
        FROM provider_activity_diagnostics WHERE activity_id = ${input.activityId} LIMIT 1
      `;
      const prior = rows[0];
      if (prior)
        return (
          prior.threadId === input.threadId &&
          prior.turnId === input.turnId &&
          prior.snapshot === encoded
        );
      yield* sql`
        INSERT INTO provider_activity_diagnostics (activity_id, thread_id, turn_id, snapshot_json, occurrence_key, created_at)
        SELECT ${input.activityId}, ${input.threadId}, ${input.turnId}, ${encoded}, ${providerDiagnosticOccurrenceKey(diagnostic)}, ${diagnostic.snapshot.observedAt}
        WHERE EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = ${input.threadId})
          AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${input.threadId})
        ON CONFLICT (activity_id) DO NOTHING
      `;
      const admitted = yield* sql<{ readonly present: number }>`SELECT EXISTS (
        SELECT 1 FROM provider_activity_diagnostics WHERE activity_id = ${input.activityId}
          AND thread_id = ${input.threadId} AND turn_id IS ${input.turnId} AND snapshot_json = ${encoded}
      ) AS present`;
      return admitted[0]?.present === 1;
    }).pipe(Effect.mapError(privateSqlError("ProviderActivityDiagnostics.persist")));
  const hasTerminalEcho = (
    input: OrchestrationThreadActivityDiagnosticInput,
    diagnostic: ProviderDiagnostic,
  ) =>
    Effect.gen(function* () {
      if (input.turnId === null) return false;
      const key = providerDiagnosticOccurrenceKey(diagnostic);
      if (key !== null) {
        const rows = yield* sql<{ readonly present: number }>`SELECT EXISTS (
          SELECT 1 FROM provider_activity_diagnostics AS diagnostic
          INNER JOIN projection_thread_activities AS activity ON activity.activity_id = diagnostic.activity_id
            AND activity.thread_id = diagnostic.thread_id AND activity.turn_id IS diagnostic.turn_id
          WHERE diagnostic.thread_id = ${input.threadId} AND diagnostic.turn_id IS ${input.turnId}
            AND diagnostic.occurrence_key = ${key} AND activity.kind = 'runtime.error'
        ) AS present`;
        if (rows[0]?.present === 1) return true;
      }
      // Providers without native error envelopes reach ingestion as a plain
      // terminal `errorMessage`. That copy carries nothing except the message,
      // so folding it into an earlier error with the exact same complete
      // message, Cafe thread/turn and runtime generation loses no evidence.
      // Any other field, capture marker or cut keeps a distinct occurrence.
      const message = messageOnlyTerminalCopy(diagnostic);
      if (message === undefined) return false;
      const runtimeId = diagnostic.snapshot.native.subagentRuntimeId ?? null;
      const rows = yield* sql<{ readonly present: number }>`SELECT EXISTS (
        SELECT 1 FROM provider_activity_diagnostics AS diagnostic
        INNER JOIN projection_thread_activities AS activity ON activity.activity_id = diagnostic.activity_id
          AND activity.thread_id = diagnostic.thread_id AND activity.turn_id IS diagnostic.turn_id
        WHERE diagnostic.thread_id = ${input.threadId} AND diagnostic.turn_id IS ${input.turnId}
          AND activity.kind = 'runtime.error'
          AND json_extract(diagnostic.snapshot_json, '$.message') = ${message}
          AND json_extract(diagnostic.snapshot_json, '$.native.subagentRuntimeId') IS ${runtimeId}
      ) AS present`;
      return rows[0]?.present === 1;
    }).pipe(Effect.mapError(privateSqlError("ProviderActivityDiagnostics.hasTerminalEcho")));
  return { read, persist, hasTerminalEcho };
}
