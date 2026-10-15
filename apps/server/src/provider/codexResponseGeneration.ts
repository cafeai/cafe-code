/**
 * Codex response-generation timing for the tokens-per-second display.
 *
 * Source contract (openai/codex rust-v0.162.1, codex-rs/core/src/session/turn.rs
 * and codex-rs/core/src/tools/parallel.rs):
 *
 * - `ResponseEvent::OutputItemAdded` for reasoning and assistant messages emits
 *   `item/started` when that item begins streaming; its deltas follow and
 *   `OutputItemDone` emits `item/completed`.
 * - Function calls emit nothing until their arguments finish. `OutputItemDone`
 *   then spawns the tool immediately (`tokio::spawn`), so the first tool's
 *   `item/started` approximates the end of its argument generation. Later
 *   tools in the same response can wait for the serial tool lock, and a tool
 *   can begin only after an approval, so neither may extend the window.
 * - `thread/tokenUsage/updated` is sent only after every tool from that
 *   response has finished (`send_token_count_event` follows
 *   `drain_in_flight`). Its arrival therefore includes tool execution time and
 *   must not end the window; the last observed output edge does instead.
 * - The exact `rawResponse/completed` marker requires `experimentalRawEvents`,
 *   which Cafe deliberately leaves disabled.
 *
 * Hosted tools (web search, image generation) and remote compaction run inside
 * the model response without producing decode output, so a response containing
 * them is not sampled. Unobserved generation time (for example a second
 * parallel call's arguments) can still make a sample read slightly high; the
 * shared clock drops implausible rates. Feed this tracker root-thread
 * notifications only: subagents are separate native threads with their own
 * concurrent sampling loops.
 */
import { ResponseGenerationClock } from "./responseGenerationClock.ts";

/** Items whose `item/started` marks the start of streamed model output. */
const OUTPUT_ITEM_TYPES: ReadonlySet<string> = new Set(["reasoning", "agentMessage", "plan"]);

/** Locally executed tools, spawned as soon as their call finishes generating. */
const LOCAL_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "imageView",
  "sleep",
]);

/** Work performed inside the provider response that is not decoding. */
const NON_DECODE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "webSearch",
  "imageGeneration",
  "contextCompaction",
]);

/** Streaming deltas that only occur while the model is producing output. */
const OUTPUT_DELTA_METHODS: ReadonlySet<string> = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/plan/delta",
]);

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readItemType(params: unknown): string | undefined {
  const type = readRecord(readRecord(params)?.item)?.type;
  return typeof type === "string" ? type : undefined;
}

function readLastOutputTokens(params: unknown): number | undefined {
  const last = readRecord(readRecord(readRecord(params)?.tokenUsage)?.last);
  const outputTokens = last?.outputTokens;
  return typeof outputTokens === "number" ? outputTokens : undefined;
}

export class CodexResponseGenerationTracker {
  readonly #clock = new ResponseGenerationClock();
  /** Only the first local tool start of a response is a trustworthy end edge. */
  #toolEdgeObserved = false;
  /** An approval/user-input resolution can delay later tool starts arbitrarily. */
  #toolEdgesSealed = false;

  /**
   * Observe one admitted root-thread notification at its receive time.
   * Returns the measured streaming interval when this notification is the
   * token-usage report closing a sampled response, otherwise `undefined`.
   */
  observe(notification: { readonly method: string; readonly params?: unknown }, atMs: number) {
    const { method, params } = notification;
    if (method === "thread/tokenUsage/updated") {
      const sample = this.#clock.finish(readLastOutputTokens(params));
      this.#resetResponse();
      return sample?.durationMs;
    }
    if (method === "turn/started" || method === "turn/completed" || method === "error") {
      // A retried stream (error with willRetry) restarts the response, and a
      // turn boundary can end a response that never reported usage.
      this.#clock.reset();
      this.#resetResponse();
      return undefined;
    }
    if (method === "serverRequest/resolved") {
      this.#toolEdgesSealed = true;
      return undefined;
    }
    if (OUTPUT_DELTA_METHODS.has(method)) {
      this.#clock.observeOutput(atMs);
      return undefined;
    }
    if (method === "item/fileChange/patchUpdated") {
      // Streamed apply_patch arguments: generation evidence, but a patch update
      // alone does not prove where the response began.
      this.#clock.observeEdge(atMs);
      return undefined;
    }
    if (method !== "item/started" && method !== "item/completed") return undefined;

    const itemType = readItemType(params);
    if (itemType === undefined) return undefined;
    if (OUTPUT_ITEM_TYPES.has(itemType)) {
      if (method === "item/started") this.#clock.observeOutput(atMs);
      else this.#clock.observeEdge(atMs);
      return undefined;
    }
    if (method !== "item/started") return undefined;
    if (NON_DECODE_ITEM_TYPES.has(itemType)) {
      this.#clock.invalidate();
      return undefined;
    }
    if (
      LOCAL_TOOL_ITEM_TYPES.has(itemType) &&
      this.#clock.isOpen &&
      !this.#toolEdgeObserved &&
      !this.#toolEdgesSealed
    ) {
      this.#clock.observeEdge(atMs);
      this.#toolEdgeObserved = true;
    }
    return undefined;
  }

  #resetResponse(): void {
    this.#toolEdgeObserved = false;
    this.#toolEdgesSealed = false;
  }
}
