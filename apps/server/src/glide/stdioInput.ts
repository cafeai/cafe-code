import { Transform } from "node:stream";

// JSON escaping can expand a 128 KiB cell to almost 768 KiB. Refuse an
// oversized line before the SDK's JSONL reader retains/parses its entire body.
const MAX_MCP_LINE_BYTES = 1024 * 1024;
export function createGlideStdioInput() {
  let used = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline;
        used += end - offset;
        if (used > MAX_MCP_LINE_BYTES) {
          callback(new Error("Glide MCP input exceeded its message limit."));
          return;
        }
        if (newline < 0) break;
        used = 0;
        offset = newline + 1;
      }
      callback(null, chunk);
    },
  });
}
