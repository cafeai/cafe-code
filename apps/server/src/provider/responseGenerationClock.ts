/**
 * Provider-neutral measurement of how long one model response spent streaming.
 *
 * The renderer's tokens-per-second display divides provider-reported output
 * tokens by this interval. Providers report output counts once per response
 * (Codex after `response.completed`, Claude on `message_delta`), never per
 * token, so the only honest live-ish speed is per response: from the first
 * streamed output Cafe observes to the last output edge of that response.
 *
 * The interval deliberately starts at the first output rather than at request
 * submission, which excludes queueing and prompt processing (time to first
 * token). Each adapter decides which native frames count as output and where a
 * response ends; this module only owns the window state and sample validation.
 * Samples are display-only metadata: they never feed billing, liveness, retry
 * or lifecycle decisions.
 */
import type { ResponseGenerationSample } from "@cafecode/contracts";

/**
 * Shorter intervals are dominated by event-loop and transport jitter: a
 * 20-token reply delivered in one burst would otherwise report an absurd rate.
 */
export const RESPONSE_GENERATION_MIN_DURATION_MS = 50;

/**
 * Defensive ceiling for a measured rate. Current hosted models decode well
 * below this; a higher value means the interval missed part of the response
 * (for example an unobserved tool-argument tail), so the sample is dropped
 * instead of inflating the renderer's rolling average.
 */
export const RESPONSE_GENERATION_MAX_TOKENS_PER_SECOND = 5_000;

/** Validate and normalize one sample; `undefined` means "not measured". */
export function makeResponseGenerationSample(
  outputTokens: number | undefined,
  durationMs: number | undefined,
): ResponseGenerationSample | undefined {
  if (
    outputTokens === undefined ||
    durationMs === undefined ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(durationMs)
  ) {
    return undefined;
  }
  const tokens = Math.trunc(outputTokens);
  const duration = Math.round(durationMs);
  if (tokens < 1 || duration < RESPONSE_GENERATION_MIN_DURATION_MS) {
    return undefined;
  }
  if ((tokens * 1_000) / duration > RESPONSE_GENERATION_MAX_TOKENS_PER_SECOND) {
    return undefined;
  }
  return { outputTokens: tokens, durationMs: duration };
}

/**
 * Mutable per-session window for the response currently streaming. Callers
 * own ordering: feed observations in native arrival order for exactly one
 * response stream (never a nested/child stream) and reset at every response,
 * turn, retry or failure boundary.
 */
export class ResponseGenerationClock {
  #firstAtMs: number | undefined;
  #lastAtMs: number | undefined;
  #invalid = false;

  /** True once streamed output has opened the current response window. */
  get isOpen(): boolean {
    return this.#firstAtMs !== undefined;
  }

  /** Streamed model output: opens the window or extends its last edge. */
  observeOutput(atMs: number): void {
    if (!Number.isFinite(atMs)) return;
    if (this.#firstAtMs === undefined) {
      this.#firstAtMs = atMs;
      this.#lastAtMs = atMs;
      return;
    }
    this.#extend(atMs);
  }

  /**
   * Evidence that output was still being produced at `atMs`, without proving
   * when the response began (for example an item completion or a tool call
   * becoming ready). It can extend an open window but never open one.
   */
  observeEdge(atMs: number): void {
    if (this.#firstAtMs === undefined || !Number.isFinite(atMs)) return;
    this.#extend(atMs);
  }

  /**
   * The current response contains time that is not decoding (for example a
   * provider-hosted web search). Keep ignoring it until the next reset.
   */
  invalidate(): void {
    this.#invalid = true;
  }

  reset(): void {
    this.#firstAtMs = undefined;
    this.#lastAtMs = undefined;
    this.#invalid = false;
  }

  /**
   * Close the window with the response's provider-reported output count.
   * `endAtMs` marks an exact end-of-generation frame; omit it when the usage
   * report arrives after unrelated work and the last edge is the better bound.
   */
  finish(outputTokens: number | undefined, endAtMs?: number): ResponseGenerationSample | undefined {
    if (endAtMs !== undefined) this.observeEdge(endAtMs);
    const sample =
      this.#invalid || this.#firstAtMs === undefined || this.#lastAtMs === undefined
        ? undefined
        : makeResponseGenerationSample(outputTokens, this.#lastAtMs - this.#firstAtMs);
    this.reset();
    return sample;
  }

  #extend(atMs: number): void {
    // Observation timestamps come from one process clock but different
    // callbacks; never let a late-delivered earlier stamp shrink the window.
    if (this.#lastAtMs === undefined || atMs > this.#lastAtMs) this.#lastAtMs = atMs;
  }
}
