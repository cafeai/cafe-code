import { describe, expect, it } from "vitest";

import { diffFileLines, WORKSPACE_OBSERVATORY_DIFF_LIMIT } from "./workspaceObservatoryDiff";

describe("diffFileLines", () => {
  it("reports no change for identical snapshots", () => {
    const diff = diffFileLines("a\nb\n", "a\nb\n");
    expect(diff).toEqual({ changed: false, changes: [], truncated: false });
  });

  it("reports only the edited line for a local change", () => {
    const diff = diffFileLines("a\nb\nc\n", "a\nB\nc\n");
    expect(diff.changed).toBe(true);
    expect(diff.truncated).toBe(false);
    expect(diff.changes).toEqual([{ kind: "changed", line: 2, before: "b", after: "B" }]);
  });

  it("reports an insertion without rewriting the trailing lines", () => {
    const diff = diffFileLines("a\nb\nc\n", "a\nnew\nb\nc\n");
    expect(diff.changes).toEqual([{ kind: "added", line: 2, after: "new" }]);
  });

  it("reports a deletion", () => {
    const diff = diffFileLines("a\nb\nc\n", "a\nc\n");
    expect(diff.changes).toEqual([{ kind: "removed", line: 2, before: "b" }]);
  });

  it("bounds the change list and flags truncation", () => {
    const before = Array.from({ length: 600 }, (_unused, index) => `line ${index}`).join("\n");
    const after = Array.from({ length: 600 }, (_unused, index) => `LINE ${index}`).join("\n");
    const diff = diffFileLines(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.truncated).toBe(true);
    expect(diff.changes).toHaveLength(WORKSPACE_OBSERVATORY_DIFF_LIMIT);
  });
});
