export const RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY = "(max-width: 980px)";
export const RIGHT_PANEL_SHEET_CLASS_NAME =
  "w-[min(42vw,28rem)] min-w-80 max-w-[28rem] p-0 max-[760px]:w-[min(88vw,24rem)] max-[760px]:min-w-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]";

export const DEFAULT_CHAT_RIGHT_PANEL_WIDTH = 340;
export const MIN_CHAT_RIGHT_PANEL_WIDTH = 220;
export const MAX_CHAT_RIGHT_PANEL_WIDTH = 640;
export const MIN_CHAT_COLUMN_WIDTH = 320;

/** Renderer storage is untrusted; a missing or invalid choice keeps automatic sizing. */
export function normalizeChatRightPanelWidth(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_CHAT_RIGHT_PANEL_WIDTH &&
    value <= MAX_CHAT_RIGHT_PANEL_WIDTH
    ? Math.round(value)
    : null;
}

export function chatRightPanelWidthBounds(containerWidth: number) {
  const available = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const max = Math.max(0, Math.min(MAX_CHAT_RIGHT_PANEL_WIDTH, available - MIN_CHAT_COLUMN_WIDTH));
  return { min: Math.min(MIN_CHAT_RIGHT_PANEL_WIDTH, max), max };
}

/** Fit only the displayed width. Narrowing a pane must not erase the user's wider choice. */
export function resolveChatRightPanelWidth(
  preferredWidth: number | null,
  containerWidth: number,
  defaultWidth = DEFAULT_CHAT_RIGHT_PANEL_WIDTH,
): number {
  const bounds = chatRightPanelWidthBounds(containerWidth);
  const fallback = Number.isFinite(defaultWidth) ? defaultWidth : DEFAULT_CHAT_RIGHT_PANEL_WIDTH;
  const preferred = normalizeChatRightPanelWidth(preferredWidth) ?? fallback;
  return Math.max(bounds.min, Math.min(bounds.max, preferred));
}
