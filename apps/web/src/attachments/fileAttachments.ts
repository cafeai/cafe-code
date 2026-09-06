import {
  ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type EnvironmentId,
  type ThreadId,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { getPrimaryKnownEnvironment } from "../environments/primary";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import {
  readSavedEnvironmentBearerToken,
  resolveEnvironmentHttpUrl,
} from "../environments/runtime/catalog";
import { FileAttachmentRequestError } from "./fileAttachmentErrors";

const decodeAttachment = Schema.decodeUnknownSync(ChatFileAttachment);
const MAX_PREVIEW_RESPONSE_BYTES = 400 * 1024;

async function fileRequest(
  environmentId: EnvironmentId,
  pathname: string,
  init: RequestInit = {},
  searchParams?: Record<string, string>,
) {
  const primary = getPrimaryKnownEnvironment()?.environmentId === environmentId;
  const bearer = primary ? null : await readSavedEnvironmentBearerToken(environmentId);
  if (!primary && !bearer) throw new FileAttachmentRequestError("environment-unavailable");
  const requestHeaders = new Headers(init.headers);
  if (bearer) requestHeaders.set("authorization", `Bearer ${bearer}`);
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000);
  // Both environment resolvers assign URL.pathname rather than concatenate a
  // URL string. Passing "?preview=text" inside pathname encodes the question
  // mark into the attachment ID, producing a local 404 for a valid upload.
  // Keep path and query structured identically on both routing branches.
  const url = primary
    ? resolvePrimaryEnvironmentHttpUrl(pathname, searchParams)
    : resolveEnvironmentHttpUrl({
        environmentId,
        pathname,
        ...(searchParams ? { searchParams } : {}),
      });
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: requestHeaders,
      credentials: primary ? "include" : "omit",
      redirect: "error",
      signal,
    });
  } catch {
    throw new FileAttachmentRequestError(signal.aborted ? "cancelled" : "transfer-failed");
  }
  if (!response.ok) {
    // A remote backend is not trusted to supply displayable error strings.
    // A body cleanup failure must not discard a known HTTP classification and
    // replace it with an arbitrary browser/remote exception.
    await response.body?.cancel().catch(() => undefined);
    throw new FileAttachmentRequestError(
      response.status === 413
        ? "too-large"
        : response.status === 401 || response.status === 403
          ? "owner-access"
          : response.status === 429
            ? "busy"
            : response.status === 404
              ? "unavailable"
              : "transfer-failed",
    );
  }
  return response;
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("The attachment response was too large.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function uploadFileAttachment(input: {
  environmentId: EnvironmentId;
  targetThreadId: ThreadId;
  file: File;
  signal?: AbortSignal;
  /** A removed/cleared draft must not retain an upload that finished late. */
  shouldRetain?: () => boolean;
}): Promise<ChatFileAttachment> {
  if (input.file.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
    throw new Error("Files must be 25 MiB or smaller.");
  const response = await fileRequest(input.environmentId, "/api/attachments", {
    method: "POST",
    body: input.file,
    headers: {
      "content-type": input.file.type || "application/octet-stream",
      // Replacement applies only to isolated surrogate code units; paired
      // emoji remain untouched. Keep compatibility with the renderer TS lib.
      "x-cafe-attachment-name": encodeURIComponent(
        input.file.name.replace(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
          "\uFFFD",
        ),
      ),
      "x-cafe-thread-id": encodeURIComponent(input.targetThreadId),
      "x-cafe-attachment-lifecycle": "provisional-v1",
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  let attachment: ChatFileAttachment;
  try {
    attachment = decodeAttachment(
      JSON.parse(new TextDecoder().decode(await readBounded(response, 8 * 1024))),
    );
    if (attachment.sizeBytes !== input.file.size) throw new Error("size mismatch");
  } catch {
    throw new Error("The server returned an invalid attachment. Please retry the upload.");
  }
  if (response.headers.get("x-cafe-attachment-lifecycle") === "provisional-v1") {
    const retain = input.shouldRetain?.() ?? true;
    // A successful retain is the server's durable promise that an offline
    // draft/queue may continue referencing these bytes without a TTL. Never
    // expose a ready handle before this ACK; failures remain retryable files.
    const acknowledgement = await fileRequest(
      input.environmentId,
      `/api/attachments/${encodeURIComponent(attachment.id)}/${retain ? "retain" : "discard"}`,
      {
        method: "POST",
        headers: { "x-cafe-thread-id": encodeURIComponent(input.targetThreadId) },
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    await acknowledgement.body?.cancel();
    if (acknowledgement.status !== 204)
      throw new Error("The attachment could not be retained. Please retry the upload.");
    if (!retain) throw new Error("This file was removed before its upload finished.");
  }
  return attachment;
}

export async function getFileAttachmentPreview(input: {
  environmentId: EnvironmentId;
  attachment: ChatFileAttachment;
  signal?: AbortSignal;
}): Promise<{ text: string; truncated: boolean } | null> {
  const attachment = decodeAttachment(input.attachment);
  const response = await fileRequest(
    input.environmentId,
    `/api/attachments/${encodeURIComponent(attachment.id)}`,
    input.signal ? { signal: input.signal } : {},
    { preview: "text" },
  );
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(await readBounded(response, MAX_PREVIEW_RESPONSE_BYTES)),
    );
    if (value === null) return null;
    if (
      typeof value !== "object" ||
      !("text" in value) ||
      typeof value.text !== "string" ||
      !("truncated" in value) ||
      typeof value.truncated !== "boolean" ||
      value.text.length > 65536
    )
      throw new Error("invalid preview");
    return { text: value.text, truncated: value.truncated };
  } catch {
    throw new FileAttachmentRequestError("invalid-preview");
  }
}

export async function downloadFileAttachment(input: {
  environmentId: EnvironmentId;
  attachment: ChatFileAttachment;
}): Promise<void> {
  const attachment = decodeAttachment(input.attachment);
  const response = await fileRequest(
    input.environmentId,
    `/api/attachments/${encodeURIComponent(attachment.id)}`,
  );
  const bytes = await readBounded(response, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
  if (bytes.length !== attachment.sizeBytes)
    throw new FileAttachmentRequestError("incomplete-download");
  // Never navigate to server-provided URLs or render executable HTML/SVG. The
  // local blob always has an inert MIME type and an explicit download intent.
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = attachment.name;
  link.rel = "noopener";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
