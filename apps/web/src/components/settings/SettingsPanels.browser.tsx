import "../../index.css";
import {
  type AuthAccessStreamEvent,
  type AuthAccessSnapshot,
  AuthSessionId,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type DesktopBridge,
  type DesktopSourceUpdateState,
  type DesktopUpdateChannel,
  type DesktopUpdateState,
  type LocalApi,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProcessResourceHistoryResult,
  type ServerProvider,
  type ServerRuntimeLayerDiagnosticsResult,
  type SourceControlDiscoveryResult,
} from "@cafecode/contracts";
import { MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES } from "@cafecode/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { __resetLocalApiForTests, ensureLocalApi } from "../../localApi";
import { AppAtomRegistryProvider, resetAppAtomRegistryForTests } from "../../rpc/atomRegistry";
import {
  getServerConfig,
  resetServerStateForTests,
  setServerConfigSnapshot,
} from "../../rpc/serverState";
import { toastManager } from "../ui/toast";
import { useUiStateStore } from "../../uiStateStore";
import { ConnectionsSettings } from "./ConnectionsSettings";
import { DiagnosticsSettingsPanel } from "./DiagnosticsSettings";
import { KeybindingsSettingsPanel } from "./KeybindingsSettings";
import {
  AppearanceSettingsPanel,
  ChatSettingsPanel,
  FilesSettingsPanel,
  ProviderSettingsPanel,
  SystemSettingsPanel,
  TextGenerationModelSettingsRow,
} from "./SettingsPanels";
import { SourceControlSettingsPanel } from "./SourceControlSettings";

