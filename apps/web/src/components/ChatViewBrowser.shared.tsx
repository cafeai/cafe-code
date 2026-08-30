// Production CSS is part of the behavior under test because row height depends on it.
import "../index.css";

import {
  EventId,
  type DesktopBridge,
  ORCHESTRATION_WS_METHODS,
  EnvironmentId,
  type DesktopSourceUpdateState,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ThreadId,
  type TurnId,
  WS_METHODS,
  OrchestrationSessionStatus,
  DEFAULT_SERVER_SETTINGS,
  ServerConfig as ServerConfigSchema,
} from "@cafecode/contracts";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import { createModelCapabilities, createModelSelection } from "@cafecode/shared/model";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { page, userEvent } from "vitest/browser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { __resetEnvironmentApiOverridesForTests } from "../environmentApi";
import { isMacPlatform } from "../lib/utils";
import { resetSourceControlDiscoveryStateForTests } from "../lib/sourceControlDiscoveryState";
import { __resetLocalApiForTests } from "../localApi";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { getServerConfig } from "../rpc/serverState";
import { getRouter } from "../router";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { selectBootstrapCompleteForActiveEnvironment, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTaskAtriumStore } from "./atrium/taskAtriumStore";
import { createAuthenticatedSessionHandlers } from "../../test/authHttpHandlers";
import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";

import { DEFAULT_CLIENT_SETTINGS } from "@cafecode/contracts/settings";

vi.mock("../lib/gitStatusState", () => ({
  useGitStatus: () => ({ data: null, error: null, cause: null, isPending: false }),
  useGitStatuses: () => new Map(),
  refreshGitStatus: () => Promise.resolve(null),
  resetGitStatusStateForTests: () => undefined,
}));

const THREAD_ID = "thread-browser-test" as ThreadId;
const THREAD_TITLE = "Browser test thread";
const ARCHIVED_SECONDARY_THREAD_ID = "thread-secondary-project-archived" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const SECOND_PROJECT_ID = "project-2" as ProjectId;
const LOCAL_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_REF = scopeThreadRef(LOCAL_ENVIRONMENT_ID, THREAD_ID);
const THREAD_KEY = scopedThreadKey(THREAD_REF);
const UUID_ROUTE_RE = /^\/draft\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_DRAFT_KEY = `${LOCAL_ENVIRONMENT_ID}:${PROJECT_ID}`;
const PROJECT_LOGICAL_KEY = deriveLogicalProjectKeyFromSettings(
  {
    environmentId: LOCAL_ENVIRONMENT_ID,
    id: PROJECT_ID,
    cwd: "/repo/project",
    repositoryIdentity: null,
  },
  {
    sidebarProjectGroupingMode: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: DEFAULT_CLIENT_SETTINGS.sidebarProjectGroupingOverrides,
  },
);
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'></svg>";
const ADD_PROJECT_SUBMENU_PLACEHOLDER = "Enter path (e.g. ~/projects/my-app)";

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: ServerLifecycleWelcomePayload;
}

let fixture: TestFixture;
const rpcHarness = new BrowserWsRpcHarness();
const wsRequests = rpcHarness.requests;
let customWsRpcResolver: ((body: NormalizedWsRpcRequestBody) => unknown | undefined) | null = null;
const wsLink = ws.link(/ws(s)?:\/\/.*/);
const encodeServerConfig = Schema.encodeSync(ServerConfigSchema);

interface ViewportSpec {
  name: string;
  width: number;
  height: number;
  textTolerancePx: number;
  attachmentTolerancePx: number;
}

const DEFAULT_VIEWPORT: ViewportSpec = {
  name: "desktop",
  width: 960,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const WIDE_FOOTER_VIEWPORT: ViewportSpec = {
  name: "wide-footer",
  width: 1_400,
  height: 1_100,
  textTolerancePx: 44,
  attachmentTolerancePx: 56,
};
const COMPACT_FOOTER_VIEWPORT: ViewportSpec = {
  name: "compact-footer",
  width: 430,
  height: 932,
  textTolerancePx: 56,
  attachmentTolerancePx: 56,
};

interface MountedChatView {
  [Symbol.asyncDispose]: () => Promise<void>;
  cleanup: () => Promise<void>;
  setViewport: (viewport: ViewportSpec) => Promise<void>;
  setContainerSize: (viewport: Pick<ViewportSpec, "width" | "height">) => Promise<void>;
  router: ReturnType<typeof getRouter>;
}

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-local"),
      label: "Local environment",
      platform: { os: "darwin" as const, arch: "arm64" as const },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    systemPromptPath: "/repo/project/.t3code-system-prompt.md",
    keybindings: [],
    issues: [],
    providers: [
      {
        driver: ProviderDriverKind.make("codex"),
        instanceId: ProviderInstanceId.make("codex"),
        enabled: true,
        installed: true,
        version: "0.116.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: NOW_ISO,
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
    },
    clientSettings: { ...DEFAULT_CLIENT_SETTINGS, onboardingCompleted: true },
  };
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: { id: MessageId; text: string; offsetSeconds: number }) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
  sessionStatus?: OrchestrationSessionStatus;
  provider?: "codex" | "claudeAgent";
  runtimeMode?: RuntimeMode;
}): OrchestrationReadModel {
  const provider = ProviderDriverKind.make(options.provider ?? "codex");
  const instanceId = ProviderInstanceId.make(options.provider ?? "codex");
  const model = provider === "claudeAgent" ? "claude-opus-4-8" : "gpt-5";
  const runtimeMode = options.runtimeMode ?? "full-access";
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
            previewUrl: `/attachments/attachment-${attachmentIndex + 1}`,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        additionalWorkspaceRoots: [],
        defaultModelSelection: {
          instanceId,
          model,
        },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: THREAD_TITLE,
        modelSelection: {
          instanceId,
          model,
        },
        interactionMode: "default",
        runtimeMode,
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        deletedAt: null,
        messages,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: options.sessionStatus ?? "ready",
          providerName: provider,
          runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    welcome: {
      environment: {
        environmentId: EnvironmentId.make("environment-local"),
        label: "Local environment",
        platform: { os: "darwin" as const, arch: "arm64" as const },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function addThreadToSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: [
      ...snapshot.threads,
      {
        id: threadId,
        projectId: PROJECT_ID,
        title: "New thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5",
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
  };
}

function toShellThread(thread: OrchestrationReadModel["threads"][number]) {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    latestTurn: thread.latestTurn,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    session: thread.session,
    latestUserMessageAt:
      thread.messages.findLast((message) => message.role === "user")?.createdAt ?? null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function toShellSnapshot(snapshot: OrchestrationReadModel) {
  return {
    snapshotSequence: snapshot.snapshotSequence,
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      repositoryIdentity: project.repositoryIdentity ?? null,
      defaultModelSelection: project.defaultModelSelection,
      scripts: project.scripts,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    })),
    threads: snapshot.threads.map(toShellThread),
    updatedAt: snapshot.updatedAt,
  };
}

function updateThreadSessionInSnapshot(
  snapshot: OrchestrationReadModel,
  threadId: ThreadId,
  session: OrchestrationReadModel["threads"][number]["session"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    snapshotSequence: snapshot.snapshotSequence + 1,
    threads: snapshot.threads.map((thread) =>
      thread.id === threadId
        ? {
            ...thread,
            session,
            updatedAt: NOW_ISO,
          }
        : thread,
    ),
  };
}

function sendShellThreadUpsert(
  threadId: ThreadId,
  options?: {
    readonly session?: OrchestrationReadModel["threads"][number]["session"];
  },
): void {
  const thread = fixture.snapshot.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error(`Expected thread ${threadId} in snapshot.`);
  }

  const shellThread =
    options?.session !== undefined
      ? toShellThread({ ...thread, session: options.session })
      : toShellThread(thread);
  rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeShell, {
    kind: "thread-upserted",
    sequence: fixture.snapshot.snapshotSequence,
    thread: shellThread,
  });
}

async function waitForWsClient(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        wsRequests.some((request) => request._tag === ORCHESTRATION_WS_METHODS.subscribeShell),
      ).toBe(true);
      expect(
        wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerLifecycle),
      ).toBe(true);
      expect(wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig)).toBe(
        true,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

function threadRefFor(threadId: ThreadId) {
  return scopeThreadRef(LOCAL_ENVIRONMENT_ID, threadId);
}

function threadKeyFor(threadId: ThreadId): string {
  return scopedThreadKey(threadRefFor(threadId));
}

function composerDraftFor(target: string) {
  const { draftsByThreadKey } = useComposerDraftStore.getState();
  return draftsByThreadKey[target] ?? draftsByThreadKey[threadKeyFor(target as ThreadId)];
}

function draftIdFromPath(pathname: string) {
  const segments = pathname.split("/");
  const draftId = segments[segments.length - 1];
  if (!draftId) {
    throw new Error(`Expected thread path, received "${pathname}".`);
  }
  return DraftId.make(draftId);
}

function draftThreadIdFor(draftId: ReturnType<typeof draftIdFromPath>): ThreadId {
  const draftSession = useComposerDraftStore.getState().getDraftSession(draftId);
  if (!draftSession) {
    throw new Error(`Expected draft session for "${draftId}".`);
  }
  return draftSession.threadId;
}

function serverThreadPath(threadId: ThreadId): string {
  return `/${LOCAL_ENVIRONMENT_ID}/${threadId}`;
}

async function waitForAppBootstrap(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(getServerConfig()).not.toBeNull();
      expect(selectBootstrapCompleteForActiveEnvironment(useStore.getState())).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function materializePromotedDraftThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  await waitForWsClient();
  fixture.snapshot = addThreadToSnapshot(fixture.snapshot, threadId);
  fixture.snapshot = updateThreadSessionInSnapshot(fixture.snapshot, threadId, null);
  sendShellThreadUpsert(threadId, { session: null });
}

async function startPromotedServerThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  fixture.snapshot = updateThreadSessionInSnapshot(fixture.snapshot, threadId, {
    threadId,
    status: "running",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: `turn-${threadId}` as TurnId,
    lastError: null,
    updatedAt: NOW_ISO,
  });
  sendShellThreadUpsert(threadId);
}

async function promoteDraftThreadViaDomainEvent(threadId: ThreadId): Promise<void> {
  await materializePromotedDraftThreadViaDomainEvent(threadId);
  await startPromotedServerThreadViaDomainEvent(threadId);
  await vi.waitFor(
    () => {
      expect(useComposerDraftStore.getState().draftThreadsByThreadKey[threadKeyFor(threadId)]).toBe(
        undefined,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

function createDraftOnlySnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-draft-target" as MessageId,
    targetText: "draft thread",
  });
  return {
    ...snapshot,
    threads: [],
  };
}

function createProjectlessSnapshot(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-projectless-target" as MessageId,
    targetText: "projectless",
  });
  return {
    ...snapshot,
    projects: [],
    threads: [],
  };
}

function withProjectScripts(
  snapshot: OrchestrationReadModel,
  scripts: OrchestrationReadModel["projects"][number]["scripts"],
): OrchestrationReadModel {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, scripts: Array.from(scripts) } : project,
    ),
  };
}

function setDraftThreadWithoutWorktree(): void {
  useComposerDraftStore.setState({
    draftThreadsByThreadKey: {
      [THREAD_KEY]: {
        threadId: THREAD_ID,
        environmentId: LOCAL_ENVIRONMENT_ID,
        projectId: PROJECT_ID,
        logicalProjectKey: PROJECT_DRAFT_KEY,
        createdAt: NOW_ISO,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        envMode: "local",
      },
    },
    logicalProjectDraftThreadKeyByLogicalProjectKey: {
      [PROJECT_DRAFT_KEY]: THREAD_KEY,
    },
  });
}

function createSnapshotWithLongProposedPlan(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-target" as MessageId,
    targetText: "plan thread",
  });
  const planMarkdown = [
    "# Ship plan mode follow-up",
    "",
    "- Step 1: capture the thread-open trace",
    "- Step 2: identify the main-thread bottleneck",
    "- Step 3: keep collapsed cards cheap",
    "- Step 4: render the full markdown only on demand",
    "- Step 5: preserve export and save actions",
    "- Step 6: add regression coverage",
    "- Step 7: verify route transitions stay responsive",
    "- Step 8: confirm no server-side work changed",
    "- Step 9: confirm short plans still render normally",
    "- Step 10: confirm long plans stay collapsed by default",
    "- Step 11: confirm preview text is still useful",
    "- Step 12: confirm plan follow-up flow still works",
    "- Step 13: confirm timeline virtualization still behaves",
    "- Step 14: confirm theme styling still looks correct",
    "- Step 15: confirm save dialog behavior is unchanged",
    "- Step 16: confirm download behavior is unchanged",
    "- Step 17: confirm code fences do not parse until expand",
    "- Step 18: confirm preview truncation ends cleanly",
    "- Step 19: confirm markdown links still open in editor after expand",
    "- Step 20: confirm deep hidden detail only appears after expand",
    "",
    "```ts",
    "export const hiddenPlanImplementationDetail = 'deep hidden detail only after expand';",
    "```",
  ].join("\n");

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            proposedPlans: [
              {
                id: "plan-browser-test",
                turnId: null,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_000),
                updatedAt: isoAt(1_001),
              },
            ],
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

const RUNTIME_TASK_TURN_ID = "turn-runtime-task-progress" as TurnId;
const RUNTIME_TASK_DESCRIPTIONS = [
  "Inspect the current orchestration projection and confirm the running turn owns the latest provider checklist snapshot.",
  "Trace the composer footer layout across desktop and compact widths without moving provider controls out of their established order.",
  "Preserve the exact provider-authored task descriptions so long instructions remain available instead of being shortened to a summary.",
  "Verify completed task styling and progress accounting against the durable statuses supplied by the runtime event.",
  "Render the current in-progress task in the composer pill and keep its full description available inside the task popover.",
  "Keep every pending task mounted in document order so assistive technology and browser search can reach the complete checklist.",
  "Constrain the task popover to the visual viewport while allowing deliberately long descriptions to wrap without horizontal overflow.",
  "Provide an independently scrollable task list so a large provider checklist never pushes the composer beyond the available screen height.",
  "Support fine-pointer hover without taking away the ordinary button press used by touch, keyboard, and browser automation clients.",
  "Return focus to the task progress trigger after Escape closes the popup so keyboard users remain at a predictable composer position.",
  "Keep runtime task snapshots out of the authored plan sidebar and do not expose a stale Tasks or Plan panel toggle during execution.",
  "Confirm the task progress control disappears when the current turn settles or the latest provider checklist is explicitly empty.",
] as const;

type RuntimeTaskStep = {
  readonly step: string;
  readonly status: "completed" | "inProgress" | "pending";
};

const RUNTIME_TASK_STEPS: ReadonlyArray<RuntimeTaskStep> = RUNTIME_TASK_DESCRIPTIONS.map(
  (step, index) => ({
    step,
    status: index < 4 ? "completed" : index === 4 ? "inProgress" : "pending",
  }),
);

/**
 * Build the provider-neutral shape produced after a real runtime `update_plan`
 * event. Keeping latest-turn and session ownership aligned is important here:
 * ChatView intentionally suppresses stale or terminal-turn checklists even when
 * an older `turn.plan.updated` activity remains in the durable thread history.
 */
function createSnapshotWithRuntimeTaskProgress(options?: {
  readonly steps?: ReadonlyArray<RuntimeTaskStep>;
  readonly terminal?: boolean;
  readonly withAuthoredPlan?: boolean;
}): OrchestrationReadModel {
  const snapshot = options?.withAuthoredPlan
    ? createSnapshotWithPlanFollowUpPrompt()
    : createSnapshotForTargetUser({
        targetMessageId: "msg-user-runtime-task-progress" as MessageId,
        targetText: "implement the runtime task checklist",
      });
  const terminal = options?.terminal ?? false;
  const steps = options?.steps ?? RUNTIME_TASK_STEPS;

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            interactionMode: terminal ? thread.interactionMode : ("default" as const),
            latestTurn: {
              turnId: RUNTIME_TASK_TURN_ID,
              state: terminal ? ("completed" as const) : ("running" as const),
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: terminal ? isoAt(1_020) : null,
              assistantMessageId: null,
              ...(options?.withAuthoredPlan
                ? {
                    sourceProposedPlan: {
                      threadId: THREAD_ID,
                      planId: "plan-follow-up-browser-test",
                    },
                  }
                : {}),
            },
            activities: [
              {
                id: EventId.make("activity-runtime-task-progress"),
                tone: "info" as const,
                kind: "turn.plan.updated",
                summary: "Runtime task plan updated",
                payload: {
                  explanation:
                    "The provider is working through the complete implementation checklist for the current turn.",
                  plan: [...steps],
                },
                turnId: RUNTIME_TASK_TURN_ID,
                sequence: 1,
                createdAt: isoAt(1_005),
              },
            ],
            session: {
              ...thread.session,
              status: terminal ? ("ready" as const) : ("running" as const),
              activeTurnId: terminal ? null : RUNTIME_TASK_TURN_ID,
              updatedAt: terminal ? isoAt(1_020) : isoAt(1_005),
            },
            updatedAt: terminal ? isoAt(1_020) : isoAt(1_005),
          })
        : thread,
    ),
  };
}

function createSnapshotWithActiveSubagent(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-active-subagent" as MessageId,
    targetText: "verify subagent and Atrium navigation",
    sessionStatus: "running",
  });
  const turnId = "turn-active-subagent" as TurnId;
  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            latestTurn: {
              turnId,
              state: "running" as const,
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            activities: [
              {
                id: EventId.make("activity-active-subagent"),
                tone: "info" as const,
                kind: "task.started",
                summary: "Subagent started",
                payload: {
                  taskId: "provider-child-browser-audit",
                  taskType: "subagent",
                  subagent: {
                    threadId: "provider-child-browser-audit",
                    label: "Browser lifecycle audit",
                    path: "/root/browser_lifecycle_audit",
                    objective: "Verify Atrium navigation",
                    status: "active",
                    startedAt: isoAt(1_001),
                  },
                },
                turnId,
                sequence: 1,
                createdAt: isoAt(1_001),
              },
            ],
            session: {
              ...thread.session,
              status: "running" as const,
              activeTurnId: turnId,
              updatedAt: isoAt(1_001),
            },
            updatedAt: isoAt(1_001),
          })
        : thread,
    ),
  };
}

function createSnapshotWithSecondaryProject(options?: {
  includeSecondaryThread?: boolean;
  includeArchivedSecondaryThread?: boolean;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-secondary-project-target" as MessageId,
    targetText: "secondary project",
  });
  const includeSecondaryThread = options?.includeSecondaryThread ?? true;
  const includeArchivedSecondaryThread = options?.includeArchivedSecondaryThread ?? true;
  const secondaryThreads: OrchestrationReadModel["threads"] = includeSecondaryThread
    ? [
        {
          id: "thread-secondary-project" as ThreadId,
          projectId: SECOND_PROJECT_ID,
          title: "Release checklist",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "release/docs-portal",
          worktreePath: null,
          latestTurn: null,
          createdAt: isoAt(30),
          updatedAt: isoAt(31),
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: {
            threadId: "thread-secondary-project" as ThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: isoAt(31),
          },
          archivedAt: null,
        },
      ]
    : [];
  const archivedSecondaryThreads: OrchestrationReadModel["threads"] = includeArchivedSecondaryThread
    ? [
        {
          id: ARCHIVED_SECONDARY_THREAD_ID,
          projectId: SECOND_PROJECT_ID,
          title: "Archived Docs Notes",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: "release/docs-archive",
          worktreePath: null,
          latestTurn: null,
          createdAt: isoAt(24),
          updatedAt: isoAt(25),
          deletedAt: null,
          messages: [],
          activities: [],
          proposedPlans: [],
          checkpoints: [],
          session: {
            threadId: ARCHIVED_SECONDARY_THREAD_ID,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: isoAt(25),
          },
          archivedAt: isoAt(26),
        },
      ]
    : [];

  return {
    ...snapshot,
    projects: [
      ...snapshot.projects,
      {
        id: SECOND_PROJECT_ID,
        title: "Docs Portal",
        workspaceRoot: "/repo/clients/docs-portal",
        additionalWorkspaceRoots: [],
        defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [...snapshot.threads, ...secondaryThreads, ...archivedSecondaryThreads],
  };
}

function createSnapshotWithPendingUserInput(): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-pending-input-target" as MessageId,
    targetText: "question thread",
  });

  return {
    ...snapshot,
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            interactionMode: "plan",
            activities: [
              {
                id: EventId.make("activity-user-input-requested"),
                tone: "info",
                kind: "user-input.requested",
                summary: "User input requested",
                payload: {
                  requestId: "req-browser-user-input",
                  questions: [
                    {
                      id: "scope",
                      header: "Scope",
                      question: "What should this change cover?",
                      options: [
                        {
                          label: "Tight",
                          description: "Touch only the footer layout logic.",
                        },
                        {
                          label: "Broad",
                          description: "Also adjust the related composer controls.",
                        },
                      ],
                    },
                    {
                      id: "risk",
                      header: "Risk",
                      question: "How aggressive should the imaginary plan be?",
                      options: [
                        {
                          label: "Conservative",
                          description: "Favor reliability and low-risk changes.",
                        },
                        {
                          label: "Balanced",
                          description: "Mix quick wins with one structural improvement.",
                        },
                      ],
                    },
                  ],
                },
                turnId: null,
                sequence: 1,
                createdAt: isoAt(1_000),
              },
            ],
            updatedAt: isoAt(1_000),
          })
        : thread,
    ),
  };
}

