import { QueryClient } from "@tanstack/react-query";
import { EnvironmentId } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateEnvironmentConnection = vi.fn();
const mockCreateWsRpcClient = vi.fn();
const mockFetchRemoteSessionState = vi.fn();
const mockWaitForSavedEnvironmentRegistryHydration = vi.fn();
const mockListSavedEnvironmentRecords = vi.fn();
const mockSavedEnvironmentRegistrySubscribe = vi.fn();
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn();

function MockWsTransport() {
  return undefined;
}

vi.mock("../primary", () => ({
  getPrimaryKnownEnvironment: vi.fn(() => ({
    id: "env-1",
    label: "Primary environment",
    source: "window-origin",
    target: {
      httpBaseUrl: "http://127.0.0.1:3000/",
      wsBaseUrl: "ws://127.0.0.1:3000/",
    },
    environmentId: EnvironmentId.make("env-1"),
  })),
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: vi.fn(),
  fetchRemoteEnvironmentDescriptor: vi.fn(),
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  resolveRemoteWebSocketConnectionUrl: vi.fn(() => "ws://remote.example.test"),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(() => true),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: vi.fn(),
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken: vi.fn(),
  useSavedEnvironmentRegistryStore: {
    subscribe: mockSavedEnvironmentRegistrySubscribe,
    getState: () => ({
      upsert: vi.fn(),
      remove: vi.fn(),
      markConnected: vi.fn(),
      rename: vi.fn(),
    }),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: vi.fn(),
      clear: vi.fn(),
    }),
  },
  waitForSavedEnvironmentRegistryHydration: mockWaitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken: vi.fn(),
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: mockCreateWsRpcClient,
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: MockWsTransport,
}));

vi.mock("~/composerDraftStore", () => ({
  markPromotedDraftThreadByRef: vi.fn(),
  markPromotedDraftThreadsByRef: vi.fn(),
  useComposerDraftStore: {
    getState: () => ({
      getDraftThreadByRef: vi.fn(() => null),
      clearDraftThread: vi.fn(),
    }),
  },
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: vi.fn(() => ({
    persistence: {
      setSavedEnvironmentRegistry: vi.fn(async () => undefined),
    },
  })),
}));

vi.mock("~/orchestrationEventEffects", () => ({
  deriveOrchestrationBatchEffects: vi.fn(() => ({
    promotedThreadRefs: [],
    invalidatedProviderState: false,
  })),
}));

vi.mock("~/lib/projectReactQuery", () => ({
  projectQueryKeys: {
    all: ["projects"],
  },
}));

vi.mock("~/lib/providerReactQuery", () => ({
  providerQueryKeys: {
    all: ["providers"],
  },
}));

vi.mock("~/store", () => ({
  useStore: {
    getState: () => ({
      syncServerShellSnapshot: vi.fn(),
      syncServerThreadDetail: vi.fn(),
      removeServerThreadDetail: vi.fn(),
      applyServerShellEvent: vi.fn(),
    }),
  },
  selectProjectsAcrossEnvironments: vi.fn(() => []),
  selectSidebarThreadSummaryByRef: vi.fn(() => null),
  selectThreadByRef: vi.fn(() => null),
  selectThreadsAcrossEnvironments: vi.fn(() => []),
}));

vi.mock("~/uiStateStore", () => ({
  useUiStateStore: {
    getState: () => ({
      clearThreadUi: vi.fn(),
      syncPromotedDraftThreadRefs: vi.fn(),
    }),
  },
}));

const savedRecord = {
  environmentId: EnvironmentId.make("env-saved"),
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.test/",
  wsBaseUrl: "wss://remote.example.test/",
};

const configSnapshot = {
  environment: {
    environmentId: savedRecord.environmentId,
    label: "Remote environment",
  },
};

function createClient() {
  return {
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    server: {
      getConfig: vi.fn(async () => configSnapshot),
      subscribeConfig: vi.fn(() => () => undefined),
      subscribeLifecycle: vi.fn(() => () => undefined),
      subscribeAuthAccess: vi.fn(() => () => undefined),
      refreshProviders: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
      getClientSettings: vi.fn(async () => undefined),
      updateClientSettings: vi.fn(async () => undefined),
    },
    orchestration: {
      subscribeShell: vi.fn(() => () => undefined),
      subscribeThread: vi.fn(() => () => undefined),
      dispatchCommand: vi.fn(async () => undefined),
      repairAssistantMessageFromProviderJournal: vi.fn(async () => ({
        status: "failed",
        threadId: "thread-test",
        messageId: "message-test",
      })),
      repairThreadAssistantMessages: vi.fn(async () => ({
        threadId: "thread-test",
        sourcePolicy: "local-then-upstream",
        counts: {
          totalMessages: 0,
          eligibleMessages: 0,
          localAttempts: 0,
          upstreamAttempts: 0,
          repaired: 0,
          unchanged: 0,
          notEligible: 0,
          sourceNotFound: 0,
          ambiguousSource: 0,
          diverged: 0,
          upstreamUnavailable: 0,
          failed: 0,
        },
        results: [],
      })),
    },
    projects: {
      searchEntries: vi.fn(async () => []),
      writeFile: vi.fn(async () => undefined),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
    },
    git: {
      pull: vi.fn(async () => undefined),
      refreshStatus: vi.fn(async () => undefined),
      onStatus: vi.fn(() => () => undefined),
      listBranches: vi.fn(async () => []),
      createWorktree: vi.fn(async () => undefined),
      removeWorktree: vi.fn(async () => undefined),
      createBranch: vi.fn(async () => undefined),
      checkout: vi.fn(async () => undefined),
      init: vi.fn(async () => undefined),
      resolvePullRequest: vi.fn(async () => undefined),
      preparePullRequestThread: vi.fn(async () => undefined),
    },
  };
}

