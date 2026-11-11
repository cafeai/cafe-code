import { EnvironmentId, ThreadGroupId, ThreadId } from "@cafecode/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import { describe, expect, it } from "vitest";

import type { SidebarThreadSummary } from "../../types";
import {
  buildSidebarThreadGroupIndex,
  collectSidebarGroupDescendants,
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
});
