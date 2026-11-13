import { expect, it, type TestContext } from "vitest";
import * as Effect from "effect/Effect";
import { RelayError } from "@cafecode/relay/errors";
import type { RelayStream } from "@cafecode/relay/session";
import { encodeInner, INNER } from "@cafecode/relay/protocol";
import { relayEffectSocket } from "./request.ts";

function ownRpcStream(context: TestContext) {
  let active = true;
  const cancellation = new AbortController();
  let releaseRead: ((value: undefined) => void) | undefined;
  let pending: Promise<void> | undefined;
  const chunks: Uint8Array[] = [];
  let writes = 0,
    maximumWrites = 0;
  const retire = () => {
    active = false;
    cancellation.abort();
    releaseRead?.(undefined);
  };
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(async () => {
    retire();
    await pending?.catch(() => {});
    context.signal.removeEventListener("abort", retire);
  });
  const stream = {
    signal: cancellation.signal,
    read: () =>
      active
        ? new Promise<undefined>((resolve) => {
            releaseRead = resolve;
          })
        : Promise.resolve(undefined),
    write: async (bytes: Uint8Array) => {
      if (!active) throw new RelayError("INCOMPLETE");
      maximumWrites = Math.max(maximumWrites, ++writes);
      try {
        chunks.push(bytes.slice());
        await Promise.resolve();
      } finally {
        writes--;
      }
    },
    finish: async () => {},
    retire,
  } as unknown as RelayStream;
  return {
    chunks,
    get maximumWrites() {
      return maximumWrites;
    },
    run: (bytes: Uint8Array) =>
      (pending = Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const socket = yield* relayEffectSocket(stream);
            const write = yield* socket.writer;
            yield* socket.run(() => {}).pipe(Effect.forkScoped);
            yield* write(bytes);
          }),
        ),
      )),
  };
}

it("streams large RPC snapshots byte-for-byte with bounded sequential writes and little padding overhead", async (context) => {
  const owned = ownRpcStream(context);
  const bytes = new TextEncoder().encode(
    JSON.stringify({ message: "café ☕ 🌐\n".repeat(8_000) }) + "\n",
  );
  await owned.run(bytes);
  const output = new Uint8Array(bytes.length);
  let offset = 0,
    wireBytes = 0;
  for (const chunk of owned.chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
    wireBytes += encodeInner(INNER.DATA, 1, chunk).byteLength;
  }
  expect(output).toEqual(bytes);
  expect(offset).toBe(bytes.length);
  expect(owned.maximumWrites).toBe(1);
  expect(wireBytes).toBeLessThan(bytes.length * 1.1);
});
