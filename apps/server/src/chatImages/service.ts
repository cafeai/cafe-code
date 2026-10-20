// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { CHAT_IMAGE_MAX_PER_MESSAGE, ChatImageMetadata, ThreadId } from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeStandaloneWorkspaceStore } from "../orchestration/standaloneWorkspace.ts";
import { markdownImageSources, readWorkspaceImage } from "./source.ts";

const decodeMetadata = Schema.decodeUnknownSync(ChatImageMetadata);
// Assets omit only the message-specific Markdown source. The existing public
// metadata bounds still qualify every stored field before source is attached.
const storedMetadata = ChatImageMetadata.mapFields(Struct.omit(["source"]));
const decodeStoredMetadata = Schema.decodeUnknownSync(Schema.fromJsonString(storedMetadata));
const encodeStoredMetadata = Schema.encodeSync(Schema.fromJsonString(storedMetadata));
const decodeRoots = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
export const makeChatImages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const permits = yield* Semaphore.make(2);
  const manifest = (threadId: string, messageId: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ source: string; metadata: string }>`
      SELECT images.source, assets.metadata_json AS metadata
      FROM chat_message_images AS images JOIN chat_image_assets AS assets ON images.digest = assets.digest
      WHERE images.thread_id = ${threadId} AND images.message_id = ${messageId}
        AND EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})
    `;
      return rows.map((row) =>
        decodeMetadata({ ...decodeStoredMetadata(row.metadata), source: row.source }),
      );
    });
  const publish = (threadId: string, messageId: string) =>
    permits
      .withPermits(1)(
        Effect.gen(function* () {
          const rows = yield* sql<{
            text: string;
            root: string | null;
            additional: string | null;
            projectId: string | null;
          }>`SELECT messages.text, COALESCE(threads.worktree_path, projects.workspace_root) AS root,
      projects.additional_workspace_roots_json AS additional, threads.project_id AS "projectId"
      FROM projection_thread_messages AS messages
      JOIN projection_threads AS threads ON threads.thread_id = messages.thread_id
      LEFT JOIN projection_projects AS projects ON projects.project_id = threads.project_id
      JOIN projection_thread_sessions AS sessions ON sessions.thread_id = threads.thread_id
      WHERE messages.thread_id = ${threadId} AND messages.message_id = ${messageId}
        AND messages.role = 'assistant' AND messages.is_streaming = 0 AND sessions.provider_name IN ('codex', 'claudeAgent')
        AND threads.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})`;
          const row = rows[0];
          if (!row) return;
          const sources = markdownImageSources(row.text);
          if (sources.length === 0) return;
          const existing = new Set(
            (yield* manifest(threadId, messageId)).map((entry) => entry.source),
          );
          if (sources.every(({ source }) => existing.has(source))) return;
          let roots = row.root ? [row.root] : [];
          if (row.projectId === null) {
            const standalone = yield* makeStandaloneWorkspaceStore;
            const root = yield* standalone.readExisting(ThreadId.make(threadId));
            if (root) roots = [root];
          } else if (row.additional) {
            const additional = decodeRoots(row.additional);
            roots.push(...additional);
          }
          for (const { source, path } of sources) {
            if (existing.has(source)) continue;
            if (existing.size >= CHAT_IMAGE_MAX_PER_MESSAGE) break;
            // File reads run on this independent, bounded publication lane. Failures
            // neither fail the provider turn nor reveal filesystem diagnostics.
            const result = yield* Effect.tryPromise(() => readWorkspaceImage(path, roots)).pipe(
              Effect.result,
            );
            if (result._tag === "Failure") continue;
            const { bytes, ...metadata } = result.success;
            const digest = createHash("sha256").update(bytes).digest("hex");
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`INSERT INTO chat_image_assets (digest, bytes, metadata_json)
          VALUES (${digest}, ${bytes}, ${encodeStoredMetadata(metadata)}) ON CONFLICT(digest) DO NOTHING`;
                // Publication must still own the same completed message after I/O.
                // Deletion, rewind and repair win over an in-flight file read.
                yield* sql`INSERT INTO chat_message_images (thread_id, message_id, source, digest)
          SELECT ${threadId}, ${messageId}, ${source}, ${digest}
          WHERE EXISTS (SELECT 1 FROM projection_thread_messages
            WHERE thread_id = ${threadId} AND message_id = ${messageId} AND role = 'assistant'
              AND is_streaming = 0 AND text = ${row.text})
            AND (SELECT COUNT(*) FROM chat_message_images WHERE thread_id = ${threadId} AND message_id = ${messageId}) < ${CHAT_IMAGE_MAX_PER_MESSAGE}
            AND EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})
          ON CONFLICT(thread_id, message_id, source) DO NOTHING`;
                yield* sql`DELETE FROM chat_image_assets WHERE digest = ${digest}
          AND NOT EXISTS (SELECT 1 FROM chat_message_images WHERE digest = ${digest})`;
              }),
            );
            existing.add(source);
          }
        }),
      )
      .pipe(Effect.uninterruptible);
  const read = (threadId: string, messageId: string, source: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ bytes: Uint8Array; digest: string; metadata: string }>`
      SELECT assets.bytes, assets.digest, assets.metadata_json AS metadata
      FROM chat_message_images AS images JOIN chat_image_assets AS assets ON assets.digest = images.digest
      WHERE images.thread_id = ${threadId} AND images.message_id = ${messageId} AND images.source = ${source}
        AND EXISTS (SELECT 1 FROM projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})`;
      const row = rows[0];
      if (!row || createHash("sha256").update(row.bytes).digest("hex") !== row.digest) return null;
      return {
        bytes: row.bytes,
        metadata: decodeMetadata({ ...decodeStoredMetadata(row.metadata), source }),
      };
    });
  return { publish, manifest, read };
});

export class ChatImages extends Context.Service<
  ChatImages,
  Effect.Success<typeof makeChatImages>
>()("cafecode/ChatImages") {}
export const ChatImagesLive = Layer.effect(ChatImages, makeChatImages);
