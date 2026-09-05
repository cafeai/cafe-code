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

const decodeAttachment = Schema.decodeUnknownSync(ChatFileAttachment);
const MAX_PREVIEW_RESPONSE_BYTES = 400 * 1024;

async function fileRequest(environmentId: EnvironmentId, pathname: string, init: RequestInit = {}) {
  const primary = getPrimaryKnownEnvironment()?.environmentId === environmentId;
  const bearer = primary ? null : await readSavedEnvironmentBearerToken(environmentId);
  if (!primary && !bearer)
    throw new Error("Reconnect to this environment before using attachments.");
  const requestHeaders = new Headers(init.headers);
  if (bearer) requestHeaders.set("authorization", `Bearer ${bearer}`);
  const signal = init.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)])
    : AbortSignal.timeout(60_000);
  const url = primary
    ? resolvePrimaryEnvironmentHttpUrl(pathname)
    : (() => {
        const [path, query] = pathname.split("?");
        return resolveEnvironmentHttpUrl({
          environmentId,
          pathname: path!,
          ...(query ? { searchParams: Object.fromEntries(new URLSearchParams(query)) } : {}),
        });
      })();
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
    throw new Error(
      signal.aborted
        ? "Attachment transfer was cancelled or timed out. Please retry."
        : "Could not transfer the attachment. Check the connection and retry.",
    );
  }
  if (!response.ok) {
    // A remote backend is not trusted to supply displayable error strings.
    await response.body?.cancel();
    throw new Error(
      response.status === 413
        ? "Files must be 25 MiB or smaller."
        : response.status === 401 || response.status === 403
          ? "Reconnect with owner access to use attachments."
          : response.status === 429
            ? "Several files are being processed. Please try again shortly."
            : response.status === 404
              ? "This attachment is unavailable. Remove it and attach the file again."
              : "The attachment could not be transferred. Please retry.",
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
    },
    ...(input.signal ? { signal: input.signal } : {}),
  });
  try {
    const attachment = decodeAttachment(
      JSON.parse(new TextDecoder().decode(await readBounded(response, 8 * 1024))),
    );
    if (attachment.sizeBytes !== input.file.size) throw new Error("size mismatch");
    return attachment;
  } catch {
    throw new Error("The server returned an invalid attachment. Please retry the upload.");
  }
}

export async function getFileAttachmentPreview(input: {
  environmentId: EnvironmentId;
  attachment: ChatFileAttachment;
  signal?: AbortSignal;
}): Promise<{ text: string; truncated: boolean } | null> {
  const attachment = decodeAttachment(input.attachment);
  const response = await fileRequest(
    input.environmentId,
    `/api/attachments/${encodeURIComponent(attachment.id)}?preview=text`,
    input.signal ? { signal: input.signal } : {},
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
    throw new Error("This file could not be previewed. You can still download it.");
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
    throw new Error("The attachment download was incomplete. Please retry.");
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
