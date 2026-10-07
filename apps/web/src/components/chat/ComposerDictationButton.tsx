import { memo, type PointerEventHandler } from "react";
import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";

import type { ComposerDictationPhase } from "~/hooks/useComposerDictation";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

const DICTATION_GLYPH_CLASS_NAME =
  "absolute transition-[opacity,scale] duration-(--duration-fast) ease-out";
const HIDDEN_GLYPH_CLASS_NAME = "scale-75 opacity-0";

export const ComposerDictationButton = memo(function ComposerDictationButton(props: {
  readonly phase: ComposerDictationPhase;
  readonly statusMessage: string;
  readonly disabled?: boolean;
  readonly preserveComposerFocusOnPointerDown?: boolean;
  readonly className?: string;
  readonly onToggle: () => void;
}) {
  const isRecording = props.phase === "recording";
  const isTransitioning = props.phase === "starting" || props.phase === "finalizing";
  const label =
    props.phase === "starting"
      ? "Connecting microphone"
      : props.phase === "recording"
        ? "Stop dictation"
        : props.phase === "finalizing"
          ? "Finishing dictation"
          : props.disabled
            ? "Dictation unavailable while the composer is busy"
            : "Start dictation";

  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className={cn(
          "shrink-0 rounded-full text-muted-foreground transition-[color,background-color,box-shadow] duration-(--duration-fast) hover:text-foreground",
          isRecording &&
            "bg-destructive/10 text-destructive-foreground hover:bg-destructive/15 hover:text-destructive-foreground",
          isTransitioning && "text-subtle-foreground",
          props.className,
        )}
        disabled={isTransitioning || props.disabled}
        aria-label={label}
        aria-pressed={isRecording}
        data-composer-dictation="true"
        data-composer-dictation-phase={props.phase}
        {...(props.preserveComposerFocusOnPointerDown
          ? { onPointerDown: preventPointerFocus }
          : {})}
        onClick={props.onToggle}
      >
        {/* The three glyphs stay mounted and crossfade so a phase change reads
            as one control changing state. Only the visible spinner animates.
            Dictation has its own explicit stop affordance; the primary arrow
            remains a Send/queue action and never impersonates this control. */}
        <span
          aria-hidden="true"
          className="relative inline-flex size-4 items-center justify-center"
        >
          <LoaderCircleIcon
            data-dictation-glyph="spinner"
            data-visible={isTransitioning}
            className={cn(
              DICTATION_GLYPH_CLASS_NAME,
              "size-4",
              isTransitioning ? "animate-spin" : HIDDEN_GLYPH_CLASS_NAME,
            )}
          />
          <SquareIcon
            data-dictation-glyph="stop"
            data-visible={isRecording && !isTransitioning}
            className={cn(
              DICTATION_GLYPH_CLASS_NAME,
              "size-3 fill-current",
              !isRecording || isTransitioning ? HIDDEN_GLYPH_CLASS_NAME : null,
            )}
          />
          <MicIcon
            data-dictation-glyph="mic"
            data-visible={!isRecording && !isTransitioning}
            className={cn(
              DICTATION_GLYPH_CLASS_NAME,
              "size-4",
              isRecording || isTransitioning ? HIDDEN_GLYPH_CLASS_NAME : null,
            )}
          />
        </span>
      </Button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {props.statusMessage}
      </span>
    </>
  );
});
