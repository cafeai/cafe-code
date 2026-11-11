import {
  EnvironmentId,
  ThreadGroupId,
  ThreadId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import { collectDeletedThreadGroupEntries } from "./deletedThreadGroups";

const environmentId = EnvironmentId.make("env");
const CASCADE = "2026-11-10T01:00:00.000Z";
const LATER = "2026-11-10T02:00:00.000Z";

function shell(id: string, groupId: string | null, deletedAt: string) {
  return {
    id: ThreadId.make(id),
    groupId: groupId ? ThreadGroupId.make(groupId) : null,
    deletedAt,
  } as unknown as OrchestrationThreadShell;
}

describe("Recycle Bin group entries", () => {
  it("lists one entry per deleted group with its same-batch subtree", () => {
    const snapshot = {
      snapshotSequence: 1,
      projects: [],
      updatedAt: CASCADE,
      threads: [
        shell("a", "wave", CASCADE),
        shell("b", "wave", CASCADE),
        shell("c", "sub", CASCADE),
        // Deleted again later on its own: not part of this group's batch.
        shell("e", "wave", LATER),
      ],
      deletedThreadGroups: [
        {
          id: ThreadGroupId.make("wave"),
          ownerThreadId: ThreadId.make("p"),
          title: "Wave",
          deletedAt: CASCADE,
        },
        {
          id: ThreadGroupId.make("sub"),
          ownerThreadId: ThreadId.make("b"),
          title: "Sub",
          deletedAt: CASCADE,
        },
      ],
    } as OrchestrationShellSnapshot;
    const entries = collectDeletedThreadGroupEntries([{ environmentId, snapshot }]);
    // The nested group is reached through its parent entry, not listed again.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      group: { id: "wave" },
      threadIds: ["a", "b", "c"],
      nestedGroupCount: 1,
    });
  });
});
