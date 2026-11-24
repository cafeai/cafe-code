// The scoped fixture creates and retires its own temporary database directory.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import path from "node:path";

import {
  CommandId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadGroupId,
  ThreadId,
  TurnId,
  SubagentRuntimeId,
  type OrchestrationCommand,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

/** Isolated SQLite/Node services only: no providers, binaries, profiles or inference. */
async function openSystem(baseDir: string) {
  const layer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(makeSqlitePersistenceLive(path.join(baseDir, "groups.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    dispatch: (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command)),
    read: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient | never>) =>
      runtime.runPromise(effect as Effect.Effect<A, E>),
    retire: (threadId: ThreadId) =>
      runtime.runPromise(engine.retireThreadForHardDelete({ threadId })),
    purge: (threadId: ThreadId) => runtime.runPromise(engine.purgeHardDeletedThread({ threadId })),
    query,
    dispose: () => runtime.dispose(),
  };
}

const now = "2026-11-10T00:00:00.000Z";
let counter = 0;
const create = (
  id: string,
  extra: Partial<Extract<OrchestrationCommand, { type: "thread.create" }>> = {},
): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make(`create-${id}-${++counter}`),
  threadId: ThreadId.make(id),
  projectId: null,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "synthetic" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now,
  ...extra,
});

describe("thread group projections", () => {
  it("projects groups/metadata to SQL, rebuilds the engine model and purges on hard delete", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-thread-groups-"));
    try {
      let system = await openSystem(baseDir);
      try {
        await system.dispatch(create("owner"));
        await system.dispatch({
          type: "thread.group.create",
          commandId: CommandId.make("group"),
          groupId: ThreadGroupId.make("wave"),
          ownerThreadId: ThreadId.make("owner"),
          title: "Wave",
          description: "Audit workers",
          provenance: {
            creationPath: "mcp-launch",
            attribution: "launch-claim",
            launchThreadId: ThreadId.make("owner"),
            recordedAt: now,
          },
          createdAt: now,
        });
        await system.dispatch(
          create("worker", {
            description: "Check relay PoW",
            provenance: {
              creationPath: "mcp-launch",
              originThreadId: ThreadId.make("owner"),
              recordedAt: now,
            },
          }),
        );

        const workerId = ThreadId.make("worker");
        const turnId = TurnId.make("existing-root");
        const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000111");
        await system.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("running-session"),
          threadId: workerId,
          createdAt: now,
          session: {
            threadId: workerId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            subagentRuntimeId: runtimeId,
            lastError: null,
            updatedAt: now,
          },
        });
        await system.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.make("existing-transcript"),
          threadId: workerId,
          messageId: MessageId.make("streaming-reply"),
          turnId,
          delta: "Still working",
          createdAt: now,
        });
        await system.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("existing-child"),
          threadId: workerId,
          createdAt: now,
          activity: {
            id: EventId.make("child-start"),
            kind: "task.started",
            tone: "info",
            summary: "Child working",
            turnId,
            createdAt: now,
            payload: {
              taskId: "child",
              subagent: { threadId: "child", runtimeId, status: "active" },
            },
          },
        });
        const before = Option.getOrThrow(
          await system.read(system.query.getThreadDetailById(workerId)),
        );
        const beforeShell = Option.getOrThrow(
          await system.read(system.query.getThreadShellById(workerId)),
        );
        expect(beforeShell.liveWork).toMatchObject({ runtimeId, agentCount: 1 });
        const move = {
          type: "thread.metadata.update" as const,
          commandId: CommandId.make("move-existing"),
          threadId: workerId,
          groupId: ThreadGroupId.make("wave"),
        };
        const receipt = await system.dispatch(move);
        expect(await system.dispatch(move)).toEqual(receipt);
        expect(
          Option.getOrThrow(await system.read(system.query.getThreadDetailById(workerId))),
        ).toEqual({ ...before, groupId: "wave" });
        expect(
          Option.getOrThrow(await system.read(system.query.getThreadShellById(workerId))),
        ).toEqual({ ...beforeShell, groupId: "wave" });
        await system.dispatch({
          ...move,
          commandId: CommandId.make("detach-existing"),
          groupId: null,
        });
        expect(
          Option.getOrThrow(await system.read(system.query.getThreadDetailById(workerId))),
        ).toEqual(before);
        await system.dispatch({ ...move, commandId: CommandId.make("regroup-existing") });

        const shell = await system.read(system.query.getShellSnapshot());
        const owner = shell.threads.find((thread) => thread.id === "owner")!;
        const worker = shell.threads.find((thread) => thread.id === "worker")!;
        expect(owner.ownedGroups).toEqual([{ id: "wave", title: "Wave", createdAt: now }]);
        expect(worker).toMatchObject({
          groupId: "wave",
          origin: { classification: "agent", source: "recorded" },
        });
        // Shells stay compact: no description text.
        expect(JSON.stringify(shell)).not.toContain("Check relay PoW");
        const detail = Option.getOrThrow(
          await system.read(system.query.getThreadDetailById(ThreadId.make("worker"))),
        );
        expect(detail).toMatchObject({
          description: "Check relay PoW",
          provenance: { creationPath: "mcp-launch", originThreadId: "owner" },
        });

        await system.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("correct-origin"),
          threadId: workerId,
          originClassification: "human",
        });
        expect(
          Option.getOrThrow(await system.read(system.query.getThreadShellById(workerId))),
        ).toMatchObject({
          groupId: "wave",
          origin: { classification: "human", source: "user" },
          liveWork: { agentCount: 1 },
        });

        await system.dispatch({
          type: "thread.group.delete",
          commandId: CommandId.make("delete-wave"),
          groupId: ThreadGroupId.make("wave"),
        });
        const deleted = await system.read(system.query.getDeletedShellSnapshot());
        expect(deleted.deletedThreadGroups?.map((group) => group.id)).toEqual(["wave"]);
        expect(deleted.threads.map((thread) => thread.id)).toEqual(["worker"]);
      } finally {
        await system.dispose();
      }

      // A fresh process rebuilds the command read model from SQL, including
      // the deleted group's exact incarnation, so restore still works.
      system = await openSystem(baseDir);
      try {
        await system.dispatch({
          type: "thread.group.restore",
          commandId: CommandId.make("restore-wave"),
          groupId: ThreadGroupId.make("wave"),
        });
        const shell = await system.read(system.query.getShellSnapshot());
        expect(shell.threads.find((thread) => thread.id === "worker")).toMatchObject({
          groupId: "wave",
          origin: { classification: "human", source: "user" },
        });
        const restored = Option.getOrThrow(
          await system.read(system.query.getThreadDetailById(ThreadId.make("worker"))),
        );
        expect(restored.provenance).toMatchObject({
          creationPath: "mcp-launch",
          originThreadId: "owner",
        });
        expect(restored.messages.map((message) => message.text)).toEqual(["Still working"]);

        // Hard delete of the owner removes its groups and returns members to
        // top level instead of orphaning them beneath a missing group.
        await system.retire(ThreadId.make("owner"));
        await expect(
          system.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("move-after-parent-retirement"),
            threadId: ThreadId.make("worker"),
            groupId: ThreadGroupId.make("wave"),
          }),
        ).rejects.toThrow();
        await system.purge(ThreadId.make("owner"));
        const organization = await system.read(system.query.getThreadOrganization!(null));
        expect(organization.groups).toEqual([]);
        expect(organization.threads.get("worker")?.groupId).toBeNull();
      } finally {
        await system.dispose();
      }
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
