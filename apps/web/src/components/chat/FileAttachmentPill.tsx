import type { ChatFileAttachment, EnvironmentId } from "@cafecode/contracts";
import { useState } from "react";
import { DownloadIcon, FileIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import {
  downloadFileAttachment,
  getFileAttachmentPreview,
} from "../../attachments/fileAttachments";
import { Button } from "../ui/button";

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
    } catch {
      setError("This file could not be retrieved. Reconnect to its environment and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex max-w-full flex-col gap-1" data-file-attachment="true">
      <span className="inline-flex max-w-full items-center gap-1 rounded-lg border border-border/70 bg-background/60 px-2 py-1 text-xs">
        {busy ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <FileIcon className="size-3.5 shrink-0" />
        )}
        <button
          type="button"
          disabled={busy}
          className="min-w-0 truncate text-left hover:underline"
          title={`${attachment.name} · ${attachment.mimeType} · ${attachment.sizeBytes.toLocaleString()} bytes · Uploaded copy`}
          onClick={() => {
            void run("preview");
          }}
        >
          {attachment.name}
        </button>
        <span className="shrink-0 text-muted-foreground">
          {attachment.sizeBytes < 1024
            ? `${attachment.sizeBytes} B`
            : `${Math.ceil(attachment.sizeBytes / 1024)} KB`}
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
        <span className="max-w-full rounded-lg border border-border bg-background p-2">
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
