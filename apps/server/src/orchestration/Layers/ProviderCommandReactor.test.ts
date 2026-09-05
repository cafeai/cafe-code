// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as waitForEventLoopTurn } from "node:timers/promises";

import {
  type ChatAttachment,
  ModelSelection,
  type ProviderThreadGoal,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SESSION_TITLE_MAX_CHARS,
} from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@cafecode/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { TextGeneration, type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  isProviderInstanceMissingError,
  providerErrorLabel,
  providerErrorLabelFromInstanceHint,
  ProviderCommandReactorLive,
} from "./ProviderCommandReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionAcceptedCodexSteerCandidate,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "../../git/GitWorkflowService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const liveDurableRuntimeOwnerPayload = () => {
  const now = new Date().toISOString();
  return {
    runtimeOwnerId: "00000000-0000-4000-8000-000000000001",
    runtimeOwnerPid: process.pid,
    runtimeOwnerStartedAt: now,
    runtimeOwnerHeartbeatAt: now,
  };
};

const deriveServerPathsSync = (baseDir: string, devUrl: URL | undefined) =>
  Effect.runSync(deriveServerPaths(baseDir, devUrl).pipe(Effect.provide(NodeServices.layer)));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    if (await predicate()) {
      return;
    }
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    // Reactor fibers can enqueue Node I/O while advancing. Yield a macrotask instead of
    // recursively spinning Effect fibers so the work under test gets a deterministic turn.
    await waitForEventLoopTurn();
  }
}

