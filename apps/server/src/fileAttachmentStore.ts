// @effect-diagnostics nodeBuiltinImport:off
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import NodePath from "node:path";
import * as Schema from "effect/Schema";
import { ChatFileAttachment, PROVIDER_SEND_TURN_MAX_FILE_BYTES } from "@cafecode/contracts";
import { createAttachmentId, parseThreadSegmentFromAttachmentId } from "./attachmentStore.ts";

const MAX_METADATA_BYTES = 8 * 1024;
const MAX_PREVIEW_BYTES = 64 * 1024;
const decodeAttachment = Schema.decodeUnknownSync(ChatFileAttachment);
const decodeMetadata = Schema.decodeUnknownSync(
  Schema.Struct({
    attachment: ChatFileAttachment,
    threadId: Schema.String,
    sha256: Schema.String,
  }),
);

/** Deliberately fixed errors: filenames, paths and parser exceptions never enter diagnostics. */
export class FileAttachmentError extends Error {
  readonly _tag = "FileAttachmentError";
  readonly code: "invalid" | "too-large" | "unavailable" | "busy";
  constructor(code: "invalid" | "too-large" | "unavailable" | "busy") {
    super(
      code === "too-large"
        ? "Files must be 25 MiB or smaller."
        : code === "busy"
          ? "Several files are being processed. Please try again shortly."
          : code === "unavailable"
            ? "This attachment is unavailable. Remove it and attach the file again."
            : "The attachment could not be validated. Please attach it again.",
    );
    this.code = code;
  }
}

export function normalizeFileAttachmentName(name: string): string {
  // Treat both platforms' path separators as separators, irrespective of the
  // host OS. Bidi/control characters must not disguise a file's visible suffix.
  const leaf = name.split(/[/\\]/u).at(-1) ?? "";
  const safe = leaf
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .slice(0, 255)
    // A UTF-16 limit can bisect an emoji. Keep stored names URI-encodable for
    // Content-Disposition without allowing a valid upload to break downloads.
    .toWellFormed();
  return safe && safe !== "." && safe !== ".." ? safe : "attachment";
}

export function normalizeFileAttachmentMimeType(mime: string): string {
  const type = mime.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(type) && type.length <= 100
    ? type
    : "application/octet-stream";
}

export function fileAttachmentStoragePaths(attachmentsDir: string, id: string) {
  if (!parseThreadSegmentFromAttachmentId(id) || id.length > 128) {
    throw new FileAttachmentError("invalid");
  }
  return {
    data: NodePath.join(attachmentsDir, `${id}.bin`),
    metadata: NodePath.join(attachmentsDir, `${id}.metadata.json`),
  };
}

