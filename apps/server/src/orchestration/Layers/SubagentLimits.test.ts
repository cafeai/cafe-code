import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationSession,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
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

/** Only isolated SQLite/Node services: no provider registry, binaries, profiles, or inference. */
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
    Layer.provideMerge(makeSqlitePersistenceLive(path.join(baseDir, "policy.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    dispatch: (command: OrchestrationCommand) => runtime.runPromise(engine.dispatch(command)),
    read: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    query,
    dispose: () => runtime.dispose(),
  };
}

const now = "2026-10-03T00:00:00.000Z";
const threadId = ThreadId.make("durable-policy");
const instanceId = ProviderInstanceId.make("codex");
const create = (
  id: ThreadId,
  limits?: { codex?: number; claude?: number },
): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make(`create-${id}`),
  threadId: id,
  projectId: null,
  title: "Durable policy",
  modelSelection: { instanceId, model: "synthetic" },
  ...(limits !== undefined ? { subagentLimits: limits } : {}),
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now,
});
const session = (fields: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId,
  status: "ready",
  providerName: "codex",
  providerInstanceId: instanceId,
  runtimeMode: "approval-required",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
  ...fields,
});

describe("durable subagent policy projections", () => {
  it("round-trips exact policy, copies, lifecycle evidence, reset/dedup, and restart through every read shape", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-subagent-policy-"));
    const duplicateId = ThreadId.make("durable-duplicate");
    const forkId = ThreadId.make("durable-fork");
    const legacyId = ThreadId.make("legacy-unknown-policy");
    try {
      const system = await openSystem(baseDir);
      try {
        await system.dispatch(create(threadId, { codex: 4, claude: 2 }));
        await system.dispatch(create(legacyId));
        const detail = await system.read(system.query.getThreadDetailById(threadId));
        expect(Option.getOrThrow(detail).subagentLimits).toEqual({ codex: 4, claude: 2 });
        const shell = await system.read(system.query.getThreadShellById(threadId));
        expect(Option.getOrThrow(shell).subagentLimits).toEqual({ codex: 4, claude: 2 });
        const snapshot = await system.read(system.query.getSnapshot());
        expect(snapshot.threads.find((thread) => thread.id === legacyId)).not.toHaveProperty(
          "subagentLimits",
        );

        let sessionCounter = 0;
        const set = (value: OrchestrationSession) =>
          system.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(`session-${sessionCounter++}`),
            threadId,
            session: value,
            createdAt: now,
          });
        await set(session({ maxConcurrentSubagents: 4 }));
        await set(session());
        expect(
          Option.getOrThrow(await system.read(system.query.getThreadDetailById(threadId))).session
            ?.maxConcurrentSubagents,
        ).toBe(4);
        await set(session({ providerInstanceId: ProviderInstanceId.make("different-account") }));
        expect(
          Option.getOrThrow(await system.read(system.query.getThreadShellById(threadId))).session,
        ).not.toHaveProperty("maxConcurrentSubagents");
        await set(session({ maxConcurrentSubagents: null }));

        await system.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("replace-limits"),
          threadId,
          subagentLimits: { claude: 3 },
        });
        await system.dispatch({
          type: "thread.duplicate",
          commandId: CommandId.make("copy-limits"),
          sourceThreadId: threadId,
          targetThreadId: duplicateId,
          title: "Duplicate",
          createdAt: now,
        });
        await system.dispatch({
          type: "thread.fork.commit",
          sourceVersion: await system.read(system.query.getThreadForkSourceVersion(threadId)),
          commandId: CommandId.make("fork-limits"),
          sourceThreadId: threadId,
          targetThreadId: forkId,
          title: "Fork",
          createdAt: now,
          session: session({ threadId: forkId, status: "stopped", maxConcurrentSubagents: null }),
        });
        expect(
          Option.getOrThrow(await system.read(system.query.getThreadDetailById(duplicateId)))
            .subagentLimits,
        ).toEqual({ claude: 3 });
        expect(
          Option.getOrThrow(await system.read(system.query.getThreadDetailById(forkId)))
            .subagentLimits,
        ).toEqual({ claude: 3 });
        await system.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-copy"),
          threadId: duplicateId,
        });
        await system.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-copy"),
          threadId: forkId,
        });
        expect(
          (await system.read(system.query.getArchivedShellSnapshot())).threads[0]?.subagentLimits,
        ).toEqual({ claude: 3 });
        expect(
          (await system.read(system.query.getDeletedShellSnapshot())).threads[0]?.subagentLimits,
        ).toEqual({ claude: 3 });

        const reset: OrchestrationCommand = {
          type: "thread.meta.update",
          commandId: CommandId.make("reset-limits"),
          threadId,
          subagentLimits: {},
        };
        await system.dispatch(reset);
        const beforeRepeat = await system.read(system.query.getSnapshotSequence());
        await system.dispatch(reset);
        expect(await system.read(system.query.getSnapshotSequence())).toEqual(beforeRepeat);
        await system.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("rename-after-reset"),
          threadId,
          title: "Reset preserved",
        });
        const commandSnapshot = await system.read(system.query.getCommandReadModel());
        expect(
          commandSnapshot.threads.find((thread) => thread.id === threadId)?.subagentLimits,
        ).toEqual({});
      } finally {
        await system.dispose();
      }

      // A fresh managed runtime reopens only this scoped database. Legacy
      // absence must stay unknown, while explicit reset/null remain durable.
      const reopened = await openSystem(baseDir);
      try {
        const snapshot = await reopened.read(reopened.query.getSnapshot());
        const thread = snapshot.threads.find((entry) => entry.id === threadId);
        expect(thread?.subagentLimits).toEqual({});
        expect(thread?.session?.maxConcurrentSubagents).toBeNull();
        expect(snapshot.threads.find((entry) => entry.id === legacyId)).not.toHaveProperty(
          "subagentLimits",
        );
        expect(
          Option.getOrThrow(await reopened.read(reopened.query.getThreadDetailById(threadId)))
            .subagentLimits,
        ).toEqual({});
        expect(
          (await reopened.read(reopened.query.getShellSnapshot())).threads.find(
            (entry) => entry.id === threadId,
          )?.subagentLimits,
        ).toEqual({});
        expect(
          (await reopened.read(reopened.query.getArchivedShellSnapshot())).threads[0]
            ?.subagentLimits,
        ).toEqual({ claude: 3 });
        expect(
          (await reopened.read(reopened.query.getDeletedShellSnapshot())).threads[0]
            ?.subagentLimits,
        ).toEqual({ claude: 3 });
      } finally {
        await reopened.dispose();
      }
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
