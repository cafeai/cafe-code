import { EnvironmentId, type EnvironmentApi } from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KnownEnvironment } from "@cafecode/client-runtime";
import type { WsRpcClient } from "../../rpc/wsRpcClient";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
  createEnvironmentApi,
  readEnvironmentApi,
} from "../../environmentApi";
import {
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
  resetEnvironmentServiceForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import {
  getWsConnectionStatus,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
  wsConnectionStatusAtom,
} from "../../rpc/wsConnectionState";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { observeVisualizationOwner } from "./visualizationOwner";
const registeredFixture = vi.hoisted(() => ({
  client: null as WsRpcClient | null,
  known: null as KnownEnvironment | null,
  kind: "primary" as "primary" | "saved",
}));
vi.mock("../../rpc/wsTransport", () => ({ WsTransport: vi.fn() }));
vi.mock("../../rpc/wsRpcClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../rpc/wsRpcClient")>()),
  createWsRpcClient: () => {
    if (!registeredFixture.client) throw new Error("Fixture RPC peer is absent.");
    return registeredFixture.client;
  },
}));
vi.mock("../../environments/primary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../environments/primary")>()),
  getPrimaryKnownEnvironment: () => registeredFixture.known,
}));
vi.mock("../../environments/runtime/connection", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../environments/runtime/connection")>();
  return {
    ...original,
    createEnvironmentConnection: (
      input: Parameters<typeof original.createEnvironmentConnection>[0],
    ) => original.createEnvironmentConnection({ ...input, kind: registeredFixture.kind }),
  };
});
const environmentId = EnvironmentId.make("visualization-fixture-environment");
function installApi(_details?: undefined, _override = false) {
  return {
    artifactApi: {
      visualizations: { list: vi.fn(async () => ({ entries: [] })), details: vi.fn() },
    },
  };
}
afterEach(async () => {
  await resetEnvironmentServiceForTests();
  resetWsConnectionStateForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  registeredFixture.client = null;
  registeredFixture.known = null;
  registeredFixture.kind = "primary";
  __resetEnvironmentApiOverridesForTests();
});
function installRegisteredConnection(
  api: ReturnType<typeof installApi>,
  kind: "primary" | "saved" = "primary",
) {
  // Unused namespaces are deliberately inert. Actual connection registration
  // still installs all three real subscriptions and owns their exact cleanup.
  const unsubscribe = vi.fn(() => undefined);
  const peer = {
    ...api.artifactApi,
    projects: {},
    filesystem: {},
    sourceControl: {},
    vcs: {},
    git: {},
    server: {
      subscribeLifecycle: vi.fn(() => unsubscribe),
      subscribeConfig: vi.fn(() => unsubscribe),
    },
    orchestration: { subscribeShell: vi.fn(() => unsubscribe) },
    dispose: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
  };
  registeredFixture.client = peer as unknown as WsRpcClient;
  registeredFixture.kind = kind;
  if (kind === "saved") {
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "connected",
      authState: "authenticated",
      role: "owner",
      connectedAt: "2026-10-13T01:02:03.000Z",
    });
  }
  registeredFixture.known = {
    id: environmentId,
    environmentId,
    label: "Isolated visualization peer",
    source: "manual",
    target: {
      httpBaseUrl: "https://visualization.invalid",
      wsBaseUrl: "wss://visualization.invalid/ws",
    },
  };
  recordWsConnectionOpened();
  const connection = getPrimaryEnvironmentConnection();
  expect(readEnvironmentConnection(environmentId)).toBe(connection);
  expect(connection.client).toBe(registeredFixture.client);
  return { connection, peer, unsubscribe };
}

describe("registered visualization connection ownership", () => {
  it("keeps constructor semantics but revokes a replaced exact registry connection with the same peer", async () => {
    const api = installApi(undefined, false);
    const { connection, peer } = installRegisteredConnection(api);
    const firstApi = readEnvironmentApi(environmentId);
    const revoked = vi.fn();
    const owner = observeVisualizationOwner(environmentId, revoked);
    try {
      expect(owner.current()).toBe(true);
      expect(firstApi).toBe(readEnvironmentApi(environmentId));
      expect(createEnvironmentApi(connection.client)).not.toBe(
        createEnvironmentApi(connection.client),
      );
      await resetEnvironmentServiceForTests();
      expect(owner.current()).toBe(false);
      expect(revoked).toHaveBeenCalled();
      const replacement = getPrimaryEnvironmentConnection();
      expect(replacement).not.toBe(connection);
      expect(replacement.client).toBe(connection.client);
      expect(readEnvironmentApi(environmentId)).not.toBe(firstApi);
      expect(readEnvironmentApi(environmentId)).toBe(readEnvironmentApi(environmentId));
      expect(owner.current()).toBe(false);
      expect(peer.dispose).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  });

  it("latches saved authority loss before notifying once and never revives its owner", () => {
    const api = installApi(undefined, false);
    installRegisteredConnection(api, "saved");
    const admitted = useSavedEnvironmentRuntimeStore.getState().byId[environmentId];
    if (!admitted) throw new Error("Fixture saved owner metadata is absent.");
    const revoked = vi.fn(() => expect(owner.current()).toBe(false));
    const owner = observeVisualizationOwner(environmentId, revoked);
    try {
      expect(owner.current()).toBe(true);
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { role: "client" });
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, admitted);
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, { authState: "unknown" });
      useSavedEnvironmentRuntimeStore.getState().patch(environmentId, admitted);
      expect(owner.current()).toBe(false);
      expect(revoked).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  });

  it("latches an invalid snapshot without a read-side notification or later resurrection", () => {
    const api = installApi(undefined, false);
    installRegisteredConnection(api);
    const revoked = vi.fn();
    const owner = observeVisualizationOwner(environmentId, revoked);
    try {
      expect(owner.current()).toBe(true);
      // Test-only adapter replacement has no registry notification: current()
      // must observe loss without invoking external callbacks during render.
      __setEnvironmentApiOverrideForTests(
        environmentId,
        api.artifactApi as unknown as EnvironmentApi,
      );
      expect(owner.current()).toBe(false);
      expect(revoked).not.toHaveBeenCalled();
      __resetEnvironmentApiOverridesForTests();
      expect(owner.current()).toBe(false);
      const admitted = getWsConnectionStatus();
      appAtomRegistry.set(wsConnectionStatusAtom, { ...admitted });
      appAtomRegistry.set(wsConnectionStatusAtom, { ...admitted });
      expect(revoked).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  });

  it("never revives a primary owner after same-clock close and open observations", () => {
    const api = installApi(undefined, false);
    installRegisteredConnection(api);
    const admitted = getWsConnectionStatus();
    const revoked = vi.fn(() => expect(owner.current()).toBe(false));
    const owner = observeVisualizationOwner(environmentId, revoked);
    try {
      expect(owner.current()).toBe(true);
      appAtomRegistry.set(wsConnectionStatusAtom, { ...admitted, phase: "disconnected" });
      appAtomRegistry.set(wsConnectionStatusAtom, { ...admitted });
      expect(getWsConnectionStatus().connectedAt).toBe(admitted.connectedAt);
      expect(owner.current()).toBe(false);
      expect(revoked).toHaveBeenCalledOnce();
    } finally {
      owner.dispose();
    }
  });
});
