import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { fileAttachmentStoragePaths, storeFileAttachment } from "./fileAttachmentStore.ts";
import {
  cleanupFileAttachmentUploads,
  discardFileAttachmentUpload,
  FILE_ATTACHMENT_PROVISIONAL_TTL_MS,
  FILE_ATTACHMENT_CLEANUP_INTERVAL_MS,
  publishFileAttachmentUpload,
  registerFileAttachmentUpload,
  retainFileAttachmentUpload,
} from "./fileAttachmentLifecycle.ts";

const withStore = <A, E, R>(
  body: (input: {
    sql: SqlClient.SqlClient;
    fs: FileSystem.FileSystem;
    attachmentsDir: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-upload-lifecycle-" });
    return yield* body({ sql, fs, attachmentsDir });
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer)),
  );

function upload(input: { sql: SqlClient.SqlClient; attachmentsDir: string }, publish = true) {
  return Effect.gen(function* () {
    const attachment = yield* Effect.promise(() =>
      storeFileAttachment({
        attachmentsDir: input.attachmentsDir,
        threadId: "future-thread",
        name: "notes.tex",
        mimeType: "text/plain",
        bytes: new TextEncoder().encode("private bytes"),
        onAllocated: (file) =>
          Effect.runPromise(
            registerFileAttachmentUpload(input.sql, {
              attachmentId: file.id,
              threadId: "future-thread",
              nowMs: 0,
            }).pipe(Effect.asVoid),
          ),
      }),
    );
    if (publish) yield* publishFileAttachmentUpload(input.sql, attachment.id, 0);
    return attachment;
  });
}

