import { EnvironmentId } from "@cafecode/contracts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let mockSavedRecords: Array<Record<string, unknown>> = [];

const mockResolveRemotePairingTarget = vi.fn();
const mockFetchRemoteEnvironmentDescriptor = vi.fn();
const mockBootstrapRemoteBearerSession = vi.fn();
const mockFetchRemoteSessionState = vi.fn();
const mockIsRemoteEnvironmentAuthHttpError = vi.fn((_: unknown) => false);
const mockResolveRemoteWebSocketConnectionUrl = vi.fn();
const mockPersistSavedEnvironmentRecord = vi.fn();
const mockWriteSavedEnvironmentBearerToken = vi.fn();
const mockSetSavedEnvironmentRegistry = vi.fn();
const mockGetSavedEnvironmentRecord = vi.fn((environmentId: EnvironmentId) => {
  return mockSavedRecords.find((record) => record.environmentId === environmentId) ?? null;
});
const mockReadSavedEnvironmentBearerToken = vi.fn();
const mockRemoveSavedEnvironmentBearerToken = vi.fn();
const mockPatchRuntime = vi.fn();
const mockClearRuntime = vi.fn();
const mockRegistrySetState = vi.fn((next: { byId: Record<string, Record<string, unknown>> }) => {
  mockSavedRecords = Object.values(next.byId);
});
const mockRemove = vi.fn((environmentId: EnvironmentId) => {
  mockSavedRecords = mockSavedRecords.filter((record) => record.environmentId !== environmentId);
});
const mockMarkConnected = vi.fn((environmentId: EnvironmentId, connectedAt: string) => {
  mockSavedRecords = mockSavedRecords.map((record) =>
    record.environmentId === environmentId ? { ...record, lastConnectedAt: connectedAt } : record,
  );
});
const mockRename = vi.fn((environmentId: EnvironmentId, label: string) => {
  mockSavedRecords = mockSavedRecords.map((record) =>
    record.environmentId === environmentId ? { ...record, label } : record,
  );
});
const mockUpsert = vi.fn((record: Record<string, unknown>) => {
  mockSavedRecords = [
    ...mockSavedRecords.filter((entry) => entry.environmentId !== record.environmentId),
    record,
  ];
});
const mockListSavedEnvironmentRecords = vi.fn(() => mockSavedRecords);
const mockToPersistedSavedEnvironmentRecord = vi.fn((record) => record);
const mockCreateEnvironmentConnection = vi.fn();
const mockClientGetConfig = vi.fn(async () => ({
  environment: {
    environmentId: EnvironmentId.make("environment-1"),
    label: "Remote environment",
  },
}));

vi.mock("../remote/target", () => ({
  resolveRemotePairingTarget: mockResolveRemotePairingTarget,
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: mockBootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor: mockFetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: mockIsRemoteEnvironmentAuthHttpError,
  resolveRemoteWebSocketConnectionUrl: mockResolveRemoteWebSocketConnectionUrl,
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      setSavedEnvironmentRegistry: mockSetSavedEnvironmentRegistry,
    },
  }),
}));

vi.mock("./catalog", () => ({
  getSavedEnvironmentRecord: mockGetSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated: vi.fn(),
  listSavedEnvironmentRecords: mockListSavedEnvironmentRecords,
  persistSavedEnvironmentRecord: mockPersistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken: mockReadSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken: mockRemoveSavedEnvironmentBearerToken,
  toPersistedSavedEnvironmentRecord: mockToPersistedSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore: {
    getState: () => ({
      upsert: mockUpsert,
      remove: mockRemove,
      markConnected: mockMarkConnected,
      rename: mockRename,
    }),
    setState: mockRegistrySetState,
    subscribe: vi.fn(() => () => {}),
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({
      ensure: vi.fn(),
      patch: mockPatchRuntime,
      clear: mockClearRuntime,
    }),
  },
  waitForSavedEnvironmentRegistryHydration: vi.fn(),
  writeSavedEnvironmentBearerToken: mockWriteSavedEnvironmentBearerToken,
}));

vi.mock("./connection", () => ({
  createEnvironmentConnection: mockCreateEnvironmentConnection,
}));

vi.mock("../../rpc/wsRpcClient", () => ({
  createWsRpcClient: vi.fn(() => ({
    server: {
      getConfig: mockClientGetConfig,
    },
    orchestration: {
      subscribeThread: vi.fn(() => () => {}),
      repairAssistantMessageFromProviderJournal: vi.fn(),
      repairThreadAssistantMessages: vi.fn(),
    },
  })),
}));

vi.mock("../../rpc/wsTransport", () => ({
  WsTransport: vi.fn(),
}));

const remoteRecord = () => ({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.com/",
  wsBaseUrl: "wss://remote.example.com/",
  createdAt: "2026-04-14T00:00:00.000Z",
  lastConnectedAt: null,
});

