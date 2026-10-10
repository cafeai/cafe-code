import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { RuntimeWorkflowPresentation } from "./providerRuntime.ts";

const decode = Schema.decodeUnknownSync(RuntimeWorkflowPresentation);
const provenance = {
  runtimeId: "bdece619-7c30-4212-8b8d-bb546568e42e",
  providerInstanceId: "claude-a",
};

describe("workflow presentation contract", () => {
  it("retains exact provenance and bounded received data", () => {
    const input = {
      ...provenance,
      name: "Geometry",
      phases: [{ index: 1, title: "Attack" }],
      agents: [
        {
          index: 1,
          phaseIndex: 1,
          label: "Agent A",
          model: "Fable 5.1",
          status: "completed",
          totalTokens: Number.MAX_SAFE_INTEGER,
          durationMs: 0,
        },
      ],
      truncated: false,
    };
    expect(decode(input)).toEqual(input);
    expect(decode(provenance)).toEqual(provenance);
  });
  it.each([
    { phases: [] },
    { agents: [] },
    { phases: [{ index: 1 }, { index: 1 }], agents: [] },
    { phases: [], agents: [{ index: 1 }, { index: 1 }] },
    {
      phases: Array.from({ length: 64 }, (_, i) => ({ index: i + 1 })),
      agents: Array.from({ length: 65 }, (_, i) => ({ index: i + 1 })),
    },
    { phases: [], agents: [{ index: 0 }] },
    { phases: [], agents: [{ index: 1, totalTokens: Number.MAX_SAFE_INTEGER + 1 }] },
    { phases: [], agents: [{ index: 1, durationMs: -1 }] },
    { phases: [], agents: [{ index: 1, status: "invented" }] },
  ])("rejects incomplete, ambiguous or excessive snapshot %j", (snapshot) => {
    expect(() => decode({ ...provenance, ...snapshot })).toThrow();
  });
  it.each([
    "",
    " Name",
    "Name ",
    "\nName",
    "Name\u202e",
    "/private/path",
    "C:\\private\\path",
    "https://example.com",
    "secret=value",
    "x".repeat(241),
  ])("rejects unsafe canonical label %j before whitespace normalization", (name) => {
    expect(() => decode({ ...provenance, name })).toThrow();
  });
});
