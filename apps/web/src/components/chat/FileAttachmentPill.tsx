import type { ChatFileAttachment, EnvironmentId } from "@cafecode/contracts";
import { useState } from "react";
import { CircleAlertIcon, DownloadIcon, FileIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import {
  downloadFileAttachment,
  getFileAttachmentPreview,
} from "../../attachments/fileAttachments";
import { getFileAttachmentErrorMessage } from "../../attachments/fileAttachmentErrors";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

/** Every attachment state (uploading, failed, ready) uses this one pill shape. */
const FILE_PILL_CLASS_NAME =
  "inline-flex max-w-full items-center gap-1 rounded-lg border border-border bg-background/60 px-2 py-0.5 text-xs";

function formatAttachmentSize(sizeBytes: number): string {
  return sizeBytes < 1024 ? `${sizeBytes} B` : `${Math.ceil(sizeBytes / 1024)} KB`;
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
          <span className="shrink-0 text-muted-foreground">{formatAttachmentSize(sizeBytes)}</span>
          <span className="sr-only">Uploading copy…</span>
          {/* Holds the download button's slot so the ready pill matches this width. */}
          <span aria-hidden="true" className="size-7 shrink-0 sm:size-6" />
        </>
      ) : (
        <span className="min-w-0 truncate text-destructive-foreground" title={error}>
          {error ?? "Upload failed."}
        </span>
      )}
      {onRetry ? (
        <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
          Retry upload
        </Button>
      ) : null}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Remove ${name}`}
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
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "preview" | "download") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (action === "download") await downloadFileAttachment({ environmentId, attachment });
      else {
        const result = await getFileAttachmentPreview({ environmentId, attachment });
        if (result) setPreview(result);
        else setError("No text preview for this format. Download the file to inspect it.");
      }
    } catch (cause) {
      // Transport failures carry locally owned, allowlisted categories. Do not
      // display arbitrary exception text here: it may contain a remote server's
      // response, credentials, or private paths. A failed preview also does not
      // prove the upload/download failed or that this environment disconnected.
      setError(
        getFileAttachmentErrorMessage(cause) ??
          (action === "preview"
            ? "This file could not be previewed. You can still download it."
            : "This file could not be downloaded. Please try again."),
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
          title={`${attachment.name} · ${attachment.mimeType} · ${attachment.sizeBytes.toLocaleString()} bytes · Uploaded copy`}
          onClick={() => {
            void run("preview");
          }}
        >
          {attachment.name}
        </button>
        <span className="shrink-0 text-muted-foreground">
          {formatAttachmentSize(attachment.sizeBytes)}
        </span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={busy}
          aria-label={`Download ${attachment.name}`}
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
            aria-label={`Remove ${attachment.name}`}
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
            Plain-text preview{preview.truncated ? " (truncated)" : ""}
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Close file preview"
              onClick={() => setPreview(null)}
            >
              <XIcon />
            </Button>
          </span>
          <pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-all text-xs">
            {preview.text}
          </pre>
        </span>
      ) : null}
    </span>
  );
}
