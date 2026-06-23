import {
  CommandId,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  type DesktopBridge,
  EnvironmentId,
  type VcsStatusResult,
  ProjectId,
  type OrchestrationShellStreamItem,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ContextMenuItem } from "@cafecode/contracts";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const shellStreamListeners = new Set<(event: OrchestrationShellStreamItem) => void>();
const gitStatusListeners = new Set<(event: VcsStatusResult) => void>();

const rpcClientMock = {
  dispose: vi.fn(),
  projects: {
    searchEntries: vi.fn(),
    writeFile: vi.fn(),
  },
  filesystem: {
    browse: vi.fn(),
  },
  sourceControl: {
    lookupRepository: vi.fn(),
    cloneRepository: vi.fn(),
  },
  shell: {
    openInEditor: vi.fn(),
    openTerminal: vi.fn(),
  },
  vcs: {
    pull: vi.fn(),
    refreshStatus: vi.fn(),
    onStatus: vi.fn((input: { cwd: string }, listener: (event: VcsStatusResult) => void) =>
      registerListener(gitStatusListeners, listener),
    ),
    listRefs: vi.fn(),
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    createRef: vi.fn(),
    switchRef: vi.fn(),
    init: vi.fn(),
  },
  git: {
    resolvePullRequest: vi.fn(),
    preparePullRequestThread: vi.fn(),
  },
  server: {
    getConfig: vi.fn(),
    refreshProviders: vi.fn(),
    loginProvider: vi.fn(),
    updateProvider: vi.fn(),
    restartProviderRuntime: vi.fn(),
    openSystemPromptFile: vi.fn(),
    upsertKeybinding: vi.fn(),
    removeKeybinding: vi.fn(),
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    getClientSettings: vi.fn(),
    updateClientSettings: vi.fn(),
    subscribeConfig: vi.fn(),
    subscribeLifecycle: vi.fn(),
    subscribeAuthAccess: vi.fn(),
  },
  orchestration: {
    dispatchCommand: vi.fn(),
    getThreadTurnActivityPage: vi.fn(),
    hardDeleteThread: vi.fn(),
    repairAssistantMessageFromProviderJournal: vi.fn(),
    repairThreadAssistantMessages: vi.fn(),
    subscribeShell: vi.fn((listener: (event: OrchestrationShellStreamItem) => void) =>
      registerListener(shellStreamListeners, listener),
    ),
    subscribeThread: vi.fn(() => () => undefined),
  },
};

vi.mock("./environments/runtime", () => ({
  getPrimaryEnvironmentConnection: () => ({
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Primary",
      source: "manual" as const,
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
      environmentId: EnvironmentId.make("environment-local"),
    },
    client: rpcClientMock,
    environmentId: EnvironmentId.make("environment-local"),
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  }),
  resetEnvironmentServiceForTests: vi.fn(),
}));

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
}));

function emitEvent<T>(listeners: Set<(event: T) => void>, event: T) {
  for (const listener of listeners) {
    listener(event);
  }
}

function getWindowForTest(): Window & typeof globalThis & { desktopBridge?: unknown } {
  const testGlobal = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis & { desktopBridge?: unknown };
  };
  if (!testGlobal.window) {
    testGlobal.window = {} as Window & typeof globalThis & { desktopBridge?: unknown };
  }
  return testGlobal.window;
}

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function makeDesktopBridge(overrides: Partial<DesktopBridge> = {}): DesktopBridge {
  return {
    getAppBranding: () => null,
    getLocalEnvironmentBootstrap: () => null,
    getDebugEndpointState: async () => ({ enabled: false, url: null }),
    publishDebugSnapshot: async () => undefined,
    getClientSettings: async () => null,
    setClientSettings: async () => undefined,
    setPowerSaveBlockerState: async () => undefined,
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
    onMenuAction: () => () => undefined,
    getUpdateState: async () => {
      throw new Error("getUpdateState not implemented in test");
    },
    setUpdateChannel: async () => {
      throw new Error("setUpdateChannel not implemented in test");
    },
    checkForUpdate: async () => {
      throw new Error("checkForUpdate not implemented in test");
    },
    downloadUpdate: async () => {
      throw new Error("downloadUpdate not implemented in test");
    },
    installUpdate: async () => {
      throw new Error("installUpdate not implemented in test");
    },
    onUpdateState: () => () => undefined,
    getSourceUpdateState: async () => ({
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
    }),
    checkSourceUpdate: async () => ({
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
    }),
    onSourceUpdateState: () => () => undefined,
    ...overrides,
  };
}