function createSnapshotWithPlanFollowUpPrompt(options?: {
  modelSelection?: { instanceId: ProviderInstanceId; model: string };
  planMarkdown?: string;
}): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: "msg-user-plan-follow-up-target" as MessageId,
    targetText: "plan follow-up thread",
  });
  const modelSelection = options?.modelSelection ?? {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
  };
  const planMarkdown =
    options?.planMarkdown ?? "# Follow-up plan\n\n- Keep the composer footer stable on resize.";

  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === PROJECT_ID ? { ...project, defaultModelSelection: modelSelection } : project,
    ),
    threads: snapshot.threads.map((thread) =>
      thread.id === THREAD_ID
        ? Object.assign({}, thread, {
            modelSelection,
            interactionMode: "plan",
            latestTurn: {
              turnId: "turn-plan-follow-up" as TurnId,
              state: "completed",
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: isoAt(1_010),
              assistantMessageId: null,
            },
            proposedPlans: [
              {
                id: "plan-follow-up-browser-test",
                turnId: "turn-plan-follow-up" as TurnId,
                planMarkdown,
                implementedAt: null,
                implementationThreadId: null,
                createdAt: isoAt(1_002),
                updatedAt: isoAt(1_003),
              },
            ],
            session: {
              ...thread.session,
              status: "ready",
              updatedAt: isoAt(1_010),
            },
            updatedAt: isoAt(1_010),
          })
        : thread,
    ),
  };
}

function resolveWsRpc(body: NormalizedWsRpcRequestBody): unknown {
  const customResult = customWsRpcResolver?.(body);
  if (customResult !== undefined) {
    return customResult;
  }
  const tag = body._tag;
  if (tag === WS_METHODS.serverGetConfig) {
    return encodeServerConfig(fixture.serverConfig);
  }
  if (tag === WS_METHODS.dictationGetStatus) {
    return { configured: false, canManage: true };
  }
  if (tag === WS_METHODS.serverDiscoverSourceControl) {
    return {
      versionControlSystems: [],
      sourceControlProviders: [
        {
          kind: "github",
          label: "GitHub",
          executable: "gh",
          status: "available",
          version: Option.some("gh version 2.0.0"),
          installHint: "Install GitHub CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("t3-oss"),
            host: Option.some("github.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "gitlab",
          label: "GitLab",
          executable: "glab",
          status: "available",
          version: Option.some("glab version 1.0.0"),
          installHint: "Install GitLab CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("t3-oss"),
            host: Option.some("gitlab.com"),
            detail: Option.none(),
          },
        },
        {
          kind: "bitbucket",
          label: "Bitbucket",
          executable: "Bitbucket REST API",
          status: "available",
          version: Option.none(),
          installHint: "Set Bitbucket API token environment variables.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("t3-oss"),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          },
        },
        {
          kind: "azure-devops",
          label: "Azure DevOps",
          executable: "az",
          status: "available",
          version: Option.some("azure-cli 2.0.0"),
          installHint: "Install Azure CLI.",
          detail: Option.none(),
          auth: {
            status: "authenticated",
            account: Option.some("t3-oss"),
            host: Option.some("dev.azure.com"),
            detail: Option.none(),
          },
        },
      ],
    };
  }
  if (tag === WS_METHODS.vcsListRefs) {
    return {
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 1,
      refs: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  if (tag === WS_METHODS.shellOpenInEditor) {
    return null;
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    void rpcHarness.connect(client);
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      void rpcHarness.onMessage(rawData);
    });
  }),
  ...createAuthenticatedSessionHandlers(() => fixture.serverConfig.auth),
  http.get("*/attachments/:attachmentId", () =>
    HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    }),
  ),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function setViewport(viewport: ViewportSpec): Promise<void> {
  await page.viewport(viewport.width, viewport.height);
  await waitForLayout();
}

async function waitForProductionStyles(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(
        getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
      ).not.toBe("");
      expect(getComputedStyle(document.body).marginTop).toBe("0px");
    },
    {
      timeout: 4_000,
      interval: 16,
    },
  );
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  let element: T | null = null;
  await vi.waitFor(
    () => {
      element = query();
      expect(element, errorMessage).toBeTruthy();
    },
    {
      timeout: 8_000,
      interval: 16,
    },
  );
  if (!element) {
    throw new Error(errorMessage);
  }
  return element;
}

async function waitForURL(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  let pathname = "";
  await vi.waitFor(
    () => {
      pathname = router.state.location.pathname;
      expect(predicate(pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return pathname;
}

async function waitForComposerEditor(): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>('[contenteditable="true"]'),
    "Unable to find composer editor.",
  );
}

async function pressComposerKey(key: string): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const keydownEvent = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  composerEditor.dispatchEvent(keydownEvent);
  if (keydownEvent.defaultPrevented) {
    await waitForLayout();
    return;
  }

  const beforeInputEvent = new InputEvent("beforeinput", {
    data: key,
    inputType: "insertText",
    bubbles: true,
    cancelable: true,
  });
  composerEditor.dispatchEvent(beforeInputEvent);
  if (beforeInputEvent.defaultPrevented) {
    await waitForLayout();
    return;
  }

  if (
    typeof document.execCommand === "function" &&
    document.execCommand("insertText", false, key)
  ) {
    await waitForLayout();
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    throw new Error("Unable to resolve composer selection for text input.");
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(key);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  composerEditor.dispatchEvent(
    new InputEvent("input", {
      data: key,
      inputType: "insertText",
      bubbles: true,
    }),
  );
  await waitForLayout();
}

async function pressComposerUndo(): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  const useMetaForMod = isMacPlatform(navigator.platform);
  composerEditor.focus();
  composerEditor.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "z",
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
  await waitForLayout();
}

async function waitForComposerText(expectedText: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
        expectedText,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function setComposerSelectionByTextOffsets(options: {
  start: number;
  end: number;
  direction?: "forward" | "backward";
}): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const resolvePoint = (targetOffset: number) => {
    const traversedRef = { value: 0 };

    const visitNode = (node: Node): { node: Node; offset: number } | null => {
      if (node.nodeType === Node.TEXT_NODE) {
        const textLength = node.textContent?.length ?? 0;
        if (targetOffset <= traversedRef.value + textLength) {
          return {
            node,
            offset: Math.max(0, Math.min(targetOffset - traversedRef.value, textLength)),
          };
        }
        traversedRef.value += textLength;
        return null;
      }

      if (node instanceof HTMLBRElement) {
        const parent = node.parentNode;
        if (!parent) {
          return null;
        }
        const siblingIndex = Array.prototype.indexOf.call(parent.childNodes, node);
        if (targetOffset <= traversedRef.value) {
          return { node: parent, offset: siblingIndex };
        }
        if (targetOffset <= traversedRef.value + 1) {
          return { node: parent, offset: siblingIndex + 1 };
        }
        traversedRef.value += 1;
        return null;
      }

      if (node instanceof Element || node instanceof DocumentFragment) {
        for (const child of node.childNodes) {
          const point = visitNode(child);
          if (point) {
            return point;
          }
        }
      }

      return null;
    };

    return (
      visitNode(composerEditor) ?? {
        node: composerEditor,
        offset: composerEditor.childNodes.length,
      }
    );
  };

  const startPoint = resolvePoint(options.start);
  const endPoint = resolvePoint(options.end);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Unable to resolve window selection.");
  }
  selection.removeAllRanges();

  if (options.direction === "backward" && "setBaseAndExtent" in selection) {
    selection.setBaseAndExtent(endPoint.node, endPoint.offset, startPoint.node, startPoint.offset);
    await waitForLayout();
    return;
  }

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  selection.addRange(range);
  await waitForLayout();
}

async function selectAllComposerContent(): Promise<void> {
  const composerEditor = await waitForComposerEditor();
  composerEditor.focus();
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Unable to resolve window selection.");
  }
  selection.removeAllRanges();
  const range = document.createRange();
  range.selectNodeContents(composerEditor);
  selection.addRange(range);
  await waitForLayout();
}

async function waitForComposerMenuItem(itemId: string): Promise<HTMLElement> {
  return waitForElement(
    () => document.querySelector<HTMLElement>(`[data-composer-item-id="${itemId}"]`),
    `Unable to find composer menu item "${itemId}".`,
  );
}

const ON_SCREEN_KEYBOARD_MEDIA_QUERY = "(hover: none) and (pointer: coarse)";

/**
 * Force the touch/on-screen-keyboard media query to match so the composer
 * renders its mobile layout under headless Chromium (which reports a fine
 * pointer). Delegates every other query to the real matchMedia. Returns a
 * restore function.
 */
function forceOnScreenKeyboardMediaQuery(): () => void {
  const original = window.matchMedia.bind(window);
  window.matchMedia = ((query: string) => {
    if (query === ON_SCREEN_KEYBOARD_MEDIA_QUERY) {
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    }
    return original(query);
  }) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

async function waitForSendButton(): Promise<HTMLButtonElement> {
  return waitForElement(
    () => document.querySelector<HTMLButtonElement>('button[aria-label="Send message"]'),
    "Unable to find send button.",
  );
}

function findComposerTaskProgressTrigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-composer-task-progress-trigger="true"]');
}

function findComposerTaskProgressPopup(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-composer-task-progress-popup="true"]');
}

function findComposerTaskProgressList(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-composer-task-progress-list="true"]');
}

function findComposerTaskProgressScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-task-list-scroll="true"]');
}

function findComposerProviderModelPicker(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('[data-chat-provider-model-picker="true"]');
}

function findButtonByText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  ) ?? null) as HTMLButtonElement | null;
}

async function waitForButtonByText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(() => findButtonByText(text), `Unable to find "${text}" button.`);
}

function findButtonContainingText(text: string): HTMLButtonElement | null {
  return (Array.from(document.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) ?? null) as HTMLButtonElement | null;
}

async function waitForButtonContainingText(text: string): Promise<HTMLButtonElement> {
  return waitForElement(
    () => findButtonContainingText(text),
    `Unable to find button containing "${text}".`,
  );
}

async function waitForMenuRadioItemContainingText(text: string): Promise<HTMLElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]')).find(
        (item) => item.textContent?.includes(text),
      ) ?? null,
    `Unable to find menu radio item containing "${text}".`,
  );
}

async function expectComposerActionsContained(): Promise<void> {
  const footer = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
    "Unable to find composer footer.",
  );
  const actions = await waitForElement(
    () => document.querySelector<HTMLElement>('[data-chat-composer-actions="right"]'),
    "Unable to find composer actions container.",
  );

  await vi.waitFor(
    () => {
      const footerRect = footer.getBoundingClientRect();
      const actionButtons = Array.from(actions.querySelectorAll<HTMLButtonElement>("button"));
      expect(actionButtons.length).toBeGreaterThanOrEqual(1);

      const buttonRects = actionButtons.map((button) => button.getBoundingClientRect());
      const firstTop = buttonRects[0]?.top ?? 0;

      for (const rect of buttonRects) {
        expect(rect.right).toBeLessThanOrEqual(footerRect.right + 0.5);
        expect(rect.bottom).toBeLessThanOrEqual(footerRect.bottom + 0.5);
        expect(Math.abs(rect.top - firstTop)).toBeLessThanOrEqual(1.5);
      }
    },
    { timeout: 8_000, interval: 16 },
  );
}

async function waitForInteractionModeButton(
  expectedLabel: "Build" | "Plan",
): Promise<HTMLButtonElement> {
  return waitForElement(
    () =>
      Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === expectedLabel,
      ) as HTMLButtonElement | null,
    `Unable to find ${expectedLabel} interaction mode button.`,
  );
}

async function waitForServerConfigToApply(): Promise<void> {
  await vi.waitFor(
    () => {
      expect(wsRequests.some((request) => request._tag === WS_METHODS.subscribeServerConfig)).toBe(
        true,
      );
    },
    { timeout: 8_000, interval: 16 },
  );
  await waitForLayout();
}

function dispatchChatNewShortcut(): void {
  const useMetaForMod = isMacPlatform(navigator.platform);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "o",
      shiftKey: true,
      metaKey: useMetaForMod,
      ctrlKey: !useMetaForMod,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function releaseModShortcut(key?: string): void {
  window.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: key ?? (isMacPlatform(navigator.platform) ? "Meta" : "Control"),
      metaKey: false,
      ctrlKey: false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

async function triggerChatNewShortcutUntilPath(
  router: ReturnType<typeof getRouter>,
  predicate: (pathname: string) => boolean,
  errorMessage: string,
): Promise<string> {
  dispatchChatNewShortcut();
  await vi.waitFor(
    () => {
      expect(predicate(router.state.location.pathname), errorMessage).toBe(true);
    },
    { timeout: 8_000, interval: 16 },
  );
  return router.state.location.pathname;
}

async function openCommandPaletteFromTrigger(): Promise<void> {
  const trigger = page.getByTestId("command-palette-trigger");
  await expect.element(trigger).toBeInTheDocument();
  await trigger.click();
  await waitForElement(
    () => document.querySelector('[data-testid="command-palette"]'),
    "Command palette should have opened from the sidebar trigger.",
  );
}

async function waitForNewThreadShortcutLabel(): Promise<void> {
  const newThreadButton = page.getByTestId("new-thread-button");
  await expect.element(newThreadButton).toBeInTheDocument();
  await newThreadButton.hover();
  const shortcutLabel = isMacPlatform(navigator.platform)
    ? "New thread (⇧⌘O)"
    : "New thread (Ctrl+Shift+O)";
  await expect.element(page.getByText(shortcutLabel)).toBeInTheDocument();
}

async function waitForCommandPaletteShortcutLabel(): Promise<void> {
  await waitForElement(
    () => document.querySelector('[data-testid="command-palette-trigger"] kbd'),
    "Command palette shortcut label did not render.",
  );
}

async function waitForCommandPaletteInput(placeholder: string): Promise<HTMLInputElement> {
  return waitForElement(
    () => document.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement | null,
    `Command palette input with placeholder "${placeholder}" did not render.`,
  );
}

function getCommandPaletteLegendEntries(): string[] {
  const footer = document.querySelector('[data-slot="command-footer"]');
  if (!footer) {
    return [];
  }

  return Array.from(footer.querySelectorAll('[data-slot="kbd-group"]'))
    .map((group) =>
      Array.from(group.children)
        .map((child) => child.textContent?.trim() ?? "")
        .filter((value) => value.length > 0)
        .join(" "),
    )
    .filter((value) => value.length > 0);
}

async function dispatchInputKey(
  input: HTMLInputElement,
  init: Pick<KeyboardEventInit, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): Promise<void> {
  input.focus();
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  await waitForLayout();
}

function createDesktopBridgeForChatViewTests(
  sourceUpdateState: DesktopSourceUpdateState,
): DesktopBridge {
  return {
    getAppBranding: () => null,
    getLocalEnvironmentBootstrap: () => null,
    getDebugEndpointState: async () => ({ enabled: false, url: null }),
    publishDebugSnapshot: async () => undefined,
    getClientSettings: async () => null,
    setClientSettings: async () => undefined,
    setPowerSaveBlockerState: async () => undefined,
    getSavedEnvironmentRegistry: async () => [],
    setSavedEnvironmentRegistry: async () => undefined,
    getSavedEnvironmentSecret: async () => null,
    setSavedEnvironmentSecret: async () => true,
    removeSavedEnvironmentSecret: async () => undefined,
    getServerExposureState: async () => ({
      mode: "local-only",
      httpsEnabled: true,
      endpointUrl: null,
      advertisedHost: null,
    }),
    setServerExposureMode: async () => ({
      mode: "local-only",
      httpsEnabled: true,
      endpointUrl: null,
      advertisedHost: null,
    }),
    setServerHttpsEnabled: async (httpsEnabled) => ({
      mode: "local-only",
      httpsEnabled,
      endpointUrl: null,
      advertisedHost: null,
    }),
    getAdvertisedEndpoints: async () => [],
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    openPath: async () => true,
    revealPath: async () => true,
    copyText: async () => undefined,
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in ChatView browser test");
    },
    setUpdateChannel: async () => {
      throw new Error("setUpdateChannel not implemented in ChatView browser test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in ChatView browser test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in ChatView browser test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in ChatView browser test");
    },
    onUpdateState: () => () => undefined,
    getSourceUpdateState: vi.fn().mockResolvedValue(sourceUpdateState),
    checkSourceUpdate: vi.fn().mockResolvedValue(sourceUpdateState),
    onSourceUpdateState: vi.fn(() => () => undefined),
  };
}

async function mountChatView(options: {
  viewport: ViewportSpec;
  snapshot: OrchestrationReadModel;
  configureFixture?: (fixture: TestFixture) => void;
  resolveRpc?: (body: NormalizedWsRpcRequestBody) => unknown | undefined;
  initialPath?: string;
}): Promise<MountedChatView> {
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  customWsRpcResolver = options.resolveRpc ?? null;
  await setViewport(options.viewport);
  await waitForProductionStyles();

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "100vw";
  host.style.height = "100vh";
  host.style.display = "grid";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [options.initialPath ?? `/${LOCAL_ENVIRONMENT_ID}/${THREAD_ID}`],
    }),
  );

  const screen = await render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
    {
      container: host,
    },
  );

  await waitForWsClient();
  await waitForAppBootstrap();
  await waitForLayout();

  const cleanup = async () => {
    customWsRpcResolver = null;
    await screen.unmount();
    host.remove();
    await waitForLayout();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    setViewport: async (viewport: ViewportSpec) => {
      await setViewport(viewport);
      await waitForProductionStyles();
    },
    setContainerSize: async (viewport) => {
      host.style.width = `${viewport.width}px`;
      host.style.height = `${viewport.height}px`;
      await waitForLayout();
    },
    router,
  };
}

type ChatViewBrowserPart = "composer" | "navigation" | "layout";

const chatViewBrowserPart = (
  globalThis as typeof globalThis & {
    __CAFE_CHAT_VIEW_BROWSER_PART__?: ChatViewBrowserPart;
  }
).__CAFE_CHAT_VIEW_BROWSER_PART__;

if (!chatViewBrowserPart) {
  throw new Error("ChatView browser tests must be loaded through a part entrypoint.");
}

