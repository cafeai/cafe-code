import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import source from "./eventModelingSvgLabels.js?raw";

interface Boundary {
  cafeMermaidEventModelingSvgLabels: (value: unknown) => string;
}

function boundary() {
  const result = {} as Boundary;
  let documentReads = 0;
  const realm = {
    globalThis: result,
    TextEncoder,
    get document(): never {
      documentReads++;
      throw new Error("Unexpected DOM access in early admission");
    },
  };
  new Script(source, { filename: "eventModelingSvgLabels.js" }).runInNewContext(realm, {
    timeout: 1000,
  });
  return { convert: result.cafeMermaidEventModelingSvgLabels, documentReads: () => documentReads };
}

describe("event-modeling label conversion early boundary", () => {
  // Native HTML parsing, exact geometry/markup, immutable labels, and raster
  // output are qualified with the real opaque browser pipeline. These Node
  // checks separately prove byte/entity admission precedes ANY DOM access.
  it.each([
    undefined,
    null,
    1,
    {},
    "\u0000",
    "<!DOCTYPE svg><svg/>",
    "<!ENTITY private SYSTEM 'file:///private'>",
  ])("refuses malformed input before parsing %j", (value) => {
    const test = boundary();
    expect(() => test.convert(value)).toThrow();
    expect(test.documentReads()).toBe(0);
  });

  it("counts the UTF-8 byte bound separately from JavaScript character length", () => {
    const test = boundary();
    expect(() => test.convert("界".repeat(699051))).toThrow();
    expect(test.documentReads()).toBe(0);
  });

  it("refuses oversized ASCII input before parsing", () => {
    const test = boundary();
    expect(() => test.convert("a".repeat(2097153))).toThrow();
    expect(test.documentReads()).toBe(0);
  });
});