const defaultProviders: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
];

const baseEnvironment = {
  environmentId: EnvironmentId.make("environment-local"),
  label: "Local environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};

const baseServerConfig: ServerConfig = {
  environment: baseEnvironment,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-session-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/.config/keybindings.json",
  systemPromptPath: "/tmp/workspace/.config/system-prompt.md",
  keybindings: [],
  issues: [],
  providers: defaultProviders,
  availableEditors: ["cursor"],
  observability: {
    logsDirectoryPath: "/tmp/workspace/.config/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
  clientSettings: DEFAULT_CLIENT_SETTINGS,
};

const baseGitStatus: VcsStatusResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/streamed",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  showContextMenuFallbackMock.mockReset();
  shellStreamListeners.clear();
  gitStatusListeners.clear();
  const testWindow = getWindowForTest();
  Reflect.deleteProperty(testWindow, "desktopBridge");
  Object.defineProperty(testWindow, "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
  Object.defineProperty(testWindow, "sessionStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wsApi", () => {
  it("forwards server config fetches directly to the RPC client", async () => {
    rpcClientMock.server.getConfig.mockResolvedValue(baseServerConfig);
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.getConfig()).resolves.toEqual(baseServerConfig);
    expect(rpcClientMock.server.getConfig).toHaveBeenCalledWith();
    expect(rpcClientMock.server.subscribeConfig).not.toHaveBeenCalled();
    expect(rpcClientMock.server.subscribeLifecycle).not.toHaveBeenCalled();
  });

  it("forwards client settings requests directly to the RPC client", async () => {
    rpcClientMock.server.getClientSettings.mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    rpcClientMock.server.updateClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      brandWordmarkPrefix: "Synced",
    });
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.getClientSettings()).resolves.toEqual(DEFAULT_CLIENT_SETTINGS);
    await expect(
      api.server.updateClientSettings({ brandWordmarkPrefix: "Synced" }),
    ).resolves.toEqual({
      ...DEFAULT_CLIENT_SETTINGS,
      brandWordmarkPrefix: "Synced",
    });
    expect(rpcClientMock.server.getClientSettings).toHaveBeenCalledWith();
    expect(rpcClientMock.server.updateClientSettings).toHaveBeenCalledWith({
      brandWordmarkPrefix: "Synced",
    });
  });

  it("forwards shell stream events", async () => {
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    const onShellEvent = vi.fn();

    api.orchestration.subscribeShell(onShellEvent);

    const shellEvent = {
      kind: "project-upserted" as const,
      sequence: 1,
      project: {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/workspace",
        additionalWorkspaceRoots: [],
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt: "2026-02-24T00:00:00.000Z",
        updatedAt: "2026-02-24T00:00:00.000Z",
      },
    } satisfies OrchestrationShellStreamItem;
    emitEvent(shellStreamListeners, shellEvent);

    expect(onShellEvent).toHaveBeenCalledWith(shellEvent);
  });

  it("forwards terminal launch requests directly to the RPC client", async () => {
    rpcClientMock.shell.openTerminal.mockResolvedValue(undefined);
    getWindowForTest().desktopBridge = makeDesktopBridge();
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);

    await expect(api.shell.openTerminal("/tmp/project")).resolves.toBeUndefined();
    expect(rpcClientMock.shell.openTerminal).toHaveBeenCalledWith({ cwd: "/tmp/project" });
  });

  it("does not proxy browser terminal launches to the backend host", async () => {
    rpcClientMock.shell.openTerminal.mockResolvedValue(undefined);
    Reflect.deleteProperty(getWindowForTest(), "desktopBridge");
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);

    await expect(api.shell.openTerminal("/tmp/project")).rejects.toThrow(
      "only available in the desktop app",
    );
    expect(rpcClientMock.shell.openTerminal).not.toHaveBeenCalled();
  });

  it("forwards git status stream events", async () => {
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    const onStatus = vi.fn();

    api.vcs.onStatus({ cwd: "/repo" }, onStatus);

    const gitStatus = baseGitStatus;
    emitEvent(gitStatusListeners, gitStatus);

    expect(rpcClientMock.vcs.onStatus).toHaveBeenCalledWith({ cwd: "/repo" }, onStatus, undefined);
    expect(onStatus).toHaveBeenCalledWith(gitStatus);
  });

  it("forwards git status refreshes directly to the RPC client", async () => {
    rpcClientMock.vcs.refreshStatus.mockResolvedValue(baseGitStatus);
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);

    await api.vcs.refreshStatus({ cwd: "/repo" });

    expect(rpcClientMock.vcs.refreshStatus).toHaveBeenCalledWith({ cwd: "/repo" });
  });

  it("forwards shell stream subscription options to the RPC client", async () => {
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    const onShellEvent = vi.fn();
    const onResubscribe = vi.fn();

    api.orchestration.subscribeShell(onShellEvent, { onResubscribe });

    expect(rpcClientMock.orchestration.subscribeShell).toHaveBeenCalledWith(onShellEvent, {
      onResubscribe,
    });
  });

  it("sends orchestration dispatch commands as the direct RPC payload", async () => {
    rpcClientMock.orchestration.dispatchCommand.mockResolvedValue({ sequence: 1 });
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    const command = {
      type: "project.create",
      commandId: CommandId.make("cmd-1"),
      projectId: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt: "2026-02-24T00:00:00.000Z",
    } as const;
    await api.orchestration.dispatchCommand(command);

    expect(rpcClientMock.orchestration.dispatchCommand).toHaveBeenCalledWith(command);
  });

  it("forwards workspace file writes to the project RPC", async () => {
    rpcClientMock.projects.writeFile.mockResolvedValue({ relativePath: "plan.md" });
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    await api.projects.writeFile({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });

    expect(rpcClientMock.projects.writeFile).toHaveBeenCalledWith({
      cwd: "/tmp/project",
      relativePath: "plan.md",
      contents: "# Plan\n",
    });
  });

  it("forwards filesystem browse requests to the RPC client", async () => {
    rpcClientMock.filesystem.browse.mockResolvedValue({
      parentPath: "/tmp/project/",
      entries: [],
    });
    const { createEnvironmentApi } = await import("./environmentApi");

    const api = createEnvironmentApi(rpcClientMock as never);
    await api.filesystem.browse({
      partialPath: "/tmp/project/",
      cwd: "/tmp/project",
    });

    expect(rpcClientMock.filesystem.browse).toHaveBeenCalledWith({
      partialPath: "/tmp/project/",
      cwd: "/tmp/project",
    });
  });

  it("forwards provider refreshes directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    rpcClientMock.server.refreshProviders.mockResolvedValue({ providers: nextProviders });
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.refreshProviders()).resolves.toEqual({ providers: nextProviders });
    expect(rpcClientMock.server.refreshProviders).toHaveBeenCalledWith();
  });

  it("forwards provider updates directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        updateState: {
          status: "succeeded",
          startedAt: "2026-01-03T00:00:00.000Z",
          finishedAt: "2026-01-03T00:00:01.000Z",
          message: "Provider updated.",
          output: null,
        },
      },
    ];
    rpcClientMock.server.updateProvider.mockResolvedValue({ providers: nextProviders });
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(
      api.server.updateProvider({ provider: ProviderDriverKind.make("codex") }),
    ).resolves.toEqual({
      providers: nextProviders,
    });
    expect(rpcClientMock.server.updateProvider).toHaveBeenCalledWith({
      provider: ProviderDriverKind.make("codex"),
    });
  });

  it("forwards provider login launches directly to the RPC client", async () => {
    const loginResult = {
      instanceId: ProviderInstanceId.make("codex"),
      provider: ProviderDriverKind.make("codex"),
      command: "codex login",
      message: "Opened codex login in PowerShell.",
    };
    rpcClientMock.server.loginProvider.mockResolvedValue(loginResult);
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(
      api.server.loginProvider({ instanceId: ProviderInstanceId.make("codex") }),
    ).resolves.toEqual(loginResult);
    expect(rpcClientMock.server.loginProvider).toHaveBeenCalledWith({
      instanceId: ProviderInstanceId.make("codex"),
    });
  });

  it("forwards provider runtime restarts directly to the RPC client", async () => {
    const nextProviders: ReadonlyArray<ServerProvider> = [
      {
        ...defaultProviders[0]!,
        checkedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    const restartResult = {
      providers: nextProviders,
      instanceId: ProviderInstanceId.make("codex"),
      provider: ProviderDriverKind.make("codex"),
      stoppedSessionCount: 2,
    };
    rpcClientMock.server.restartProviderRuntime.mockResolvedValue(restartResult);
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(
      api.server.restartProviderRuntime({ instanceId: ProviderInstanceId.make("codex") }),
    ).resolves.toEqual(restartResult);
    expect(rpcClientMock.server.restartProviderRuntime).toHaveBeenCalledWith({
      instanceId: ProviderInstanceId.make("codex"),
    });
  });

  it("forwards system prompt file open requests directly to the RPC client", async () => {
    const result = { path: "/tmp/workspace/.config/system-prompt.md" };
    rpcClientMock.server.openSystemPromptFile.mockResolvedValue(result);
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.openSystemPromptFile()).resolves.toEqual(result);
    expect(rpcClientMock.server.openSystemPromptFile).toHaveBeenCalledWith();
  });

  it("forwards server settings updates directly to the RPC client", async () => {
    const nextSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      enableAssistantStreaming: true,
    };
    rpcClientMock.server.updateSettings.mockResolvedValue(nextSettings);
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);

    await expect(api.server.updateSettings({ enableAssistantStreaming: true })).resolves.toEqual(
      nextSettings,
    );
    expect(rpcClientMock.server.updateSettings).toHaveBeenCalledWith({
      enableAssistantStreaming: true,
    });
  });

  it("forwards context menu metadata to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    getWindowForTest().desktopBridge = makeDesktopBridge({ showContextMenu });

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);
    const items = [{ id: "delete", label: "Delete" }] as const;

    await expect(api.contextMenu.show(items)).resolves.toBe("delete");
    expect(showContextMenu).toHaveBeenCalledWith(items, undefined);
  });

  it("forwards folder picker options to the desktop bridge", async () => {
    const pickFolder = vi.fn().mockResolvedValue("/tmp/project");
    getWindowForTest().desktopBridge = makeDesktopBridge({ pickFolder });

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);

    await expect(api.dialogs.pickFolder({ initialPath: "/tmp/workspace" })).resolves.toBe(
      "/tmp/project",
    );
    expect(pickFolder).toHaveBeenCalledWith({ initialPath: "/tmp/workspace" });
  });

  it("falls back to the browser context menu helper when the desktop bridge is missing", async () => {
    showContextMenuFallbackMock.mockResolvedValue("rename");
    const { createLocalApi } = await import("./localApi");

    const api = createLocalApi(rpcClientMock as never);
    const items = [{ id: "rename", label: "Rename" }] as const;

    await expect(api.contextMenu.show(items, { x: 4, y: 5 })).resolves.toBe("rename");
    expect(showContextMenuFallbackMock).toHaveBeenCalledWith(items, { x: 4, y: 5 });
  });

  it("reads and writes persistence through the desktop bridge when available", async () => {
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      autoOpenPlanSidebar: false,
      confirmThreadArchive: true,
      confirmThreadDelete: false,
      dismissedProviderUpdateNotificationKeys: [],
      diffIgnoreWhitespace: true,
      diffWordWrap: true,
      continueBackgroundAnimations: false,
      showSidebarMascot: true,
      themeAccentColor: "",
      appAccentColor: "",
      defaultEditor: "system-default" as const,
      favorites: [],
      providerModelPreferences: {},
      powerSaveBlockerMode: "off" as const,
      sidebarProjectGroupingMode: "repository_path" as const,
      sidebarProjectGroupingOverrides: {
        "environment-local:/tmp/project": "separate" as const,
      },
      sidebarProjectSortOrder: "manual" as const,
      sidebarThreadSortOrder: "created_at" as const,
      sidebarThreadPreviewCount: 6,
      timestampFormat: "24-hour" as const,
    };
    const getClientSettings = vi.fn().mockResolvedValue({
      ...clientSettings,
    });
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    getWindowForTest().desktopBridge = makeDesktopBridge({
      getClientSettings,
      setClientSettings,
    });

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);

    await api.persistence.getClientSettings();
    await api.persistence.setClientSettings(clientSettings);

    expect(getClientSettings).toHaveBeenCalledWith();
    expect(setClientSettings).toHaveBeenCalledWith(clientSettings);
  });

  it("falls back to browser client settings and removes legacy saved environments", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      autoOpenPlanSidebar: false,
      confirmThreadArchive: true,
      confirmThreadDelete: false,
      dismissedProviderUpdateNotificationKeys: [],
      diffIgnoreWhitespace: true,
      diffWordWrap: true,
      continueBackgroundAnimations: false,
      showSidebarMascot: true,
      themeAccentColor: "",
      appAccentColor: "",
      defaultEditor: "system-default" as const,
      favorites: [],
      providerModelPreferences: {},
      powerSaveBlockerMode: "off" as const,
      sidebarProjectGroupingMode: "repository_path" as const,
      sidebarProjectGroupingOverrides: {
        "environment-local:/tmp/project": "separate" as const,
      },
      sidebarProjectSortOrder: "manual" as const,
      sidebarThreadSortOrder: "created_at" as const,
      sidebarThreadPreviewCount: 6,
      timestampFormat: "24-hour" as const,
    };

    getWindowForTest().localStorage.setItem(
      "cafe-code:saved-environment-registry:v1",
      JSON.stringify({ records: [{ environmentId: "environment-local" }] }),
    );
    getWindowForTest().sessionStorage.setItem(
      "cafe-code:saved-environment-session-secrets:v1",
      JSON.stringify({ secrets: { "environment-local": "bearer-token" } }),
    );

    await api.persistence.setClientSettings(clientSettings);

    await expect(api.persistence.getClientSettings()).resolves.toEqual(clientSettings);
    expect(getWindowForTest().localStorage.getItem("cafe-code:saved-environment-registry:v1")).toBe(
      null,
    );
    expect(
      getWindowForTest().sessionStorage.getItem("cafe-code:saved-environment-session-secrets:v1"),
    ).toBe(null);
  });

  it("removes legacy browser-persisted saved environment bearer tokens", async () => {
    getWindowForTest().localStorage.setItem(
      "cafecode:saved-environment-registry:v1",
      JSON.stringify({
        version: 1,
        records: [
          {
            environmentId: "environment-legacy",
            label: "Legacy",
            httpBaseUrl: "http://localhost:3000",
            wsBaseUrl: "ws://localhost:3000",
            createdAt: "2026-04-09T00:00:00.000Z",
            lastConnectedAt: null,
            bearerToken: "legacy-bearer-token",
          },
        ],
      }),
    );

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi(rpcClientMock as never);

    await api.persistence.getClientSettings();

    expect(getWindowForTest().localStorage.getItem("cafecode:saved-environment-registry:v1")).toBe(
      null,
    );
    expect(getWindowForTest().localStorage.getItem("cafe-code:saved-environment-registry:v1")).toBe(
      null,
    );
  });
});
