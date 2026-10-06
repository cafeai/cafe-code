import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@cafecode/contracts";
import { scopeThreadRef, scopedThreadKey } from "@cafecode/client-runtime";
import { describe, expect, it } from "vitest";
import type { SidebarThreadSummary } from "../../types";
import { buildStandaloneCatalog, groupThreadHistory } from "./standaloneNavigation.logic";

const local = EnvironmentId.make("local-fixture");
const remote = EnvironmentId.make("remote-fixture");
const projectId = ProjectId.make("project-1");
const createdAt = "2026-10-01T01:00:00.000Z";

function thread(id: string, overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId: local,
    projectId: null,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt,
    archivedAt: null,
    updatedAt: createdAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}
function snapshot(
  threads: readonly SidebarThreadSummary[],
  withProject = false,
): OrchestrationShellSnapshot {
  // This grouping test consumes only shell routing/time fields, not chat detail.
  return {
    projects: withProject
      ? [{ id: projectId, title: "Fixture project", workspaceRoot: "/fixture" }]
      : [],
    threads,
  } as unknown as OrchestrationShellSnapshot;
}

describe("standalone shell catalog", () => {
  it("keeps projectless saved chats distinct across environments and excludes archived/project rows", () => {
    const rows = buildStandaloneCatalog({
      threads: [
        thread("same"),
        thread("same", { environmentId: remote }),
        thread("project", { projectId }),
        thread("archived", { archivedAt: createdAt }),
      ],
      sortOrder: "updated_at",
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.key))).toEqual(
      new Set([
        scopedThreadKey(scopeThreadRef(local, ThreadId.make("same"))),
        scopedThreadKey(scopeThreadRef(remote, ThreadId.make("same"))),
      ]),
    );
  });
  it("uses the existing last-user-message order and actual timestamp offsets", () => {
    const rows = buildStandaloneCatalog({
      threads: [
        thread("activity", {
          latestUserMessageAt: "2026-10-02T01:00:00.000Z",
          updatedAt: "2026-10-03T01:00:00.000Z",
        }),
        thread("created", {
          createdAt: "2026-10-02T02:00:00.000Z",
          updatedAt: "2026-10-02T02:00:00.000Z",
        }),
        thread("newest", { updatedAt: "2026-10-02T12:00:00+09:00" }),
      ],
      sortOrder: "updated_at",
    });
    expect(rows.map((row) => row.thread.id)).toEqual(["newest", "created", "activity"]);
  });
});

describe("standalone archive/recycle-bin grouping", () => {
  it("groups projectless saved history without fake projects or cross-environment id collisions", () => {
    const groups = groupThreadHistory(
      [
        {
          environmentId: local,
          snapshot: snapshot([thread("same"), thread("project", { projectId })], true),
        },
        { environmentId: remote, snapshot: snapshot([thread("same", { environmentId: remote })]) },
      ],
      "archived",
    );
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => [group.environmentId, group.project?.name ?? "Chats"])).toEqual([
      [local, "Chats"],
      [local, "Fixture project"],
      [remote, "Chats"],
    ]);
    expect(new Set(groups.map((group) => group.groupKey)).size).toBe(3);
    expect(groups.flatMap((group) => group.threads).map((row) => row.environmentId)).toEqual([
      local,
      local,
      remote,
    ]);
  });
  it("sorts archive and deletion dates independently and does not relabel missing real projects", () => {
    const first = {
      ...thread("one"),
      archivedAt: "2026-10-02T00:00:00Z",
      deletedAt: "2026-10-01T00:00:00Z",
    };
    const second = {
      ...thread("two"),
      archivedAt: "2026-10-01T00:00:00Z",
      deletedAt: "2026-10-03T00:00:00Z",
    };
    const snapshots = [
      {
        environmentId: local,
        snapshot: snapshot([first, second, thread("missing", { projectId })]),
      },
    ];
    expect(groupThreadHistory(snapshots, "archived")[0]?.threads.map((row) => row.id)).toEqual([
      "one",
      "two",
    ]);
    expect(groupThreadHistory(snapshots, "deleted")[0]?.threads.map((row) => row.id)).toEqual([
      "two",
      "one",
    ]);
  });
});
