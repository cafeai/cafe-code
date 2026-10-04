// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import * as fsPromises from "node:fs/promises";
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
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { TextGenerationError } from "@cafecode/contracts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import { buildCodexSteerClientCorrelationId } from "../../provider/codexSteerCorrelation.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
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
import { seedScheduledFollowUp } from "../scheduledFollowUp.testSupport.ts";

// Node ESM namespace exports are immutable. Retain the real filesystem by
// default, with one explicit module seam for the no-progress local-I/O test.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

// Exercise all active metadata paths with a missing helper setting and an
// explicit saved choice. These models intentionally differ from the harness's
// chat model so a caller cannot accidentally use the interactive selection.
const savedHelperSelection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.6-sol", [
  { id: "reasoningEffort", value: "low" },
  { id: "fastMode", value: false },
]);
const metadataHelperSelectionCases = [
  {
    name: "default Sol 6.1 Medium",
    settingsOverride: {},
    expected: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6.1-sol", [
      { id: "reasoningEffort", value: "medium" },
    ]),
  },
  {
    name: "saved helper override",
    settingsOverride: { textGenerationModelSelection: savedHelperSelection },
    expected: savedHelperSelection,
  },
] as const;

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
    | OrchestrationEngineService
    | ProviderCommandReactor
    | ProjectionSnapshotQuery
    | SqlClient.SqlClient,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  let testClockScope: Scope.Closeable | null = null;
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
    if (testClockScope) {
      await Effect.runPromise(Scope.close(testClockScope, Exit.void));
      testClockScope = null;
    }
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
    readonly textGenerationModelSelection?: ModelSelection;
    readonly missingProviderInstanceIds?: ReadonlySet<string>;
    readonly sessionModelSwitch?: "unsupported" | "restart-resume" | "in-session";
    readonly liveSteer?: "supported" | "unsupported";
    readonly threadGoals?: "supported" | "unsupported";
    readonly manualCompaction?: "supported" | "unsupported";
    readonly startReactor?: boolean;
    readonly getCodexSteerAcceptanceEvidence?: ProjectionSnapshotQueryShape["getCodexSteerAcceptanceEvidence"];
    readonly beforeProjectRead?: Effect.Effect<void, Error>;
    readonly beforeTurnStartFailureDispatch?: Effect.Effect<void>;
    readonly logMessages?: unknown[];
    readonly beforeCodexSteerDeliveryAttemptDispatch?: Effect.Effect<void>;
    readonly beforeCodexRootReplacementDispatch?: Effect.Effect<void>;
    readonly beforeRuntimeRecoveryAttemptDispatch?: Effect.Effect<void>;
    readonly beforeTurnConfigurationDispatch?: Effect.Effect<void>;
    readonly providerDisplayNames?: ReadonlyMap<string, string>;
    readonly testClock?: TestClock.TestClock;
    readonly standalone?: boolean;
    readonly subagentConcurrency?: boolean;
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
    const compactThread = vi.fn(() => Effect.void);
    const modelSelection = input?.threadModelSelection ?? {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    };
    const startSession = vi.fn<ProviderServiceShape["startSession"]>((_, input) => {
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
        ...(typeof input === "object" && input !== null && "maxConcurrentSubagents" in input
          ? { maxConcurrentSubagents: input.maxConcurrentSubagents as number | null }
          : {}),
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
      compactThread,
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
          manualCompaction: input?.manualCompaction ?? "unsupported",
          subagentConcurrency: input?.subagentConcurrency ?? true,
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
          displayName: input?.providerDisplayNames?.get(raw),
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
      input?.beforeCodexSteerDeliveryAttemptDispatch === undefined &&
      input?.beforeCodexRootReplacementDispatch === undefined &&
      input?.beforeRuntimeRecoveryAttemptDispatch === undefined &&
      input?.beforeTurnStartFailureDispatch === undefined &&
      input?.beforeTurnConfigurationDispatch === undefined
        ? orchestrationLayer
        : Layer.effect(
            OrchestrationEngineService,
            Effect.map(Effect.service(OrchestrationEngineService), (engine) => ({
              ...engine,
              dispatch: (command: Parameters<typeof engine.dispatch>[0]) =>
                command.type === "thread.session.set" &&
                command.expectedTurnStartIntentSequence !== undefined &&
                input.beforeTurnStartFailureDispatch !== undefined
                  ? input.beforeTurnStartFailureDispatch.pipe(
                      Effect.andThen(engine.dispatch(command)),
                    )
                  : command.type === "thread.activity.append" &&
                      command.activity.kind === "provider.turn.configuration" &&
                      input.beforeTurnConfigurationDispatch !== undefined
                    ? input.beforeTurnConfigurationDispatch.pipe(
                        Effect.andThen(engine.dispatch(command)),
                      )
                    : command.type === "thread.activity.append" &&
                        command.activity.kind === "provider.turn.steer.delivery-attempted" &&
                        input.beforeCodexSteerDeliveryAttemptDispatch !== undefined
                      ? input.beforeCodexSteerDeliveryAttemptDispatch!.pipe(
                          Effect.andThen(engine.dispatch(command)),
                        )
                      : command.type === "thread.activity.append" &&
                          command.activity.kind === "runtime.warning" &&
                          (
                            command.activity.payload as
                              | Readonly<Record<string, unknown>>
                              | undefined
                          )?.recovery === "provider-runtime-continuation-attempted" &&
                          input.beforeRuntimeRecoveryAttemptDispatch !== undefined
                        ? input.beforeRuntimeRecoveryAttemptDispatch.pipe(
                            Effect.andThen(engine.dispatch(command)),
                          )
                        : command.type === "thread.session.set" &&
                            command.codexRootReplacement !== undefined &&
                            input.beforeCodexRootReplacementDispatch !== undefined
                          ? input.beforeCodexRootReplacementDispatch.pipe(
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
      input?.getCodexSteerAcceptanceEvidence === undefined && input?.beforeProjectRead === undefined
        ? baseProjectionSnapshotLayer
        : Layer.effect(
            ProjectionSnapshotQuery,
            Effect.map(Effect.service(ProjectionSnapshotQuery), (query) => ({
              ...query,
              ...(input.getCodexSteerAcceptanceEvidence !== undefined
                ? { getCodexSteerAcceptanceEvidence: input.getCodexSteerAcceptanceEvidence }
                : {}),
              ...(input.beforeProjectRead !== undefined
                ? {
                    getProjectShellById: (id: ProjectId) =>
                      input.beforeProjectRead!.pipe(
                        Effect.orDie,
                        Effect.andThen(query.getProjectShellById(id)),
                      ),
                  }
                : {}),
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
      Layer.provideMerge(
        ServerSettingsService.layerTest(
          input?.textGenerationModelSelection === undefined
            ? {}
            : { textGenerationModelSelection: input.textGenerationModelSelection },
        ),
      ),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const clockLayer =
      input?.testClock === undefined
        ? layer
        : layer.pipe(Layer.provideMerge(Layer.succeed(Clock.Clock, input.testClock)));
    runtime = ManagedRuntime.make(
      input?.logMessages === undefined
        ? clockLayer
        : clockLayer.pipe(
            Layer.provide(
              Logger.layer(
                [
                  Logger.make(({ message }) => {
                    input.logMessages!.push(...(Array.isArray(message) ? message : [message]));
                  }),
                ],
                { mergeWithExisting: false },
              ),
            ),
          ),
    );

    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(ProviderCommandReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    const startReactor = () => {
      const start = reactor.start().pipe(Scope.provide(scope!));
      // Layer construction logs and later start() logs execute in different
      // fibers. Capture both explicitly when a fixture audits redaction.
      return runtime!.runPromise(
        input?.logMessages === undefined
          ? start
          : start.pipe(
              Effect.provide(
                Logger.layer(
                  [
                    Logger.make(({ message }) => {
                      input.logMessages!.push(...(Array.isArray(message) ? message : [message]));
                    }),
                  ],
                  { mergeWithExisting: false },
                ),
              ),
            ),
      );
    };
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

    if (!input?.standalone)
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
        projectId: input?.standalone ? null : asProjectId("project-1"),
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
      sql,
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
      compactThread,
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

  describe("scheduled follow-up dispatch", () => {
    const threadId = ThreadId.make("thread-1");
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" };

    async function seed(harness: Awaited<ReturnType<typeof createHarness>>) {
      return Effect.runPromise(
        seedScheduledFollowUp(harness.sql, { threadId, modelSelection: selection }),
      );
    }

    async function readRun(harness: Awaited<ReturnType<typeof createHarness>>, id: string) {
      const [row] = await Effect.runPromise(
        harness.sql<{
          state: string;
          turn_id: string | null;
          attempt_at: string | null;
          error_code: string | null;
        }>`SELECT state, turn_id, attempt_at, error_code FROM scheduled_followup_runs WHERE id = ${id}`,
      );
      return row;
    }

    it.each(["codex", "claudeAgent", "grok"] as const)(
      "submits an authorized %s occurrence once without live-steer fallback",
      async (provider) => {
        const modelSelection = {
          instanceId: ProviderInstanceId.make(provider),
          model: "synthetic-model",
        };
        const harness = await createHarness({ threadModelSelection: modelSelection });
        const command = await Effect.runPromise(
          seedScheduledFollowUp(harness.sql, { threadId, modelSelection }),
        );
        const accepted = Effect.runSync(Deferred.make<void>());
        const originalSend = harness.sendTurn.getMockImplementation()!;
        harness.sendTurn.mockImplementationOnce((request) =>
          originalSend(request).pipe(Effect.tap(() => Deferred.succeed(accepted, undefined))),
        );
        const receipt = await Effect.runPromise(harness.engine.dispatch(command));
        // Preparation includes asynchronous local filesystem work. Observe
        // the mock's actual acceptance boundary instead of requiring full
        // preparation to finish inside the unrelated 2-second polling helper.
        // The enclosing test deadline remains unchanged and still bounds bugs.
        await Effect.runPromise(Deferred.await(accepted));
        await harness.drain();
        const repeated = await Effect.runPromise(harness.engine.dispatch(command));
        await harness.drain();
        expect(repeated.sequence).toBe(receipt.sequence);
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
          threadId,
          messageId: command.message.messageId,
          modelSelection,
          allowActiveTurnSteerFallback: false,
        });
        expect(harness.steerTurn).not.toHaveBeenCalled();
        expect(await readRun(harness, command.scheduledFollowUp!.runId)).toMatchObject({
          state: "running",
          turn_id: "turn-1",
          attempt_at: expect.any(String),
        });
        expect(harness.generateThreadMetadata).not.toHaveBeenCalled();
      },
    );

    it("waits for explicit preparation and acceptance barriers before asserting scheduled delivery", async () => {
      const preparationEntered = Effect.runSync(Deferred.make<void>());
      const releasePreparation = Effect.runSync(Deferred.make<void>());
      const accepted = Effect.runSync(Deferred.make<void>());
      const harness = await createHarness({
        beforeProjectRead: Deferred.succeed(preparationEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releasePreparation)),
        ),
      });
      const command = await seed(harness);
      const originalSend = harness.sendTurn.getMockImplementation()!;
      harness.sendTurn.mockImplementationOnce((request) =>
        originalSend(request).pipe(Effect.tap(() => Deferred.succeed(accepted, undefined))),
      );
      await Effect.runPromise(harness.engine.dispatch(command));
      await Effect.runPromise(Deferred.await(preparationEntered));
      try {
        // An accepted event is not provider acceptance. A deliberately held
        // preparation must retain its unattempted ledger, without a send or
        // implicit steering regardless of how the host schedules this fiber.
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect(await readRun(harness, command.scheduledFollowUp!.runId)).toMatchObject({
          state: "dispatching",
          attempt_at: null,
        });
      } finally {
        await Effect.runPromise(Deferred.succeed(releasePreparation, undefined));
      }
      await Effect.runPromise(Deferred.await(accepted));
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.steerTurn).not.toHaveBeenCalled();
      expect(await readRun(harness, command.scheduledFollowUp!.runId)).toMatchObject({
        state: "running",
        turn_id: "turn-1",
        attempt_at: expect.any(String),
      });
    });

    it.each(["unattempted", "attempted", "paused"] as const)(
      "reconciles a committed %s occurrence when the reactor starts after the original event",
      async (state) => {
        const harness = await createHarness({ startReactor: false });
        const command = await seed(harness);
        const first = await Effect.runPromise(harness.engine.dispatch(command));
        expect(harness.sendTurn).not.toHaveBeenCalled();
        if (state === "attempted") {
          await Effect.runPromise(harness.sql`
            UPDATE scheduled_followup_runs SET attempt_at = '2026-10-04T10:00:01.000Z'
            WHERE id = ${command.scheduledFollowUp!.runId}`);
        } else if (state === "paused") {
          await Effect.runPromise(harness.sql`
            UPDATE scheduled_followups SET state = 'paused', revision = revision + 1
            WHERE id = ${command.scheduledFollowUp!.scheduleId}`);
        }
        // This is a fresh worker/hot subscription with a durable event that
        // predates it, exactly the crash-between-commit-and-enqueue boundary.
        await harness.startReactor();
        await harness.drain();
        const repeated = await Effect.runPromise(harness.engine.dispatch(command));
        await harness.drain();
        expect(repeated.sequence).toBe(first.sequence);
        expect(harness.sendTurn).toHaveBeenCalledTimes(state === "unattempted" ? 1 : 0);
        expect(harness.steerTurn).not.toHaveBeenCalled();
        const run = await readRun(harness, command.scheduledFollowUp!.runId);
        expect(run).toMatchObject(
          state === "unattempted"
            ? { state: "running", turn_id: "turn-1", attempt_at: expect.any(String) }
            : state === "paused"
              ? { state: "skipped", attempt_at: null }
              : { state: "dispatching", attempt_at: "2026-10-04T10:00:01.000Z" },
        );
      },
    );

    it.each(["transient lock", "persistent lock", "connection failure"] as const)(
      "bounds startup intent reads after a %s without duplicating paid submissions",
      async (failure) => {
        const logMessages: unknown[] = [];
        const harness = await createHarness({ startReactor: false, logMessages });
        const command = await seed(harness);
        const receipt = await Effect.runPromise(harness.engine.dispatch(command));
        const readEvents = harness.engine.readEvents;
        let attempts = 0;
        const spy = vi.spyOn(harness.engine, "readEvents").mockImplementation((sequence, limit) => {
          if (sequence === receipt.sequence - 1) {
            attempts += 1;
            if (failure !== "transient lock" || attempts === 1) {
              return Stream.fail(
                new PersistenceSqlError({
                  operation: "synthetic-startup-read",
                  detail: "synthetic private database detail must not appear in diagnostics",
                  cause: new SqlError.SqlError({
                    reason:
                      failure === "connection failure"
                        ? new SqlError.ConnectionError({
                            operation: "execute",
                            cause: new Error("fixture"),
                          })
                        : new SqlError.LockTimeoutError({
                            operation: "execute",
                            cause: new Error("fixture"),
                          }),
                  }),
                }),
              );
            }
          }
          return readEvents(sequence, limit);
        });
        try {
          await harness.startReactor();
          await harness.drain();
          expect(attempts).toBe(
            failure === "transient lock" ? 2 : failure === "persistent lock" ? 3 : 1,
          );
          expect(harness.sendTurn).toHaveBeenCalledTimes(failure === "transient lock" ? 1 : 0);
          expect(harness.steerTurn).not.toHaveBeenCalled();
          if (failure !== "transient lock") {
            expect(await readRun(harness, command.scheduledFollowUp!.runId)).toMatchObject({
              state: "dispatching",
              attempt_at: null,
            });
            expect(logMessages.join(" ")).toContain(
              "scheduled follow-up startup replay deferred; durable state retained",
            );
            expect(logMessages.join(" ")).not.toContain("synthetic private database detail");
          }
        } finally {
          spy.mockRestore();
        }
      },
    );

    it("does not submit or restart when live runtime is busy behind an idle projection", async () => {
      const harness = await createHarness();
      const command = await seed(harness);
      harness.runtimeSessions.push({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: selection.instanceId,
        status: "running",
        runtimeMode: "approval-required",
        activeTurnId: asTurnId("native-existing"),
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
      });
      await Effect.runPromise(harness.engine.dispatch(command));
      await waitFor(
        async () => (await readRun(harness, command.scheduledFollowUp!.runId))?.state === "skipped",
      );
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.steerTurn).not.toHaveBeenCalled();
    });

    it("a pause during preparation wins before the paid submission CAS", async () => {
      const harness = await createHarness();
      const command = await seed(harness);
      const original = harness.startSession.getMockImplementation()!;
      harness.startSession.mockImplementationOnce((...args) =>
        original(...args).pipe(
          Effect.tap(() =>
            harness.sql`UPDATE scheduled_followups SET state = 'paused', revision = revision + 1
          WHERE id = ${command.scheduledFollowUp!.scheduleId}`.pipe(Effect.orDie),
          ),
        ),
      );
      await Effect.runPromise(harness.engine.dispatch(command));
      await waitFor(
        async () => (await readRun(harness, command.scheduledFollowUp!.runId))?.state === "skipped",
      );
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.steerTurn).not.toHaveBeenCalled();
      await harness.drain();
      expect((await harness.readThreadDetail(threadId))?.session?.status).not.toBe("starting");
    });

    it.each(["expiry", "run limit"] as const)(
      "rechecks the owner's %s after preparation before attempting a paid turn",
      async (limit) => {
        const clockScope = await Effect.runPromise(Scope.make());
        testClockScope = clockScope;
        const clock = await Effect.runPromise(TestClock.make().pipe(Scope.provide(clockScope)));
        await Effect.runPromise(
          clock.setTime(Date.parse("2026-10-04T10:00:00.000Z")).pipe(Scope.provide(clockScope)),
        );
        const harness = await createHarness({
          testClock: {
            ...clock,
            adjust: (duration) => clock.adjust(duration).pipe(Scope.provide(clockScope)),
            setTime: (timestamp) => clock.setTime(timestamp).pipe(Scope.provide(clockScope)),
          },
        });
        const command = await seed(harness);
        const scheduleId = command.scheduledFollowUp!.scheduleId;
        await Effect.runPromise(
          harness.sql`UPDATE scheduled_followups
            SET definition_json = json_set(definition_json, '$.endAt', '2026-10-04T10:00:01.000Z', '$.maxRuns', 1)
            WHERE id = ${scheduleId}`,
        );
        const original = harness.startSession.getMockImplementation()!;
        harness.startSession.mockImplementationOnce((...args) =>
          original(...args).pipe(
            Effect.tap(() =>
              limit === "expiry"
                ? clock.adjust("2 seconds").pipe(Scope.provide(clockScope))
                : harness.sql`UPDATE scheduled_followups SET run_count = 1
                    WHERE id = ${scheduleId}`.pipe(Effect.orDie, Effect.asVoid),
            ),
          ),
        );
        await Effect.runPromise(harness.engine.dispatch(command));
        await waitFor(
          async () =>
            (await readRun(harness, command.scheduledFollowUp!.runId))?.state === "skipped",
        );
        await harness.drain();
        expect(harness.startSession).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect(harness.steerTurn).not.toHaveBeenCalled();
        expect(await readRun(harness, command.scheduledFollowUp!.runId)).toMatchObject({
          state: "skipped",
          attempt_at: null,
        });
        const [schedule] = await Effect.runPromise(harness.sql<{ run_count: number }>`
          SELECT run_count FROM scheduled_followups WHERE id = ${scheduleId}`);
        expect(schedule?.run_count).toBe(limit === "expiry" ? 0 : 1);
      },
    );

    it("does not replay an ambiguous provider acceptance and requires attention", async () => {
      const harness = await createHarness();
      const command = await seed(harness);
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/start",
            detail: "Synthetic acknowledgement was lost.",
          }),
        ),
      );
      await Effect.runPromise(harness.engine.dispatch(command));
      await waitFor(
        async () => (await readRun(harness, command.scheduledFollowUp!.runId))?.state === "unknown",
      );
      await Effect.runPromise(harness.engine.dispatch(command));
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.steerTurn).not.toHaveBeenCalled();
      const [schedule] = await Effect.runPromise(harness.sql<{ state: string }>`
        SELECT state FROM scheduled_followups WHERE id = ${command.scheduledFollowUp!.scheduleId}`);
      expect(schedule?.state).toBe("needs_attention");
      expect(await readRun(harness, command.scheduledFollowUp!.runId)).toMatchObject({
        state: "unknown",
        error_code: "acceptance-unknown",
        attempt_at: expect.any(String),
      });
    });

    it("never reclassifies another owner's unconfirmed attempt as a skipped occurrence", async () => {
      const harness = await createHarness();
      const command = await seed(harness);
      const attemptedAt = "2026-10-04T10:00:00.500Z";
      const original = harness.startSession.getMockImplementation()!;
      harness.startSession.mockImplementationOnce((...args) =>
        original(...args).pipe(
          Effect.tap(() =>
            harness.sql`UPDATE scheduled_followup_runs SET attempt_at = ${attemptedAt}
          WHERE id = ${command.scheduledFollowUp!.runId}`.pipe(Effect.orDie),
          ),
        ),
      );
      await Effect.runPromise(harness.engine.dispatch(command));
      await waitFor(
        async () => (await readRun(harness, command.scheduledFollowUp!.runId))?.state === "unknown",
      );
      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.steerTurn).not.toHaveBeenCalled();
      expect(await readRun(harness, command.scheduledFollowUp!.runId)).toMatchObject({
        state: "unknown",
        attempt_at: attemptedAt,
        error_code: "acceptance-unknown",
      });
      const [schedule] = await Effect.runPromise(harness.sql<{ state: string }>`
        SELECT state FROM scheduled_followups WHERE id = ${command.scheduledFollowUp!.scheduleId}`);
      expect(schedule?.state).toBe("needs_attention");
    });

    it("an exact Stop accepted during the provider ACK cannot be reopened by that ACK", async () => {
      const harness = await createHarness();
      const command = await seed(harness);
      harness.sendTurn.mockImplementationOnce(() =>
        harness.engine
          .dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("scheduled-stop-during-ack"),
            threadId,
            createdAt: "2026-10-04T10:00:01.000Z",
          })
          .pipe(Effect.orDie, Effect.as({ threadId, turnId: asTurnId("accepted-before-stop") })),
      );
      await Effect.runPromise(harness.engine.dispatch(command));
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      const thread = await harness.readThreadDetail(threadId);
      expect(thread?.session?.status).not.toBe("running");
      expect(thread?.session?.activeTurnId).toBeNull();
      expect(harness.steerTurn).not.toHaveBeenCalled();
    });
  });

  describe("per-chat subagent process policy", () => {
    const threadId = ThreadId.make("thread-1");
    let sendIndex = 0;
    beforeEach(() => {
      sendIndex = 0;
    });
    async function send(
      harness: Awaited<ReturnType<typeof createHarness>>,
      key: string,
      fails = false,
    ) {
      const sentBefore = harness.sendTurn.mock.calls.length;
      const turnId = asTurnId(`${key}-native-turn`);
      // Real native turns have distinct identities. Reusing the harness's
      // default turn-1 would deliberately hit the completed-turn replay fence
      // after the first readiness transition instead of testing replacement.
      harness.sendTurn.mockImplementationOnce((input) =>
        Effect.succeed({
          threadId: input.threadId,
          turnId,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(key),
          threadId,
          message: { messageId: asMessageId(key), role: "user", text: "Hello", attachments: [] },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, ++sendIndex * 2 - 1)).toISOString(),
        }),
      );
      // drain waits admitted reactor work, not the PubSub consumer's next
      // scheduling turn. Observe the outcome before draining its final writes.
      await waitFor(async () =>
        fails
          ? (await harness.readThreadDetail(threadId))?.activities.some(
              (activity) => activity.kind === "provider.turn.start.failed",
            ) === true
          : harness.sendTurn.mock.calls.length === sentBefore + 1,
      );
      await harness.drain();
      if (!fails) {
        // The provider acknowledgement's presentation write is intentionally
        // detached from delivery. Wait for that exact marker before the test
        // emits its terminal ready edge, so a late ACK cannot reopen the fake
        // idle session after markThreadReady has run.
        await waitFor(async () => {
          const session = (await harness.readThreadDetail(threadId))?.session;
          return session?.status === "running" && session.activeTurnId === turnId;
        });
      }
    }
    async function change(
      harness: Awaited<ReturnType<typeof createHarness>>,
      key: string,
      limits: { codex?: number; claude?: number },
    ) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(key),
          threadId,
          subagentLimits: limits,
        }),
      );
      await harness.drain();
    }

    it("materializes only on the next send and keeps a child-wake race pending without replay", async () => {
      const harness = await createHarness({ standalone: true });
      await change(harness, "limit-three", { codex: 3, claude: 8 });
      expect(harness.startSession).not.toHaveBeenCalled();
      await send(harness, "initial-limit-send");
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({ maxConcurrentSubagents: 3 });
      expect(harness.runtimeSessions[0]?.maxConcurrentSubagents).toBe(3);
      await harness.markThreadReady(threadId, "2026-01-01T00:00:02.000Z");
      await change(harness, "limit-seven", { codex: 7, claude: 8 });
      expect((await harness.readThreadDetail(threadId))?.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
      });
      expect(harness.runtimeSessions[0]).toMatchObject({
        status: "ready",
        maxConcurrentSubagents: 3,
      });
      expect(harness.startSession).toHaveBeenCalledTimes(1);
      await send(harness, "changed-limit-send");
      expect(harness.startSession.mock.calls[1]?.[1]).toMatchObject({
        maxConcurrentSubagents: 7,
        requireIdleForSubagentLimitChange: true,
      });

      await harness.markThreadReady(threadId, "2026-01-01T00:00:04.000Z");
      await change(harness, "limit-nine", { codex: 9, claude: 8 });
      harness.startSession.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "startSession",
            detail: "Subagent work is active.",
            remoteErrorTag: "subagent-concurrency-active",
          }),
        ),
      );
      await send(harness, "child-woke-send");
      expect(harness.sendTurn).toHaveBeenCalledTimes(3);
      expect(harness.runtimeSessions[0]?.maxConcurrentSubagents).toBe(7);
      expect((await harness.readThreadDetail(threadId))?.subagentLimits).toEqual({
        codex: 9,
        claude: 8,
      });
      expect(harness.stopSession).not.toHaveBeenCalled();

      await harness.markThreadReady(threadId, "2026-01-01T00:00:06.000Z");
      await change(harness, "reset-limit", {});
      await send(harness, "reset-limit-send");
      expect(harness.startSession.mock.calls.at(-1)?.[1]).toMatchObject({
        maxConcurrentSubagents: null,
        requireIdleForSubagentLimitChange: true,
      });
      expect(harness.runtimeSessions[0]?.maxConcurrentSubagents).toBeNull();
    });

    it("rejects a requested override when the configured runtime is unqualified", async () => {
      const harness = await createHarness({ standalone: true, subagentConcurrency: false });
      await change(harness, "unsupported-limit", { codex: 2 });
      await send(harness, "unsupported-limit-send", true);
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      const thread = await harness.readThreadDetail(threadId);
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
      ).toBe(true);
    });

    it("does not restart running root work to apply a newly saved limit", async () => {
      const harness = await createHarness({ standalone: true, liveSteer: "supported" });
      await harness.setRunningCodexTurn(asTurnId("busy-root"), "2026-01-01T00:00:01.000Z");
      await change(harness, "busy-limit-change", { codex: 2 });
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.stopSession).not.toHaveBeenCalled();
      expect((await harness.readThreadDetail(threadId))?.subagentLimits).toEqual({ codex: 2 });
    });
  });

  describe("turn preparation failures", () => {
    const threadId = ThreadId.make("thread-1");
    const send = (harness: Awaited<ReturnType<typeof createHarness>>) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("preparation-start"),
          threadId,
          message: {
            messageId: asMessageId("preparation-message"),
            role: "user",
            text: "Hello",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          titleSeed: "Thread",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
    const waitForFailure = (harness: Awaited<ReturnType<typeof createHarness>>) =>
      waitFor(
        async () =>
          (await harness.readThreadDetail(threadId))?.activities.some(
            (activity) => activity.kind === "provider.turn.start.failed",
          ) === true,
      );

    it("settles invalid standalone storage before starting a provider or title request", async () => {
      const harness = await createHarness({ standalone: true });
      const root = path.join(path.dirname(harness.stateDir), "standalone-workspaces");
      // A regular file is a deterministic rejected directory on every host;
      // this fixture does not require symlink privileges or live providers.
      fs.writeFileSync(root, "not a workspace");
      await send(harness);
      await waitForFailure(harness);
      await harness.drain();
      const thread = await harness.readThreadDetail(threadId);
      expect(thread?.session).toMatchObject({ status: "ready", activeTurnId: null });
      expect(thread?.session?.lastError).toContain("Standalone chat directory is unavailable.");
      expect(thread?.session?.lastError).not.toContain(root);
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    });

    it("reports an unexpected preparation defect without exposing its private cause", async () => {
      const harness = await createHarness({
        beforeProjectRead: Effect.fail(new Error("secret filesystem path /private/account")),
      });
      await send(harness);
      await waitForFailure(harness);
      await harness.drain();
      const thread = await harness.readThreadDetail(threadId);
      expect(thread?.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError: "Cafe Code could not prepare this turn. No message was sent to the provider.",
      });
      expect(JSON.stringify(thread?.activities)).not.toContain("/private/account");
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("redacts unexpected provider-initialization defects through the ordinary failure path", async () => {
      const harness = await createHarness();
      harness.startSession.mockImplementationOnce(() =>
        Effect.die(new Error("private initialization /secret/account")),
      );
      await send(harness);
      await waitForFailure(harness);
      await harness.drain();
      const thread = await harness.readThreadDetail(threadId);
      expect(thread?.session).toMatchObject({
        status: "ready",
        activeTurnId: null,
        lastError:
          "Cafe Code could not start this turn. Check the provider connection before trying again.",
      });
      expect(JSON.stringify(thread?.activities)).not.toContain("/secret/account");
      expect(harness.startSession).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it.each(["running", "stopped"] as const)(
      "does not overwrite newer %s state after delayed preparation fails",
      async (state) => {
        const entered = Effect.runSync(Deferred.make<void>());
        const release = Effect.runSync(Deferred.make<void>());
        const harness = await createHarness({
          beforeProjectRead: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Effect.fail(new Error("delayed preparation failure"))),
          ),
        });
        await send(harness);
        await Effect.runPromise(Deferred.await(entered));
        if (state === "running") {
          await harness.setRunningCodexTurn(
            asTurnId("new-native-turn"),
            "2026-01-01T00:00:02.000Z",
          );
        } else {
          const session = (await harness.readThreadDetail(threadId))!.session!;
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("newer-stopped-state"),
              threadId,
              session: {
                ...session,
                status: "stopped",
                lastError: null,
                updatedAt: "2026-01-01T00:00:02.000Z",
              },
              createdAt: "2026-01-01T00:00:02.000Z",
            }),
          );
        }
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await harness.drain();
        const thread = await harness.readThreadDetail(threadId);
        expect(thread?.session?.status).toBe(state);
        expect(thread?.session?.lastError).toBeNull();
        expect(
          thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
        ).toBe(false);
        expect(harness.sendTurn).not.toHaveBeenCalled();
      },
    );

    it("rejects a failure publication when Stop commits after its last observation", async () => {
      const entered = Effect.runSync(Deferred.make<void>());
      const release = Effect.runSync(Deferred.make<void>());
      const harness = await createHarness({
        beforeProjectRead: Effect.fail(new Error("preparation rejected")),
        beforeTurnStartFailureDispatch: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      await send(harness);
      await Effect.runPromise(Deferred.await(entered));
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make("stop-racing-failure-publication"),
          threadId,
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      );
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
      const thread = await harness.readThreadDetail(threadId);
      expect(thread?.session).toMatchObject({ status: "stopped", lastError: null });
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
      ).toBe(false);
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("preserves a durable Stop when delayed standalone preparation fails", async () => {
      const harness = await createHarness({ standalone: true });
      const root = path.join(path.dirname(harness.stateDir), "standalone-workspaces");
      const original = vi.mocked(fsPromises.lstat).getMockImplementation()!;
      const blocked: Array<(error: Error) => void> = [];
      const lstat = vi
        .mocked(fsPromises.lstat)
        .mockImplementation((...args: Parameters<typeof fsPromises.lstat>) =>
          args[0] === root
            ? new Promise((_resolve, reject) => {
                blocked.push(reject);
              })
            : original(...args),
        );
      try {
        await send(harness);
        await waitFor(() => blocked.length >= 2);
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.stop",
            commandId: CommandId.make("stop-pending-preparation"),
            threadId,
            createdAt: "2026-01-01T00:00:02.000Z",
          }),
        );
        for (const reject of blocked) reject(new Error("workspace unavailable after Stop"));
        await harness.drain();
        const thread = await harness.readThreadDetail(threadId);
        expect(thread?.session?.status).toBe("stopped");
        expect(thread?.session?.lastError).toBeNull();
        expect(
          thread?.activities.some((activity) => activity.kind === "provider.turn.start.failed"),
        ).toBe(false);
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      } finally {
        for (const reject of blocked) reject(new Error("test cleanup"));
        lstat.mockImplementation(original);
      }
    });

    it("bounds local workspace preparation without starting or replaying a provider request", async () => {
      const clockScope = await Effect.runPromise(Scope.make());
      testClockScope = clockScope;
      const clock = await Effect.runPromise(TestClock.make().pipe(Scope.provide(clockScope)));
      await Effect.runPromise(
        clock.setTime(Date.parse("2026-01-01T00:00:01.000Z")).pipe(Scope.provide(clockScope)),
      );
      const harness = await createHarness({
        standalone: true,
        testClock: {
          ...clock,
          adjust: (duration) => clock.adjust(duration).pipe(Scope.provide(clockScope)),
          setTime: (timestamp) => clock.setTime(timestamp).pipe(Scope.provide(clockScope)),
        },
      });
      const root = path.join(path.dirname(harness.stateDir), "standalone-workspaces");
      const original = vi.mocked(fsPromises.lstat).getMockImplementation()!;
      let blocked = 0;
      const lstat = vi
        .mocked(fsPromises.lstat)
        .mockImplementation((...args: Parameters<typeof fsPromises.lstat>) => {
          if (args[0] === root) {
            blocked++;
            return new Promise(() => {});
          }
          return original(...args);
        });
      try {
        await send(harness);
        // Both the optional metadata lane and the required session lane must
        // have entered their independently bounded local preparation before
        // advancing the clock; an earlier jump would start the second lane's
        // deadline after the simulated time jump instead of expiring it.
        await waitFor(() => blocked >= 2);
        await Effect.runPromise(clock.adjust("15 seconds").pipe(Scope.provide(clockScope)));
        await waitForFailure(harness);
        await harness.drain();
        const thread = await harness.readThreadDetail(threadId);
        expect(thread?.session).toMatchObject({ status: "ready", activeTurnId: null });
        expect(thread?.session?.lastError).toContain(
          "Preparing the standalone chat directory timed out.",
        );
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      } finally {
        lstat.mockImplementation(original);
      }
    });
  });

  it("starts a standalone turn without any project using stable private cwd and explicit empty roots", async () => {
    const harness = await createHarness({ standalone: true });
    const threadId = ThreadId.make("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("standalone-first-send"),
        threadId,
        message: {
          messageId: asMessageId("standalone-message"),
          role: "user",
          text: "Hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await waitFor(() => harness.sendTurn.mock.calls.length === 1);
    await harness.drain();
    const request = harness.startSession.mock.calls[0]?.[1] as {
      cwd: string;
      additionalDirectories: readonly string[];
      runtimeMode: string;
    };
    expect(request.runtimeMode).toBe("approval-required");
    expect(request.additionalDirectories).toEqual([]);
    expect(path.dirname(request.cwd)).toBe(
      path.join(path.dirname(harness.stateDir), "standalone-workspaces"),
    );
    expect(fs.statSync(request.cwd).isDirectory()).toBe(true);
    expect((await harness.readModel()).projects).toEqual([]);
    expect((await harness.readThreadDetail(threadId))?.projectId).toBeNull();
    expect(harness.renameBranch).not.toHaveBeenCalled();
    expect(harness.generateBranchName).not.toHaveBeenCalled();
  });

  it.each(["detach", "revoke-roots"] as const)(
    "rebinds %s only on the next explicit turn and explicitly revokes stale roots",
    async (change) => {
      const harness = await createHarness();
      const threadId = ThreadId.make("thread-1");
      const instance = ProviderInstanceId.make("codex");
      const resumeCursor = { opaque: "existing-native-conversation" };
      harness.runtimeSessions.push({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: instance,
        status: "ready",
        runtimeMode: "approval-required",
        threadId,
        cwd: "/tmp/provider-project",
        additionalDirectories: ["/former-additional-root"],
        resumeCursor,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`seed-idle-${change}`),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: instance,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch(
          change === "detach"
            ? {
                type: "thread.meta.update",
                commandId: CommandId.make("detach-idle-chat"),
                threadId,
                projectId: null,
              }
            : {
                type: "project.meta.update",
                commandId: CommandId.make("revoke-project-roots"),
                projectId: asProjectId("project-1"),
                additionalWorkspaceRoots: [],
              },
        ),
      );
      await harness.drain();
      expect(harness.startSession).not.toHaveBeenCalled();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`explicit-next-${change}`),
          threadId,
          message: {
            messageId: asMessageId(`explicit-message-${change}`),
            role: "user",
            text: "Continue",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.startSession).toHaveBeenCalledTimes(1);
      const request = harness.startSession.mock.calls[0]?.[1] as {
        cwd: string;
        additionalDirectories: readonly string[];
        resumeCursor: unknown;
      };
      expect(request.additionalDirectories).toEqual([]);
      expect(request.resumeCursor).toEqual(resumeCursor);
      if (change === "detach")
        expect(path.dirname(request.cwd)).toBe(
          path.join(path.dirname(harness.stateDir), "standalone-workspaces"),
        );
      else expect(request.cwd).toBe("/tmp/provider-project");
    },
  );

  describe("verified runtime ownership-loss recovery", () => {
    const threadId = ThreadId.make("thread-1");
    const lostTurnId = asTurnId("turn-before-verified-runtime-loss");
    const lostAt = "2026-01-01T00:00:04.000Z";
    const originalText = "Apply the original accepted changes exactly once.";
    const queuedText = "Also keep the additional saved requirement.";
    const queuedMessageId = asMessageId("message-parked-before-runtime-loss");

    async function createRecoveryTestClock(): Promise<TestClock.TestClock> {
      const clockScope = await Effect.runPromise(Scope.make());
      testClockScope = clockScope;
      const clock = await Effect.runPromise(TestClock.make().pipe(Scope.provide(clockScope)));
      await Effect.runPromise(
        clock.setTime(Date.parse("2026-01-01T00:00:10.000Z")).pipe(Scope.provide(clockScope)),
      );
      // The beta TestClock factory's inferred methods retain their scope
      // requirement; bind that scope explicitly for this Promise-based suite.
      return {
        ...clock,
        adjust: (duration) => clock.adjust(duration).pipe(Scope.provide(clockScope)),
        setTime: (timestamp) => clock.setTime(timestamp).pipe(Scope.provide(clockScope)),
      };
    }

    // Seed the same durable ordering produced by ingestion, without a live
    // reactor that could consume the old accepted prompt or parked steer.
    // Only the final server-owned marker grants automatic recovery authority.
    async function seedLoss(
      harness: Awaited<ReturnType<typeof createHarness>>,
      options?: { readonly queuedInput?: boolean; readonly startBeforeMarker?: boolean },
    ) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-original-before-runtime-loss"),
          threadId,
          message: {
            messageId: asMessageId("original-accepted-before-runtime-loss"),
            role: "user",
            text: originalText,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
      await harness.setRunningCodexTurn(lostTurnId, "2026-01-01T00:00:02.000Z");
      if (options?.queuedInput) {
        const intent = await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.steer",
            commandId: CommandId.make("cmd-parked-input-before-runtime-loss"),
            threadId,
            message: {
              messageId: queuedMessageId,
              role: "user",
              text: queuedText,
              attachments: [],
            },
            createdAt: "2026-01-01T00:00:03.000Z",
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make("server:parked-input-before-runtime-loss"),
            threadId,
            activity: {
              id: EventId.make("activity-parked-input-before-runtime-loss"),
              kind: "provider.turn.steer.failed",
              tone: "error",
              summary: "Saved input is awaiting provider recovery",
              turnId: lostTurnId,
              payload: {
                provider: "codex",
                messageId: queuedMessageId,
                intentSequence: intent.sequence,
                retryableFollowUp: true,
                retryAfter: "active-turn",
                recoveryBarrier: "provider-liveness-unknown",
              },
              createdAt: "2026-01-01T00:00:03.500Z",
            },
            createdAt: "2026-01-01T00:00:03.500Z",
          }),
        );
      }
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("server:session-stopped-for-runtime-loss"),
          threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: lostAt,
          },
          createdAt: lostAt,
        }),
      );
      harness.runtimeSessions.length = 0;
      if (options?.startBeforeMarker) await harness.startReactor();
      return Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make("server:verified-runtime-loss"),
          threadId,
          activity: {
            id: EventId.make("activity-verified-runtime-loss"),
            kind: "runtime.warning",
            tone: "info",
            turnId: lostTurnId,
            summary: "Provider runtime ownership was lost",
            payload: { recovery: "provider-runtime-ownership-lost", sessionUpdatedAt: lostAt },
            createdAt: lostAt,
          },
          createdAt: lostAt,
        }),
      );
    }

    async function interrupt(harness: Awaited<ReturnType<typeof createHarness>>) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("cmd-stop-runtime-recovery"),
          threadId,
          turnId: lostTurnId,
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      );
    }

    it("continues once with the preserved Max model, without replaying the accepted prompt", async () => {
      const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra", [
        { id: "reasoningEffort", value: "max" },
      ]);
      const harness = await createHarness({
        startReactor: false,
        threadModelSelection: modelSelection,
      });
      const loss = await seedLoss(harness, { startBeforeMarker: true });
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();

      expect(harness.startSession).toHaveBeenCalledTimes(1);
      expect(harness.startSession.mock.calls[0]?.[1]).toMatchObject({
        threadId,
        modelSelection,
        providerInstanceId: modelSelection.instanceId,
      });
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId,
        modelSelection,
        allowActiveTurnSteerFallback: false,
        input: expect.stringContaining("Continue the unfinished request"),
      });
      expect(JSON.stringify(harness.sendTurn.mock.calls[0]?.[0])).not.toContain(originalText);
      const events = await Effect.runPromise(
        harness.engine.readEvents(loss.sequence).pipe(Stream.runCollect),
      );
      expect(events.find((event) => event.type === "thread.turn-start-requested")).toMatchObject({
        payload: {
          runtimeRecovery: {
            sourceEventSequence: loss.sequence,
            turnId: lostTurnId,
            sessionUpdatedAt: lostAt,
          },
        },
      });
    });

    it("delivers the exact parked input instead of a synthetic continuation or a duplicate bubble", async () => {
      const harness = await createHarness({ startReactor: false });
      await seedLoss(harness, { queuedInput: true });
      await harness.startReactor();
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId,
        messageId: queuedMessageId,
        input: queuedText,
      });
      expect(harness.steerTurn).not.toHaveBeenCalled();
      const detail = await harness.readThreadDetail(threadId);
      expect(detail?.messages.filter((message) => message.id === queuedMessageId)).toHaveLength(1);
    });

    it.each(["thread.turn.interrupt", "thread.session.stop"] as const)(
      "does not reconnect when %s was persisted after the loss marker",
      async (type) => {
        const harness = await createHarness({ startReactor: false });
        await seedLoss(harness);
        await Effect.runPromise(
          harness.engine.dispatch({
            type,
            commandId: CommandId.make("cmd-durable-stop-after-runtime-loss"),
            threadId,
            createdAt: "2026-01-01T00:00:05.000Z",
          }),
        );
        await harness.startReactor();
        await harness.drain();
        expect(harness.startSession).not.toHaveBeenCalled();
        expect(harness.sendTurn).not.toHaveBeenCalled();
      },
    );

    it("rechecks durable Stop after native session materialization", async () => {
      const harness = await createHarness({ startReactor: false });
      await seedLoss(harness);
      const release = Effect.runSync(Deferred.make<void>());
      const startSession = harness.startSession.getMockImplementation()!;
      harness.startSession.mockImplementationOnce((thread, request) =>
        Deferred.await(release).pipe(Effect.flatMap(() => startSession(thread, request))),
      );
      await harness.startReactor();
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await interrupt(harness);
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("rechecks durable Stop after the pre-I/O attempt marker is appended", async () => {
      const markerReached = Effect.runSync(Deferred.make<void>());
      const release = Effect.runSync(Deferred.make<void>());
      const harness = await createHarness({
        startReactor: false,
        beforeRuntimeRecoveryAttemptDispatch: Deferred.succeed(markerReached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      await seedLoss(harness);
      await harness.startReactor();
      await Effect.runPromise(Deferred.await(markerReached));
      await interrupt(harness);
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(
        (await harness.readThreadDetail(threadId))?.activities.some(
          (activity) =>
            (activity.payload as Readonly<Record<string, unknown>> | undefined)?.recovery ===
            "provider-runtime-continuation-attempted",
        ),
      ).toBe(true);
    });

    it("lets newer user input supersede a continuation during native materialization", async () => {
      const harness = await createHarness({ startReactor: false });
      await seedLoss(harness);
      const release = Effect.runSync(Deferred.make<void>());
      const startSession = harness.startSession.getMockImplementation()!;
      harness.startSession.mockImplementationOnce((thread, request) =>
        Deferred.await(release).pipe(Effect.flatMap(() => startSession(thread, request))),
      );
      await harness.startReactor();
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-newer-input-during-reconnect"),
          threadId,
          message: {
            messageId: asMessageId("newer-input-during-reconnect"),
            role: "user",
            text: "Use this newer request instead.",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      );
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        input: "Use this newer request instead.",
      });
    });

    it("does not send when another backend wins the same durable recovery attempt", async () => {
      const markerReached = Effect.runSync(Deferred.make<void>());
      const release = Effect.runSync(Deferred.make<void>());
      let interceptedFirstAttempt = false;
      const harness = await createHarness({
        startReactor: false,
        beforeRuntimeRecoveryAttemptDispatch: Effect.suspend(() => {
          // Only suspend the local worker. The competing backend's append
          // below must be able to commit while this worker remains paused.
          if (interceptedFirstAttempt) return Effect.void;
          interceptedFirstAttempt = true;
          return Deferred.succeed(markerReached, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          );
        }),
      });
      const loss = await seedLoss(harness);
      await harness.startReactor();
      await Effect.runPromise(Deferred.await(markerReached));
      const events = await Effect.runPromise(
        harness.engine.readEvents(loss.sequence).pipe(Stream.runCollect),
      );
      const recoveryIntent = events.find(
        (event) =>
          event.type === "thread.turn-start-requested" &&
          event.payload.runtimeRecovery?.sourceEventSequence === loss.sequence,
      );
      if (recoveryIntent?.type !== "thread.turn-start-requested") {
        throw new Error("Expected the admitted runtime recovery intent before its attempt.");
      }
      const winningOwnerId = "00000000-0000-4000-8000-000000000099";
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`server:runtime-recovery-attempt:${recoveryIntent.sequence}`),
          threadId,
          activity: {
            id: EventId.make(`runtime-recovery-attempt:${recoveryIntent.sequence}`),
            kind: "runtime.warning",
            tone: "info",
            summary: "Continuing interrupted provider work",
            turnId: lostTurnId,
            payload: {
              recovery: "provider-runtime-continuation-attempted",
              sourceEventSequence: loss.sequence,
              attemptOwnerId: winningOwnerId,
            },
            createdAt,
          },
          createdAt,
        }),
      );
      // The local stable command now resolves to the other backend's receipt.
      // Its post-append owner readback must reject that receipt as permission
      // to send, even though all ordinary Stop/new-input fences still allow it.
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
      expect(harness.startSession).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect(
        (await harness.readThreadDetail(threadId))?.activities.filter(
          (activity) =>
            (activity.payload as Readonly<Record<string, unknown>> | undefined)?.recovery ===
            "provider-runtime-continuation-attempted",
        ),
      ).toMatchObject([{ payload: { attemptOwnerId: winningOwnerId } }]);
    });

    it("does not duplicate an ambiguous send when startup recovery runs again", async () => {
      const harness = await createHarness({ startReactor: false });
      await seedLoss(harness);
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "sendTurn",
            detail: "Acknowledgement transport disconnected",
          }),
        ),
      );
      await harness.startReactor();
      await waitFor(
        async () =>
          (await harness.readThreadDetail(threadId))?.activities.some(
            (activity) => activity.summary === "Provider continuation needs reconciliation",
          ) === true,
      );
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      // Re-run the real startup scan against the same durable attempted marker.
      // A new subscription cannot license another provider request.
      await harness.startReactor();
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.startSession).toHaveBeenCalledTimes(1);
    });

    it.each(["unknown inventory", "new native turn", "later Stop"] as const)(
      "keeps unbound newer input saved across %s without sending or steering it",
      async (barrier) => {
        const harness = await createHarness({ startReactor: false });
        await seedLoss(harness);
        const release = Effect.runSync(Deferred.make<void>());
        const startSession = harness.startSession.getMockImplementation()!;
        harness.startSession.mockImplementationOnce((thread, request) =>
          Deferred.await(release).pipe(
            Effect.flatMap(() => startSession(thread, request)),
            Effect.map((session) => {
              if (barrier !== "new native turn") return session;
              const running: ProviderSession = {
                ...session,
                status: "running",
                activeTurnId: asTurnId("unrelated-new-native-turn"),
              };
              harness.runtimeSessions.splice(0, harness.runtimeSessions.length, running);
              return running;
            }),
          ),
        );
        await harness.startReactor();
        await waitFor(() => harness.startSession.mock.calls.length === 1);
        const messageId = asMessageId("unbound-newer-input-with-barrier");
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-unbound-newer-input-with-barrier"),
            threadId,
            message: {
              messageId,
              role: "user",
              text: "Keep this newer request safe.",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt: new Date().toISOString(),
          }),
        );
        if (barrier === "later Stop") await interrupt(harness);
        if (barrier === "unknown inventory") {
          harness.listSessions.mockImplementation(() =>
            Effect.die(new Error("Inventory inconclusive")),
          );
        }
        await Effect.runPromise(Deferred.succeed(release, undefined));
        await harness.drain();
        await waitFor(
          async () =>
            (await harness.readThreadDetail(threadId))?.activities.some(
              (activity) =>
                activity.kind === "provider.turn.steer.failed" &&
                (activity.payload as Readonly<Record<string, unknown>> | undefined)?.messageId ===
                  messageId,
            ) === true,
        );
        expect(harness.sendTurn).not.toHaveBeenCalled();
        expect(harness.steerTurn).not.toHaveBeenCalled();
        const detail = await harness.readThreadDetail(threadId);
        expect(detail?.messages.filter((message) => message.id === messageId)).toHaveLength(1);
      },
    );

    it("recovers an admitted but unattempted continuation on backend startup", async () => {
      const harness = await createHarness({ startReactor: false });
      const loss = await seedLoss(harness);
      const messageId = asMessageId("recovery-admitted-before-restart");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("server:recovery-admitted-before-restart"),
          threadId,
          message: {
            messageId,
            role: "user",
            text: "Continue the unfinished saved work.",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeRecovery: {
            sourceEventSequence: loss.sequence,
            turnId: lostTurnId,
            sessionUpdatedAt: lostAt,
          },
          createdAt: "2026-01-01T00:00:05.000Z",
        }),
      );
      await harness.startReactor();
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        messageId,
        input: "Continue the unfinished saved work.",
      });
      expect(harness.startSession).toHaveBeenCalledTimes(1);
    });

    it("does not resurrect running state when Stop commits before a delayed send acknowledgement", async () => {
      const harness = await createHarness({ startReactor: false });
      await seedLoss(harness);
      const release = Effect.runSync(Deferred.make<void>());
      const acceptedTurnId = asTurnId("accepted-runtime-recovery-turn");
      harness.sendTurn.mockImplementationOnce(() =>
        Deferred.await(release).pipe(
          Effect.as({
            threadId,
            turnId: acceptedTurnId,
          }),
        ),
      );
      await harness.startReactor();
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await interrupt(harness);
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
      const detail = await harness.readThreadDetail(threadId);
      expect(detail?.session?.status).not.toBe("running");
      expect(detail?.session?.activeTurnId).not.toBe(acceptedTurnId);
    });

    it("retries inconclusive preparation with capped backoff without blocking Stop", async () => {
      const testClock = await createRecoveryTestClock();
      const harness = await createHarness({ startReactor: false, testClock });
      harness.startSession.mockImplementation(() =>
        Effect.die(new Error("Preparation unavailable")),
      );
      await seedLoss(harness, { startBeforeMarker: true });
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await harness.drain();

      // Each failed preparation completes the serial work item and registers
      // one scoped timer. Moving the test clock proves the exact cap without
      // waiting minutes or making Stop race wall-clock scheduling in CI.
      const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
      for (const [index, delayMs] of delays.entries()) {
        await Effect.runPromise(testClock.adjust(delayMs - 1));
        await harness.drain();
        expect(harness.startSession).toHaveBeenCalledTimes(index + 1);
        await Effect.runPromise(testClock.adjust(1));
        await waitFor(() => harness.startSession.mock.calls.length === index + 2);
        await harness.drain();
      }
      await interrupt(harness);
      await harness.drain();
      expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
      await Effect.runPromise(testClock.adjust(60_000));
      await harness.drain();
      expect(harness.startSession).toHaveBeenCalledTimes(delays.length + 1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
    });

    it("retries an inconclusive post-materialization inventory without a duplicate native start", async () => {
      const testClock = await createRecoveryTestClock();
      const harness = await createHarness({ startReactor: false, testClock });
      const startSession = harness.startSession.getMockImplementation()!;
      harness.startSession.mockImplementationOnce((thread, request) => {
        // This failure is armed only once native resume has succeeded. It
        // must be treated as unknown ownership, not empty provider inventory.
        harness.listSessions.mockImplementationOnce(() =>
          Effect.die(new Error("Inventory unavailable")),
        );
        return startSession(thread, request);
      });
      await seedLoss(harness, { startBeforeMarker: true });
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      await Effect.runPromise(testClock.adjust(1_000));
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      await harness.drain();
      expect(harness.startSession).toHaveBeenCalledTimes(1);
    });

    it("does not send a synthetic continuation when native resume restores running work", async () => {
      const harness = await createHarness({ startReactor: false });
      await seedLoss(harness);
      const startSession = harness.startSession.getMockImplementation()!;
      const nativeTurnId = asTurnId("native-resumed-running-turn");
      harness.startSession.mockImplementationOnce((thread, request) =>
        startSession(thread, request).pipe(
          Effect.map((session) => {
            const running: ProviderSession = {
              ...session,
              status: "running",
              activeTurnId: nativeTurnId,
            };
            harness.runtimeSessions.splice(0, harness.runtimeSessions.length, running);
            return running;
          }),
        ),
      );
      await harness.startReactor();
      await waitFor(() => harness.startSession.mock.calls.length === 1);
      await harness.drain();
      expect(harness.sendTurn).not.toHaveBeenCalled();
      expect((await harness.readThreadDetail(threadId))?.session).toMatchObject({
        status: "running",
        activeTurnId: nativeTurnId,
      });
    });
  });

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

  it("deduplicates manual compaction without sending a user prompt", async () => {
    const harness = await createHarness({ manualCompaction: "supported" });
    const threadId = ThreadId.make("thread-1");
    await harness.setRunningCodexTurn(TurnId.make("previous-turn"), "2026-01-01T00:00:01.000Z");
    await harness.markThreadReady();
    const command = {
      type: "thread.compact" as const,
      commandId: CommandId.make("cmd-compact-1"),
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    harness.compactThread.mockImplementation(() =>
      Effect.promise(async () => {
        const thread = await harness.readThreadDetail(threadId);
        expect(
          thread?.activities.some((activity) => activity.kind === "provider.compaction.requested"),
        ).toBe(true);
      }),
    );
    await Effect.runPromise(harness.engine.dispatch(command));
    await Effect.runPromise(harness.engine.dispatch(command));
    await harness.drain();
    expect(harness.compactThread).toHaveBeenCalledTimes(1);
    const feedback = (await harness.readThreadDetail(threadId))?.activities.filter(
      (activity) => activity.kind === "provider.compaction.requested",
    );
    expect(feedback).toHaveLength(1);
    expect(feedback?.[0]?.payload).toMatchObject({ operationId: command.commandId });
    expect(harness.compactThread).toHaveBeenCalledWith({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      operationId: command.commandId,
    });
    expect(harness.sendTurn).not.toHaveBeenCalled();
    expect(harness.generateThreadMetadata).not.toHaveBeenCalled();
  });

  it("rejects compaction during active turns and for a different provider instance", async () => {
    const harness = await createHarness({ manualCompaction: "supported" });
    const threadId = ThreadId.make("thread-1");
    await harness.setRunningCodexTurn(TurnId.make("active-turn"), "2026-01-01T00:00:01.000Z");
    const command = {
      type: "thread.compact" as const,
      commandId: CommandId.make("cmd-compact-busy"),
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
    };
    await expect(Effect.runPromise(harness.engine.dispatch(command))).rejects.toThrow(
      "Wait for the current turn",
    );
    await harness.markThreadReady();
    await expect(
      Effect.runPromise(
        harness.engine.dispatch({
          ...command,
          commandId: CommandId.make("cmd-compact-wrong-instance"),
          providerInstanceId: ProviderInstanceId.make("opencode"),
        }),
      ),
    ).rejects.toThrow("existing Codex or OpenCode");
    expect(harness.compactThread).not.toHaveBeenCalled();
  });

  it("records a visible failure when an adopted daemon lacks compaction support", async () => {
    const harness = await createHarness();
    await harness.setRunningCodexTurn(TurnId.make("previous-turn"), "2026-01-01T00:00:01.000Z");
    await harness.markThreadReady();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.compact",
        commandId: CommandId.make("cmd-compact-unsupported"),
        threadId: ThreadId.make("thread-1"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.drain();
    const detail = await harness.readThreadDetail(ThreadId.make("thread-1"));
    expect(
      detail?.activities.some((activity) => activity.kind === "provider.compaction.failed"),
    ).toBe(true);
    expect(harness.compactThread).not.toHaveBeenCalled();
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

  it.each([false, true])(
    "treats unavailable provider inventory as unknown, not stopped (detached proof=%s)",
    async (live) => {
      const harness = await createHarness({ startReactor: false });
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("unavailable-native-root");
      const at = "2026-01-01T00:00:01.000Z";
      const runtimeId = "00000000-0000-4000-8000-000000000001";
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("unavailable-saved-generation"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            subagentRuntimeId: runtimeId,
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: at,
          },
          createdAt: at,
        }),
      );
      if (live)
        harness.durableProviderBindings.push({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running",
          runtimeMode: "approval-required",
          resumeCursor: {},
          lastSeenAt: at,
          runtimePayload: {
            subagentRuntimeId: runtimeId,
            activeTurnId: turnId,
            ...liveDurableRuntimeOwnerPayload(),
          },
        });
      harness.listSessions.mockImplementation(() =>
        // The service inventory has no declared typed error channel. Exercise
        // an unavailable transport as a defect, matching its public contract.
        Effect.die(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "listSessions",
            detail: "Inventory unavailable",
          }),
        ),
      );
      await harness.startReactor();
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      expect(thread?.session).toMatchObject({ status: "running", activeTurnId: turnId });
      expect(thread?.session?.subagentRuntimeId ?? null).toBe(live ? runtimeId : null);
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.interruptTurn).not.toHaveBeenCalled();
      expect(harness.sendTurn).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "reconciles idle saved context against detached-owner evidence (live=%s)",
    async (live) => {
      const harness = await createHarness({ startReactor: false });
      const threadId = ThreadId.make("thread-1");
      const at = "2026-01-01T00:00:01.000Z";
      const runtimeId = "00000000-0000-4000-8000-000000000001";
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("idle-saved-generation"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            subagentRuntimeId: runtimeId,
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: at,
          },
          createdAt: at,
        }),
      );
      if (live)
        harness.durableProviderBindings.push({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running",
          runtimeMode: "approval-required",
          resumeCursor: {},
          lastSeenAt: at,
          runtimePayload: { subagentRuntimeId: runtimeId, ...liveDurableRuntimeOwnerPayload() },
        });
      await harness.startReactor();
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
      expect(thread?.session?.status).toBe("ready");
      expect(thread?.session?.subagentRuntimeId ?? null).toBe(live ? runtimeId : null);
      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.interruptTurn).not.toHaveBeenCalled();
    },
  );

  it("adopts a surviving native context on backend restart without starting provider work", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("surviving-native-root");
    const at = "2026-01-01T00:00:01.000Z";
    const runtimeId = "00000000-0000-4000-8000-000000000001";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("seed-legacy-native-context"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: at,
        },
        createdAt: at,
      }),
    );
    harness.runtimeSessions.push({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId,
      subagentRuntimeId: runtimeId,
      status: "running",
      runtimeMode: "approval-required",
      activeTurnId: turnId,
      createdAt: at,
      updatedAt: at,
    });
    await harness.startReactor();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.session).toMatchObject({
      status: "running",
      activeTurnId: turnId,
      subagentRuntimeId: runtimeId,
    });
    expect(harness.startSession).not.toHaveBeenCalled();
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

  describe("accepted turn configuration", () => {
    async function startTurn(
      harness: Awaited<ReturnType<typeof createHarness>>,
      suffix: string,
      selection?: ModelSelection,
    ) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`config-start-${suffix}`),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId(`config-message-${suffix}`),
            role: "user",
            text: "private configuration fixture prompt",
            attachments: [],
          },
          ...(selection !== undefined ? { modelSelection: selection } : {}),
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      );
    }

    const configurations = async (harness: Awaited<ReturnType<typeof createHarness>>) =>
      (await harness.readModel()).threads
        .find((thread) => thread.id === "thread-1")
        ?.activities.filter((entry) => entry.kind === "provider.turn.configuration") ?? [];

    it("records every accepted same-account turn with its frozen name/settings", async () => {
      const names = new Map([["codex", "Codex Personal"]]);
      const harness = await createHarness({ providerDisplayNames: names });
      let counter = 0;
      harness.sendTurn.mockImplementation((input) =>
        Effect.succeed({
          threadId: input.threadId,
          turnId: asTurnId(`configuration-turn-${++counter}`),
        }),
      );
      const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-6.1-sol", [
        { id: "reasoningEffort", value: "ultra" },
        { id: "fastMode", value: true },
      ]);
      await startTurn(harness, "first", selection);
      await waitFor(async () => (await configurations(harness)).length === 1);
      await harness.markThreadReady();
      names.set("codex", "Renamed Personal");
      await startTurn(
        harness,
        "second",
        createModelSelection(selection.instanceId, selection.model, [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: false },
        ]),
      );
      await waitFor(async () => (await configurations(harness)).length === 2);
      const rows = await configurations(harness);
      expect(rows[0]).toMatchObject({
        turnId: "configuration-turn-1",
        payload: {
          turnConfiguration: {
            providerDisplayName: "Codex Personal",
            model: "gpt-6.1-sol",
            effort: "ultra",
            fastMode: true,
            settingsSource: "submitted",
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        },
      });
      expect(rows[1]).toMatchObject({
        turnId: "configuration-turn-2",
        payload: {
          turnConfiguration: {
            providerDisplayName: "Renamed Personal",
            effort: "high",
            fastMode: false,
          },
        },
      });
      expect(JSON.stringify(rows)).not.toContain("private configuration fixture prompt");
      expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    });

    it("does not publish configuration for a rejected submission", async () => {
      const harness = await createHarness();
      harness.sendTurn.mockReturnValue(
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/start",
            detail: "Fixture rejected turn",
          }),
        ),
      );
      await startTurn(harness, "rejected");
      await waitFor(
        async () =>
          (await harness.readModel()).threads[0]?.activities.some(
            (entry) => entry.kind === "provider.turn.start.failed",
          ) ?? false,
      );
      expect(await configurations(harness)).toEqual([]);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    });

    it("does not let a pending configuration write hold accepted running/Stop bookkeeping", async () => {
      const reached = Effect.runSync(Deferred.make<void>());
      const release = Effect.runSync(Deferred.make<void>());
      let readRunningBeforeMetadata = async () => false;
      let acceptedBeforeMetadata = false;
      const harness = await createHarness({
        beforeTurnConfigurationDispatch: Effect.promise(() => readRunningBeforeMetadata()).pipe(
          Effect.tap((running) =>
            Effect.sync(() => {
              acceptedBeforeMetadata = running;
            }),
          ),
          Effect.andThen(Deferred.succeed(reached, undefined)),
          Effect.andThen(Deferred.await(release)),
        ),
      });
      readRunningBeforeMetadata = async () =>
        (await harness.readModel()).threads[0]?.session?.status === "running";
      await startTurn(harness, "pending-metadata");
      await Effect.runPromise(Deferred.await(reached).pipe(Effect.timeout("2 seconds")));
      expect(acceptedBeforeMetadata).toBe(true);
      await waitFor(
        async () => (await harness.readModel()).threads[0]?.session?.status === "running",
      );
      expect(await configurations(harness)).toEqual([]);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make("config-stop-pending-metadata"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: "2026-01-01T00:00:02.000Z",
        }),
      );
      await waitFor(() => harness.interruptTurn.mock.calls.length === 1);
      await waitFor(
        async () => (await harness.readModel()).threads[0]?.latestTurn?.state === "interrupted",
      );
      await harness.drain();
      const terminalBeforeMetadata = (await harness.readModel()).threads[0]?.latestTurn;
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await waitFor(async () => (await configurations(harness)).length === 1);
      expect((await harness.readModel()).threads[0]?.latestTurn).toEqual(terminalBeforeMetadata);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.interruptTurn).toHaveBeenCalledTimes(1);
    });

    it.each([
      { deliveryKind: "steer" as const },
      {
        clientCorrelationId: buildCodexSteerClientCorrelationId("config-message-steer-correlation"),
      },
    ])(
      "does not backfill settings when an idle-prepared request is routed to existing steering (%j)",
      async (evidence) => {
        const harness = await createHarness();
        harness.sendTurn.mockImplementation((input) =>
          Effect.sync(() => {
            // Simulate the provider becoming active after idle preparation. Its
            // strict correlation receipt still needs matching native liveness;
            // the discriminator covers providers without that correlation API.
            if ("clientCorrelationId" in evidence) {
              const index = harness.runtimeSessions.findIndex(
                (session) => session.threadId === input.threadId,
              );
              const previous = harness.runtimeSessions[index]!;
              harness.runtimeSessions.splice(index, 1, {
                ...previous,
                status: "running",
                activeTurnId: asTurnId("existing-pre-upgrade-turn"),
              });
            }
            return {
              threadId: input.threadId,
              turnId: asTurnId("existing-pre-upgrade-turn"),
              ...evidence,
            };
          }),
        );
        await startTurn(harness, `steer-${"deliveryKind" in evidence ? "kind" : "correlation"}`);
        await waitFor(
          async () =>
            (await harness.readModel()).threads[0]?.session?.activeTurnId ===
            "existing-pre-upgrade-turn",
        );
        await harness.drain();
        expect(await configurations(harness)).toEqual([]);
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      },
    );

    it("keeps the original start snapshot when its pending write races a renamed-account steer", async () => {
      const reached = Effect.runSync(Deferred.make<void>());
      const release = Effect.runSync(Deferred.make<void>());
      const names = new Map([["codex", "Original Personal"]]);
      const harness = await createHarness({
        providerDisplayNames: names,
        beforeTurnConfigurationDispatch: Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      harness.sendTurn.mockImplementationOnce((input) =>
        Effect.succeed({
          threadId: input.threadId,
          turnId: asTurnId("frozen-start-turn"),
          deliveryKind: "start",
        }),
      );
      await startTurn(
        harness,
        "before-racing-steer",
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-6.1-sol", [
          { id: "reasoningEffort", value: "ultra" },
        ]),
      );
      await Effect.runPromise(Deferred.await(reached).pipe(Effect.timeout("2 seconds")));
      await waitFor(
        async () => (await harness.readModel()).threads[0]?.session?.status === "running",
      );
      await harness.markThreadReady();
      names.set("codex", "Renamed Personal");
      harness.sendTurn.mockImplementationOnce((input) =>
        Effect.succeed({
          threadId: input.threadId,
          turnId: asTurnId("frozen-start-turn"),
          deliveryKind: "steer",
        }),
      );
      await startTurn(
        harness,
        "racing-steer",
        createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra", [
          { id: "reasoningEffort", value: "low" },
        ]),
      );
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      await harness.drain();
      expect(await configurations(harness)).toEqual([]);
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await waitFor(async () => (await configurations(harness)).length === 1);
      expect((await configurations(harness))[0]).toMatchObject({
        turnId: "frozen-start-turn",
        payload: {
          turnConfiguration: {
            providerDisplayName: "Original Personal",
            model: "gpt-6.1-sol",
            effort: "ultra",
          },
        },
      });
      expect(harness.sendTurn).toHaveBeenCalledTimes(2);
    });
  });

  it.each(metadataHelperSelectionCases)(
    "generates a thread title using $name on the first turn",
    async ({ settingsOverride, expected }) => {
      const harness = await createHarness(settingsOverride);
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
      expect(harness.generateThreadTitle.mock.calls[0]?.[0].modelSelection).toEqual(expected);

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
    },
  );

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

  it.each(metadataHelperSelectionCases)(
    "generates a worktree branch name using $name for the first turn",
    async ({ settingsOverride, expected }) => {
      const harness = await createHarness(settingsOverride);
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
      expect(harness.generateBranchName.mock.calls[0]?.[0].modelSelection).toEqual(expected);
      expect(harness.refreshStatus.mock.calls[0]?.[0]).toBe("/tmp/provider-project-worktree");
      // The branch write proves this detached metadata lane ran. Preserve a
      // custom title without assuming that a separate main-turn send proves
      // the title-eligibility guard has already been evaluated.
      expect((await harness.readModel()).threads[0]?.title).toBe("Keep this custom title");
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();
      expect(harness.generateThreadMetadata).not.toHaveBeenCalled();
    },
  );

  it.each(metadataHelperSelectionCases)(
    "generates and applies first-turn title and branch using $name with one deduplicated request",
    async ({ settingsOverride, expected }) => {
      const harness = await createHarness(settingsOverride);
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
      // Metadata and main-turn delivery are independent fibers. Observing the
      // label writes does not establish that the main provider send ran yet.
      await waitFor(() => harness.sendTurn.mock.calls.length === 1);
      expect(harness.generateThreadMetadata).toHaveBeenCalledTimes(1);
      expect(harness.generateThreadMetadata.mock.calls[0]?.[0]).toMatchObject({
        cwd: "/tmp/provider-project-worktree",
        message: "Add a safer reconnect backoff.",
      });
      expect(harness.generateThreadMetadata.mock.calls[0]?.[0].modelSelection).toEqual(expected);
      expect(harness.generateBranchName).not.toHaveBeenCalled();
      expect(harness.generateThreadTitle).not.toHaveBeenCalled();
      expect(harness.renameBranch).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
    },
  );

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
    const logMessages: unknown[] = [];
    const harness = await createHarness({ logMessages });
    const metadataFailureLog = "provider command reactor failed to generate first-turn metadata";
    const releaseMetadata = Effect.runSync(Deferred.make<void>());
    const metadataSettled = Effect.runSync(Deferred.make<void>());
    harness.generateThreadMetadata.mockReturnValue(
      Deferred.await(releaseMetadata).pipe(
        Effect.andThen(
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadMetadata",
              detail: "controlled metadata failure",
            }),
          ),
        ),
        Effect.ensuring(Deferred.succeed(metadataSettled, undefined)),
      ),
    );
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
    // Wait for each independent lane explicitly. A main-turn ACK must not be
    // used as evidence that the detached metadata fiber has even started.
    await waitFor(() => harness.generateThreadMetadata.mock.calls.length === 1);
    await waitFor(async () => {
      const thread = (await harness.readModel()).threads[0];
      return harness.sendTurn.mock.calls.length === 1 && thread?.session?.status === "running";
    });
    expect(await Effect.runPromise(Deferred.isDone(metadataSettled))).toBe(false);
    expect(harness.renameBranch).not.toHaveBeenCalled();

    // The main turn has already reached Running while metadata is deliberately
    // blocked. Release one known failure, then assert it neither retries paid
    // helper work nor demotes that live turn before testing the next user send.
    await Effect.runPromise(Deferred.succeed(releaseMetadata, undefined));
    await Effect.runPromise(Deferred.await(metadataSettled));
    // The helper effect's finalizer alone runs before its caller handles the
    // failure. Observe that caller's fixed failure log too, so the assertions
    // cannot race a not-yet-executed catch/fallback branch in the detached lane.
    await waitFor(() => logMessages.includes(metadataFailureLog));
    expect(harness.generateThreadMetadata).toHaveBeenCalledTimes(1);
    expect(harness.generateBranchName).not.toHaveBeenCalled();
    expect(harness.generateThreadTitle).not.toHaveBeenCalled();
    expect(harness.renameBranch).not.toHaveBeenCalled();
    const thread = (await harness.readModel()).threads[0];
    expect(thread?.session?.status).toBe("running");
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
    expect(logMessages.filter((message) => message === metadataFailureLog)).toHaveLength(1);
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
      const thread = readModel.threads.find((entry) => entry.id === threadId);
      // Goal synchronization and the interrupt-completed activity are separate
      // durable writes. Observing the first does not prove the second exists.
      return (
        thread?.goal?.status === "paused" &&
        thread.activities.some((activity) => activity.kind === "provider.turn.interrupt.completed")
      );
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

  describe("completed Codex root with running subagents", () => {
    const threadId = ThreadId.make("thread-1");
    const rootTurnId = asTurnId("turn-completed-root-subagents-running");
    const providerThreadId = "native-thread-completed-root-subagents-running";
    const messageId = asMessageId("message-after-root-completion");
    const text = "preserve this exact saved input after the root finishes";

    async function createRootCompletionRace(input?: {
      readonly beforeCodexSteerDeliveryAttemptDispatch?: Effect.Effect<void>;
      readonly beforeCodexRootReplacementDispatch?: Effect.Effect<void>;
      readonly changeRecoveryState?: (harness: Awaited<ReturnType<typeof createHarness>>) => void;
    }) {
      const harness = await createHarness({
        liveSteer: "supported",
        ...(input?.beforeCodexSteerDeliveryAttemptDispatch !== undefined
          ? {
              beforeCodexSteerDeliveryAttemptDispatch:
                input.beforeCodexSteerDeliveryAttemptDispatch,
            }
          : {}),
        ...(input?.beforeCodexRootReplacementDispatch !== undefined
          ? { beforeCodexRootReplacementDispatch: input.beforeCodexRootReplacementDispatch }
          : {}),
      });
      await harness.setRunningCodexTurn(rootTurnId, "2026-01-01T00:00:01.000Z");
      harness.runtimeSessions[0] = {
        ...harness.runtimeSessions[0]!,
        cwd: "/tmp/provider-project",
        model: "gpt-5-codex",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      };
      harness.durableProviderBindings.push({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        runtimeMode: "approval-required",
        runtimePayload: { activeTurnId: rootTurnId, ...liveDurableRuntimeOwnerPayload() },
        resumeCursor: { threadId: providerThreadId },
        lastSeenAt: "2026-01-01T00:00:03.000Z",
      });
      harness.steerTurn.mockImplementationOnce(() =>
        Effect.gen(function* () {
          const current = harness.runtimeSessions[0]!;
          // The root completes between admission and turn/steer. The adapter
          // keeps the aggregate running id for its live children, but exposes
          // exact root-completion evidence in the next fresh inventory read.
          harness.runtimeSessions[0] = {
            ...current,
            resumeCursor: { threadId: providerThreadId },
            codexRootTurnCompletion: {
              turnId: rootTurnId,
              providerThreadId,
              observedAt: "2026-01-01T00:00:03.000Z",
            },
          };
          input?.changeRecoveryState?.(harness);
          return yield* Effect.fail(
            new ProviderAdapterRequestError({
              provider: "provider-daemon",
              method: "steerTurn",
              detail:
                "Provider adapter request failed (codex) for turn/steer: no active turn to steer",
            }),
          );
        }),
      );
      const dispatchSteer = (commandId = "cmd-steer-after-root-completion") =>
        Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.steer",
            commandId: CommandId.make(commandId),
            threadId,
            message: { messageId, role: "user", text, attachments: [] },
            createdAt: "2026-01-01T00:00:02.000Z",
          }),
        );
      const waitForRecoveryOutcome = () =>
        waitFor(async () => {
          const thread = await harness.readThreadDetail(threadId);
          return (
            thread?.activities.some(
              (activity) =>
                activity.kind === "provider.turn.steer.delivered" ||
                activity.kind === "provider.turn.steer.failed",
            ) === true
          );
        });
      return { ...harness, dispatchSteer, waitForRecoveryOutcome };
    }

    it("delivers the original steer once as a new root despite aggregate durable running state", async () => {
      const harness = await createRootCompletionRace();
      const nextTurnId = asTurnId("turn-next-root");
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.sync(() => {
          expect(harness.runtimeSessions[0]).toMatchObject({
            status: "running",
            activeTurnId: rootTurnId,
          });
          const { codexRootTurnCompletion: _completion, ...session } = harness.runtimeSessions[0]!;
          harness.runtimeSessions[0] = { ...session, activeTurnId: nextTurnId };
          return { threadId, turnId: nextTurnId };
        }),
      );
      await harness.dispatchSteer();
      await harness.waitForRecoveryOutcome();
      await harness.drain();

      expect(harness.steerTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn.mock.calls[0]?.[0]).toMatchObject({
        threadId,
        messageId,
        input: text,
        allowActiveTurnSteerFallback: false,
        expectedCompletedRootTurnId: rootTurnId,
      });
      const thread = await harness.readThreadDetail(threadId);
      expect(thread?.session).toMatchObject({ status: "running", activeTurnId: nextTurnId });
      expect(
        thread?.activities.filter((activity) => activity.kind === "provider.turn.steer.delivered"),
      ).toHaveLength(1);
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.failed"),
      ).toBe(false);
      expect(await harness.getUnsettledCodexSteerIntentEvents()).toEqual([]);
    });

    it("preserves aggregate running projection before the replacement root is submitted", async () => {
      const releaseMarker = Effect.runSync(Deferred.make<void>());
      let attemptedMarkers = 0;
      const harness = await createRootCompletionRace({
        beforeCodexSteerDeliveryAttemptDispatch: Effect.gen(function* () {
          attemptedMarkers += 1;
          if (attemptedMarkers === 2) yield* Deferred.await(releaseMarker);
        }),
      });
      await harness.dispatchSteer();
      await waitFor(() => attemptedMarkers === 2);

      // Subagents still own aggregate work throughout recovery. A synthetic
      // ready/null-active projection would temporarily hide Stop and expose
      // idle-only controls before the provider accepts a replacement root.
      expect(harness.sendTurn).not.toHaveBeenCalled();
      const thread = await harness.readThreadDetail(threadId);
      expect(thread?.session).toMatchObject({ status: "running", activeTurnId: rootTurnId });
      const events = await Effect.runPromise(harness.engine.readEvents(0).pipe(Stream.runCollect));
      expect(
        events.some(
          (event) =>
            event.type === "thread.session-set" &&
            event.payload.threadId === threadId &&
            event.payload.session?.status === "ready",
        ),
      ).toBe(false);

      await Effect.runPromise(Deferred.succeed(releaseMarker, undefined));
      await harness.waitForRecoveryOutcome();
      await harness.drain();
    });

    it("admits a new user-authorized retry of the same message after a rejected next-root send", async () => {
      const harness = await createRootCompletionRace();
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "codex",
            method: "turn/start",
            detail: "simulated explicit provider rejection before accepting input",
          }),
        ),
      );
      const firstIntent = await harness.dispatchSteer();
      await harness.waitForRecoveryOutcome();
      await harness.drain();
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);

      // A new command id creates new durable user authorization while keeping
      // the immutable message id and content. The prior in-memory recovery
      // cache entry must not consume this distinct intent generation.
      const nextTurnId = asTurnId("turn-retried-next-root");
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.sync(() => {
          const { codexRootTurnCompletion: _completion, ...session } = harness.runtimeSessions[0]!;
          harness.runtimeSessions[0] = { ...session, activeTurnId: nextTurnId };
          return { threadId, turnId: nextTurnId };
        }),
      );
      const retryIntent = await harness.dispatchSteer("cmd-user-authorized-root-retry");
      expect(retryIntent.sequence).toBeGreaterThan(firstIntent.sequence);
      await waitFor(() => harness.sendTurn.mock.calls.length === 2);
      await waitFor(async () => {
        const thread = await harness.readThreadDetail(threadId);
        return (
          thread?.activities.some(
            (activity) =>
              activity.kind === "provider.turn.steer.delivered" &&
              (activity.payload as Readonly<Record<string, unknown>> | undefined)
                ?.intentSequence === retryIntent.sequence,
          ) === true
        );
      });
      await harness.drain();

      expect(harness.steerTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn.mock.calls[1]?.[0]).toMatchObject({
        threadId,
        messageId,
        input: text,
        expectedCompletedRootTurnId: rootTurnId,
      });
      const thread = await harness.readThreadDetail(threadId);
      expect(thread?.messages.filter((message) => message.id === messageId)).toHaveLength(1);
      expect(thread?.session).toMatchObject({ status: "running", activeTurnId: nextTurnId });
      expect(await harness.getUnsettledCodexSteerIntentEvents()).toEqual([]);
    });

    it.each([
      "newer-projection",
      "newer-provider-turn",
      "missing-inventory",
      "failed-inventory",
      "mismatched-instance",
      "missing-instance",
    ] as const)(
      "preserves newer or unverified projection state after a recovery ACK with %s",
      async (variant) => {
        const harness = await createRootCompletionRace();
        const acknowledgedTurnId = asTurnId("turn-recovery-ack");
        const newerTurnId = asTurnId("turn-newer-than-recovery-ack");
        const ack = Effect.runSync(
          Deferred.make<{ readonly threadId: ThreadId; readonly turnId: TurnId }>(),
        );
        harness.sendTurn.mockImplementationOnce(() => Deferred.await(ack));
        await harness.dispatchSteer();
        await waitFor(() => harness.sendTurn.mock.calls.length === 1);

        const { codexRootTurnCompletion: _completion, ...activeSession } =
          harness.runtimeSessions[0]!;
        if (variant === "newer-projection") {
          await harness.setRunningCodexTurn(newerTurnId, "2026-01-01T00:00:04.000Z");
        }
        // The provider ACK arrives after its final admission check. Only a
        // fresh matching native turn and instance can replace the exact old
        // aggregate root; neither a later root nor unavailable inventory can.
        harness.runtimeSessions[0] = {
          ...activeSession,
          activeTurnId: variant === "newer-provider-turn" ? newerTurnId : acknowledgedTurnId,
        };
        if (variant === "missing-inventory") {
          harness.runtimeSessions.length = 0;
        } else if (variant === "failed-inventory") {
          harness.listSessions.mockImplementation(() =>
            Effect.die(new Error("inventory unavailable after ACK")),
          );
        } else if (variant === "mismatched-instance") {
          harness.runtimeSessions[0] = {
            ...harness.runtimeSessions[0]!,
            providerInstanceId: ProviderInstanceId.make("codex_other"),
          };
        } else if (variant === "missing-instance") {
          const { providerInstanceId: _instance, ...withoutInstance } = harness.runtimeSessions[0]!;
          harness.runtimeSessions[0] = withoutInstance;
        }
        await Effect.runPromise(Deferred.succeed(ack, { threadId, turnId: acknowledgedTurnId }));
        await harness.waitForRecoveryOutcome();
        await harness.drain();

        const thread = await harness.readThreadDetail(threadId);
        expect(thread?.session).toMatchObject({
          status: "running",
          activeTurnId: variant === "newer-projection" ? newerTurnId : rootTurnId,
          providerInstanceId: ProviderInstanceId.make("codex"),
        });
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(harness.steerTurn).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      { phase: "inventory read", barrier: "Stop" },
      { phase: "inventory read", barrier: "newer root" },
      { phase: "guarded session write", barrier: "Stop" },
      { phase: "guarded session write", barrier: "newer root" },
    ] as const)(
      "honors $barrier committed during the post-ACK $phase",
      async ({ phase, barrier }) => {
        const releasePause = Effect.runSync(Deferred.make<void>());
        let pauseReached = false;
        const pause = Effect.gen(function* () {
          pauseReached = true;
          yield* Deferred.await(releasePause);
        });
        const harness = await createRootCompletionRace(
          phase === "guarded session write" ? { beforeCodexRootReplacementDispatch: pause } : {},
        );
        const acknowledgedTurnId = asTurnId("turn-accepted-before-post-ack-race");
        const newerTurnId = asTurnId("turn-started-during-post-ack-race");
        harness.sendTurn.mockImplementationOnce(() =>
          Effect.sync(() => {
            const { codexRootTurnCompletion: _completion, ...session } =
              harness.runtimeSessions[0]!;
            const acceptedSession = { ...session, activeTurnId: acknowledgedTurnId };
            harness.runtimeSessions[0] = acceptedSession;
            if (phase === "inventory read") {
              harness.listSessions.mockImplementationOnce(() =>
                pause.pipe(Effect.as([acceptedSession])),
              );
            }
            return { threadId, turnId: acknowledgedTurnId };
          }),
        );
        await harness.dispatchSteer();
        await waitFor(() => pauseReached);

        // Stop/newer state commits while the recovery worker is suspended after
        // its provider ACK. The inventory response can still describe the ACK
        // turn, and the session write can already have been constructed; neither
        // may overwrite a later durable user-control or projected-turn barrier.
        if (barrier === "Stop") {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.session.stop",
              commandId: CommandId.make(`cmd-stop-during-post-ack-${phase.replaceAll(" ", "-")}`),
              threadId,
              createdAt: "2026-01-01T00:00:04.000Z",
            }),
          );
          await waitFor(
            async () => (await harness.readThreadDetail(threadId))?.session?.status === "stopped",
          );
        } else {
          await harness.setRunningCodexTurn(newerTurnId, "2026-01-01T00:00:04.000Z");
        }
        await Effect.runPromise(Deferred.succeed(releasePause, undefined));
        await harness.waitForRecoveryOutcome();
        await harness.drain();

        const thread = await harness.readThreadDetail(threadId);
        expect(thread?.session).toMatchObject(
          barrier === "Stop"
            ? { status: "stopped", activeTurnId: null }
            : { status: "running", activeTurnId: newerTurnId },
        );
        expect(harness.sendTurn).toHaveBeenCalledTimes(1);
        expect(harness.steerTurn).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      "missing-proof",
      "stale-turn-proof",
      "mismatched-native-thread",
      "newer-durable-turn",
      "different-instance",
      "unverified-owner",
      "failed-ownership-read",
    ] as const)("keeps the saved steer queued for %s", async (variant) => {
      const harness = await createRootCompletionRace({
        changeRecoveryState: (currentHarness) => {
          const session = currentHarness.runtimeSessions[0]!;
          const binding = currentHarness.durableProviderBindings[0]!;
          if (variant === "missing-proof") {
            const { codexRootTurnCompletion: _completion, ...withoutCompletion } = session;
            currentHarness.runtimeSessions[0] = withoutCompletion;
          } else if (variant === "stale-turn-proof" || variant === "mismatched-native-thread") {
            currentHarness.runtimeSessions[0] = {
              ...session,
              codexRootTurnCompletion: {
                ...session.codexRootTurnCompletion!,
                ...(variant === "stale-turn-proof"
                  ? { turnId: asTurnId("turn-older-root") }
                  : { providerThreadId: "native-thread-older-root" }),
              },
            };
          } else if (variant === "newer-durable-turn") {
            currentHarness.durableProviderBindings[0] = {
              ...binding,
              runtimePayload: {
                activeTurnId: asTurnId("turn-newer-root"),
                ...liveDurableRuntimeOwnerPayload(),
              },
            };
          } else if (variant === "different-instance") {
            currentHarness.durableProviderBindings[0] = {
              ...binding,
              providerInstanceId: ProviderInstanceId.make("codex_other"),
            };
          } else if (variant === "unverified-owner") {
            currentHarness.durableProviderBindings[0] = {
              ...binding,
              runtimePayload: { activeTurnId: rootTurnId },
            };
          } else {
            currentHarness.getBinding.mockImplementation(() =>
              Effect.die(new Error("ownership unavailable")),
            );
          }
        },
      });
      await harness.dispatchSteer();
      await harness.waitForRecoveryOutcome();
      await harness.drain();

      expect(harness.steerTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).not.toHaveBeenCalled();
      const thread = await harness.readThreadDetail(threadId);
      expect(
        thread?.messages.some((message) => message.id === messageId && message.text === text),
      ).toBe(true);
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.failed"),
      ).toBe(true);
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.delivered"),
      ).toBe(false);
    });

    it.each(["Stop", "newer turn", "withdrawn root proof"] as const)(
      "honors %s after root proof but before recovery I/O",
      async (barrier) => {
        const releaseMarker = Effect.runSync(Deferred.make<void>());
        let attemptedMarkers = 0;
        const harness = await createRootCompletionRace({
          beforeCodexSteerDeliveryAttemptDispatch: Effect.gen(function* () {
            attemptedMarkers += 1;
            // The first marker authorizes the rejected steer; the second marks
            // its replacement turn/start. Pause only that recovery boundary.
            if (attemptedMarkers === 2) yield* Deferred.await(releaseMarker);
          }),
        });
        await harness.dispatchSteer();
        await waitFor(() => attemptedMarkers === 2);
        if (barrier === "Stop") {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.make("cmd-stop-after-root-completion"),
              threadId,
              turnId: rootTurnId,
              createdAt: "2026-01-01T00:00:04.000Z",
            }),
          );
        } else if (barrier === "newer turn") {
          await harness.setRunningCodexTurn(
            asTurnId("turn-newer-root"),
            "2026-01-01T00:00:04.000Z",
          );
        } else {
          const { codexRootTurnCompletion: _completion, ...withoutCompletion } =
            harness.runtimeSessions[0]!;
          harness.runtimeSessions[0] = withoutCompletion;
        }
        await Effect.runPromise(Deferred.succeed(releaseMarker, undefined));
        await harness.waitForRecoveryOutcome();
        await harness.drain();

        expect(harness.steerTurn).toHaveBeenCalledTimes(1);
        expect(harness.sendTurn).not.toHaveBeenCalled();
        const thread = await harness.readThreadDetail(threadId);
        expect(
          thread?.activities.some((activity) => activity.kind === "provider.turn.steer.failed"),
        ).toBe(true);
        expect(
          thread?.activities.some((activity) => activity.kind === "provider.turn.steer.delivered"),
        ).toBe(false);
      },
    );

    it("does not resend after an ambiguous next-root submission outcome", async () => {
      const harness = await createRootCompletionRace();
      harness.sendTurn.mockImplementationOnce(() =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: "provider-daemon",
            method: "sendTurn",
            detail: "simulated lost turn/start acknowledgement",
          }),
        ),
      );
      await harness.dispatchSteer();
      await harness.waitForRecoveryOutcome();
      await harness.drain();
      // Repeating the original durable command is idempotent even when the
      // provider may have accepted it before the acknowledgement was lost.
      await harness.dispatchSteer();
      await harness.drain();

      expect(harness.steerTurn).toHaveBeenCalledTimes(1);
      expect(harness.sendTurn).toHaveBeenCalledTimes(1);
      const thread = await harness.readThreadDetail(threadId);
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.failed"),
      ).toBe(true);
      expect(
        thread?.activities.some((activity) => activity.kind === "provider.turn.steer.delivered"),
      ).toBe(false);
      expect(await harness.getUnsettledCodexSteerIntentEvents()).toEqual([]);
    });
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
    // The failed attempt must be newer than its original intent; otherwise
    // queued initialization events can erase the visible rejection.
    expect(Date.parse(thread!.session!.updatedAt)).toBeGreaterThan(Date.parse(now));
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
