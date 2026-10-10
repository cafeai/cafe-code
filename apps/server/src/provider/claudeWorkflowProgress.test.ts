import { describe, expect, it } from "vitest";
import {
  claudeWorkflowLabel,
  decodeClaudeWorkflowProgress,
  supportsClaudeWorkflowProgress,
} from "./claudeWorkflowProgress.ts";

describe("received Claude workflow snapshots", () => {
  it.each([null, undefined, "2.1.287", "2.1.288-beta.1", "2.2.0-beta.1", "bad", "2".repeat(65)])(
    "does not qualify unknown, old or prerelease runtime %j",
    (version) => {
      expect(supportsClaudeWorkflowProgress(version)).toBe(false);
    },
  );
  it.each(["2.1.288", "2.1.289", "2.2.0"])("qualifies stable runtime %s", (version) => {
    expect(supportsClaudeWorkflowProgress(version)).toBe(true);
  });
  it("copies only public bounded fields and does not invent missing counters/status", () => {
    expect(
      decodeClaudeWorkflowProgress([
        { type: "workflow_phase", index: 1, title: "Attack", kind: "parallel", prompt: "private" },
        {
          type: "workflow_agent",
          index: 1,
          phaseIndex: 1,
          label: "Geometry",
          model: "Fable 5.1",
          fallbackModel: "Sonnet 5",
          state: "error",
          tokens: 0,
          durationMs: 42,
          promptPreview: "private",
          error: "secret",
          agentId: "opaque",
          lastToolSummary: "/private/tool",
        },
        { type: "workflow_agent", index: 2, state: "future", tokens: -1, durationMs: Infinity },
      ]),
    ).toEqual({
      phases: [{ index: 1, title: "Attack", kind: "parallel" }],
      agents: [
        {
          index: 1,
          phaseIndex: 1,
          label: "Geometry",
          model: "Fable 5.1",
          fallbackModel: "Sonnet 5",
          status: "failed",
          totalTokens: 0,
          durationMs: 42,
        },
        { index: 2 },
      ],
      truncated: false,
    });
  });
  it.each([
    undefined,
    null,
    {},
    [null],
    [{ type: "workflow_agent", index: 0 }],
    [{ type: "workflow_agent", index: 10_001 }],
    [{ type: "workflow_agent", index: 1.5 }],
    [{ type: "workflow_log", index: 1 }],
    [
      { type: "workflow_agent", index: 1 },
      { type: "workflow_agent", index: 1 },
    ],
    Array.from({ length: 513 }, (_, index) => ({ type: "workflow_agent", index: index + 1 })),
  ])("rejects malformed or excessive envelope %j without clearing prior evidence", (input) => {
    expect(decodeClaudeWorkflowProgress(input)).toBeUndefined();
  });
  it("retains a finite prefix with an explicit truncation notice and admits explicit empty replacement", () => {
    const rows = Array.from({ length: 129 }, (_, index) => ({
      type: "workflow_agent",
      index: index + 1,
    }));
    const result = decodeClaudeWorkflowProgress(rows);
    expect(result?.agents).toHaveLength(128);
    expect(result?.truncated).toBe(true);
    expect(decodeClaudeWorkflowProgress([])).toEqual({ phases: [], agents: [], truncated: false });
  });
  it("does not evaluate accessor fields or trust inherited identity", () => {
    let reads = 0;
    const row = {
      type: "workflow_agent",
      index: 1,
      get label() {
        reads++;
        throw new Error("private");
      },
    };
    expect(decodeClaudeWorkflowProgress([row])).toEqual({
      phases: [],
      agents: [{ index: 1 }],
      truncated: false,
    });
    expect(reads).toBe(0);
    expect(
      decodeClaudeWorkflowProgress([Object.create({ type: "workflow_agent", index: 1 })]),
    ).toBeUndefined();
    expect(
      decodeClaudeWorkflowProgress([
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("private");
            },
          },
        ),
      ]),
    ).toBeUndefined();
  });
  it.each([
    "\nAttack",
    "Attack\u202e",
    "/private/workflow/log",
    "C:\\private\\workflow",
    "https://example.com",
    "token=private",
    "Bearer private",
    "sk-abcdefghijkl",
    "x".repeat(241),
  ])("drops unsafe display label %j", (label) => {
    expect(claudeWorkflowLabel(label)).toBeUndefined();
  });
  it("canonicalizes ordinary whitespace but preserves no opaque sibling", () => {
    expect(claudeWorkflowLabel("  Geometry   attack  ")).toBe("Geometry attack");
  });
});
