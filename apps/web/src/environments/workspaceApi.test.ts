import { EnvironmentId } from "@cafecode/contracts";
import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  selected: "local",
  local: { server: { updateSettings: vi.fn() }, shell: { openInEditor: vi.fn() } },
  remote: { updateSettings: vi.fn(), getRuntimeLayerDiagnostics: vi.fn() },
  config: { environment: { environmentId: "local" }, settings: { fixture: "local" } },
  byId: {} as Record<string, any>,
  patch: vi.fn(),
  connected: true,
}));
vi.mock("../localApi", () => ({ readLocalApi: () => fixture.local }));
vi.mock("./primary", () => ({
  readPrimaryEnvironmentDescriptor: () => ({ environmentId: "local" }),
}));
vi.mock("./workspace", () => ({ readWorkspaceEnvironmentId: () => fixture.selected }));
vi.mock("./runtime/service", () => ({
  readEnvironmentConnection: () =>
    fixture.connected ? { client: { server: fixture.remote } } : undefined,
}));
vi.mock("./runtime/catalog", () => ({
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({ byId: fixture.byId, patch: fixture.patch }),
  },
}));
vi.mock("../rpc/serverState", () => ({ getServerConfig: () => fixture.config }));
import {
  ensureWorkspaceApi,
  getWorkspaceServerConfig,
  patchWorkspaceServerConfig,
} from "./workspaceApi";
beforeEach(() => {
  fixture.selected = "local";
  fixture.connected = true;
  fixture.byId = {
    remote: {
      connectionState: "connected",
      serverConfig: { environment: { environmentId: "remote" }, settings: { fixture: "remote" } },
    },
  };
  vi.clearAllMocks();
  fixture.remote.updateSettings.mockResolvedValue({});
});
it("captures a remote server while native shell remains local and does not retarget after selection changes", async () => {
  fixture.selected = "remote";
  const api = ensureWorkspaceApi();
  expect(api.shell).toBe(fixture.local.shell);
  expect(getWorkspaceServerConfig()?.environment.environmentId).toBe("remote");
  fixture.selected = "local";
  await api.server.updateSettings({});
  expect(fixture.remote.updateSettings).toHaveBeenCalledOnce();
  expect(fixture.local.server.updateSettings).not.toHaveBeenCalled();
  patchWorkspaceServerConfig(EnvironmentId.make("remote"), { settings: {} as never });
  expect(fixture.patch).toHaveBeenCalledWith("remote", expect.any(Object));
  expect(fixture.config.settings.fixture).toBe("local");
});
it("does not fall back to the Mac when the selected server disconnects and redacts RPC errors", async () => {
  fixture.selected = "remote";
  fixture.connected = false;
  expect(() => ensureWorkspaceApi()).toThrow("Reconnect");
  expect(fixture.local.server.updateSettings).not.toHaveBeenCalled();
  fixture.connected = true;
  fixture.remote.updateSettings.mockRejectedValue(new Error("private remote token"));
  await expect(ensureWorkspaceApi().server.updateSettings({})).rejects.toThrow(
    "The selected server operation did not complete.",
  );
});
