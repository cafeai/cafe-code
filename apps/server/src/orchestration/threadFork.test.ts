import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type ProviderSessionForkResult,
} from "@cafecode/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { dispatchProviderNativeThreadFork } from "./threadFork.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { ProviderAdapterRequestError } from "../provider/Errors.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeStandaloneWorkspaceStore } from "./standaloneWorkspace.ts";

const sourceThreadId = ThreadId.make("thread-fork-source");
const targetThreadId = ThreadId.make("thread-fork-target");
const commandId = CommandId.make("cmd-thread-fork");
const createdAt = "2026-08-21T12:00:00.000Z";

const sourceThread = {
  id: sourceThreadId,
  projectId: ProjectId.make("project-fork"),
  title: "Source",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/fork",
  worktreePath: "/repo/fork",
  latestTurn: null,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: sourceThreadId,
    status: "ready",
    providerName: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: createdAt,
  },
  goal: null,
} satisfies OrchestrationThread;

const nativeFork = {
  operationId: commandId,
  sourceThreadId,
  targetThreadId,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  cwd: "/repo/fork",
  resumeCursor: { threadId: "provider-fork-id" },
} satisfies ProviderSessionForkResult;

it.effect("compensates only the owned native fork when the domain commit fails", () => {
  const forkSession = vi.fn<ProviderServiceShape["forkSession"]>(() => Effect.succeed(nativeFork));
  const discardSessionFork = vi.fn<ProviderServiceShape["discardSessionFork"]>(() => Effect.void);
  const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>((command) =>
    Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "simulated commit conflict",
      }),
    ),
  );
  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = () =>
    Effect.succeed(Option.some(sourceThread));

  return Effect.gen(function* () {
    const exit = yield* dispatchProviderNativeThreadFork({
      command: {
        type: "thread.fork",
        commandId,
        sourceThreadId,
        targetThreadId,
        title: "Source (fork)",
        createdAt,
      },
      orchestrationEngine: { dispatch },
      projectionSnapshotQuery: { getThreadDetailById },
      providerService: { forkSession, discardSessionFork },
    }).pipe(Effect.exit);

    assert.equal(Exit.isFailure(exit), true);
    assert.deepEqual(forkSession.mock.calls[0]?.[0], {
      operationId: commandId,
      sourceThreadId,
      targetThreadId,
      title: "Source (fork)",
    });
    assert.equal(dispatch.mock.calls[0]?.[0].type, "thread.fork.commit");
    assert.deepEqual(discardSessionFork.mock.calls[0]?.[0], { fork: nativeFork });
  });
});

