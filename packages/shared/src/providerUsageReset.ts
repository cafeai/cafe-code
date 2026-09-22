import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";

/** Use the unrounded provider figure: exactly 5% remaining is not below 5%. */
export function hasLowCodexUsage(
  rateLimits: ServerProviderAccountRateLimits | null | undefined,
): boolean {
  const snapshot = rateLimits?.rateLimitsByLimitId?.codex ?? rateLimits?.rateLimits;
  return [snapshot?.primary, snapshot?.secondary].some(
    (window) =>
      typeof window?.usedPercent === "number" &&
      Number.isFinite(window.usedPercent) &&
      window.usedPercent > 95,
  );
}
