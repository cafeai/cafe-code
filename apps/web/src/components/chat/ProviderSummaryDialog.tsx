import { uiText } from "@cafecode/shared/i18n";
import { ArrowDownIcon, BrainIcon, MessageSquareTextIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useUiLocale } from "~/i18n";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import {
  providerPublicSummaryLabel,
  type ProviderPublicSummary,
} from "./providerOperationVisibility";

const FOLLOW_TAIL_THRESHOLD_PX = 24;

export interface ProviderSummaryDialogProps {
  readonly open: boolean;
  readonly summary: ProviderPublicSummary | null;
  readonly onOpenChange: (open: boolean) => void;
}

function ProviderSummaryDialogBody(props: { readonly summary: ProviderPublicSummary }) {
  const uiLocale = useUiLocale();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { summary } = props;
  const thinking = summary.provider !== "claudeAgent";
  const streaming = summary.status === "inProgress";
  const label = providerPublicSummaryLabel(summary.provider, uiLocale);
  const followTailRef = useRef(streaming);
  const [followTail, setFollowTail] = useState(streaming);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (followTailRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [summary.text, summary.status]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_TAIL_THRESHOLD_PX;
    if (followTailRef.current !== atBottom) {
      followTailRef.current = atBottom;
      setFollowTail(atBottom);
    }
  }, []);

  const handleJumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    followTailRef.current = true;
    setFollowTail(true);
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  return (
    <>
      <DialogHeader className="border-b border-border/60 pb-3 pe-12">
        <div className="flex items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            {thinking ? (
              <BrainIcon
                className={cn("size-4", streaming && "animate-pulse motion-reduce:animate-none")}
                aria-hidden
              />
            ) : (
              <MessageSquareTextIcon
                className={cn("size-4", streaming && "animate-pulse motion-reduce:animate-none")}
                aria-hidden
              />
            )}
          </span>
          <DialogTitle className="text-base">{label}</DialogTitle>
          {streaming ? (
            <span className="text-xs text-subtle-foreground">
              {uiText("Updating…", undefined, undefined, uiLocale)}
            </span>
          ) : summary.status === "failed" ? (
            <span className="text-xs text-muted-foreground">
              {uiText("Partial", undefined, undefined, uiLocale)}
            </span>
          ) : null}
        </div>
      </DialogHeader>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          tabIndex={0}
          role="region"
          aria-label={label}
          data-summary-dialog-scroll="true"
          onScroll={handleScroll}
          className="focus-ring min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4"
        >
          <p
            className={cn(
              "text-xs leading-5 whitespace-pre-wrap wrap-break-word",
              thinking ? "text-muted-foreground" : "text-chat-foreground",
            )}
            data-summary-dialog-text="true"
          >
            {summary.text}
          </p>
          {summary.truncated ? (
            <p className="mt-3 text-2xs text-muted-foreground">
              {thinking
                ? uiText(
                    "Thinking truncated to the retained preview.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Summary truncated to the retained preview.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
            </p>
          ) : null}
        </div>
        {streaming && !followTail ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
            <Button
              type="button"
              size="xs"
              variant="secondary"
              className="pointer-events-auto shadow-sm"
              onClick={handleJumpToLatest}
            >
              <ArrowDownIcon className="size-3" aria-hidden />
              {uiText("Jump to latest", undefined, undefined, uiLocale)}
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * Scrollable, live-updating popup for inspecting a full retained thinking trace
 * or provider summary without expanding the virtualized chat timeline.
 *
 * Follows the latest lines while streaming unless the reader scrolls up to
 * inspect earlier text; completed traces open at the top for top-down reading.
 */
export function ProviderSummaryDialog(props: ProviderSummaryDialogProps) {
  const { summary } = props;

  return (
    <Dialog open={props.open && summary !== null} onOpenChange={props.onOpenChange}>
      <DialogPopup
        className="max-h-[80vh] max-w-2xl overflow-hidden"
        data-provider-summary-dialog={summary?.provider ?? undefined}
      >
        {summary ? <ProviderSummaryDialogBody summary={summary} /> : null}
      </DialogPopup>
    </Dialog>
  );
}
