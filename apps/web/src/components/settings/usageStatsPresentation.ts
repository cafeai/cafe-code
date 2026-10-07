import type { ProviderDriverKind } from "@cafecode/contracts";

const tokenIntegerFormat = new Intl.NumberFormat("en-US");
const padDurationUnit = (value: number) => String(value).padStart(2, "0");

/**
 * Recorded generating time, always down to seconds and with no unit above days.
 * Shared with the global Usage duration so per-model rows remain familiar.
 * Values hold at the last detailed response; this formatter never extrapolates
 * an account-wide clock into a model's prospective recorded time.
 */
export function formatGeneratingTime(generatingMs: number): string {
  const totalSeconds = Number.isFinite(generatingMs)
    ? Math.max(0, Math.floor(generatingMs / 1_000))
    : 0;
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${tokenIntegerFormat.format(days)}d ${padDurationUnit(hours)}h ${padDurationUnit(minutes)}m ${padDurationUnit(seconds)}s`;
  }
  if (hours > 0) return `${hours}h ${padDurationUnit(minutes)}m ${padDurationUnit(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${padDurationUnit(seconds)}s`;
  return `${seconds}s`;
}

/** Local display date for the explicitly recorded coverage boundary. */
export function formatUsageRecordingDate(startedAt: string): string | undefined {
  // IsoDateTime remains a string on mixed-version boundaries. Keep parsing
  // bounded and never echo an oversized/corrupt coverage value into the UI.
  if (startedAt.length > 64) return undefined;
  const date = new Date(startedAt);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Usage counters are decoded as non-negative finite numbers, but presentation
 * helpers still fail closed so a mixed-version or corrupt snapshot cannot put
 * `NaN` or `Infinity` into the interface.
 */
function normalizedTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Exact comma-separated token count, available on hover/focus of a compact readout. */
export function formatFullTokenCount(value: number): string {
  return tokenIntegerFormat.format(Math.round(normalizedTokenCount(value)));
}

/** Compact token readout shown on usage surfaces, such as `3.54B`, `3.00M`, or `9.5K`. */
export function formatCompactTokenCount(value: number): string {
  const normalized = normalizedTokenCount(value);
  const formatMagnitude = (
    divisor: number,
    suffix: string,
    precisionBelowTen: number,
    precisionAtLeastTen: number,
  ) => {
    const scaled = normalized / divisor;
    const initialPrecision = scaled < 10 ? precisionBelowTen : precisionAtLeastTen;
    const rounded = Number(scaled.toFixed(initialPrecision));
    const stablePrecision = rounded < 10 ? precisionBelowTen : precisionAtLeastTen;
    return { rounded, text: `${rounded.toFixed(stablePrecision)}${suffix}` };
  };

  if (normalized >= 1_000_000_000) {
    return formatMagnitude(1_000_000_000, "B", 2, 1).text;
  }
  if (normalized >= 1_000_000) {
    const millions = formatMagnitude(1_000_000, "M", 2, 0);
    // Promote a rounded boundary instead of flashing `1000M` as an animated
    // full counter crosses into its next magnitude.
    return millions.rounded >= 1_000
      ? formatMagnitude(1_000_000_000, "B", 2, 1).text
      : millions.text;
  }
  if (normalized >= 1_000) {
    const thousands = formatMagnitude(1_000, "K", 1, 0);
    return thousands.rounded >= 1_000 ? formatMagnitude(1_000_000, "M", 2, 0).text : thousands.text;
  }
  return tokenIntegerFormat.format(Math.round(normalized));
}

export function formatUsageProviderLabel(provider: ProviderDriverKind): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "opencode":
      return "OpenCode";
    default:
      return provider
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .replace(/\b\w/g, (character) => character.toUpperCase());
  }
}

export function formatUsageModelLabel(model: string): string {
  return model === "unknown" ? "Model not reported" : model;
}

/**
 * A known provider with an absent effective model is different from missing
 * provider attribution. Helpers and older observations can legitimately lack
 * that field; never present the requested model as the one that served them,
 * and never claim every such row came from a helper.
 */
export function getUsageModelExplanation(model: string): string | undefined {
  return model === "unknown"
    ? "The provider didn't report which model served these tokens. They're counted but not priced."
    : undefined;
}
