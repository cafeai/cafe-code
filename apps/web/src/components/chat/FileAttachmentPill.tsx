import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import type { ChatFileAttachment, EnvironmentId } from "@cafecode/contracts";
import { useState } from "react";
import { CircleAlertIcon, DownloadIcon, FileIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import {
  downloadFileAttachment,
  getFileAttachmentPreview,
} from "../../attachments/fileAttachments";
import {
  formatFileAttachmentErrorCode,
  readFileAttachmentErrorCode,
  type FileAttachmentErrorCode,
} from "../../attachments/fileAttachmentErrors";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

/** Every attachment state (uploading, failed, ready) uses this one pill shape. */
const FILE_PILL_CLASS_NAME =
  "inline-flex max-w-full items-center gap-1 rounded-lg border border-border bg-background/60 px-2 py-0.5 text-xs";

function formatAttachmentSize(sizeBytes: number): string {
  return sizeBytes < 1024
    ? uiText("{bytes} B", { bytes: sizeBytes })
    : uiText("{kilobytes} KB", { kilobytes: Math.ceil(sizeBytes / 1024) });
}

type AttachmentFeedbackCode = FileAttachmentErrorCode | "no-preview" | "download-failed";

function formatAttachmentFeedback(code: AttachmentFeedbackCode, locale: UiLocale): string {
  if (code === "no-preview")
    return uiText(
      "No text preview for this format. Download the file to inspect it.",
      undefined,
      undefined,
      locale,
    );
  if (code === "download-failed")
    return uiText(
      "This file could not be downloaded. Please try again.",
      undefined,
      undefined,
      locale,
    );
  return formatFileAttachmentErrorCode(code, locale);
}

/**
 * The composer's not-yet-ready attachment. It keeps the ready pill's layout
 * (icon, name, size, an action slot) so the upload finishing swaps contents in
 * place instead of reflowing the attachment row.
 */
export function FileAttachmentPendingPill({
  name,
  sizeBytes,
  status,
  error,
  onRetry,
  onRemove,
}: {
  name: string;
  sizeBytes: number;
  status: "uploading" | "failed" | "ready";
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
  onRemove: () => void;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const uploading = status === "uploading";
  return (
    <span
      className={cn(FILE_PILL_CLASS_NAME, !uploading && "border-destructive/40")}
      role="status"
      data-file-attachment-pending={uploading ? "uploading" : "failed"}
    >
      {uploading ? (
        <LoaderCircleIcon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <CircleAlertIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-destructive-foreground"
        />
      )}
      <span className="min-w-0 truncate" title={name}>
        {name}
      </span>
      {uploading ? (
        <>
          <span className="shrink-0 text-muted-foreground">
            {uiPresentation.formatAttachmentSize(sizeBytes)}
          </span>
          <span className="sr-only">
            {uiText("Uploading copy…", undefined, undefined, uiLocale)}
          </span>
          {/* Holds the download button's slot so the ready pill matches this width. */}
          <span aria-hidden="true" className="size-7 shrink-0 sm:size-6" />
        </>
      ) : (
        <span className="min-w-0 truncate text-destructive-foreground" title={error}>
          {error ?? uiText("Upload failed.", undefined, undefined, uiLocale)}
        </span>
      )}
      {onRetry ? (
        <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
          {uiText("Retry upload", undefined, undefined, uiLocale)}
        </Button>
      ) : null}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={uiText("Remove {value0}", { value0: name }, undefined, uiLocale)}
        onClick={onRemove}
      >
        <XIcon className="size-3" />
      </Button>
    </span>
  );
}

/** No file URL is navigable here: active formats are downloaded or escaped as plain text. */
export function FileAttachmentPill({
  attachment,
  environmentId,
  onRemove,
}: {
  attachment: ChatFileAttachment;
  environmentId: EnvironmentId;
  onRemove?: () => void;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ text: string; truncated: boolean } | null>(null);
  // Retain only finite Cafe-owned feedback, never an exception, response body
  // or old-locale message. Language switches repaint without replaying IO.
  const [feedbackCode, setFeedbackCode] = useState<AttachmentFeedbackCode | null>(null);
  const error = feedbackCode === null ? null : formatAttachmentFeedback(feedbackCode, uiLocale);
  const run = async (action: "preview" | "download") => {
    if (busy) return;
    setBusy(true);
    setFeedbackCode(null);
    try {
      if (action === "download") await downloadFileAttachment({ environmentId, attachment });
      else {
        const result = await getFileAttachmentPreview({ environmentId, attachment });
        if (result) setPreview(result);
        else setFeedbackCode("no-preview");
      }
    } catch (cause) {
      // Transport failures carry locally owned, allowlisted categories. Do not
      // display arbitrary exception text here: it may contain a remote server's
      // response, credentials, or private paths. A failed preview also does not
      // prove the upload/download failed or that this environment disconnected.
      setFeedbackCode(
        readFileAttachmentErrorCode(cause) ??
          (action === "preview" ? "invalid-preview" : "download-failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex max-w-full flex-col gap-1" data-file-attachment="true">
      <span className={FILE_PILL_CLASS_NAME}>
        {busy ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <FileIcon className="size-3.5 shrink-0" />
        )}
        <button
          type="button"
          disabled={busy}
          className="focus-ring min-w-0 truncate rounded-sm text-left hover:underline"
          title={uiText(
            "{value0} · {value1} · {value2} bytes · Uploaded copy",
            {
              value0: attachment.name,
              value1: attachment.mimeType,
              value2: attachment.sizeBytes.toLocaleString(),
            },
            undefined,
            uiLocale,
          )}
          onClick={() => {
            void run("preview");
          }}
        >
          {attachment.name}
        </button>
        <span className="shrink-0 text-muted-foreground">
          {uiPresentation.formatAttachmentSize(attachment.sizeBytes)}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={busy}
          aria-label={uiText("Download {value0}", { value0: attachment.name }, undefined, uiLocale)}
          onClick={() => {
            void run("download");
          }}
        >
          <DownloadIcon className="size-3" />
        </Button>
        {onRemove ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={uiText("Remove {value0}", { value0: attachment.name }, undefined, uiLocale)}
            onClick={onRemove}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
      </span>
      {error ? (
        <span role="status" className="max-w-80 text-xs text-muted-foreground">
          {error}
        </span>
      ) : null}
      {preview ? (
        <span className="max-w-full animate-enter-rise rounded-lg border border-border bg-background p-2">
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <UiMessage
              message={
                "Plain-text preview{truncated, select, yes { (truncated)} other {}}<close></close>"
              }
              values={{ truncated: preview.truncated ? "yes" : "no" }}
              slots={{
                close: (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={uiText("Close file preview", undefined, undefined, uiLocale)}
                    onClick={() => setPreview(null)}
                  >
                    <XIcon />
                  </Button>
                ),
              }}
            />
          </span>
          <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-all text-xs">
            {preview.text}
          </pre>
        </span>
      ) : null}
    </span>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { formatAttachmentSize };
