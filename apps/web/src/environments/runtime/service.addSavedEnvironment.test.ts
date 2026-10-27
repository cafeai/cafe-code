import { EnvironmentId } from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockSavedRecords: Array<Record<string, unknown>> = [];

const mockResolveRemotePairingTarget = vi.fn();
const mockResolveRemoteServerTarget = vi.fn();
const mockFetchRemoteEnvironmentDescriptor = vi.fn();
const mockBootstrapRemoteBearerSession = vi.fn();
const mockBootstrapRemotePasswordBearerSession = vi.fn();
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
  resolveRemoteServerTarget: mockResolveRemoteServerTarget,
}));

vi.mock("../remote/api", () => ({
  bootstrapRemoteBearerSession: mockBootstrapRemoteBearerSession,
  bootstrapRemotePasswordBearerSession: mockBootstrapRemotePasswordBearerSession,
  fetchRemoteEnvironmentDescriptor: mockFetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState: mockFetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError: mockIsRemoteEnvironmentAuthHttpError,
  isRetryableRemoteWebSocketUrlError: vi.fn(() => false),
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

// Collect the real service only after all fixture-owned mock bindings exist.
// Connection actions remain inside the tests; loading the module is preparation,
// not a lifecycle readiness check that belongs inside a beforeAll deadline.
await import("./service");

describe("direct saved environments", () => {
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
    mockResolveRemoteServerTarget.mockReturnValue({
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    });
    mockBootstrapRemotePasswordBearerSession.mockResolvedValue({
      sessionToken: "password-bearer-token",
      role: "owner",
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

  it("saves only the bearer session from a password login", async () => {
    mockWriteSavedEnvironmentBearerToken.mockResolvedValue(true);
    const { addSavedEnvironment, reconnectSavedEnvironment } = await import("./service");
    await addSavedEnvironment({
      label: "PC",
      host: "https://remote.example.com",
      password: " admin-secret ",
    });

    expect(mockBootstrapRemotePasswordBearerSession).toHaveBeenCalledExactlyOnceWith({
      httpBaseUrl: "https://remote.example.com/",
      password: "admin-secret",
    });
    expect(mockBootstrapRemoteBearerSession).not.toHaveBeenCalled();
    expect(mockResolveRemotePairingTarget).not.toHaveBeenCalled();
    expect(mockFetchRemoteEnvironmentDescriptor).toHaveBeenCalledExactlyOnceWith({
      httpBaseUrl: "https://remote.example.com/",
      approveCertificate: true,
    });
    expect(mockWriteSavedEnvironmentBearerToken).toHaveBeenCalledWith(
      EnvironmentId.make("environment-1"),
      "password-bearer-token",
    );
    expect(JSON.stringify(mockPersistSavedEnvironmentRecord.mock.calls)).not.toMatch(
      /admin-secret|workstation-user/,
    );

    mockReadSavedEnvironmentBearerToken.mockResolvedValue("password-bearer-token");
    await reconnectSavedEnvironment(EnvironmentId.make("environment-1"));
    expect(mockBootstrapRemotePasswordBearerSession).toHaveBeenCalledOnce();
    expect(mockFetchRemoteSessionState).toHaveBeenLastCalledWith({
      httpBaseUrl: "https://remote.example.com/",
      bearerToken: "password-bearer-token",
    });
  });

  it("does not persist or retry failed password authentication", async () => {
    mockBootstrapRemotePasswordBearerSession.mockRejectedValueOnce(
      new Error("Remote auth request failed (401)."),
    );
    const { addSavedEnvironment } = await import("./service");
    await expect(
      addSavedEnvironment({ label: "PC", host: "remote.example.com", password: "admin-secret" }),
    ).rejects.toThrow("Remote auth request failed (401).");
    expect(mockBootstrapRemotePasswordBearerSession).toHaveBeenCalledOnce();
    expect(mockPersistSavedEnvironmentRecord).not.toHaveBeenCalled();
    expect(mockWriteSavedEnvironmentBearerToken).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("rolls back password login metadata if bearer storage fails", async () => {
    const { addSavedEnvironment } = await import("./service");
    await expect(
      addSavedEnvironment({ label: "PC", host: "remote.example.com", password: "admin-secret" }),
    ).rejects.toThrow("Unable to persist saved environment credentials.");
    expect(mockSetSavedEnvironmentRegistry).toHaveBeenCalledWith([]);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it.each([
    { password: "  " },
    { password: "secret", pairingCode: "code" },
    { password: "secret", pairingUrl: "https://remote.example.com/pair#token=code" },
  ])(
    "rejects empty or ambiguous password inputs before contacting the server",
    async (credential) => {
      const { addSavedEnvironment } = await import("./service");
      await expect(
        addSavedEnvironment({ label: "PC", host: "remote.example.com", ...credential }),
      ).rejects.toThrow();
      expect(mockFetchRemoteEnvironmentDescriptor).not.toHaveBeenCalled();
      expect(mockBootstrapRemotePasswordBearerSession).not.toHaveBeenCalled();
    },
  );

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

  it("preserves the saved local name when a server reports a different label", async () => {
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

    expect(mockRename).not.toHaveBeenCalled();
    expect(mockSavedRecords[0]?.label).toBe("remote.example.com");
  });

  it("saves offline edits locally without reading or replacing the saved credential", async () => {
    const record = remoteRecord();
    mockSavedRecords = [record];
    const { updateSavedEnvironment } = await import("./service");
    await updateSavedEnvironment(record.environmentId, {
      label: "New name",
      host: "10.0.0.108",
      port: "3775",
    });
    expect(mockPersistSavedEnvironmentRecord).toHaveBeenCalledExactlyOnceWith({
      ...record,
      label: "New name",
      httpBaseUrl: "https://10.0.0.108:3775/",
      wsBaseUrl: "wss://10.0.0.108:3775/",
    });
    expect(mockSavedRecords[0]).toMatchObject({
      environmentId: record.environmentId,
      label: "New name",
      httpBaseUrl: "https://10.0.0.108:3775/",
    });
    expect(mockReadSavedEnvironmentBearerToken).not.toHaveBeenCalled();
    expect(mockWriteSavedEnvironmentBearerToken).not.toHaveBeenCalled();
    expect(mockRemoveSavedEnvironmentBearerToken).not.toHaveBeenCalled();
    expect(mockFetchRemoteEnvironmentDescriptor).not.toHaveBeenCalled();
    expect(mockCreateEnvironmentConnection).not.toHaveBeenCalled();
  });

  it("leaves the current connection and record intact when an edit cannot be persisted", async () => {
    const record = remoteRecord();
    mockSavedRecords = [record];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("existing-bearer");
    const { reconnectSavedEnvironment, updateSavedEnvironment, readEnvironmentConnection } =
      await import("./service");
    await reconnectSavedEnvironment(record.environmentId);
    const original = readEnvironmentConnection(record.environmentId);
    mockPersistSavedEnvironmentRecord.mockRejectedValueOnce(new Error("Storage unavailable"));
    await expect(
      updateSavedEnvironment(record.environmentId, {
        label: "New name",
        host: "new.example",
        port: "8443",
      }),
    ).rejects.toThrow("Storage unavailable");
    expect(readEnvironmentConnection(record.environmentId)).toBe(original);
    expect(mockSavedRecords[0]).toMatchObject(record);
    expect(mockRemoveSavedEnvironmentBearerToken).not.toHaveBeenCalled();
  });

  it("retires the old transport before publishing an edited address", async () => {
    const record = remoteRecord();
    mockSavedRecords = [record];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("existing-bearer");
    const { reconnectSavedEnvironment, updateSavedEnvironment, readEnvironmentConnection } =
      await import("./service");
    await reconnectSavedEnvironment(record.environmentId);
    const connection = readEnvironmentConnection(record.environmentId)!;
    const disposed = vi.spyOn(connection, "dispose").mockImplementation(async () => {
      expect(mockSavedRecords[0]?.httpBaseUrl).toBe(record.httpBaseUrl);
    });
    await updateSavedEnvironment(record.environmentId, {
      label: "Moved",
      host: "new.example",
      port: "8443",
    });
    expect(disposed).toHaveBeenCalledOnce();
    expect(readEnvironmentConnection(record.environmentId)).toBeNull();
    expect(mockClearRuntime).toHaveBeenCalledWith(record.environmentId);
    expect(mockRemoveSavedEnvironmentBearerToken).not.toHaveBeenCalled();
  });

  it("keeps the live transport when only the local name changes", async () => {
    const record = remoteRecord();
    mockSavedRecords = [record];
    mockReadSavedEnvironmentBearerToken.mockResolvedValue("existing-bearer");
    const { reconnectSavedEnvironment, updateSavedEnvironment, readEnvironmentConnection } =
      await import("./service");
    await reconnectSavedEnvironment(record.environmentId);
    const connection = readEnvironmentConnection(record.environmentId)!;
    const disposed = vi.spyOn(connection, "dispose");
    await updateSavedEnvironment(record.environmentId, {
      label: "My box",
      host: "remote.example.com",
      port: "443",
    });
    expect(readEnvironmentConnection(record.environmentId)).toBe(connection);
    expect(disposed).not.toHaveBeenCalled();
    expect(mockClearRuntime).not.toHaveBeenCalled();
    expect(mockSavedRecords[0]?.label).toBe("My box");
  });

  it.each([false, true])(
    "fences an old pending connection after an address edit (late auth failure: %s)",
    async (authFailure) => {
      const record = remoteRecord();
      mockSavedRecords = [record];
      mockReadSavedEnvironmentBearerToken.mockResolvedValue("existing-bearer");
      let finish!: () => void;
      mockFetchRemoteSessionState.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = () =>
              authFailure
                ? reject({ status: 401 })
                : resolve({ authenticated: true, role: "owner" });
          }),
      );
      mockIsRemoteEnvironmentAuthHttpError.mockImplementation(
        (error) => (error as { status?: number })?.status === 401,
      );
      const { reconnectSavedEnvironment, updateSavedEnvironment, readEnvironmentConnection } =
        await import("./service");
      const opening = reconnectSavedEnvironment(record.environmentId);
      try {
        await vi.waitFor(() => expect(mockFetchRemoteSessionState).toHaveBeenCalledOnce());
        await updateSavedEnvironment(record.environmentId, {
          label: "Moved",
          host: "new.example",
          port: "8443",
        });
        mockPatchRuntime.mockClear();
        finish();
        await opening;
        expect(readEnvironmentConnection(record.environmentId)).toBeNull();
        expect(mockPatchRuntime).not.toHaveBeenCalled();
        expect(mockRemoveSavedEnvironmentBearerToken).not.toHaveBeenCalled();
        expect(mockSavedRecords[0]).toMatchObject({
          label: "Moved",
          httpBaseUrl: "https://new.example:8443/",
        });
      } finally {
        finish?.();
        await opening;
      }
    },
  );

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
    ).rejects.toThrow("Saved environment credential expired. Add it again to sign in.");

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
