import {
  ChatFileAttachment,
  EnvironmentId,
  ThreadId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";

/** A browser File exists only while an upload can be retried in this renderer. */
export interface ComposerFileAttachment {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly targetThreadId: ThreadId;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly status: "uploading" | "failed" | "ready";
  readonly attachment?: ChatFileAttachment;
  readonly file?: File | undefined;
  readonly error?: string | undefined;
}

export const PersistedComposerFileAttachment = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  environmentId: EnvironmentId,
  targetThreadId: ThreadId,
  name: Schema.String.check(Schema.isMaxLength(255)),
  mimeType: Schema.String.check(Schema.isMaxLength(100)),
  sizeBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES),
  ),
  status: Schema.Literals(["uploading", "failed", "ready"]),
  attachment: Schema.optionalKey(ChatFileAttachment),
});
const isPersistedFile = Schema.is(PersistedComposerFileAttachment);

/** Explicit projection keeps browser blobs, transient exceptions and paths out of storage. */
export function persistComposerFile(
  file: ComposerFileAttachment,
): typeof PersistedComposerFileAttachment.Type {
  return {
    id: file.id,
    environmentId: file.environmentId,
    targetThreadId: file.targetThreadId,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    status: file.status,
    ...(file.attachment ? { attachment: file.attachment } : {}),
  };
}

export function hydrateComposerFile(value: unknown): ComposerFileAttachment | null {
  if (!isPersistedFile(value)) return null;
  const ready = value.status === "ready" && value.attachment !== undefined;
  return {
    ...persistComposerFile(value as ComposerFileAttachment),
    environmentId: value.environmentId as EnvironmentId,
    targetThreadId: value.targetThreadId as ThreadId,
    status: ready ? "ready" : "failed",
    ...(ready ? {} : { error: "Upload not completed. Remove this file and select it again." }),
  };
}

export function composerFileFromAttachment(
  environmentId: EnvironmentId,
  targetThreadId: ThreadId,
  attachment: ChatFileAttachment,
): ComposerFileAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    environmentId,
    targetThreadId,
    status: "ready",
    attachment,
  };
}

export function readyComposerFiles(
  files: readonly ComposerFileAttachment[],
  environmentId: EnvironmentId,
  targetThreadId: ThreadId,
): ChatFileAttachment[] {
  return files.map((file) => {
    if (
      file.status !== "ready" ||
      !file.attachment ||
      file.environmentId !== environmentId ||
      file.targetThreadId !== targetThreadId
    ) {
      throw new Error(
        "Finish or remove every file upload before sending. Files must belong to the selected environment.",
      );
    }
    return file.attachment;
  });
}

/** Only passive raster formats enter the existing thumbnail/data-URL image path. */
export function isComposerImageFile(file: Pick<File, "type">): boolean {
  return /^(?:image\/(?:png|jpeg|gif|webp))$/i.test(file.type);
}
