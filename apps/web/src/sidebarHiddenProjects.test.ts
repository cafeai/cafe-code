import { MAX_HIDDEN_SIDEBAR_PROJECT_KEYS } from "@cafecode/contracts/settings";
import { describe, expect, it } from "vitest";

import {
  isSidebarProjectHidden,
  nextHiddenSidebarProjectKeys,
  partitionHiddenSidebarProjects,
} from "./sidebarHiddenProjects";

const row = (name: string, ...keys: string[]) => ({
  name,
  memberProjects: keys.map((physicalProjectKey) => ({ physicalProjectKey })),
});

describe("hidden sidebar projects", () => {
  it("hides a grouped row only while every member folder is hidden", () => {
    const hidden = new Set(["env:/repo", "env:/repo-worktree"]);
    expect(isSidebarProjectHidden(row("a", "env:/repo", "env:/repo-worktree"), hidden)).toBe(true);
    // A new worktree joining the group brings the row back.
    expect(
      isSidebarProjectHidden(row("a", "env:/repo", "env:/repo-worktree", "env:/new"), hidden),
    ).toBe(false);
    expect(isSidebarProjectHidden(row("empty"), hidden)).toBe(false);
  });

  it("partitions rows without changing their sorted order", () => {
    const projects = [row("a", "e:/a"), row("b", "e:/b"), row("c", "e:/c"), row("d", "e:/d")];
    const { shown, hidden } = partitionHiddenSidebarProjects(projects, new Set(["e:/b", "e:/d"]));
    expect(shown.map((project) => project.name)).toEqual(["a", "c"]);
    expect(hidden.map((project) => project.name)).toEqual(["b", "d"]);
  });

  it("adds and removes every member key without duplicates", () => {
    const hidden = nextHiddenSidebarProjectKeys({
      current: ["e:/x", "e:/a"],
      memberKeys: ["e:/a", "e:/a-wt"],
      hidden: true,
      prune: null,
    });
    expect(hidden).toEqual(["e:/x", "e:/a", "e:/a-wt"]);
    expect(
      nextHiddenSidebarProjectKeys({
        current: hidden,
        memberKeys: ["e:/a", "e:/a-wt"],
        hidden: false,
        prune: null,
      }),
    ).toEqual(["e:/x"]);
  });

  it("prunes only removed projects of a fully loaded workspace", () => {
    const current = ["e:/gone", "e:/kept", "other:/gone-elsewhere"];
    expect(
      nextHiddenSidebarProjectKeys({
        current,
        memberKeys: ["e:/new"],
        hidden: true,
        prune: { environmentId: "e", knownKeys: new Set(["e:/kept", "e:/new"]) },
      }),
    ).toEqual(["e:/kept", "other:/gone-elsewhere", "e:/new"]);
    // Without a complete catalog nothing is pruned.
    expect(
      nextHiddenSidebarProjectKeys({ current, memberKeys: [], hidden: false, prune: null }),
    ).toEqual(current);
  });

  it("drops the oldest entries at the saved-list bound", () => {
    const current = Array.from({ length: MAX_HIDDEN_SIDEBAR_PROJECT_KEYS }, (_, i) => `e:/p${i}`);
    const next = nextHiddenSidebarProjectKeys({
      current,
      memberKeys: ["e:/newest"],
      hidden: true,
      prune: null,
    });
    expect(next).toHaveLength(MAX_HIDDEN_SIDEBAR_PROJECT_KEYS);
    expect(next[0]).toBe("e:/p1");
    expect(next.at(-1)).toBe("e:/newest");
  });
});
