import {
  CommandId,
  ClientOrchestrationCommand,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MAX_THREAD_GROUP_DEPTH,
  ProjectId,
  ProviderInstanceId,
  ThreadGroupId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadProvenance,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-11-10T00:00:00.000Z";
const tid = (value: string) => ThreadId.make(value);
const gid = (value: string) => ThreadGroupId.make(value);
const cid = (value: string) => CommandId.make(value);

let sequence = 0;
let commandCounter = 0;

/** Decide and project a command, as the serialized engine does. */
async function apply(
  model: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<{ model: OrchestrationReadModel; events: OrchestrationEvent[] }> {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: model }),
  );
  const planned = Array.isArray(decided) ? decided : [decided];
  let next = model;
  const events: OrchestrationEvent[] = [];
  for (const event of planned) {
    sequence += 1;
    const saved = { ...event, sequence } as OrchestrationEvent;
    events.push(saved);
    next = await Effect.runPromise(projectEvent(next, saved));
  }
  return { model: next, events };
}

async function refuse(model: OrchestrationReadModel, command: OrchestrationCommand) {
  await expect(
    Effect.runPromise(decideOrchestrationCommand({ command, readModel: model })),
  ).rejects.toThrow();
}

const nextCommandId = () => cid(`cmd-${++commandCounter}`);

const MCP_PROVENANCE: ThreadProvenance = {
  creationPath: "mcp-launch",
  originThreadId: tid("coordinator"),
  recordedAt: NOW,
};

function createThread(
  threadId: string,
  extra: Partial<Extract<OrchestrationCommand, { type: "thread.create" }>> = {},
): OrchestrationCommand {
  return {
    type: "thread.create",
    commandId: nextCommandId(),
    threadId: tid(threadId),
    projectId: ProjectId.make("project"),
    title: threadId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    ...extra,
  };
}

function createGroup(
  groupId: string,
  ownerThreadId: string,
  title = groupId,
): OrchestrationCommand {
  return {
    type: "thread.group.create",
    commandId: nextCommandId(),
    groupId: gid(groupId),
    ownerThreadId: tid(ownerThreadId),
    title,
    provenance: { creationPath: "mcp-launch", attribution: "launch-claim", recordedAt: NOW },
    createdAt: NOW,
  };
}

