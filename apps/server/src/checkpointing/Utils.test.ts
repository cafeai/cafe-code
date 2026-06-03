import { describe, expect, it } from "vitest";
import { ProjectId } from "@cafecode/contracts";

import { isGeneratedHiddenCheckpointRef, resolveThreadWorkspaceDirectories } from "./Utils.ts";

describe("isGeneratedHiddenCheckpointRef", () => {
  it("accepts only Cafe-owned hidden checkpoint refs", () => {
    expect(isGeneratedHiddenCheckpointRef("refs/cafe/checkpoints/thread_123-abc/turn/42")).toBe(
      true,
    );
    expect(isGeneratedHiddenCheckpointRef("refs/t3/checkpoints/thread_123-abc/turn/42")).toBe(true);
    expect(isGeneratedHiddenCheckpointRef("provider-diff:evt-1")).toBe(false);
    expect(isGeneratedHiddenCheckpointRef("refs/heads/main")).toBe(false);
    expect(
      isGeneratedHiddenCheckpointRef(
        "refs/cafe/checkpoints/thread/turn/1\n delete refs/heads/main",
      ),
    ).toBe(false);
  });
});

describe("resolveThreadWorkspaceDirectories", () => {
  it("keeps worktree cwd primary and excludes duplicate additional roots", () => {
    const result = resolveThreadWorkspaceDirectories({
      thread: {
        projectId: ProjectId.make("project-1"),
        worktreePath: "/repo-worktree",
      },
      projects: [
        {
          id: ProjectId.make("project-1"),
          workspaceRoot: "/repo",
          additionalWorkspaceRoots: ["/repo-worktree", "/docs", "/docs/"],
        },
      ],
    });

    expect(result).toEqual({
      cwd: "/repo-worktree",
      additionalDirectories: ["/docs"],
    });
  });
});