async function verifyRoot(attachmentsDir: string) {
  const info = await lstat(attachmentsDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new FileAttachmentError("invalid");
}

async function readPrivateBounded(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new FileAttachmentError("invalid");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.dev !== before.dev ||
      info.ino !== before.ino ||
      info.size > limit ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
      throw new FileAttachmentError("invalid");
    }
    // A fixed limit-plus-one read also bounds a file that grows after stat.
    const bytes = Buffer.alloc(Math.min(limit, info.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== info.size || length > limit) throw new FileAttachmentError("invalid");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Server-minted identity is fixed to the future thread even for an unsent draft. */
export async function storeFileAttachment(input: {
  attachmentsDir: string;
  threadId: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<ChatFileAttachment> {
  if (input.bytes.byteLength > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
    throw new FileAttachmentError("too-large");
  if (!input.threadId || input.threadId.length > 512) throw new FileAttachmentError("invalid");
  const id = createAttachmentId(input.threadId);
  if (!id) throw new FileAttachmentError("invalid");
  const attachment = decodeAttachment({
    type: "file",
    id,
    name: normalizeFileAttachmentName(input.name),
    mimeType: normalizeFileAttachmentMimeType(input.mimeType),
    sizeBytes: input.bytes.byteLength,
  });
  const paths = fileAttachmentStoragePaths(input.attachmentsDir, id);
  let createdData = false;
  let createdMetadata = false;
  try {
    await mkdir(input.attachmentsDir, { recursive: true, mode: 0o700 });
    await verifyRoot(input.attachmentsDir);
    const data = await open(paths.data, "wx", 0o600);
    createdData = true;
    try {
      await data.writeFile(input.bytes);
      await data.sync();
    } finally {
      await data.close();
    }
    const metadata = await open(paths.metadata, "wx", 0o600);
    createdMetadata = true;
    try {
      await metadata.writeFile(
        JSON.stringify({
          attachment,
          threadId: input.threadId,
          sha256: createHash("sha256").update(input.bytes).digest("hex"),
        }),
      );
      await metadata.sync();
    } finally {
      await metadata.close();
    }
    return attachment;
  } catch {
    // Delete only files this exact upload created; a collision is never authority
    // to remove some other upload's bytes. Incomplete writes never get a handle.
    if (createdMetadata) await unlink(paths.metadata).catch(() => undefined);
    if (createdData) await unlink(paths.data).catch(() => undefined);
    throw new FileAttachmentError("unavailable");
  }
}

export async function readStoredFileAttachment(input: {
  attachmentsDir: string;
  attachment: ChatFileAttachment;
  threadId?: string;
}): Promise<{ bytes: Uint8Array; path: string; threadId: string }> {
  try {
    const attachment = decodeAttachment(input.attachment);
    await verifyRoot(input.attachmentsDir);
    const paths = fileAttachmentStoragePaths(input.attachmentsDir, attachment.id);
    const metadata = decodeMetadata(
      JSON.parse((await readPrivateBounded(paths.metadata, MAX_METADATA_BYTES)).toString("utf8")),
    );
    if (
      metadata.attachment.id !== attachment.id ||
      metadata.attachment.name !== attachment.name ||
      metadata.attachment.mimeType !== attachment.mimeType ||
      metadata.attachment.sizeBytes !== attachment.sizeBytes ||
      (input.threadId !== undefined && metadata.threadId !== input.threadId) ||
      !/^[a-f0-9]{64}$/u.test(metadata.sha256)
    )
      throw new FileAttachmentError("invalid");
    const bytes = await readPrivateBounded(paths.data, PROVIDER_SEND_TURN_MAX_FILE_BYTES);
    const digest = createHash("sha256").update(bytes).digest();
    if (
      bytes.byteLength !== attachment.sizeBytes ||
      !timingSafeEqual(digest, Buffer.from(metadata.sha256, "hex"))
    ) {
      throw new FileAttachmentError("invalid");
    }
    return { bytes, path: paths.data, threadId: metadata.threadId };
  } catch {
    throw new FileAttachmentError("unavailable");
  }
}

export async function readFileAttachmentById(attachmentsDir: string, id: string) {
  try {
    await verifyRoot(attachmentsDir);
    const paths = fileAttachmentStoragePaths(attachmentsDir, id);
    const metadata = decodeMetadata(
      JSON.parse((await readPrivateBounded(paths.metadata, MAX_METADATA_BYTES)).toString("utf8")),
    );
    if (metadata.attachment.id !== id) throw new FileAttachmentError("invalid");
    return {
      attachment: metadata.attachment,
      ...(await readStoredFileAttachment({ attachmentsDir, attachment: metadata.attachment })),
    };
  } catch {
    throw new FileAttachmentError("unavailable");
  }
}

/** Bounded metadata-only ownership check for cleanup; never reads document bytes. */
export async function readFileAttachmentOwner(attachmentsDir: string, id: string) {
  try {
    await verifyRoot(attachmentsDir);
    const paths = fileAttachmentStoragePaths(attachmentsDir, id);
    const metadata = decodeMetadata(
      JSON.parse((await readPrivateBounded(paths.metadata, MAX_METADATA_BYTES)).toString("utf8")),
    );
    if (metadata.attachment.id !== id) throw new FileAttachmentError("invalid");
    return metadata.threadId;
  } catch {
    throw new FileAttachmentError("unavailable");
  }
}

/** Only used to compensate this request's newly created upload after deletion races. */
export async function removeNewFileAttachment(
  attachmentsDir: string,
  attachment: ChatFileAttachment,
) {
  const paths = fileAttachmentStoragePaths(attachmentsDir, attachment.id);
  await unlink(paths.data).catch(() => undefined);
  await unlink(paths.metadata).catch(() => undefined);
}

/** Pure inert preview, never HTML/Markdown interpretation, scripts, or external resources. */
export function previewFileAttachment(
  bytes: Uint8Array,
): { text: string; truncated: boolean } | null {
  const slice = bytes.subarray(0, MAX_PREVIEW_BYTES);
  if (slice.includes(0)) return null;
  try {
    const truncated = bytes.length > MAX_PREVIEW_BYTES;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(slice, { stream: truncated });
    if (
      Array.from(text).some((character) => {
        const code = character.codePointAt(0)!;
        return code < 32 && code !== 9 && code !== 10 && code !== 13;
      })
    )
      return null;
    return { text: text.replace(/[\p{Cf}]/gu, ""), truncated };
  } catch {
    return null;
  }
}
