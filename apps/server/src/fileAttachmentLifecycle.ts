import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { FileAttachmentError, removeClaimedFileAttachment } from "./fileAttachmentStore.ts";

export const FILE_ATTACHMENT_PROVISIONAL_TTL_MS = 60 * 60 * 1000;
export const FILE_ATTACHMENT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 16;
interface UploadRow {
  readonly id: string;
  readonly threadId: string;
  readonly state: string;
  readonly writerPid: number;
}

export const registerFileAttachmentUpload = (
  sql: SqlClient.SqlClient,
  input: {
    attachmentId: string;
    threadId: string;
    nowMs: number;
  },
) => sql`
  INSERT INTO file_attachment_uploads (attachment_id, thread_id, state, expires_at, writer_pid)
  VALUES (${input.attachmentId}, ${input.threadId}, 'writing', ${input.nowMs + FILE_ATTACHMENT_PROVISIONAL_TTL_MS}, ${process.pid})
`;

export const publishFileAttachmentUpload = (
  sql: SqlClient.SqlClient,
  id: string,
  nowMs: number,
) => sql`
  UPDATE file_attachment_uploads SET state = 'provisional', expires_at = ${nowMs + FILE_ATTACHMENT_PROVISIONAL_TTL_MS}
  WHERE attachment_id = ${id} AND state = 'writing'
`;

/**
 * Retain acknowledgement is a durable promise to an offline draft/queue. It
 * never expires. The same atomic writer fence runs before normalization reads
 * bytes, preventing an expiry collector from deleting between read and commit.
 * Absent rows are protected legacy uploads/committed attachments, not garbage.
 */
export const retainFileAttachmentUpload = (
  sql: SqlClient.SqlClient,
  input: {
    attachmentId: string;
    threadId: string;
  },
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
    UPDATE file_attachment_uploads SET state = 'retained'
    WHERE attachment_id = ${input.attachmentId} AND thread_id = ${input.threadId}
      AND state = 'provisional'
      AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${input.threadId})
  `;
      const rows = yield* sql<{ readonly threadId: string; readonly state: string }>`
    SELECT thread_id AS "threadId", state FROM file_attachment_uploads WHERE attachment_id = ${input.attachmentId}
  `;
      if (
        rows.length > 0 &&
        (rows[0]?.threadId !== input.threadId || rows[0]?.state !== "retained")
      ) {
        return yield* Effect.fail(new FileAttachmentError("unavailable"));
      }
    }),
  );

/** Only signal 0 is used. Permission/unknown failures never prove owner exit. */
function writerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

const removeClaimed = (sql: SqlClient.SqlClient, attachmentsDir: string, id: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => removeClaimedFileAttachment(attachmentsDir, id),
      catch: () => new FileAttachmentError("unavailable"),
    });
    yield* sql`DELETE FROM file_attachment_uploads WHERE attachment_id = ${id} AND state = 'deleting'`;
  });

/** An explicit discard never revokes a retained/committed offline reference. */
export const discardFileAttachmentUpload = (
  sql: SqlClient.SqlClient,
  input: {
    attachmentId: string;
    threadId: string;
    attachmentsDir: string;
  },
) =>
  Effect.gen(function* () {
    const claimed = yield* sql<{ readonly id: string }>`
    UPDATE file_attachment_uploads SET state = 'deleting', expires_at = 0
    WHERE attachment_id = ${input.attachmentId} AND thread_id = ${input.threadId}
      AND state IN ('provisional', 'deleting')
      AND NOT EXISTS (SELECT 1 FROM attachment_content_commitments WHERE attachment_id = ${input.attachmentId})
    RETURNING attachment_id AS id
  `;
    if (claimed.length > 0) yield* removeClaimed(sql, input.attachmentsDir, input.attachmentId);
  });

/**
 * Bounded indexed batches, never a directory/history scan. The SQL state CAS
 * is the cross-process cleanup/retain linearization point. Writing rows are
 * different: no file may be removed while their owner can still publish late
 * metadata, so only a conclusively absent PID permits crash cleanup.
 */
export const cleanupFileAttachmentUploads = (
  sql: SqlClient.SqlClient,
  input: {
    attachmentsDir: string;
    nowMs: number;
    isWriterAlive?: (pid: number) => boolean;
  },
) =>
  Effect.gen(function* () {
    const candidates: UploadRow[] = [];
    // One exact state per indexed range avoids sorting/scanning every retained
    // offline upload just to find a small expired batch.
    for (const state of ["provisional", "deleting", "writing"] as const) {
      const rows = yield* sql<UploadRow>`
      SELECT attachment_id AS id, thread_id AS "threadId", state, writer_pid AS "writerPid"
      FROM file_attachment_uploads WHERE state = ${state} AND expires_at <= ${input.nowMs}
      ORDER BY expires_at, attachment_id LIMIT ${CLEANUP_BATCH_SIZE}
    `;
      candidates.push(...rows);
    }
    let removed = 0;
    for (const row of candidates) {
      if (row.state === "writing" && (input.isWriterAlive ?? writerIsAlive)(row.writerPid)) {
        // Move an inconclusive/live writer behind older eligible rows. Without
        // this retry timestamp, sixteen long-lived writers could permanently
        // starve crash cleanup in a count-bounded oldest-first batch.
        yield* sql`UPDATE file_attachment_uploads SET expires_at = ${input.nowMs + FILE_ATTACHMENT_CLEANUP_INTERVAL_MS}
          WHERE attachment_id = ${row.id} AND state = 'writing'`;
        continue;
      }
      const claimed = yield* sql<{ readonly id: string }>`
      UPDATE file_attachment_uploads SET state = 'deleting'
      WHERE attachment_id = ${row.id} AND state = ${row.state}
        AND NOT EXISTS (SELECT 1 FROM attachment_content_commitments WHERE attachment_id = ${row.id})
      RETURNING attachment_id AS id
    `;
      if (claimed.length === 0) continue;
      const completed = yield* removeClaimed(sql, input.attachmentsDir, row.id).pipe(Effect.result);
      if (completed._tag === "Success") removed += 1;
      else {
        // Retain ownership, but rotate failed I/O behind other expired work.
        yield* sql`UPDATE file_attachment_uploads SET expires_at = ${input.nowMs + FILE_ATTACHMENT_CLEANUP_INTERVAL_MS}
          WHERE attachment_id = ${row.id} AND state = 'deleting'`;
        yield* Effect.logWarning("provisional attachment cleanup remains pending");
      }
    }
    return removed;
  });
