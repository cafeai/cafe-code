export const CHAT_VIEW_BROWSER_PART = "composer" as const;

(
  globalThis as typeof globalThis & { __CAFE_CHAT_VIEW_BROWSER_PART__?: string }
).__CAFE_CHAT_VIEW_BROWSER_PART__ = CHAT_VIEW_BROWSER_PART;

await import("./ChatViewBrowser.shared");