async function seed(): Promise<OrchestrationReadModel> {
  let model = createEmptyReadModel(NOW);
  model = (
    await apply(model, {
      type: "project.create",
      commandId: nextCommandId(),
      projectId: ProjectId.make("project"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      createdAt: NOW,
    } as OrchestrationCommand)
  ).model;
  return (await apply(model, createThread("coordinator"))).model;
}

/** coordinator → wave(a, b → sub(c)) and a sibling group other(d). */
async function seedTree() {
  let model = await seed();
  for (const command of [
    createGroup("wave", "coordinator", "Wave"),
    createGroup("other", "coordinator", "Other"),
    createThread("a", { groupId: gid("wave"), provenance: MCP_PROVENANCE }),
    createThread("b", { groupId: gid("wave"), provenance: MCP_PROVENANCE }),
    createGroup("sub", "b", "Sub"),
    createThread("c", { groupId: gid("sub"), provenance: MCP_PROVENANCE }),
    createThread("d", { groupId: gid("other"), provenance: MCP_PROVENANCE }),
  ]) {
    model = (await apply(model, command)).model;
  }
  return model;
}

const thread = (model: OrchestrationReadModel, id: string) =>
  model.threads.find((entry) => entry.id === id)!;
const group = (model: OrchestrationReadModel, id: string) =>
  model.threadGroups!.find((entry) => entry.id === id)!;

describe("thread groups", () => {
  it("records server provenance and a derived origin label on creation", async () => {
    const model = await seedTree();
    expect(thread(model, "a")).toMatchObject({
      groupId: "wave",
      provenance: { creationPath: "mcp-launch", originThreadId: "coordinator" },
      origin: { classification: "agent", source: "recorded" },
    });
    // No provenance means unrecorded: no guessed label.
    expect(thread(model, "coordinator").origin).toBeUndefined();
  });

  it("keeps group creation out of the client command schema", () => {
    const decode = Schema.decodeUnknownExit(ClientOrchestrationCommand);
    expect(
      decode({
        type: "thread.group.create",
        commandId: "client-cmd",
        groupId: "g",
        ownerThreadId: "coordinator",
        title: "x",
        provenance: { creationPath: "mcp-launch", attribution: "launch-claim", recordedAt: NOW },
        createdAt: NOW,
      })._tag,
    ).toBe("Failure");
  });

  it("deletes a group's whole subtree but keeps the parent and sibling groups", async () => {
    const before = await seedTree();
    const { model, events } = await apply(before, {
      type: "thread.group.delete",
      commandId: cid("delete-wave"),
      groupId: gid("wave"),
    });
    expect(
      events.filter((event) => event.type === "thread.deleted").map((e) => e.aggregateId),
    ).toEqual(["a", "b", "c"]);
    expect(events.filter((event) => event.type === "thread.group-deleted").length).toBe(2);
    expect(thread(model, "coordinator").deletedAt).toBeNull();
    expect(thread(model, "d").deletedAt).toBeNull();
    expect(group(model, "other").deletedAt).toBeNull();
    for (const id of ["a", "b", "c"]) expect(thread(model, id).deletionId).toBe("delete-wave");
  });

  it("refuses a worker created after its group was deleted, and captures one created before", async () => {
    let model = await seedTree();
    model = (await apply(model, createThread("early", { groupId: gid("wave") }))).model;
    model = (
      await apply(model, {
        type: "thread.group.delete",
        commandId: cid("del"),
        groupId: gid("wave"),
      })
    ).model;
    expect(thread(model, "early").deletedAt).not.toBeNull();
    await refuse(model, createThread("late", { groupId: gid("wave") }));
  });

  it("cascades a parent delete through its groups with one deletion incarnation", async () => {
    const { model } = await apply(await seedTree(), {
      type: "thread.delete",
      commandId: cid("delete-coordinator"),
      threadId: tid("coordinator"),
    });
    for (const id of ["coordinator", "a", "b", "c", "d"])
      expect(thread(model, id).deletionId).toBe("delete-coordinator");
    for (const id of ["wave", "other", "sub"])
      expect(group(model, id).deletionId).toBe("delete-coordinator");
  });

  it("restores only the chosen group's subtree at the matching incarnation", async () => {
    let model = (
      await apply(await seedTree(), {
        type: "thread.delete",
        commandId: cid("delete-coordinator"),
        threadId: tid("coordinator"),
      })
    ).model;
    // The parent must come back first.
    await refuse(model, {
      type: "thread.group.restore",
      commandId: cid("r0"),
      groupId: gid("wave"),
    });
    // Restoring the parent alone, then re-deleting and restoring one member,
    // gives that member a newer incarnation.
    model = (
      await apply(model, {
        type: "thread.restore",
        commandId: cid("r1"),
        threadId: tid("coordinator"),
      })
    ).model;
    expect(thread(model, "coordinator").deletedAt).toBeNull();
    // Parent restore brings back its own subtree under the same incarnation.
    expect(group(model, "wave").deletedAt).toBeNull();
    expect(thread(model, "a").deletedAt).toBeNull();
  });

  it("does not restore a sibling deleted by the same cascade or a re-deleted member", async () => {
    let model = await seedTree();
    // One cascade tags both sibling groups with the same deletion ID.
    model = (
      await apply(model, {
        type: "thread.delete",
        commandId: cid("cascade"),
        threadId: tid("coordinator"),
      })
    ).model;
    // Defensive bound: make the parent live without its subtree (as a row
    // with no recorded incarnation would be), then restore just one group.
    model = {
      ...model,
      threads: model.threads.map((entry) =>
        entry.id === "coordinator" ? { ...entry, deletedAt: null, deletionId: null } : entry,
      ),
    };
    model = (
      await apply(model, {
        type: "thread.group.restore",
        commandId: cid("rw"),
        groupId: gid("wave"),
      })
    ).model;
    expect(group(model, "wave").deletedAt).toBeNull();
    expect(thread(model, "a").deletedAt).toBeNull();
    expect(group(model, "sub").deletedAt).toBeNull();
    expect(thread(model, "c").deletedAt).toBeNull();
    // The sibling group shared the cascade deletion ID but is not in wave's subtree.
    expect(group(model, "other").deletedAt).not.toBeNull();
    expect(thread(model, "d").deletedAt).not.toBeNull();

    // A member deleted again later carries a newer incarnation and stays deleted.
    model = (
      await apply(model, { type: "thread.delete", commandId: cid("again"), threadId: tid("a") })
    ).model;
    model = (
      await apply(model, {
        type: "thread.group.delete",
        commandId: cid("dw2"),
        groupId: gid("wave"),
      })
    ).model;
    model = (
      await apply(model, {
        type: "thread.group.restore",
        commandId: cid("rw2"),
        groupId: gid("wave"),
      })
    ).model;
    expect(thread(model, "b").deletedAt).toBeNull();
    expect(thread(model, "a").deletedAt).not.toBeNull();
    expect(thread(model, "a").deletionId).toBe("again");
  });

  it("restores a single member under its group shell, or top level when the parent is gone", async () => {
    let model = (
      await apply(await seedTree(), {
        type: "thread.group.delete",
        commandId: cid("dw"),
        groupId: gid("wave"),
      })
    ).model;
    model = (
      await apply(model, { type: "thread.restore", commandId: cid("ra"), threadId: tid("a") })
    ).model;
    expect(thread(model, "a")).toMatchObject({ deletedAt: null, groupId: "wave" });
    expect(group(model, "wave").deletedAt).toBeNull();
    expect(thread(model, "b").deletedAt).not.toBeNull();

    model = (
      await apply(model, {
        type: "thread.delete",
        commandId: cid("dp"),
        threadId: tid("coordinator"),
      })
    ).model;
    model = (
      await apply(model, { type: "thread.restore", commandId: cid("rd"), threadId: tid("d") })
    ).model;
    expect(thread(model, "d")).toMatchObject({ deletedAt: null, groupId: null });
  });

  it("archives members with their parent and unarchives only that cascade", async () => {
    let model = await seedTree();
    model = (
      await apply(model, { type: "thread.archive", commandId: cid("arch-d"), threadId: tid("d") })
    ).model;
    model = (
      await apply(model, {
        type: "thread.archive",
        commandId: cid("arch-parent"),
        threadId: tid("coordinator"),
      })
    ).model;
    for (const id of ["a", "b", "c"]) expect(thread(model, id).archivedAt).not.toBeNull();
    model = (
      await apply(model, {
        type: "thread.unarchive",
        commandId: cid("unarch"),
        threadId: tid("coordinator"),
      })
    ).model;
    for (const id of ["coordinator", "a", "b", "c"])
      expect(thread(model, id).archivedAt).toBeNull();
    // Independently archived before the cascade: stays archived.
    expect(thread(model, "d").archivedAt).not.toBeNull();
  });

  it("enforces per-owner title uniqueness and the nesting depth bound", async () => {
    let model = await seedTree();
    await refuse(model, createGroup("dup", "coordinator", "wave"));
    let owner = "coordinator";
    for (let depth = 1; depth <= MAX_THREAD_GROUP_DEPTH; depth += 1) {
      model = (await apply(model, createGroup(`g${depth}`, owner))).model;
      model = (await apply(model, createThread(`t${depth}`, { groupId: gid(`g${depth}`) }))).model;
      owner = `t${depth}`;
    }
    await refuse(model, createGroup("too-deep", owner));
  });

  it("refuses new turns on a chat in the Recycle Bin", async () => {
    const model = (
      await apply(await seedTree(), {
        type: "thread.group.delete",
        commandId: cid("dw"),
        groupId: gid("wave"),
      })
    ).model;
    await refuse(model, {
      type: "thread.turn.start",
      commandId: nextCommandId(),
      threadId: tid("a"),
      message: { messageId: "m1" as never, role: "user", text: "hi", attachments: [] },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt: NOW,
    } as OrchestrationCommand);
  });

  it("lets a person correct the label without touching provenance", async () => {
    const { model } = await apply(await seedTree(), {
      type: "thread.metadata.update",
      commandId: nextCommandId(),
      threadId: tid("a"),
      originClassification: "human",
      description: "Audit the relay",
    });
    expect(thread(model, "a")).toMatchObject({
      origin: { classification: "human", source: "user" },
      description: "Audit the relay",
      provenance: { creationPath: "mcp-launch", originThreadId: "coordinator" },
    });
  });

  it("copies neither membership nor groups to a duplicate", async () => {
    const { model } = await apply(await seedTree(), {
      type: "thread.duplicate",
      commandId: nextCommandId(),
      sourceThreadId: tid("b"),
      targetThreadId: tid("b-copy"),
      title: "copy",
      createdAt: NOW,
    });
    expect(thread(model, "b-copy").groupId ?? null).toBeNull();
    expect(thread(model, "b-copy").provenance).toMatchObject({
      creationPath: "duplicate",
      originThreadId: "b",
    });
    expect(model.threadGroups!.some((entry) => entry.ownerThreadId === "b-copy")).toBe(false);
  });
});