it.effect("rejects an unresolved native turn identity before any fork I/O", () => {
  const forkSession = vi.fn<ProviderServiceShape["forkSession"]>(() => Effect.succeed(nativeFork));
  const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>(() =>
    Effect.succeed({ sequence: 1 }),
  );
  return Effect.gen(function* () {
    const result = yield* Effect.exit(
      dispatchProviderNativeThreadFork({
        command: {
          type: "thread.fork",
          commandId,
          sourceThreadId,
          targetThreadId,
          title: "Fork",
          createdAt,
        },
        orchestrationEngine: { dispatch },
        projectionSnapshotQuery: {
          getThreadDetailById: () =>
            Effect.succeed(
              Option.some({
                ...sourceThread,
                session: {
                  ...sourceThread.session,
                  activeTurnId: TurnId.make("unsettled-native-turn"),
                },
              }),
            ),
        },
        providerService: { forkSession, discardSessionFork: () => Effect.void },
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.equal(forkSession.mock.calls.length, 0);
    assert.equal(dispatch.mock.calls.length, 0);
  });
});

it.effect("compensates provisional standalone ownership without releasing the source", () => {
  const forkSession = vi.fn<ProviderServiceShape["forkSession"]>(() =>
    Effect.succeed({ ...nativeFork, cwd: "/server-owned-neutral" }),
  );
  const discardSessionFork = vi.fn<ProviderServiceShape["discardSessionFork"]>(() => Effect.void);
  const shareFork = vi.fn(() => Effect.succeed(undefined));
  const discardFork = vi.fn(() => Effect.void);
  const remove = vi.fn(() => Effect.succeed(undefined));
  return Effect.gen(function* () {
    const result = yield* Effect.exit(
      dispatchProviderNativeThreadFork({
        command: {
          type: "thread.fork",
          commandId,
          sourceThreadId,
          targetThreadId,
          title: "Fork",
          createdAt,
        },
        orchestrationEngine: {
          dispatch: (command) =>
            Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "simulated conflict",
              }),
            ),
        },
        projectionSnapshotQuery: {
          getThreadDetailById: () =>
            Effect.succeed(
              Option.some({ ...sourceThread, projectId: null, branch: null, worktreePath: null }),
            ),
        },
        providerService: { forkSession, discardSessionFork },
        standaloneWorkspaces: {
          resolve: () => Effect.succeed("/server-owned-neutral"),
          remove,
          shareFork,
          discardFork,
        },
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.deepEqual(shareFork.mock.calls[0], [sourceThreadId, targetThreadId, commandId]);
    assert.deepEqual(discardFork.mock.calls[0], [targetThreadId, commandId]);
    assert.equal(discardSessionFork.mock.calls.length, 1);
    assert.equal(remove.mock.calls.length, 0);
  });
});

const workspaceLayer = Layer.mergeAll(
  SqlitePersistenceMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "standalone-fork-compensation-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
it.layer(Layer.fresh(workspaceLayer))("standalone fork final-owner compensation", (it) => {
  for (const outcome of [
    "confirmed-retirement",
    "uncertain-retirement",
    "uncertain-preparation",
  ] as const) {
    it.effect(`preserves final-owner authority through ${outcome} after source deletion`, () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const source = ThreadId.make(`source-${outcome}`);
        const target = ThreadId.make(`target-${outcome}`);
        const operation = CommandId.make(`fork-${outcome}`);
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at)
          VALUES (${source}, NULL, 'Source', ${createdAt}, ${createdAt})`;
        const store = yield* makeStandaloneWorkspaceStore;
        const cwd = yield* store.resolve(source);
        const fork = {
          ...nativeFork,
          operationId: operation,
          sourceThreadId: source,
          targetThreadId: target,
          cwd,
        };
        const preparationFailure = new ProviderAdapterRequestError({
          provider: "codex",
          method: "session.fork",
          detail: "Synthetic preparation outcome is unknown.",
        });
        const forkSession = vi.fn<ProviderServiceShape["forkSession"]>(() =>
          Effect.gen(function* () {
            // shareFork has committed before this mocked provider boundary. Retire
            // the source while preparation is in flight: its files must remain
            // owned by the provisional target until native retirement is proven.
            yield* sql`INSERT INTO hard_deleted_threads VALUES (${source}, ${createdAt})`.pipe(
              Effect.orDie,
            );
            yield* store.remove(source).pipe(Effect.orDie);
            assert.isTrue((yield* Effect.promise(() => fs.stat(cwd))).isDirectory());
            if (outcome === "uncertain-preparation") return yield* Effect.fail(preparationFailure);
            return fork;
          }),
        );
        const discardSessionFork = vi.fn<ProviderServiceShape["discardSessionFork"]>(() =>
          outcome === "uncertain-retirement"
            ? Effect.fail(
                new ProviderAdapterRequestError({
                  provider: "codex",
                  method: "session.fork.discard",
                  detail: "Synthetic retirement could not be verified.",
                }),
              )
            : Effect.void,
        );
        const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>((command) =>
          Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Source retired before commit.",
            }),
          ),
        );
        const result = yield* Effect.exit(
          dispatchProviderNativeThreadFork({
            command: {
              type: "thread.fork",
              commandId: operation,
              sourceThreadId: source,
              targetThreadId: target,
              title: "Fork",
              createdAt,
            },
            orchestrationEngine: { dispatch },
            projectionSnapshotQuery: {
              getThreadDetailById: () =>
                Effect.succeed(
                  Option.some({
                    ...sourceThread,
                    id: source,
                    projectId: null,
                    branch: null,
                    worktreePath: null,
                    session: { ...sourceThread.session, threadId: source },
                  }),
                ),
            },
            providerService: { forkSession, discardSessionFork },
            standaloneWorkspaces: store,
          }),
        );
        assert.equal(result._tag, "Failure");
        assert.deepEqual(
          yield* sql`SELECT thread_id FROM standalone_thread_workspaces WHERE thread_id = ${source}`,
          [],
        );
        const ownership =
          yield* sql`SELECT fork_operation_id, directory_device, directory_inode, cleanup_name FROM standalone_thread_workspaces WHERE thread_id = ${target}`;
        if (outcome === "confirmed-retirement") {
          assert.deepEqual(ownership, []);
          assert.equal(
            yield* Effect.promise(() =>
              fs.stat(cwd).then(
                () => true,
                () => false,
              ),
            ),
            false,
          );
          assert.equal(discardSessionFork.mock.calls.length, 1);
        } else {
          assert.equal(ownership.length, 1);
          assert.equal(ownership[0]?.fork_operation_id, operation);
          assert.isNotNull(ownership[0]?.directory_device);
          assert.isNotNull(ownership[0]?.directory_inode);
          assert.equal(ownership[0]?.cleanup_name, null);
          assert.isTrue((yield* Effect.promise(() => fs.stat(cwd))).isDirectory());
          assert.equal(
            discardSessionFork.mock.calls.length,
            outcome === "uncertain-preparation" ? 0 : 1,
          );
          assert.equal(dispatch.mock.calls.length, outcome === "uncertain-preparation" ? 0 : 1);
          // No native provider exists in this synthetic fixture. Explicitly
          // establish fixture retirement only after testing retained evidence,
          // then exercise the exact-command retry of the real cleanup path.
          yield* store.discardFork(target, operation);
          assert.deepEqual(
            yield* sql`SELECT thread_id FROM standalone_thread_workspaces WHERE thread_id = ${target}`,
            [],
          );
        }
      }),
    );
  }
});
// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