describe("saved environment startup", () => {
  let savedConnectionCreated: Promise<void>;
  let signalSavedConnectionCreated: () => void;
  let remoteSessionStateRequested: Promise<void>;
  let signalRemoteSessionStateRequested: () => void;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    savedConnectionCreated = new Promise<void>((resolve) => {
      signalSavedConnectionCreated = resolve;
    });
    remoteSessionStateRequested = new Promise<void>((resolve) => {
      signalRemoteSessionStateRequested = resolve;
    });

    mockFetchRemoteSessionState.mockImplementation(async () => {
      signalRemoteSessionStateRequested();
      return {
        authenticated: true,
        role: "owner",
      };
    });
    mockGetSavedEnvironmentRecord.mockImplementation((environmentId: EnvironmentId) =>
      environmentId === savedRecord.environmentId ? savedRecord : null,
    );
    mockListSavedEnvironmentRecords.mockReturnValue([savedRecord]);
    mockSavedEnvironmentRegistrySubscribe.mockReturnValue(() => undefined);
    mockWaitForSavedEnvironmentRegistryHydration.mockResolvedValue(undefined);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("saved-bearer-token");
    mockCreateWsRpcClient.mockImplementation(() => createClient());
    mockCreateEnvironmentConnection.mockImplementation((input) => {
      if (input.kind === "saved") {
        queueMicrotask(() => {
          input.onConfigSnapshot?.(configSnapshot);
        });
        signalSavedConnectionCreated();
      }

      return {
        kind: input.kind,
        environmentId: input.knownEnvironment.environmentId,
        knownEnvironment: input.knownEnvironment,
        client: input.client,
        ensureBootstrapped: vi.fn(async () => undefined),
        reconnect: vi.fn(async () => undefined),
        dispose: vi.fn(async () => undefined),
      };
    });
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
  });

  it("uses the initial config snapshot instead of issuing an extra getConfig call", async () => {
    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    await savedConnectionCreated;
    await remoteSessionStateRequested;

    const savedConnectionCall = mockCreateEnvironmentConnection.mock.calls.find(
      ([input]) => input.kind === "saved",
    );
    expect(savedConnectionCall).toBeDefined();

    const savedClient = savedConnectionCall?.[0]?.client;
    expect(savedClient.server.getConfig).not.toHaveBeenCalled();
    expect(mockFetchRemoteSessionState).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });

  it("coalesces hydration and registry sync so the initial saved connection only starts once", async () => {
    let finishHydration!: () => void;
    let finishTokenRead!: (token: string) => void;
    let signalTokenReadStarted!: () => void;
    const tokenReadStarted = new Promise<void>((resolve) => {
      signalTokenReadStarted = resolve;
    });

    mockWaitForSavedEnvironmentRegistryHydration.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishHydration = () => resolve();
        }),
    );
    mockReadSavedEnvironmentBearerToken.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishTokenRead = resolve;
          signalTokenReadStarted();
        }),
    );

    const { startEnvironmentConnectionService, resetEnvironmentServiceForTests } =
      await import("./service");

    const stop = startEnvironmentConnectionService(new QueryClient());
    const registryListener = mockSavedEnvironmentRegistrySubscribe.mock.calls[0]?.[0];
    expect(registryListener).toBeTypeOf("function");

    registryListener?.();
    finishHydration();
    await tokenReadStarted;
    expect(mockReadSavedEnvironmentBearerToken).toHaveBeenCalledTimes(1);

    finishTokenRead("saved-bearer-token");
    await savedConnectionCreated;
    await remoteSessionStateRequested;

    const savedConnectionCalls = mockCreateEnvironmentConnection.mock.calls.filter(
      ([input]) => input.kind === "saved",
    );
    expect(savedConnectionCalls).toHaveLength(1);
    expect(mockFetchRemoteSessionState).toHaveBeenCalledTimes(1);

    stop();
    await resetEnvironmentServiceForTests();
  });
});
