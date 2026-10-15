import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useChatPaneSharedState } from "~/chatPaneContext";

const MAX_DISMISSED_CHAT_CONTROLS = 64;

/** A bounded, volatile presentation preference, never transcript/provider state. */
export function updateScrollToBottomDismissals(
  previous: ReadonlySet<string>,
  owner: string,
  dismissed: boolean,
): ReadonlySet<string> {
  if (previous.has(owner) === dismissed) return previous;
  const next = new Set(previous);
  if (dismissed) next.add(owner);
  else next.delete(owner);
  while (next.size > MAX_DISMISSED_CHAT_CONTROLS) {
    const oldest = next.values().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

/**
 * The layout owns this preference across tab remounts, just like review offsets.
 * Keys include the exact environment and chat. Two views of that same chat
 * share the choice; another chat or environment never inherits it. Updates
 * happen only on a deliberate hide or fresh physical-bottom observation,
 * never on a stream tick, optimistic follow signal or scroll request.
 */
export function useScrollToBottomDismissal(owner: string) {
  const [dismissals, setDismissals] = useChatPaneSharedState<ReadonlySet<string>>(
    "timeline-scroll-control-dismissals",
    () => new Set<string>(),
  );
  // String equality alone cannot fence an away-and-back navigation or an old
  // unmounted view. Every committed ownership lifetime has a fresh token.
  const ownerToken = useMemo(() => ({ owner }), [owner]);
  const currentOwner = useRef<object | null>(null);
  useLayoutEffect(() => {
    currentOwner.current = ownerToken;
    return () => {
      if (currentOwner.current === ownerToken) currentOwner.current = null;
    };
  }, [ownerToken]);
  const hideUntilBottom = useCallback(() => {
    if (currentOwner.current !== ownerToken) return;
    setDismissals((previous) => updateScrollToBottomDismissals(previous, owner, true));
  }, [owner, ownerToken, setDismissals]);
  const observeBottom = useCallback(() => {
    // Retired list callbacks must not consume a newer chat's choice.
    if (currentOwner.current !== ownerToken) return;
    setDismissals((previous) => updateScrollToBottomDismissals(previous, owner, false));
  }, [owner, ownerToken, setDismissals]);
  return { dismissed: dismissals.has(owner), hideUntilBottom, observeBottom };
}