describe("private file upload lifecycle", () => {
  it.effect(
    "rejects retired-thread allocation before bytes are written and cleans its retained uploads",
    () =>
      withStore((input) =>
        Effect.gen(function* () {
          const file = yield* upload(input);
          yield* retainFileAttachmentUpload(input.sql, {
            attachmentId: file.id,
            threadId: "future-thread",
          });
          yield* input.sql`INSERT INTO hard_deleted_threads (thread_id, deleted_at) VALUES ('future-thread', '2026-09-06T00:00:00.000Z')`;
          assert.equal(yield* cleanupFileAttachmentUploads(input.sql, { ...input, nowMs: 0 }), 1);
          assert.equal((yield* upload(input).pipe(Effect.exit))._tag, "Failure");
          assert.deepEqual(yield* input.fs.readDirectory(input.attachmentsDir), []);
        }),
      ),
  );
  it.effect(
    "reclaims expired unacknowledged uploads while retaining offline and legacy handles",
    () =>
      withStore((input) =>
        Effect.gen(function* () {
          const provisional = yield* upload(input);
          const retained = yield* upload(input);
          const legacy = yield* Effect.promise(() =>
            storeFileAttachment({
              attachmentsDir: input.attachmentsDir,
              threadId: "legacy",
              name: "legacy",
              mimeType: "text/plain",
              bytes: new Uint8Array(),
            }),
          );
          yield* retainFileAttachmentUpload(input.sql, {
            attachmentId: retained.id,
            threadId: "future-thread",
          });
          const nowMs = FILE_ATTACHMENT_PROVISIONAL_TTL_MS + 1;
          assert.equal(yield* cleanupFileAttachmentUploads(input.sql, { ...input, nowMs }), 1);
          assert.equal(
            yield* input.fs.exists(
              fileAttachmentStoragePaths(input.attachmentsDir, provisional.id).data,
            ),
            false,
          );
          assert.equal(
            yield* input.fs.exists(
              fileAttachmentStoragePaths(input.attachmentsDir, retained.id).data,
            ),
            true,
          );
          assert.equal(
            yield* input.fs.exists(
              fileAttachmentStoragePaths(input.attachmentsDir, legacy.id).data,
            ),
            true,
          );
          assert.equal(
            yield* cleanupFileAttachmentUploads(input.sql, { ...input, nowMs: nowMs * 1000 }),
            0,
          );
        }),
      ),
  );

  it.effect("never revokes retained references or accepts another thread's discard", () =>
    withStore((input) =>
      Effect.gen(function* () {
        const file = yield* upload(input);
        yield* discardFileAttachmentUpload(input.sql, {
          ...input,
          attachmentId: file.id,
          threadId: "wrong-thread",
        });
        assert.equal(
          yield* input.fs.exists(fileAttachmentStoragePaths(input.attachmentsDir, file.id).data),
          true,
        );
        const wrong = yield* retainFileAttachmentUpload(input.sql, {
          attachmentId: file.id,
          threadId: "wrong-thread",
        }).pipe(Effect.result);
        assert.equal(wrong._tag, "Failure");
        yield* retainFileAttachmentUpload(input.sql, {
          attachmentId: file.id,
          threadId: "future-thread",
        });
        yield* discardFileAttachmentUpload(input.sql, {
          ...input,
          attachmentId: file.id,
          threadId: "future-thread",
        });
        assert.equal(
          yield* input.fs.exists(fileAttachmentStoragePaths(input.attachmentsDir, file.id).data),
          true,
        );
      }),
    ),
  );

  it.effect("retains the deleting claim across interrupted removal and fences late retain", () =>
    withStore((input) =>
      Effect.gen(function* () {
        const file = yield* upload(input);
        const paths = fileAttachmentStoragePaths(input.attachmentsDir, file.id);
        yield* input.sql`UPDATE file_attachment_uploads SET state = 'deleting' WHERE attachment_id = ${file.id}`;
        yield* input.fs.remove(paths.data);
        assert.equal(
          (yield* retainFileAttachmentUpload(input.sql, {
            attachmentId: file.id,
            threadId: "future-thread",
          }).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          yield* cleanupFileAttachmentUploads(input.sql, {
            ...input,
            nowMs: FILE_ATTACHMENT_PROVISIONAL_TTL_MS + 1,
          }),
          1,
        );
        assert.equal(yield* input.fs.exists(paths.metadata), false);
        assert.deepEqual(yield* input.sql`SELECT * FROM file_attachment_uploads`, []);
      }),
    ),
  );

  it.effect("keeps failed filesystem cleanup claimed until a later safe retry", () =>
    withStore((input) =>
      Effect.gen(function* () {
        const file = yield* upload(input);
        const paths = fileAttachmentStoragePaths(input.attachmentsDir, file.id);
        // A directory cannot be unlinked as a file. This deterministic fixture
        // models a cleanup I/O failure without changing real filesystem access.
        yield* input.fs.remove(paths.metadata);
        yield* input.fs.makeDirectory(paths.metadata);
        const nowMs = FILE_ATTACHMENT_PROVISIONAL_TTL_MS + 1;
        assert.equal(yield* cleanupFileAttachmentUploads(input.sql, { ...input, nowMs }), 0);
        assert.deepEqual(
          yield* input.sql`SELECT state FROM file_attachment_uploads WHERE attachment_id = ${file.id}`,
          [{ state: "deleting" }],
        );
        assert.equal(
          (yield* retainFileAttachmentUpload(input.sql, {
            attachmentId: file.id,
            threadId: "future-thread",
          }).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* input.fs.remove(paths.metadata, { recursive: true });
        assert.equal(
          yield* cleanupFileAttachmentUploads(input.sql, {
            ...input,
            nowMs: nowMs + FILE_ATTACHMENT_CLEANUP_INTERVAL_MS,
          }),
          1,
        );
      }),
    ),
  );

  it.effect("cleans partial crash writes only after the writer is conclusively absent", () =>
    withStore((input) =>
      Effect.gen(function* () {
        const file = yield* upload(input, false);
        const nowMs = FILE_ATTACHMENT_PROVISIONAL_TTL_MS + 1;
        assert.equal(
          yield* cleanupFileAttachmentUploads(input.sql, {
            ...input,
            nowMs,
            isWriterAlive: () => true,
          }),
          0,
        );
        assert.equal(
          yield* cleanupFileAttachmentUploads(input.sql, {
            ...input,
            nowMs: nowMs + FILE_ATTACHMENT_CLEANUP_INTERVAL_MS,
            isWriterAlive: () => false,
          }),
          1,
        );
        assert.equal(
          yield* input.fs.exists(fileAttachmentStoragePaths(input.attachmentsDir, file.id).data),
          false,
        );
      }),
    ),
  );

  it.effect("uses finite indexed batches and preserves newer uploads", () =>
    withStore((input) =>
      Effect.gen(function* () {
        for (let index = 0; index < 18; index += 1) yield* upload(input);
        const newer = yield* upload(input);
        yield* input.sql`UPDATE file_attachment_uploads SET expires_at = ${FILE_ATTACHMENT_PROVISIONAL_TTL_MS * 3} WHERE attachment_id = ${newer.id}`;
        const nowMs = FILE_ATTACHMENT_PROVISIONAL_TTL_MS + 1;
        assert.equal(yield* cleanupFileAttachmentUploads(input.sql, { ...input, nowMs }), 16);
        assert.equal(yield* cleanupFileAttachmentUploads(input.sql, { ...input, nowMs }), 2);
        assert.equal(
          yield* input.fs.exists(fileAttachmentStoragePaths(input.attachmentsDir, newer.id).data),
          true,
        );
      }),
    ),
  );
});
