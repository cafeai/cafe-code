import { createChatViewSnapshots } from "./ChatViewSnapshots.fixture";
import { createChatViewFixtureRetirement } from "./chatViewFixtureRetirement.test.fixture";
import "../index.css";
import { scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import {
  DEFAULT_SERVER_SETTINGS,
  type DesktopBridge,
  type DesktopSourceUpdateState,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationReadModel,
  OrchestrationSessionStatus,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerConfig,
  ServerConfig as ServerConfigSchema,
  type ServerLifecycleWelcomePayload,
  ThreadId,
  TurnId,
  WS_METHODS,
} from "@cafecode/contracts";
import { createMemoryHistory, RouterProvider } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { http, HttpResponse, ws } from "msw";
import { setupWorker } from "msw/browser";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { type Locator, locators, page, userEvent } from "vitest/browser";
import { createAuthenticatedSessionHandlers } from "../../test/authHttpHandlers";
import { BrowserWsRpcHarness, type NormalizedWsRpcRequestBody } from "../../test/wsRpcHarness";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { showContextMenuFallback } from "../contextMenuFallback";
import { createDeskState } from "../deskModel";
import { useDeskStore } from "../deskStore";
import { __resetEnvironmentApiOverridesForTests } from "../environmentApi";
import { resetSourceControlDiscoveryStateForTests } from "../lib/sourceControlDiscoveryState";
import { isMacPlatform } from "../lib/utils";
import { __resetLocalApiForTests } from "../localApi";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { getRouter } from "../router";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { getServerConfig } from "../rpc/serverState";
import { selectBootstrapCompleteForActiveEnvironment, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTaskAtriumStore } from "./atrium/taskAtriumStore";
import { DEFAULT_CLIENT_SETTINGS } from "@cafecode/contracts/settings";

declare module "vitest/browser" {
  interface LocatorSelectors {
    getByTimelineMessageId(messageId: MessageId): Locator;
  }
}

// A generated element locator may use text or row position, both of which can
// change while a virtualized timeline settles. Keep fixture interactions bound
// to their explicit message identity through asynchronous browser actions.
locators.extend({
  getByTimelineMessageId(messageId) {
    return `css=[data-message-id="${CSS.escape(messageId)}"]`;
  },
});

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
const scopedFixtureRetirement = createChatViewFixtureRetirement();
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
      capabilities: { repositoryIdentity: true, standaloneChats: true },
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
  /** Policy-only journeys retain the exact target and tail pairs, not filler history. */
  history?: "full" | "essential";
}): OrchestrationReadModel {
  const provider = ProviderDriverKind.make(options.provider ?? "codex");
  const instanceId = ProviderInstanceId.make(options.provider ?? "codex");
  const model = provider === "claudeAgent" ? "claude-opus-4-8" : "gpt-5";
  const runtimeMode = options.runtimeMode ?? "full-access";
  const targetPairIndex = 3;
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === targetPairIndex;
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

  // Keep the original message objects, identities, chronological order and
  // timestamps. Filtering also deduplicates naturally if target and tail meet.
  // Full history remains the default for layout, scrolling and history tests.
  const retainedMessages =
    options.history === "essential"
      ? messages.filter(
          (_message, index) =>
            (index >= targetPairIndex * 2 && index < targetPairIndex * 2 + 2) ||
            index >= messages.length - 2,
        )
      : messages;

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
        messages: retainedMessages,
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
        capabilities: { repositoryIdentity: true, standaloneChats: true },
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
    ...(thread.subagentLimits !== undefined ? { subagentLimits: thread.subagentLimits } : {}),
    ...(thread.codexContextWindowOverride !== undefined
      ? { codexContextWindowOverride: thread.codexContextWindowOverride }
      : {}),
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
export type ChatViewSnapshotSources = {
  createSnapshotForTargetUser: typeof createSnapshotForTargetUser;
  THREAD_ID: typeof THREAD_ID;
  isoAt: typeof isoAt;
  RUNTIME_TASK_STEPS: typeof RUNTIME_TASK_STEPS;
  RUNTIME_TASK_TURN_ID: typeof RUNTIME_TASK_TURN_ID;
  SUBAGENT_RUNTIME_ID: typeof SUBAGENT_RUNTIME_ID;
  SECOND_PROJECT_ID: typeof SECOND_PROJECT_ID;
  ARCHIVED_SECONDARY_THREAD_ID: typeof ARCHIVED_SECONDARY_THREAD_ID;
  NOW_ISO: typeof NOW_ISO;
  PROJECT_ID: typeof PROJECT_ID;
};

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

export type RuntimeTaskStep = {
  readonly step: string;
  readonly status: "completed" | "inProgress" | "pending";
};

const RUNTIME_TASK_STEPS: ReadonlyArray<RuntimeTaskStep> = RUNTIME_TASK_DESCRIPTIONS.map(
  (step, index) => ({
    step,
    status: index < 4 ? "completed" : index === 4 ? "inProgress" : "pending",
  }),
);

// Live child fixtures model evidence from one actual provider runtime, rather
// than persisted task history alone. Reuse this identity on the session, child
// lifecycle edges, and their terminal updates just as the native bridge does.
const SUBAGENT_RUNTIME_ID = "b73284bf-01be-4dbf-94c8-b54e54f17801";

function resolveWsRpc(body: NormalizedWsRpcRequestBody): unknown {
  const customResult = customWsRpcResolver?.(body);
  if (customResult !== undefined) {
    return customResult;
  }
  const tag = body._tag;
  if (tag === WS_METHODS.serverGetConfig) {
    return encodeServerConfig(fixture.serverConfig);
  }
  if (tag === WS_METHODS.scheduledFollowupsList) {
    return { schedules: [], backendOnline: true };
  }
  if (tag === WS_METHODS.visualizationsList) {
    // Chat fixtures contain no admitted artifact publications. This exact
    // empty namespace response does not fake a host, source or native proof.
    return { entries: [] };
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

function editButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Edit queued message"]');
}

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text,
  );
}

function queuedSendButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>(".cafe-followup-steer-button"));
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

function findSendFailureToastTitle(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')).find(
      (element) => element.textContent?.trim() === "Message was not sent",
    ) ?? null
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

function findSessionRail(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-session-rail="true"]');
}

function expectEmptyScheduledSessionRailTasks(): void {
  // A server chat keeps Scheduled available when its current work retires.
  // Scope this assertion to the task container so unrelated rail usage text
  // cannot satisfy it, and prove no stale active rows or extra placeholder stay.
  const tasks = findSessionRail()?.querySelector<HTMLElement>('[data-session-rail-tasks="true"]');
  const scheduled = tasks?.querySelector<HTMLElement>('[data-scheduled-followups="true"]');
  expect(tasks).toBeTruthy();
  expect(scheduled).toBeTruthy();
  expect(tasks?.children).toHaveLength(1);
  expect(tasks?.firstElementChild).toBe(scheduled);
  expect(scheduled?.querySelector("h3")?.textContent).toBe("Scheduled 0");
  expect(scheduled?.textContent).toContain(
    "Schedule a check-in or a repeating task for this chat.",
  );
  expect(tasks?.textContent).not.toContain("No tasks yet.");
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

async function expectComposerInteractionMode(expectedLabel: "Build" | "Plan"): Promise<void> {
  await page.getByRole("button", { name: "More composer controls", exact: true }).click();
  await expect
    .element(page.getByRole("menuitemradio", { name: expectedLabel, exact: true }))
    .toHaveAttribute("aria-checked", "true");
  await expect
    .element(
      page.getByRole("menuitemradio", {
        name: expectedLabel === "Build" ? "Plan" : "Build",
        exact: true,
      }),
    )
    .toHaveAttribute("aria-checked", "false");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
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
  await revealProjectThreadAction();
  await newThreadButton.hover();
  const shortcutLabel = isMacPlatform(navigator.platform)
    ? "New chat (⇧⌘O)"
    : "New chat (Ctrl+Shift+O)";
  await expect.element(page.getByText(shortcutLabel)).toBeInTheDocument();
}

async function revealProjectThreadAction(): Promise<void> {
  const button = page.getByTestId("new-thread-button");
  await expect.element(button).toBeInTheDocument();
  // The desktop action deliberately disables pointer events while its project
  // header is idle. Hover the owning header first, just as a user must; Vitest
  // 5's Playwright actionability check must not be bypassed by a forced click.
  const header = button
    .element()
    .closest('[class~="group/project-header"]')
    ?.querySelector('[data-sidebar="menu-button"]');
  expect(header).not.toBeNull();
  expect(header).not.toBeUndefined();
  await page.elementLocator(header!).hover();
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
  sourceUpdateState: DesktopSourceUpdateState = {
    status: "idle",
    branch: null,
    trackedBranch: null,
    runtimeHash: null,
    localHash: null,
    remoteHash: null,
    mergeBaseHash: null,
    dirty: null,
    checkedAt: null,
    message: null,
  },
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
    getGlobalDictationSettings: async () => ({
      enabled: false,
      shortcut: "CommandOrControl+Shift+,",
      registered: false,
      error: null,
    }),
    setGlobalDictationEnabled: async (enabled) => ({
      enabled,
      shortcut: "CommandOrControl+Shift+,",
      registered: false,
      error: null,
    }),
    setGlobalDictationShortcut: async (shortcut) => ({
      enabled: false,
      shortcut,
      registered: false,
      error: null,
    }),
    onGlobalDictationEvent: () => () => undefined,
    globalDictationAction: async () => ({ ok: false, reason: "unavailable" }),
    claimComposerDictationCapture: async () => "test-composer-lease",
    releaseComposerDictationCapture: async () => undefined,
    getAdvertisedEndpoints: async () => [],
    pickFolder: async () => null,
    confirm: async () => true,
    setTheme: async () => undefined,
    showContextMenu: async () => null,
    openExternal: async () => true,
    openPath: async () => true,
    revealPath: async () => true,
    copyText: async () => undefined,
    copyPng: async () => undefined,
    savePng: async () => "cancelled",
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
  lifecycle?: {
    readonly assertActive: () => void;
    readonly retire: () => Promise<void>;
    readonly ownCleanup: (cleanup: () => Promise<void>) => void;
    readonly observePhase: (
      phase: "viewport" | "styles" | "render" | "websocket" | "bootstrap" | "layout",
    ) => void;
  };
}): Promise<MountedChatView> {
  const lifecycle = options.lifecycle;
  // A scoped caller owns its complete mount/native-action drain, not just the
  // eventual React unmount. Admit that exact owner before any fixture mutation.
  // An uncertain previous owner cannot be replaced even by an unscoped mount.
  if (lifecycle) scopedFixtureRetirement.admit(lifecycle.retire);
  else scopedFixtureRetirement.assertIdle();
  let retired = false;
  let host: HTMLDivElement | undefined;
  let rendering: ReturnType<typeof render> | undefined;
  let screen: Awaited<ReturnType<typeof render>> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const ownedResolver = options.resolveRpc ?? null;
  const assertActive = () => {
    if (retired) throw new Error("The exact chat mount fixture was retired.");
    lifecycle?.assertActive();
  };
  const dispose = async () => {
    if (lifecycle === undefined) {
      // Preserve the established cleanup ordering for unscoped consumers.
      customWsRpcResolver = null;
      await screen?.unmount();
      host?.remove();
      await waitForLayout();
      return;
    }
    if (customWsRpcResolver === ownedResolver) customWsRpcResolver = null;
    // The scoped caller owns this promise before render can yield. A timeout
    // must join its exact result and unmount it, not clear a replacement root
    // or abandon a render that may commit after ordinary DOM cleanup.
    let ownedScreen: Awaited<ReturnType<typeof render>> | undefined;
    try {
      ownedScreen = await rendering;
    } catch {
      // The original mount await retains the render failure. Cleanup still
      // removes this exact owned host without replacing that original error.
    }
    try {
      await ownedScreen?.unmount();
    } finally {
      host?.remove();
      await waitForLayout();
    }
  };
  const cleanup = () => {
    if (lifecycle === undefined) return dispose();
    retired = true;
    return (cleanupPromise ??= dispose());
  };
  // Optional ownership is installed synchronously before viewport, render or
  // bootstrap awaits. Existing unscoped consumers retain their own lifecycle.
  lifecycle?.ownCleanup(cleanup);
  assertActive();
  fixture = buildFixture(options.snapshot);
  options.configureFixture?.(fixture);
  customWsRpcResolver = ownedResolver;
  lifecycle?.observePhase("viewport");
  await setViewport(options.viewport);
  assertActive();
  lifecycle?.observePhase("styles");
  await waitForProductionStyles();
  assertActive();

  host = document.createElement("div");
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

  lifecycle?.observePhase("render");
  rendering = render(
    <AppAtomRegistryProvider>
      <RouterProvider router={router} />
    </AppAtomRegistryProvider>,
    {
      container: host,
    },
  );
  screen = await rendering;
  assertActive();

  lifecycle?.observePhase("websocket");
  await waitForWsClient();
  assertActive();
  lifecycle?.observePhase("bootstrap");
  await waitForAppBootstrap();
  assertActive();
  lifecycle?.observePhase("layout");
  await waitForLayout();
  assertActive();

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    setViewport: async (viewport: ViewportSpec) => {
      assertActive();
      await setViewport(viewport);
      assertActive();
      await waitForProductionStyles();
      assertActive();
    },
    setContainerSize: async (viewport) => {
      assertActive();
      // Successful mounting above owns this exact host through cleanup.
      if (!host) throw new Error("The exact chat mount host is unavailable.");
      host.style.width = `${viewport.width}px`;
      host.style.height = `${viewport.height}px`;
      await waitForLayout();
      assertActive();
    },
    router,
  };
}
const {
  createSnapshotWithLongProposedPlan,
  createSnapshotWithRuntimeTaskProgress,
  createSnapshotWithActiveSubagent,
  createSnapshotWithCrossTurnActiveSubagent,
  createSnapshotWithSecondaryProject,
  createSnapshotWithPendingUserInput,
  createSnapshotWithPlanFollowUpPrompt,
} = createChatViewSnapshots({
  createSnapshotForTargetUser,
  THREAD_ID,
  isoAt,
  RUNTIME_TASK_STEPS,
  RUNTIME_TASK_TURN_ID,
  SUBAGENT_RUNTIME_ID,
  SECOND_PROJECT_ID,
  ARCHIVED_SECONDARY_THREAD_ID,
  NOW_ISO,
  PROJECT_ID,
});

