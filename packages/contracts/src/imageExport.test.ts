import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  MAX_PNG_BYTES,
  MAX_PNG_DIMENSION,
  MAX_PNG_PIXELS,
  PngBytesSchema,
  SavePngInputSchema,
  SavePngResultSchema,
} from "./imageExport.ts";

describe("image export capability contracts", () => {
  it("bounds typed PNG bytes independently from their renderer MIME label", () => {
    const decode = Schema.decodeUnknownSync(PngBytesSchema);
    const bytes = new Uint8Array([137, 80, 78, 71]);
    expect(decode(bytes)).toBe(bytes);
    expect(() => decode("data:image/png;base64,private")).toThrow();
    expect(() => decode([137, 80, 78, 71])).toThrow();
    expect(() => decode(new Uint8Array(0))).toThrow();
    const oversizedBytes = new Uint8Array(MAX_PNG_BYTES + 1);
    const oversizedResult = Schema.decodeUnknownResult(PngBytesSchema)(oversizedBytes);
    // Keep the real one-byte-over-limit parser rejection, but inspect only
    // bounded issue metadata. Effect's synchronous throwing wrapper eagerly
    // formats its Error message by stringifying the entire rejected typed array,
    // unnecessarily rendering 32 MiB of pixels under the test deadline. The
    // Result API runs the same parser without that diagnostic formatting step.
    // Boolean identity assertions also keep an unexpected failure from dumping
    // the payload while still binding this issue to the exact oversized input.
    expect(Result.isFailure(oversizedResult)).toBe(true);
    if (Result.isFailure(oversizedResult)) {
      expect(oversizedResult.failure._tag).toBe("Composite");
      if (oversizedResult.failure._tag === "Composite") {
        expect(oversizedResult.failure.issues.length).toBe(1);
        const issue = oversizedResult.failure.issues[0];
        expect(issue?._tag).toBe("Filter");
        if (issue?._tag === "Filter") {
          expect(issue.actual === oversizedBytes).toBe(true);
        }
      }
    }
    expect(MAX_PNG_BYTES).toBe(32 * 1024 * 1024);
    expect(MAX_PNG_DIMENSION).toBe(8192);
    expect(MAX_PNG_PIXELS).toBe(16_777_216);
  });

  it("accepts only a default PNG basename and finite save outcomes", () => {
    const decode = Schema.decodeUnknownSync(SavePngInputSchema);
    const png = new Uint8Array([137, 80, 78, 71]);
    expect(decode({ png, suggestedName: "mermaid-diagram.png" })).toEqual({
      png,
      suggestedName: "mermaid-diagram.png",
    });
    for (const suggestedName of [
      "../private.png",
      "C:\\private.png",
      "/private.png",
      "image.svg",
      "image\u0000.png",
    ])
      expect(() => decode({ png, suggestedName })).toThrow();
    const result = Schema.decodeUnknownSync(SavePngResultSchema);
    for (const outcome of ["saved", "cancelled", "failed"]) expect(result(outcome)).toBe(outcome);
    expect(() => result("/private/saved-file.png")).toThrow();
  });
});
