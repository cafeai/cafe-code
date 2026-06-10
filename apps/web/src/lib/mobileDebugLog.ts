/**
 * Mobile debugging instrumentation (disabled by default).
 *
 * When enabled, sends DOM/state snapshots to the server
 * (`POST /api/client-debug-log`), which echoes them to the server log only
 * when the backend was started with debug logging. This lets mobile composer
 * behavior be diagnosed without attaching devtools to the device.
 *
 * To enable on a device without rebuilding, run this in its console (or via a
 * bookmarklet) and reload:
 *
 *   localStorage.setItem("cafecode:mobile-debug", "1")
 *
 * Remove the key (or set DEBUG_ENABLED to false) to turn it back off.
 */
const DEBUG_ENABLED = false;

let enabledCache: boolean | null = null;

function isDebugLoggingEnabled(): boolean {
  if (enabledCache !== null) return enabledCache;
  if (DEBUG_ENABLED) {
    enabledCache = true;
    return true;
  }
  try {
    enabledCache =
      typeof window !== "undefined" && window.localStorage.getItem("cafecode:mobile-debug") === "1";
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}

let sequence = 0;

function describeElement(element: unknown): string {
  if (!(element instanceof Element)) {
    return element === null ? "<null>" : "<non-element>";
  }
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : "";
  const testId = element.getAttribute("data-testid");
  const ariaLabel = element.getAttribute("aria-label");
  const editable = element instanceof HTMLElement && element.isContentEditable ? "[editable]" : "";
  return `${tag}${id}${testId ? `[testid=${testId}]` : ""}${ariaLabel ? `[aria=${ariaLabel}]` : ""}${editable}`;
}

function computedDisplay(selector: string): string {
  const element = document.querySelector(selector);
  if (!element) return "<absent>";
  return window.getComputedStyle(element).display;
}

export function domSnapshot(): Record<string, unknown> {
  // Skip the DOM queries entirely when disabled — this runs in hot paths
  // (focus events, composer state changes) where callers spread the result.
  if (!isDebugLoggingEnabled()) return {};
  const composerSurface = document.querySelector("[data-chat-composer-mobile-collapsed]");
  return {
    innerSize: `${window.innerWidth}x${window.innerHeight}`,
    visualViewport: window.visualViewport
      ? `${Math.round(window.visualViewport.width)}x${Math.round(window.visualViewport.height)}`
      : "<unsupported>",
    maxSm: window.matchMedia("(max-width: 639px)").matches,
    maxMd: window.matchMedia("(max-width: 767px)").matches,
    touchOnly: window.matchMedia("(hover: none) and (pointer: coarse)").matches,
    activeElement: describeElement(document.activeElement),
    headerDisplay: computedDisplay("[data-chat-view-header]"),
    footerDisplay: computedDisplay("[data-chat-composer-footer]"),
    collapsedAttr:
      composerSurface?.getAttribute("data-chat-composer-mobile-collapsed") ?? "<absent>",
    keyboardOpenAttr:
      composerSurface?.getAttribute("data-chat-composer-keyboard-open") ?? "<absent>",
  };
}

export function mobileDebugLog(event: string, data: Record<string, unknown> = {}): void {
  if (!isDebugLoggingEnabled()) return;
  const payload = { seq: ++sequence, event, ...data };
  console.info("[mobile-debug]", payload);
  try {
    void fetch("/api/client-debug-log", {
      method: "POST",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    // Logging must never break the app.
  }
}

let installed = false;

export function installMobileDebugLogging(): void {
  if (installed || typeof window === "undefined") return;
  if (!isDebugLoggingEnabled()) return;
  installed = true;

  mobileDebugLog("init", {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    ...domSnapshot(),
  });

  window.visualViewport?.addEventListener("resize", () => {
    mobileDebugLog("visualViewport-resize", domSnapshot());
  });
  window.addEventListener("resize", () => {
    mobileDebugLog("window-resize", domSnapshot());
  });
  document.addEventListener("focusin", (event) => {
    mobileDebugLog("focusin", { target: describeElement(event.target), ...domSnapshot() });
  });
  document.addEventListener("focusout", (event) => {
    mobileDebugLog("focusout", { target: describeElement(event.target) });
  });
}
