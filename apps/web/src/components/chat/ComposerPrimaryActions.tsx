import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
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
  connectingStopAvailable?: boolean | undefined;
  stopInFlight?: boolean | undefined;
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
    return uiText("Submitting…");
  }
  if (input.compact) {
    return input.isLastQuestion ? uiText("Submit") : uiText("Next");
  }
  if (!input.isLastQuestion) {
    return uiText("Next question");
  }
  return uiText("{count, plural, one {Submit answer} other {Submit answers}}", {
    count: input.questionIndex > 0 ? input.questionIndex + 1 : 1,
  });
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

/** Stop for an explicit recovery/start remains accessible even with a draft.
 * Ordinary running turns retain their established send-before-stop behavior. */
export function primaryStopState(input: {
  readonly isRunning: boolean;
  readonly isQueueEditing: boolean;
  readonly recoveryStopAvailable: boolean;
  readonly connectingStopAvailable: boolean;
  readonly hasSendableContent: boolean;
  readonly postSubmitInterruptGuardActive: boolean;
  readonly isEnvironmentUnavailable: boolean;
  readonly stopInFlight: boolean;
}): { readonly visible: boolean; readonly disabled: boolean; readonly showSend: boolean } {
  const contextStop = input.recoveryStopAvailable || input.connectingStopAvailable;
  return {
    visible:
      contextStop ||
      (input.isRunning && !input.hasSendableContent && !input.postSubmitInterruptGuardActive),
    disabled: input.stopInFlight || (contextStop && input.isEnvironmentUnavailable),
    showSend:
      !input.isQueueEditing &&
      !input.connectingStopAvailable &&
      (input.isRunning || input.recoveryStopAvailable) &&
      (input.hasSendableContent || input.postSubmitInterruptGuardActive),
  };
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  pendingAction,
  isRunning,
  recoveryStopAvailable = false,
  connectingStopAvailable = false,
  stopInFlight = false,
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  if (isQueueEditing && !recoveryStopAvailable && !connectingStopAvailable) return null;
  const pointerFocusProps = preserveComposerFocusOnPointerDown
    ? { onPointerDown: preventPointerFocus }
    : undefined;

  const stop = primaryStopState({
    isRunning,
    isQueueEditing,
    recoveryStopAvailable,
    connectingStopAvailable,
    hasSendableContent,
    postSubmitInterruptGuardActive,
    isEnvironmentUnavailable,
    stopInFlight,
  });
  const stopAction = stop.visible ? (
    <button
      type="button"
      className={cn(
        ROUND_PRIMARY_BUTTON_CLASS_NAME,
        "cursor-pointer bg-destructive/90 text-white hover:bg-destructive",
      )}
      {...pointerFocusProps}
      onClick={onInterrupt}
      disabled={stop.disabled}
      aria-label={
        recoveryStopAvailable
          ? uiText("Stop recovery", undefined, undefined, uiLocale)
          : connectingStopAvailable
            ? uiText("Stop", undefined, undefined, uiLocale)
            : uiText("Stop generation", undefined, undefined, uiLocale)
      }
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
        <rect x="2" y="2" width="8" height="8" rx="1.5" />
      </svg>
    </button>
  ) : null;

  if (pendingAction) {
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {/* Pending questions retain their existing navigation/submit policy.
            Context cancellation is independent from answering that request. */}
        {recoveryStopAvailable || connectingStopAvailable ? stopAction : null}
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label={uiText("Previous question", undefined, undefined, uiLocale)}
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
              {uiText("Previous", undefined, undefined, uiLocale)}
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
          {uiPresentation.formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </Button>
      </div>
    );
  }

  if (isRunning || recoveryStopAvailable || connectingStopAvailable) {
    // Recovery keeps both actions when the draft can be sent. Starting a
    // provider instead keeps Stop in the formerly disabled connecting slot.
    const sendTemporarilyGuarded = postSubmitInterruptGuardActive && !hasSendableContent;
    const sendAction = stop.showSend ? (
      <button
        type="submit"
        className={SEND_BUTTON_CLASS_NAME}
        {...pointerFocusProps}
        onClick={onArmPostSubmitInterruptGuard}
        disabled={isSendBusy || isConnecting || isEnvironmentUnavailable || sendTemporarilyGuarded}
        aria-label={
          isRunning
            ? uiText("Queue message", undefined, undefined, uiLocale)
            : uiText("Send message", undefined, undefined, uiLocale)
        }
      >
        <ArrowUpIcon aria-hidden="true" className="size-4" strokeWidth={2.25} />
      </button>
    ) : null;

    return stopAction && sendAction ? (
      <div className="flex items-center gap-2">
        {stopAction}
        {sendAction}
      </div>
    ) : (
      (stopAction ?? sendAction)
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
          {isConnecting || isSendBusy
            ? uiText("Sending…", undefined, undefined, uiLocale)
            : uiText("Refine", undefined, undefined, uiLocale)}
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
          {isConnecting || isSendBusy
            ? uiText("Sending…", undefined, undefined, uiLocale)
            : uiText("Implement", undefined, undefined, uiLocale)}
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
                aria-label={uiText("Implementation actions", undefined, undefined, uiLocale)}
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
              {uiText("Implement in a new chat", undefined, undefined, uiLocale)}
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
          ? uiText("Environment disconnected", undefined, undefined, uiLocale)
          : isConnecting
            ? uiText("Connecting", undefined, undefined, uiLocale)
            : isPreparingWorktree
              ? uiText("Preparing worktree", undefined, undefined, uiLocale)
              : isSendBusy
                ? uiText("Sending", undefined, undefined, uiLocale)
                : uiText("Send message", undefined, undefined, uiLocale)
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

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { formatPendingPrimaryActionLabel };
