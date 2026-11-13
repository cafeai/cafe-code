import { EnvironmentId, ThreadGroupId, ThreadId } from "@cafecode/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../../types";
import {
  buildSidebarThreadGroupIndex,
  collectSidebarGroupDescendants,
  layoutSidebarThreadGroupRows,
  sidebarCollapsedGroupVisibleMembers,
  sidebarGroupKeysContaining,
  sidebarRootThreadKey,
  sidebarThreadGroupKey,
} from "./threadGroups.logic";

const environmentId = EnvironmentId.make("env");

function summary(id: string, fields: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.make(id),
    environmentId,
    projectId: null,
    title: id,
    interactionMode: "default",
    session: null,
    createdAt: `2026-11-10T00:00:0${id.length % 10}.000Z`,
    archivedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...fields,
  };
}

const groupAt = (id: string, createdAt: string) => ({
  id: ThreadGroupId.make(id),
  title: id,
  createdAt,
});
const key = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
const group = (id: string, title = id) => ({
  id: ThreadGroupId.make(id),
  title,
  createdAt: "2026-11-10T00:00:00.000Z",
});

describe("sidebar thread group index", () => {
  const coordinator = summary("coordinator", { ownedGroups: [group("wave", "Wave")] });
  const a = summary("a", { groupId: ThreadGroupId.make("wave") });
  const b = summary("bb", {
    groupId: ThreadGroupId.make("wave"),
    ownedGroups: [group("sub", "Sub")],
  });
  const c = summary("c", { groupId: ThreadGroupId.make("sub") });
  const unrelated = summary("unrelated");

  it("nests members beneath their parent and omits them from the top level", () => {
    const index = buildSidebarThreadGroupIndex([coordinator, a, b, c, unrelated]);
    expect([...index.nestedThreadKeys].toSorted()).toEqual(
      [key("a"), key("bb"), key("c")].toSorted(),
    );
    const [wave] = index.groupsByOwnerKey.get(key("coordinator"))!;
    expect(wave!.members.map((member) => member.id)).toEqual(["a", "bb"]);
    expect(index.groupsByOwnerKey.get(key("bb"))![0]!.members.map((m) => m.id)).toEqual(["c"]);
    expect(collectSidebarGroupDescendants(index, wave!).map((m) => m.id)).toEqual(["a", "bb", "c"]);
  });

  it("falls back to top level when the parent or group is not shown", () => {
    // Parent archived (absent from the sidebar list) or group no longer live.
    const index = buildSidebarThreadGroupIndex([a, b, c, unrelated]);
    expect(index.nestedThreadKeys.has(key("a"))).toBe(false);
    // c's group owner (b) is visible, so c nests beneath b, now top level.
    expect(index.nestedThreadKeys.has(key("c"))).toBe(true);
  });

  it("never hides chats caught in a malformed cycle", () => {
    const x = summary("x", {
      groupId: ThreadGroupId.make("gy"),
      ownedGroups: [group("gx")],
    });
    const y = summary("y", {
      groupId: ThreadGroupId.make("gx"),
      ownedGroups: [group("gy")],
    });
    const index = buildSidebarThreadGroupIndex([x, y]);
    expect(index.nestedThreadKeys.size).toBe(0);
  });

  it("expands the path to the open chat and pins its top-level parent", () => {
    const index = buildSidebarThreadGroupIndex([coordinator, a, b, c]);
    expect([...sidebarGroupKeysContaining(index, key("c"))].toSorted()).toEqual(
      [
        sidebarThreadGroupKey(environmentId, ThreadGroupId.make("wave")),
        sidebarThreadGroupKey(environmentId, ThreadGroupId.make("sub")),
      ].toSorted(),
    );
    expect(sidebarRootThreadKey(index, key("c"))).toBe(key("coordinator"));
    expect(sidebarRootThreadKey(index, key("unrelated"))).toBe(key("unrelated"));
  });

  it("keeps only the open chat or its path visible in a collapsed group", () => {
    const index = buildSidebarThreadGroupIndex([coordinator, a, b, c, unrelated]);
    const [wave] = index.groupsByOwnerKey.get(key("coordinator"))!;
    const visible = (active: string | null) =>
      sidebarCollapsedGroupVisibleMembers(
        index,
        wave!,
        active === null ? null : key(active),
        sidebarGroupKeysContaining(index, active === null ? null : key(active)),
      ).map((member) => member.id);
    expect(visible("a")).toEqual(["a"]);
    // c lives in bb's nested group, so bb stays visible as the path to it.
    expect(visible("c")).toEqual(["bb"]);
    expect(visible("coordinator")).toEqual([]);
    expect(visible("unrelated")).toEqual([]);
    expect(visible(null)).toEqual([]);
  });

  describe("several groups under one parent chat", () => {
    // ownedGroups and member order deliberately disagree with creation order.
    const orchestrator = summary("orchestrator", {
      ownedGroups: [
        groupAt("third", "2026-11-10T00:00:03.000Z"),
        groupAt("first", "2026-11-10T00:00:01.000Z"),
        groupAt("second", "2026-11-10T00:00:02.000Z"),
      ],
    });
    const inThird = summary("t1", { groupId: ThreadGroupId.make("third") });
    const inFirst = summary("f1", { groupId: ThreadGroupId.make("first") });
    const inSecond = summary("s1", { groupId: ThreadGroupId.make("second") });
    const index = buildSidebarThreadGroupIndex([orchestrator, inThird, inSecond, inFirst]);
    const nodes = index.groupsByOwnerKey.get(key("orchestrator"))!;

    it("renders every group in creation order", () => {
      expect(nodes.map((node) => node.groupId)).toEqual(["first", "second", "third"]);
    });

    const layout = (expanded: boolean[], active: string | null = null) =>
      layoutSidebarThreadGroupRows(
        index,
        nodes,
        expanded,
        active === null ? null : key(active),
      ).map((row) => [row.node.groupId, row.attached, row.visibleMembers.length]);

    it("attaches rows to the parent unless an earlier sibling shows chats", () => {
      expect(layout([false, false, false])).toEqual([
        ["first", true, 0],
        ["second", true, 0],
        ["third", true, 0],
      ]);
      expect(layout([true, false, false])).toEqual([
        ["first", true, 1],
        ["second", false, 0],
        ["third", true, 0],
      ]);
      // A collapsed group that pins the open chat also separates the next row.
      expect(layout([false, false, false], "s1")).toEqual([
        ["first", true, 0],
        ["second", true, 1],
        ["third", false, 0],
      ]);
    });
  });
});
