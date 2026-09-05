import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@cafecode/contracts";
import { ServerAuth, AuthError } from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { ServerConfig } from "./config.ts";
import { browserApiCorsHeaders } from "./httpCors.ts";
import {
  FileAttachmentError,
  previewFileAttachment,
  readFileAttachmentById,
  removeNewFileAttachment,
  storeFileAttachment,
} from "./fileAttachmentStore.ts";

const headers = {
  ...browserApiCorsHeaders,
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
// Admission is process-owned, not connection-owned. A reconnect must not bypass
// the memory bound while old HTTP bodies are still arriving.
let activeUploads = 0;
const MAX_ACTIVE_UPLOADS = 4;
let activeReads = 0;
const MAX_ACTIVE_READS = 4;

const owner = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const session = yield* (yield* ServerAuth).authenticateHttpRequest(request);
  if (session.role !== "owner")
    return yield* new AuthError({ message: "Owner access required.", status: 403 });
});

const assertThreadAvailable = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const deleted =
      yield* sql`SELECT thread_id FROM hard_deleted_threads WHERE thread_id = ${threadId} LIMIT 1`;
    if (deleted.length) return yield* Effect.fail(new FileAttachmentError("unavailable"));
  });

const respondToFileError = (error: FileAttachmentError) =>
  Effect.succeed(
    HttpServerResponse.jsonUnsafe(
      { error: error.code, message: error.message },
      {
        status:
          error.code === "too-large"
            ? 413
            : error.code === "busy"
              ? 429
              : error.code === "unavailable"
                ? 404
                : 400,
        headers,
      },
    ),
  );

export const fileAttachmentUploadRouteLayer = HttpRouter.add(
  "POST",
  "/api/attachments",
  Effect.gen(function* () {
    yield* owner;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const metadata = yield* Effect.try({
      try: () => ({
        threadId: decodeURIComponent(request.headers["x-cafe-thread-id"] ?? ""),
        name: decodeURIComponent(request.headers["x-cafe-attachment-name"] ?? ""),
      }),
      catch: () => new FileAttachmentError("invalid"),
    });
    if (
      !metadata.threadId.trim() ||
      metadata.threadId.length > 512 ||
      !metadata.name ||
      metadata.name.length > 2048
    ) {
      return yield* Effect.fail(new FileAttachmentError("invalid"));
    }
    const declared = request.headers["content-length"];
    if (
      declared !== undefined &&
      (!/^\d+$/u.test(declared) || Number(declared) > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
    ) {
      return yield* Effect.fail(new FileAttachmentError("too-large"));
    }
    yield* assertThreadAvailable(metadata.threadId);
    return yield* Effect.acquireUseRelease(
      Effect.suspend(() =>
        activeUploads >= MAX_ACTIVE_UPLOADS
          ? Effect.fail(new FileAttachmentError("busy"))
          : Effect.sync(() => {
              activeUploads += 1;
            }),
      ),
      () =>
        Effect.gen(function* () {
          // Do not trust Content-Length and do not call arrayBuffer(), which can
          // buffer an unbounded chunked body before the application checks it.
          const collected = yield* request.stream.pipe(
            Stream.runFoldEffect(
              () => ({ chunks: [] as Uint8Array[], length: 0 }),
              (state, chunk) =>
                state.length + chunk.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES
                  ? Effect.fail(new FileAttachmentError("too-large"))
                  : Effect.sync(() => {
                      state.chunks.push(chunk);
                      state.length += chunk.byteLength;
                      return state;
                    }),
            ),
            Effect.mapError((error) =>
              error instanceof FileAttachmentError ? error : new FileAttachmentError("invalid"),
            ),
            Effect.timeoutOrElse({
              duration: "60 seconds",
              orElse: () => Effect.fail(new FileAttachmentError("unavailable")),
            }),
          );
          const bytes = new Uint8Array(collected.length);
          let offset = 0;
          for (const chunk of collected.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          yield* assertThreadAvailable(metadata.threadId);
          // Once bounded bytes have been collected, publication and the final
          // tombstone check are one short commit section. Node filesystem
          // promises are not cancelled by an Effect interruption: otherwise a
          // disconnected client could release admission while a late metadata
          // write escapes the deletion check and recreates a deleted upload.
          const attachment = yield* Effect.gen(function* () {
            const published = yield* Effect.tryPromise({
              try: () =>
                storeFileAttachment({
                  attachmentsDir: config.attachmentsDir,
                  ...metadata,
                  mimeType: request.headers["content-type"] ?? "application/octet-stream",
                  bytes,
                }),
              catch: (error) =>
                error instanceof FileAttachmentError
                  ? error
                  : new FileAttachmentError("unavailable"),
            });
            yield* assertThreadAvailable(metadata.threadId).pipe(
              Effect.tapError(() =>
                Effect.promise(() => removeNewFileAttachment(config.attachmentsDir, published)),
              ),
            );
            return published;
          }).pipe(Effect.uninterruptible);
          return HttpServerResponse.jsonUnsafe(attachment, { status: 201, headers });
        }),
      () =>
        Effect.sync(() => {
          activeUploads -= 1;
        }),
    );
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("FileAttachmentError", respondToFileError),
  ),
);

export const fileAttachmentReadRouteLayer = HttpRouter.add(
  "GET",
  "/api/attachments/*",
  Effect.gen(function* () {
    yield* owner;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return yield* Effect.fail(new FileAttachmentError("invalid"));
    const id = url.value.pathname.slice("/api/attachments/".length);
    // Bound simultaneous disk reads and SHA-256 work as well as uploads. This
    // gate is shared across clients, including a client that has reconnected.
    const stored = yield* Effect.acquireUseRelease(
      Effect.suspend(() =>
        activeReads >= MAX_ACTIVE_READS
          ? Effect.fail(new FileAttachmentError("busy"))
          : Effect.sync(() => {
              activeReads += 1;
            }),
      ),
      () =>
        Effect.tryPromise({
          try: () => readFileAttachmentById(config.attachmentsDir, id),
          catch: () => new FileAttachmentError("unavailable"),
        }),
      () =>
        Effect.sync(() => {
          activeReads -= 1;
        }),
    );
    yield* assertThreadAvailable(stored.threadId);
    if (url.value.searchParams.get("preview") === "text") {
      return HttpServerResponse.jsonUnsafe(previewFileAttachment(stored.bytes), { headers });
    }
    return HttpServerResponse.uint8Array(stored.bytes, {
      contentType: "application/octet-stream",
      headers: {
        ...headers,
        "content-disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(stored.attachment.name).replace(/['()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  }).pipe(
    Effect.catchTag("AuthError", respondToAuthError),
    Effect.catchTag("FileAttachmentError", respondToFileError),
  ),
);

export const fileAttachmentRouteLayer = Layer.mergeAll(
  fileAttachmentUploadRouteLayer,
  fileAttachmentReadRouteLayer,
);
