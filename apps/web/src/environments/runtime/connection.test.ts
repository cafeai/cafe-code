import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfigStreamEvent,
  type ServerProvider,
} from "@cafecode/contracts";
import { describe, expect, it, vi } from "vitest";

import { createEnvironmentConnection } from "./connection";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

function createTestClient() {
  const lifecycleListeners = new Set<(event: any) => void>();
  const configListeners = new Set<(event: any) => void>();
  const shellListeners = new Set<(event: any) => void>();
  let shellResubscribe: (() => void) | undefined;

  const client = {
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => {
      shellResubscribe?.();
    }),
    server: {
      getConfig: vi.fn(async () => ({
        environment: {
          environmentId: EnvironmentId.make("env-1"),
        },
      })),
      subscribeConfig: vi.fn((listener: (event: any) => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
      }),
      subscribeLifecycle: vi.fn((listener: (event: any) => void) => {
        lifecycleListeners.add(listener);
        return () => lifecycleListeners.delete(listener);
      }),
      subscribeAuthAccess: () => () => undefined,
      refreshProviders: vi.fn(async () => undefined),
      loginProvider: vi.fn(async () => undefined),
      updateProvider: vi.fn(async () => undefined),
      restartProviderRuntime: vi.fn(async () => undefined),
      upsertKeybinding: vi.fn(async () => undefined),
      getSettings: vi.fn(async () => undefined),
      updateSettings: vi.fn(async () => undefined),
      getClientSettings: vi.fn(async () => undefined),
      updateClientSettings: vi.fn(async () => undefined),
    },
    orchestration: {
      dispatchCommand: vi.fn(async () => undefined),
      repairAssistantMessageFromProviderJournal: vi.fn(),
      repairThreadAssistantMessages: vi.fn(),
      subscribeShell: vi.fn(
        (
          listener: (event: any) => void,
          options?: { onResubscribe?: () => void; retryNonTransportErrors?: boolean },
        ) => {
          shellListeners.add(listener);
          shellResubscribe = options?.onResubscribe;
          queueMicrotask(() => {
            listener({
              kind: "snapshot",
              snapshot: {
                snapshotSequence: 1,
                projects: [],
                threads: [],
                updatedAt: "2026-04-12T00:00:00.000Z",
              },
            });
          });
          return () => {
            shellListeners.delete(listener);
            if (shellResubscribe === options?.onResubscribe) {
              shellResubscribe = undefined;
            }
          };
        },
      ),
      subscribeThread: vi.fn(() => () => undefined),
    },
    projects: {
      searchEntries: vi.fn(async () => []),
      writeFile: vi.fn(async () => undefined),
    },
    shell: {
      openInEditor: vi.fn(async () => undefined),
    },
    git: {
      resolvePullRequest: vi.fn(async () => undefined),
      preparePullRequestThread: vi.fn(async () => undefined),
    },
  } as unknown as WsRpcClient;

  return {
    client,
    readShellSubscribeOptions: () =>
      (client.orchestration.subscribeShell as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as
        | { onResubscribe?: () => void; retryNonTransportErrors?: boolean }
        | undefined,
    emitWelcome: (environmentId: EnvironmentId) => {
      for (const listener of lifecycleListeners) {
        listener({
          type: "welcome",
          payload: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitConfigSnapshot: (environmentId: EnvironmentId) => {
      for (const listener of configListeners) {
        listener({
          type: "snapshot",
          config: {
            environment: {
              environmentId,
            },
          },
        });
      }
    },
    emitConfigEvent: (event: ServerConfigStreamEvent) => {
      for (const listener of configListeners) listener(event);
    },
    emitShellSnapshot: (snapshotSequence: number) => {
      for (const listener of shellListeners) {
        listener({
          kind: "snapshot",
          snapshot: {
            snapshotSequence,
            projects: [],
            threads: [],
            updatedAt: "2026-04-12T00:00:00.000Z",
          },
        });
      }
    },
  };
}

describe("createEnvironmentConnection", () => {
  it("delivers saved-provider status changes after the identity snapshot and retires disposed callbacks", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitConfigEvent, emitConfigSnapshot } = createTestClient();
    const onProviderStatuses = vi.fn();
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: { httpBaseUrl: "http://example.test", wsBaseUrl: "ws://example.test" },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      onProviderStatuses,
    });
    const provider: ServerProvider = {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "0.159.3",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-19T22:33:38.151Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    const update: ServerConfigStreamEvent = {
      version: 1,
      type: "providerStatuses",
      payload: { providers: [provider] },
    };
    emitConfigEvent(update);
    expect(onProviderStatuses).not.toHaveBeenCalled();
    emitConfigSnapshot(environmentId);
    emitConfigEvent(update);
    expect(onProviderStatuses).toHaveBeenCalledExactlyOnceWith(update.payload);
    emitConfigEvent({ ...update, payload: { providers: [] } });
    expect(onProviderStatuses).toHaveBeenLastCalledWith({ providers: [] });
    expect(client.server.getConfig).not.toHaveBeenCalled();
    expect(client.server.refreshProviders).not.toHaveBeenCalled();
    const retainedCallback = vi.mocked(client.server.subscribeConfig).mock.calls[0]?.[0];
    await connection.dispose();
    retainedCallback?.(update);
    expect(onProviderStatuses).toHaveBeenCalledTimes(2);
  });

  it("delivers selected saved-server settings metadata after its snapshot and retires disposed callbacks", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitConfigEvent, emitConfigSnapshot } = createTestClient();
    const onSettingsUpdated = vi.fn();
    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: { httpBaseUrl: "http://example.test", wsBaseUrl: "ws://example.test" },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
      onSettingsUpdated,
    });
    const id = ProviderInstanceId.make("saved-debug-account");
    const update: ServerConfigStreamEvent = {
      version: 1,
      type: "settingsUpdated",
      payload: {
        settings: DEFAULT_SERVER_SETTINGS,
        providerDataProfiles: {
          [id]: { scope: "unconfigured", nativeHome: "saved-server-private-target" },
        },
      },
    };
    emitConfigEvent(update);
    expect(onSettingsUpdated).not.toHaveBeenCalled();
    emitConfigSnapshot(environmentId);
    emitConfigEvent(update);
    expect(onSettingsUpdated).toHaveBeenLastCalledWith(update.payload);
    const legacy: ServerConfigStreamEvent = {
      version: 1,
      type: "settingsUpdated",
      payload: { settings: DEFAULT_SERVER_SETTINGS },
    };
    emitConfigEvent(legacy);
    expect(onSettingsUpdated).toHaveBeenLastCalledWith({ settings: DEFAULT_SERVER_SETTINGS });
    expect(onSettingsUpdated).toHaveBeenCalledTimes(2);
    expect(client.server.getConfig).not.toHaveBeenCalled();
    expect(client.server.refreshProviders).not.toHaveBeenCalled();
    const retainedCallback = vi.mocked(client.server.subscribeConfig).mock.calls[0]?.[0];
    await connection.dispose();
    retainedCallback?.(update);
    expect(onSettingsUpdated).toHaveBeenCalledTimes(2);
  });
  it("bootstraps from the shell subscription snapshot", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, readShellSubscribeOptions } = createTestClient();
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
    });

    await connection.ensureBootstrapped();

    expect(syncShellSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotSequence: 1 }),
      environmentId,
    );
    expect(readShellSubscribeOptions()).toMatchObject({
      retryNonTransportErrors: true,
    });

    await connection.dispose();
  });

  it("rejects welcome/config identity drift", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitWelcome } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
    });

    expect(() => emitWelcome(EnvironmentId.make("env-2"))).toThrow(
      "Environment connection env-1 changed identity to env-2 via server lifecycle welcome.",
    );

    await connection.dispose();
  });

  it("waits for a fresh shell snapshot after reconnect", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client, emitShellSnapshot } = createTestClient();
    const syncShellSnapshot = vi.fn();

    const connection = createEnvironmentConnection({
      kind: "saved",
      knownEnvironment: {
        id: "env-1",
        label: "Remote env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot,
    });

    await connection.ensureBootstrapped();

    const reconnectPromise = connection.reconnect();
    await Promise.resolve();
    expect(syncShellSnapshot).toHaveBeenCalledTimes(1);

    emitShellSnapshot(2);
    await reconnectPromise;

    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(syncShellSnapshot).toHaveBeenCalledTimes(2);
    expect(syncShellSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ snapshotSequence: 2 }),
      environmentId,
    );

    await connection.dispose();
  });

  it("skips primary lifecycle/config subscriptions when no handlers are registered", async () => {
    const environmentId = EnvironmentId.make("env-1");
    const { client } = createTestClient();

    const connection = createEnvironmentConnection({
      kind: "primary",
      knownEnvironment: {
        id: "env-1",
        label: "Local env",
        source: "manual",
        target: {
          httpBaseUrl: "http://example.test",
          wsBaseUrl: "ws://example.test",
        },
        environmentId,
      },
      client,
      applyShellEvent: vi.fn(),
      syncShellSnapshot: vi.fn(),
    });

    expect(client.server.subscribeLifecycle).not.toHaveBeenCalled();
    expect(client.server.subscribeConfig).not.toHaveBeenCalled();
    expect(client.orchestration.subscribeShell).toHaveBeenCalledOnce();

    await connection.dispose();
  });
});
