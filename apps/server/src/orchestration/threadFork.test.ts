import {
  CommandId,
  CheckpointRef,
  MessageId,
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
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
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
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { makeStandaloneWorkspaceStore } from "./standaloneWorkspace.ts";
import { threadForkPrefix } from "./threadForkCutoff.ts";

const sourceThreadId = ThreadId.make("thread-fork-source");
const targetThreadId = ThreadId.make("thread-fork-target");
const commandId = CommandId.make("cmd-thread-fork");
const createdAt = "2026-08-21T12:00:00.000Z";
const getThreadForkSourceVersion = () => Effect.succeed(42);
const forkProjectionDefaults = {
  hasPendingContextBootstrap: () => Effect.succeed(false),
  getThreadForkSourceVersion,
  getThreadForkMessageCount: () => Effect.succeed(0),
  getProjectShellById: () => Effect.succeed(Option.none()),
};

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
  maxConcurrentSubagents: 4,
  resumeCursor: { threadId: "provider-fork-id" },
} satisfies ProviderSessionForkResult;

it.effect(
  "resolves an exact selected-message cutoff on the authenticated Claude source before provider I/O",
  () =>
    Effect.gen(function* () {
      const messageId = MessageId.make("selected-middle-block");
      const turnId = TurnId.make("selected-turn");
      const claudeSource: OrchestrationThread = {
        ...sourceThread,
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "sonnet" },
        session: {
          ...sourceThread.session,
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        },
        messages: [
          {
            id: messageId,
            turnId,
            role: "assistant",
            text: "Selected",
            streaming: false,
            createdAt,
            updatedAt: createdAt,
          },
        ],
        checkpoints: [
          {
            turnId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("refs/fixture/1"),
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("later-final-block"),
            completedAt: createdAt,
          },
        ],
      };
      const forkSession = vi.fn<ProviderServiceShape["forkSession"]>((input) =>
        Effect.succeed({
          ...nativeFork,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          messageCutoff: input.messageCutoff,
          retainedMessageIds: [messageId],
        }),
      );
      const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>(() =>
        Effect.succeed({ sequence: 1 }),
      );
      const command = {
        type: "thread.fork" as const,
        commandId,
        sourceThreadId,
        targetThreadId,
        sourceMessageId: messageId,
        title: "Selected fork",
        createdAt,
      };
      const run = (
        source: OrchestrationThread,
        selected = messageId,
        completeMessageCount = source.messages.length,
      ) =>
        dispatchProviderNativeThreadFork({
          command: { ...command, sourceMessageId: selected },
          orchestrationEngine: { dispatch },
          projectionSnapshotQuery: {
            ...forkProjectionDefaults,
            getThreadForkMessageCount: () => Effect.succeed(completeMessageCount),
            getThreadDetailById: () => Effect.succeed(Option.some(source)),
          },
          providerService: { forkSession, discardSessionFork: () => Effect.void },
        });
      yield* run(claudeSource);
      const expected = {
        sourceMessageId: messageId,
        turnId,
        retainedTurnCount: 1,
        includesCompleteTurn: false,
      };
      assert.deepEqual(forkSession.mock.calls[0]?.[0].messageCutoff, expected);
      assert.deepInclude(dispatch.mock.calls[0]?.[0], { messageCutoff: expected });
      for (const source of [
        sourceThread,
        { ...claudeSource, checkpoints: [] },
        { ...claudeSource, messages: [] },
      ]) {
        const result = yield* run(source).pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
      }
      assert.equal(
        (yield* run(claudeSource, MessageId.make("another-chat-message")).pipe(Effect.exit))._tag,
        "Failure",
      );
      // A bounded detail tail must never masquerade as the full projection. The
      // native map's larger retention limit cannot authorize dropping older rows.
      for (const count of [2, 2001])
        assert.equal(
          (yield* run(claudeSource, messageId, count).pipe(Effect.exit))._tag,
          "Failure",
        );
      assert.equal(forkSession.mock.calls.length, 1);
      // Simulate a persisted/reloaded partial fork: its deliberately interrupted
      // endpoint has no filesystem checkpoint, yet its exact native ordinal is
      // retained by the provider. A successive fork must still reach that adapter.
      const partial = JSON.parse(
        JSON.stringify(threadForkPrefix(claudeSource, expected, [messageId])),
      ) as OrchestrationThread;
      assert.equal(partial.checkpoints.length, 0);
      yield* run(partial);
      assert.deepEqual(forkSession.mock.calls[1]?.[0].messageCutoff, expected);
    }),
);

