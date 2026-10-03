import {
  CommandId,
  OrchestrationEvent,
  OrchestrationThread,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-10-03T04:00:00.000Z";
const sourceId = ThreadId.make("standalone-source");
const projectId = ProjectId.make("real-project");
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);

function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return decodeThread({
    id: sourceId,
    projectId: null,
    title: "A standalone chat",
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  });
}

function model(threads: ReadonlyArray<OrchestrationThread> = []): OrchestrationReadModel {
  return {
    ...createEmptyReadModel(now),
    projects: [
      {
        id: projectId,
        title: "Real project",
        workspaceRoot: "/synthetic/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads,
  };
}

function create(
  association: ProjectId | null = null,
): Extract<OrchestrationCommand, { type: "thread.create" }> {
  return {
    type: "thread.create",
    commandId: CommandId.make("create-standalone"),
    threadId: sourceId,
    projectId: association,
    title: "A standalone chat",
    modelSelection: thread().modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: now,
  };
}

const meta = (
  projectId: ProjectId | null,
): Extract<OrchestrationCommand, { type: "thread.meta.update" }> => ({
  type: "thread.meta.update",
  commandId: CommandId.make("change-association"),
  threadId: sourceId,
  projectId,
});

async function decide(command: OrchestrationCommand, readModel = model()) {
  return Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
}

async function apply(command: OrchestrationCommand, readModel: OrchestrationReadModel) {
  const result = await decide(command, readModel);
  const events = Array.isArray(result) ? result : [result];
  let next = readModel;
  for (const planned of events) {
    const event = Schema.decodeUnknownSync(OrchestrationEvent)({
      ...planned,
      sequence: next.snapshotSequence + 1,
    });
    next = await Effect.runPromise(projectEvent(next, event));
  }
  return next;
}

describe("standalone orchestration admission", () => {
  it("creates a genuine standalone thread with zero projects and a conservative default", async () => {
    const result = await apply(create(), createEmptyReadModel(now));
    expect(result.projects).toEqual([]);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]).toMatchObject({
      projectId: null,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
    });
  });

  it("does not change an explicitly project-associated creation's permission mode", async () => {
    expect(await decide(create(projectId))).toMatchObject({
      payload: { projectId, runtimeMode: "full-access" },
    });
  });

  it.each([{ branch: "secret-branch" }, { worktreePath: "/other/project" }])(
    "rejects standalone creation carrying repository metadata %j",
    async (overrides) => {
      await expect(decide({ ...create(), ...overrides })).rejects.toThrow("branch or worktree");
    },
  );

  it("still rejects a project-linked chat with an unknown project", async () => {
    await expect(decide(create(ProjectId.make("not-on-this-server")))).rejects.toThrow(
      "does not exist",
    );
  });

  it("detaches an idle conversation without relabelling its model/account or permission selection", async () => {
    const original = thread({
      projectId,
      branch: "old-branch",
      worktreePath: "/old/project/worktree",
      runtimeMode: "full-access",
    });
    const result = await apply(meta(null), model([original]));
    expect(result.threads[0]).toMatchObject({
      projectId: null,
      branch: null,
      worktreePath: null,
      runtimeMode: "full-access",
      modelSelection: original.modelSelection,
    });
    expect(original.projectId).toBe(projectId);
    expect(original.worktreePath).toBe("/old/project/worktree");
  });

  it("attaches an idle standalone chat only to a live project on its owning backend", async () => {
    const attached = await apply(meta(projectId), model([thread()]));
    expect(attached.threads[0]).toMatchObject({ projectId, branch: null, worktreePath: null });
    await expect(
      decide(meta(ProjectId.make("foreign-environment-project")), model([thread()])),
    ).rejects.toThrow("does not exist");
  });

  it.each(["starting", "running"] as const)(
    "does not change association while the session is %s",
    async (status) => {
      const active = thread({
        session: {
          threadId: sourceId,
          status,
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: status === "running" ? TurnId.make("active-turn") : null,
          lastError: null,
          updatedAt: now,
        },
      });
      await expect(decide(meta(projectId), model([active]))).rejects.toThrow("must be idle");
    },
  );

  it("rejects association change across an accepted start not yet reflected in the session", async () => {
    const active = thread({
      latestTurn: {
        turnId: TurnId.make("accepted-turn"),
        state: "running",
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        assistantMessageId: null,
      },
    });
    await expect(decide(meta(projectId), model([active]))).rejects.toThrow("must be idle");
  });

  it("treats an unresolved active-turn identity as non-idle even with a ready status", async () => {
    const active = thread({
      session: {
        threadId: sourceId,
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: TurnId.make("unsettled-turn"),
        lastError: null,
        updatedAt: now,
      },
    });
    await expect(decide(meta(projectId), model([active]))).rejects.toThrow("must be idle");
  });

  it.each([{ branch: "branch" }, { worktreePath: "/forged/path" }])(
    "rejects repository metadata added to an existing standalone thread %j",
    async (overrides) => {
      await expect(
        decide(
          {
            type: "thread.meta.update",
            commandId: CommandId.make("set-forged-workspace"),
            threadId: sourceId,
            ...overrides,
          },
          model([thread()]),
        ),
      ).rejects.toThrow("branch or worktree");
    },
  );

  it("an ordinary rename does not implicitly detach or clear a project workspace", async () => {
    const linked = thread({ projectId, branch: "kept-branch", worktreePath: "/kept/worktree" });
    const result = await apply(
      {
        type: "thread.meta.update",
        commandId: CommandId.make("rename-only"),
        threadId: sourceId,
        title: "Renamed",
      },
      model([linked]),
    );
    expect(result.threads[0]).toMatchObject({
      projectId,
      branch: "kept-branch",
      worktreePath: "/kept/worktree",
      title: "Renamed",
    });
  });

  it("project deletion does not delete or archive an unrelated standalone chat", async () => {
    const standalone = thread();
    const result = await apply(
      {
        type: "project.delete",
        commandId: CommandId.make("delete-project"),
        projectId,
        force: true,
      },
      model([standalone]),
    );
    expect(result.threads[0]).toEqual(standalone);
  });

  it("archive, restore and rename retain standalone identity and conversation history", async () => {
    const initial = model([thread()]);
    const archived = await apply(
      { type: "thread.archive", commandId: CommandId.make("archive-chat"), threadId: sourceId },
      initial,
    );
    expect(archived.threads[0]?.archivedAt).not.toBeNull();
    const restored = await apply(
      { type: "thread.unarchive", commandId: CommandId.make("restore-chat"), threadId: sourceId },
      archived,
    );
    expect(restored.threads[0]).toMatchObject({
      projectId: null,
      archivedAt: null,
      runtimeMode: "approval-required",
    });
    expect(restored.projects).toEqual(initial.projects);
  });
});
