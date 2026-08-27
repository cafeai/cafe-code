import { memo, type PointerEventHandler } from "react";
import { MicIcon } from "lucide-react";

import type { ComposerDictationPhase } from "~/hooks/useComposerDictation";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

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
          "shrink-0 rounded-full text-foreground/85 hover:text-foreground",
          isRecording && "bg-rose-500/10 text-rose-500 hover:bg-rose-500/15 hover:text-rose-500",
          isTransitioning && "text-muted-foreground",
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
        <MicIcon
          aria-hidden="true"
          className={cn(
            "size-4",
            (isRecording || isTransitioning) && "animate-pulse motion-reduce:animate-none",
          )}
        />
      </Button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {props.statusMessage}
      </span>
    </>
  );
});
