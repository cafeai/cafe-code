import { useId, useState } from "react";
import { ChevronRightIcon, ImageIcon } from "lucide-react";
import {
  DESKTOP_OBSERVATION_MAX_BYTES,
  DESKTOP_OBSERVATION_PATH,
  type EnvironmentId,
  type ThreadId,
} from "@cafecode/contracts";
import type { WorkLogEntry } from "../../session-logic";
import { formatTimestamp } from "../../timestampFormat";
import type { TimestampFormat } from "@cafecode/contracts/settings";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Dialog, DialogPopup, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { cn } from "~/lib/utils";
import { useDesktopImage } from "./useDesktopImage";

function ObservationImage({
  environmentId,
  threadId,
  observation,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  observation: NonNullable<WorkLogEntry["desktopObservation"]>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [fullSize, setFullSize] = useState(false);
  const [actualPixels, setActualPixels] = useState(false);
  const reference = observation.reference;
  const { src, error, onError } = useDesktopImage(
    environmentId,
    reference?.storage === "saved" ? `${DESKTOP_OBSERVATION_PATH}/${reference.id}` : null,
    DESKTOP_OBSERVATION_MAX_BYTES,
    threadId,
    attempt,
  );
  const unavailable = observation.pending
    ? "Taking screenshot…"
    : !reference
      ? "This call did not save a screenshot. Older calls cannot be restored."
      : reference.storage === "disabled"
        ? "Saving screenshots was disabled for this call."
        : reference.storage === "failed"
          ? "The desktop was observed, but its screenshot could not be saved."
          : null;
  const message =
    unavailable ??
    (error === "unavailable"
      ? "This screenshot is no longer retained. You can keep more in Settings → Desktop control."
      : error === "owner-access"
        ? "Owner access is required to view saved screenshots."
        : error
          ? "Could not load this screenshot. Reconnect to this environment and try again."
          : null);
  if (message)
    return (
      <div className="space-y-2">
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
        {error && error !== "unavailable" && error !== "owner-access" && (
          <Button size="xs" variant="outline" onClick={() => setAttempt((v) => v + 1)}>
            Retry
          </Button>
        )}
      </div>
    );
  // The saved reference knows the capture's pixel size, so the frame reserves
  // the final box while bytes load and the image fades in without a jump.
  const frameStyle =
    reference && reference.width > 0 && reference.height > 0
      ? { aspectRatio: `${reference.width} / ${reference.height}` }
      : undefined;
  const frameClassName = cn(
    "relative block w-full max-w-sm max-h-56 overflow-hidden rounded-lg border border-border bg-muted",
    !frameStyle && "h-40",
  );
  if (!src)
    return (
      <div role="status" className={frameClassName} style={frameStyle}>
        <Skeleton aria-hidden="true" className="absolute inset-0 rounded-none" />
        <span className="absolute inset-0 flex items-center justify-center text-2xs text-muted-foreground">
          Loading screenshot…
        </span>
      </div>
    );
  return (
    <>
      <button
        type="button"
        aria-label="View full resolution screenshot"
        className={cn(
          frameClassName,
          "cursor-zoom-in focus-visible:outline-2 focus-visible:outline-ring",
        )}
        style={frameStyle}
        onClick={() => setFullSize(true)}
      >
        <img
          src={src}
          alt="Desktop screenshot observed by the model"
          onError={onError}
          draggable={false}
          className="size-full object-contain animate-enter-fade"
        />
      </button>
      <Dialog open={fullSize} onOpenChange={setFullSize}>
        <DialogPopup className="max-w-[min(94vw,1600px)]" bottomStickOnMobile={false}>
          <DialogHeader>
            <DialogTitle>Desktop screenshot</DialogTitle>
            <DialogDescription>
              {reference?.width} × {reference?.height} · Original screenshot
            </DialogDescription>
            <Button
              variant="ghost"
              size="sm"
              className="w-fit"
              onClick={() => setActualPixels((v) => !v)}
            >
              {actualPixels ? "Fit to window" : "Actual size"}
            </Button>
          </DialogHeader>
          <div className="max-h-[75vh] overflow-auto px-4 pb-4">
            <img
              src={src}
              alt="Full resolution desktop screenshot"
              draggable={false}
              className={
                actualPixels ? "max-w-none" : "mx-auto max-h-[70vh] max-w-full object-contain"
              }
            />
          </div>
        </DialogPopup>
      </Dialog>
    </>
  );
}
export function DesktopObservation({
  entry,
  environmentId,
  threadId,
  timestampFormat,
}: {
  entry: WorkLogEntry;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  timestampFormat: TimestampFormat;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const observation = entry.desktopObservation;
  if (!observation) return null;
  const reference = observation.reference;
  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-2xs leading-5 transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        aria-label="View desktop screenshot"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <ImageIcon className="size-3" />
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {observation.pending ? "Viewing desktop" : "Viewed desktop"}
        </span>
        <span className="text-muted-foreground">
          {open
            ? "Hide screenshot"
            : observation.pending
              ? "In progress"
              : !reference || reference.storage !== "saved"
                ? "Screenshot not saved"
                : "View screenshot"}
        </span>
        <ChevronRightIcon
          className={cn(
            "size-3 text-muted-foreground transition-transform duration-(--duration-fast)",
            open && "rotate-90",
          )}
        />
      </button>
      {open && (
        <div id={panelId} className="space-y-2 py-2 pl-8 pr-2 animate-enter-rise">
          <ObservationImage
            key={`${environmentId}:${threadId}:${reference?.id ?? entry.id}`}
            environmentId={environmentId}
            threadId={threadId}
            observation={observation}
          />
          <div className="text-2xs text-subtle-foreground">
            {formatTimestamp(reference?.capturedAt ?? entry.createdAt, timestampFormat)}
            <details className="mt-1">
              <summary className="cursor-pointer">Details</summary>Desktop screenshot
              {reference
                ? ` · ${reference.width} × ${reference.height} · Frame ${reference.frame}`
                : ""}
            </details>
          </div>
        </div>
      )}
    </div>
  );
}