function renderWithTestRouter(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const rootRoute = createRootRoute({
    component: () => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

const authAccessHarness = vi.hoisted(() => {
  type Snapshot = AuthAccessSnapshot;
  let snapshot: Snapshot = {
    pairingLinks: [],
    clientSessions: [],
  };
  let revision = 1;
  const listeners = new Set<(event: AuthAccessStreamEvent) => void>();

  const emitEvent = (event: AuthAccessStreamEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return {
    reset() {
      snapshot = {
        pairingLinks: [],
        clientSessions: [],
      };
      revision = 1;
      listeners.clear();
    },
    setSnapshot(next: Snapshot) {
      snapshot = next;
    },
    emitSnapshot() {
      emitEvent({
        version: 1 as const,
        revision,
        type: "snapshot" as const,
        payload: snapshot,
      });
      revision += 1;
    },
    emitEvent,
    emitPairingLinkUpserted(pairingLink: Snapshot["pairingLinks"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: pairingLink,
      });
      revision += 1;
    },
    emitPairingLinkRemoved(id: string) {
      emitEvent({
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id },
      });
      revision += 1;
    },
    emitClientUpserted(clientSession: Snapshot["clientSessions"][number]) {
      emitEvent({
        version: 1,
        revision,
        type: "clientUpserted",
        payload: clientSession,
      });
      revision += 1;
    },
    emitClientRemoved(sessionId: string) {
      emitEvent({
        version: 1,
        revision,
        type: "clientRemoved",
        payload: {
          sessionId: AuthSessionId.make(sessionId),
        },
      });
      revision += 1;
    },
    subscribe(listener: (event: AuthAccessStreamEvent) => void) {
      listeners.add(listener);
      listener({
        version: 1,
        revision: 1,
        type: "snapshot",
        payload: snapshot,
      });
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: {
        subscribeAuthAccess: (listener: Parameters<typeof authAccessHarness.subscribe>[0]) =>
          authAccessHarness.subscribe(listener),
      },
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    resolveEnvironmentHttpUrl: (input: { readonly pathname: string }) =>
      new URL(input.pathname, "http://localhost:3000").toString(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: () => undefined,
    startEnvironmentConnectionService: () => undefined,
    subscribeEnvironmentConnections: () => () => {},
    useSavedEnvironmentRuntimeStore: (
      selector: (state: { readonly byId: Record<string, never> }) => unknown,
    ) => selector({ byId: {} }),
  };
});

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
    providers: [],
    availableEditors: ["cursor"],
    observability: {
      logsDirectoryPath: "/repo/project/.t3/logs",
      localTracingEnabled: true,
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpTracesEnabled: true,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
    clientSettings: { ...DEFAULT_CLIENT_SETTINGS, onboardingCompleted: true },
  };
}

function createOutdatedProvider(
  driver: string,
  updateCommand = "npm install -g openai/codex@latest",
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-05-04T10:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      message: "Update available.",
      checkedAt: "2026-05-04T10:00:00.000Z",
      updateCommand,
      canUpdate: true,
    },
  };
}

function makeUtc(value: string) {
  return DateTime.makeUnsafe(value);
}

function createEmptyProcessResourceHistoryResult(): ServerProcessResourceHistoryResult {
  return {
    readAt: makeUtc("2036-04-07T00:00:00.000Z"),
    windowMs: 15 * 60_000,
    bucketMs: 60_000,
    sampleIntervalMs: 5_000,
    retainedSampleCount: 0,
    totalCpuSecondsApprox: 0,
    buckets: [],
    topProcesses: [],
    error: Option.none(),
  };
}

function createRuntimeLayerDiagnosticsResult(): ServerRuntimeLayerDiagnosticsResult {
  return {
    readAt: "2036-04-07T00:00:00.000Z",
    platform: "darwin",
    windowMs: 15 * 60_000,
    bucketMs: 60_000,
    collectionSource: "test",
    partialFailure: false,
    runtimeLayers: [
      {
        role: "backend",
        status: "online",
        pid: 1234,
        rssBytes: 1024,
        cpuPercent: 1,
        uptimeLabel: "00:10",
        lastEventAt: "2036-04-07T00:00:00.000Z",
        notes: ["Main backend process."],
      },
      {
        role: "provider-daemon",
        status: "online",
        pid: 5678,
        rssBytes: 2048,
        cpuPercent: 2,
        uptimeLabel: "00:05",
        lastEventAt: "2036-04-07T00:00:00.000Z",
        notes: ["Provider daemon health summary."],
      },
      {
        role: "provider-supervisor",
        status: "not-configured",
        pid: null,
        rssBytes: 0,
        cpuPercent: 0,
        uptimeLabel: null,
        lastEventAt: null,
        notes: ["Optional provider supervisor is not configured; providers run in the daemon."],
      },
    ],
    orchestrator: {
      latestEventSequence: 10,
      projectionSequence: 10,
      projectionLag: 0,
      commandQueueDepth: 0,
      acceptedCommandCount: 1,
      rejectedCommandCount: 0,
      failedCommandCount: 0,
      projectCount: 1,
      threadCount: 1,
      pendingTurnCount: 0,
      runningTurnCount: 0,
      activeTurnCount: 0,
      recentEventTypeCounts: [
        {
          eventType: "thread.message-sent",
          actorKind: "provider",
          count: 1,
          lastSeenAt: "2036-04-07T00:00:00.000Z",
        },
      ],
      projectorCursors: [
        {
          projector: "thread-detail",
          cursor: 10,
          lag: 0,
          updatedAt: "2036-04-07T00:00:00.000Z",
          status: "online",
        },
      ],
      providerRuntimeIngestion: {
        cursor: 10,
        daemonEventCursor: 10,
        lag: 0,
        updatedAt: "2036-04-07T00:00:00.000Z",
        lastDaemonEventAt: "2036-04-07T00:00:00.000Z",
        status: "online",
      },
      staleStateFlags: [],
    },
    subprocesses: [
      {
        role: "provider-daemon",
        ownerKind: "daemon-marker",
        pid: 5678,
        ppid: 1,
        status: "S",
        cpuPercent: 2,
        rssBytes: 2048,
        elapsed: "00:05",
        commandLabel: "node",
        sanitizedCommand: "node daemon.mjs",
        depth: 0,
        childPids: [],
        attribution: "daemon health PID",
        lastSeenAt: "2036-04-07T00:00:00.000Z",
        notes: [],
      },
    ],
    providerDaemon: {
      available: true,
      reachable: true,
      status: "online",
      pid: 5678,
      ppid: 1,
      mode: "provider-daemon",
      transport: "loopback-tcp",
      healthLatencyMs: 2,
      startedAt: "2036-04-07T00:00:00.000Z",
      activeSessionCount: 1,
      activeStreamCount: 0,
      retainedEventCount: 2,
      eventCursor: 4,
      leaseCount: 0,
      commandCount: 1,
      runningCommandCount: 0,
      completedCommandCount: 1,
      failedCommandCount: 0,
      totalRpcCount: 3,
      failedRpcCount: 0,
      maxRpcDurationMs: 5,
      meanRpcDurationMs: 2,
      sqliteBusyTimeoutMs: 5_000,
      recentCommands: [],
      runtimeEventSummaries: [],
      error: null,
    },
    providerSupervisor: {
      configured: false,
      reachable: false,
      status: "not-configured",
      pid: null,
      ppid: null,
      transport: null,
      healthLatencyMs: null,
      activeSessionCount: 0,
      activeStreamCount: 0,
      retainedEventCount: 0,
      commandCount: 0,
      runningCommandCount: 0,
      completedCommandCount: 0,
      failedCommandCount: 0,
      sessionCounts: {},
      error: null,
    },
    resources: {
      sampleIntervalMs: 0,
      retainedSampleCount: 1,
      buckets: [],
      processes: [
        {
          processKey: "provider-daemon:5678:node",
          role: "provider-daemon",
          pid: 5678,
          currentRssBytes: 2048,
          maxRssBytes: 2048,
          currentCpuPercent: 2,
          avgCpuPercent: 2,
          maxCpuPercent: 2,
          sampleCount: 1,
          lastSeenAt: "2036-04-07T00:00:00.000Z",
        },
      ],
    },
    errors: [],
  };
}

function makePairingLink(input: {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}): AuthAccessSnapshot["pairingLinks"][number] {
  return {
    ...input,
    createdAt: makeUtc(input.createdAt),
    expiresAt: makeUtc(input.expiresAt),
  };
}

function makeClientSession(input: {
  readonly sessionId: string;
  readonly subject: string;
  readonly role: "owner" | "client";
  readonly method: "browser-session-cookie";
  readonly client?: {
    readonly label?: string;
    readonly ipAddress?: string;
    readonly userAgent?: string;
    readonly deviceType?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
    readonly os?: string;
    readonly browser?: string;
  };
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt?: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}): AuthAccessSnapshot["clientSessions"][number] {
  return {
    ...input,
    client: {
      deviceType: "unknown",
      ...input.client,
    },
    sessionId: AuthSessionId.make(input.sessionId),
    issuedAt: makeUtc(input.issuedAt),
    expiresAt: makeUtc(input.expiresAt),
    lastConnectedAt:
      input.lastConnectedAt === undefined || input.lastConnectedAt === null
        ? null
        : makeUtc(input.lastConnectedAt),
  };
}

const createDesktopBridgeStub = (overrides?: {
  readonly serverExposureState?: Awaited<ReturnType<DesktopBridge["getServerExposureState"]>>;
  readonly advertisedEndpoints?: Awaited<ReturnType<DesktopBridge["getAdvertisedEndpoints"]>>;
  readonly setServerExposureMode?: DesktopBridge["setServerExposureMode"];
  readonly setServerHttpsEnabled?: DesktopBridge["setServerHttpsEnabled"];
  readonly setUpdateChannel?: DesktopBridge["setUpdateChannel"];
  readonly sourceUpdateState?: DesktopSourceUpdateState;
  readonly checkSourceUpdate?: DesktopBridge["checkSourceUpdate"];
}): DesktopBridge => {
  const idleUpdateState: DesktopUpdateState = {
    enabled: false,
    status: "idle",
    channel: "latest",
    installMode: "in-app",
    currentVersion: "0.0.0-test",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
  const sourceUpdateState: DesktopSourceUpdateState = overrides?.sourceUpdateState ?? {
    status: "ignored",
    branch: "feature-test",
    trackedBranch: null,
    runtimeHash: "abc123",
    localHash: "abc123",
    remoteHash: null,
    mergeBaseHash: null,
    dirty: false,
    checkedAt: "2026-01-01T00:00:00.000Z",
    message: "Only branches main and dev are tracked.",
  };

  return {
    openVirtualDesktop: async () => undefined,
    getAppBranding: vi.fn().mockReturnValue(null),
    getLocalEnvironmentBootstrap: () => ({
      label: "Local environment",
      httpBaseUrl: "http://127.0.0.1:3773",
      wsBaseUrl: "ws://127.0.0.1:3773",
      bootstrapToken: "desktop-bootstrap-token",
    }),
    getDebugEndpointState: vi.fn().mockResolvedValue({ enabled: false, url: null }),
    publishDebugSnapshot: vi.fn().mockResolvedValue(undefined),
    getClientSettings: vi.fn().mockResolvedValue(null),
    setClientSettings: vi.fn().mockResolvedValue(undefined),
    setPowerSaveBlockerState: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentRegistry: vi.fn().mockResolvedValue([]),
    setSavedEnvironmentRegistry: vi.fn().mockResolvedValue(undefined),
    getSavedEnvironmentSecret: vi.fn().mockResolvedValue(null),
    setSavedEnvironmentSecret: vi.fn().mockResolvedValue(true),
    removeSavedEnvironmentSecret: vi.fn().mockResolvedValue(undefined),
    getServerExposureState: vi.fn().mockResolvedValue(
      overrides?.serverExposureState ?? {
        mode: "local-only",
        httpsEnabled: true,
        endpointUrl: null,
        advertisedHost: null,
      },
    ),
    setServerExposureMode:
      overrides?.setServerExposureMode ??
      vi.fn().mockImplementation(async (mode) => ({
        mode,
        httpsEnabled: true,
        endpointUrl: mode === "network-accessible" ? "http://192.168.1.44:3773" : null,
        advertisedHost: mode === "network-accessible" ? "192.168.1.44" : null,
      })),
    setServerHttpsEnabled:
      overrides?.setServerHttpsEnabled ??
      vi.fn().mockImplementation(async (httpsEnabled) => ({
        mode: "local-only",
        httpsEnabled,
        endpointUrl: null,
        advertisedHost: null,
      })),
    getGlobalDictationSettings: vi.fn().mockResolvedValue({
      enabled: false,
      shortcut: "CommandOrControl+Shift+,",
      registered: false,
      error: null,
    }),
    setGlobalDictationEnabled: vi.fn().mockImplementation(async (enabled) => ({
      enabled,
      shortcut: "CommandOrControl+Shift+,",
      registered: false,
      error: null,
    })),
    setGlobalDictationShortcut: vi.fn().mockImplementation(async (shortcut) => ({
      enabled: false,
      shortcut,
      registered: false,
      error: null,
    })),
    onGlobalDictationEvent: () => () => {},
    globalDictationAction: vi.fn().mockResolvedValue({ ok: false, reason: "unavailable" }),
    claimComposerDictationCapture: vi.fn().mockResolvedValue("test-composer-lease"),
    releaseComposerDictationCapture: vi.fn().mockResolvedValue(undefined),
    getAdvertisedEndpoints: vi.fn().mockResolvedValue(overrides?.advertisedEndpoints ?? []),
    pickFolder: vi.fn().mockResolvedValue(null),
    confirm: vi.fn().mockResolvedValue(false),
    setTheme: vi.fn().mockResolvedValue(undefined),
    showContextMenu: vi.fn().mockResolvedValue(null),
    openExternal: vi.fn().mockResolvedValue(true),
    openPath: vi.fn().mockResolvedValue(true),
    revealPath: vi.fn().mockResolvedValue(true),
    copyText: vi.fn().mockResolvedValue(undefined),
    copyPng: vi.fn().mockResolvedValue(undefined),
    savePng: vi.fn().mockResolvedValue("cancelled"),
    onMenuAction: () => () => {},
    getUpdateState: vi.fn().mockResolvedValue(idleUpdateState),
    setUpdateChannel:
      overrides?.setUpdateChannel ??
      vi.fn().mockImplementation(async (channel: DesktopUpdateChannel) => ({
        ...idleUpdateState,
        channel,
      })),
    checkForUpdate: vi.fn().mockResolvedValue({ checked: false, state: idleUpdateState }),
    downloadUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    installUpdate: vi
      .fn()
      .mockResolvedValue({ accepted: false, completed: false, state: idleUpdateState }),
    onUpdateState: () => () => {},
    getSourceUpdateState: vi.fn().mockResolvedValue(sourceUpdateState),
    checkSourceUpdate: overrides?.checkSourceUpdate ?? vi.fn().mockResolvedValue(sourceUpdateState),
    onSourceUpdateState: () => () => {},
  };
};

function installClientSettingsNativeApi(desktopBridge: DesktopBridge) {
  const updateClientSettings = vi
    .fn<LocalApi["server"]["updateClientSettings"]>()
    .mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  window.nativeApi = {
    persistence: {
      getClientSettings: desktopBridge.getClientSettings,
      setClientSettings: desktopBridge.setClientSettings,
    },
    server: {
      updateClientSettings,
    },
  } as unknown as LocalApi;
  return { updateClientSettings };
}

function installFileSettingsNativeApi(config: ServerConfig) {
  const getConfig = vi.fn<LocalApi["server"]["getConfig"]>().mockResolvedValue(config);
  const openSystemPromptFile = vi
    .fn<LocalApi["server"]["openSystemPromptFile"]>()
    .mockResolvedValue({ path: config.systemPromptPath });
  const openPath = vi.fn<LocalApi["shell"]["openPath"]>().mockResolvedValue(undefined);
  const openInEditor = vi.fn<LocalApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
  const confirm = vi.fn<LocalApi["dialogs"]["confirm"]>().mockResolvedValue(true);
  window.nativeApi = {
    dialogs: { confirm },
    persistence: {
      getClientSettings: vi.fn().mockResolvedValue(null),
      setClientSettings: vi.fn().mockResolvedValue(undefined),
    },
    server: { getConfig, openSystemPromptFile },
    shell: { openPath, openInEditor },
  } as unknown as LocalApi;
  setServerConfigSnapshot(config);
  return { getConfig, openSystemPromptFile, openPath, openInEditor, confirm };
}

describe("settings panels", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetServerStateForTests();
    await __resetLocalApiForTests();
    localStorage.clear();
    useUiStateStore.setState({ defaultAdvertisedEndpointKey: null });
    authAccessHarness.reset();
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "desktopBridge");
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    resetServerStateForTests();
    await __resetLocalApiForTests();
    authAccessHarness.reset();
  });

  it("preserves saved helper choices and resets to Sol 6.1 with Medium reasoning", async () => {
    const updateSettings = vi.fn().mockResolvedValue(undefined);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: { updateSettings },
    } as unknown as LocalApi;
    const config = createBaseServerConfig();
    setServerConfigSnapshot({
      ...config,
      settings: {
        ...config.settings,
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-luna",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
      },
      providers: [
        {
          ...createOutdatedProvider("codex"),
          models: [
            { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
            { slug: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
          ].map((model) => ({
            slug: model.slug,
            name: model.name,
            isCustom: false,
            capabilities: {
              // Use a native Low default so the assertion proves that the
              // helper-specific Medium choice reaches the actual control.
              optionDescriptors: [
                {
                  id: "reasoningEffort",
                  label: "Reasoning",
                  type: "select",
                  currentValue: "low",
                  options: [
                    { id: "low", label: "Low", isDefault: true },
                    { id: "medium", label: "Medium" },
                    { id: "high", label: "High" },
                  ],
                },
                { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
              ],
            },
          })),
        },
      ],
    });
    mounted = await render(
      <AppAtomRegistryProvider>
        <TextGenerationModelSettingsRow />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Writes chat titles and branch names.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: /GPT-5.6 Luna/ })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "High · Fast", exact: true }))
      .toBeVisible();
    expect(updateSettings).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Reset text generation model to default" }).click();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({
      textGenerationModelSelection: {
        instanceId: "codex",
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    });
    await expect.element(page.getByRole("button", { name: /GPT-6.1 Sol/ })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Medium · Normal", exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Reset text generation model to default" }))
      .not.toBeInTheDocument();
  });

  it("hides owner pairing tools in browser-served loopback builds without remote exposure", async () => {
    Reflect.deleteProperty(window, "desktopBridge");
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [
        makeClientSession({
          sessionId: "session-owner",
          subject: "browser-owner",
          role: "owner",
          method: "browser-session-cookie",
          client: {
            label: "Chrome on Mac",
            deviceType: "desktop",
            os: "macOS",
            browser: "Chrome",
            ipAddress: "127.0.0.1",
          },
          issuedAt: "2036-04-07T00:00:00.000Z",
          expiresAt: "2036-05-07T00:00:00.000Z",
          connected: true,
          current: true,
        }),
      ],
    });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/session")) {
        return new Response(
          JSON.stringify({
            authenticated: true,
            auth: createBaseServerConfig().auth,
            role: "owner",
            sessionMethod: "browser-session-cookie",
            expiresAt: "2036-05-07T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch GET ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Local server")).toBeInTheDocument();
    await expect.element(page.getByLabelText("Enable network access")).toBeDisabled();
    await expect
      .element(page.getByText("Restart the server so other devices on your network can reach it."))
      .toBeInTheDocument();
    await expect.element(page.getByText("Paired devices")).not.toBeInTheDocument();
    await expect.element(page.getByText("Chrome on Mac")).not.toBeInTheDocument();
  });

  it("hides advertised endpoint rows when desktop network access is disabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "local-only",
        httpsEnabled: true,
        endpointUrl: null,
        advertisedHost: null,
      },
      advertisedEndpoints: [
        {
          id: "loopback",
          label: "This machine",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          reachability: "loopback",
          source: "desktop-core",
          status: "available",
          isDefault: true,
        },
      ],
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    // Loaded local-only state: the switch is interactive and off, so no
    // reachable address or endpoint rows are listed.
    await expect.element(page.getByLabelText("Enable network access")).not.toBeDisabled();
    await expect.element(page.getByLabelText("Enable network access")).not.toBeChecked();
    await expect.element(page.getByText(/^Reachable at/)).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "This machine", exact: true }))
      .not.toBeInTheDocument();
  });

  it("shows advertised endpoints by default and lets users hide them", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        httpsEnabled: true,
        endpointUrl: "http://192.168.86.39:3773",
        advertisedHost: "192.168.86.39",
      },
      advertisedEndpoints: [
        {
          id: "desktop-loopback:3773",
          label: "This machine",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          reachability: "loopback",
          source: "desktop-core",
          status: "available",
        },
        {
          id: "desktop-lan:http://192.168.86.39:3773",
          label: "Local network",
          provider: {
            id: "desktop-core",
            label: "Desktop",
            kind: "manual",
            isAddon: false,
          },
          httpBaseUrl: "http://192.168.86.39:3773/",
          wsBaseUrl: "ws://192.168.86.39:3773/",
          reachability: "lan",
          source: "desktop-core",
          status: "available",
          isDefault: true,
        },
      ],
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("http://192.168.86.39:3773/").first()).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Hide" }).click();

    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "+1" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Local network", exact: true }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Set as default" }).first().click();
    await expect.element(page.getByText("http://127.0.0.1:3773/").first()).toBeInTheDocument();
  });

  it("shows diagnostics inside About with a diagnostics link", async () => {
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <SystemSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("About")).toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Diagnostics", exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByRole("link", { name: "View diagnostics" })).toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces.",
        ),
      )
      .toBeInTheDocument();
  });

  it("shows source branch update status in About and refreshes it on demand", async () => {
    const checkSourceUpdate = vi.fn().mockResolvedValue({
      status: "behind",
      branch: "dev",
      trackedBranch: "dev",
      runtimeHash: "1111111111111111111111111111111111111111",
      localHash: "1111111111111111111111111111111111111111",
      remoteHash: "2222222222222222222222222222222222222222",
      mergeBaseHash: "1111111111111111111111111111111111111111",
      dirty: true,
      checkedAt: "2026-01-01T00:00:00.000Z",
      message: "A newer dev commit is available at 222222222222.",
    } satisfies DesktopSourceUpdateState);
    window.desktopBridge = createDesktopBridgeStub({
      sourceUpdateState: {
        status: "behind",
        branch: "dev",
        trackedBranch: "dev",
        runtimeHash: "1111111111111111111111111111111111111111",
        localHash: "1111111111111111111111111111111111111111",
        remoteHash: "2222222222222222222222222222222222222222",
        mergeBaseHash: "1111111111111111111111111111111111111111",
        dirty: true,
        checkedAt: "2026-01-01T00:00:00.000Z",
        message: "A newer dev commit is available at 222222222222.",
      },
      checkSourceUpdate,
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <SystemSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("(dev branch)", { exact: false })).toBeInTheDocument();
    await expect.element(page.getByText("Newer dev commit available")).toBeInTheDocument();
    // Commit hashes live in the Version row's info tooltip rather than the row itself.
    await page.getByRole("button", { name: "Version details" }).hover();
    await expect
      .element(page.getByText("Current: 111111111111 (dirty)", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Running build: 111111111111", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Latest origin/dev: 222222222222", { exact: false }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Check for updates", exact: true }).click();
    await vi.waitFor(() => {
      expect(checkSourceUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("shows rebuild-required source status when the running build hash is stale", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      sourceUpdateState: {
        status: "current",
        branch: "dev",
        trackedBranch: "dev",
        runtimeHash: "1111111111111111111111111111111111111111",
        localHash: "2222222222222222222222222222222222222222",
        remoteHash: "2222222222222222222222222222222222222222",
        mergeBaseHash: "2222222222222222222222222222222222222222",
        dirty: false,
        checkedAt: "2026-01-01T00:00:00.000Z",
        message: "This checkout is current with origin.",
      },
    });
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <SystemSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Rebuild to apply (dev)")).toBeInTheDocument();
    await page.getByRole("button", { name: "Version details" }).hover();
    await expect
      .element(page.getByText("Current: 222222222222 (clean)", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Running build: 111111111111", { exact: false }))
      .toBeInTheDocument();
  });

  it("persists the keep-awake preference from System settings", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;
    const { updateClientSettings } = installClientSettingsNativeApi(desktopBridge);
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <SystemSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Keep awake")).toBeInTheDocument();
    await page.getByLabelText("Keep awake").click();

    await page.getByText("During chats", { exact: true }).click();

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ powerSaveBlockerMode: "during-chats" });
    });
  });

  it("preserves primary settings optimistic behavior and failure feedback", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;
    const { updateClientSettings } = installClientSettingsNativeApi(desktopBridge);
    const failure = new Error("fixture write failure");
    updateClientSettings.mockRejectedValueOnce(failure);
    setServerConfigSnapshot(createBaseServerConfig());
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const toast = vi.spyOn(toastManager, "add");
    try {
      mounted = await renderWithTestRouter(
        <AppAtomRegistryProvider>
          <SystemSettingsPanel />
        </AppAtomRegistryProvider>,
      );
      await page.getByLabelText("Keep awake").click();
      await page.getByText("During chats", { exact: true }).click();
      await vi.waitFor(() =>
        expect(errorLog).toHaveBeenCalledWith("[CLIENT_SETTINGS] client update failed", failure),
      );
      expect(getServerConfig()?.clientSettings.powerSaveBlockerMode).toBe("during-chats");
      expect(toast).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      toast.mockRestore();
    }
  });

  it("persists the chat selection copy preference from Chat settings", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;
    const { updateClientSettings } = installClientSettingsNativeApi(desktopBridge);
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <ChatSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Chat selection copy")).toBeInTheDocument();
    await expect.element(page.getByText("Markdown", { exact: true })).toBeInTheDocument();
    await page.getByLabelText("Chat selection copy format").click();
    await page.getByText("Plain text", { exact: true }).click();

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ chatCopyFormat: "plainText" });
    });
  });

  it("persists single-click behavior from Chat settings and resets it to preview", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;
    const { updateClientSettings } = installClientSettingsNativeApi(desktopBridge);
    updateClientSettings.mockImplementation(async (patch) => ({
      ...DEFAULT_CLIENT_SETTINGS,
      ...patch,
    }));
    setServerConfigSnapshot(createBaseServerConfig());
    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <ChatSettingsPanel />
      </AppAtomRegistryProvider>,
    );
    await page.getByLabelText("Chat click behavior").click();
    await page.getByRole("option", { name: "Open", exact: true }).click();
    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ chatClickBehavior: "open" });
      expect(getServerConfig()?.clientSettings.chatClickBehavior).toBe("open");
    });
    await page.getByRole("button", { name: "Reset single-click behavior to default" }).click();
    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenLastCalledWith({ chatClickBehavior: "preview" });
      expect(getServerConfig()?.clientSettings.chatClickBehavior).toBe("preview");
    });
  });

  it("persists appearance preferences from Appearance settings", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;
    const { updateClientSettings } = installClientSettingsNativeApi(desktopBridge);
    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <AppearanceSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const setColorInput = (ariaLabel: string, value: string) => {
      const input = document.querySelector(
        `input[aria-label="${ariaLabel}"]`,
      ) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      const inputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      inputValueSetter?.call(input, value);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    };

    await expect.element(page.getByText("Accent color")).toBeInTheDocument();
    await expect.element(page.getByText("Interface size")).toBeInTheDocument();
    page.getByRole("slider", { name: "Interface size" }).element().focus();
    await userEvent.keyboard("{ArrowRight}");

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ interfaceScalePercent: 105 });
    });

    setColorInput("Branding prefix", "Acme");

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ brandWordmarkPrefix: "Acme" });
    });

    const uploadFetch = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/branding/sidebar-image") && init?.method === "POST") {
        expect(init.body).toBeInstanceOf(File);
        expect(init.headers).toMatchObject({ "content-type": "image/png" });
        return new Response(
          JSON.stringify({
            sidebarBrandImage: {
              id: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
              url: "/api/branding/sidebar-image/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
              mimeType: "image/png",
              width: 128,
              height: 160,
              sizeBytes: 1234,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      throw new Error(`Unhandled fetch ${url}`);
    });
    vi.stubGlobal("fetch", uploadFetch);

    await expect
      .element(page.getByRole("heading", { name: "Sidebar image", exact: true }))
      .toBeInTheDocument();
    const imageInput = document.querySelector(
      'input[aria-label="Sidebar image file"]',
    ) as HTMLInputElement | null;
    expect(imageInput).not.toBeNull();
    Object.defineProperty(imageInput, "files", {
      configurable: true,
      value: [new File(["image"], "brand.png", { type: "image/png" })],
    });
    imageInput!.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          sidebarBrandImage: {
            id: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
            url: "/api/branding/sidebar-image/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
            mimeType: "image/png",
            width: 128,
            height: 160,
            sizeBytes: 1234,
          },
          sidebarBrandImageDataUrl: "",
        }),
      );
    });
    expect(uploadFetch).toHaveBeenCalledTimes(1);

    const callsBeforeUnsupportedImage = updateClientSettings.mock.calls.length;
    Object.defineProperty(imageInput, "files", {
      configurable: true,
      value: [new File(["<svg />"], "brand.svg", { type: "image/svg+xml" })],
    });
    imageInput!.dispatchEvent(new Event("change", { bubbles: true }));

    await expect
      .element(page.getByText("Choose a PNG, JPEG, GIF, or WebP image."))
      .toBeInTheDocument();
    expect(updateClientSettings).toHaveBeenCalledTimes(callsBeforeUnsupportedImage);

    const callsBeforeOversizedImage = updateClientSettings.mock.calls.length;
    Object.defineProperty(imageInput, "files", {
      configurable: true,
      value: [
        new File([new Uint8Array(MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES + 1)], "brand.png", {
          type: "image/png",
        }),
      ],
    });
    imageInput!.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.element(page.getByText("Choose an image under 1 MB.")).toBeInTheDocument();
    expect(updateClientSettings).toHaveBeenCalledTimes(callsBeforeOversizedImage);

    await expect.element(page.getByText("Accent color")).toBeInTheDocument();
    setColorInput("App accent color", "#dc2626");

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ appAccentColor: "#dc2626" });
    });

    await expect.element(page.getByText("Sidebar color")).toBeInTheDocument();
    setColorInput("Animated sidebar color", "#16a34a");

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ themeAccentColor: "#16a34a" });
    });

    await expect.element(page.getByText("Sidebar search")).toBeInTheDocument();
    await page.getByLabelText("Show sidebar search").click();

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ showSidebarSearch: false });
    });

    await expect
      .element(page.getByRole("heading", { name: "Show sidebar image", exact: true }))
      .toBeInTheDocument();
    await page.getByLabelText("Show sidebar image").click();

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ showSidebarMascot: false });
    });

    await expect.element(page.getByText("Sidebar attribution")).toBeInTheDocument();
    await page.getByLabelText("Show sidebar attribution").click();

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ showSidebarAttribution: false });
    });

    await expect.element(page.getByText("Background animations")).toBeInTheDocument();
    await page.getByLabelText("Keep animations running in background").click();

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ continueBackgroundAnimations: true });
    });

    await expect.element(page.getByText("Sidebar star speed")).toBeInTheDocument();
    await page.getByLabelText("Increase sidebar star speed").click();

    await vi.waitFor(() => {
      expect(updateClientSettings).toHaveBeenCalledWith({ sidebarStarSpeed: 1.25 });
    });
  });

  it("shows detected editor icons in the Files default editor selector", async () => {
    const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;
    const { updateClientSettings } = installClientSettingsNativeApi(desktopBridge);
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      availableEditors: ["vscode", "antigravity", "file-manager"],
    });

    try {
      mounted = await renderWithTestRouter(
        <AppAtomRegistryProvider>
          <FilesSettingsPanel />
        </AppAtomRegistryProvider>,
      );

      await page.getByLabelText("Default editor").click();

      await expect
        .element(page.getByTestId("default-editor-option-vscode-icon"))
        .toBeInTheDocument();
      await expect
        .element(page.getByTestId("default-editor-option-antigravity-icon"))
        .toBeInTheDocument();
      await expect
        .element(page.getByTestId("default-editor-option-file-manager-icon"))
        .toBeInTheDocument();
      await expect.element(page.getByText("Finder", { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText("Cursor", { exact: true })).not.toBeInTheDocument();

      await page.getByText("VS Code", { exact: true }).click();

      await vi.waitFor(() => {
        expect(updateClientSettings).toHaveBeenCalledWith({ defaultEditor: "vscode" });
      });
      await expect
        .element(
          page.getByTestId("default-editor-selected-option").getByText("VS Code", { exact: true }),
        )
        .toBeInTheDocument();
      await expect
        .element(page.getByTestId("default-editor-selected-option-icon"))
        .toBeInTheDocument();
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("creates and shows a pairing link when network access is enabled", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        httpsEnabled: true,
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
      },
    });
    let pairingLinks: Array<AuthAccessSnapshot["pairingLinks"][number]> = [];
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
        issuedAt: "2036-04-07T00:00:00.000Z",
        expiresAt: "2036-05-07T00:00:00.000Z",
        connected: true,
        current: true,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks,
      clientSessions,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/auth/pairing-token") && method === "POST") {
          pairingLinks = [
            makePairingLink({
              id: "pairing-link-1",
              credential: "pairing-token",
              role: "client",
              subject: "one-time-token",
              label: "Julius iPhone",
              createdAt: "2036-04-07T00:00:00.000Z",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
          ];
          clientSessions = [
            ...clientSessions,
            makeClientSession({
              sessionId: "session-client",
              subject: "one-time-token",
              role: "client",
              method: "browser-session-cookie",
              client: {
                label: "Julius iPhone",
                deviceType: "mobile",
                os: "iOS",
                browser: "Safari",
                ipAddress: "192.168.1.88",
              },
              issuedAt: "2036-04-07T00:01:00.000Z",
              expiresAt: "2036-05-07T00:01:00.000Z",
              connected: false,
              current: false,
            }),
          ];
          authAccessHarness.setSnapshot({
            pairingLinks,
            clientSessions,
          });
          return new Response(
            JSON.stringify({
              id: "pairing-link-1",
              credential: "pairing-token",
              label: "Julius iPhone",
              expiresAt: "2036-04-10T00:05:00.000Z",
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        throw new Error(`Unhandled fetch ${method} ${url}`);
      }),
    );

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Paired devices")).toBeInTheDocument();
    await expect.element(page.getByText("Revoke others")).toBeInTheDocument();
    await expect.element(page.getByText("This Mac")).toBeInTheDocument();
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    await expect.element(page.getByText("Create pairing link")).toBeInTheDocument();
    await page.getByRole("button", { name: "Create link", exact: true }).click();
    authAccessHarness.emitPairingLinkUpserted(pairingLinks[0]!);
    authAccessHarness.emitClientUpserted(clientSessions[1]!);
    await expect
      .element(page.getByText("Client · Mobile · iOS · Safari · 192.168.1.88"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^Copy pairing URL for:/ }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Revoke others")).toBeInTheDocument();
  });

  it("enables, changes, and disables admin password auth from settings", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        httpsEnabled: true,
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
      },
    });
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions: [],
    });
    let configured = false;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/auth/admin-password") && method === "GET") {
        return new Response(JSON.stringify({ configured }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/admin-password") && method === "POST") {
        configured = true;
        return new Response(JSON.stringify({ configured }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/auth/admin-password/clear") && method === "POST") {
        configured = false;
        return new Response(JSON.stringify({ configured }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unhandled fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Admin password")).toBeInTheDocument();
    const passwordSwitch = page.getByLabelText("Enable password authentication");
    await expect.element(passwordSwitch).not.toBeDisabled();
    await expect.element(passwordSwitch).not.toBeChecked();
    await passwordSwitch.click();
    await expect.element(page.getByText("Enable admin password")).toBeInTheDocument();
    await page
      .getByRole("textbox", { name: "Admin password", exact: true })
      .fill("correct horse battery staple");
    await page
      .getByRole("textbox", { name: "Confirm password", exact: true })
      .fill("correct horse battery staple");
    await page.getByRole("button", { name: "Enable", exact: true }).click();

    await expect.element(passwordSwitch).toBeChecked();
    await expect
      .element(page.getByRole("button", { name: "Change", exact: true }))
      .toBeInTheDocument();

    await passwordSwitch.click();
    await expect.element(page.getByText("Disable password authentication?")).toBeInTheDocument();
    await page.getByRole("button", { name: "Disable", exact: true }).click();

    await expect.element(passwordSwitch).not.toBeChecked();
    await expect
      .element(page.getByRole("button", { name: "Change", exact: true }))
      .not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3773/api/auth/admin-password", {
      body: JSON.stringify({ password: "correct horse battery staple" }),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
  });

  it("revokes all other paired clients from settings", async () => {
    window.desktopBridge = createDesktopBridgeStub({
      serverExposureState: {
        mode: "network-accessible",
        httpsEnabled: true,
        endpointUrl: "http://192.168.1.44:3773",
        advertisedHost: "192.168.1.44",
      },
    });
    let clientSessions: Array<AuthAccessSnapshot["clientSessions"][number]> = [
      makeClientSession({
        sessionId: "session-owner",
        subject: "desktop-bootstrap",
        role: "owner",
        method: "browser-session-cookie",
        client: {
          label: "This Mac",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
        issuedAt: "2036-04-05T00:00:00.000Z",
        expiresAt: "2036-05-05T00:00:00.000Z",
        connected: true,
        current: true,
      }),
      makeClientSession({
        sessionId: "session-client",
        subject: "one-time-token",
        role: "client",
        method: "browser-session-cookie",
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
        issuedAt: "2036-04-05T00:01:00.000Z",
        expiresAt: "2036-05-05T00:01:00.000Z",
        connected: false,
        current: false,
      }),
    ];
    authAccessHarness.setSnapshot({
      pairingLinks: [],
      clientSessions,
    });

    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/auth/clients/revoke-others") && method === "POST") {
        clientSessions = clientSessions.filter((session) => session.current);
        authAccessHarness.setSnapshot({
          pairingLinks: [],
          clientSessions,
        });
        authAccessHarness.emitClientRemoved("session-client");
        return new Response(JSON.stringify({ revokedCount: 1 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unhandled fetch ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Julius iPhone")).toBeInTheDocument();
    await page.getByRole("button", { name: "Revoke others", exact: true }).click();
    await expect.element(page.getByText("This Mac")).toBeInTheDocument();
    await expect.element(page.getByText("Julius iPhone")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("shows a disabled network access toggle with guidance in desktop builds", async () => {
    const desktopBridge = createDesktopBridgeStub();
    window.desktopBridge = desktopBridge;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    const networkAccessToggle = page.getByLabelText("Enable network access");
    await expect.element(networkAccessToggle).not.toBeDisabled();
    await networkAccessToggle.click();
    await expect.element(page.getByText("Enable network access?")).toBeInTheDocument();
    await expect
      .element(
        page.getByText("Cafe Code will restart to expose this environment over the network."),
      )
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Restart and enable", exact: true }).click();
    await vi.waitFor(() => {
      expect(desktopBridge.setServerExposureMode).toHaveBeenCalledWith("network-accessible");
    });
    await expect.element(page.getByText("http://192.168.1.44:3773")).toBeInTheDocument();
  });

  it("toggles desktop HTTPS separately from network access", async () => {
    const setServerHttpsEnabled = vi.fn().mockResolvedValue({
      mode: "local-only",
      httpsEnabled: false,
      endpointUrl: null,
      advertisedHost: null,
    });
    window.desktopBridge = createDesktopBridgeStub({
      setServerHttpsEnabled,
    });

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <ConnectionsSettings />
      </AppAtomRegistryProvider>,
    );

    const httpsSwitch = page.getByLabelText("Enable HTTPS");
    await expect.element(httpsSwitch).toBeChecked();
    await expect
      .element(page.getByRole("link", { name: "Download certificate" }))
      .toBeInTheDocument();
    await httpsSwitch.click();
    await expect.element(page.getByText("Disable HTTPS?")).toBeInTheDocument();
    await expect
      .element(page.getByText("Cafe Code will restart to apply this."))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Restart and disable", exact: true }).click();
    await vi.waitFor(() => {
      expect(setServerHttpsEnabled).toHaveBeenCalledWith(false);
    });
    await expect.element(httpsSwitch).not.toBeChecked();
    await expect
      .element(page.getByRole("link", { name: "Download certificate" }))
      .not.toBeInTheDocument();
  });

  it("opens the logs folder in the preferred editor", async () => {
    const openInEditor = vi.fn<LocalApi["shell"]["openInEditor"]>().mockResolvedValue(undefined);
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      shell: {
        openInEditor,
      },
      server: {
        getProcessDiagnostics: vi.fn().mockResolvedValue({
          serverPid: 1234,
          readAt: makeUtc("2036-04-07T00:00:00.000Z"),
          processCount: 0,
          totalRssBytes: 0,
          totalCpuPercent: 0,
          processes: [],
          error: Option.none(),
        }),
        getProcessResourceHistory: vi
          .fn()
          .mockResolvedValue(createEmptyProcessResourceHistoryResult()),
        getRuntimeLayerDiagnostics: vi
          .fn()
          .mockResolvedValue(createRuntimeLayerDiagnosticsResult()),
        getTraceDiagnostics: vi.fn().mockResolvedValue({
          traceFilePath: "/repo/project/.t3/traces.jsonl",
          scannedFilePaths: ["/repo/project/.t3/traces.jsonl"],
          readAt: makeUtc("2036-04-07T00:00:00.000Z"),
          recordCount: 0,
          parseErrorCount: 0,
          firstSpanAt: Option.none(),
          lastSpanAt: Option.none(),
          failureCount: 0,
          interruptionCount: 0,
          slowSpanThresholdMs: 5_000,
          slowSpanCount: 0,
          logLevelCounts: {},
          topSpansByCount: [],
          slowestSpans: [],
          commonFailures: [],
          latestFailures: [],
          latestWarningAndErrorLogs: [],
          partialFailure: Option.none(),
          error: Option.none(),
        }),
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot(createBaseServerConfig());

    mounted = await render(
      <AppAtomRegistryProvider>
        <DiagnosticsSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const openLogsButton = page.getByLabelText("Open logs folder");
    await expect
      .element(page.getByRole("heading", { name: "Diagnostics", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Runtime overview", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Orchestrator subprocesses", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Provider daemon", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("heading", { name: "Provider supervisor", exact: true }))
      .toBeInTheDocument();
    // The unconfigured supervisor is a neutral layer status, and its section
    // collapses to one quiet line instead of a grid of empty values.
    await expect
      .element(page.getByRole("cell", { name: "Not configured", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "About the provider supervisor" }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Configured", { exact: true })).not.toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Optional provider supervisor is not configured; providers run in the daemon.",
          { exact: true },
        ),
      )
      .toBeInTheDocument();
    await openLogsButton.click();

    expect(openInEditor).toHaveBeenCalledWith("/repo/project/.t3/logs", "cursor");
  });

  it("opens the file-backed system prompt with the configured editor from Chat settings", async () => {
    const config: ServerConfig = {
      ...createBaseServerConfig(),
      availableEditors: ["vscode", "cursor"],
      clientSettings: { ...DEFAULT_CLIENT_SETTINGS, defaultEditor: "cursor" },
    };
    const { openSystemPromptFile, openPath, openInEditor, confirm } =
      installFileSettingsNativeApi(config);
    localStorage.setItem("cafe-code:last-editor", JSON.stringify("vscode"));

    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <ChatSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Open file" }).click();

    await vi.waitFor(() => {
      expect(openSystemPromptFile).toHaveBeenCalledTimes(1);
      expect(openInEditor).toHaveBeenCalledExactlyOnceWith(config.systemPromptPath, "cursor");
      expect(openPath).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it.each([
    "C:\\repo\\project\\.cafe-code-system-prompt.md",
    "/Users/example/project/.cafe-code-system-prompt.md",
    "/home/example/project/.cafe-code-system-prompt.md",
  ])("opens the file-backed system prompt with its system association for %s", async (path) => {
    const { openSystemPromptFile, openPath, openInEditor, confirm } = installFileSettingsNativeApi({
      ...createBaseServerConfig(),
      availableEditors: [],
      systemPromptPath: path,
      clientSettings: { ...DEFAULT_CLIENT_SETTINGS, defaultEditor: "system-default" },
    });
    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <ChatSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Open file" }).click();

    await vi.waitFor(() => {
      expect(openSystemPromptFile).toHaveBeenCalledTimes(1);
      expect(openPath).toHaveBeenCalledExactlyOnceWith(path);
      expect(openInEditor).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  it.each(["system-default", "vscode"] as const)(
    "opens keybindings.json with the configured %s selection",
    async (defaultEditor) => {
      const config: ServerConfig = {
        ...createBaseServerConfig(),
        availableEditors: ["cursor", "vscode"],
        clientSettings: { ...DEFAULT_CLIENT_SETTINGS, defaultEditor },
      };
      const { openPath, openInEditor, confirm } = installFileSettingsNativeApi(config);
      localStorage.setItem("cafe-code:last-editor", JSON.stringify("cursor"));
      mounted = await renderWithTestRouter(
        <AppAtomRegistryProvider>
          <KeybindingsSettingsPanel />
        </AppAtomRegistryProvider>,
      );

      await page.getByRole("button", { name: "Open keybindings.json", exact: true }).click();

      await vi.waitFor(() => {
        expect(confirm).not.toHaveBeenCalled();
        if (defaultEditor === "system-default") {
          expect(openPath).toHaveBeenCalledExactlyOnceWith(config.keybindingsConfigPath);
          expect(openInEditor).not.toHaveBeenCalled();
        } else {
          expect(openInEditor).toHaveBeenCalledExactlyOnceWith(
            config.keybindingsConfigPath,
            "vscode",
          );
          expect(openPath).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each([
    { panel: "system prompt", path: "C:\\repo\\script.cmd", button: "Open file" },
    { panel: "keybindings", path: "/repo/script.sh", button: "Open keybindings.json" },
  ] as const)(
    "does not bypass declined system-association consent from the $panel settings action",
    async ({ panel, path, button }) => {
      const { openPath, openInEditor, confirm } = installFileSettingsNativeApi({
        ...createBaseServerConfig(),
        systemPromptPath: path,
        keybindingsConfigPath: path,
        clientSettings: { ...DEFAULT_CLIENT_SETTINGS, defaultEditor: "system-default" },
      });
      confirm.mockResolvedValue(false);
      mounted = await renderWithTestRouter(
        <AppAtomRegistryProvider>
          {panel === "system prompt" ? <ChatSettingsPanel /> : <KeybindingsSettingsPanel />}
        </AppAtomRegistryProvider>,
      );

      const openButton = page.getByRole("button", { name: button, exact: true });
      await openButton.click();

      await vi.waitFor(() => {
        expect(confirm).toHaveBeenCalledExactlyOnceWith(
          `The system default may run code or launch an application for this path:\n\n${path}\n\nOpen with the system default?`,
        );
      });
      await expect.element(openButton).toBeEnabled();
      expect(openPath).not.toHaveBeenCalled();
      expect(openInEditor).not.toHaveBeenCalled();
    },
  );

  it("opens a potentially runnable system-prompt association only after explicit consent", async () => {
    const path = "/Users/example/review.command";
    const { openPath, openInEditor, confirm } = installFileSettingsNativeApi({
      ...createBaseServerConfig(),
      systemPromptPath: path,
      clientSettings: { ...DEFAULT_CLIENT_SETTINGS, defaultEditor: "system-default" },
    });
    mounted = await renderWithTestRouter(
      <AppAtomRegistryProvider>
        <ChatSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Open file", exact: true }).click();

    await vi.waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(openPath).toHaveBeenCalledExactlyOnceWith(path);
    });
    expect(openInEditor).not.toHaveBeenCalled();
  });

  it("copies the system prompt path when the local shell capability disappears", async () => {
    const config = createBaseServerConfig();
    const { getConfig, openSystemPromptFile, openPath, openInEditor } =
      installFileSettingsNativeApi(config);
    // A cached backend API can outlive the native bridge. It still supplies the
    // prompt path, but cannot grant permission to open applications on this host.
    ensureLocalApi();
    Reflect.deleteProperty(window, "nativeApi");
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    try {
      mounted = await renderWithTestRouter(
        <AppAtomRegistryProvider>
          <ChatSettingsPanel />
        </AppAtomRegistryProvider>,
      );

      await page.getByRole("button", { name: "Copy path", exact: true }).click();

      await vi.waitFor(() => {
        expect(openSystemPromptFile).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledExactlyOnceWith(config.systemPromptPath);
      });
      expect(getConfig).not.toHaveBeenCalled();
      expect(openPath).not.toHaveBeenCalled();
      expect(openInEditor).not.toHaveBeenCalled();
    } finally {
      writeText.mockRestore();
    }
  });

  it("copies keybindings.json in a browser without a local shell bridge", async () => {
    const config = createBaseServerConfig();
    setServerConfigSnapshot(config);
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    try {
      mounted = await renderWithTestRouter(
        <AppAtomRegistryProvider>
          <KeybindingsSettingsPanel />
        </AppAtomRegistryProvider>,
      );

      await page.getByRole("button", { name: "Copy keybindings.json path", exact: true }).click();

      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledExactlyOnceWith(config.keybindingsConfigPath);
      });
      expect(window.nativeApi).toBeUndefined();
      expect(window.desktopBridge).toBeUndefined();
    } finally {
      writeText.mockRestore();
    }
  });

  it("runs one-click provider updates from the provider card", async () => {
    const updateProvider = vi.fn<LocalApi["server"]["updateProvider"]>().mockResolvedValue({
      providers: [createOutdatedProvider("codex")],
    });
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        updateProvider,
      },
    } as unknown as LocalApi;

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createOutdatedProvider("codex")],
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProviderSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Update available — view details" }).click();
    await expect.element(page.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    await page.getByRole("button", { name: "Update now" }).click();

    expect(updateProvider).toHaveBeenCalledWith({
      provider: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
    });
  });

  it("shows every Codex quota bucket and keeps reset availability below the reset schedule", async () => {
    const codexProvider: ServerProvider = {
      ...createOutdatedProvider("codex"),
      accountRateLimits: {
        checkedAt: "2026-07-27T00:00:00.000Z",
        rateLimits: {
          limitId: "codex",
          primary: {
            usedPercent: 25,
            windowDurationMins: 300,
            resetsAt: 1_784_944_800,
          },
          secondary: {
            usedPercent: 50,
            windowDurationMins: 10_080,
            resetsAt: 1_785_549_600,
          },
        },
        rateLimitsByLimitId: {
          codex: {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_784_944_800 },
            secondary: { usedPercent: 50, windowDurationMins: 10_080, resetsAt: 1_785_549_600 },
          },
          additional: {
            limitName: "Additional quota",
            credits: { hasCredits: false, unlimited: false, balance: "0" },
            individualLimit: {
              used: "10",
              limit: "10",
              remainingPercent: 0,
              resetsAt: 1_785_549_600,
            },
            rateLimitReachedType: "workspace_member_usage_limit_reached",
          },
        },
        rateLimitResetCredits: {
          availableCount: 2,
          credits: null,
        },
      },
    };
    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [codexProvider],
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProviderSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect
      .element(page.getByText("Usage limit resets available: 2", { exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Additional quota", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Credits: 0 available", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Credit balance:", { exact: false }))
      .not.toBeInTheDocument();
    // Amount, remaining share and reset share one row for the one limit.
    await expect
      .element(page.getByText("Individual spend limit: 10 used of 10 (0% left)"))
      .toBeVisible();
    await expect
      .element(page.getByText("Limit reached: Workspace member usage limit reached"))
      .toBeVisible();
    expect(document.querySelectorAll('[data-account-quota-bucket="codex"]')).toHaveLength(1);
    await vi.waitFor(() => {
      const lines = Array.from(document.querySelectorAll<HTMLParagraphElement>("p"));
      const availabilityIndex = lines.findIndex(
        (line) => line.textContent === "Usage limit resets available: 2",
      );
      const resetScheduleIndex = lines.findIndex((line) => line.textContent?.includes("7d reset:"));

      expect(availabilityIndex).toBeGreaterThanOrEqual(0);
      expect(resetScheduleIndex).toBeGreaterThanOrEqual(0);
      expect(availabilityIndex).toBeGreaterThan(resetScheduleIndex);
      const availability = lines[availabilityIndex]!;
      expect(availability.parentElement?.lastElementChild).toBe(availability);
    });
  });

  it("keeps long provider update commands inside the fixed-width popover", async () => {
    const longUpdateCommand =
      "npm install -g @anthropic-ai/claude-code@latest --registry=https://registry.npmjs.org --cache=/tmp/t3code-provider-update-cache";

    setServerConfigSnapshot({
      ...createBaseServerConfig(),
      providers: [createOutdatedProvider("codex", longUpdateCommand)],
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <ProviderSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await page.getByRole("button", { name: "Update available — view details" }).click();
    await expect.element(page.getByText(longUpdateCommand)).toBeInTheDocument();

    await vi.waitFor(() => {
      const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]');
      const commandCode = Array.from(document.querySelectorAll<HTMLElement>("code")).find(
        (element) => element.textContent === longUpdateCommand,
      );
      const scrollViewport = commandCode?.closest<HTMLElement>(
        '[data-slot="scroll-area-viewport"]',
      );

      expect(popup).toBeTruthy();
      expect(commandCode).toBeTruthy();
      expect(scrollViewport).toBeTruthy();

      const popupRect = popup!.getBoundingClientRect();
      const viewportRect = scrollViewport!.getBoundingClientRect();

      expect(popupRect.width).toBeGreaterThan(300);
      expect(popupRect.width).toBeLessThanOrEqual(337);
      expect(viewportRect.right).toBeLessThanOrEqual(popupRect.right + 0.5);
      expect(scrollViewport!.scrollWidth).toBeGreaterThan(scrollViewport!.clientWidth);
    });
  });
});

describe("SourceControlSettingsPanel discovery states", () => {
  let mounted:
    | (Awaited<ReturnType<typeof render>> & {
        cleanup?: () => Promise<void>;
        unmount?: () => Promise<void>;
      })
    | null = null;

  beforeEach(async () => {
    resetAppAtomRegistryForTests();
    await __resetLocalApiForTests();
    document.body.innerHTML = "";
  });

  afterEach(async () => {
    if (mounted) {
      const teardown = mounted.cleanup ?? mounted.unmount;
      await teardown?.call(mounted).catch(() => {});
    }
    mounted = null;
    Reflect.deleteProperty(window, "nativeApi");
    document.body.innerHTML = "";
    await __resetLocalApiForTests();
    resetAppAtomRegistryForTests();
  });

  function setSourceControlDiscoveryStub(
    discoverSourceControl: () => Promise<SourceControlDiscoveryResult>,
  ) {
    window.nativeApi = {
      persistence: {
        getClientSettings: vi.fn().mockResolvedValue(null),
        setClientSettings: vi.fn().mockResolvedValue(undefined),
      },
      server: {
        discoverSourceControl,
      },
    } as unknown as LocalApi;
  }

  it("shows skeleton sections while the first source control scan is pending", async () => {
    let finishDiscovery!: (result: SourceControlDiscoveryResult) => void;
    const pendingDiscovery = new Promise<SourceControlDiscoveryResult>((resolve) => {
      finishDiscovery = resolve;
    });
    setSourceControlDiscoveryStub(() => pendingDiscovery);

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Version control", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("Source control providers", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Rescan server environment" }))
      .toBeDisabled();
    await expect.element(page.getByText("Nothing detected yet")).not.toBeInTheDocument();

    finishDiscovery({ versionControlSystems: [], sourceControlProviders: [] });
    await expect.element(page.getByText("Nothing detected yet")).toBeInTheDocument();
  });

  it("uses the shared empty state when discovery completes without tools", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [],
      sourceControlProviders: [],
    }));

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByText("Nothing detected yet")).toBeInTheDocument();
    await expect
      .element(page.getByText("Install Git on the server, then rescan."))
      .toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Scan" })).toBeInTheDocument();
  });

  it("keeps discovered rows instead of showing the empty state", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          status: "available",
          version: Option.some("git version 2.50.0"),
          installHint: "Install Git.",
          detail: Option.none(),
        },
      ],
      sourceControlProviders: [],
    }));

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByRole("switch", { name: "Git availability" })).toBeDisabled();
    await expect.element(page.getByText("Nothing detected yet")).not.toBeInTheDocument();
  });

  it("shows Git fetch interval settings inside the Git details dropdown", async () => {
    setSourceControlDiscoveryStub(async () => ({
      versionControlSystems: [
        {
          kind: "git",
          label: "Git",
          executable: "git",
          status: "available",
          version: Option.some("git version 2.50.0"),
          installHint: "Install Git.",
          detail: Option.none(),
        },
      ],
      sourceControlProviders: [],
    }));

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    const toggle = page.getByRole("button", { name: "Toggle Git details" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();

    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(page.getByLabelText("Automatic Git fetch interval in seconds"))
      .toBeVisible();
    await expect
      .element(page.getByText("Automatic Git fetches run every 30 seconds"))
      .not.toBeInTheDocument();
  });

  it("does not rescan on remount while the discovery atom is fresh", async () => {
    let calls = 0;
    setSourceControlDiscoveryStub(async () => {
      calls += 1;
      return {
        versionControlSystems: [
          {
            kind: "git",
            label: "Git",
            executable: "git",
            status: "available",
            version: Option.some("git version 2.50.0"),
            installHint: "Install Git.",
            detail: Option.none(),
          },
        ],
        sourceControlProviders: [],
      };
    });

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByRole("switch", { name: "Git availability" })).toBeDisabled();
    expect(calls).toBe(1);

    const teardown = mounted.cleanup ?? mounted.unmount;
    await teardown?.call(mounted).catch(() => {});
    mounted = null;
    document.body.innerHTML = "";

    mounted = await render(
      <AppAtomRegistryProvider>
        <SourceControlSettingsPanel />
      </AppAtomRegistryProvider>,
    );

    await expect.element(page.getByRole("switch", { name: "Git availability" })).toBeDisabled();
    expect(calls).toBe(1);
  });
});