describe("ProviderCommandReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderCommandReactor | ProjectionSnapshotQuery,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const createdStateDirs = new Set<string>();
  const createdBaseDirs = new Set<string>();

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const stateDir of createdStateDirs) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
    createdStateDirs.clear();
    for (const baseDir of createdBaseDirs) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
    createdBaseDirs.clear();
  });

  describe("provider error attribution", () => {
    it("uses the current provider instance slug when current instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "codex_personal",
          modelSelectionInstanceId: "codex",
          sessionProvider: "codex",
        }),
      ).toBe("codex_personal");
    });

    it("uses the desired provider instance slug when desired instance lookup fails", () => {
      expect(
        providerErrorLabelFromInstanceHint({
          instanceId: "claude_openrouter",
        }),
      ).toBe("claude_openrouter");
    });

    it("uses the unknown driver kind when the resolved driver is not registered locally", () => {
      expect(providerErrorLabel("third_party_driver")).toBe("third_party_driver");
    });

    it("preserves provider daemon transport failures as operational errors", () => {
      const error = new ProviderAdapterRequestError({
        provider: "provider-daemon",
        method: "getInstanceInfo",
        detail: "connect ECONNREFUSED /tmp/provider-daemon.sock",
      });

      expect(isProviderInstanceMissingError(error)).toBe(false);
    });

    it("recognizes a typed remote registry miss", () => {
      const error = new ProviderAdapterRequestError({
        provider: "provider-daemon",
        method: "getInstanceInfo",
        detail: "ProviderUnsupportedError: provider instance is not configured",
        remoteErrorTag: "ProviderUnsupportedError",
      });

      expect(isProviderInstanceMissingError(error)).toBe(true);
    });
  });

  async function createHarness(input?: {
    readonly baseDir?: string;
    readonly threadModelSelection?: ModelSelection;
    readonly missingProviderInstanceIds?: ReadonlySet<string>;
    readonly sessionModelSwitch?: "unsupported" | "restart-resume" | "in-session";
    readonly liveSteer?: "supported" | "unsupported";
    readonly threadGoals?: "supported" | "unsupported";
    readonly startReactor?: boolean;
    readonly getCodexSteerAcceptanceEvidence?: ProjectionSnapshotQueryShape["getCodexSteerAcceptanceEvidence"];
    readonly beforeCodexSteerDeliveryAttemptDispatch?: Effect.Effect<void>;
  }) {
    const now = "2026-01-01T00:00:00.000Z";
    const baseDir = input?.baseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "t3code-reactor-"));
    createdBaseDirs.add(baseDir);
    const { stateDir, systemPromptPath } = deriveServerPathsSync(baseDir, undefined);
    createdStateDirs.add(stateDir);
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    let nextSessionIndex = 1;
    let nextGoalRevision = 1;
    const runtimeSessions: Array<ProviderSession> = [];
    const durableProviderBindings: Array<ProviderRuntimeBindingWithMetadata> = [];
    let providerGoal: ProviderThreadGoal | null = null;
    const goalOperations: string[] = [];
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSession = vi.fn((_: unknown, input: unknown) => {
      const sessionIndex = nextSessionIndex++;
      const resumeCursor =
        typeof input === "object" && input !== null && "resumeCursor" in input
          ? input.resumeCursor
          : undefined;
      const threadId =
        typeof input === "object" &&
        input !== null &&
        "threadId" in input &&
        typeof input.threadId === "string"
          ? ThreadId.make(input.threadId)
          : ThreadId.make(`thread-${sessionIndex}`);
      const inputModelSelection =
        typeof input === "object" && input !== null && "modelSelection" in input
          ? (input.modelSelection as ModelSelection | undefined)
          : undefined;
      const providerInstanceId =
        typeof input === "object" && input !== null && "providerInstanceId" in input
          ? (input.providerInstanceId as ProviderInstanceId | undefined)
          : inputModelSelection?.instanceId;
      const provider =
        typeof input === "object" &&
        input !== null &&
        "provider" in input &&
        typeof input.provider === "string"
          ? (input.provider as ProviderSession["provider"])
          : ProviderDriverKind.make(inputModelSelection?.instanceId ?? modelSelection.instanceId);
      const session: ProviderSession = {
        provider,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        status: "ready" as const,
        runtimeMode:
          typeof input === "object" &&
          input !== null &&
          "runtimeMode" in input &&
          (input.runtimeMode === "approval-required" ||
            input.runtimeMode === "auto-accept-edits" ||
            input.runtimeMode === "full-access")
            ? input.runtimeMode
            : "full-access",
        ...(typeof input === "object" &&
        input !== null &&
        "interactionMode" in input &&
        (input.interactionMode === "default" ||
          input.interactionMode === "plan" ||
          input.interactionMode === "auto")
          ? { interactionMode: input.interactionMode }
          : {}),
        ...(typeof input === "object" &&
        input !== null &&
        "cwd" in input &&
        typeof input.cwd === "string"
          ? { cwd: input.cwd }
          : {}),
        ...((inputModelSelection?.model ?? modelSelection.model)
          ? { model: inputModelSelection?.model ?? modelSelection.model }
          : {}),
        ...(inputModelSelection ? { modelSelection: inputModelSelection } : {}),
        threadId,
        resumeCursor: resumeCursor ?? { opaque: `resume-${sessionIndex}` },
        createdAt: now,
        updatedAt: now,
      };
      const existingSessionIndex = runtimeSessions.findIndex(
        (candidate) => candidate.threadId === threadId,
      );
      if (existingSessionIndex >= 0) {
        runtimeSessions.splice(existingSessionIndex, 1, session);
      } else {
        runtimeSessions.push(session);
      }
      return Effect.succeed(session);
    });
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((input) => {
      const threadId = input.threadId;
      return Effect.succeed({
        threadId,
        turnId: asTurnId("turn-1"),
      });
    });
    const steerTurn = vi.fn<ProviderServiceShape["steerTurn"]>((_) =>
      Effect.succeed({
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      }),
    );
    const interruptTurn = vi.fn((_: unknown) => Effect.void);
    const getGoal = vi.fn<NonNullable<ProviderServiceShape["getGoal"]>>(() =>
      Effect.succeed(providerGoal),
    );
    const setGoal = vi.fn<NonNullable<ProviderServiceShape["setGoal"]>>((goalInput) => {
      const objective = goalInput.objective ?? providerGoal?.objective ?? "Test goal";
      const updatedAt = new Date(Date.parse(now) + nextGoalRevision++ * 1_000).toISOString();
      const nextGoal: ProviderThreadGoal = {
        threadId: goalInput.threadId,
        objective,
        status: goalInput.status ?? providerGoal?.status ?? "active",
        tokenBudget:
          goalInput.tokenBudget === undefined
            ? (providerGoal?.tokenBudget ?? null)
            : goalInput.tokenBudget,
        tokensUsed: providerGoal?.tokensUsed ?? 0,
        timeUsedSeconds: providerGoal?.timeUsedSeconds ?? 0,
        createdAt: providerGoal?.createdAt ?? updatedAt,
        updatedAt,
      };
      providerGoal = nextGoal;
      goalOperations.push("set");
      return Effect.succeed(nextGoal);
    });
    const clearGoal = vi.fn<NonNullable<ProviderServiceShape["clearGoal"]>>(() => {
      providerGoal = null;
      goalOperations.push("clear");
      return Effect.succeed({ cleared: true });
    });
    const respondToRequest = vi.fn<ProviderServiceShape["respondToRequest"]>(() => Effect.void);
    const respondToUserInput = vi.fn<ProviderServiceShape["respondToUserInput"]>(() => Effect.void);
    const snoozeUserInput = vi.fn<ProviderServiceShape["snoozeUserInput"]>(() => Effect.void);
    const listSessions = vi.fn<ProviderServiceShape["listSessions"]>(() =>
      Effect.succeed(runtimeSessions),
    );
    const getBinding = vi.fn((threadId: ThreadId) =>
      Effect.succeed(
        Option.fromNullishOr(
          durableProviderBindings.find((binding) => binding.threadId === threadId),
        ),
      ),
    );
    const stopSession = vi.fn((input: unknown) =>
      Effect.sync(() => {
        const threadId =
          typeof input === "object" && input !== null && "threadId" in input
            ? (input as { threadId?: ThreadId }).threadId
            : undefined;
        if (!threadId) {
          return;
        }
        const index = runtimeSessions.findIndex((session) => session.threadId === threadId);
        if (index >= 0) {
          runtimeSessions.splice(index, 1);
        }
      }),
    );
    const renameBranch = vi.fn((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "newBranch" in input &&
          typeof input.newBranch === "string"
            ? input.newBranch
            : "renamed-branch",
      }),
    );
    const refreshStatus = vi.fn((_: string) =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: true,
        isDefaultRef: false,
        refName: "renamed-branch",
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: true,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      }),
    );
    const generateBranchName = vi.fn<TextGenerationShape["generateBranchName"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateBranchName",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadTitle = vi.fn<TextGenerationShape["generateThreadTitle"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "disabled in test harness",
        }),
      ),
    );
    const generateThreadMetadata = vi.fn<TextGenerationShape["generateThreadMetadata"]>((_) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadMetadata",
          detail: "disabled in test harness",
        }),
      ),
    );

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
    const service: ProviderServiceShape = {
      startSession: startSession as ProviderServiceShape["startSession"],
      forkSession: () => unsupported(),
      discardSessionFork: () => unsupported(),
      sendTurn: sendTurn as ProviderServiceShape["sendTurn"],
      steerTurn: steerTurn as ProviderServiceShape["steerTurn"],
      interruptTurn: interruptTurn as ProviderServiceShape["interruptTurn"],
      respondToRequest: respondToRequest as ProviderServiceShape["respondToRequest"],
      respondToUserInput: respondToUserInput as ProviderServiceShape["respondToUserInput"],
      snoozeUserInput,
      stopSession: stopSession as ProviderServiceShape["stopSession"],
      quiesceThreadForHardDelete: () => unsupported(),
      restartProviderRuntime: () => unsupported(),
      listSessions,
      getCapabilities: (_provider) =>
        Effect.succeed({
          sessionModelSwitch: input?.sessionModelSwitch ?? "in-session",
          liveSteer: input?.liveSteer ?? "unsupported",
          threadGoals: input?.threadGoals ?? "unsupported",
        }),
      getInstanceInfo: (instanceId) => {
        const raw = String(instanceId);
        if (input?.missingProviderInstanceIds?.has(raw)) {
          return Effect.fail(
            new ProviderAdapterRequestError({
              provider: raw,
              method: "getInstanceInfo",
              detail: `Provider instance '${raw}' is not configured.`,
            }),
          );
        }
        const driverKind = ProviderDriverKind.make(
          raw.startsWith("claude") ? "claudeAgent" : raw.startsWith("codex") ? "codex" : raw,
        );
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey:
              driverKind === ProviderDriverKind.make("codex")
                ? "codex:home:/shared-codex"
                : `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      readSubagentDetail: () => unsupported(),
      getGoal,
      setGoal,
      clearGoal,
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerCommandEngineLayer =
      input?.beforeCodexSteerDeliveryAttemptDispatch === undefined
        ? orchestrationLayer
        : Layer.effect(
            OrchestrationEngineService,
            Effect.map(Effect.service(OrchestrationEngineService), (engine) => ({
              ...engine,
              dispatch: (command: Parameters<typeof engine.dispatch>[0]) =>
                command.type === "thread.activity.append" &&
                command.activity.kind === "provider.turn.steer.delivery-attempted"
                  ? input.beforeCodexSteerDeliveryAttemptDispatch!.pipe(
                      Effect.andThen(engine.dispatch(command)),
                    )
                  : engine.dispatch(command),
            })),
          ).pipe(Layer.provide(orchestrationLayer));
    const baseProjectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer =
      input?.getCodexSteerAcceptanceEvidence === undefined
        ? baseProjectionSnapshotLayer
        : Layer.effect(
            ProjectionSnapshotQuery,
            Effect.map(Effect.service(ProjectionSnapshotQuery), (query) => ({
              ...query,
              getCodexSteerAcceptanceEvidence: input.getCodexSteerAcceptanceEvidence!,
            })),
          ).pipe(Layer.provide(baseProjectionSnapshotLayer));
    const layer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(providerCommandEngineLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(Layer.succeed(ProviderService, service)),
      Layer.provideMerge(
        Layer.mock(ProviderSessionDirectory)({
          getBinding,
          listBindings: () => Effect.succeed([...durableProviderBindings]),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(GitWorkflowService)({
          renameBranch,
        } satisfies Partial<GitWorkflowServiceShape>),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.die("refreshLocalStatus should not be called in this test"),
          refreshStatus,
          streamStatus: () => Stream.die("streamStatus should not be called in this test"),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TextGeneration, {
          generateBranchName,
          generateThreadTitle,
          generateThreadMetadata,
        }),
      ),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    const startReactor = () => Effect.runPromise(reactor.start().pipe(Scope.provide(scope!)));
    if (input?.startReactor !== false) {
      await startReactor();
    }
    const drain = () => Effect.runPromise(reactor.drain);
    const markThreadReady = async (
      threadId = ThreadId.make("thread-1"),
      updatedAt = now,
    ): Promise<void> => {
      const snapshot = await Effect.runPromise(snapshotQuery.getSnapshot());
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      const session = thread?.session;
      if (!session) {
        throw new Error(`Cannot mark thread '${threadId}' ready without a projected session.`);
      }
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-session-ready-${crypto.randomUUID()}`),
          threadId,
          session: {
            ...session,
            status: "ready",
            activeTurnId: null,
            lastError: null,
            updatedAt,
          },
          createdAt: updatedAt,
        }),
      );
    };
    const setRunningCodexTurn = async (
      turnId: TurnId,
      updatedAt: string,
      threadId = ThreadId.make("thread-1"),
    ): Promise<void> => {
      await Effect.runPromise(
        engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-running-codex-${crypto.randomUUID()}`),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt,
          },
          createdAt: updatedAt,
        }),
      );
      const session: ProviderSession = {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        runtimeMode: "approval-required",
        threadId,
        activeTurnId: turnId,
        resumeCursor: { opaque: `resume-${turnId}` },
        createdAt: updatedAt,
        updatedAt,
      };
      const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === threadId);
      if (existingIndex >= 0) {
        runtimeSessions.splice(existingIndex, 1, session);
      } else {
        runtimeSessions.push(session);
      }
    };

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModelSelection: modelSelection,
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      readThreadDetail: async (threadId: ThreadId) =>
        Option.getOrUndefined(await Effect.runPromise(snapshotQuery.getThreadDetailById(threadId))),
      getUnsettledCodexSteerIntentEvents: () =>
        Effect.runPromise(snapshotQuery.getUnsettledCodexSteerIntentEvents()),
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      getGoal,
      setGoal,
      clearGoal,
      goalOperations,
      respondToRequest,
      respondToUserInput,
      snoozeUserInput,
      listSessions,
      getBinding,
      stopSession,
      renameBranch,
      refreshStatus,
      generateBranchName,
      generateThreadTitle,
      generateThreadMetadata,
      runtimeSessions,
      durableProviderBindings,
      stateDir,
      systemPromptPath,
      startReactor,
      drain,
      markThreadReady,
      setRunningCodexTurn,
    };
  }

  it("passes a bounded existing Cafe title into Claude session startup", async () => {
    const harness = await createHarness({
      threadModelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-5",
      ),
    });
    const title = `Cafe task ${"x".repeat(PROVIDER_SESSION_TITLE_MAX_CHARS)}`;
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-native-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-start-native-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-native-title"),
          role: "user",
          text: "Perform the requested task.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: "claudeAgent",
      title: title.slice(0, PROVIDER_SESSION_TITLE_MAX_CHARS),
    });
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("replaces a Codex goal with an ordered clear then active unbudgeted set", async () => {
    const harness = await createHarness({ threadGoals: "supported" });
    const threadId = ThreadId.make("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make("cmd-goal-create"),
        threadId,
        objective: "First objective",
        status: "active",
        tokenBudget: 10_000,
        expectedUpdatedAt: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return readModel.threads.some(
        (thread) => thread.id === threadId && thread.goal?.objective === "First objective",
      );
    });
    const firstReadModel = await harness.readModel();
    const firstGoal = firstReadModel.threads.find((thread) => thread.id === threadId)?.goal;
    expect(firstGoal).toBeDefined();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make("cmd-goal-replace"),
        threadId,
        objective: "Replacement objective",
        replaceExisting: true,
        expectedUpdatedAt: firstGoal?.updatedAt ?? null,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return readModel.threads.some(
        (thread) => thread.id === threadId && thread.goal?.objective === "Replacement objective",
      );
    });

    expect(harness.goalOperations).toEqual(["set", "clear", "set"]);
    expect(harness.setGoal.mock.calls[1]?.[0]).toEqual({
      threadId,
      objective: "Replacement objective",
      status: "active",
      tokenBudget: null,
    });
    const readModel = await harness.readModel();
    expect(readModel.threads.find((thread) => thread.id === threadId)?.goal).toMatchObject({
      objective: "Replacement objective",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
    });
  });

  it("clears interrupted turn starts on startup without resending provider work", async () => {
    const harness = await createHarness({ startReactor: false });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-before-restart"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-before-restart"),
          role: "user",
          text: "hello before restart",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    expect(harness.sendTurn).not.toHaveBeenCalled();
    await harness.startReactor();

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.session?.status === "ready" &&
        thread.session.activeTurnId === null &&
        thread.activities.some((activity) => activity.kind === "provider.turn.start.failed")
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.lastError).toContain("before a provider turn started");
    expect(harness.sendTurn).not.toHaveBeenCalled();
  });

  it("closes a projected running turn on startup when its provider session is gone", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-orphaned-by-restart");
    const startedAt = "2026-01-01T00:00:01.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-before-restart"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: startedAt,
        },
        createdAt: startedAt,
      }),
    );

    await harness.startReactor();

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      return (
        thread?.session?.status === "interrupted" &&
        thread.session.activeTurnId === null &&
        thread.latestTurn?.state === "interrupted" &&
        thread.latestTurn.completedAt !== null
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.lastError).toContain("provider process ended");
    expect(
      thread?.activities.some(
        (activity) =>
          activity.kind === "runtime.warning" &&
          activity.summary === "Provider turn interrupted by restart",
      ),
    ).toBe(true);
    expect(harness.interruptTurn).not.toHaveBeenCalled();
  });

  it("preserves a running turn owned by a detached provider's durable binding", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-owned-by-detached-daemon");
    const startedAt = "2026-01-01T00:00:01.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-detached-provider"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: startedAt,
        },
        createdAt: startedAt,
      }),
    );
    harness.durableProviderBindings.push({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      runtimePayload: { activeTurnId: turnId, ...liveDurableRuntimeOwnerPayload() },
      resumeCursor: { opaque: "resume-detached-codex" },
      lastSeenAt: startedAt,
    });

    await harness.startReactor();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.status).toBe("running");
    expect(thread?.session?.activeTurnId).toBe(turnId);
    expect(thread?.latestTurn?.state).toBe("running");
    expect(
      thread?.activities.some(
        (activity) => activity.summary === "Provider turn interrupted by restart",
      ),
    ).toBe(false);
    expect(harness.interruptTurn).not.toHaveBeenCalled();
  });

  it("rejects a stale durable running binding as provider liveness", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-owned-by-stale-provider-process");
    const startedAt = "2026-01-01T00:00:01.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-stale-provider"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: startedAt,
        },
        createdAt: startedAt,
      }),
    );
    harness.durableProviderBindings.push({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      runtimePayload: {
        activeTurnId: turnId,
        runtimeOwnerId: "00000000-0000-4000-8000-000000000002",
        runtimeOwnerPid: process.pid,
        runtimeOwnerStartedAt: startedAt,
        runtimeOwnerHeartbeatAt: startedAt,
      },
      resumeCursor: { opaque: "resume-stale-codex" },
      lastSeenAt: new Date().toISOString(),
    });

    await harness.startReactor();

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      return (
        thread?.session?.status === "interrupted" &&
        thread.session.activeTurnId === null &&
        thread.latestTurn?.state === "interrupted"
      );
    });
    expect(harness.interruptTurn).not.toHaveBeenCalled();
  });

  it("restores a falsely orphaned terminal projection when durable ownership remains live", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-falsely-closed-by-auxiliary-backend");
    const startedAt = "2026-01-01T00:00:01.000Z";
    const falselyInterruptedAt = "2026-01-01T00:00:02.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-before-false-orphan-repair"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: startedAt,
        },
        createdAt: startedAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("server:test:false-orphan-session-terminal"),
        threadId,
        session: {
          threadId,
          status: "interrupted",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: "Incorrect orphan repair",
          updatedAt: falselyInterruptedAt,
        },
        createdAt: falselyInterruptedAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("server:test:false-orphan-marker"),
        threadId,
        activity: {
          id: EventId.make("activity-false-orphan-marker"),
          tone: "error",
          kind: "runtime.warning",
          summary: "Provider turn interrupted by restart",
          payload: {
            message: "Provider turn interrupted by restart",
            detail: "Incorrect orphan repair",
            recovery: "orphaned-active-turn",
          },
          turnId,
          createdAt: falselyInterruptedAt,
        },
        createdAt: falselyInterruptedAt,
      }),
    );
    harness.durableProviderBindings.push({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      runtimePayload: { activeTurnId: turnId, ...liveDurableRuntimeOwnerPayload() },
      resumeCursor: { opaque: "resume-still-live" },
      lastSeenAt: falselyInterruptedAt,
    });

    await harness.startReactor();

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const candidate = readModel.threads.find((entry) => entry.id === threadId);
      return (
        candidate?.session?.status === "running" &&
        candidate.session.activeTurnId === turnId &&
        candidate.latestTurn?.state === "running"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.session?.lastError).toBeNull();
    expect(thread?.latestTurn?.completedAt).toBeNull();
    expect(
      thread?.activities.some(
        (activity) =>
          activity.summary === "Live provider turn restored after restart reconciliation",
      ),
    ).toBe(true);
    expect(harness.interruptTurn).not.toHaveBeenCalled();
  });

  it("retries a durable Stop on startup when the provider still owns the same turn", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-stop-survived-backend-restart");
    const startedAt = "2026-01-01T00:00:01.000Z";
    const interruptedAt = "2026-01-01T00:00:02.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-before-stop"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          providerInstanceId: ProviderInstanceId.make("grok"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: startedAt,
        },
        createdAt: startedAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-stop-before-backend-restart"),
        threadId,
        turnId,
        createdAt: interruptedAt,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("grok"),
      providerInstanceId: ProviderInstanceId.make("grok"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: turnId,
      resumeCursor: { opaque: "resume-live-grok" },
      createdAt: startedAt,
      updatedAt: interruptedAt,
    });

    await harness.startReactor();
    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);

    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({ threadId, turnId });
    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      return Boolean(
        thread?.activities.some(
          (activity) => activity.summary === "Provider turn interrupt restored after restart",
        ),
      );
    });
  });

  it("reacts to thread.turn.start by ensuring session and sending provider turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-1"),
          role: "user",
          text: "hello reactor",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      input: "hello reactor",
    });
    expect(harness.startSession.mock.calls[0]?.[0]).toEqual(ThreadId.make("thread-1"));
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("prepends the configured system prompt to the first provider turn only", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const attachments = [
      {
        type: "image" as const,
        id: "attachment-1",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 128,
      },
    ] as unknown as ChatAttachment[];
    fs.mkdirSync(path.dirname(harness.systemPromptPath), { recursive: true });
    fs.writeFileSync(harness.systemPromptPath, "  Follow the repository rules.  \n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-system-prompt"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-system-prompt"),
          role: "user",
          text: "implement the feature",
          attachments,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      input: "System prompt:\nFollow the repository rules.\n\nUser request:\nimplement the feature",
      attachments,
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.messages.find((message) => message.id === "user-message-system-prompt")).toEqual(
      expect.objectContaining({
        role: "user",
        text: "implement the feature",
      }),
    );
  });

  it("does not prepend a blank system prompt or apply the prompt to later provider turns", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    fs.mkdirSync(path.dirname(harness.systemPromptPath), { recursive: true });
    fs.writeFileSync(harness.systemPromptPath, " \n\t\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-blank-system-prompt"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-blank-system-prompt"),
          role: "user",
          text: "first message",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      input: "first message",
    });

    await harness.markThreadReady();
    fs.writeFileSync(harness.systemPromptPath, "Now active", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-system-prompt-follow-up"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-system-prompt-follow-up"),
          role: "user",
          text: "second message",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:01:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      input: "second message",
    });
  });

  it("routes turn starts through live steer when the Codex runtime still owns an active turn", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const runtimeActiveTurnId = asTurnId("runtime-active-turn");
    fs.mkdirSync(path.dirname(harness.systemPromptPath), { recursive: true });
    fs.writeFileSync(harness.systemPromptPath, "Do not inject into steers.", "utf8");
    harness.steerTurn.mockImplementationOnce((input) =>
      Effect.succeed({
        threadId: input.threadId,
        turnId: input.expectedTurnId,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: runtimeActiveTurnId,
      resumeCursor: { opaque: "resume-runtime-active" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-routed-to-steer"),
        threadId,
        message: {
          messageId: asMessageId("user-message-routed-to-steer"),
          role: "user",
          text: "this should steer the active turn",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.5",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    expect(harness.steerTurn.mock.calls[0]?.[0]).toEqual({
      threadId,
      expectedTurnId: runtimeActiveTurnId,
      messageId: asMessageId("user-message-routed-to-steer"),
      input: "this should steer the active turn",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      return (
        thread?.session?.status === "running" &&
        thread.session.activeTurnId === runtimeActiveTurnId &&
        thread.activities.some(
          (activity) =>
            activity.kind === "runtime.warning" &&
            activity.summary === "Turn start routed to active steer",
        )
      );
    });
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.latestTurn).toMatchObject({
      turnId: runtimeActiveTurnId,
      state: "running",
    });
    expect(thread?.messages.some((message) => message.id === "user-message-routed-to-steer")).toBe(
      true,
    );
  });

  it("marks the turn running from sendTurn success when the provider omits turn.started", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-without-provider-started"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-without-provider-started"),
          role: "user",
          text: "hello without provider turn started event",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.session?.status === "running" &&
        thread.session.activeTurnId === asTurnId("turn-1") &&
        thread.latestTurn?.turnId === asTurnId("turn-1") &&
        thread.latestTurn.state === "running"
      );
    });

    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it("generates a thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";
    harness.generateThreadTitle.mockReturnValue(Effect.succeed({ title: "Generated title" }));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    expect(harness.generateThreadTitle.mock.calls[0]?.[0]).toMatchObject({
      message: "Please investigate reconnect failures after restarting the session.",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Generated title"
      );
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Generated title");
  });

  it("does not overwrite an existing custom thread title on the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Please investigate reconnect failures after restar...";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-custom"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-preserve"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-preserve"),
          role: "user",
          text: "Please investigate reconnect failures after restarting the session.",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Keep this custom title");
  });

  it("matches the client-seeded title even when the outgoing prompt is reformatted", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const seededTitle = "Fix reconnect spinner on resume";
    harness.generateThreadTitle.mockReturnValue(
      Effect.succeed({
        title: "Reconnect spinner resume bug",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-title-formatted-seed"),
        threadId: ThreadId.make("thread-1"),
        title: seededTitle,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-title-formatted"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-title-formatted"),
          role: "user",
          text: "[effort:high]\\n\\nFix reconnect spinner on resume",
          attachments: [],
        },
        titleSeed: seededTitle,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateThreadTitle.mock.calls.length === 1);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      return (
        readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"))?.title ===
        "Reconnect spinner resume bug"
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.title).toBe("Reconnect spinner resume bug");
  });

  it("generates a worktree branch name for the first turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-branch"),
        threadId: ThreadId.make("thread-1"),
        title: "Keep this custom title",
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    harness.generateBranchName.mockImplementation((input: unknown) =>
      Effect.succeed({
        branch:
          typeof input === "object" &&
          input !== null &&
          "modelSelection" in input &&
          typeof input.modelSelection === "object" &&
          input.modelSelection !== null &&
          "model" in input.modelSelection &&
          typeof input.modelSelection.model === "string"
            ? `feature/${input.modelSelection.model}`
            : "feature/generated",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-branch-model"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-branch-model"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.generateBranchName.mock.calls.length === 1);
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    expect(harness.generateBranchName.mock.calls[0]?.[0]).toMatchObject({
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
  });

  it("generates and applies first-turn title and branch with one deduplicated request", async () => {
    const harness = await createHarness();
    harness.generateThreadMetadata.mockReturnValue(
      Effect.succeed({ title: "Safer reconnect backoff", branch: "safer-reconnect" }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-combined-metadata-setup"),
        threadId: ThreadId.make("thread-1"),
        title: "New thread",
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    const command = {
      type: "thread.turn.start" as const,
      commandId: CommandId.make("cmd-combined-metadata-turn"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: asMessageId("combined-metadata-message"),
        role: "user" as const,
        text: "Add a safer reconnect backoff.",
        attachments: [],
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    await Effect.runPromise(harness.engine.dispatch(command));
    await Effect.runPromise(harness.engine.dispatch(command));
    await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
    await waitFor(
      async () => (await harness.readModel()).threads[0]?.title === "Safer reconnect backoff",
    );
    expect(harness.generateThreadMetadata).toHaveBeenCalledTimes(1);
    expect(harness.generateThreadMetadata.mock.calls[0]?.[0]).toMatchObject({
      cwd: "/tmp/provider-project-worktree",
      message: "Add a safer reconnect backoff.",
    });
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.renameBranch).toHaveBeenCalledTimes(1);
    expect(harness.sendTurn).toHaveBeenCalledTimes(1);
  });

  it.each(["title", "branch", "rename-failure"] as const)(
    "applies combined metadata independently after %s changes during generation",
    async (changed) => {
      const harness = await createHarness();
      const generation = Effect.runSync(Deferred.make<{ title: string; branch: string }>());
      harness.generateThreadMetadata.mockReturnValue(Deferred.await(generation));
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-pending-metadata-setup"),
          threadId: ThreadId.make("thread-1"),
          title: "New thread",
          branch: "t3code/1234abcd",
          worktreePath: "/tmp/provider-project-worktree",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-pending-metadata-turn"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("pending-metadata-message"),
            role: "user",
            text: "Add a safer reconnect backoff.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await waitFor(() => harness.generateThreadMetadata.mock.calls.length === 1);
      if (changed === "rename-failure") {
        harness.renameBranch.mockReturnValue(Effect.die("Simulated Git rename failure"));
      } else {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-pending-metadata-user-edit"),
            threadId: ThreadId.make("thread-1"),
            ...(changed === "title" ? { title: "User title" } : { branch: "user-branch" }),
          }),
        );
      }
      await Effect.runPromise(
        Deferred.succeed(generation, {
          title: "Generated title",
          branch: "generated-branch",
        }),
      );
      if (changed === "title") {
        await waitFor(() => harness.refreshStatus.mock.calls.length === 1);
      } else {
        await waitFor(
          async () => (await harness.readModel()).threads[0]?.title === "Generated title",
        );
      }
      const thread = (await harness.readModel()).threads[0];
      expect(thread?.title).toBe(changed === "title" ? "User title" : "Generated title");
      if (changed === "branch") {
        expect(thread?.branch).toBe("user-branch");
        expect(harness.renameBranch).not.toHaveBeenCalled();
      }
      expect(harness.generateBranchName).not.toHaveBeenCalled();
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    },
  );

  it("keeps the main turn running when combined metadata generation fails without paid retries", async () => {
    const harness = await createHarness();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-failed-metadata-setup"),
        threadId: ThreadId.make("thread-1"),
        title: "New thread",
        branch: "t3code/1234abcd",
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-failed-metadata-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("failed-metadata-message"),
          role: "user",
          text: "Add a safer reconnect backoff.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.generateThreadMetadata).toHaveBeenCalledTimes(1);
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.renameBranch).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.title).toBe("New thread");
    expect(thread?.branch).toBe("t3code/1234abcd");

    // Failure leaves both labels eligible, but a later user turn must still
    // respect the first-message admission guard instead of retrying inference.
    await harness.markThreadReady();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-metadata-second-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("metadata-second-message"),
          role: "user",
          text: "Also check the reconnect timeout.",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:01:00.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.generateThreadMetadata).toHaveBeenCalledTimes(1);
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
  });

  it("forwards provider model options through session start and turn send", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const scenarios = [
      {
        name: "Codex reasoning and fast mode",
        threadId: ThreadId.make("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ]),
      },
      {
        name: "Claude effort",
        threadId: ThreadId.make("thread-options-claude-effort"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
      },
      {
        name: "Claude fast mode",
        threadId: ThreadId.make("thread-options-claude-fast"),
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "fastMode", value: true }],
        ),
      },
    ] as const;

    for (const [index, scenario] of scenarios.entries()) {
      if (scenario.threadId !== ThreadId.make("thread-1")) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`cmd-create-${scenario.threadId}`),
            threadId: scenario.threadId,
            projectId: asProjectId("project-1"),
            title: scenario.name,
            modelSelection: scenario.modelSelection,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            branch: null,
            worktreePath: null,
            createdAt: now,
          }),
        );
      }

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-turn-options-${index}`),
          threadId: scenario.threadId,
          message: {
            messageId: asMessageId(`user-message-options-${index}`),
            role: "user",
            text: scenario.name,
            attachments: [],
          },
          modelSelection: scenario.modelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

      await waitFor(() => harness.startSession.mock.calls.length === index + 1);
      await waitFor(() => harness.sendTurn.mock.calls.length === index + 1);
      expect(harness.startSession.mock.calls[index]?.[1], scenario.name).toMatchObject({
        modelSelection: scenario.modelSelection,
      });
      expect(harness.sendTurn.mock.calls[index]?.[0], scenario.name).toMatchObject({
        threadId: scenario.threadId,
        modelSelection: scenario.modelSelection,
      });
    }
  });

  it("forwards plan interaction mode to the provider turn request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-set-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-plan"),
          role: "user",
          text: "plan this change",
          attachments: [],
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      interactionMode: "plan",
    });
  });

  it("preserves the active session model when in-session model switching is unsupported", async () => {
    const harness = await createHarness({ sessionModelSwitch: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.markThreadReady();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unsupported-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unsupported-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
    });
  });

  it("starts a first turn on the requested provider instance even when it differs from the thread model", async () => {
    const harness = await createHarness({
      threadModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-first"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-first"),
          role: "user",
          text: "hello claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession).toHaveBeenCalledTimes(1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBeUndefined();
  });

  it("switches providers instead of steering a stale active runtime and records the switch", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      liveSteer: "supported",
    });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-before-switch"),
        threadId,
        message: {
          messageId: asMessageId("user-message-claude-before-switch"),
          role: "user",
          text: "start with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    const claudeSession = harness.runtimeSessions[0];
    if (!claudeSession) {
      throw new Error("Expected the Claude runtime session to exist.");
    }
    harness.runtimeSessions[0] = {
      ...claudeSession,
      status: "running",
      activeTurnId: asTurnId("stale-claude-active-turn"),
    };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-codex-provider-switch"),
        threadId,
        message: {
          messageId: asMessageId("user-message-codex-provider-switch"),
          role: "user",
          text: "continue with codex",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      return thread?.activities.some((activity) => activity.kind === "provider.switched") ?? false;
    });

    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
    });

    const readModel = await harness.readModel();
    const switchActivity = readModel.threads
      .find((entry) => entry.id === threadId)
      ?.activities.find((activity) => activity.kind === "provider.switched");
    expect(switchActivity).toMatchObject({
      tone: "info",
      summary: "Switched from Claude to Codex · gpt-5.6-sol",
      turnId: asTurnId("turn-1"),
      payload: {
        fromProvider: ProviderDriverKind.make("claudeAgent"),
        fromProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
        fromModel: "claude-sonnet-4-6",
        toProvider: ProviderDriverKind.make("codex"),
        toProviderInstanceId: ProviderInstanceId.make("codex"),
        toModel: "gpt-5.6-sol",
      },
    });
  });

  it("reuses the same provider session when runtime mode is unchanged", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.markThreadReady();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-unchanged-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-unchanged-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls.length).toBe(1);
    expect(harness.stopSession.mock.calls.length).toBe(0);
  });

  it("restarts an existing Codex thread on a compatible requested instance", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.markThreadReady();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-compatible-codex-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-compatible-codex-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession).toHaveBeenCalledTimes(2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
      resumeCursor: { opaque: "resume-1" },
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
  });

  it("restarts the provider session when the thread workspace changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-1"),
          role: "user",
          text: "first in project root",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.markThreadReady();
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      cwd: "/tmp/provider-project",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-thread-worktree-change"),
        threadId: ThreadId.make("thread-1"),
        worktreePath: "/tmp/provider-project-worktree",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-workspace-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-workspace-2"),
          role: "user",
          text: "second in worktree",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project-worktree",
      resumeCursor: { opaque: "resume-1" },
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("restarts claude sessions when claude effort changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-1"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "medium" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.markThreadReady();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-effort-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-effort-2"),
          role: "user",
          text: "second claude turn",
          attachments: [],
        },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-sonnet-4-6",
          [{ id: "effort", value: "max" }],
        ),
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: createModelSelection(
        ProviderInstanceId.make("claudeAgent"),
        "claude-sonnet-4-6",
        [{ id: "effort", value: "max" }],
      ),
    });
  });

  it("restart-resumes Grok for reasoning and model changes without dropping native context", async () => {
    const initialSelection = createModelSelection(ProviderInstanceId.make("grok"), "grok-4.6", [
      { id: "reasoningEffort", value: "high" },
    ]);
    const harness = await createHarness({
      threadModelSelection: initialSelection,
      sessionModelSwitch: "restart-resume",
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-grok-restart-resume-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-grok-restart-resume-1"),
          role: "user",
          text: "first grok turn",
          attachments: [],
        },
        modelSelection: initialSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.markThreadReady();

    const lowerEffortSelection = createModelSelection(ProviderInstanceId.make("grok"), "grok-4.6", [
      { id: "reasoningEffort", value: "low" },
    ]);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-grok-restart-resume-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-grok-restart-resume-2"),
          role: "user",
          text: "use lower effort",
          attachments: [],
        },
        modelSelection: lowerEffortSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: lowerEffortSelection,
    });
    await harness.markThreadReady();

    const changedModelSelection = createModelSelection(
      ProviderInstanceId.make("grok"),
      "grok-4.5",
      [{ id: "reasoningEffort", value: "low" }],
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-grok-restart-resume-3"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-grok-restart-resume-3"),
          role: "user",
          text: "switch models",
          attachments: [],
        },
        modelSelection: changedModelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 3);
    await waitFor(() => harness.sendTurn.mock.calls.length === 3);
    expect(harness.startSession.mock.calls[2]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      modelSelection: changedModelSelection,
    });
    expect(harness.sendTurn.mock.calls[2]?.[0]).toMatchObject({
      modelSelection: changedModelSelection,
    });
    await harness.markThreadReady();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-grok-restart-resume-plan"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-grok-restart-resume-plan"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-grok-restart-resume-plan"),
          role: "user",
          text: "plan this next",
          attachments: [],
        },
        modelSelection: changedModelSelection,
        interactionMode: "plan",
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 4);
    expect(harness.startSession.mock.calls[3]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      interactionMode: "plan",
      runtimeMode: "approval-required",
    });
    await waitFor(() => harness.sendTurn.mock.calls.length === 4);
    await harness.markThreadReady();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make("cmd-interaction-mode-grok-restart-resume-auto"),
        threadId: ThreadId.make("thread-1"),
        interactionMode: "auto",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-grok-restart-resume-auto"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "auto-accept-edits",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-grok-restart-resume-auto"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-grok-restart-resume-auto"),
          role: "user",
          text: "continue in auto",
          attachments: [],
        },
        modelSelection: changedModelSelection,
        interactionMode: "auto",
        runtimeMode: "auto-accept-edits",
        createdAt: now,
      }),
    );
    await waitFor(() => harness.startSession.mock.calls.length === 5);
    expect(harness.startSession.mock.calls[4]?.[1]).toMatchObject({
      resumeCursor: { opaque: "resume-1" },
      interactionMode: "auto",
      runtimeMode: "auto-accept-edits",
    });
  });

  it("starts a fresh provider session without resume state when a thread switches drivers", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-claude-before-cross-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-claude-before-cross-provider-switch"),
          role: "user",
          text: "first claude turn",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-claude-before-cross-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-claude-before-cross-provider-switch"),
        turnId: asTurnId("turn-1"),
        delta: "Claude inspected the workspace and changed apps/server/src/provider.ts.",
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-claude-complete-before-cross-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        messageId: asMessageId("assistant-message-claude-before-cross-provider-switch"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.messages.some(
          (message) =>
            message.id === "assistant-message-claude-before-cross-provider-switch" &&
            message.role === "assistant" &&
            message.text.includes("Claude inspected the workspace") &&
            !message.streaming,
        ) ?? false
      );
    });
    await harness.markThreadReady();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-codex-after-cross-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-codex-after-cross-provider-switch"),
          role: "user",
          text: "continue with codex",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.3-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.3-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.3-codex",
      },
    });
    const codexTurnInput = harness.sendTurn.mock.calls[1]?.[0];
    const codexPrompt =
      typeof codexTurnInput === "object" &&
      codexTurnInput !== null &&
      "input" in codexTurnInput &&
      typeof codexTurnInput.input === "string"
        ? codexTurnInput.input
        : "";
    expect(codexPrompt).toContain("You are taking over an existing Cafe Code chat");
    expect(codexPrompt).toContain("User:\nfirst claude turn");
    expect(codexPrompt).toContain("Assistant:\nClaude inspected the workspace");
    expect(codexPrompt).toContain("Current user request:\ncontinue with codex");
  });

  it("ignores stale unknown persisted session instances when starting the selected provider", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-fable-5",
        options: [
          { id: "effort", value: "max" },
          { id: "contextWindow", value: "1m" },
        ],
      },
      missingProviderInstanceIds: new Set(["codex"]),
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale-unknown-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError:
            "Thread 'thread-1' references unknown provider instance 'codex'. The instance is not configured in this build.",
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-after-stale-session-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-after-stale-session-instance"),
          role: "user",
          text: "continue with the selected Claude model",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-fable-5",
        options: [
          { id: "effort", value: "max" },
          { id: "contextWindow", value: "1m" },
        ],
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe(ProviderDriverKind.make("claudeAgent"));
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(thread?.session?.lastError).toBeNull();
  });

  it("restarts the provider session when runtime mode is updated on the thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.markThreadReady();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-1"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-runtime-mode-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-runtime-mode-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      resumeCursor: { opaque: "resume-1" },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
  });

  it("does not inject derived model options when restarting claude on runtime mode changes", async () => {
    const harness = await createHarness({
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-runtime-mode-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-claude-no-options"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
  });

  it("does not stop the active session when restart fails before rebind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-initial-full-access-2"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-restart-failure-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-restart-failure-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.markThreadReady();

    harness.startSession.mockImplementationOnce(
      (_: unknown, __: unknown) => Effect.fail("simulated restart failure") as never,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("cmd-runtime-mode-set-restart-failure"),
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return thread?.runtimeMode === "approval-required";
    });
    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await harness.drain();

    expect(harness.stopSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(1);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.runtimeMode).toBe("full-access");
  });

  it("starts a fresh provider session when a bound idle thread switches drivers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-1"),
          role: "user",
          text: "first",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.markThreadReady();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-provider-switch-2"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-provider-switch-2"),
          role: "user",
          text: "second",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 2);
    await waitFor(() => harness.sendTurn.mock.calls.length === 2);

    expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[1]?.[1]).not.toHaveProperty("resumeCursor");
    expect(harness.stopSession.mock.calls.length).toBe(0);

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(thread?.session?.runtimeMode).toBe("approval-required");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(false);
  });

  it("starts the requested provider after the existing thread session has stopped", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "stopped",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stopped-provider-switch"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stopped-provider-switch"),
          role: "user",
          text: "continue with claude",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.startSession.mock.calls[0]?.[1]).not.toHaveProperty("resumeCursor");
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session?.providerName).toBe("claudeAgent");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
    ).toBe(false);
  });

  it("reacts to thread.turn.interrupt-requested by calling provider interrupt", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.interrupt.completed" &&
            activity.turnId === asTurnId("turn-1"),
        ) ?? false
      );
    });
  });

  it("pauses and durably synchronizes an active Codex goal after interrupt", async () => {
    const harness = await createHarness({ threadGoals: "supported" });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-with-active-goal");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make("cmd-goal-before-interrupt"),
        threadId,
        objective: "Continue autonomously",
        status: "active",
        tokenBudget: null,
        expectedUpdatedAt: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.setGoal.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-running-session-before-goal-interrupt"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-interrupt-active-goal"),
        threadId,
        turnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    await waitFor(() => harness.setGoal.mock.calls.length === 2);
    expect(harness.setGoal.mock.calls[1]?.[0]).toEqual({
      threadId,
      status: "paused",
    });

    await waitFor(async () => {
      const readModel = await harness.readModel();
      return readModel.threads.find((entry) => entry.id === threadId)?.goal?.status === "paused";
    });
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(thread?.goal?.status).toBe("paused");
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.interrupt.completed"),
    ).toBe(true);
  });

  it("retargets provider interrupts to the runtime active turn when projection is stale", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const projectedTurnId = asTurnId("projected-stale-turn");
    const runtimeActiveTurnId = asTurnId("runtime-active-turn");

    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId,
      activeTurnId: runtimeActiveTurnId,
      resumeCursor: { opaque: "resume-runtime-active" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale-interrupt"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: projectedTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-retarget"),
        threadId,
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId,
      turnId: runtimeActiveTurnId,
    });

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.find(
        (activity) =>
          activity.kind === "runtime.warning" &&
          activity.summary === "Interrupt retargeted to provider active turn",
      ),
    ).toMatchObject({
      turnId: runtimeActiveTurnId,
      payload: {
        projectedTurnId,
        runtimeActiveTurnId,
      },
    });
  });

  it("falls back to the session active turn id for provider interrupts", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-interrupt-fallback"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-from-session"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-turn-interrupt-fallback"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
    expect(harness.interruptTurn.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      turnId: "turn-from-session",
    });
  });

  it("routes live steer requests to providers that support steering", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-steer"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-turn-steer"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-steer"),
          role: "user",
          text: "adjust course",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    expect(harness.steerTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      expectedTurnId: asTurnId("turn-1"),
      messageId: asMessageId("user-message-steer"),
      input: "adjust course",
    });
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === ThreadId.make("thread-1"),
      );
      return (
        thread?.activities.some((activity) => {
          const payload = activity.payload as Readonly<Record<string, unknown>> | undefined;
          return (
            activity.kind === "provider.turn.steer.accepted" &&
            activity.turnId === asTurnId("turn-1") &&
            payload?.messageId === asMessageId("user-message-steer")
          );
        }) ?? false
      );
    });
  });

  it("delivers two durable steers in order without waiting for provider processing", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const threadId = ThreadId.make("thread-1");
    const expectedTurnId = asTurnId("turn-1");
    await harness.setRunningCodexTurn(expectedTurnId, "2026-01-01T00:00:01.000Z");
    const firstAck = Effect.runSync(
      Deferred.make<{ readonly threadId: ThreadId; readonly turnId: TurnId }>(),
    );
    harness.steerTurn.mockImplementationOnce(() => Deferred.await(firstAck));
    const commands = ["first", "second"].map((name, index) => ({
      type: "thread.turn.steer" as const,
      commandId: CommandId.make(`cmd-consecutive-steer-${name}`),
      threadId,
      message: {
        messageId: asMessageId(`message-consecutive-steer-${name}`),
        role: "user" as const,
        text: `${name} correction`,
        attachments: [],
      },
      createdAt: `2026-01-01T00:00:0${index + 2}.000Z`,
    }));

    await Effect.runPromise(harness.engine.dispatch(commands[0]!));
    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    await Effect.runPromise(harness.engine.dispatch(commands[1]!));
    // Admission is durable and ordered, but the first provider ACK is not a
    // processing barrier for a second message. Replaying the second command
    // receipt must not append or deliver that input twice.
    await Effect.runPromise(harness.engine.dispatch(commands[1]!));
    await waitFor(() => harness.steerTurn.mock.calls.length === 2);

    await Effect.runPromise(Deferred.succeed(firstAck, { threadId, turnId: expectedTurnId }));
    await harness.drain();
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.filter((activity) => activity.kind === "provider.turn.steer.accepted")
          .length === 2
      );
    });
    expect(harness.steerTurn.mock.calls.map(([input]) => input.messageId)).toEqual(
      commands.map((command) => command.message.messageId),
    );
    expect(
      harness.steerTurn.mock.calls.every(([input]) => input.expectedTurnId === expectedTurnId),
    ).toBe(true);
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.interruptTurn).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId)!;
    expect(
      thread.messages.filter((message) =>
        commands.some((command) => command.message.messageId === message.id),
      ),
    ).toHaveLength(2);
    expect(
      thread.activities.filter((activity) => activity.kind === "provider.turn.steer.accepted"),
    ).toHaveLength(2);
  });

  it("replays a crash-before-provider-call steer only to its persisted turn", async () => {
    const harness = await createHarness({ liveSteer: "supported", startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const expectedTurnId = asTurnId("turn-crash-before-steer-call");
    const messageId = asMessageId("message-crash-before-steer-call");
    await harness.setRunningCodexTurn(expectedTurnId, "2026-01-01T00:00:01.000Z");
    harness.steerTurn.mockImplementationOnce(() =>
      Effect.succeed({ threadId, turnId: expectedTurnId }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-crash-before-steer-call"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "deliver after restart",
          attachments: [],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    expect(harness.steerTurn).not.toHaveBeenCalled();

    await harness.startReactor();
    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    expect(harness.steerTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      expectedTurnId,
      messageId,
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.steer.accepted" &&
            (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
              messageId,
        ) === true
      );
    });
    expect(await harness.getUnsettledCodexSteerIntentEvents()).toEqual([]);
  });

  it("fails closed while a provider mutation is attempted but its receipt is unresolved", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const threadId = ThreadId.make("thread-1");
    const expectedTurnId = asTurnId("turn-provider-io-crash-window");
    const messageId = asMessageId("message-provider-io-crash-window");
    await harness.setRunningCodexTurn(expectedTurnId, "2026-01-01T00:00:01.000Z");
    const steerAck = Effect.runSync(
      Deferred.make<{ readonly threadId: ThreadId; readonly turnId: TurnId }>(),
    );
    harness.steerTurn.mockImplementationOnce(() => Deferred.await(steerAck));

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-provider-io-crash-window"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "deliver no more than once",
          attachments: [],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    const threadDuringProviderIo = await harness.readThreadDetail(threadId);
    expect(
      threadDuringProviderIo?.activities.find(
        (activity) =>
          activity.kind === "provider.turn.steer.delivery-attempted" &&
          (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
            messageId,
      ),
    ).toMatchObject({
      turnId: expectedTurnId,
      payload: {
        provider: "codex",
        intentSequence: expect.any(Number),
        delivery: "live-steer",
        deliveryState: "attempted",
        reason: "live-steer",
        expectedTurnId,
      },
    });
    // This is the exact crash window: provider I/O is in flight and no
    // acceptance receipt exists. A fresh reactor query must not blindly replay
    // an attempted mutation whose external outcome is now ambiguous.
    expect(await harness.getUnsettledCodexSteerIntentEvents()).toEqual([]);

    await Effect.runPromise(Deferred.succeed(steerAck, { threadId, turnId: expectedTurnId }));
    await waitFor(async () => {
      const thread = await harness.readThreadDetail(threadId);
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.accepted") ===
        true
      );
    });
  });

  it("honors Stop committed while the delivery-attempt marker is waiting to persist", async () => {
    const markerDispatchStarted = Effect.runSync(Deferred.make<void>());
    const releaseMarkerDispatch = Effect.runSync(Deferred.make<void>());
    const harness = await createHarness({
      liveSteer: "supported",
      beforeCodexSteerDeliveryAttemptDispatch: Effect.gen(function* () {
        yield* Deferred.succeed(markerDispatchStarted, undefined);
        yield* Deferred.await(releaseMarkerDispatch);
      }),
    });
    const threadId = ThreadId.make("thread-1");
    const expectedTurnId = asTurnId("turn-stop-before-attempt-marker");
    const messageId = asMessageId("message-stop-before-attempt-marker");
    await harness.setRunningCodexTurn(expectedTurnId, "2026-01-01T00:00:01.000Z");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-steer-before-deferred-attempt-marker"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "do not deliver after Stop",
          attachments: [],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(Deferred.await(markerDispatchStarted));

    // The provider worker is paused immediately before the attempt append.
    // Stop commits directly through the engine, then the marker is allowed to
    // persist. The post-marker fence must observe Stop and skip provider I/O.
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-stop-before-deferred-attempt-marker"),
        threadId,
        turnId: expectedTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await Effect.runPromise(Deferred.succeed(releaseMarkerDispatch, undefined));

    await waitFor(async () => {
      const thread = await harness.readThreadDetail(threadId);
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.steer.failed" &&
            (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
              messageId,
        ) === true
      );
    });
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    const thread = await harness.readThreadDetail(threadId);
    expect(
      thread?.activities.find(
        (activity) =>
          activity.kind === "provider.turn.steer.delivery-attempted" &&
          (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
            messageId,
      ),
    ).toBeDefined();
  });

  it("queues a crash-before-call steer behind a later Stop intent", async () => {
    const harness = await createHarness({ liveSteer: "supported", startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const expectedTurnId = asTurnId("turn-before-restart-stop");
    const messageId = asMessageId("message-before-restart-stop");
    await harness.setRunningCodexTurn(expectedTurnId, "2026-01-01T00:00:01.000Z");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-steer-before-restart-stop"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "keep queued after Stop",
          attachments: [],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make("cmd-stop-after-persisted-steer"),
        threadId,
        turnId: expectedTurnId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );

    await harness.startReactor();
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.steer.failed" &&
            (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
              messageId,
        ) === true
      );
    });
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.find(
        (activity) =>
          activity.kind === "provider.turn.steer.failed" &&
          (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
            messageId,
      ),
    ).toMatchObject({ payload: { recoveryBarrier: "turn-interrupt-requested" } });
  });

  it("queues a crash-before-call steer behind a later session stop", async () => {
    const harness = await createHarness({ liveSteer: "supported", startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const expectedTurnId = asTurnId("turn-before-session-stop");
    const messageId = asMessageId("message-before-session-stop");
    await harness.setRunningCodexTurn(expectedTurnId, "2026-01-01T00:00:01.000Z");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-steer-before-session-stop"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "keep queued after session stop",
          attachments: [],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop-after-persisted-steer"),
        threadId,
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );

    await harness.startReactor();
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.steer.failed" &&
            (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
              messageId,
        ) === true
      );
    });
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.find(
        (activity) =>
          activity.kind === "provider.turn.steer.failed" &&
          (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
            messageId,
      ),
    ).toMatchObject({ payload: { recoveryBarrier: "session-stop-requested" } });
  });

  it("does not redirect a crash-before-call T1 steer into a materialized T2", async () => {
    const harness = await createHarness({ liveSteer: "supported", startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const expectedTurnId = asTurnId("turn-before-newer-t2");
    const newerTurnId = asTurnId("turn-newer-t2");
    const messageId = asMessageId("message-before-newer-t2");
    await harness.setRunningCodexTurn(expectedTurnId, "2026-01-01T00:00:01.000Z");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-steer-before-newer-t2"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "never inject into T2",
          attachments: [],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.setRunningCodexTurn(newerTurnId, "2026-01-01T00:00:03.000Z");

    await harness.startReactor();
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.steer.failed" &&
            (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
              messageId,
        ) === true
      );
    });
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.find(
        (activity) =>
          activity.kind === "provider.turn.steer.failed" &&
          (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
            messageId,
      ),
    ).toMatchObject({ payload: { recoveryBarrier: "newer-turn-active" } });
  });

  it("does not let a delayed steer ACK replace a newer active turn", async () => {
    let acceptedBarrier: ProjectionAcceptedCodexSteerCandidate | undefined;
    const harness = await createHarness({
      liveSteer: "supported",
      getCodexSteerAcceptanceEvidence: (input) => {
        if (input?.exactAcceptedBarrier !== undefined) {
          acceptedBarrier = input.exactAcceptedBarrier;
        }
        return Effect.succeed([]);
      },
    });
    const threadId = ThreadId.make("thread-1");
    const firstTurnId = asTurnId("turn-1");
    const newerTurnId = asTurnId("turn-2");
    const startedAt = "2026-01-01T00:00:01.000Z";
    const newerAt = "2026-01-01T00:00:03.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-start-before-delayed-steer-ack"),
        threadId,
        message: {
          messageId: asMessageId("user-start-before-delayed-steer-ack"),
          role: "user",
          text: "begin",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: startedAt,
      }),
    );
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return thread?.session?.activeTurnId === firstTurnId;
    });

    const runtimeSession = harness.runtimeSessions.find((entry) => entry.threadId === threadId);
    expect(runtimeSession).toBeDefined();
    harness.runtimeSessions.splice(0, harness.runtimeSessions.length, {
      ...runtimeSession!,
      status: "running",
      activeTurnId: firstTurnId,
      updatedAt: startedAt,
    });

    const steerAck = Effect.runSync(
      Deferred.make<{ readonly threadId: ThreadId; readonly turnId: TurnId }>(),
    );
    harness.steerTurn.mockImplementationOnce(() => Deferred.await(steerAck));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-delayed-steer-ack"),
        threadId,
        message: {
          messageId: asMessageId("user-delayed-steer-ack"),
          role: "user",
          text: "change course",
          attachments: [],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await waitFor(() => harness.steerTurn.mock.calls.length === 1);

    harness.runtimeSessions.splice(0, harness.runtimeSessions.length, {
      ...runtimeSession!,
      status: "running",
      activeTurnId: newerTurnId,
      updatedAt: newerAt,
    });
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-newer-session-before-steer-ack"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: newerTurnId,
          lastError: null,
          updatedAt: newerAt,
        },
        createdAt: newerAt,
      }),
    );
    await Effect.runPromise(Deferred.succeed(steerAck, { threadId, turnId: firstTurnId }));

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.accepted") ===
        true
      );
    });
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session).toMatchObject({
      status: "running",
      activeTurnId: newerTurnId,
    });
    expect(acceptedBarrier?.intentCreatedAt).toBe("2026-01-01T00:00:02.000Z");
    expect(acceptedBarrier?.acceptedAt).not.toBe(acceptedBarrier?.intentCreatedAt);
    expect(acceptedBarrier?.eventSequence).toBeGreaterThan(acceptedBarrier?.intentSequence ?? 0);
  });

  it("does not let a send marker overwrite a runtime-only newer turn", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const threadId = ThreadId.make("thread-1");
    const firstTurnId = asTurnId("turn-1");
    const newerTurnId = asTurnId("turn-runtime-only-newer");
    const startedAt = "2026-01-01T00:00:01.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-start-before-runtime-only-newer"),
        threadId,
        message: {
          messageId: asMessageId("user-start-before-runtime-only-newer"),
          role: "user",
          text: "begin",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: startedAt,
      }),
    );
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return thread?.session?.activeTurnId === firstTurnId;
    });

    const runtimeSession = harness.runtimeSessions.find((entry) => entry.threadId === threadId);
    expect(runtimeSession).toBeDefined();
    harness.runtimeSessions.splice(0, harness.runtimeSessions.length, {
      ...runtimeSession!,
      status: "running",
      activeTurnId: firstTurnId,
      updatedAt: startedAt,
    });

    const steerAck = Effect.runSync(
      Deferred.make<{ readonly threadId: ThreadId; readonly turnId: TurnId }>(),
    );
    harness.steerTurn.mockImplementationOnce(() => Deferred.await(steerAck));
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-runtime-only-newer-steer"),
        threadId,
        message: {
          messageId: asMessageId("user-runtime-only-newer-steer"),
          role: "user",
          text: "change course",
          attachments: [],
        },
        createdAt: "2026-01-01T00:00:03.000Z",
      }),
    );
    await waitFor(() => harness.steerTurn.mock.calls.length === 1);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-ready-before-runtime-only-newer-ack"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    harness.listSessions.mockImplementationOnce(() =>
      Effect.sync(() => {
        const firstTurnSnapshot = [...harness.runtimeSessions];
        harness.runtimeSessions.splice(0, harness.runtimeSessions.length, {
          ...runtimeSession!,
          status: "running",
          activeTurnId: newerTurnId,
          updatedAt: "2026-01-01T00:00:04.000Z",
        });
        return firstTurnSnapshot;
      }),
    );
    await Effect.runPromise(Deferred.succeed(steerAck, { threadId, turnId: firstTurnId }));

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.accepted") ===
        true
      );
    });
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session).toMatchObject({ status: "ready", activeTurnId: null });
    expect(harness.runtimeSessions[0]?.activeTurnId).toBe(newerTurnId);
  });

  it("does not recover a terminal steer while a detached durable owner still runs it", async () => {
    const threadId = ThreadId.make("thread-1");
    const staleTurnId = asTurnId("turn-owned-by-detached-recovery-runtime");
    const messageId = asMessageId("message-owned-by-detached-recovery-runtime");
    const harness = await createHarness({
      liveSteer: "supported",
      getCodexSteerAcceptanceEvidence: () =>
        Effect.succeed([
          {
            threadId,
            acceptedTurnId: staleTurnId,
            intentSequence: 1,
            clientCorrelationId: null,
            messageId,
            messageTurnId: staleTurnId,
            messageText: "do not duplicate detached work",
            messageAttachments: [],
            acceptedAt: "2026-01-01T00:00:02.000Z",
            turnState: "completed",
            turnCompletedAt: "2026-01-01T00:00:03.000Z",
            processingObserved: false,
            recoveryObserved: false,
            interruptRequested: false,
            sessionStopRequested: false,
          },
        ]),
    });
    harness.durableProviderBindings.push({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      runtimePayload: { activeTurnId: staleTurnId, ...liveDurableRuntimeOwnerPayload() },
      resumeCursor: { opaque: "resume-detached-terminal-recovery" },
      lastSeenAt: "2026-01-01T00:00:03.000Z",
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("server:terminal-recovery-detached-owner"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "do not duplicate detached work",
          attachments: [],
        },
        terminalRecovery: { staleTurnId, intentSequence: 1 },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );
    await harness.drain();

    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.steerTurn).not.toHaveBeenCalled();
  });

  it.each(["local-missing", "local-malformed", "durable-missing", "durable-malformed"] as const)(
    "fails closed for %s running ownership without an exact active turn",
    async (variant) => {
      const threadId = ThreadId.make("thread-1");
      const staleTurnId = asTurnId(`turn-unresolved-${variant}`);
      const messageId = asMessageId(`message-unresolved-${variant}`);
      const harness = await createHarness({
        liveSteer: "supported",
        getCodexSteerAcceptanceEvidence: () =>
          Effect.succeed([
            {
              threadId,
              acceptedTurnId: staleTurnId,
              intentSequence: 1,
              clientCorrelationId: null,
              messageId,
              messageTurnId: staleTurnId,
              messageText: "do not duplicate unresolved live ownership",
              messageAttachments: [],
              acceptedAt: "2026-01-01T00:00:02.000Z",
              turnState: "completed",
              turnCompletedAt: "2026-01-01T00:00:03.000Z",
              processingObserved: false,
              recoveryObserved: false,
              interruptRequested: false,
              sessionStopRequested: false,
            },
          ]),
      });

      if (variant.startsWith("local")) {
        harness.runtimeSessions.push({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running",
          runtimeMode: "approval-required",
          threadId,
          ...(variant === "local-malformed" ? { activeTurnId: "" as TurnId } : {}),
          resumeCursor: { opaque: `resume-${variant}` },
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:03.000Z",
        });
      } else {
        harness.durableProviderBindings.push({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running",
          runtimeMode: "approval-required",
          runtimePayload: {
            ...liveDurableRuntimeOwnerPayload(),
            ...(variant === "durable-malformed" ? { activeTurnId: 42 } : {}),
          },
          resumeCursor: { opaque: `resume-${variant}` },
          lastSeenAt: "2026-01-01T00:00:03.000Z",
        });
      }

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.steer",
          commandId: CommandId.make(`server:terminal-recovery-${variant}`),
          threadId,
          message: {
            messageId,
            role: "user",
            text: "do not duplicate unresolved live ownership",
            attachments: [],
          },
          terminalRecovery: { staleTurnId, intentSequence: 1 },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      await harness.drain();

      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.steerTurn).not.toHaveBeenCalled();
    },
  );

  it.each(["local session list", "durable ownership"] as const)(
    "fails closed when the %s read fails during terminal recovery",
    async (failedRead) => {
      const threadId = ThreadId.make("thread-1");
      const staleTurnId = asTurnId(`turn-${failedRead.replaceAll(" ", "-")}-failure`);
      const messageId = asMessageId(`message-${failedRead.replaceAll(" ", "-")}-failure`);
      const harness = await createHarness({
        liveSteer: "supported",
        getCodexSteerAcceptanceEvidence: () =>
          Effect.succeed([
            {
              threadId,
              acceptedTurnId: staleTurnId,
              intentSequence: 1,
              clientCorrelationId: null,
              messageId,
              messageTurnId: staleTurnId,
              messageText: "do not recover through an unknown liveness boundary",
              messageAttachments: [],
              acceptedAt: "2026-01-01T00:00:02.000Z",
              turnState: "completed",
              turnCompletedAt: "2026-01-01T00:00:03.000Z",
              processingObserved: false,
              recoveryObserved: false,
              interruptRequested: false,
              sessionStopRequested: false,
            },
          ]),
      });
      if (failedRead === "local session list") {
        harness.listSessions.mockImplementation(() =>
          Effect.die(new Error("simulated local session read failure")),
        );
      } else {
        harness.getBinding.mockImplementation(() =>
          Effect.die(new Error("simulated durable ownership read failure")),
        );
      }

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.steer",
          commandId: CommandId.make(`server:terminal-recovery-${failedRead.replaceAll(" ", "-")}`),
          threadId,
          message: {
            messageId,
            role: "user",
            text: "do not recover through an unknown liveness boundary",
            attachments: [],
          },
          terminalRecovery: { staleTurnId, intentSequence: 1 },
          createdAt: "2026-01-01T00:00:04.000Z",
        }),
      );
      await harness.drain();

      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.steerTurn).not.toHaveBeenCalled();
    },
  );

  it("selects the exact same-tuple acceptance generation before guarded recovery", async () => {
    const threadId = ThreadId.make("thread-1");
    const staleTurnId = asTurnId("turn-terminal-before-guarded-recovery");
    const newerTurnId = asTurnId("turn-newer-before-guarded-recovery");
    const messageId = asMessageId("user-guarded-terminal-recovery-race");
    const harness = await createHarness({
      liveSteer: "supported",
      getCodexSteerAcceptanceEvidence: () =>
        Effect.succeed([
          // The provider may reuse the same MessageId and turn tuple across a
          // retry. An older recovery receipt must not suppress the newer
          // accepted generation selected by terminalRecovery.intentSequence.
          {
            threadId,
            acceptedTurnId: staleTurnId,
            intentSequence: 1,
            clientCorrelationId: null,
            messageId,
            messageTurnId: staleTurnId,
            messageText: "recover me safely",
            messageAttachments: [],
            acceptedAt: "2026-01-01T00:00:01.000Z",
            turnState: "completed",
            turnCompletedAt: "2026-01-01T00:00:03.000Z",
            processingObserved: false,
            recoveryObserved: true,
            interruptRequested: false,
            sessionStopRequested: false,
          },
          {
            threadId,
            acceptedTurnId: staleTurnId,
            intentSequence: 2,
            clientCorrelationId: null,
            messageId,
            messageTurnId: staleTurnId,
            messageText: "recover me safely",
            messageAttachments: [],
            acceptedAt: "2026-01-01T00:00:02.000Z",
            turnState: "completed",
            turnCompletedAt: "2026-01-01T00:00:03.000Z",
            processingObserved: false,
            recoveryObserved: false,
            interruptRequested: false,
            sessionStopRequested: false,
          },
        ]),
    });
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread.turn.start",
          detail: `Cannot start a new Codex turn while active turn '${newerTurnId}' is running.`,
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("server:guarded-terminal-recovery-race"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "recover me safely",
          attachments: [],
        },
        terminalRecovery: { staleTurnId, intentSequence: 2 },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.failed") ===
        true
      );
    });
    expect(harness.steerTurn).not.toHaveBeenCalled();
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      messageId,
      allowActiveTurnSteerFallback: false,
    });
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    const threadDetail = await harness.readThreadDetail(threadId);
    expect(
      threadDetail?.activities.find(
        (activity) =>
          activity.kind === "provider.turn.steer.delivery-attempted" &&
          (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
            messageId,
      ),
    ).toMatchObject({
      turnId: staleTurnId,
      payload: {
        provider: "codex",
        intentSequence: expect.any(Number),
        delivery: "next-turn",
        deliveryState: "attempted",
        reason: "turn-start-after-terminal-unprocessed-steer",
        staleTurnId,
      },
    });
    expect(thread?.activities.at(-1)).toMatchObject({
      kind: "provider.turn.steer.failed",
      payload: {
        messageId,
        retryableFollowUp: true,
        recoveryBarrier: "newer-turn-active",
      },
      turnId: staleTurnId,
    });
  });

  it("fails closed when guarded terminal recovery has no trusted acceptance evidence", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const threadId = ThreadId.make("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("server:guarded-terminal-recovery-without-evidence"),
        threadId,
        message: {
          messageId: asMessageId("user-terminal-recovery-without-evidence"),
          role: "user",
          text: "do not replay without evidence",
          attachments: [],
        },
        terminalRecovery: {
          staleTurnId: asTurnId("turn-without-trusted-evidence"),
          intentSequence: 1,
        },
        createdAt: "2026-01-01T00:00:04.000Z",
      }),
    );

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.messages.some(
          (message) => message.id === asMessageId("user-terminal-recovery-without-evidence"),
        ) === true
      );
    });
    await harness.drain();

    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.steerTurn).not.toHaveBeenCalled();
  });

  it("routes Codex steer while the active turn is running even when assistant text is closed", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const activeTurnId = asTurnId("turn-closed-assistant");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-late-steer"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete-late-steer"),
        threadId,
        messageId: asMessageId("assistant-closed"),
        turnId: activeTurnId,
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-turn-steer-closed-assistant"),
        threadId,
        message: {
          messageId: asMessageId("user-message-late-steer"),
          role: "user",
          text: "new request after closed assistant output",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.messages.some((message) => message.id === "user-message-late-steer")).toBe(true);
    expect(harness.steerTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      expectedTurnId: activeTurnId,
      messageId: asMessageId("user-message-late-steer"),
      input: "new request after closed assistant output",
    });
  });

  it("retries a Codex no-active-turn steer race as the next turn", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const staleTurnId = asTurnId("turn-stale");
    const messageId = asMessageId("user-message-stale-steer");
    harness.steerTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "provider-daemon",
          method: "steerTurn",
          detail: "Provider adapter request failed (codex) for turn/steer: no active turn to steer",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale-steer"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: staleTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-turn-steer-stale"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "continue after the stale active turn",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.steerTurn.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId,
      input: "continue after the stale active turn",
    });

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.steer.failed"),
    ).toBe(false);
    expect(
      thread?.activities.find((activity) => activity.kind === "runtime.warning"),
    ).toMatchObject({
      summary: "Steer retried as next turn",
      payload: {
        recovery: "turn-start-after-no-active-turn",
        messageId,
        staleTurnId,
      },
      turnId: staleTurnId,
    });
    await waitFor(async () => {
      const updatedThread = (await harness.readModel()).threads.find(
        (entry) => entry.id === threadId,
      );
      return (
        updatedThread?.session?.status === "running" &&
        updatedThread.session.activeTurnId === "turn-1" &&
        updatedThread.latestTurn?.turnId === "turn-1" &&
        updatedThread.latestTurn.state === "running"
      );
    });
    const deliveredThread = await harness.readThreadDetail(threadId);
    expect(
      deliveredThread?.activities.find(
        (activity) =>
          activity.kind === "provider.turn.steer.delivered" &&
          (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
            messageId,
      ),
    ).toMatchObject({
      turnId: asTurnId("turn-1"),
      payload: {
        provider: "codex",
        deliveredTurnId: asTurnId("turn-1"),
        delivery: "next-turn",
        reason: "turn-start-after-provider-no-active-turn",
      },
    });
    expect(await harness.getUnsettledCodexSteerIntentEvents()).toEqual([]);
  });

  it("treats stale steer commands on inactive sessions as the next turn", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const now = "2026-01-01T00:00:00.000Z";
    const stoppedThreadId = ThreadId.make("thread-stopped-stale-steer");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-create-stopped-stale-steer-thread"),
        threadId: stoppedThreadId,
        projectId: asProjectId("project-1"),
        title: "Stopped stale steer",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: now,
      }),
    );

    const scenarios = [
      {
        name: "ready session",
        threadId: ThreadId.make("thread-1"),
        status: "ready" as const,
        input: "this should become the next turn",
      },
      {
        name: "starting session without an active turn id",
        threadId: ThreadId.make("thread-1"),
        status: "starting" as const,
        input: "preserve this while the first turn materializes",
      },
      {
        name: "stopped session after restart",
        threadId: stoppedThreadId,
        status: "stopped" as const,
        input: "restart this conversation after app recovery",
      },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`cmd-session-set-${scenario.status}-for-stale-steer`),
          threadId: scenario.threadId,
          session: {
            threadId: scenario.threadId,
            status: scenario.status,
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
          createdAt: now,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.steer",
          commandId: CommandId.make(`cmd-turn-steer-${scenario.status}-session`),
          threadId: scenario.threadId,
          message: {
            messageId: asMessageId(`user-message-${scenario.status}-steer`),
            role: "user",
            text: scenario.input,
            attachments: [],
          },
          createdAt: now,
        }),
      );

      await waitFor(() => harness.sendTurn.mock.calls.length === index + 1);
      expect(harness.sendTurn.mock.calls[index]?.[0], scenario.name).toMatchObject({
        threadId: scenario.threadId,
        input: scenario.input,
      });
      const thread = (await harness.readModel()).threads.find(
        (entry) => entry.id === scenario.threadId,
      );
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.failed"),
        scenario.name,
      ).toBe(false);
    }
    expect(harness.steerTurn.mock.calls.length).toBe(0);
  });

  it("persists restart-safe queue truth when next-turn steer delivery fails", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const threadId = ThreadId.make("thread-1");
    const messageId = asMessageId("message-next-turn-delivery-failed");
    const staleTurnId = asTurnId("turn-next-turn-delivery-failed");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-next-turn-delivery-failed"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: staleTurnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    harness.steerTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "provider-daemon",
          method: "steerTurn",
          detail: "Provider adapter request failed (codex) for turn/steer: no active turn to steer",
        }),
      ),
    );
    harness.sendTurn.mockImplementationOnce(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread.turn.start",
          detail: "simulated provider transport failure",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-next-turn-delivery-failed"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "keep this queued across restart",
          attachments: [],
        },
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );

    await waitFor(async () => {
      const thread = await harness.readThreadDetail(threadId);
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.steer.failed" &&
            (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
              messageId,
        ) === true
      );
    });
    const thread = await harness.readThreadDetail(threadId);
    expect(
      thread?.activities.find(
        (activity) =>
          activity.kind === "provider.turn.steer.failed" &&
          (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
            messageId,
      ),
    ).toMatchObject({
      payload: {
        provider: "codex",
        intentSequence: expect.any(Number),
        retryableFollowUp: true,
        delivery: "next-turn",
        deliveryState: "queued",
        recoveryBarrier: "next-turn-delivery-failed",
        reason: "turn-start-after-provider-no-active-turn",
      },
      turnId: staleTurnId,
    });
    expect(
      thread?.activities.some((activity) => activity.kind === "provider.turn.steer.delivered"),
    ).toBe(false);
    expect(await harness.getUnsettledCodexSteerIntentEvents()).toEqual([]);
  });

  it("spells out Codex review steer rejection as a retryable queued follow-up", async () => {
    const harness = await createHarness({ liveSteer: "supported" });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const activeTurnId = asTurnId("turn-review");
    harness.steerTurn.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "turn/steer",
          detail: "cannot steer a review turn",
          cause: {
            code: -32600,
            errorMessage: "cannot steer a review turn",
            data: {
              message: "cannot steer a review turn",
              codexErrorInfo: {
                activeTurnNotSteerable: {
                  turnKind: "review",
                },
              },
              additionalDetails: null,
            },
          },
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-review-steer"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    const steerReceipt = await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-turn-steer-review"),
        threadId,
        message: {
          messageId: asMessageId("user-message-review-steer"),
          role: "user",
          text: "apply after review",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.steer.failed" &&
            activity.payload !== null &&
            typeof activity.payload === "object" &&
            "retryableFollowUp" in activity.payload,
        ) ?? false
      );
    });

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    const failure = thread?.activities.find(
      (activity) => activity.kind === "provider.turn.steer.failed",
    );
    expect(failure?.payload).toMatchObject({
      messageId: "user-message-review-steer",
      intentSequence: steerReceipt.sequence,
      retryableFollowUp: true,
      retryAfter: "active-turn",
      codexNonSteerableTurnKind: "review",
    });
    expect(JSON.stringify(failure?.payload)).toContain("review active turn");
  });

  it("requeues a rejected Grok interjection instead of exposing the extension error", async () => {
    const harness = await createHarness({
      liveSteer: "supported",
      threadModelSelection: {
        instanceId: ProviderInstanceId.make("grok"),
        model: "grok-4.6",
      },
    });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = ThreadId.make("thread-1");
    const activeTurnId = asTurnId("turn-grok-interject");
    const messageId = asMessageId("user-message-grok-interject");
    harness.steerTurn.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "provider-daemon",
          method: "steerTurn",
          detail:
            "Provider adapter request failed (grok) for x.ai/interject: The ACP provider rejected 'x.ai/interject'.",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-grok-interject"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "grok",
          providerInstanceId: ProviderInstanceId.make("grok"),
          runtimeMode: "approval-required",
          activeTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-turn-steer-grok-interject"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "wrap it up quickly",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      return (
        thread?.activities.some(
          (activity) =>
            activity.kind === "provider.turn.steer.failed" &&
            activity.payload !== null &&
            typeof activity.payload === "object" &&
            "retryableFollowUp" in activity.payload,
        ) ?? false
      );
    });

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    const queued = thread?.activities.find(
      (activity) => activity.kind === "provider.turn.steer.failed",
    );
    expect(queued).toMatchObject({
      summary: "Provider steer queued",
      payload: {
        detail:
          "Cafe Code preserved this follow-up for automatic delivery after the active turn is ready.",
        messageId,
        retryableFollowUp: true,
        retryAfter: "active-turn",
      },
    });
    expect(JSON.stringify(queued?.payload)).not.toContain("x.ai/interject");
  });

  it("does not route steer requests to providers without live steering support", async () => {
    const harness = await createHarness({ liveSteer: "unsupported" });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-steer-unsupported"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-1"),
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.steer",
        commandId: CommandId.make("cmd-turn-steer-unsupported"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-steer-unsupported"),
          role: "user",
          text: "adjust course",
          attachments: [],
        },
        createdAt: now,
      }),
    );

    await harness.drain();
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    expect(harness.steerTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.activities.at(-1)).toMatchObject({
      kind: "provider.turn.steer.failed",
      payload: {
        detail:
          "Cafe Code preserved this follow-up for automatic delivery after the active turn is ready.",
        messageId: "user-message-steer-unsupported",
        retryableFollowUp: true,
        retryAfter: "active-turn",
      },
    });
  });

  it("starts a fresh session when only projected session state exists", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-stale"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-stale"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-stale"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.startSession.mock.calls.length === 1);
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);

    expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "approval-required",
    });
    expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
      threadId: ThreadId.make("thread-1"),
    });
  });

  it("rejects active runtime sessions that are missing provider instance ids", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      cwd: "/tmp/provider-project",
      resumeCursor: { opaque: "resume-without-instance" },
      createdAt: now,
      updatedAt: now,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-missing-instance"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("user-message-missing-instance"),
          role: "user",
          text: "resume codex",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      return (
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed") ??
        false
      );
    });

    expect(harness.startSession.mock.calls.length).toBe(0);
    expect(harness.sendTurn.mock.calls.length).toBe(0);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      thread?.activities.find((activity) => activity.kind === "provider.turn.start.failed"),
    ).toMatchObject({
      payload: {
        detail: expect.stringContaining("without a provider instance id"),
      },
    });
  });

  it("reacts to thread.approval.respond by forwarding provider approval response", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "accept",
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToRequest.mock.calls.length === 1);
    expect(harness.respondToRequest.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "approval-request-1",
      decision: "accept",
    });
  });

  it("reacts to thread.user-input.respond by forwarding structured user input answers", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(() => harness.respondToUserInput.mock.calls.length === 1);
    expect(harness.respondToUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
      answers: {
        sandbox_mode: "workspace-write",
      },
    });
  });

  it("reacts to thread.user-input.snooze without resolving the request", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-snooze"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.snooze",
        commandId: CommandId.make("cmd-user-input-snooze"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.snoozeUserInput.mock.calls.length === 1);
    expect(harness.snoozeUserInput.mock.calls[0]?.[0]).toEqual({
      threadId: "thread-1",
      requestId: "user-input-request-1",
    });
    expect(harness.respondToUserInput).not.toHaveBeenCalled();
  });

  it("surfaces stale provider approval request failures without faking approval resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToRequest.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("codex"),
          method: "session/request_permission",
          detail: "Unknown pending permission request: approval-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-approval-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-approval-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-approval-requested"),
          tone: "approval",
          kind: "approval.requested",
          summary: "Command approval requested",
          payload: {
            requestId: "approval-request-1",
            requestKind: "command",
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make("cmd-approval-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("approval-request-1"),
        decision: "acceptForSession",
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.approval.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.approval.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "approval-request-1",
      detail: expect.stringContaining("Stale pending approval request: approval-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "approval.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "approval-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("surfaces stale provider user-input failures without faking user-input resolution", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    harness.respondToUserInput.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: ProviderDriverKind.make("claudeAgent"),
          method: "item/tool/respondToUserInput",
          detail: "Unknown pending user-input request: user-input-request-1",
        }),
      ),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-user-input-error"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make("cmd-user-input-requested"),
        threadId: ThreadId.make("thread-1"),
        activity: {
          id: EventId.make("activity-user-input-requested"),
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            requestId: "user-input-request-1",
            questions: [
              {
                id: "sandbox_mode",
                header: "Sandbox",
                question: "Which mode should be used?",
                options: [
                  {
                    label: "workspace-write",
                    description: "Allow workspace writes only",
                  },
                ],
              },
            ],
          },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make("cmd-user-input-respond-stale"),
        threadId: ThreadId.make("thread-1"),
        requestId: asApprovalRequestId("user-input-request-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
        createdAt: now,
      }),
    );

    await waitFor(async () => {
      const readModel = await harness.readModel();
      const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      if (!thread) return false;
      return thread.activities.some(
        (activity) => activity.kind === "provider.user-input.respond.failed",
      );
    });

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const failureActivity = thread?.activities.find(
      (activity) => activity.kind === "provider.user-input.respond.failed",
    );
    expect(failureActivity).toBeDefined();
    expect(failureActivity?.payload).toMatchObject({
      requestId: "user-input-request-1",
      detail: expect.stringContaining("Stale pending user-input request: user-input-request-1"),
    });

    const resolvedActivity = thread?.activities.find(
      (activity) =>
        activity.kind === "user-input.resolved" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === "user-input-request-1",
    );
    expect(resolvedActivity).toBeUndefined();
  });

  it("reacts to thread.session.stop by stopping provider session and clearing thread session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-for-stop"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex_work"),
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make("cmd-session-stop"),
        threadId: ThreadId.make("thread-1"),
        createdAt: now,
      }),
    );

    await waitFor(() => harness.stopSession.mock.calls.length === 1);
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.session).not.toBeNull();
    expect(thread?.session?.status).toBe("stopped");
    expect(thread?.session?.threadId).toBe("thread-1");
    expect(thread?.session?.providerInstanceId).toBe(ProviderInstanceId.make("codex_work"));
    expect(thread?.session?.activeTurnId).toBeNull();
  });
});
