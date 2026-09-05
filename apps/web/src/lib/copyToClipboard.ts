function legacyCopyText(value: string): boolean {
  if (typeof document.execCommand !== "function") {
    return false;
  }

  const previouslyFocusedElement =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const selection = window.getSelection();
  const previousSelectionRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.setAttribute("aria-hidden", "true");
  textarea.tabIndex = -1;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.append(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();

    // Selecting the temporary textarea moves keyboard focus and replaces the
    // user's document selection in Chromium. Restore both so a fallback copy
    // does not eject keyboard users from the control they activated or erase
    // text they were inspecting in the conversation.
    if (previouslyFocusedElement?.isConnected) {
      previouslyFocusedElement.focus({ preventScroll: true });
    }
    const currentSelection = window.getSelection();
    if (currentSelection) {
      currentSelection.removeAllRanges();
      for (const range of previousSelectionRanges) {
        if (range.startContainer.isConnected && range.endContainer.isConnected) {
          currentSelection.addRange(range);
        }
      }
    }
  }
}

/** Copy text through the native desktop shell, modern browser API, or legacy browser fallback. */
export async function copyTextToClipboard(value: string): Promise<void> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Clipboard is unavailable outside a browser window.");
  }

  if (window.desktopBridge?.copyText) {
    await window.desktopBridge.copyText(value);
    return;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (clipboardError) {
      if (legacyCopyText(value)) return;
      throw clipboardError;
    }
  }

  if (!legacyCopyText(value)) {
    throw new Error("Clipboard access was denied by this browser.");
  }
}
