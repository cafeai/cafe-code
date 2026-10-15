import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import { uiFormatNumber } from "@cafecode/shared/i18n";

/**
 * Rolling window for the displayed generation speed, measured in generation
 * time rather than wall time. Providers report output once per response, so a
 * wall-clock window would be empty for most of a long reasoning response.
 * Averaging the most recent five seconds of measured decoding keeps one short
 * reply from swinging the figure while still following model changes quickly.
 */
export const GENERATION_RATE_WINDOW_MS = 5_000;

/**
 * Bound the backwards scan. Each measured response contributes at least the
 * server's 50 ms minimum, so this covers far more than one window; it only
 * stops chats whose provider never reports samples from rescanning history.
 */
const MAX_USAGE_ACTIVITIES_SCANNED = 64;

/** Mirrors the server ceiling; a stale or foreign payload cannot spike the average. */
const MAX_TOKENS_PER_SECOND = 5_000;

export interface GenerationRate {
  readonly tokensPerSecond: number;
  /** Measured decode time the average covers, at most the window. */
  readonly measuredMs: number;
}

interface Sample {
  readonly outputTokens: number;
  readonly durationMs: number;
}

function readSample(payload: unknown): Sample | null {
  if (!payload || typeof payload !== "object") return null;
  const sample = (payload as { responseGeneration?: unknown }).responseGeneration;
  if (!sample || typeof sample !== "object") return null;
  const { outputTokens, durationMs } = sample as Record<string, unknown>;
  if (
    typeof outputTokens !== "number" ||
    typeof durationMs !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(durationMs) ||
    outputTokens < 1 ||
    durationMs < 1 ||
    (outputTokens * 1_000) / durationMs > MAX_TOKENS_PER_SECOND
  ) {
    return null;
  }
  return { outputTokens, durationMs };
}

/**
 * Average output speed over the most recent `windowMs` of measured model
 * decoding, newest responses first. Each response's rate is treated as
 * constant across its own interval, so a response straddling the window edge
 * contributes proportionally. `since` restricts samples to activities observed
 * at or after that instant (for example the current turn's start).
 *
 * Display-only: the result never indicates liveness or provider state, and
 * `null` means no measurement, not zero speed.
 */
export function deriveGenerationRate(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  options?: { readonly since?: string | null | undefined; readonly windowMs?: number },
): GenerationRate | null {
  const windowMs = options?.windowMs ?? GENERATION_RATE_WINDOW_MS;
  const sinceMs = options?.since ? Date.parse(options.since) : Number.NaN;
  let tokens = 0;
  let measuredMs = 0;
  let scanned = 0;
  for (let index = activities.length - 1; index >= 0 && measuredMs < windowMs; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "context-window.updated") continue;
    // Activities are sequence-ordered, so everything before an older one is
    // older as well.
    if (Number.isFinite(sinceMs) && Date.parse(activity.createdAt) < sinceMs) break;
    if (++scanned > MAX_USAGE_ACTIVITIES_SCANNED) break;
    const sample = readSample(activity.payload);
    if (!sample) continue;
    const remainingMs = windowMs - measuredMs;
    if (sample.durationMs <= remainingMs) {
      tokens += sample.outputTokens;
      measuredMs += sample.durationMs;
    } else {
      tokens += (sample.outputTokens * remainingMs) / sample.durationMs;
      measuredMs = windowMs;
    }
  }
  if (measuredMs <= 0) return null;
  return { tokensPerSecond: (tokens * 1_000) / measuredMs, measuredMs };
}

/**
 * Viewer-native number for a rate: one decimal below 10 tok/s, where a whole
 * number would hide meaningful differences, and whole numbers above.
 */
export function formatTokensPerSecond(rate: GenerationRate): string {
  return uiFormatNumber(rate.tokensPerSecond, {
    maximumFractionDigits: rate.tokensPerSecond < 10 ? 1 : 0,
  });
}
