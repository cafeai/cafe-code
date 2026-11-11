// The scoped fixture creates and retires its own temporary database directory.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import path from "node:path";

import {
  CommandId,
  ProviderInstanceId,
  ThreadGroupId,
  ThreadId,
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
import { purgeOwnedThreadGroups } from "../../persistence/threadOrganization.ts";
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
    sql: <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      runtime.runPromise(effect as never) as Promise<A>,
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
            groupId: ThreadGroupId.make("wave"),
            description: "Check relay PoW",
            provenance: {
              creationPath: "mcp-launch",
              originThreadId: ThreadId.make("owner"),
              recordedAt: now,
            },
          }),
        );

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
        expect(shell.threads.find((thread) => thread.id === "worker")?.groupId).toBe("wave");

        // Hard delete of the owner removes its groups and returns members to
        // top level instead of orphaning them beneath a missing group.
        await system.sql(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* purgeOwnedThreadGroups(sql, ThreadId.make("owner"));
          }),
        );
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