// These live accessors preserve the two existing mutable fixture bindings.
// They do not snapshot state or expose a second store; helpers and cases
// observe the same exact current fixture/resolver after every assignment.
export const chatViewFixture = {
  get fixture(): TestFixture {
    return fixture;
  },
  set fixture(value: TestFixture) {
    fixture = value;
  },
  get customWsRpcResolver() {
    return customWsRpcResolver;
  },
  set customWsRpcResolver(value: typeof customWsRpcResolver) {
    customWsRpcResolver = value;
  },
};

// Register inside each unchanged feature describe, not at module scope.
// Mutable stores, native input, bootstrap gates and teardown remain per case.
export function registerChatViewBrowserHooks(): void {
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
    try {
      await scopedFixtureRetirement.retire();
    } finally {
      await rpcHarness.disconnect();
      await worker.stop();
    }
  });

  beforeEach(async () => {
    // A timed-out hook wrapper does not settle its native child. Refuse a new
    // fixture/reset while its exact prior retirement is still outstanding.
    // React's global beforeEach may clean an old root, but cannot authorize a
    // replacement RPC harness, store or matching controls through this fence.
    scopedFixtureRetirement.assertIdle();
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
    useDeskStore.getState().bindEnvironment(null);
    localStorage.clear();
    useDeskStore.setState({ desk: createDeskState(), draftEditors: {}, activeDraftId: null });
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
      composerTabCollapsed: false,
      threadLastVisitedAtById: {},
      sessionRailDocked: false,
    });
    useTaskAtriumStore.getState().setOpen(false);
  });

  afterEach(async () => {
    try {
      // Vitest runs afterEach before onTestFinished. Join the SAME caller-owned
      // cleanup here before clearing a still-resolving native locator's target;
      // a later completion callback alone cannot establish that ordering.
      await scopedFixtureRetirement.retire();
    } finally {
      customWsRpcResolver = null;
      // Imperative context menus own separate React roots. Finish active menus
      // and their exit transitions before clearing the DOM they still own.
      await showContextMenuFallback([]);
      expect(document.querySelector("[data-context-menu-host]")).toBeNull();
      document.body.innerHTML = "";
    }
  });
}

