/**
 * The Settings → App icon easter egg: clicking the "Icon" title 10 times
 * within 10 seconds swaps the default icon for Dekai, and doing it again
 * swaps it back. From the 5th click the row counts down the clicks left.
 */
export const SECRET_ICON_TAP_COUNT = 10;
export const SECRET_ICON_TAP_WINDOW_MS = 10_000;
export const SECRET_ICON_HINT_FROM_TAP = 5;

export interface SecretIconTapResult {
  /** Click times still inside the rolling window, oldest first. */
  readonly taps: readonly number[];
  /** Clicks left before the toggle, once the hint should show; otherwise null. */
  readonly remaining: number | null;
  /** True on the click that completes the sequence. */
  readonly toggled: boolean;
}

export function registerSecretIconTap(taps: readonly number[], now: number): SecretIconTapResult {
  const recent = taps.filter((tap) => now - tap < SECRET_ICON_TAP_WINDOW_MS && tap <= now);
  const next = [...recent, now];
  if (next.length >= SECRET_ICON_TAP_COUNT) return { taps: [], remaining: null, toggled: true };
  return {
    taps: next,
    remaining:
      next.length >= SECRET_ICON_HINT_FROM_TAP ? SECRET_ICON_TAP_COUNT - next.length : null,
    toggled: false,
  };
}
