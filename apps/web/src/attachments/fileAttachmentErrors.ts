/** Only Cafe-authored, fixed messages may cross the attachment UI boundary. */
const messages = {
  "owner-access": "Reconnect with owner access to use attachments.",
  unavailable: "This attachment is unavailable. Remove it and attach the file again.",
  busy: "Several files are being processed. Please try again shortly.",
  "too-large": "Files must be 25 MiB or smaller.",
  "transfer-failed": "The attachment could not be transferred. Please retry.",
  cancelled: "Attachment transfer was cancelled or timed out. Please retry.",
  "invalid-preview": "This file could not be previewed. You can still download it.",
  "incomplete-download": "The attachment download was incomplete. Please retry.",
  "environment-unavailable": "Reconnect to this environment before using attachments.",
} as const;

export class FileAttachmentRequestError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
    this.name = "FileAttachmentRequestError";
  }
}

/**
 * Remote response bodies and browser exceptions may contain credentials, paths
 * or attacker-controlled text. Display only our finite error classification,
 * not even an Error.message that a later wrapper could have overwritten.
 */
export function getFileAttachmentErrorMessage(error: unknown): string | null {
  return error instanceof FileAttachmentRequestError && Object.hasOwn(messages, error.code)
    ? messages[error.code]
    : null;
}
