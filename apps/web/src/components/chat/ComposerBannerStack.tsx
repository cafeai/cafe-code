import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

/**
 * Exits use the fast motion token (docs/style-guide.md: exits are faster than
 * entrances). The timeout must match --duration-fast because the dismissed
 * banner is removed only after its exit finishes. Reduced motion keeps the
 * fade but drops the travel, matching the global entrance rule.
 */
const DISMISS_TRANSITION_MS = 120;
const frontExitStyle = {
  opacity: 0,
  transform: "translate3d(0, 4rem, 0)",
} satisfies CSSProperties;
const stackedExitStyle = {
  opacity: 0,
  transform: "translate3d(0, 7rem, 0)",
} satisfies CSSProperties;
const reducedMotionExitStyle = { opacity: 0 } satisfies CSSProperties;
const restingStyle = {
  opacity: 1,
  transform: "translate3d(0, 0, 0)",
} satisfies CSSProperties;
const exitTransitionStyle = {
  transition: `transform ${DISMISS_TRANSITION_MS}ms var(--ease-in), opacity ${DISMISS_TRANSITION_MS}ms var(--ease-in)`,
  willChange: "transform, opacity",
} satisfies CSSProperties;

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: "error" | "info" | "success" | "warning";
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

interface ComposerBannerStackProps {
  readonly className?: string;
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
}

export function ComposerBannerStack({ className, items }: ComposerBannerStackProps) {
  const [exitingItemId, setExitingItemId] = useState<string | null>(null);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (exitingItemId && !items.some((item) => item.id === exitingItemId)) {
      setExitingItemId(null);
    }
  }, [exitingItemId, items]);

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, []);

  if (items.length === 0) {
    return null;
  }

  const frontItem = items[0];
  if (!frontItem) {
    return null;
  }
  const stackedItems = items.slice(1);
  const hasStack = stackedItems.length > 0;
  const showCollapsedStackCap = hasStack && exitingItemId !== frontItem.id;

  const requestDismiss = (item: ComposerBannerStackItem) => {
    if (!item.onDismiss || exitingItemId) {
      return;
    }
    setExitingItemId(item.id);
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
    }
    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null;
      item.onDismiss?.();
    }, DISMISS_TRANSITION_MS);
  };

  return (
    <div className={cn("group/banner-stack mx-auto mb-2 max-w-208", className)}>
      <div
        className={cn(
          "relative",
          hasStack ? "group-hover/banner-stack:z-50 group-focus-within/banner-stack:z-50" : null,
        )}
      >
        {showCollapsedStackCap ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 -top-3 z-0 mx-auto h-3 rounded-t-xl",
              "border border-b-0 border-warning/24 bg-background/96 shadow-[0_6px_18px_rgba(0,0,0,0.06)]",
              "transition-opacity duration-(--duration-fast) ease-out",
              "group-hover/banner-stack:opacity-0 group-focus-within/banner-stack:opacity-0",
            )}
            style={{ width: "96%" }}
            aria-hidden="true"
          />
        ) : null}
        <div
          // Keyed so a banner promoted from the stack (or a new one) enters once.
          key={frontItem.id}
          className={cn(
            "relative z-10 animate-enter-rise",
            exitingItemId === frontItem.id ? "pointer-events-none" : null,
          )}
          style={{
            ...exitTransitionStyle,
            ...(exitingItemId === frontItem.id
              ? reducedMotion
                ? reducedMotionExitStyle
                : frontExitStyle
              : restingStyle),
          }}
        >
          <ComposerBannerStackAlert
            item={frontItem}
            exiting={exitingItemId === frontItem.id}
            onDismissRequest={() => requestDismiss(frontItem)}
          />
        </div>
        {hasStack ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-[calc(100%+0.5rem)] z-20 space-y-2 opacity-0",
              "transition-[opacity,transform] duration-(--duration-base) ease-out motion-reduce:translate-y-0",
              "translate-y-1 transform-gpu will-change-[opacity,transform]",
              "group-hover/banner-stack:pointer-events-auto group-hover/banner-stack:translate-y-0 group-hover/banner-stack:opacity-100",
              "group-focus-within/banner-stack:pointer-events-auto group-focus-within/banner-stack:translate-y-0 group-focus-within/banner-stack:opacity-100",
            )}
          >
            {stackedItems.map((item) => (
              <div
                key={item.id}
                className={cn(exitingItemId === item.id ? "pointer-events-none" : null)}
                style={{
                  ...exitTransitionStyle,
                  ...(exitingItemId === item.id
                    ? reducedMotion
                      ? reducedMotionExitStyle
                      : stackedExitStyle
                    : restingStyle),
                }}
              >
                <ComposerBannerStackAlert
                  item={item}
                  exiting={exitingItemId === item.id}
                  onDismissRequest={() => requestDismiss(item)}
                />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ComposerBannerStackAlert({
  item,
  exiting,
  onDismissRequest,
}: {
  readonly item: ComposerBannerStackItem;
  readonly exiting: boolean;
  readonly onDismissRequest: () => void;
}) {
  const dismissOnly = item.onDismiss && !item.actions;

  return (
    <Alert variant={item.variant}>
      {item.icon}
      <AlertTitle>{item.title}</AlertTitle>
      {item.description ? <AlertDescription>{item.description}</AlertDescription> : null}
      {item.actions || item.onDismiss ? (
        <AlertAction
          className={
            dismissOnly
              ? "max-sm:col-start-3 max-sm:row-start-1 max-sm:mt-0 max-sm:self-start"
              : undefined
          }
        >
          {item.actions}
          {item.onDismiss ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={item.dismissLabel ?? "Dismiss warning"}
              disabled={exiting}
              onClick={onDismissRequest}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </AlertAction>
      ) : null}
    </Alert>
  );
}
