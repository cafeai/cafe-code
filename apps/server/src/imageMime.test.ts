import { describe, expect, it } from "vitest";

import { inferImageExtension, parseBase64DataUrl } from "./imageMime.ts";

describe("imageMime", () => {
  const dataUrlScenarios = [
    {
      name: "parses base64 data URL with mime type",
      input: "data:image/png;base64,SGVsbG8=",
      expected: { mimeType: "image/png", base64: "SGVsbG8=" },
    },
    {
      name: "parses base64 data URL with mime parameters",
      input: "data:image/png;charset=utf-8;base64,SGVsbG8=",
      expected: { mimeType: "image/png", base64: "SGVsbG8=" },
    },
    {
      name: "rejects non-base64 data URL",
      input: "data:image/png;charset=utf-8,hello",
      expected: null,
    },
    {
      name: "rejects missing mime type",
      input: "data:;base64,SGVsbG8=",
      expected: null,
    },
    {
      name: "parses base64 data URL with spaces in payload",
      input: "data:image/png;base64,SGVs bG8=\n",
      expected: { mimeType: "image/png", base64: "SGVsbG8=" },
    },
  ] as const;

  for (const scenario of dataUrlScenarios) {
    it(scenario.name, () => {
      expect(parseBase64DataUrl(scenario.input)).toEqual(scenario.expected);
    });
  }

  it("does not read inherited keys from mime extension map", () => {
    expect(inferImageExtension({ mimeType: "constructor" })).toBe(".bin");
  });
});