for (const admission of ["pending", "unreadable"] as const) {
  it.effect(
    `refuses ${admission} copied context before native fork or standalone ownership`,
    () => {
      const forkSession = vi.fn<ProviderServiceShape["forkSession"]>(() =>
        Effect.succeed(nativeFork),
      );
      const discardSessionFork = vi.fn<ProviderServiceShape["discardSessionFork"]>(
        () => Effect.void,
      );
      const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>(() =>
        Effect.succeed({ sequence: 1 }),
      );
      const readExisting = vi.fn(() => Effect.succeed("/server-owned-neutral"));
      const resolve = vi.fn(() => Effect.succeed("/server-owned-neutral"));
      const remove = vi.fn(() => Effect.succeed(undefined));
      const shareFork = vi.fn(() => Effect.succeed(undefined));
      const discardFork = vi.fn(() => Effect.succeed(undefined));
      const hasPendingContextBootstrap = vi.fn<
        ProjectionSnapshotQueryShape["hasPendingContextBootstrap"]
      >(() =>
        admission === "pending"
          ? Effect.succeed(true)
          : Effect.fail(
              new PersistenceSqlError({
                operation: "fixture-read",
                detail: "Synthetic missing admission database",
              }),
            ),
      );
      return Effect.gen(function* () {
        const error = yield* dispatchProviderNativeThreadFork({
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
            ...forkProjectionDefaults,
            hasPendingContextBootstrap,
            getThreadDetailById: () =>
              Effect.succeed(
                Option.some({
                  ...sourceThread,
                  projectId: null,
                  branch: null,
                  worktreePath: null,
                }),
              ),
          },
          providerService: { forkSession, discardSessionFork },
          standaloneWorkspaces: { readExisting, resolve, remove, shareFork, discardFork },
        }).pipe(Effect.flip);
        assert.equal(
          "_tag" in error ? error._tag : undefined,
          admission === "pending" ? "OrchestrationDispatchCommandError" : "PersistenceSqlError",
        );
        if (admission === "pending")
          assert.match(
            error.message,
            /Send a normal message in this copied chat before creating a native fork/,
          );
        assert.deepEqual(hasPendingContextBootstrap.mock.calls, [[sourceThreadId]]);
        for (const operation of [
          forkSession,
          discardSessionFork,
          dispatch,
          readExisting,
          resolve,
          remove,
          shareFork,
          discardFork,
        ])
          assert.equal(operation.mock.calls.length, 0);
      });
    },
  );
}

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
      projectionSnapshotQuery: { ...forkProjectionDefaults, getThreadDetailById },
      providerService: { forkSession, discardSessionFork },
    }).pipe(Effect.exit);

    assert.equal(Exit.isFailure(exit), true);
    assert.deepEqual(forkSession.mock.calls[0]?.[0], {
      operationId: commandId,
      sourceThreadId,
      sourceVersion: 42,
      expectedCwd: "/repo/fork",
      targetThreadId,
      title: "Source (fork)",
    });
    assert.equal(dispatch.mock.calls[0]?.[0].type, "thread.fork.commit");
    const committed = dispatch.mock.calls[0]?.[0];
    assert.equal(
      committed?.type === "thread.fork.commit" && committed.session.maxConcurrentSubagents,
      4,
    );
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
          ...forkProjectionDefaults,
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

it.effect(
  "retains native fork evidence when cancellation loses the queued commit acknowledgment",
  () =>
    Effect.gen(function* () {
      const enqueued = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const result = yield* Deferred.make<{ sequence: number }>();
      // Model the engine's independently-owned queue worker exactly: cancellation
      // of the RPC waiter does not cancel an already-enqueued database commit.
      const worker = yield* Effect.gen(function* () {
        yield* Deferred.await(enqueued);
        yield* Deferred.await(releaseCommit);
        yield* Deferred.succeed(committed, undefined);
        yield* Deferred.succeed(result, { sequence: 43 });
      }).pipe(Effect.forkChild);
      const discardSessionFork = vi.fn<ProviderServiceShape["discardSessionFork"]>(
        () => Effect.void,
      );
      const request = yield* dispatchProviderNativeThreadFork({
        command: {
          type: "thread.fork",
          commandId,
          sourceThreadId,
          targetThreadId,
          title: "Fork",
          createdAt,
        },
        orchestrationEngine: {
          dispatch: () =>
            Deferred.succeed(enqueued, undefined).pipe(Effect.andThen(Deferred.await(result))),
        },
        projectionSnapshotQuery: {
          ...forkProjectionDefaults,
          getThreadDetailById: () => Effect.succeed(Option.some(sourceThread)),
        },
        providerService: { forkSession: () => Effect.succeed(nativeFork), discardSessionFork },
      }).pipe(Effect.forkChild);
      yield* Deferred.await(enqueued);
      yield* Fiber.interrupt(request);
      assert.equal(discardSessionFork.mock.calls.length, 0);
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Deferred.await(committed);
      yield* Fiber.join(worker);
      assert.equal(discardSessionFork.mock.calls.length, 0);
    }),
);

it.effect(
  "rejects changing source authority during its initial detail read before native I/O",
  () =>
    Effect.gen(function* () {
      let version = 41;
      const forkSession = vi.fn<ProviderServiceShape["forkSession"]>(() =>
        Effect.succeed(nativeFork),
      );
      const result = yield* dispatchProviderNativeThreadFork({
        command: {
          type: "thread.fork",
          commandId,
          sourceThreadId,
          targetThreadId,
          title: "Fork",
          createdAt,
        },
        orchestrationEngine: { dispatch: () => Effect.succeed({ sequence: 43 }) },
        projectionSnapshotQuery: {
          ...forkProjectionDefaults,
          getThreadForkSourceVersion: () => Effect.sync(() => ++version),
          getThreadDetailById: () => Effect.succeed(Option.some(sourceThread)),
        },
        providerService: { forkSession, discardSessionFork: () => Effect.void },
      }).pipe(Effect.exit);
      assert.equal(result._tag, "Failure");
      assert.equal(forkSession.mock.calls.length, 0);
    }),
);

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
          ...forkProjectionDefaults,
          getThreadDetailById: () =>
            Effect.succeed(
              Option.some({ ...sourceThread, projectId: null, branch: null, worktreePath: null }),
            ),
        },
        providerService: { forkSession, discardSessionFork },
        standaloneWorkspaces: {
          readExisting: () => Effect.succeed("/server-owned-neutral"),
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
              ...forkProjectionDefaults,
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
