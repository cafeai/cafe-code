import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  DESKTOP_OBSERVATION_MAX_BYTES,
  DesktopObservationReference,
  DesktopObservationRetention,
  VirtualDesktopId,
  type ThreadId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeReference = Schema.decodeUnknownSync(DesktopObservationReference);
const validId = Schema.is(VirtualDesktopId);
const validRetention = Schema.is(DesktopObservationRetention);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const CLEANUP_BATCH = 32;

interface ObservationRow {
  id: string;
  sequence: number;
  sha256: string;
  byte_length: number;
}

/** One writer belongs to the desktop runtime; backend HTTP creates read-only
 * handles. Only that writer may recover pending intents after owner handoff.
 * Files never enter provider journals, transcript SQLite blobs, or logs. */
export const makeDesktopObservationStore = (stateDir: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const run = Effect.runPromise;
    const directory = join(stateDir, "desktop-observations");
    let retention = 0;
    let cleanupCursor = 0;
    let closed = false;
    let tail: Promise<unknown> = Promise.resolve();
    const serial = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = tail.then(operation);
      tail = result.catch(() => undefined);
      return result;
    };
    const privateDirectory = async (create: boolean) => {
      if (create) await fs.mkdir(directory, { mode: 0o700 });
      const info = await fs.lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.platform !== "win32" &&
          (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
      )
        throw new Error("Observation storage is unavailable.");
    };
    const ensureDirectory = async () => {
      try {
        await privateDirectory(true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await privateDirectory(false);
      }
    };
    const prune = async () => {
      // The indexed offset reads identifiers only, never historical PNG bytes.
      await run(
        sql`UPDATE desktop_observations SET state = 'retired'
      WHERE state = 'ready' AND sequence <= (
        SELECT sequence FROM desktop_observations WHERE state = 'ready'
        ORDER BY sequence DESC LIMIT 1 OFFSET ${retention}
      )`.pipe(Effect.asVoid),
      );
    };
    const cleanup = async () => {
      const rows = await run(sql<ObservationRow>`SELECT id, sequence FROM desktop_observations
      WHERE state = 'retired' AND sequence > ${cleanupCursor}
      ORDER BY sequence LIMIT ${CLEANUP_BATCH}`);
      if (!rows.length) {
        cleanupCursor = 0;
        return;
      }
      for (const row of rows) {
        cleanupCursor = row.sequence;
        if (!validId(row.id)) continue;
        try {
          await privateDirectory(false);
          await fs
            .unlink(join(directory, `${row.id}.png`))
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
          await run(
            sql`DELETE FROM desktop_observations WHERE id = ${row.id} AND state = 'retired'`.pipe(
              Effect.asVoid,
            ),
          );
        } catch (error) {
          // A failed/unavailable directory remains retryable. Rotate past failures
          // so one undeletable file cannot starve newer retired observations.
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            await run(
              sql`DELETE FROM desktop_observations WHERE id = ${row.id} AND state = 'retired'`.pipe(
                Effect.asVoid,
              ),
            );
        }
      }
    };
    const retained = async (id: string, threadId: ThreadId, limit: number) => {
      if (!validId(id) || !validRetention(limit) || limit === 0) return undefined;
      return (
        await run(sql<ObservationRow>`SELECT id, sequence, sha256, byte_length
      FROM desktop_observations WHERE id = ${id} AND thread_id = ${threadId} AND state = 'ready'
      AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})
      AND sequence >= COALESCE((SELECT sequence FROM desktop_observations WHERE state = 'ready'
        ORDER BY sequence DESC LIMIT 1 OFFSET ${limit - 1}), 0)`)
      )[0];
    };
    return {
      setRetention: (limit: number, recoverPending = false) =>
        serial(async () => {
          if (!validRetention(limit)) throw new Error("Invalid observation retention.");
          retention = limit;
          // No other writer survives the provider-runtime ownership boundary. Never
          // perform this recovery from an HTTP reader or a settings refresh.
          if (recoverPending)
            await run(
              sql`UPDATE desktop_observations SET state = 'retired' WHERE state = 'pending'`.pipe(
                Effect.asVoid,
              ),
            );
          await prune();
          await cleanup();
        }),
      sweep: () =>
        serial(async () => {
          // The writer queue is quiescent here. If a failed capture could not
          // retire its intent (for example SQLite was busy), retry that cleanup
          // now; never age-expire a pending write from a separate HTTP reader.
          await run(
            sql`UPDATE desktop_observations SET state = 'retired' WHERE state = 'pending'`.pipe(
              Effect.asVoid,
            ),
          );
          await prune();
          await cleanup();
        }),
      close: () => {
        closed = true;
        return tail.then(() => undefined);
      },
      save: (threadId: ThreadId, result: Record<string, unknown>) => {
        const reference = decodeReference({
          id: randomUUID(),
          capturedAt: new Date().toISOString(),
          width: result.width,
          height: result.height,
          frame: result.frame,
          humanControl: result.humanControl,
          storage: "failed",
        });
        if (closed) return Promise.resolve(reference);
        return serial(async (): Promise<DesktopObservationReference> => {
          if (retention === 0) return { ...reference, storage: "disabled" };
          try {
            if (
              typeof result.image !== "string" ||
              result.image.length > Math.ceil(DESKTOP_OBSERVATION_MAX_BYTES / 3) * 4
            )
              throw new Error("Invalid observation image.");
            const bytes = Buffer.from(result.image, "base64");
            // Accept only the bounded native PNG, and verify its dimensions. This
            // is an artifact sink, never an arbitrary file-write API.
            if (
              bytes.length < 24 ||
              bytes.length > DESKTOP_OBSERVATION_MAX_BYTES ||
              !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
              bytes.toString("ascii", 12, 16) !== "IHDR" ||
              bytes.readUInt32BE(16) !== reference.width ||
              bytes.readUInt32BE(20) !== reference.height
            )
              throw new Error("Invalid observation image.");
            await ensureDirectory();
            const saved = { ...reference, storage: "saved" } as const;
            await run(
              sql`INSERT INTO desktop_observations (id, thread_id, metadata_json, sha256, byte_length, state)
            VALUES (${reference.id}, ${threadId}, ${JSON.stringify(saved)}, ${hash(bytes)}, ${bytes.length}, 'pending')`.pipe(
                Effect.asVoid,
              ),
            );
            const file = await fs.open(join(directory, `${reference.id}.png`), "wx", 0o600);
            try {
              await file.writeFile(bytes);
              await file.sync();
            } finally {
              await file.close();
            }
            // A hard deletion can retire this intent while the file is writing.
            // Never resurrect that row, even if the native observe itself succeeded.
            await run(
              sql`UPDATE desktop_observations SET state = 'ready'
            WHERE id = ${reference.id} AND state = 'pending'`.pipe(Effect.asVoid),
            );
            await prune();
            const committed = await retained(reference.id, threadId, retention);
            await cleanup();
            return committed ? saved : reference;
          } catch {
            // Saving history is auxiliary: do not fail a valid live screenshot or
            // induce the model to retry input because disk space or storage failed.
            await run(
              sql`UPDATE desktop_observations SET state = 'retired'
            WHERE id = ${reference.id}`.pipe(Effect.asVoid),
            ).catch(() => undefined);
            await cleanup().catch(() => undefined);
            return reference;
          }
        });
      },
      read: async (
        id: string,
        threadId: ThreadId,
        limit: number,
      ): Promise<Uint8Array | undefined> => {
        const row = await retained(id, threadId, limit);
        if (!row || row.byte_length < 24 || row.byte_length > DESKTOP_OBSERVATION_MAX_BYTES)
          return undefined;
        await privateDirectory(false);
        const file = await fs.open(
          join(directory, `${row.id}.png`),
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const info = await file.stat();
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            info.size !== row.byte_length ||
            (process.platform !== "win32" &&
              (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
          )
            return undefined;
          // Bounded read even if a same-user process grows the file after stat().
          const bytes = Buffer.alloc(row.byte_length);
          let offset = 0;
          while (offset < bytes.length) {
            const read = await file.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) return undefined;
            offset += read.bytesRead;
          }
          if (hash(bytes) !== row.sha256 || !(await retained(id, threadId, limit)))
            return undefined;
          return bytes;
        } finally {
          await file.close();
        }
      },
    };
  });

export type DesktopObservationStore = Effect.Success<
  ReturnType<typeof makeDesktopObservationStore>
>;
