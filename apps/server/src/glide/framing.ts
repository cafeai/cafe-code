import type { Readable, Writable } from "node:stream";
import { GLIDE_FRAME_BYTES } from "./protocol.ts";

/** Length-prefixed UTF-8 JSON is shared by the kernel and native helper. Read a
 * bounded body once instead of repeatedly concatenating fragmented images. */
export async function* readGlideFrames(input: Readable): AsyncGenerator<unknown> {
  let header = Buffer.alloc(4);
  let used = 0;
  let body: Buffer | undefined;
  for await (const chunk of input) {
    const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const destination = body ?? header;
      const length = Math.min(destination.length - used, bytes.length - offset);
      bytes.copy(destination, used, offset, offset + length);
      used += length;
      offset += length;
      if (used !== destination.length) continue;
      if (!body) {
        const size = header.readUInt32BE();
        if (size < 1 || size > GLIDE_FRAME_BYTES) throw new Error("Invalid glide frame size.");
        body = Buffer.alloc(size);
      } else {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
        yield JSON.parse(text) as unknown;
        body = undefined;
        header = Buffer.alloc(4);
      }
      used = 0;
    }
  }
  if (body || used) throw new Error("Incomplete glide frame.");
}

export async function writeGlideFrame(output: Writable, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value));
  if (!body.length || body.length > GLIDE_FRAME_BYTES) throw new Error("Glide frame is too large.");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  await new Promise<void>((resolve, reject) =>
    output.write(Buffer.concat([header, body]), (error) => (error ? reject(error) : resolve())),
  );
}
