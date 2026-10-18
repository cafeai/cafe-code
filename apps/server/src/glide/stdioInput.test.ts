import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createGlideStdioInput } from "./stdioInput.ts";

describe("Glide MCP input bounds", () => {
  it("bounds an unterminated fragmented request before SDK parsing", async () => {
    const input = createGlideStdioInput();
    input.resume();
    const error = once(input, "error");
    input.write(Buffer.alloc(512 * 1024, 32));
    input.write(Buffer.alloc(512 * 1024, 32));
    input.write(Buffer.from("x"));
    expect((await error)[0]).toBeInstanceOf(Error);
    input.destroy();
  });
  it("resets the byte allowance only at a real JSONL delimiter", async () => {
    const input = createGlideStdioInput(),
      chunks: Buffer[] = [];
    input.on("data", (chunk: Buffer) => chunks.push(chunk));
    const end = once(input, "end");
    input.write(Buffer.alloc(600 * 1024, 32));
    input.write(Buffer.from("\n"));
    input.end(Buffer.alloc(600 * 1024, 32));
    await end;
    expect(Buffer.concat(chunks).length).toBe(1200 * 1024 + 1);
  });
});