describe("direct saved environments", () => {
  beforeAll(async () => {
    await import("./service");
  });

  afterEach(async () => {
    const { resetEnvironmentServiceForTests } = await import("./service");
    await resetEnvironmentServiceForTests();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSavedRecords = [];
    vi.stubGlobal("window", { location: { origin: "https://app.example.com" } });
    mockResolveRemotePairingTarget.mockReturnValue({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
      credential: "pairing-code",
    });
    mockFetchRemoteEnvironmentDescriptor.mockResolvedValue({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Remote environment",
    });
    mockBootstrapRemoteBearerSession.mockResolvedValue({
      sessionToken: "bearer-token",
      role: "owner",
    });
    mockFetchRemoteSessionState.mockResolvedValue({ authenticated: true, role: "owner" });
    mockIsRemoteEnvironmentAuthHttpError.mockReturnValue(false);
    mockResolveRemoteWebSocketConnectionUrl.mockResolvedValue(
      "wss://remote.example.com/?wsToken=remote-token",
    );
    mockPersistSavedEnvironmentRecord.mockResolvedValue(undefined);
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(false);
    mockSetSavedEnvironmentRegistry.mockResolvedValue(undefined);
    mockReadSavedEnvironmentBearerToken.mockResolvedValue(null);
    mockRemoveSavedEnvironmentBearerToken.mockResolvedValue(undefined);
    mockCreateEnvironmentConnection.mockImplementation(
      (input: {
        knownEnvironment: { environmentId: EnvironmentId };
        client: unknown;
        onConfigSnapshot?: (config: Awaited<ReturnType<typeof mockClientGetConfig>>) => void;
      }) => {
        queueMicrotask(async () => {
          input.onConfigSnapshot?.(await mockClientGetConfig());
        });
        return {
          kind: "saved" as const,
          environmentId: input.knownEnvironment.environmentId,
          knownEnvironment: input.knownEnvironment,
          client: input.client,
          ensureBootstrapped: async () => undefined,
          reconnect: async () => undefined,
          dispose: async () => undefined,
        };
      },
    );
    mockClientGetConfig.mockResolvedValue({
      environment: {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote environment",
      },
    });
  });

  it("rolls back metadata when bearer persistence fails", async () => {
    const { addSavedEnvironment } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");

    expect(mockPersistSavedEnvironmentRecord).toHaveBeenCalledOnce();
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      "bearer-token",
    );
    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([]);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("preserves unrelated records when credential rollback runs", async () => {
    mockSavedRecords = [
      {
        ...remoteRecord(),
        environmentId: EnvironmentId.make("environment-existing"),
      },
    ];
    const { addSavedEnvironment } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");

    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([
      expect.objectContaining({
        environmentId: EnvironmentId.make("environment-existing"),
      }),
    ]);
  });

  it("persists the authoritative server label after connecting", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    mockClientGetConfig.mockResolvedValue({
      environment: {
        environmentId: EnvironmentId.make("environment-1"),
        label: "Build server",
      },
    });
    const { addSavedEnvironment } = await import("./service");

    await addSavedEnvironment({
      label: "remote.example.com",
      host: "remote.example.com",
      pairingCode: "123456",
    });

    expect(mockRename).toHaveBeenCalledWith(EnvironmentId.make("environment-1"), "Build server");
  });

  it("removes an expired bearer token and requires pairing again", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    const authError = { status: 401, message: "Unauthorized" };
    mockFetchRemoteSessionState.mockRejectedValueOnce(authError);
    mockIsRemoteEnvironmentAuthHttpError.mockImplementation((error) => error === authError);
    const { addSavedEnvironment } = await import("./service");

    await expect(
      addSavedEnvironment({
        label: "Remote environment",
        host: "remote.example.com",
        pairingCode: "123456",
      }),
    ).rejects.toThrow("Saved environment credential expired. Pair it again.");

    expect(mockRemoveSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
    );
  });

  it("disconnects without deleting the saved record or bearer token", async () => {
    mockSavedRecords = [remoteRecord()];
    const { disconnectSavedEnvironment } = await import("./service");

    await disconnectSavedEnvironment(EnvironmentId.make("environment-1"));

    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockRemoveSavedEnvironmentBearerToken).not.toHaveBeenCalled();
  });

  it("cancels a pending saved environment connection", async () => {
    mockSavedRecords = [remoteRecord()];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("bearer-token");
    const dispose = vi.fn(async () => undefined);
    mockCreateEnvironmentConnection.mockImplementation(
      (input: {
        knownEnvironment: { environmentId: EnvironmentId };
        client: unknown;
        onConfigSnapshot?: (config: Awaited<ReturnType<typeof mockClientGetConfig>>) => void;
      }) => {
        queueMicrotask(async () => {
          input.onConfigSnapshot?.(await mockClientGetConfig());
        });
        return {
          kind: "saved" as const,
          environmentId: input.knownEnvironment.environmentId,
          knownEnvironment: input.knownEnvironment,
          client: input.client,
          ensureBootstrapped: async () => undefined,
          reconnect: async () => undefined,
          dispose,
        };
      },
    );
    let resolveSessionState!: (value: { authenticated: true; role: "owner" }) => void;
    let signalSessionStateStarted!: () => void;
    const sessionStateStarted = new Promise<void>((resolve) => {
      signalSessionStateStarted = resolve;
    });
    mockFetchRemoteSessionState.mockImplementation(() => {
      signalSessionStateStarted();
      return new Promise((resolve) => {
        resolveSessionState = resolve;
      });
    });
    const { disconnectSavedEnvironment, listEnvironmentConnections, reconnectSavedEnvironment } =
      await import("./service");

    const reconnectPromise = reconnectSavedEnvironment(EnvironmentId.make("environment-1"));
    await sessionStateStarted;
    expect(mockFetchRemoteSessionState).toHaveBeenCalledOnce();
    await disconnectSavedEnvironment(EnvironmentId.make("environment-1"));
    resolveSessionState({ authenticated: true, role: "owner" });
    await expect(reconnectPromise).resolves.toBeUndefined();

    expect(listEnvironmentConnections()).toHaveLength(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(mockPatchRuntime).not.toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      expect.objectContaining({ connectionState: "error" }),
    );
  });
});