export {
  THREAD_ID,
  THREAD_REF,
  wsRequests,
  WIDE_FOOTER_VIEWPORT,
  isoAt,
  SUBAGENT_RUNTIME_ID,
  waitForElement,
  waitForComposerEditor,
  waitForSendButton,
  mountChatView,
  createSnapshotWithActiveSubagent,
  PROJECT_ID,
  LOCAL_ENVIRONMENT_ID,
  THREAD_KEY,
  PROJECT_DRAFT_KEY,
  PROJECT_LOGICAL_KEY,
  NOW_ISO,
  rpcHarness,
  DEFAULT_VIEWPORT,
  COMPACT_FOOTER_VIEWPORT,
  createUserMessage,
  createAssistantMessage,
  createSnapshotForTargetUser,
  addThreadToSnapshot,
  draftIdFromPath,
  serverThreadPath,
  createDraftOnlySnapshot,
  withProjectScripts,
  setDraftThreadWithoutWorktree,
  RUNTIME_TASK_DESCRIPTIONS,
  worker,
  waitForLayout,
  editButton,
  buttonWithText,
  queuedSendButtons,
  waitForURL,
  pressComposerKey,
  pressComposerUndo,
  waitForComposerText,
  setComposerSelectionByTextOffsets,
  selectAllComposerContent,
  forceOnScreenKeyboardMediaQuery,
  findSendFailureToastTitle,
  findComposerTaskProgressTrigger,
  findComposerTaskProgressPopup,
  findComposerTaskProgressList,
  findComposerTaskProgressScroller,
  findSessionRail,
  expectEmptyScheduledSessionRailTasks,
  findButtonByText,
  waitForButtonByText,
  waitForMenuRadioItemContainingText,
  expectComposerInteractionMode,
  waitForServerConfigToApply,
  createDesktopBridgeForChatViewTests,
  createSnapshotWithRuntimeTaskProgress,
  createSnapshotWithCrossTurnActiveSubagent,
  createSnapshotWithPlanFollowUpPrompt,
  UUID_ROUTE_RE,
  encodeServerConfig,
  toShellThread,
  threadRefFor,
  draftThreadIdFor,
  startPromotedServerThreadViaDomainEvent,
  createProjectlessSnapshot,
  THREAD_TITLE,
  SECOND_PROJECT_ID,
  ADD_PROJECT_SUBMENU_PLACEHOLDER,
  composerDraftFor,
  materializePromotedDraftThreadViaDomainEvent,
  promoteDraftThreadViaDomainEvent,
  dispatchChatNewShortcut,
  triggerChatNewShortcutUntilPath,
  openCommandPaletteFromTrigger,
  waitForNewThreadShortcutLabel,
  revealProjectThreadAction,
  waitForCommandPaletteShortcutLabel,
  waitForCommandPaletteInput,
  getCommandPaletteLegendEntries,
  dispatchInputKey,
  createSnapshotWithSecondaryProject,
  waitForComposerMenuItem,
  findComposerProviderModelPicker,
  waitForButtonContainingText,
  expectComposerActionsContained,
  releaseModShortcut,
  createSnapshotWithLongProposedPlan,
  createSnapshotWithPendingUserInput,
};
export type { TestFixture };
