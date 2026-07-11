import type { ChangeRequest } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { selectLatestPullRequest } from "./GitPullRequestSelection.ts";

const changeRequest = (
  number: number,
  state: ChangeRequest["state"],
  updatedAt: string,
  overrides: Partial<ChangeRequest> = {},
): ChangeRequest => ({
  provider: "github",
  number,
  title: `${state} PR ${number}`,
  url: `https://github.com/cafeai/cafe-code/pull/${number}`,
  baseRefName: "main",
  headRefName: "feature/status",
  state,
  updatedAt: Option.some(DateTime.makeUnsafe(updatedAt)),
  ...overrides,
});

const headContext = {
  headBranch: "feature/status",
  headRepositoryNameWithOwner: "cafeai/cafe-code",
  headRepositoryOwnerLogin: "cafeai",
  isCrossRepository: false,
} as const;

describe("selectLatestPullRequest", () => {
  it("returns the newest terminal PR when no open PR remains", () => {
    const selected = selectLatestPullRequest(
      [
        changeRequest(16, "closed", "2026-01-01T00:00:00.000Z"),
        changeRequest(17, "merged", "2026-01-02T00:00:00.000Z"),
      ],
      headContext,
    );

    expect(selected).toMatchObject({ number: 17, state: "merged" });
  });

  it("prefers an actionable open PR over a newer merged PR", () => {
    const selected = selectLatestPullRequest(
      [
        changeRequest(45, "merged", "2026-02-01T10:00:00.000Z"),
        changeRequest(46, "open", "2026-01-30T10:00:00.000Z"),
      ],
      headContext,
    );

    expect(selected).toMatchObject({ number: 46, state: "open" });
  });

  it("ignores PRs for other branches and repository owners", () => {
    const selected = selectLatestPullRequest(
      [
        changeRequest(40, "open", "2026-02-02T10:00:00.000Z", {
          headRefName: "feature/other",
        }),
        changeRequest(41, "open", "2026-02-01T10:00:00.000Z", {
          isCrossRepository: true,
          headRepositoryNameWithOwner: "someone/cafe-code",
          headRepositoryOwnerLogin: "someone",
        }),
        changeRequest(42, "open", "2026-01-31T10:00:00.000Z"),
      ],
      headContext,
    );

    expect(selected).toMatchObject({ number: 42 });
  });
});
