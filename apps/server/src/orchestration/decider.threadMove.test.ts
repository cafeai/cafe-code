import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

async function makeReadModelWithMoveFixture() {
  const now = "2026-01-01T00:00:00.000Z";
  const initial = createEmptyReadModel(now);
  const withSourceProject = await Effect.runPromise(
    projectEvent(initial, {
      sequence: 1,
      eventId: EventId.make("event-project-source"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-source"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-project-source"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-source"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-source"),
        title: "Source",
        workspaceRoot: "/tmp/source",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  const withTargetProject = await Effect.runPromise(
    projectEvent(withSourceProject, {
      sequence: 2,
      eventId: EventId.make("event-project-target"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-target"),
      type: "project.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-project-target"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-target"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-target"),
        title: "Target",
        workspaceRoot: "/tmp/target",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
  return Effect.runPromise(
    projectEvent(withTargetProject, {
      sequence: 3,
      eventId: EventId.make("event-thread"),
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-1"),
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.make("cmd-thread"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-thread"),
      metadata: {},
      payload: {
        threadId: asThreadId("thread-1"),
        projectId: asProjectId("project-source"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/tmp/source/worktree",
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

describe("thread move decider", () => {
  it("emits a thread meta update with the target project id and clears stale worktree overrides", async () => {
    const readModel = await makeReadModelWithMoveFixture();

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-thread-move"),
          threadId: asThreadId("thread-1"),
          projectId: asProjectId("project-target"),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.meta-updated");
    expect(
      (event.payload as { projectId?: ProjectId; worktreePath?: string | null }).projectId,
    ).toBe("project-target");
    expect(
      (event.payload as { projectId?: ProjectId; worktreePath?: string | null }).worktreePath,
    ).toBeNull();
  });

  it("rejects moves to missing projects", async () => {
    const readModel = await makeReadModelWithMoveFixture();

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-thread-move-missing"),
            threadId: asThreadId("thread-1"),
            projectId: asProjectId("project-missing"),
          },
          readModel,
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("rejects moves to deleted projects", async () => {
    const readModel = await makeReadModelWithMoveFixture();
    const withDeletedTarget = await Effect.runPromise(
      projectEvent(readModel, {
        sequence: 4,
        eventId: EventId.make("event-project-target-deleted"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-target"),
        type: "project.deleted",
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: CommandId.make("cmd-project-target-deleted"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-target-deleted"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-target"),
          deletedAt: "2026-01-01T00:00:01.000Z",
        },
      }),
    );

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-thread-move-deleted"),
            threadId: asThreadId("thread-1"),
            projectId: asProjectId("project-target"),
          },
          readModel: withDeletedTarget,
        }),
      ),
    ).rejects.toThrow("has been deleted");
  });
});
