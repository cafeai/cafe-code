/** Compatibility-only filtering for private tools in older provider history.
 * These names do not register tools or grant any runtime capability. */
export function isArchivedPrivateToolServer(name: string): boolean {
  return name === "cafe-desktop" || /^cafe-native-[A-Za-z0-9_-]{22}$/u.test(name);
}

/** Redact Cafe-owned Claude tool payloads before native logging or projection.
 * The provider's own model exchange already consumed its unmodified message. */
export class ArchivedToolPayloadRedactor {
  private readonly toolIds = new Set<string>();
  private readonly streamIndexes = new Set<number>();
  private overflow = false;
  redact<T>(value: T): T {
    const walk = (item: unknown, depth: number): unknown => {
      if (depth > 32) return "[Archived private tool payload omitted]";
      if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1));
      if (!item || typeof item !== "object") return item;
      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      if (record.type === "tool_use" && /^mcp__cafe-native-[A-Za-z0-9_-]{22}__/u.test(name)) {
        if (typeof record.id === "string") {
          if (this.toolIds.size < 4096) this.toolIds.add(record.id);
          else this.overflow = true;
        }
        return { ...record, input: {} };
      }
      if (
        record.type === "tool_result" &&
        typeof record.tool_use_id === "string" &&
        (this.overflow || this.toolIds.has(record.tool_use_id))
      )
        return { ...record, content: "[Archived private tool result]" };
      if (record.type === "content_block_start" && typeof record.index === "number") {
        const block = record.content_block as Record<string, unknown> | undefined;
        if (
          typeof block?.name === "string" &&
          /^mcp__cafe-native-[A-Za-z0-9_-]{22}__/u.test(block.name)
        )
          this.streamIndexes.add(record.index);
        else this.streamIndexes.delete(record.index);
      }
      if (
        record.type === "content_block_delta" &&
        typeof record.index === "number" &&
        this.streamIndexes.has(record.index)
      )
        return { ...record, delta: { type: "input_json_delta", partial_json: "" } };
      if (record.type === "content_block_stop" && typeof record.index === "number")
        this.streamIndexes.delete(record.index);
      return Object.fromEntries(
        Object.entries(record).map(([key, entry]) => [key, walk(entry, depth + 1)]),
      );
    };
    return walk(value, 0) as T;
  }
}
