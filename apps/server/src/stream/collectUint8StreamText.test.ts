import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { collectUint8StreamText, decodeCollectedText } from "./collectUint8StreamText.ts";

const encoder = new TextEncoder();

describe("collectUint8StreamText", () => {
  it.effect("collects Uint8Array chunks into decoded text", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("hello "), encoder.encode("world")),
      });

      assert.deepStrictEqual(result, {
        text: "hello world",
        bytes: 11,
        truncated: false,
      });
    }),
  );

  it.effect("truncates by bytes and appends an optional marker once", () =>
    Effect.gen(function* () {
      const result = yield* collectUint8StreamText({
        stream: Stream.make(encoder.encode("abcdef"), encoder.encode("ghij")),
        maxBytes: 5,
        truncatedMarker: "[truncated]",
      });

      assert.deepStrictEqual(result, {
        text: "abcde[truncated]",
        bytes: 5,
        truncated: true,
      });
    }),
  );

  it("keeps valid UTF-8 output on Windows", () => {
    assert.strictEqual(
      decodeCollectedText(Buffer.from("hello", "utf8"), { platform: "win32" }),
      "hello",
    );
  });

  it("falls back to Japanese Windows text decoding for invalid UTF-8", () => {
    const shiftJisErrorText = Buffer.from([0x83, 0x47, 0x83, 0x89, 0x81, 0x5b]);

    assert.strictEqual(
      decodeCollectedText(shiftJisErrorText, {
        platform: "win32",
        locale: "ja-JP",
      }),
      "\u30a8\u30e9\u30fc",
    );
  });
});
