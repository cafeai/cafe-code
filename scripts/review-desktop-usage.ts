import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";

/** Opt-in, read-only comparison of a local Codex JSONL snapshot. Output is
 * numeric aggregates only: never prompts, reasoning, images, paths, arguments,
 * native turn IDs, or credentials. No provider requests or SQLite scans. */
export async function reviewDesktopUsage(file: string) {
  const size = (await stat(file)).size;
  const turns = new Map<
    string,
    {
      responses: number;
      input: number;
      cachedInput: number;
      output: number;
      desktopCalls: number;
      screenshotCalls: number;
      failedDesktopCalls: number;
    }
  >();
  const row = (id: unknown) => {
    const key = typeof id === "string" ? id : "unknown";
    let value = turns.get(key);
    if (!value) {
      if (turns.size >= 10_000) throw Error("Usage review exceeded its turn limit.");
      value = {
        responses: 0,
        input: 0,
        cachedInput: 0,
        output: 0,
        desktopCalls: 0,
        screenshotCalls: 0,
        failedDesktopCalls: 0,
      };
      turns.set(key, value);
    }
    return value;
  };
  const counter = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  if (size === 0) return [];
  const stream = createReadStream(file, { end: size - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 64 * 1024 * 1024)
        throw Error("Usage record exceeds the bounded review limit.");
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      } // An active writer's final partial line.
      const payload = record?.payload;
      if (record?.type === "token_usage_record" && payload?.usage) {
        const total = row(payload.turn_id);
        total.responses++;
        total.input += counter(payload.usage.input_tokens);
        total.cachedInput += counter(payload.usage.cached_input_tokens);
        total.output += counter(payload.usage.output_tokens);
      }
      const item = payload?.item;
      if (
        record?.type === "event_msg" &&
        payload?.type === "item_completed" &&
        item?.type === "McpToolCall" &&
        item.server === "cafe-desktop"
      ) {
        const total = row(payload.turn_id);
        total.desktopCalls++;
        if (item.status !== "completed") total.failedDesktopCalls++;
        // Count confirmed image blocks, including Codex's JSON-wrapped logging
        // representation. That wrapper is not model-visible base64 text.
        const hasImage = (value: unknown, depth = 0): boolean => {
          if (depth > 6 || !value || typeof value !== "object") return false;
          if (Array.isArray(value)) return value.some((item) => hasImage(item, depth + 1));
          const block = value as Record<string, unknown>;
          if (block.type === "image") return true;
          if (
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text.startsWith("{")
          ) {
            try {
              return hasImage(JSON.parse(block.text), depth + 1);
            } catch {
              return false;
            }
          }
          return hasImage(block.content, depth + 1);
        };
        if (hasImage(item.result)) total.screenshotCalls++;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return [...turns.values()].map((turn, index) => ({
    turn: index + 1,
    ...turn,
    uncachedInput: Math.max(0, turn.input - turn.cachedInput),
  }));
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw Error("Pass a local Codex JSONL transcript to review.");
  console.log(JSON.stringify(await reviewDesktopUsage(file), null, 2));
}
