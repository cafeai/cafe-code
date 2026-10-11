import { getUiLocale, uiText, type UiLocale } from "@cafecode/shared/i18n";

// These are Cafe transport classifications, not translatable protocol values.
const FILE_ATTACHMENT_ERROR_CODES = [
  "owner-access",
  "unavailable",
  "busy",
  "too-large",
  "transfer-failed",
  "cancelled",
  "invalid-preview",
  "incomplete-download",
  "environment-unavailable",
] as const;
export type FileAttachmentErrorCode = (typeof FILE_ATTACHMENT_ERROR_CODES)[number];
const knownCodes: ReadonlySet<string> = new Set(FILE_ATTACHMENT_ERROR_CODES);

/** One definition of each sentence; retained UI state contains only its code. */
export function formatFileAttachmentErrorCode(
  code: FileAttachmentErrorCode,
  locale: UiLocale = getUiLocale(),
): string {
  switch (code) {
    case "owner-access":
      return uiText(
        "Reconnect with owner access to use attachments.",
        undefined,
        undefined,
        locale,
      );
    case "unavailable":
      return uiText(
        "This attachment is unavailable. Remove it and attach the file again.",
        undefined,
        undefined,
        locale,
      );
    case "busy":
      return uiText(
        "Several files are being processed. Please try again shortly.",
        undefined,
        undefined,
        locale,
      );
    case "too-large":
      return uiText("Files must be 25 MiB or smaller.", undefined, undefined, locale);
    case "transfer-failed":
      return uiText(
        "The attachment could not be transferred. Please retry.",
        undefined,
        undefined,
        locale,
      );
    case "cancelled":
      return uiText(
        "Attachment transfer was cancelled or timed out. Please retry.",
        undefined,
        undefined,
        locale,
      );
    case "invalid-preview":
      return uiText(
        "This file could not be previewed. You can still download it.",
        undefined,
        undefined,
        locale,
      );
    case "incomplete-download":
      return uiText(
        "The attachment download was incomplete. Please retry.",
        undefined,
        undefined,
        locale,
      );
    case "environment-unavailable":
      return uiText(
        "Reconnect to this environment before using attachments.",
        undefined,
        undefined,
        locale,
      );
  }
}

// Never infer source provenance from received properties or mutable Error
// fields. The exact locally constructed error retains its original finite
// classification even if another wrapper overwrites message or code.
const ownedCodes = new WeakMap<object, FileAttachmentErrorCode>();

export class FileAttachmentRequestError extends Error {
  constructor(readonly code: FileAttachmentErrorCode) {
    super(formatFileAttachmentErrorCode(code));
    this.name = "FileAttachmentRequestError";
    if (knownCodes.has(code)) ownedCodes.set(this, code);
  }
}

export function readFileAttachmentErrorCode(error: unknown): FileAttachmentErrorCode | null {
  return typeof error === "object" && error !== null ? (ownedCodes.get(error) ?? null) : null;
}

/**
 * Remote response bodies and browser exceptions may contain credentials, paths
 * or attacker-controlled text. Display only our finite error classification,
 * not even an Error.message that a later wrapper could have overwritten.
 */
export function getFileAttachmentErrorMessage(
  error: unknown,
  locale: UiLocale = getUiLocale(),
): string | null {
  const code = readFileAttachmentErrorCode(error);
  return code === null ? null : formatFileAttachmentErrorCode(code, locale);
}