describe(`ChatView full app (${chatViewBrowserPart})`, () => {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await rpcHarness.disconnect();
    await worker.stop();
  });

  beforeEach(async () => {
    await rpcHarness.reset({
      resolveUnary: resolveWsRpc,
      getInitialStreamValues: (request) => {
        if (request._tag === WS_METHODS.subscribeServerLifecycle) {
          return [
            {
              version: 1,
              sequence: 1,
              type: "welcome",
              payload: fixture.welcome,
            },
          ];
        }
        if (request._tag === WS_METHODS.subscribeServerConfig) {
          return [
            {
              version: 1,
              type: "snapshot",
              config: encodeServerConfig(fixture.serverConfig),
            },
          ];
        }
        if (request._tag === ORCHESTRATION_WS_METHODS.subscribeShell) {
          return [
            {
              kind: "snapshot",
              snapshot: toShellSnapshot(fixture.snapshot),
            },
          ];
        }
        if (request._tag === ORCHESTRATION_WS_METHODS.subscribeThread) {
          const thread = fixture.snapshot.threads.find((entry) => entry.id === request.threadId);
          return thread
            ? [
                {
                  kind: "snapshot",
                  snapshot: {
                    snapshotSequence: fixture.snapshot.snapshotSequence,
                    thread,
                  },
                },
              ]
            : [];
        }
        return [];
      },
    });
    await __resetLocalApiForTests();
    resetSourceControlDiscoveryStateForTests();
    await setViewport(DEFAULT_VIEWPORT);
    localStorage.clear();
    document.body.innerHTML = "";
    wsRequests.length = 0;
    customWsRpcResolver = null;
    __resetEnvironmentApiOverridesForTests();
    Reflect.deleteProperty(window, "desktopBridge");
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    useCommandPaletteStore.setState({
      open: false,
      openIntent: null,
    });
    useStore.setState({
      activeEnvironmentId: null,
      environmentStateById: {},
    });
    useUiStateStore.setState({
      projectExpandedById: {},
      projectOrder: [],
      threadPlanSidebarOpenById: {},
      threadLastVisitedAtById: {},
    });
    useTaskAtriumStore.getState().setOpen(false);
  });

  afterEach(() => {
    customWsRpcResolver = null;
    document.body.innerHTML = "";
  });

  if (chatViewBrowserPart === "composer") {
    it("places configured dictation immediately before the send action", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-dictation-action" as MessageId,
          targetText: "dictation action target",
        }),
        resolveRpc: (body) =>
          body._tag === WS_METHODS.dictationGetStatus
            ? { configured: true, canManage: true }
            : undefined,
      });

      try {
        const dictationButton = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Start dictation"]'),
          "Unable to find configured dictation button.",
        );
        const sendButton = await waitForSendButton();
        const actionButtons = Array.from(
          dictationButton
            .closest<HTMLElement>('[data-chat-composer-actions="right"]')
            ?.querySelectorAll<HTMLButtonElement>("button") ?? [],
        );
        expect(actionButtons.indexOf(dictationButton)).toBe(actionButtons.indexOf(sendButton) - 1);
      } finally {
        await mounted.cleanup();
      }
    });

    it.each([80, 130] as const)(
      "scales desktop composer typography and editor bounds at %i percent",
      async (interfaceScalePercent) => {
        const mounted = await mountChatView({
          viewport: DEFAULT_VIEWPORT,
          snapshot: createSnapshotForTargetUser({
            targetMessageId: `msg-user-scaled-composer-${interfaceScalePercent}` as MessageId,
            targetText: "scaled composer target",
          }),
          configureFixture: (nextFixture) => {
            nextFixture.serverConfig = {
              ...nextFixture.serverConfig,
              clientSettings: {
                ...nextFixture.serverConfig.clientSettings,
                interfaceScalePercent,
              },
            };
          },
        });

        try {
          await waitForServerConfigToApply();
          const editor = await waitForComposerEditor();

          await vi.waitFor(() => {
            const rootFontSize = Number.parseFloat(
              window.getComputedStyle(document.documentElement).fontSize,
            );
            const editorStyle = window.getComputedStyle(editor);
            const editorFontSize = Number.parseFloat(editorStyle.fontSize);
            const editorMinHeight = Number.parseFloat(editorStyle.minHeight);
            const editorMaxHeight = Number.parseFloat(editorStyle.maxHeight);

            expect(rootFontSize).toBeGreaterThan(0);
            expect(editorFontSize / rootFontSize).toBeCloseTo(0.875, 3);
            expect(editorMinHeight / rootFontSize).toBeCloseTo(4.375, 3);
            expect(editorMaxHeight / rootFontSize).toBeCloseTo(12.5, 3);
          });
        } finally {
          await mounted.cleanup();
        }
      },
    );

    it("shows the current runtime step and exposes every full task on hover without a side panel", async () => {
      // Even an old explicit "open" preference must not turn a runtime checklist
      // into authored plan content. This catches the former Tasks-sidebar path,
      // not just the default-closed presentation.
      useUiStateStore.setState({
        threadPlanSidebarOpenById: {
          [THREAD_KEY]: true,
        },
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithRuntimeTaskProgress({ withAuthoredPlan: true }),
      });

      try {
        const trigger = page.getByRole("button", {
          name: /^Task progress: step 5 of 12\b/i,
        });
        await expect.element(trigger).toHaveTextContent("Step 5 / 12");
        expect(findComposerTaskProgressTrigger()).not.toBeNull();

        expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
        expect(
          document.querySelector(
            'button[title="Show plan sidebar"], button[title="Hide plan sidebar"]',
          ),
        ).toBeNull();
        expect(document.querySelector('[data-slot="sheet-popup"]:not([hidden])')).toBeNull();

        await trigger.hover();
        await vi.waitFor(
          () => {
            expect(findComposerTaskProgressPopup()).not.toBeNull();
            expect(findComposerTaskProgressList()).not.toBeNull();
            expect(findComposerTaskProgressScroller()).not.toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );

        const popup = findComposerTaskProgressPopup();
        const list = findComposerTaskProgressList();
        const scroller = findComposerTaskProgressScroller();
        expect(popup).not.toBeNull();
        expect(list).not.toBeNull();
        expect(scroller).not.toBeNull();
        if (!popup || !list || !scroller) {
          throw new Error("Task progress popup did not finish mounting.");
        }

        const rows = Array.from(
          list.querySelectorAll<HTMLElement>("[data-composer-task-progress-step]"),
        );
        expect(rows).toHaveLength(RUNTIME_TASK_DESCRIPTIONS.length);
        for (const description of RUNTIME_TASK_DESCRIPTIONS) {
          expect(popup.textContent).toContain(description);
        }
        expect(popup.textContent).not.toContain("and more");

        expect(getComputedStyle(scroller).overflowY).toBe("auto");
        expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
        scroller.scrollTop = scroller.scrollHeight;
        await waitForLayout();
        const lastRow = rows.at(-1);
        expect(lastRow).toBeTruthy();
        expect(lastRow!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          scroller.getBoundingClientRect().bottom + 1,
        );

        // Opening the task popover must not opportunistically open the removed
        // runtime Tasks panel or make its authored-plan close control appear.
        expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
        expect(document.querySelector('[data-slot="sheet-popup"]:not([hidden])')).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    });

    it("opens task progress with an ordinary press and restores trigger focus on Escape", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithRuntimeTaskProgress(),
      });

      try {
        const trigger = page.getByRole("button", {
          name: /^Task progress: step 5 of 12\b/i,
        });
        const triggerElement = await waitForElement(
          findComposerTaskProgressTrigger,
          "Unable to find task progress trigger.",
        );
        triggerElement.focus();

        // Base UI maps the same press interaction to mouse click, touch tap, and
        // keyboard activation. Exercising the semantic button keeps this an
        // integration test of that shared path rather than a hover-only check.
        await trigger.click();
        await vi.waitFor(() => {
          expect(findComposerTaskProgressPopup()).not.toBeNull();
          expect(triggerElement.getAttribute("aria-expanded")).toBe("true");
        });

        const scroller = findComposerTaskProgressScroller();
        expect(scroller).not.toBeNull();
        scroller?.focus();
        expect(document.activeElement).toBe(scroller);

        await userEvent.keyboard("{Escape}");
        await vi.waitFor(() => {
          expect(findComposerTaskProgressPopup()).toBeNull();
          expect(triggerElement.getAttribute("aria-expanded")).toBe("false");
          expect(document.activeElement).toBe(triggerElement);
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps the pressed task popover contained at 430px and omits the compact plan-sidebar action", async () => {
      useUiStateStore.setState({
        threadPlanSidebarOpenById: {
          [THREAD_KEY]: true,
        },
      });
      const mounted = await mountChatView({
        viewport: COMPACT_FOOTER_VIEWPORT,
        snapshot: createSnapshotWithRuntimeTaskProgress(),
      });

      try {
        const trigger = page.getByRole("button", {
          name: /^Task progress: step 5 of 12\b/i,
        });
        await trigger.click();
        await vi.waitFor(() => expect(findComposerTaskProgressPopup()).not.toBeNull());

        const popup = findComposerTaskProgressPopup();
        const scroller = findComposerTaskProgressScroller();
        const outerViewport = popup?.querySelector<HTMLElement>('[data-slot="popover-viewport"]');
        expect(popup).not.toBeNull();
        expect(scroller).not.toBeNull();
        expect(outerViewport).not.toBeNull();
        if (!popup || !scroller) {
          throw new Error("Compact task progress popup did not finish mounting.");
        }

        const popupBounds = popup.getBoundingClientRect();
        expect(popupBounds.left).toBeGreaterThanOrEqual(-1);
        expect(popupBounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
          document.documentElement.clientWidth,
        );
        expect(document.body.scrollWidth).toBeLessThanOrEqual(document.body.clientWidth);
        expect(getComputedStyle(outerViewport!).overflowY).toBe("hidden");
        expect(getComputedStyle(scroller).overflowY).toBe("auto");
        expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
        expect(scroller.getBoundingClientRect().bottom).toBeLessThanOrEqual(
          outerViewport!.getBoundingClientRect().bottom + 1,
        );
        expect(outerViewport!.scrollTop).toBe(0);

        await userEvent.keyboard("{Escape}");
        await vi.waitFor(() => expect(findComposerTaskProgressPopup()).toBeNull());

        const moreControls = page.getByRole("button", { name: "More composer controls" });
        await moreControls.click();
        await vi.waitFor(() => {
          expect(document.querySelector('[data-slot="menu-popup"]')).not.toBeNull();
        });
        const compactSidebarAction = Array.from(
          document.querySelectorAll<HTMLElement>('[data-slot="menu-item"]'),
        ).find((item) => /^(?:Show|Hide) plan sidebar$/i.test(item.textContent?.trim() ?? ""));
        expect(compactSidebarAction).toBeUndefined();
        expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
        expect(document.querySelector('[data-slot="sheet-popup"]:not([hidden])')).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    });

    it.each([
      ["the latest provider checklist is explicitly empty", { steps: [] }],
      ["the latest turn is terminal", { terminal: true }],
    ] as const)("hides task progress when %s", async (_reason, options) => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithRuntimeTaskProgress(options),
      });

      try {
        await waitForLayout();
        expect(findComposerTaskProgressTrigger()).toBeNull();
        expect(findComposerTaskProgressPopup()).toBeNull();
        expect(document.querySelector('button[aria-label^="Task progress: step"]')).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    });

    it("temporarily hides an authored plan during implementation without persisting a closed preference", async () => {
      useUiStateStore.setState({
        threadPlanSidebarOpenById: {},
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithPlanFollowUpPrompt(),
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return { sequence: fixture.snapshot.snapshotSequence + 1 };
          }
          return undefined;
        },
      });

      const publishThreadSnapshot = (nextSnapshot: OrchestrationReadModel): void => {
        const nextThread = nextSnapshot.threads.find((thread) => thread.id === THREAD_ID);
        if (!nextThread) {
          throw new Error("Sequential plan regression fixture is missing its active thread.");
        }
        const snapshotSequence = fixture.snapshot.snapshotSequence + 1;
        fixture.snapshot = {
          ...nextSnapshot,
          snapshotSequence,
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence,
            thread: nextThread,
          },
        });
      };

      try {
        // The completed authored plan still follows the normal auto-open path.
        await vi.waitFor(
          () => {
            expect(
              document.querySelector('button[aria-label="Close plan sidebar"]'),
            ).not.toBeNull();
            expect(document.body.textContent).toContain("Follow-up plan");
            expect(useUiStateStore.getState().threadPlanSidebarOpenById[THREAD_KEY]).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );

        const implementButton = await waitForButtonByText("Implement");
        implementButton.click();
        await vi.waitFor(
          () => {
            const implementationDispatch = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.turn.start" &&
                request.interactionMode === "default",
            );
            expect(implementationDispatch).toMatchObject({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              type: "thread.turn.start",
              sourceProposedPlan: {
                threadId: THREAD_ID,
                planId: "plan-follow-up-browser-test",
              },
            });
            // Local dispatch hides the panel immediately, but that suppression
            // is not a user preference and must never overwrite the stored true.
            expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
            expect(useUiStateStore.getState().threadPlanSidebarOpenById[THREAD_KEY]).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );

        publishThreadSnapshot(createSnapshotWithRuntimeTaskProgress({ withAuthoredPlan: true }));
        await vi.waitFor(
          () => {
            expect(findComposerTaskProgressTrigger()).not.toBeNull();
            expect(document.querySelector('button[aria-label="Close plan sidebar"]')).toBeNull();
            expect(
              document.querySelector(
                'button[title="Show plan sidebar"], button[title="Hide plan sidebar"]',
              ),
            ).toBeNull();
            expect(useUiStateStore.getState().threadPlanSidebarOpenById[THREAD_KEY]).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );

        // Once there is no active runtime turn, the next authored plan is
        // visible again under the unchanged open preference.
        publishThreadSnapshot(
          createSnapshotWithPlanFollowUpPrompt({
            planMarkdown: "# Future authored plan\n\n- Preserve plan auto-open behavior.",
          }),
        );
        await vi.waitFor(
          () => {
            expect(
              document.querySelector('button[aria-label="Close plan sidebar"]'),
            ).not.toBeNull();
            expect(document.body.textContent).toContain("Future authored plan");
            expect(findComposerTaskProgressTrigger()).toBeNull();
            expect(useUiStateStore.getState().threadPlanSidebarOpenById[THREAD_KEY]).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("renders locked single-environment mobile run context as a static workspace label", async () => {
      const mounted = await mountChatView({
        viewport: COMPACT_FOOTER_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-mobile-locked-workspace" as MessageId,
          targetText: "locked mobile workspace",
        }),
      });

      try {
        await waitForElement(
          () =>
            Array.from(document.querySelectorAll<HTMLElement>("span")).find(
              (element) => element.textContent?.trim() === "Local checkout",
            ) ?? null,
          "Unable to find static mobile workspace label.",
        );

        expect(findButtonByText("Local checkout")).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps dismiss-only composer banners aligned on mobile", async () => {
      const mounted = await mountChatView({
        viewport: COMPACT_FOOTER_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-mobile-version-banner" as MessageId,
          targetText: "mobile version banner",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            environment: {
              ...nextFixture.serverConfig.environment,
              serverVersion: "9.9.9",
            },
          };
        },
      });

      try {
        const banner = await waitForElement(
          () =>
            Array.from(document.querySelectorAll<HTMLElement>('[data-slot="alert"]')).find(
              (element) => element.textContent?.includes("Client and server versions differ"),
            ) ?? null,
          "Unable to find version mismatch banner.",
        );
        const title = banner.querySelector<HTMLElement>('[data-slot="alert-title"]');
        const description = banner.querySelector<HTMLElement>('[data-slot="alert-description"]');
        const dismissButton = banner.querySelector<HTMLButtonElement>(
          'button[aria-label="Dismiss version mismatch warning"]',
        );

        expect(title).toBeTruthy();
        expect(description).toBeTruthy();
        expect(dismissButton).toBeTruthy();
        expect(dismissButton!.getBoundingClientRect().top).toBeLessThan(
          description!.getBoundingClientRect().top,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("re-expands the bootstrap project using its logical key", async () => {
      useUiStateStore.setState({
        projectExpandedById: {
          [PROJECT_LOGICAL_KEY]: false,
        },
        projectOrder: [PROJECT_LOGICAL_KEY],
        threadLastVisitedAtById: {},
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-bootstrap-project-expand" as MessageId,
          targetText: "bootstrap project expand",
        }),
      });

      try {
        await vi.waitFor(
          () => {
            expect(useUiStateStore.getState().projectExpandedById[PROJECT_LOGICAL_KEY]).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows an explicit empty state for projects without threads in the sidebar", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
      });

      try {
        await expect.element(page.getByText("No threads yet")).toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });

    it("does not render local editor open controls for draft threads", async () => {
      setDraftThreadWithoutWorktree();

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            availableEditors: ["vscode"],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        const hasOpenButton = Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "Open",
        );
        const hasOpenPickerButton =
          document.querySelector('button[aria-label="Copy options"]') !== null;

        expect(hasOpenButton).toBe(false);
        expect(hasOpenPickerButton).toBe(false);
        expect(wsRequests.some((request) => request._tag === WS_METHODS.shellOpenInEditor)).toBe(
          false,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows a passive source update badge before the Open button when the tracked branch is behind", async () => {
      setDraftThreadWithoutWorktree();
      const sourceUpdateState: DesktopSourceUpdateState = {
        status: "behind",
        branch: "dev",
        trackedBranch: "dev",
        runtimeHash: "1111111111111111111111111111111111111111",
        localHash: "1111111111111111111111111111111111111111",
        remoteHash: "2222222222222222222222222222222222222222",
        mergeBaseHash: "1111111111111111111111111111111111111111",
        dirty: false,
        checkedAt: "2026-06-02T00:00:00.000Z",
        message: null,
      };
      window.desktopBridge = createDesktopBridgeForChatViewTests(sourceUpdateState);

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            availableEditors: ["vscode"],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        const updateBadge = await waitForElement(
          () =>
            Array.from(document.querySelectorAll("[data-slot='badge']")).find(
              (element) => element.textContent?.trim() === "Newer dev",
            ) as HTMLElement | null,
          "Unable to find passive source update badge.",
        );
        expect(updateBadge.getAttribute("title")).toContain("Newer origin/dev commit available");
        await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              '[data-chat-view-header="true"] button[aria-label="Copy options"]',
            ),
          "Unable to find desktop open project picker.",
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows a passive rebuild badge when the checkout hash differs from the running build", async () => {
      setDraftThreadWithoutWorktree();
      const sourceUpdateState: DesktopSourceUpdateState = {
        status: "current",
        branch: "dev",
        trackedBranch: "dev",
        runtimeHash: "1111111111111111111111111111111111111111",
        localHash: "2222222222222222222222222222222222222222",
        remoteHash: "2222222222222222222222222222222222222222",
        mergeBaseHash: "2222222222222222222222222222222222222222",
        dirty: false,
        checkedAt: "2026-06-02T00:00:00.000Z",
        message: "This checkout is current with origin.",
      };
      window.desktopBridge = createDesktopBridgeForChatViewTests(sourceUpdateState);

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            availableEditors: ["vscode"],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        const updateBadge = await waitForElement(
          () =>
            Array.from(document.querySelectorAll("[data-slot='badge']")).find(
              (element) => element.textContent?.trim() === "Rebuild to apply (dev)",
            ) as HTMLElement | null,
          "Unable to find passive rebuild badge.",
        );
        expect(updateBadge.getAttribute("title")).toContain("Rebuild and restart to apply dev");
      } finally {
        await mounted.cleanup();
      }
    });

    it("lets the server own setup after preparing a pull request worktree thread", async () => {
      useComposerDraftStore.setState({
        draftThreadsByThreadKey: {
          [THREAD_KEY]: {
            threadId: THREAD_ID,
            environmentId: LOCAL_ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            logicalProjectKey: PROJECT_DRAFT_KEY,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            envMode: "local",
          },
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {
          [PROJECT_DRAFT_KEY]: THREAD_KEY,
        },
      });

      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: withProjectScripts(createDraftOnlySnapshot(), [
          {
            id: "setup",
            name: "Setup",
            command: "yarn install --immutable",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ]),
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.gitResolvePullRequest) {
            return {
              pullRequest: {
                number: 1359,
                title: "Add thread archiving and settings navigation",
                url: "https://github.com/cafeai/cafe-code/pull/1359",
                baseBranch: "main",
                headBranch: "archive-settings-overhaul",
                state: "open",
              },
            };
          }
          if (body._tag === WS_METHODS.gitPreparePullRequestThread) {
            return {
              pullRequest: {
                number: 1359,
                title: "Add thread archiving and settings navigation",
                url: "https://github.com/cafeai/cafe-code/pull/1359",
                baseBranch: "main",
                headBranch: "archive-settings-overhaul",
                state: "open",
              },
              branch: "archive-settings-overhaul",
              worktreePath: "/repo/worktrees/pr-1359",
            };
          }
          return undefined;
        },
      });

      try {
        const branchButton = await waitForElement(
          () =>
            Array.from(document.querySelectorAll("button")).find(
              (button) => button.textContent?.trim() === "main",
            ) as HTMLButtonElement | null,
          "Unable to find branch selector button.",
        );
        branchButton.click();

        const branchInput = await waitForElement(
          () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
          "Unable to find ref search input.",
        );
        branchInput.focus();
        await page.getByPlaceholder("Search refs...").fill("1359");

        const checkoutItem = await waitForElement(
          () =>
            Array.from(document.querySelectorAll("span")).find(
              (element) => element.textContent?.trim() === "Checkout pull request",
            ) as HTMLSpanElement | null,
          "Unable to find checkout pull request option.",
        );
        checkoutItem.click();

        const worktreeButton = await waitForElement(
          () =>
            Array.from(document.querySelectorAll("button")).find(
              (button) => button.textContent?.trim() === "Worktree",
            ) as HTMLButtonElement | null,
          "Unable to find Worktree button.",
        );
        worktreeButton.click();

        await vi.waitFor(
          () => {
            const prepareRequest = wsRequests.find(
              (request) => request._tag === WS_METHODS.gitPreparePullRequestThread,
            );
            expect(prepareRequest).toMatchObject({
              _tag: WS_METHODS.gitPreparePullRequestThread,
              cwd: "/repo/project",
              reference: "1359",
              mode: "worktree",
              threadId: THREAD_ID,
            });
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("sends bootstrap turn-starts and waits for server setup on first-send worktree drafts", async () => {
      useComposerDraftStore.setState({
        draftThreadsByThreadKey: {
          [THREAD_KEY]: {
            threadId: THREAD_ID,
            environmentId: LOCAL_ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            logicalProjectKey: PROJECT_DRAFT_KEY,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            envMode: "worktree",
          },
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {
          [PROJECT_DRAFT_KEY]: THREAD_KEY,
        },
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: withProjectScripts(createDraftOnlySnapshot(), [
          {
            id: "setup",
            name: "Setup",
            command: "yarn install --immutable",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ]),
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }
          return undefined;
        },
      });

      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
        await waitForLayout();

        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        sendButton.click();

        await vi.waitFor(
          () => {
            const dispatchRequest = wsRequests.find(
              (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
            ) as
              | {
                  _tag: string;
                  type?: string;
                  bootstrap?: {
                    createThread?: { projectId?: string };
                    prepareWorktree?: { projectCwd?: string; baseBranch?: string; branch?: string };
                    runSetupScript?: boolean;
                  };
                }
              | undefined;
            expect(dispatchRequest).toMatchObject({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              type: "thread.turn.start",
              bootstrap: {
                createThread: {
                  projectId: PROJECT_ID,
                },
                prepareWorktree: {
                  projectCwd: "/repo/project",
                  baseBranch: "main",
                  branch: expect.stringMatching(/^cafecode\/[0-9a-f]{8}$/),
                },
                runSetupScript: true,
              },
            });
          },
          { timeout: 8_000, interval: 16 },
        );

        expect(wsRequests.some((request) => request._tag === WS_METHODS.vcsCreateWorktree)).toBe(
          false,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps custom provider instance ids when bootstrapping a local draft thread", async () => {
      setDraftThreadWithoutWorktree();
      const openRouterInstanceId = ProviderInstanceId.make("claude_openrouter");
      const openRouterSelection = createModelSelection(openRouterInstanceId, "openai/gpt-5.5");
      useComposerDraftStore.getState().setModelSelection(THREAD_REF, openRouterSelection);

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            providers: [
              ...nextFixture.serverConfig.providers,
              {
                driver: ProviderDriverKind.make("claudeAgent"),
                instanceId: ProviderInstanceId.make("claudeAgent"),
                enabled: true,
                installed: true,
                version: "2.1.117",
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: NOW_ISO,
                models: [
                  {
                    slug: "claude-opus-4-7",
                    name: "Claude Opus 4.7",
                    isCustom: false,
                    capabilities: createModelCapabilities({ optionDescriptors: [] }),
                  },
                ],
                slashCommands: [],
                skills: [],
              },
              {
                driver: ProviderDriverKind.make("claudeAgent"),
                instanceId: openRouterInstanceId,
                displayName: "Claude OpenRouter",
                enabled: true,
                installed: true,
                version: "2.1.117",
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: NOW_ISO,
                models: [
                  {
                    slug: "claude-opus-4-7",
                    name: "Claude Opus 4.7",
                    isCustom: false,
                    capabilities: createModelCapabilities({ optionDescriptors: [] }),
                  },
                ],
                slashCommands: [],
                skills: [],
              },
            ],
            settings: {
              ...nextFixture.serverConfig.settings,
              providerInstances: {
                ...nextFixture.serverConfig.settings.providerInstances,
                [openRouterInstanceId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  displayName: "Claude OpenRouter",
                  config: { customModels: ["openai/gpt-5.5"] },
                },
              },
            },
          };
        },
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }
          return undefined;
        },
      });

      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Hello there");
        await waitForLayout();

        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        sendButton.click();

        await vi.waitFor(
          () => {
            const turnStartRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.turn.start",
            ) as
              | {
                  modelSelection?: { instanceId?: string; model?: string };
                  bootstrap?: {
                    createThread?: {
                      modelSelection?: { instanceId?: string; model?: string };
                    };
                  };
                }
              | undefined;

            expect(turnStartRequest?.modelSelection).toMatchObject({
              instanceId: openRouterInstanceId,
              model: "openai/gpt-5.5",
            });
            expect(turnStartRequest?.bootstrap?.createThread?.modelSelection).toMatchObject({
              instanceId: openRouterInstanceId,
              model: "openai/gpt-5.5",
            });
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("dispatches Sol Ultra from the exact custom Codex instance", async () => {
      setDraftThreadWithoutWorktree();
      const zkmInstanceId = ProviderInstanceId.make("codex_codex_astrea_zkm");
      const solModel = {
        slug: "gpt-5.6-sol",
        name: "GPT-5.6-Sol",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              currentValue: "low",
              options: [
                { id: "low", label: "Low", isDefault: true },
                { id: "ultra", label: "Ultra" },
              ],
            },
          ],
        }),
      };

      // Reproduce the historical failure shape: the default Codex bucket has
      // Low while the selected custom account explicitly has Ultra. Reading
      // traits through the driver-kind key would send Low for the ZKM turn.
      useComposerDraftStore
        .getState()
        .setModelSelection(
          THREAD_REF,
          createModelSelection(ProviderInstanceId.make("codex"), solModel.slug, [
            { id: "reasoningEffort", value: "low" },
          ]),
        );
      useComposerDraftStore
        .getState()
        .setModelSelection(
          THREAD_REF,
          createModelSelection(zkmInstanceId, solModel.slug, [
            { id: "reasoningEffort", value: "ultra" },
          ]),
        );

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            providers: [
              ...nextFixture.serverConfig.providers,
              {
                driver: ProviderDriverKind.make("codex"),
                instanceId: zkmInstanceId,
                displayName: "Codex Astrea ZKM",
                enabled: true,
                installed: true,
                version: "0.144.6",
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: NOW_ISO,
                models: [solModel],
                slashCommands: [],
                skills: [],
              },
            ],
            settings: {
              ...nextFixture.serverConfig.settings,
              providerInstances: {
                ...nextFixture.serverConfig.settings.providerInstances,
                [zkmInstanceId]: {
                  driver: ProviderDriverKind.make("codex"),
                  displayName: "Codex Astrea ZKM",
                },
              },
            },
          };
        },
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }
          return undefined;
        },
      });

      try {
        await mounted.setContainerSize(WIDE_FOOTER_VIEWPORT);
        await vi.waitFor(() => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const optionsButton = footer?.querySelector<HTMLButtonElement>(
            'button[aria-label="More composer controls"]',
          );
          const traitsLabel = optionsButton?.querySelector<HTMLElement>(
            '[data-compact-composer-controls-label="true"]',
          );
          expect(footer?.dataset.chatComposerFooterCompact).toBe("false");
          expect(traitsLabel?.textContent).toBe("Ultra");
          expect(optionsButton?.textContent).not.toContain("Full access");
        });

        await mounted.setContainerSize(COMPACT_FOOTER_VIEWPORT);
        await vi.waitFor(() => {
          const footer = document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]');
          const traitsLabel = document.querySelector<HTMLElement>(
            '[data-compact-composer-controls-label="true"]',
          );
          expect(footer?.dataset.chatComposerFooterCompact).toBe("true");
          expect(traitsLabel?.textContent).toBe("Ultra");
        });

        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep this turn on Ultra");
        await waitForLayout();

        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        sendButton.click();

        await vi.waitFor(
          () => {
            const turnStartRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.turn.start",
            ) as
              | {
                  modelSelection?: {
                    instanceId?: string;
                    model?: string;
                    options?: ReadonlyArray<{ id?: string; value?: string | boolean }>;
                  };
                }
              | undefined;

            expect(turnStartRequest?.modelSelection).toMatchObject({
              instanceId: zkmInstanceId,
              model: "gpt-5.6-sol",
              options: expect.arrayContaining([{ id: "reasoningEffort", value: "ultra" }]),
            });
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps new-worktree mode on empty server threads and bootstraps the first send", async () => {
      const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? Object.assign({}, thread, { session: null }) : thread,
          ),
        },
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.vcsListRefs) {
            return {
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 1,
              refs: [
                {
                  name: "main",
                  current: true,
                  isDefault: true,
                  worktreePath: null,
                },
              ],
            };
          }
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }
          return undefined;
        },
      });

      try {
        (await waitForButtonByText("Current checkout")).click();
        await page.getByText("New worktree", { exact: true }).click();

        await vi.waitFor(
          () => {
            expect(findButtonByText("New worktree")).toBeTruthy();
          },
          { timeout: 8_000, interval: 16 },
        );

        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
        await waitForLayout();

        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        sendButton.click();

        await vi.waitFor(
          () => {
            const turnStartRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.turn.start",
            ) as
              | {
                  _tag: string;
                  type?: string;
                  bootstrap?: {
                    createThread?: { projectId?: string };
                    prepareWorktree?: { projectCwd?: string; baseBranch?: string; branch?: string };
                    runSetupScript?: boolean;
                  };
                }
              | undefined;

            expect(turnStartRequest).toMatchObject({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              type: "thread.turn.start",
              bootstrap: {
                prepareWorktree: {
                  projectCwd: "/repo/project",
                  baseBranch: "main",
                  branch: expect.stringMatching(/^cafecode\/[0-9a-f]{8}$/),
                },
                runSetupScript: true,
              },
            });
            expect(turnStartRequest?.bootstrap?.createThread).toBeUndefined();
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("updates the selected worktree base branch on empty server threads", async () => {
      const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID ? Object.assign({}, thread, { session: null }) : thread,
          ),
        },
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.vcsListRefs) {
            return {
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 2,
              refs: [
                {
                  name: "main",
                  current: true,
                  isDefault: true,
                  worktreePath: null,
                },
                {
                  name: "release/next",
                  current: false,
                  isDefault: false,
                  worktreePath: null,
                },
              ],
            };
          }
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }
          return undefined;
        },
      });

      try {
        (await waitForButtonByText("Current checkout")).click();
        await page.getByText("New worktree", { exact: true }).click();
        await page.getByText("From main", { exact: true }).click();
        await page.getByText("release/next", { exact: true }).click();

        await vi.waitFor(
          () => {
            expect(findButtonByText("From release/next")).toBeTruthy();
          },
          { timeout: 8_000, interval: 16 },
        );

        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
        await waitForLayout();

        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        sendButton.click();

        await vi.waitFor(
          () => {
            const turnStartRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.turn.start",
            ) as
              | {
                  _tag: string;
                  type?: string;
                  bootstrap?: {
                    prepareWorktree?: { baseBranch?: string };
                  };
                }
              | undefined;

            expect(turnStartRequest?.bootstrap?.prepareWorktree?.baseBranch).toBe("release/next");
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("clears pending worktree overrides when switching empty server threads", async () => {
      const secondThreadId = "thread-browser-test-second" as ThreadId;
      const snapshot = addThreadToSnapshot(createDraftOnlySnapshot(), THREAD_ID);
      const snapshotWithSecondThread = addThreadToSnapshot(snapshot, secondThreadId);
      const snapshotWithTwoThreads = {
        ...snapshotWithSecondThread,
        threads: snapshotWithSecondThread.threads.map((thread) => {
          if (thread.id === THREAD_ID) {
            return Object.assign({}, thread, { session: null, title: "Thread alpha" });
          }
          if (thread.id === secondThreadId) {
            return Object.assign({}, thread, { session: null, title: "Thread beta" });
          }
          return thread;
        }),
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: snapshotWithTwoThreads,
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.vcsListRefs) {
            return {
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 2,
              refs: [
                {
                  name: "main",
                  current: true,
                  isDefault: true,
                  worktreePath: null,
                },
                {
                  name: "release/next",
                  current: false,
                  isDefault: false,
                  worktreePath: null,
                },
              ],
            };
          }
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }
          return undefined;
        },
      });

      try {
        (await waitForButtonByText("Current checkout")).click();
        await page.getByText("New worktree", { exact: true }).click();
        await page.getByText("From main", { exact: true }).click();
        await page.getByText("release/next", { exact: true }).click();

        await vi.waitFor(
          () => {
            expect(findButtonByText("From release/next")).toBeTruthy();
          },
          { timeout: 8_000, interval: 16 },
        );

        await mounted.router.navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: LOCAL_ENVIRONMENT_ID,
            threadId: secondThreadId,
          },
        });

        await waitForURL(
          mounted.router,
          (path) => path === serverThreadPath(secondThreadId),
          "Route should switch to the second empty server thread.",
        );

        await vi.waitFor(
          () => {
            expect(findButtonByText("Current checkout")).toBeTruthy();
            expect(findButtonByText("From release/next")).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );

        (await waitForButtonByText("Current checkout")).click();
        await page.getByText("New worktree", { exact: true }).click();

        await vi.waitFor(
          () => {
            expect(findButtonByText("From main")).toBeTruthy();
            expect(findButtonByText("From release/next")).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows the send state once bootstrap dispatch is in flight", async () => {
      useComposerDraftStore.setState({
        draftThreadsByThreadKey: {
          [THREAD_KEY]: {
            threadId: THREAD_ID,
            environmentId: LOCAL_ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            logicalProjectKey: PROJECT_DRAFT_KEY,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            envMode: "worktree",
          },
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {
          [PROJECT_DRAFT_KEY]: THREAD_KEY,
        },
      });

      let resolveDispatch!: (value: { sequence: number }) => void;
      const dispatchPromise = new Promise<{ sequence: number }>((resolve) => {
        resolveDispatch = resolve;
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: withProjectScripts(createDraftOnlySnapshot(), [
          {
            id: "setup",
            name: "Setup",
            command: "yarn install --immutable",
            icon: "configure",
            runOnWorktreeCreate: true,
          },
        ]),
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return dispatchPromise;
          }
          return undefined;
        },
      });

      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Ship it");
        await waitForLayout();

        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        sendButton.click();

        await vi.waitFor(
          () => {
            expect(
              wsRequests.some(
                (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
              ),
            ).toBe(true);
            expect(document.querySelector('button[aria-label="Sending"]')).toBeTruthy();
            expect(document.querySelector('button[aria-label="Preparing worktree"]')).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        resolveDispatch({ sequence: fixture.snapshot.snapshotSequence + 1 });
        await mounted.cleanup();
      }
    });

    it("restores composer focus after a send completes", async () => {
      let resolveDispatch!: (value: { sequence: number }) => void;
      let dispatchResolved = false;
      const dispatchPromise = new Promise<{ sequence: number }>((resolve) => {
        resolveDispatch = resolve;
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-focus-after-send" as MessageId,
          targetText: "focus after send target",
        }),
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return dispatchPromise;
          }
          return undefined;
        },
      });

      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Keep the composer focused");
        await waitForLayout();

        const editor = await waitForComposerEditor();
        editor.focus();
        await waitForLayout();
        expect(document.activeElement).toBe(editor);

        const sendButton = await waitForSendButton();
        expect(sendButton.disabled).toBe(false);
        sendButton.click();

        await vi.waitFor(
          () => {
            expect(
              wsRequests.some(
                (request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand,
              ),
            ).toBe(true);
            expect(document.querySelector('button[aria-label="Sending"]')).toBeTruthy();
            const currentEditor = document.querySelector<HTMLElement>(
              '[data-testid="composer-editor"]',
            );
            expect(currentEditor?.getAttribute("contenteditable")).toBe("false");
          },
          { timeout: 8_000, interval: 16 },
        );

        const acknowledgedTurnId = "turn-focus-after-send" as TurnId;
        const baseThread = fixture.snapshot.threads[0]!;
        const baseSession = baseThread.session!;
        const acknowledgedThread: OrchestrationReadModel["threads"][number] = {
          ...baseThread,
          latestTurn: {
            turnId: acknowledgedTurnId,
            state: "running" as const,
            requestedAt: isoAt(1_000),
            startedAt: isoAt(1_001),
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            ...baseSession,
            status: "running" as const,
            activeTurnId: acknowledgedTurnId,
            updatedAt: isoAt(1_001),
          },
          updatedAt: isoAt(1_001),
        };
        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence: fixture.snapshot.snapshotSequence + 1,
          threads: [acknowledgedThread],
        };
        dispatchResolved = true;
        resolveDispatch({ sequence: fixture.snapshot.snapshotSequence });
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: fixture.snapshot.snapshotSequence,
            thread: acknowledgedThread,
          },
        });

        await vi.waitFor(
          () => {
            const currentEditor = document.querySelector<HTMLElement>(
              '[data-testid="composer-editor"]',
            );
            expect(currentEditor?.getAttribute("contenteditable")).toBe("true");
            expect(document.activeElement).toBe(currentEditor);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        if (!dispatchResolved) {
          resolveDispatch({ sequence: fixture.snapshot.snapshotSequence + 1 });
        }
        await mounted.cleanup();
      }
    });

    it("attaches an image through the composer file picker", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-attach-image" as MessageId,
          targetText: "attach image target",
        }),
      });

      try {
        await waitForComposerEditor();

        const attachButton = await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              '[data-chat-composer-form="true"] button[aria-label="Attach image"]',
            ),
          "Unable to find composer attach-image button.",
        );

        const fileInput = document.querySelector<HTMLInputElement>(
          '[data-chat-composer-form="true"] input[type="file"]',
        );
        expect(fileInput).toBeTruthy();
        expect(fileInput!.accept).toBe("image/*");
        expect(fileInput!.multiple).toBe(true);

        // Tapping the button forwards to the hidden file input's native picker.
        let pickerOpened = false;
        const originalClick = fileInput!.click.bind(fileInput!);
        fileInput!.click = () => {
          pickerOpened = true;
        };
        attachButton.click();
        expect(pickerOpened).toBe(true);
        fileInput!.click = originalClick;

        // Simulate the user choosing a file from the native picker.
        const transfer = new DataTransfer();
        transfer.items.add(
          new File([new Uint8Array([1, 2, 3, 4])], "diagram.png", { type: "image/png" }),
        );
        fileInput!.files = transfer.files;
        fileInput!.dispatchEvent(new Event("change", { bubbles: true }));

        // The chosen image shows up in the composer preview strip.
        await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>('button[aria-label="Preview diagram.png"]'),
          "Unable to find attached image preview.",
        );
        await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>('button[aria-label="Remove diagram.png"]'),
          "Unable to find attached image remove control.",
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("exposes the attach-image button in the mobile keyboard overlay", async () => {
      // Headless Chromium reports a fine pointer, so force the touch media query
      // the composer uses to detect on-screen-keyboard devices.
      const restoreTouchMediaQuery = forceOnScreenKeyboardMediaQuery();
      const mounted = await mountChatView({
        viewport: COMPACT_FOOTER_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-mobile-attach-image" as MessageId,
          targetText: "mobile attach image target",
        }),
      });

      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "attach on mobile");
        await waitForLayout();

        const expandButton = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Expand composer"]'),
          "Unable to find compact composer expand button.",
        );
        expandButton.click();

        // Focusing opens the on-screen-keyboard overlay, which hides the footer
        // and surfaces the attach control alongside the primary action so touch
        // users can add an image without a paste/drag affordance.
        const overlayAttachButton = await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              '[data-chat-composer-mobile-pending-actions="true"] button[aria-label="Attach image"]',
            ),
          "Unable to find mobile overlay attach-image button.",
        );

        const fileInput = document.querySelector<HTMLInputElement>(
          '[data-chat-composer-form="true"] input[type="file"]',
        );
        expect(fileInput).toBeTruthy();

        let pickerOpened = false;
        const originalClick = fileInput!.click.bind(fileInput!);
        fileInput!.click = () => {
          pickerOpened = true;
        };
        overlayAttachButton.click();
        expect(pickerOpened).toBe(true);
        fileInput!.click = originalClick;
      } finally {
        await mounted.cleanup();
        restoreTouchMediaQuery();
      }
    });

    it("shows an attachment count pill in the collapsed mobile composer", async () => {
      const restoreTouchMediaQuery = forceOnScreenKeyboardMediaQuery();
      const mounted = await mountChatView({
        viewport: COMPACT_FOOTER_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-mobile-attachment-pill" as MessageId,
          targetText: "mobile attachment pill target",
        }),
      });

      try {
        const file = new File([new Uint8Array([1, 2, 3, 4])], "diagram.png", { type: "image/png" });
        useComposerDraftStore.getState().addImage(THREAD_REF, {
          type: "image",
          id: "composer-image-pill",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: file.size,
          previewUrl: URL.createObjectURL(file),
          file,
        });
        await waitForLayout();

        // Collapsed (keyboard down) hides the preview strip, so the count pill is
        // the only signal the attachment is still there.
        const pill = await waitForElement(
          () =>
            Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
              button.getAttribute("aria-label")?.includes("1 attachment attached"),
            ) ?? null,
          "Unable to find collapsed-composer attachment pill.",
        );
        expect(pill.textContent).toContain("1 attachment");

        // Tapping it expands the composer so the attachment can be managed.
        pill.click();
        await vi.waitFor(
          () => {
            const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
            expect(editor?.getAttribute("contenteditable")).toBe("true");
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
        restoreTouchMediaQuery();
      }
    });

    it("locks the composer while the provider session is starting", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-provider-starting" as MessageId,
          targetText: "provider starting",
          sessionStatus: "starting",
        }),
      });

      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "follow-up while starting");
        await waitForLayout();

        await vi.waitFor(
          () => {
            const connectingButton = document.querySelector<HTMLButtonElement>(
              'button[aria-label="Connecting"]',
            );
            expect(connectingButton).toBeTruthy();
            expect(connectingButton?.disabled).toBe(true);
            expect(connectingButton?.querySelector(".animate-spin")).toBeTruthy();

            const editor = document.querySelector<HTMLElement>('[data-testid="composer-editor"]');
            expect(editor).toBeTruthy();
            expect(editor?.getAttribute("contenteditable")).toBe("false");
          },
          { timeout: 8_000, interval: 16 },
        );
        await expect.element(page.getByText("Starting Codex...")).toBeVisible();
      } finally {
        await mounted.cleanup();
      }
    });

    it("toggles plan mode with Shift+Tab only while the composer is focused", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-target-hotkey" as MessageId,
          targetText: "hotkey target",
        }),
      });

      try {
        const initialModeButton = await waitForInteractionModeButton("Build");
        expect(initialModeButton.title).toContain("enter plan mode");

        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        await waitForLayout();

        expect((await waitForInteractionModeButton("Build")).title).toContain("enter plan mode");

        const composerEditor = await waitForComposerEditor();
        composerEditor.focus();
        composerEditor.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );

        await vi.waitFor(
          async () => {
            expect((await waitForInteractionModeButton("Plan")).title).toContain(
              "return to normal build mode",
            );
          },
          { timeout: 8_000, interval: 16 },
        );

        composerEditor.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Tab",
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );

        await vi.waitFor(
          async () => {
            expect((await waitForInteractionModeButton("Build")).title).toContain(
              "enter plan mode",
            );
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps Claude permission modes in options and cycles them with Shift+Tab", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-target-claude-mode-hotkey" as MessageId,
          targetText: "claude mode hotkey target",
          provider: "claudeAgent",
          runtimeMode: "approval-required",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            providers: [
              ...nextFixture.serverConfig.providers,
              {
                driver: ProviderDriverKind.make("claudeAgent"),
                instanceId: ProviderInstanceId.make("claudeAgent"),
                enabled: true,
                installed: true,
                version: "2.1.216",
                status: "ready",
                auth: { status: "authenticated" },
                checkedAt: NOW_ISO,
                models: [
                  {
                    slug: "claude-opus-4-8",
                    name: "Claude Opus 4.8",
                    isCustom: false,
                    capabilities: createModelCapabilities({ optionDescriptors: [] }),
                  },
                ],
                slashCommands: [],
                skills: [],
              },
            ],
          };
        },
      });

      try {
        const footer = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
          "Unable to find composer footer.",
        );
        const optionsButton = await waitForElement(
          () =>
            footer.querySelector<HTMLButtonElement>('button[aria-label="More composer controls"]'),
          "Unable to find the combined composer options button.",
        );
        expect(
          Array.from(footer.querySelectorAll("button")).some((button) =>
            ["Manual", "Accept edits", "Plan", "Auto", "Bypass permissions"].includes(
              button.textContent?.trim() ?? "",
            ),
          ),
        ).toBe(false);

        optionsButton.click();
        expect((await waitForMenuRadioItemContainingText("Manual")).textContent).toContain(
          "Ask before edits and commands",
        );
        expect((await waitForMenuRadioItemContainingText("Accept edits")).textContent).toContain(
          "Apply edits automatically",
        );
        expect(
          (await waitForMenuRadioItemContainingText("Bypass permissions")).textContent,
        ).toContain("Run without permission checks");
        await userEvent.keyboard("{Escape}");
        await vi.waitFor(() => {
          expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
        });

        const composerEditor = await waitForComposerEditor();
        const expectedModes = [
          {
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
          },
          {
            runtimeMode: "auto-accept-edits",
            interactionMode: "plan",
          },
          {
            runtimeMode: "auto-accept-edits",
            interactionMode: "auto",
          },
          {
            runtimeMode: "approval-required",
            interactionMode: "default",
          },
        ] as const;

        for (const expected of expectedModes) {
          composerEditor.focus();
          composerEditor.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Tab",
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
          await vi.waitFor(() => {
            const draft = useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY];
            expect(draft?.runtimeMode ?? "approval-required").toBe(expected.runtimeMode);
            expect(draft?.interactionMode ?? "default").toBe(expected.interactionMode);
          });
        }
      } finally {
        await mounted.cleanup();
      }
    });

    it("uses the active draft route session when changing the base branch", async () => {
      const staleDraftId = draftIdFromPath("/draft/draft-stale-branch-session");
      const activeDraftId = draftIdFromPath("/draft/draft-active-branch-session");

      useComposerDraftStore.setState({
        draftThreadsByThreadKey: {
          [staleDraftId]: {
            threadId: THREAD_ID,
            environmentId: LOCAL_ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            logicalProjectKey: `${PROJECT_DRAFT_KEY}:stale`,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            envMode: "worktree",
          },
          [activeDraftId]: {
            threadId: THREAD_ID,
            environmentId: LOCAL_ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            logicalProjectKey: PROJECT_DRAFT_KEY,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            envMode: "worktree",
          },
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {
          [`${PROJECT_DRAFT_KEY}:stale`]: staleDraftId,
          [PROJECT_DRAFT_KEY]: activeDraftId,
        },
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        initialPath: `/draft/${activeDraftId}`,
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.vcsListRefs) {
            return {
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 2,
              refs: [
                {
                  name: "main",
                  current: true,
                  isDefault: true,
                  worktreePath: null,
                },
                {
                  name: "release/next",
                  current: false,
                  isDefault: false,
                  worktreePath: null,
                },
              ],
            };
          }
          return undefined;
        },
      });

      try {
        const branchButton = await waitForElement(
          () =>
            Array.from(document.querySelectorAll("button")).find(
              (button) => button.textContent?.trim() === "From main",
            ) as HTMLButtonElement | null,
          'Unable to find branch selector button with "From main".',
        );
        branchButton.click();

        const branchOption = await waitForElement(
          () =>
            Array.from(document.querySelectorAll("span")).find(
              (element) => element.textContent?.trim() === "release/next",
            ) as HTMLSpanElement | null,
          'Unable to find the "release/next" branch option.',
        );
        branchOption.click();

        await vi.waitFor(
          () => {
            expect(useComposerDraftStore.getState().getDraftSession(activeDraftId)?.branch).toBe(
              "release/next",
            );
            expect(useComposerDraftStore.getState().getDraftSession(staleDraftId)?.branch).toBe(
              "main",
            );
          },
          { timeout: 8_000, interval: 16 },
        );

        await vi.waitFor(
          () => {
            const updatedButton = Array.from(document.querySelectorAll("button")).find((button) =>
              button.textContent?.trim().includes("From release/next"),
            );
            expect(updatedButton).toBeTruthy();
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps the new worktree branch picker anchored at the top when opening with a preselected branch", async () => {
      const draftId = DraftId.make("draft-branch-picker-scroll-regression");
      const branches = [
        {
          name: "feature/current",
          current: true,
          isDefault: false,
          worktreePath: null,
        },
        {
          name: "main",
          current: false,
          isDefault: true,
          worktreePath: null,
        },
        ...Array.from({ length: 48 }, (_, index) => ({
          name: `feature/${String(index).padStart(2, "0")}`,
          current: false,
          isDefault: false,
          worktreePath: null,
        })),
        {
          name: "feature/selected",
          current: false,
          isDefault: false,
          worktreePath: null,
        },
      ];

      useComposerDraftStore.setState({
        draftThreadsByThreadKey: {
          [draftId]: {
            threadId: THREAD_ID,
            environmentId: LOCAL_ENVIRONMENT_ID,
            projectId: PROJECT_ID,
            logicalProjectKey: PROJECT_DRAFT_KEY,
            createdAt: NOW_ISO,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature/selected",
            worktreePath: null,
            envMode: "worktree",
          },
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {
          [PROJECT_DRAFT_KEY]: draftId,
        },
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
        initialPath: `/draft/${draftId}`,
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.vcsListRefs) {
            return {
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: branches.length,
              refs: branches,
            };
          }
          return undefined;
        },
      });

      try {
        const branchButton = await waitForElement(
          () =>
            Array.from(document.querySelectorAll("button")).find(
              (button) => button.textContent?.trim() === "From feature/selected",
            ) as HTMLButtonElement | null,
          'Unable to find branch selector button with "From feature/selected".',
        );
        branchButton.click();

        await waitForElement(
          () => document.querySelector<HTMLInputElement>('input[placeholder="Search refs..."]'),
          "Unable to find ref search input.",
        );

        const popup = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-slot="combobox-popup"]'),
          "Unable to find the branch picker popup.",
        );

        await vi.waitFor(
          () => {
            const popupSpans = Array.from(popup.querySelectorAll("span"));
            expect(
              popupSpans.some((element) => element.textContent?.trim() === "feature/current"),
            ).toBe(true);
            expect(popupSpans.some((element) => element.textContent?.trim() === "main")).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("surrounds selected plain text and preserves the inner selection for repeated wrapping", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-surround-basic" as MessageId,
          targetText: "surround basic",
        }),
      });

      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");
        await waitForComposerText("selected");
        await setComposerSelectionByTextOffsets({ start: 0, end: "selected".length });
        await pressComposerKey("(");
        await waitForComposerText("(selected)");

        await pressComposerKey("[");
        await waitForComposerText("([selected])");
      } finally {
        await mounted.cleanup();
      }
    });

    it("leaves collapsed-caret typing unchanged for surround symbols", async () => {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "selected");

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-surround-collapsed" as MessageId,
          targetText: "surround collapsed",
        }),
      });

      try {
        await waitForComposerText("selected");
        await setComposerSelectionByTextOffsets({
          start: "selected".length,
          end: "selected".length,
        });
        await pressComposerKey("(");
        await waitForComposerText("selected(");
      } finally {
        await mounted.cleanup();
      }
    });

    it("supports symmetric and backward-selection surrounds", async () => {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "backward");

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-surround-backward" as MessageId,
          targetText: "surround backward",
        }),
      });

      try {
        await waitForComposerText("backward");
        await setComposerSelectionByTextOffsets({
          start: 0,
          end: "backward".length,
          direction: "backward",
        });
        await pressComposerKey("*");
        await waitForComposerText("*backward*");
      } finally {
        await mounted.cleanup();
      }
    });

    it("supports option-produced surround symbols like guillemets", async () => {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-surround-guillemet" as MessageId,
          targetText: "surround guillemet",
        }),
      });

      try {
        await waitForComposerText("quoted");
        await setComposerSelectionByTextOffsets({ start: 0, end: "quoted".length });
        await pressComposerKey("«");
        await waitForComposerText("«quoted»");
      } finally {
        await mounted.cleanup();
      }
    });

    it("supports dead-key composition that resolves to another surround symbol without an extra undo step", async () => {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "quoted");

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-surround-dead-quote" as MessageId,
          targetText: "surround dead quote",
        }),
      });

      try {
        await waitForComposerText("quoted");
        await setComposerSelectionByTextOffsets({ start: 0, end: "quoted".length });
        const composerEditor = await waitForComposerEditor();
        composerEditor.focus();
        composerEditor.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Dead",
            bubbles: true,
            cancelable: true,
          }),
        );
        composerEditor.dispatchEvent(
          new InputEvent("beforeinput", {
            data: "'",
            inputType: "insertCompositionText",
            bubbles: true,
            cancelable: true,
          }),
        );
        const resolvedInputEvent = new InputEvent("beforeinput", {
          data: "'",
          inputType: "insertText",
          bubbles: true,
          cancelable: true,
        });
        composerEditor.dispatchEvent(resolvedInputEvent);
        expect(resolvedInputEvent.defaultPrevented).toBe(true);
        await waitForComposerText("'quoted'");
        await pressComposerUndo();
        await waitForComposerText("quoted");
      } finally {
        await mounted.cleanup();
      }
    });

    it("surrounds text after a mention using the correct expanded offsets", async () => {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there");

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-surround-after-mention" as MessageId,
          targetText: "surround after mention",
        }),
      });

      try {
        await vi.waitFor(
          () => {
            expect(document.body.textContent).toContain("package.json");
          },
          { timeout: 8_000, interval: 16 },
        );
        await waitForComposerText("hi @package.json there");
        await setComposerSelectionByTextOffsets({
          start: "hi package.json ".length,
          end: "hi package.json there".length,
        });
        await pressComposerKey("(");
        await waitForComposerText("hi @package.json (there)");
      } finally {
        await mounted.cleanup();
      }
    });

    it("falls back to normal replacement when the selection includes a mention token", async () => {
      useComposerDraftStore.getState().setPrompt(THREAD_REF, "hi @package.json there ");

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-surround-token" as MessageId,
          targetText: "surround token",
        }),
      });

      try {
        await vi.waitFor(
          () => {
            expect(document.body.textContent).toContain("package.json");
          },
          { timeout: 8_000, interval: 16 },
        );
        await selectAllComposerContent();
        await pressComposerKey("(");
        await waitForComposerText("(");
      } finally {
        await mounted.cleanup();
      }
    });

    it("replaces Stop with Send while a running turn has a follow-up draft", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-running-follow-up-send" as MessageId,
          targetText: "running follow-up send target",
          sessionStatus: "running",
        }),
      });

      try {
        const initialStopButton = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          "Unable to find the empty running composer Stop button.",
        );
        expect(initialStopButton.disabled).toBe(false);

        useComposerDraftStore
          .getState()
          .setPrompt(THREAD_REF, "Queue this without interrupting the active turn");

        const queueButton = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]'),
          "Unable to find the running composer Send button.",
        );
        expect(queueButton.disabled).toBe(false);
        expect(
          document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        ).toBeNull();

        queueButton.click();

        await vi.waitFor(
          () => {
            expect(document.querySelector('[data-cafe-followup-queue="true"]')).not.toBeNull();
            expect(
              useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "",
            ).toBe("");
            const queuedGuardButton = document.querySelector<HTMLButtonElement>(
              'button[aria-label="Queue message"]',
            );
            expect(queuedGuardButton).not.toBeNull();
            expect(queuedGuardButton?.disabled).toBe(true);
            expect(
              document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
            ).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );

        // Exercise the control again during the double-click guard. A rapid
        // second activation must remain harmless instead of landing on Stop.
        document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]')?.click();
        await waitForLayout();
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.interrupt",
          ),
        ).toBe(false);

        await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          "Stop did not return after the post-send double-click guard elapsed.",
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps a steer pending when another message starts processing on the same turn", async () => {
      const activeTurnId = "turn-correlated-steer-processing" as TurnId;
      const baseSnapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-correlated-steer-processing" as MessageId,
        targetText: "correlated steer processing target",
        sessionStatus: "running",
      });
      const runningSnapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          Object.assign({}, thread, {
            latestTurn: {
              turnId: activeTurnId,
              state: "running" as const,
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              ...thread.session!,
              status: "running" as const,
              activeTurnId,
              updatedAt: isoAt(1_001),
            },
            updatedAt: isoAt(1_001),
          }),
        ),
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: runningSnapshot,
        configureFixture: (testFixture) => {
          testFixture.serverConfig = {
            ...testFixture.serverConfig,
            providers: testFixture.serverConfig.providers.map((provider) => ({
              ...provider,
              runtimeCapabilities: {
                liveSteer: "supported" as const,
                threadGoals: "unsupported" as const,
              },
            })),
          };
        },
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return { sequence: fixture.snapshot.snapshotSequence + 1 };
          }
          return undefined;
        },
      });

      try {
        useComposerDraftStore
          .getState()
          .setPrompt(THREAD_REF, "Keep this steer pending until its own marker arrives");

        const queueButton = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]'),
          "Unable to find the running composer Send button.",
        );
        queueButton.click();

        const steerButton = await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              '[data-cafe-followup-queue="true"] .cafe-followup-steer-button',
            ),
          "Unable to find the queued follow-up Send action.",
        );
        steerButton.click();

        let dispatchedMessageId: MessageId | null = null;
        await vi.waitFor(
          () => {
            const request = wsRequests.find(
              (candidate) =>
                candidate._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                candidate.type === "thread.turn.steer",
            ) as
              | {
                  readonly type: "thread.turn.steer";
                  readonly message: { readonly messageId: MessageId };
                }
              | undefined;
            dispatchedMessageId = request?.message.messageId ?? null;
            expect(dispatchedMessageId).not.toBeNull();
            expect(
              document.querySelector('[aria-label="Follow-up steering into active turn"]'),
            ).not.toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );

        const emitProcessingActivity = (
          messageId: MessageId,
          eventId: string,
          correlationLocation: "payload" | "usage",
        ) => {
          const currentThread = fixture.snapshot.threads[0]!;
          const snapshotSequence = fixture.snapshot.snapshotSequence + 1;
          const processingPayload = {
            taskId: `codex-turn-steer-processing:${activeTurnId}`,
            detail: "Codex app-server began processing turn/steer.",
            ...(correlationLocation === "payload" ? { messageId } : { usage: { messageId } }),
          };
          const nextThread: OrchestrationReadModel["threads"][number] = {
            ...currentThread,
            activities: [
              ...currentThread.activities,
              {
                id: EventId.make(eventId),
                tone: "info",
                kind: "task.progress",
                summary: "Reasoning update",
                payload: processingPayload,
                turnId: activeTurnId,
                sequence: currentThread.activities.length + 1,
                createdAt: new Date(Date.now() + snapshotSequence * 1_000).toISOString(),
              },
            ],
            updatedAt: new Date(Date.now() + snapshotSequence * 1_000).toISOString(),
          };
          fixture.snapshot = {
            ...fixture.snapshot,
            snapshotSequence,
            threads: [nextThread],
          };
          rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
            kind: "snapshot",
            snapshot: {
              snapshotSequence,
              thread: nextThread,
            },
          });
        };

        emitProcessingActivity(
          "different-steer-message" as MessageId,
          "activity-other-steer-processing",
          "usage",
        );
        await waitForLayout();
        expect(
          document.querySelector('[aria-label="Follow-up steering into active turn"]'),
        ).not.toBeNull();

        emitProcessingActivity(
          dispatchedMessageId!,
          "activity-correlated-steer-processing",
          "payload",
        );
        await vi.waitFor(
          () => {
            expect(
              document.querySelector('[aria-label="Follow-up steering into active turn"]'),
            ).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );
        expect(
          wsRequests.filter(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.steer",
          ),
        ).toHaveLength(1);
      } finally {
        await mounted.cleanup();
      }
    });

    it("settles a pending steer only from an exact successful delivery receipt", async () => {
      const activeTurnId = "turn-steer-delivery-receipt" as TurnId;
      const baseSnapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-steer-delivery-receipt" as MessageId,
        targetText: "delivery receipt target",
        sessionStatus: "running",
      });
      const runningSnapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          Object.assign({}, thread, {
            latestTurn: {
              turnId: activeTurnId,
              state: "running" as const,
              requestedAt: isoAt(1_000),
              startedAt: isoAt(1_001),
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              ...thread.session!,
              status: "running" as const,
              activeTurnId,
              updatedAt: isoAt(1_001),
            },
            updatedAt: isoAt(1_001),
          }),
        ),
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: runningSnapshot,
        configureFixture: (testFixture) => {
          testFixture.serverConfig = {
            ...testFixture.serverConfig,
            providers: testFixture.serverConfig.providers.map((provider) => ({
              ...provider,
              runtimeCapabilities: {
                liveSteer: "supported" as const,
                threadGoals: "unsupported" as const,
              },
            })),
          };
        },
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return { sequence: fixture.snapshot.snapshotSequence + 1 };
          }
          return undefined;
        },
      });

      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "Deliver this steer exactly once");
        const queueButton = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]'),
          "Unable to find the running composer Send button.",
        );
        queueButton.click();
        const steerButton = await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              '[data-cafe-followup-queue="true"] .cafe-followup-steer-button',
            ),
          "Unable to find the queued follow-up Send action.",
        );
        steerButton.click();

        let dispatchedMessageId: MessageId | null = null;
        await vi.waitFor(
          () => {
            const request = wsRequests.find(
              (candidate) =>
                candidate._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                candidate.type === "thread.turn.steer",
            ) as
              | {
                  readonly type: "thread.turn.steer";
                  readonly message: { readonly messageId: MessageId };
                }
              | undefined;
            dispatchedMessageId = request?.message.messageId ?? null;
            expect(dispatchedMessageId).not.toBeNull();
            expect(
              document.querySelector('[aria-label="Follow-up steering into active turn"]'),
            ).not.toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );

        const emitReceiptActivity = (input: {
          readonly id: string;
          readonly kind: string;
          readonly payload: unknown;
        }) => {
          const currentThread = fixture.snapshot.threads[0]!;
          const snapshotSequence = fixture.snapshot.snapshotSequence + 1;
          const nextThread: OrchestrationReadModel["threads"][number] = {
            ...currentThread,
            activities: [
              ...currentThread.activities,
              {
                id: EventId.make(input.id),
                tone: "info",
                kind: input.kind,
                summary: "Steer delivery state changed",
                payload: input.payload,
                turnId: activeTurnId,
                sequence: currentThread.activities.length + 1,
                createdAt: isoAt(1_010 + snapshotSequence),
              },
            ],
            updatedAt: isoAt(1_010 + snapshotSequence),
          };
          fixture.snapshot = {
            ...fixture.snapshot,
            snapshotSequence,
            threads: [nextThread],
          };
          rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
            kind: "snapshot",
            snapshot: { snapshotSequence, thread: nextThread },
          });
        };

        emitReceiptActivity({
          id: "activity-pre-io-steer-warning",
          kind: "runtime.warning",
          payload: {
            provider: "codex",
            messageId: dispatchedMessageId!,
            delivery: "next-turn",
          },
        });
        await waitForLayout();
        expect(
          document.querySelector('[aria-label="Follow-up steering into active turn"]'),
        ).not.toBeNull();

        emitReceiptActivity({
          id: "activity-steer-delivered",
          kind: "provider.turn.steer.delivered",
          payload: {
            provider: "codex",
            messageId: dispatchedMessageId!,
            deliveredTurnId: "turn-delivered-next",
            delivery: "next-turn",
            reason: "active-turn-ended-before-steer",
          },
        });
        await vi.waitFor(
          () => {
            expect(
              document.querySelector('[aria-label="Follow-up steering into active turn"]'),
            ).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps a same-id retry pending until that retry generation fails", async () => {
      const activeTurnId = "turn-same-id-steer-retry" as TurnId;
      const messageId = "msg-same-id-steer-retry" as MessageId;
      const baseSnapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-same-id-steer-target" as MessageId,
        targetText: "same-id steer target",
        sessionStatus: "running",
      });
      const retryMessage = {
        ...createUserMessage({
          id: messageId,
          text: "Retry this exact message",
          offsetSeconds: 2_000,
        }),
        turnId: activeTurnId,
      };
      const oldFailure = {
        id: EventId.make("activity-old-same-id-steer-failure"),
        tone: "error" as const,
        kind: "provider.turn.steer.failed",
        summary: "Codex could not steer the compact turn",
        payload: {
          provider: "codex",
          messageId,
          intentSequence: 41,
          retryableFollowUp: true,
          codexNonSteerableTurnKind: "compact",
        },
        turnId: activeTurnId,
        sequence: 42,
        createdAt: isoAt(2_002),
      };
      const runningSnapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          Object.assign({}, thread, {
            messages: [...thread.messages, retryMessage],
            activities: [oldFailure],
            latestTurn: {
              turnId: activeTurnId,
              state: "running" as const,
              requestedAt: isoAt(1_900),
              startedAt: isoAt(1_901),
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              ...thread.session!,
              status: "running" as const,
              activeTurnId,
              updatedAt: isoAt(2_003),
            },
            updatedAt: isoAt(2_003),
          }),
        ),
      };
      const currentIntentSequence = 77;
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: runningSnapshot,
        configureFixture: (testFixture) => {
          testFixture.serverConfig = {
            ...testFixture.serverConfig,
            providers: testFixture.serverConfig.providers.map((provider) => ({
              ...provider,
              runtimeCapabilities: {
                liveSteer: "supported" as const,
                threadGoals: "unsupported" as const,
              },
            })),
          };
        },
        resolveRpc: (body) =>
          body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand
            ? { sequence: currentIntentSequence }
            : undefined,
      });

      try {
        await vi.waitFor(
          () => {
            const steerButton = document.querySelector<HTMLButtonElement>(
              '[data-cafe-followup-queue="true"] .cafe-followup-steer-button',
            );
            const automaticallyDispatched = wsRequests.some(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.turn.steer",
            );
            expect(steerButton !== null || automaticallyDispatched).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );
        // Compact-blocked retries can become immediately eligible and be
        // auto-steered; click only when the visible shelf action won the race.
        document
          .querySelector<HTMLButtonElement>(
            '[data-cafe-followup-queue="true"] .cafe-followup-steer-button',
          )
          ?.click();

        await vi.waitFor(
          () => {
            expect(
              wsRequests.some(
                (request) =>
                  request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                  request.type === "thread.turn.steer" &&
                  (
                    request as unknown as {
                      readonly message: { readonly messageId: MessageId };
                    }
                  ).message.messageId === messageId,
              ),
            ).toBe(true);
            // The old generation-41 failure remains in the snapshot, but must
            // not settle the generation-77 retry that reused its MessageId.
            expect(
              document.querySelector('[aria-label="Follow-up steering into active turn"]'),
            ).not.toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );

        const currentThread = fixture.snapshot.threads[0]!;
        const snapshotSequence = fixture.snapshot.snapshotSequence + 1;
        const nextThread: OrchestrationReadModel["threads"][number] = {
          ...currentThread,
          activities: [
            ...currentThread.activities,
            {
              ...oldFailure,
              id: EventId.make("activity-current-same-id-steer-failure"),
              payload: { ...oldFailure.payload, intentSequence: currentIntentSequence },
              sequence: 43,
              createdAt: new Date().toISOString(),
            },
          ],
          updatedAt: new Date().toISOString(),
        };
        fixture.snapshot = { ...fixture.snapshot, snapshotSequence, threads: [nextThread] };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: { snapshotSequence, thread: nextThread },
        });
        await vi.waitFor(
          () => {
            expect(
              document.querySelector('[aria-label="Follow-up steering into active turn"]'),
            ).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("reconstructs more than 64 durable steer retries once after a reload", async () => {
      const activeTurnId = "turn-reload-retry-review" as TurnId;
      const baseSnapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-reload-retry-target" as MessageId,
        targetText: "reload retry target",
        sessionStatus: "running",
      });
      const retryMessages = Array.from({ length: 65 }, (_, index) => ({
        ...createUserMessage({
          id: `msg-reload-retry-${index}` as MessageId,
          text: `Durable retry prompt ${index}`,
          offsetSeconds: 2_000 + index * 2,
        }),
        turnId: activeTurnId,
      }));
      const retryActivities = retryMessages.map((message, index) => ({
        id: EventId.make(`activity-reload-retry-${index}`),
        tone: "error" as const,
        kind: "provider.turn.steer.failed",
        summary: "Codex could not steer the review turn",
        payload: {
          provider: "codex",
          messageId: message.id,
          retryableFollowUp: true,
          codexNonSteerableTurnKind: "review",
        },
        turnId: activeTurnId,
        sequence: index + 1,
        createdAt: isoAt(2_001 + index * 2),
      }));
      const reloadSnapshot: OrchestrationReadModel = {
        ...baseSnapshot,
        threads: baseSnapshot.threads.map((thread) =>
          Object.assign({}, thread, {
            messages: [...thread.messages, ...retryMessages],
            activities: retryActivities,
            latestTurn: {
              turnId: activeTurnId,
              state: "running" as const,
              requestedAt: isoAt(1_900),
              startedAt: isoAt(1_901),
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              ...thread.session!,
              status: "running" as const,
              activeTurnId,
              updatedAt: isoAt(2_200),
            },
            updatedAt: isoAt(2_200),
          }),
        ),
      };
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: reloadSnapshot,
        configureFixture: (testFixture) => {
          testFixture.serverConfig = {
            ...testFixture.serverConfig,
            providers: testFixture.serverConfig.providers.map((provider) => ({
              ...provider,
              runtimeCapabilities: {
                liveSteer: "supported" as const,
                threadGoals: "unsupported" as const,
              },
            })),
          };
        },
      });

      try {
        await vi.waitFor(
          () => {
            expect(
              document.querySelectorAll('button[aria-label="Remove queued message"]').length,
            ).toBe(65);
            expect(document.body.textContent).toContain("65 steers waiting");
            expect(document.body.textContent).toContain("Durable retry prompt 0");
            expect(document.body.textContent).toContain("Durable retry prompt 64");
          },
          { timeout: 12_000, interval: 16 },
        );
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              (request.type === "thread.turn.steer" || request.type === "thread.turn.start"),
          ),
        ).toBe(false);

        // Replaying the same canonical snapshot models reconnect hydration.
        // Every source MessageId must remain represented exactly once.
        const currentThread = fixture.snapshot.threads[0]!;
        const snapshotSequence = fixture.snapshot.snapshotSequence + 1;
        fixture.snapshot = {
          ...fixture.snapshot,
          snapshotSequence,
          threads: [{ ...currentThread, updatedAt: isoAt(2_201) }],
        };
        rpcHarness.emitStreamValue(ORCHESTRATION_WS_METHODS.subscribeThread, {
          kind: "snapshot",
          snapshot: {
            snapshotSequence,
            thread: fixture.snapshot.threads[0]!,
          },
        });
        await waitForLayout();
        expect(document.querySelectorAll('button[aria-label="Remove queued message"]').length).toBe(
          65,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps Send guarded when a mobile follow-up collapses the keyboard overlay", async () => {
      const restoreTouchMediaQuery = forceOnScreenKeyboardMediaQuery();
      const mounted = await mountChatView({
        viewport: COMPACT_FOOTER_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-mobile-running-follow-up-send" as MessageId,
          targetText: "mobile running follow-up send target",
          sessionStatus: "running",
        }),
      });

      try {
        useComposerDraftStore
          .getState()
          .setPrompt(THREAD_REF, "Queue this mobile follow-up without interrupting");

        const expandButton = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Expand composer"]'),
          "Unable to find the compact running composer expand button.",
        );
        expandButton.click();

        const overlayQueueButton = await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              '[data-chat-composer-mobile-pending-actions="true"] button[aria-label="Queue message"]',
            ),
          "Unable to find the mobile keyboard overlay Send button.",
        );
        expect(
          document.querySelector<HTMLButtonElement>(
            '[data-chat-composer-mobile-pending-actions="true"] button[aria-label="Stop generation"]',
          ),
        ).toBeNull();

        // Let the synchronous expand gesture release before exercising the
        // next touch gesture, matching a real user tap after the keyboard has
        // opened rather than compressing both gestures into one animation frame.
        await waitForLayout();
        overlayQueueButton.click();

        const guardedFooterQueueButton = await waitForElement(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-chat-composer-actions="right"] button[aria-label="Queue message"]',
          );
          return button?.disabled ? button : null;
        }, "The mobile footer did not preserve the guarded Send action after hiding the keyboard.");
        expect(document.querySelector('[data-cafe-followup-queue="true"]')).not.toBeNull();
        expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.prompt ?? "").toBe(
          "",
        );
        expect(
          document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
        ).toBeNull();

        // A second activation at the same coordinates remains inert after the
        // overlay-to-footer transition instead of interrupting the provider.
        guardedFooterQueueButton.click();
        await waitForLayout();
        expect(
          wsRequests.some(
            (request) =>
              request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
              request.type === "thread.turn.interrupt",
          ),
        ).toBe(false);

        await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          "Stop did not return after the mobile post-send guard elapsed.",
        );
      } finally {
        await mounted.cleanup();
        restoreTouchMediaQuery();
      }
    });
  }

  if (chatViewBrowserPart === "navigation") {
    it("replaces an open subagent detail with Atrium and does not restore it on close", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithActiveSubagent(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            clientSettings: {
              ...nextFixture.serverConfig.clientSettings,
              ambianceAtriumEnabled: true,
            },
          };
        },
      });

      try {
        await page.getByRole("button", { name: /^1 active subagent\. Show task list$/i }).click();
        const subagentRow = page
          .getByRole("region", { name: "Active subagents" })
          .getByRole("button", {
            name: /Browser lifecycle audit, Working\. Verify Atrium navigation\. Open details/i,
          });
        await expect.element(subagentRow).toBeInTheDocument();
        await subagentRow.click();
        await vi.waitFor(() => {
          expect(document.querySelector('[data-subagent-detail-view="true"]')).not.toBeNull();
        });

        useTaskAtriumStore.getState().setOpen(true);
        await vi.waitFor(() => {
          expect(document.querySelector('[data-cafe-task-atrium-overlay="true"]')).not.toBeNull();
          expect(document.querySelector('[data-subagent-detail-view="true"]')).toBeNull();
        });

        useTaskAtriumStore.getState().setOpen(false);
        await vi.waitFor(() => {
          expect(document.querySelector('[data-cafe-task-atrium-overlay="true"]')).toBeNull();
          expect(document.querySelector('[data-subagent-detail-view="true"]')).toBeNull();
        });
      } finally {
        useTaskAtriumStore.getState().setOpen(false);
        await mounted.cleanup();
      }
    });

    it("keeps runtime access in the desktop options menu without a footer mode label", async () => {
      setDraftThreadWithoutWorktree();

      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: createDraftOnlySnapshot(),
      });

      try {
        const footer = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
          "Unable to find composer footer.",
        );
        const optionsButton = await waitForElement(
          () =>
            footer.querySelector<HTMLButtonElement>('button[aria-label="More composer controls"]'),
          "Unable to find the combined composer options button.",
        );
        const footerShowsAccessMode = () =>
          Array.from(footer.querySelectorAll("button")).some((button) =>
            ["Supervised", "Auto-accept edits", "Full access"].includes(
              button.textContent?.trim() ?? "",
            ),
          );

        // The provider fixture intentionally has no option descriptors. Access
        // still needs a fallback options trigger, but the selected access label
        // must not consume permanent footer space.
        expect(optionsButton.textContent?.trim()).toBe("");
        expect(footerShowsAccessMode()).toBe(false);
        optionsButton.click();

        expect((await waitForMenuRadioItemContainingText("Supervised")).textContent).toContain(
          "Ask before commands and file changes",
        );

        const autoAcceptItem = await waitForMenuRadioItemContainingText("Auto-accept edits");
        expect(autoAcceptItem.textContent).toContain("Auto-approve edits");
        expect((await waitForMenuRadioItemContainingText("Full access")).textContent).toContain(
          "Allow commands and edits without prompts",
        );

        autoAcceptItem.click();
        await vi.waitFor(() => {
          expect(useComposerDraftStore.getState().draftsByThreadKey[THREAD_KEY]?.runtimeMode).toBe(
            "auto-accept-edits",
          );
          expect(
            Array.from(
              document.querySelectorAll<HTMLElement>('[data-slot="menu-radio-item"]'),
            ).find((item) => item.textContent?.includes("Auto-accept edits")),
          ).toHaveAttribute("aria-checked", "true");
        });
        expect(footerShowsAccessMode()).toBe(false);
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows a pointer cursor for the running stop button", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-stop-button-cursor" as MessageId,
          targetText: "stop button cursor target",
          sessionStatus: "running",
        }),
      });

      try {
        const stopButton = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop generation"]'),
          "Unable to find stop generation button.",
        );

        expect(getComputedStyle(stopButton).cursor).toBe("pointer");
      } finally {
        await mounted.cleanup();
      }
    });

    it("hides the archive action when the pointer leaves a thread row", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-archive-hover-test" as MessageId,
          targetText: "archive hover target",
        }),
      });

      try {
        const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);

        await expect.element(threadRow).toBeInTheDocument();
        const archiveButton = await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              `[data-testid="thread-archive-${THREAD_ID}"]`,
            ),
          "Unable to find archive button.",
        );
        const archiveAction = archiveButton.parentElement;
        expect(
          archiveAction,
          "Archive button should render inside a visibility wrapper.",
        ).not.toBeNull();
        await vi.waitFor(
          () => {
            expect(getComputedStyle(archiveAction!).opacity).toBe("0");
          },
          { timeout: 4_000, interval: 16 },
        );

        await threadRow.hover();
        await vi.waitFor(
          () => {
            expect(getComputedStyle(archiveAction!).opacity).toBe("1");
          },
          { timeout: 4_000, interval: 16 },
        );

        await page.getByTestId("composer-editor").hover();
        await vi.waitFor(
          () => {
            expect(getComputedStyle(archiveAction!).opacity).toBe("0");
          },
          { timeout: 4_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("exposes the full thread title on the sidebar row tooltip", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-thread-tooltip-target" as MessageId,
          targetText: "thread tooltip target",
        }),
      });

      try {
        const threadTitle = page.getByTestId(`thread-title-${THREAD_ID}`);

        await expect.element(threadTitle).toBeInTheDocument();
        await threadTitle.hover();

        await vi.waitFor(
          () => {
            const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
            expect(tooltip).not.toBeNull();
            expect(tooltip?.textContent).toContain(THREAD_TITLE);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows the confirm archive action after clicking the archive button", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-archive-confirm-test" as MessageId,
          targetText: "archive confirm target",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            clientSettings: {
              ...nextFixture.serverConfig.clientSettings,
              confirmThreadArchive: true,
            },
          };
        },
      });

      try {
        const threadRow = page.getByTestId(`thread-row-${THREAD_ID}`);

        await expect.element(threadRow).toBeInTheDocument();
        await threadRow.hover();

        const archiveButton = page.getByTestId(`thread-archive-${THREAD_ID}`);
        await expect.element(archiveButton).toBeInTheDocument();
        await archiveButton.click();

        const confirmButton = page.getByTestId(`thread-archive-confirm-${THREAD_ID}`);
        await expect.element(confirmButton).toBeInTheDocument();
        await expect.element(confirmButton).toBeVisible();
      } finally {
        await mounted.cleanup();
      }
    });

    it("canonicalizes promoted draft threads to the server thread route", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-new-thread-test" as MessageId,
          targetText: "new thread selection test",
        }),
      });

      try {
        // Wait for the sidebar to render with the project.
        const newThreadButton = page.getByTestId("new-thread-button");
        await expect.element(newThreadButton).toBeInTheDocument();

        await newThreadButton.click();

        // The route should change to a new draft thread ID.
        const newThreadPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread UUID.",
        );
        const newDraftId = draftIdFromPath(newThreadPath);
        const newThreadId = draftThreadIdFor(newDraftId);

        // The composer editor should be present for the new draft thread.
        await waitForComposerEditor();

        // `thread.created` should only mark the draft as promoting; it should
        // not navigate away until the server thread has actual runtime state.
        await materializePromotedDraftThreadViaDomainEvent(newThreadId);
        expect(mounted.router.state.location.pathname).toBe(newThreadPath);
        await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();

        // Once the server thread starts, the route should canonicalize.
        await startPromotedServerThreadViaDomainEvent(newThreadId);
        await vi.waitFor(
          () => {
            expect(useComposerDraftStore.getState().draftThreadsByThreadKey[newDraftId]).toBe(
              undefined,
            );
          },
          { timeout: 8_000, interval: 16 },
        );

        // The route should switch to the canonical server thread path.
        await waitForURL(
          mounted.router,
          (path) => path === serverThreadPath(newThreadId),
          "Promoted drafts should canonicalize to the server thread route.",
        );

        // The composer should remain usable after canonicalization, regardless of
        // whether the promoted thread is still visibly empty or has already
        // entered the running state.
        await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });

    it("canonicalizes stale promoted draft routes to the server thread route", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-draft-hydration-race-test" as MessageId,
          targetText: "draft hydration race test",
        }),
      });

      try {
        const newThreadButton = page.getByTestId("new-thread-button");
        await expect.element(newThreadButton).toBeInTheDocument();

        await newThreadButton.click();

        const newThreadPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread UUID.",
        );
        const newDraftId = draftIdFromPath(newThreadPath);
        const newThreadId = draftThreadIdFor(newDraftId);

        await promoteDraftThreadViaDomainEvent(newThreadId);

        await mounted.router.navigate({
          to: "/draft/$draftId",
          params: { draftId: newDraftId },
        });

        await waitForURL(
          mounted.router,
          (path) => path === serverThreadPath(newThreadId),
          "Stale promoted draft routes should canonicalize to the server thread path.",
        );

        await expect.element(page.getByTestId("composer-editor")).toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });

    it("creates a fresh worktree draft from an existing worktree thread when the default mode is worktree", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...createSnapshotForTargetUser({
            targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
            targetText: "new thread worktree default test",
          }),
          threads: createSnapshotForTargetUser({
            targetMessageId: "msg-user-new-thread-worktree-default-test" as MessageId,
            targetText: "new thread worktree default test",
          }).threads.map((thread) =>
            thread.id === THREAD_ID
              ? Object.assign({}, thread, {
                  branch: "feature/existing",
                  worktreePath: "/repo/.t3/worktrees/existing",
                })
              : thread,
          ),
        },
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            settings: {
              ...nextFixture.serverConfig.settings,
              defaultThreadEnvMode: "worktree",
            },
          };
        },
      });

      try {
        const newThreadButton = page.getByTestId("new-thread-button");
        await expect.element(newThreadButton).toBeInTheDocument();

        await newThreadButton.click();

        const newThreadPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should change to a new draft thread.",
        );
        const newDraftId = draftIdFromPath(newThreadPath);

        expect(useComposerDraftStore.getState().getDraftSession(newDraftId)).toMatchObject({
          envMode: "worktree",
          worktreePath: null,
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("creates a new draft instead of reusing a promoting draft thread", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-promoting-draft-new-thread-test" as MessageId,
          targetText: "promoting draft new thread test",
        }),
      });

      try {
        const newThreadButton = page.getByTestId("new-thread-button");
        await expect.element(newThreadButton).toBeInTheDocument();

        await newThreadButton.click();

        const firstDraftPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should change to the first draft thread.",
        );
        const firstDraftId = draftIdFromPath(firstDraftPath);
        const firstThreadId = draftThreadIdFor(firstDraftId);

        await materializePromotedDraftThreadViaDomainEvent(firstThreadId);
        expect(mounted.router.state.location.pathname).toBe(firstDraftPath);

        await newThreadButton.click();

        const secondDraftPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path) && path !== firstDraftPath,
          "Route should change to a second draft thread instead of reusing the promoting draft.",
        );
        expect(draftIdFromPath(secondDraftPath)).not.toBe(firstDraftId);
      } finally {
        await mounted.cleanup();
      }
    });

    it("snapshots sticky codex settings into a new draft thread", async () => {
      useComposerDraftStore.setState({
        stickyModelSelectionByProvider: {
          [ProviderInstanceId.make("codex")]: createModelSelection(
            ProviderInstanceId.make("codex"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "medium" },
              { id: "fastMode", value: true },
            ],
          ),
        },
        stickyActiveProvider: ProviderInstanceId.make("codex"),
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-sticky-codex-traits-test" as MessageId,
          targetText: "sticky codex traits test",
        }),
      });

      try {
        const newThreadButton = page.getByTestId("new-thread-button");
        await expect.element(newThreadButton).toBeInTheDocument();

        await newThreadButton.click();

        const newThreadPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread UUID.",
        );
        const newDraftId = draftIdFromPath(newThreadPath);

        // `toMatchObject` matches objects loosely (extras ignored) but compares
        // arrays strictly, so wrap `options` in `arrayContaining` to keep the
        // assertion focused on sticky `fastMode` carrying over without asserting
        // on exactly which other options are preserved.
        expect(composerDraftFor(newDraftId)).toMatchObject({
          modelSelectionByProvider: {
            codex: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.3-codex",
              options: expect.arrayContaining([{ id: "fastMode", value: true }]),
            },
          },
          activeProvider: "codex",
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("hydrates the provider alongside a sticky claude model", async () => {
      useComposerDraftStore.setState({
        stickyModelSelectionByProvider: {
          [ProviderInstanceId.make("claudeAgent")]: createModelSelection(
            ProviderInstanceId.make("claudeAgent"),
            "claude-opus-4-6",
            [
              { id: "effort", value: "max" },
              { id: "fastMode", value: true },
            ],
          ),
        },
        stickyActiveProvider: ProviderInstanceId.make("claudeAgent"),
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-sticky-claude-model-test" as MessageId,
          targetText: "sticky claude model test",
        }),
      });

      try {
        const newThreadButton = page.getByTestId("new-thread-button");
        await expect.element(newThreadButton).toBeInTheDocument();

        await newThreadButton.click();

        const newThreadPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new sticky claude draft thread UUID.",
        );
        const newDraftId = draftIdFromPath(newThreadPath);

        expect(composerDraftFor(newDraftId)).toMatchObject({
          modelSelectionByProvider: {
            claudeAgent: createModelSelection(
              ProviderInstanceId.make("claudeAgent"),
              "claude-opus-4-6",
              [
                { id: "effort", value: "max" },
                { id: "fastMode", value: true },
              ],
            ),
          },
          activeProvider: "claudeAgent",
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("falls back to defaults when no sticky composer settings exist", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-default-codex-traits-test" as MessageId,
          targetText: "default codex traits test",
        }),
      });

      try {
        const newThreadButton = page.getByTestId("new-thread-button");
        await expect.element(newThreadButton).toBeInTheDocument();

        await newThreadButton.click();

        const newThreadPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread UUID.",
        );
        const newDraftId = draftIdFromPath(newThreadPath);

        expect(composerDraftFor(newDraftId)).toBe(undefined);
      } finally {
        await mounted.cleanup();
      }
    });

    it("prefers draft state over sticky composer settings and defaults", async () => {
      useComposerDraftStore.setState({
        stickyModelSelectionByProvider: {
          [ProviderInstanceId.make("codex")]: createModelSelection(
            ProviderInstanceId.make("codex"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "medium" },
              { id: "fastMode", value: true },
            ],
          ),
        },
        stickyActiveProvider: ProviderInstanceId.make("codex"),
      });

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-draft-codex-traits-precedence-test" as MessageId,
          targetText: "draft codex traits precedence test",
        }),
      });

      try {
        const newThreadButton = page.getByTestId("new-thread-button");
        await expect.element(newThreadButton).toBeInTheDocument();

        await newThreadButton.click();

        const threadPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a sticky draft thread UUID.",
        );
        const draftId = draftIdFromPath(threadPath);

        // See the note on the sibling sticky-codex test: arrays match strictly
        // under `toMatchObject`, so use `arrayContaining` to keep the assertion
        // scoped to the sticky trait (`fastMode`) that must carry over.
        expect(composerDraftFor(draftId)).toMatchObject({
          modelSelectionByProvider: {
            codex: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.3-codex",
              options: expect.arrayContaining([{ id: "fastMode", value: true }]),
            },
          },
          activeProvider: "codex",
        });

        useComposerDraftStore.getState().setModelSelection(
          draftId,
          createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
            { id: "reasoningEffort", value: "low" },
            { id: "fastMode", value: true },
          ]),
        );

        await newThreadButton.click();

        await waitForURL(
          mounted.router,
          (path) => path === threadPath,
          "New-thread should reuse the existing project draft thread.",
        );
        expect(composerDraftFor(draftId)).toMatchObject({
          modelSelectionByProvider: {
            codex: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
              { id: "reasoningEffort", value: "low" },
              { id: "fastMode", value: true },
            ]),
          },
          activeProvider: "codex",
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("creates a new thread from the global chat.new shortcut", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-chat-shortcut-test" as MessageId,
          targetText: "chat shortcut test",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "chat.new",
                shortcut: {
                  key: "o",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: true,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
              {
                command: "thread.jump.1",
                shortcut: {
                  key: "1",
                  metaKey: true,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: false,
                },
              },
              {
                command: "modelPicker.jump.1",
                shortcut: {
                  key: "1",
                  metaKey: true,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: false,
                },
                whenAst: { type: "identifier", name: "modelPickerOpen" },
              },
            ],
          };
        },
      });

      try {
        await waitForNewThreadShortcutLabel();
        await waitForServerConfigToApply();
        const composerEditor = await waitForComposerEditor();
        composerEditor.focus();
        await waitForLayout();
        await triggerChatNewShortcutUntilPath(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread UUID from the shortcut.",
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("does not consume chat.new when there is no project context", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createProjectlessSnapshot(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "chat.new",
                shortcut: {
                  key: "o",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: true,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        dispatchChatNewShortcut();
        await waitForLayout();

        expect(mounted.router.state.location.pathname).toBe(serverThreadPath(THREAD_ID));
        expect(Object.keys(useComposerDraftStore.getState().draftThreadsByThreadKey)).toHaveLength(
          0,
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("renders the configurable shortcut and runs a command from the sidebar trigger", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-shortcut-test" as MessageId,
          targetText: "command palette shortcut test",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
      });

      try {
        await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await expect
          .element(palette.getByText("New thread in Project", { exact: true }))
          .toBeInTheDocument();
        await palette.getByText("New thread in Project", { exact: true }).click();

        await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread UUID from the command palette.",
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("filters command palette results as the user types", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-search-test" as MessageId,
          targetText: "command palette search test",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
      });

      try {
        await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await page.getByPlaceholder("Search commands, projects, and threads...").fill("settings");
        await expect
          .element(palette.getByText("Open settings", { exact: true }))
          .toBeInTheDocument();
        await expect
          .element(palette.getByText("New thread in Project", { exact: true }))
          .not.toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });

    it("adds a project from browse mode with Enter when no directory is highlighted", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-add-project-enter" as MessageId,
          targetText: "command palette add project enter",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.filesystemBrowse) {
            if (body.partialPath === "~/Development/") {
              return {
                parentPath: "~/Development/",
                entries: [
                  { name: "alpha", fullPath: "~/Development/alpha" },
                  { name: "beta", fullPath: "~/Development/beta" },
                ],
              };
            }

            return {
              parentPath: "~/",
              entries: [{ name: "Development", fullPath: "~/Development" }],
            };
          }

          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }

          return undefined;
        },
      });

      try {
        await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Add project", { exact: true }).click();
        await palette.getByText("Local folder", { exact: true }).click();

        const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
        await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
        await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

        await expect
          .element(palette.getByRole("button", { name: "Add (Enter)" }))
          .toBeInTheDocument();

        await dispatchInputKey(browseInput, { key: "Enter" });

        await vi.waitFor(
          () => {
            const dispatchRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "project.create",
            ) as
              | {
                  _tag: string;
                  type?: string;
                  workspaceRoot?: string;
                  title?: string;
                }
              | undefined;

            expect(dispatchRequest).toMatchObject({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              type: "project.create",
              workspaceRoot: "~/Development",
              title: "Development",
            });
          },
          { timeout: 8_000, interval: 16 },
        );

        await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread after adding a project with Enter.",
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("hides unavailable source control providers in the add project source picker", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-add-project-source-filter" as MessageId,
          targetText: "command palette add project source filter",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.serverDiscoverSourceControl) {
            return {
              versionControlSystems: [],
              sourceControlProviders: [
                {
                  kind: "github",
                  label: "GitHub",
                  executable: "gh",
                  status: "available",
                  version: Option.some("gh version 2.0.0"),
                  installHint: "Install GitHub CLI.",
                  detail: Option.none(),
                  auth: {
                    status: "authenticated",
                    account: Option.some("cafe"),
                    host: Option.some("github.com"),
                    detail: Option.none(),
                  },
                },
                {
                  kind: "gitlab",
                  label: "GitLab",
                  executable: "glab",
                  status: "missing",
                  version: Option.none(),
                  installHint: "Install GitLab CLI.",
                  detail: Option.none(),
                  auth: {
                    status: "unknown",
                    account: Option.none(),
                    host: Option.none(),
                    detail: Option.none(),
                  },
                },
                {
                  kind: "bitbucket",
                  label: "Bitbucket",
                  executable: "Bitbucket REST API",
                  status: "available",
                  version: Option.none(),
                  installHint: "Set Bitbucket API token environment variables.",
                  detail: Option.none(),
                  auth: {
                    status: "unauthenticated",
                    account: Option.none(),
                    host: Option.some("bitbucket.org"),
                    detail: Option.some("Bitbucket token is not configured."),
                  },
                },
                {
                  kind: "azure-devops",
                  label: "Azure DevOps",
                  executable: "az",
                  status: "missing",
                  version: Option.none(),
                  installHint: "Install Azure CLI.",
                  detail: Option.none(),
                  auth: {
                    status: "unknown",
                    account: Option.none(),
                    host: Option.none(),
                    detail: Option.none(),
                  },
                },
              ],
            };
          }

          return undefined;
        },
      });

      try {
        await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Add project", { exact: true }).click();
        await expect
          .element(palette.getByText("Local folder", { exact: true }))
          .toBeInTheDocument();
        await expect.element(palette.getByText("Git URL", { exact: true })).toBeInTheDocument();
        await expect
          .element(palette.getByText("GitHub repository", { exact: true }))
          .toBeInTheDocument();
        await expect
          .element(palette.getByText("GitLab repository", { exact: true }))
          .not.toBeInTheDocument();
        await expect
          .element(palette.getByText("Bitbucket repository", { exact: true }))
          .not.toBeInTheDocument();
        await expect
          .element(palette.getByText("Azure DevOps repository", { exact: true }))
          .not.toBeInTheDocument();
        await expect
          .element(palette.getByText("Setup Required", { exact: true }))
          .not.toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows clone destination controls after resolving an add project repository", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-add-project-remote" as MessageId,
          targetText: "command palette add project remote",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.filesystemBrowse) {
            if (body.partialPath === "~/Development/") {
              return {
                parentPath: "~/Development",
                entries: [],
              };
            }

            return {
              parentPath: "~/",
              entries: [{ name: "Development", fullPath: "~/Development" }],
            };
          }

          if (body._tag === WS_METHODS.sourceControlLookupRepository) {
            return {
              provider: "github",
              nameWithOwner: "t3-oss/t3-env",
              url: "https://github.com/t3-oss/t3-env",
              sshUrl: "git@github.com:t3-oss/t3-env.git",
            };
          }

          if (body._tag === WS_METHODS.sourceControlCloneRepository) {
            return {
              cwd: body.destinationPath,
              remoteUrl: body.remoteUrl,
              repository: null,
            };
          }

          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }

          return undefined;
        },
      });

      try {
        await Promise.all([waitForServerConfigToApply(), waitForCommandPaletteShortcutLabel()]);
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Add project", { exact: true }).click();
        await palette.getByText("GitHub repository", { exact: true }).click();

        const repositoryInput = await waitForCommandPaletteInput(
          "Enter GitHub repository (owner/repo)",
        );
        await page.getByPlaceholder("Enter GitHub repository (owner/repo)").fill("t3-oss/t3-env");
        await dispatchInputKey(repositoryInput, { key: "Enter" });

        await vi.waitFor(
          () => {
            const clonePathInput = document.querySelector<HTMLInputElement>(
              'input[placeholder="Enter path (e.g. ~/projects/my-app)"]',
            );
            expect(clonePathInput?.value).toBe("~/t3-env");
            expect(document.body.textContent).toContain("Repository");
            expect(document.body.textContent).toContain("t3-oss/t3-env");
            expect(document.body.textContent).toContain("https://github.com/t3-oss/t3-env");
            expect(document.body.textContent).toContain("Select parent folder");
            expect(document.body.textContent).toContain("Clone");
          },
          { timeout: 8_000, interval: 16 },
        );

        await page.getByPlaceholder("Enter path (e.g. ~/projects/my-app)").fill("~/Development/");
        const clonePathInput = await waitForCommandPaletteInput(
          "Enter path (e.g. ~/projects/my-app)",
        );
        await dispatchInputKey(clonePathInput, { key: "Enter" });

        await vi.waitFor(
          () => {
            const cloneRequest = wsRequests.find(
              (request) => request._tag === WS_METHODS.sourceControlCloneRepository,
            ) as { destinationPath?: string; remoteUrl?: string } | undefined;
            expect(cloneRequest).toMatchObject({
              remoteUrl: "git@github.com:t3-oss/t3-env.git",
              destinationPath: "~/Development/t3-env",
            });
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("opens add project browse mode from the sidebar add button", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-sidebar-add-project-trigger" as MessageId,
          targetText: "sidebar add project trigger",
        }),
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.filesystemBrowse) {
            return {
              parentPath: "~/",
              entries: [{ name: "Development", fullPath: "~/Development" }],
            };
          }

          return undefined;
        },
      });

      try {
        await waitForServerConfigToApply();

        await page.getByTestId("sidebar-add-project-trigger").click();

        const palette = page.getByTestId("command-palette");
        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Local folder", { exact: true }).click();

        const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
        await expect.element(browseInput).toHaveValue("~/");

        await vi.waitFor(
          () => {
            expect(
              wsRequests.some(
                (request) =>
                  request._tag === WS_METHODS.filesystemBrowse && request.partialPath === "~/",
              ),
            ).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("starts add project browse mode from the configured base directory", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-sidebar-add-project-custom-base-dir" as MessageId,
          targetText: "sidebar add project custom base directory",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            settings: {
              ...nextFixture.serverConfig.settings,
              addProjectBaseDirectory: "~/Development",
            },
          };
        },
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.filesystemBrowse) {
            if (body.partialPath === "~/Development/") {
              return {
                parentPath: "~/Development/",
                entries: [{ name: "codething", fullPath: "~/Development/codething" }],
              };
            }

            return {
              parentPath: "~/",
              entries: [{ name: "Development", fullPath: "~/Development" }],
            };
          }

          return undefined;
        },
      });

      try {
        await waitForServerConfigToApply();

        await page.getByTestId("sidebar-add-project-trigger").click();

        const palette = page.getByTestId("command-palette");
        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Local folder", { exact: true }).click();

        const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
        await expect.element(browseInput).toHaveValue("~/Development/");

        await vi.waitFor(
          () => {
            expect(
              wsRequests.some(
                (request) =>
                  request._tag === WS_METHODS.filesystemBrowse &&
                  request.partialPath === "~/Development/",
              ),
            ).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("shows create-folder affordances for missing project paths", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-create-missing-project" as MessageId,
          targetText: "command palette create missing project",
        }),
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.filesystemBrowse) {
            if (body.partialPath === "~/Desktop/") {
              return {
                parentPath: "~/Desktop/",
                entries: [{ name: "existing", fullPath: "~/Desktop/existing" }],
              };
            }

            return {
              parentPath: "~/",
              entries: [{ name: "Desktop", fullPath: "~/Desktop" }],
            };
          }

          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }

          return undefined;
        },
      });

      try {
        await waitForServerConfigToApply();
        const palette = page.getByTestId("command-palette");
        await page.getByTestId("sidebar-add-project-trigger").click();

        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Local folder", { exact: true }).click();
        const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
        await page
          .getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER)
          .fill("~/Desktop/fresh-project");

        await expect
          .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
          .toBeInTheDocument();
        await expect.element(palette.getByText("Will create this folder")).not.toBeInTheDocument();

        await dispatchInputKey(browseInput, { key: "Enter" });

        await vi.waitFor(
          () => {
            const dispatchRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "project.create",
            ) as
              | {
                  _tag: string;
                  type?: string;
                  workspaceRoot?: string;
                  title?: string;
                  createWorkspaceRootIfMissing?: boolean;
                }
              | undefined;

            expect(dispatchRequest).toMatchObject({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              type: "project.create",
              workspaceRoot: "~/Desktop/fresh-project",
              title: "fresh-project",
              createWorkspaceRootIfMissing: true,
            });
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("does not show create affordances for an existing directory with a trailing slash", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-existing-trailing-directory" as MessageId,
          targetText: "command palette existing trailing directory",
        }),
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.filesystemBrowse) {
            if (body.partialPath === "~/Development/codex/") {
              return {
                parentPath: "~/Development/codex/",
                entries: [{ name: "Codex.app", fullPath: "~/Development/codex/Codex.app" }],
              };
            }

            return {
              parentPath: "~/",
              entries: [{ name: "Development", fullPath: "~/Development" }],
            };
          }

          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }

          return undefined;
        },
      });

      try {
        await waitForServerConfigToApply();
        const palette = page.getByTestId("command-palette");
        await page.getByTestId("sidebar-add-project-trigger").click();

        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Local folder", { exact: true }).click();
        const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
        await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/codex/");

        await vi.waitFor(
          () => {
            expect(
              wsRequests.some(
                (request) =>
                  request._tag === WS_METHODS.filesystemBrowse &&
                  request.partialPath === "~/Development/codex/",
              ),
            ).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );

        await expect
          .element(palette.getByRole("button", { name: "Add (Enter)" }))
          .toBeInTheDocument();
        await expect
          .element(palette.getByRole("button", { name: "Create & Add (Enter)" }))
          .not.toBeInTheDocument();

        await dispatchInputKey(browseInput, { key: "Enter" });

        await vi.waitFor(
          () => {
            const dispatchRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "project.create",
            ) as
              | {
                  _tag: string;
                  type?: string;
                  workspaceRoot?: string;
                  title?: string;
                }
              | undefined;

            expect(dispatchRequest).toMatchObject({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              type: "project.create",
              workspaceRoot: "~/Development/codex",
              title: "codex",
            });
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("picks a local project from the native file manager", async () => {
      const pickFolder = vi.fn().mockResolvedValue("/Users/julius/Projects/finder-picked");

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-add-project-file-manager" as MessageId,
          targetText: "command palette add project file manager",
        }),
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.filesystemBrowse) {
            if (body.partialPath === "~/Applications/") {
              return {
                parentPath: "~/Applications/",
                entries: [{ name: "Utilities", fullPath: "~/Applications/Utilities" }],
              };
            }

            return {
              parentPath: "~/",
              entries: [{ name: "Applications", fullPath: "~/Applications" }],
            };
          }

          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }

          return undefined;
        },
      });

      try {
        await waitForServerConfigToApply();
        window.desktopBridge = {
          pickFolder,
          setTheme: vi.fn().mockResolvedValue(undefined),
        } as unknown as NonNullable<typeof window.desktopBridge>;

        await page.getByTestId("sidebar-add-project-trigger").click();

        const palette = page.getByTestId("command-palette");
        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Local folder", { exact: true }).click();
        const browseInput = palette.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER);
        await browseInput.fill("~/Applications/access");

        const fileManagerLabel = isMacPlatform(navigator.platform)
          ? "Open in Finder"
          : navigator.platform.toLowerCase().startsWith("win")
            ? "Open in Explorer"
            : "Open in Files";
        await palette.getByRole("button", { name: fileManagerLabel }).click();

        await vi.waitFor(
          () => {
            expect(pickFolder).toHaveBeenCalledWith({ initialPath: "~/Applications" });
          },
          { timeout: 8_000, interval: 16 },
        );

        await vi.waitFor(
          () => {
            const dispatchRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "project.create",
            ) as
              | {
                  _tag: string;
                  type?: string;
                  workspaceRoot?: string;
                  title?: string;
                }
              | undefined;

            expect(dispatchRequest).toMatchObject({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              type: "project.create",
              workspaceRoot: "/Users/julius/Projects/finder-picked",
              title: "finder-picked",
            });
          },
          { timeout: 8_000, interval: 16 },
        );

        await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread after adding a project from the native file manager.",
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("adds a project from browse mode with Mod+Enter when a directory is highlighted", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-palette-add-project-mod-enter" as MessageId,
          targetText: "command palette add project mod enter",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
        resolveRpc: (body) => {
          if (body._tag === WS_METHODS.filesystemBrowse) {
            if (body.partialPath === "~/Development/") {
              return {
                parentPath: "~/Development/",
                entries: [
                  { name: "alpha", fullPath: "~/Development/alpha" },
                  { name: "beta", fullPath: "~/Development/beta" },
                ],
              };
            }

            return {
              parentPath: "~/",
              entries: [{ name: "Development", fullPath: "~/Development" }],
            };
          }

          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }

          return undefined;
        },
      });

      try {
        await waitForServerConfigToApply();
        await waitForCommandPaletteShortcutLabel();
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await palette.getByText("Add project", { exact: true }).click();
        await palette.getByText("Local folder", { exact: true }).click();

        const browseInput = await waitForCommandPaletteInput(ADD_PROJECT_SUBMENU_PLACEHOLDER);
        await page.getByPlaceholder(ADD_PROJECT_SUBMENU_PLACEHOLDER).fill("~/Development/");
        await expect.element(palette.getByText("alpha", { exact: true })).toBeInTheDocument();

        await dispatchInputKey(browseInput, { key: "ArrowDown" });

        const addButtonLabel = isMacPlatform(navigator.platform)
          ? "Add (\u2318 Enter)"
          : "Add (Ctrl Enter)";
        await vi.waitFor(
          () => {
            const legendEntries = getCommandPaletteLegendEntries();
            expect(legendEntries).toContain("Enter Select");
          },
          { timeout: 8_000, interval: 16 },
        );
        await expect
          .element(palette.getByRole("button", { name: addButtonLabel }))
          .toBeInTheDocument();

        await dispatchInputKey(browseInput, {
          key: "Enter",
          metaKey: isMacPlatform(navigator.platform),
          ctrlKey: !isMacPlatform(navigator.platform),
        });

        await vi.waitFor(
          () => {
            const dispatchRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "project.create",
            ) as
              | {
                  _tag: string;
                  type?: string;
                  workspaceRoot?: string;
                  title?: string;
                }
              | undefined;

            expect(dispatchRequest).toMatchObject({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              type: "project.create",
              workspaceRoot: "~/Development",
              title: "Development",
            });
          },
          { timeout: 8_000, interval: 16 },
        );

        await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread after adding a project with Mod+Enter.",
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps project-context thread matches available when searching by project name", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithSecondaryProject(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        await waitForCommandPaletteShortcutLabel();
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await page.getByPlaceholder("Search commands, projects, and threads...").fill("docs");
        await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
        await expect
          .element(palette.getByText("Release checklist", { exact: true }))
          .toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });

    it("searches projects by path and opens the latest thread for that project", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithSecondaryProject(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            settings: {
              ...nextFixture.serverConfig.settings,
              defaultThreadEnvMode: "worktree",
            },
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        await waitForCommandPaletteShortcutLabel();
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await page
          .getByPlaceholder("Search commands, projects, and threads...")
          .fill("clients/docs");
        await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
        await expect
          .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
          .toBeInTheDocument();
        await palette.getByText("Docs Portal", { exact: true }).click();

        const nextPath = await waitForURL(
          mounted.router,
          (path) => path === serverThreadPath("thread-secondary-project" as ThreadId),
          "Route should have changed to the latest thread for the selected project.",
        );
        expect(nextPath).toBe(serverThreadPath("thread-secondary-project" as ThreadId));
        expect(
          useComposerDraftStore
            .getState()
            .getDraftThread(threadRefFor("thread-secondary-project" as ThreadId)),
        ).toBeNull();
      } finally {
        await mounted.cleanup();
      }
    });

    it("creates a new thread from project search when no active project thread exists", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithSecondaryProject({ includeSecondaryThread: false }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            settings: {
              ...nextFixture.serverConfig.settings,
              defaultThreadEnvMode: "worktree",
            },
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        await waitForCommandPaletteShortcutLabel();
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await page
          .getByPlaceholder("Search commands, projects, and threads...")
          .fill("clients/docs");
        await expect.element(palette.getByText("Docs Portal", { exact: true })).toBeInTheDocument();
        await expect
          .element(palette.getByText("/repo/clients/docs-portal", { exact: true }))
          .toBeInTheDocument();
        await palette.getByText("Docs Portal", { exact: true }).click();

        const nextPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a new draft thread UUID from the project search result.",
        );
        const nextDraftId = draftIdFromPath(nextPath);
        const draftThread = useComposerDraftStore.getState().getDraftSession(nextDraftId);
        expect(draftThread?.projectId).toBe(SECOND_PROJECT_ID);
        expect(draftThread?.envMode).toBe("worktree");
      } finally {
        await mounted.cleanup();
      }
    });

    it("filters archived threads out of command palette search results", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithSecondaryProject(),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "commandPalette.toggle",
                shortcut: {
                  key: "k",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: false,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        await waitForCommandPaletteShortcutLabel();
        const palette = page.getByTestId("command-palette");
        await openCommandPaletteFromTrigger();

        await expect.element(palette).toBeInTheDocument();
        await page
          .getByPlaceholder("Search commands, projects, and threads...")
          .fill("docs-archive");
        await expect
          .element(palette.getByText("Archived Docs Notes", { exact: true }))
          .not.toBeInTheDocument();
      } finally {
        await mounted.cleanup();
      }
    });

    it("creates a fresh draft after the previous draft thread is promoted", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-promoted-draft-shortcut-test" as MessageId,
          targetText: "promoted draft shortcut test",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "chat.new",
                shortcut: {
                  key: "o",
                  metaKey: false,
                  ctrlKey: false,
                  shiftKey: true,
                  altKey: false,
                  modKey: true,
                },
                whenAst: {
                  type: "not",
                  node: { type: "identifier", name: "modelPickerOpen" },
                },
              },
            ],
          };
        },
      });

      try {
        const newThreadButton = page.getByTestId("new-thread-button");
        await expect.element(newThreadButton).toBeInTheDocument();
        await waitForServerConfigToApply();
        await newThreadButton.click();

        const promotedThreadPath = await waitForURL(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path),
          "Route should have changed to a promoted draft thread UUID.",
        );
        const promotedDraftId = draftIdFromPath(promotedThreadPath);
        const promotedThreadId = draftThreadIdFor(promotedDraftId);

        await promoteDraftThreadViaDomainEvent(promotedThreadId);
        await waitForURL(
          mounted.router,
          (path) => path === serverThreadPath(promotedThreadId),
          "Promoted drafts should canonicalize to the server thread route before a fresh draft is created.",
        );
        await vi.waitFor(
          () => {
            expect(useComposerDraftStore.getState().getDraftThread(promotedDraftId)).toBeNull();
          },
          { timeout: 8_000, interval: 16 },
        );
        const composerEditor = await waitForComposerEditor();
        composerEditor.focus();
        await waitForLayout();

        const freshThreadPath = await triggerChatNewShortcutUntilPath(
          mounted.router,
          (path) => UUID_ROUTE_RE.test(path) && path !== promotedThreadPath,
          "Shortcut should create a fresh draft instead of reusing the promoted thread.",
        );
        expect(freshThreadPath).not.toBe(promotedThreadPath);
      } finally {
        await mounted.cleanup();
      }
    });
  }

  if (chatViewBrowserPart === "layout") {
    it("keeps long proposed plans lightweight until the user expands them", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithLongProposedPlan(),
      });

      try {
        await waitForElement(
          () =>
            Array.from(document.querySelectorAll("button")).find(
              (button) => button.textContent?.trim() === "Expand plan",
            ) as HTMLButtonElement | null,
          "Unable to find Expand plan button.",
        );

        expect(document.body.textContent).not.toContain("deep hidden detail only after expand");

        const expandButton = await waitForElement(
          () =>
            Array.from(document.querySelectorAll("button")).find(
              (button) => button.textContent?.trim() === "Expand plan",
            ) as HTMLButtonElement | null,
          "Unable to find Expand plan button.",
        );
        expandButton.click();

        await vi.waitFor(
          () => {
            expect(document.body.textContent).toContain("deep hidden detail only after expand");
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("uses the active worktree path when saving a proposed plan to the workspace", async () => {
      const snapshot = createSnapshotWithLongProposedPlan();
      const threads = snapshot.threads.slice();
      const targetThreadIndex = threads.findIndex((thread) => thread.id === THREAD_ID);
      const targetThread = targetThreadIndex >= 0 ? threads[targetThreadIndex] : undefined;
      if (targetThread) {
        threads[targetThreadIndex] = {
          ...targetThread,
          worktreePath: "/repo/worktrees/plan-thread",
        };
      }

      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          threads,
        },
      });

      try {
        const planActionsButton = await waitForElement(
          () => document.querySelector<HTMLButtonElement>('button[aria-label="Plan actions"]'),
          "Unable to find proposed plan actions button.",
        );
        planActionsButton.click();

        const saveToWorkspaceItem = await waitForElement(
          () =>
            (Array.from(document.querySelectorAll('[data-slot="menu-item"]')).find(
              (item) => item.textContent?.trim() === "Save to workspace",
            ) ?? null) as HTMLElement | null,
          'Unable to find "Save to workspace" menu item.',
        );
        saveToWorkspaceItem.click();

        await vi.waitFor(
          () => {
            expect(document.body.textContent).toContain(
              "Enter a path relative to /repo/worktrees/plan-thread.",
            );
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps pending-question footer actions inside the composer after a real resize", async () => {
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: createSnapshotWithPendingUserInput(),
      });

      try {
        const firstOption = await waitForButtonContainingText("Tight");
        firstOption.click();

        await waitForButtonByText("Previous");
        await waitForButtonByText("Submit answers");

        await mounted.setContainerSize(COMPACT_FOOTER_VIEWPORT);
        await expectComposerActionsContained();
      } finally {
        await mounted.cleanup();
      }
    });

    it("submits pending user input after the final option selection resolves the draft answers", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotWithPendingUserInput(),
        resolveRpc: (body) => {
          if (body._tag === ORCHESTRATION_WS_METHODS.dispatchCommand) {
            return {
              sequence: fixture.snapshot.snapshotSequence + 1,
            };
          }
          return undefined;
        },
      });

      try {
        const firstOption = await waitForButtonContainingText("Tight");
        firstOption.click();

        const finalOption = await waitForButtonContainingText("Conservative");
        finalOption.click();

        await vi.waitFor(
          () => {
            const dispatchRequest = wsRequests.find(
              (request) =>
                request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
                request.type === "thread.user-input.respond",
            ) as
              | {
                  _tag: string;
                  type?: string;
                  requestId?: string;
                  answers?: Record<string, unknown>;
                }
              | undefined;

            expect(dispatchRequest).toMatchObject({
              _tag: ORCHESTRATION_WS_METHODS.dispatchCommand,
              type: "thread.user-input.respond",
              requestId: "req-browser-user-input",
              answers: {
                scope: "Tight",
                risk: "Conservative",
              },
            });
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps plan follow-up footer actions fused and aligned after a real resize", async () => {
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: createSnapshotWithPlanFollowUpPrompt(),
      });

      try {
        const footer = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-chat-composer-footer="true"]'),
          "Unable to find composer footer.",
        );
        const initialModelPicker = await waitForElement(
          findComposerProviderModelPicker,
          "Unable to find provider model picker.",
        );
        const initialModelPickerOffset =
          initialModelPicker.getBoundingClientRect().left - footer.getBoundingClientRect().left;
        const initialImplementButton = await waitForButtonByText("Implement");
        const initialImplementWidth = initialImplementButton.getBoundingClientRect().width;

        await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              'button[aria-label="Implementation actions"]',
            ),
          "Unable to find implementation actions trigger.",
        );

        await mounted.setContainerSize({
          width: 440,
          height: WIDE_FOOTER_VIEWPORT.height,
        });
        await expectComposerActionsContained();

        const implementButton = await waitForButtonByText("Implement");
        const implementActionsButton = await waitForElement(
          () =>
            document.querySelector<HTMLButtonElement>(
              'button[aria-label="Implementation actions"]',
            ),
          "Unable to find implementation actions trigger.",
        );

        await vi.waitFor(
          () => {
            const implementRect = implementButton.getBoundingClientRect();
            const implementActionsRect = implementActionsButton.getBoundingClientRect();
            const compactModelPicker = findComposerProviderModelPicker();
            expect(compactModelPicker).toBeTruthy();

            const compactModelPickerOffset =
              compactModelPicker!.getBoundingClientRect().left -
              footer.getBoundingClientRect().left;

            expect(Math.abs(implementRect.right - implementActionsRect.left)).toBeLessThanOrEqual(
              1,
            );
            expect(Math.abs(implementRect.top - implementActionsRect.top)).toBeLessThanOrEqual(1);
            expect(Math.abs(implementRect.width - initialImplementWidth)).toBeLessThanOrEqual(1);
            expect(
              Math.abs(compactModelPickerOffset - initialModelPickerOffset),
            ).toBeLessThanOrEqual(1);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps the wide desktop follow-up layout expanded when the footer still fits", async () => {
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: createSnapshotWithPlanFollowUpPrompt({
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex-spark",
          },
          planMarkdown:
            "# Imaginary Long-Range Plan: Cafe Code Adaptive Orchestration and Safe-Delay Execution Initiative",
        }),
        // This case isolates composer-width behavior. Authored plans are
        // allowed to auto-open their document sidebar, which intentionally
        // narrows the chat column and is covered by the plan-specific tests.
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            clientSettings: {
              ...nextFixture.serverConfig.clientSettings,
              autoOpenPlanSidebar: false,
            },
          };
        },
      });

      try {
        await waitForButtonByText("Implement");

        await vi.waitFor(
          () => {
            const footer = document.querySelector<HTMLElement>(
              '[data-chat-composer-footer="true"]',
            );
            const actions = document.querySelector<HTMLElement>(
              '[data-chat-composer-actions="right"]',
            );

            expect(footer?.dataset.chatComposerFooterCompact).toBe("false");
            expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("false");
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("compacts the footer when a wide desktop follow-up layout starts overflowing", async () => {
      const mounted = await mountChatView({
        viewport: WIDE_FOOTER_VIEWPORT,
        snapshot: createSnapshotWithPlanFollowUpPrompt({
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.3-codex-spark",
          },
          planMarkdown:
            "# Imaginary Long-Range Plan: Cafe Code Adaptive Orchestration and Safe-Delay Execution Initiative",
        }),
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            clientSettings: {
              ...nextFixture.serverConfig.clientSettings,
              autoOpenPlanSidebar: false,
            },
          };
        },
      });

      try {
        await waitForButtonByText("Implement");

        await mounted.setContainerSize({
          width: 804,
          height: WIDE_FOOTER_VIEWPORT.height,
        });

        await expectComposerActionsContained();

        await vi.waitFor(
          () => {
            const footer = document.querySelector<HTMLElement>(
              '[data-chat-composer-footer="true"]',
            );
            const actions = document.querySelector<HTMLElement>(
              '[data-chat-composer-actions="right"]',
            );

            expect(footer?.dataset.chatComposerFooterCompact).toBe("true");
            expect(actions?.dataset.chatComposerPrimaryActionsCompact).toBe("true");
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("keeps the slash-command menu visible above the composer", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-command-menu-target" as MessageId,
          targetText: "command menu thread",
        }),
      });

      try {
        await waitForComposerEditor();
        await page.getByTestId("composer-editor").fill("/");

        const menuItem = await waitForComposerMenuItem("slash:model");
        const composerForm = await waitForElement(
          () => document.querySelector<HTMLElement>('[data-chat-composer-form="true"]'),
          "Unable to find composer form.",
        );

        await vi.waitFor(
          () => {
            const menuRect = menuItem.getBoundingClientRect();
            const composerRect = composerForm.getBoundingClientRect();
            const hitTarget = document.elementFromPoint(
              menuRect.left + menuRect.width / 2,
              menuRect.top + menuRect.height / 2,
            );

            expect(menuRect.width).toBeGreaterThan(0);
            expect(menuRect.height).toBeGreaterThan(0);
            expect(menuRect.bottom).toBeLessThanOrEqual(composerRect.bottom);
            expect(hitTarget instanceof Element && menuItem.contains(hitTarget)).toBe(true);
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });

    it("opens the model picker when selecting /model", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-model-command-target" as MessageId,
          targetText: "model command thread",
        }),
      });

      try {
        await waitForComposerEditor();
        await page.getByTestId("composer-editor").fill("/mod");

        const menuItem = await waitForComposerMenuItem("slash:model");
        await menuItem.click();

        await vi.waitFor(() => {
          expect(document.querySelector(".model-picker-list")).not.toBeNull();
          expect(findComposerProviderModelPicker()?.textContent).not.toContain("/model");
        });

        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
          });
        });

        await vi.waitFor(() => {
          const searchInput = document.querySelector<HTMLInputElement>(
            'input[placeholder="Search models..."]',
          );
          expect(searchInput).not.toBeNull();
          expect(document.activeElement).toBe(searchInput);
        });
      } finally {
        await mounted.cleanup();
      }
    });

    it("toggles the model picker and shows jump keys immediately from the shortcut", async () => {
      const snapshot = createSnapshotForTargetUser({
        targetMessageId: "msg-user-model-picker-shortcut-target" as MessageId,
        targetText: "model picker shortcut thread",
      });
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: {
          ...snapshot,
          projects: snapshot.projects.map((project) =>
            project.id === PROJECT_ID
              ? Object.assign({}, project, {
                  defaultModelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5.4",
                  },
                })
              : project,
          ),
          threads: snapshot.threads.map((thread) =>
            thread.id === THREAD_ID
              ? Object.assign({}, thread, {
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5.4",
                  },
                })
              : thread,
          ),
        },
        configureFixture: (nextFixture) => {
          nextFixture.serverConfig = {
            ...nextFixture.serverConfig,
            keybindings: [
              {
                command: "modelPicker.toggle",
                shortcut: {
                  key: "m",
                  metaKey: false,
                  ctrlKey: true,
                  shiftKey: true,
                  altKey: false,
                  modKey: false,
                },
              },
              {
                command: "thread.jump.1",
                shortcut: {
                  key: "1",
                  metaKey: false,
                  ctrlKey: true,
                  shiftKey: false,
                  altKey: false,
                  modKey: false,
                },
              },
              {
                command: "modelPicker.jump.1",
                shortcut: {
                  key: "1",
                  metaKey: false,
                  ctrlKey: true,
                  shiftKey: false,
                  altKey: false,
                  modKey: false,
                },
                whenAst: { type: "identifier", name: "modelPickerOpen" },
              },
            ],
            providers: [
              {
                ...nextFixture.serverConfig.providers[0]!,
                models: [
                  {
                    slug: "gpt-5.1-codex-max",
                    name: "GPT-5.1 Codex Max",
                    isCustom: false,
                    capabilities: createModelCapabilities({
                      optionDescriptors: [
                        { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                      ],
                    }),
                  },
                  {
                    slug: "gpt-5.3-codex",
                    name: "GPT-5.3 Codex",
                    isCustom: false,
                    capabilities: createModelCapabilities({
                      optionDescriptors: [
                        { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                      ],
                    }),
                  },
                  {
                    slug: "gpt-5.4",
                    name: "GPT-5.4",
                    isCustom: false,
                    capabilities: createModelCapabilities({
                      optionDescriptors: [
                        { id: "fastMode", label: "Fast Mode", type: "boolean" as const },
                      ],
                    }),
                  },
                ],
              },
            ],
          };
        },
      });

      try {
        await waitForServerConfigToApply();
        await waitForComposerEditor();

        const initialPath = mounted.router.state.location.pathname;
        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "m",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );

        await vi.waitFor(() => {
          expect(document.querySelector(".model-picker-list")).not.toBeNull();
        });

        const jumpLabel = isMacPlatform(navigator.platform) ? "⌃1" : "Ctrl+1";
        await vi.waitFor(() => {
          expect(
            Array.from(
              document.querySelectorAll<HTMLElement>('.model-picker-list [data-slot="kbd"]'),
            ).some((element) => element.textContent?.trim() === jumpLabel),
          ).toBe(true);
        });
        expect(mounted.router.state.location.pathname).toBe(initialPath);

        window.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "m",
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );

        await vi.waitFor(() => {
          expect(document.querySelector(".model-picker-list")).toBeNull();
        });
      } finally {
        releaseModShortcut("Control");
        await mounted.cleanup();
      }
    });

    it("shows a tooltip with the skill description when hovering a skill pill", async () => {
      const mounted = await mountChatView({
        viewport: DEFAULT_VIEWPORT,
        snapshot: createSnapshotForTargetUser({
          targetMessageId: "msg-user-skill-tooltip-target" as MessageId,
          targetText: "skill tooltip thread",
        }),
        configureFixture: (nextFixture) => {
          const provider = nextFixture.serverConfig.providers[0];
          if (!provider) {
            throw new Error("Expected default provider in test fixture.");
          }
          (
            provider as {
              skills: ServerConfig["providers"][number]["skills"];
            }
          ).skills = [
            {
              name: "agent-browser",
              displayName: "Agent Browser",
              description: "Open pages, click around, and inspect web apps.",
              path: "/Users/test/.agents/skills/agent-browser/SKILL.md",
              enabled: true,
            },
          ];
        },
      });

      try {
        useComposerDraftStore.getState().setPrompt(THREAD_REF, "use the $agent-browser ");
        await waitForComposerText("use the $agent-browser ");

        await waitForElement(
          () => document.querySelector<HTMLElement>('[data-composer-skill-chip="true"]'),
          "Unable to find rendered composer skill chip.",
        );
        await page.getByText("Agent Browser").hover();

        await vi.waitFor(
          () => {
            const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
            expect(tooltip).not.toBeNull();
            expect(tooltip?.textContent).toContain(
              "Open pages, click around, and inspect web apps.",
            );
          },
          { timeout: 8_000, interval: 16 },
        );
      } finally {
        await mounted.cleanup();
      }
    });
  }
});
