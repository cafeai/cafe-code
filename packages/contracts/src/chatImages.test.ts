import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { CHAT_IMAGE_MAX_BYTES, ChatImageMetadata } from "./chatImages.ts";

it("accepts inclusive image bounds and rejects zero, oversized and fractional metadata", () => {
  const decode = Schema.decodeUnknownSync(ChatImageMetadata);
  const minimum = {
    source: "fixture.png",
    mimeType: "image/png",
    width: 1,
    height: 1,
    sizeBytes: 1,
  };
  expect(decode(minimum)).toEqual(minimum);
  const maximum = { ...minimum, width: 16_384, height: 16_384, sizeBytes: CHAT_IMAGE_MAX_BYTES };
  expect(decode(maximum)).toEqual(maximum);
  for (const [key, maximumValue] of [
    ["width", 16_384],
    ["height", 16_384],
    ["sizeBytes", CHAT_IMAGE_MAX_BYTES],
  ] as const) {
    for (const value of [0, -1, 1.5, maximumValue + 1])
      expect(() => decode({ ...minimum, [key]: value })).toThrow();
  }
});
