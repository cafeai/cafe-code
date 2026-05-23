import { describe, expect, it } from "vitest";
import { ProjectId } from "@cafecode/contracts";

import { resolveThreadWorkspaceDirectories } from "./Utils.ts";

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
