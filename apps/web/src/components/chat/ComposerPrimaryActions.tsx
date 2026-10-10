import { memo, type PointerEventHandler } from "react";
import { ArrowUpIcon, ChevronDownIcon, ChevronLeftIcon, LoaderCircleIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  compact: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  /** Recovery owns a stoppable context without making a failed root running. */
  recoveryStopAvailable?: boolean | undefined;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  isQueueEditing?: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  postSubmitInterruptGuardActive: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  onArmPostSubmitInterruptGuard: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}

export const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting…";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

/** Send, queue and stop share one round button: the same size in every
 * composer layout so swapping between them never shifts the footer. */
const ROUND_PRIMARY_BUTTON_CLASS_NAME =
  "focus-ring flex size-9 shrink-0 items-center justify-center rounded-full transition-[background-color,opacity,scale] duration-(--duration-fast) ease-out active:scale-98 disabled:pointer-events-none disabled:opacity-50 sm:size-8";
const SEND_BUTTON_CLASS_NAME = cn(
  ROUND_PRIMARY_BUTTON_CLASS_NAME,
  "enabled:cursor-pointer bg-primary/90 text-primary-foreground hover:bg-primary",
);

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  recoveryStopAvailable = false,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  isQueueEditing = false,
  isConnecting,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  postSubmitInterruptGuardActive,
  preserveComposerFocusOnPointerDown = false,
  onArmPostSubmitInterruptGuard,
  onPreviousPendingQuestion,
  onInterrupt,
  onImplementPlanInNewThread,
}: ComposerPrimaryActionsProps) {
  if (isQueueEditing) return null;
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "px-3" : "px-4")}
          {...pointerFocusProps}
          disabled={
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </Button>
      </div>
    );
  }

  if (isRunning || recoveryStopAvailable) {
    // A sendable draft always wins the shared primary-action slot. Aside from
    // preventing accidental interruption, this mirrors the established
    // keyboard path: a normal submit during a running turn queues a follow-up;
    // explicit steering and interruption remain separate user intents. A
    // failed-root recovery does not change that form's native phase: its draft
    // sends a new manual turn rather than being mislabeled a running-turn queue.
    if (hasSendableContent || postSubmitInterruptGuardActive) {
      // Do not disable the button merely because the click armed the guard:
      // disabling a submit button during its click dispatch can suppress the
      // browser's subsequent form-submit default action. Once submission
      // clears the draft, the same guarded button becomes inert.
      const sendTemporarilyGuarded = postSubmitInterruptGuardActive && !hasSendableContent;
      return (
        <button
          type="submit"
          className={SEND_BUTTON_CLASS_NAME}
          {...pointerFocusProps}
          onClick={onArmPostSubmitInterruptGuard}
          disabled={
            isSendBusy || isConnecting || isEnvironmentUnavailable || sendTemporarilyGuarded
          }
          aria-label={isRunning ? "Queue message" : "Send message"}
        >
          <ArrowUpIcon aria-hidden="true" className="size-4" strokeWidth={2.25} />
        </button>
      );
    }

    return (
      <button
        type="button"
        className={cn(
          ROUND_PRIMARY_BUTTON_CLASS_NAME,
          "cursor-pointer bg-destructive/90 text-white hover:bg-destructive",
        )}
        {...pointerFocusProps}
        onClick={onInterrupt}
        disabled={recoveryStopAvailable && (isSendBusy || isConnecting || isEnvironmentUnavailable)}
        aria-label={recoveryStopAvailable ? "Stop recovery" : "Stop generation"}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </button>
    );
  }

  if (showPlanFollowUpPrompt) {
    if (promptHasText) {
      return (
        <Button
          type="submit"
          size="sm"
          className={cn("rounded-full", compact ? "h-9 px-3 sm:h-8" : "h-9 px-4 sm:h-8")}
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending…" : "Refine"}
        </Button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <Button
          type="submit"
          size="sm"
          className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
          {...pointerFocusProps}
          disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
        >
          {isConnecting || isSendBusy ? "Sending…" : "Implement"}
        </Button>
        <Menu>
          {/* This popup owns focus. Preventing its pointer default, unlike an
              immediate Send/Implement action, suppresses Base UI activation. */}
          <MenuTrigger
            render={
              <Button
                size="sm"
                variant="default"
                className={cn(
                  "h-9 rounded-l-none rounded-r-full border-l-white/12 sm:h-8",
                  compact ? "px-1" : "px-2",
                )}
                aria-label="Implementation actions"
                disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            <MenuItem
              disabled={isSendBusy || isConnecting || isEnvironmentUnavailable}
              onClick={() => void onImplementPlanInNewThread()}
            >
              Implement in a new chat
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  return (
    <button
      type="submit"
      className={SEND_BUTTON_CLASS_NAME}
      {...pointerFocusProps}
      disabled={isSendBusy || isConnecting || isEnvironmentUnavailable || !hasSendableContent}
      aria-label={
        isEnvironmentUnavailable
          ? "Environment disconnected"
          : isConnecting
            ? "Connecting"
            : isPreparingWorktree
              ? "Preparing worktree"
              : isSendBusy
                ? "Sending"
                : "Send message"
      }
    >
      {isConnecting || isSendBusy ? (
        <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
      ) : (
        <ArrowUpIcon aria-hidden="true" className="size-4" strokeWidth={2.25} />
      )}
    </button>
  );
});
