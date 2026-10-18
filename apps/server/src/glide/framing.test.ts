import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readGlideFrames, writeGlideFrame } from "./framing.ts";
import { GLIDE_FRAME_BYTES } from "./protocol.ts";

async function collect(input: Readable) {
  const result: unknown[] = [];
  for await (const message of readGlideFrames(input)) result.push(message);
  return result;
}
function frame(body: Buffer) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
describe("Glide framed IPC", () => {
  it("preserves fragmented Unicode JSON and multiple adjacent frames", async () => {
    const bytes = Buffer.concat([
      frame(Buffer.from(JSON.stringify({ text: "café 👩‍💻" }))),
      frame(Buffer.from("null")),
    ]);
    expect(await collect(Readable.from(Array.from(bytes, (byte) => Buffer.from([byte]))))).toEqual([
      { text: "café 👩‍💻" },
      null,
    ]);
  });
  it("rejects oversized, truncated and malformed UTF-8 frames", async () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(GLIDE_FRAME_BYTES + 1);
    await expect(collect(Readable.from([oversized]))).rejects.toThrow("size");
    await expect(collect(Readable.from([Buffer.from([0, 0, 0, 3, 123])]))).rejects.toThrow(
      "Incomplete",
    );
    await expect(collect(Readable.from([frame(Buffer.from([0xff]))]))).rejects.toThrow();
  });
  it("writes and reads the same bounded wire format", async () => {
    const pipe = new PassThrough();
    const result = collect(pipe);
    await writeGlideFrame(pipe, { id: 1, text: "hello" });
    pipe.end();
    expect(await result).toEqual([{ id: 1, text: "hello" }]);
  });
});
