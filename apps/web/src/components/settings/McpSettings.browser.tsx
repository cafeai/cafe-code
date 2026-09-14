vi.mock("../../attachments/fileAttachments", () => ({
  fileRequest: vi.fn(
    async () =>
      new Response(
        Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
          ),
          (c) => c.charCodeAt(0),
        ),
        { headers: { "content-type": "image/png" } },
      ),
  ),
  readBounded: async (response: Response) => new Uint8Array(await response.arrayBuffer()),
}));
vi.mock("~/store", () => ({
  useStore: (selector: (value: unknown) => unknown) => selector({ environmentStateById: {} }),
}));
import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type CafeMcpStatus,
  type DesktopBridge,
  type ServerSettings,
} from "@cafecode/contracts";
import { McpSettings } from "./McpSettings";

const harness = vi.hoisted(() => ({
  getStatus: vi.fn(),
  updateClient: vi.fn(),
  updateSettings: vi.fn(),
  applySettings: vi.fn(),
  desktopStatus: vi.fn(),
  settings: null as ServerSettings | null,
  backendUrl: "http://127.0.0.1:3774/",
}));

vi.mock("~/environments/primary", () => ({ usePrimaryEnvironmentId: () => "test-local" }));
vi.mock("~/environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: () => harness.backendUrl,
  requireEnvironmentConnection: () => ({
    client: {
      server: {
        getMcpStatus: harness.getStatus,
        updateMcpClient: harness.updateClient,
        updateSettings: harness.updateSettings,
        virtualDesktop: harness.desktopStatus,
      },
    },
  }),
}));
vi.mock("~/rpc/serverState", async () => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@cafecode/contracts");
  return {
    useServerSettings: () => harness.settings ?? DEFAULT_SERVER_SETTINGS,
    applySettingsUpdated: harness.applySettings,
  };
});

const status: CafeMcpStatus = {
  enabled: true,
  canManage: true,
  canInstall: true,
  bridgeReady: true,
  clients: [
    {
      id: "codex",
      name: "Codex",
      status: "not-installed",
      detail: "Available for your user account.",
    },
    {
      id: "claude",
      name: "Claude Code",
      status: "conflict",
      detail: "A different registration exists.",
    },
  ],
};
let mounted: Awaited<ReturnType<typeof render>> | undefined;
const originalBridge = window.desktopBridge;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <McpSettings />
    </QueryClientProvider>,
  );
}

describe("MCP settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.settings = DEFAULT_SERVER_SETTINGS;
    harness.desktopStatus.mockResolvedValue({ supported: false });
    harness.backendUrl = "http://127.0.0.1:3774/";
    harness.getStatus.mockResolvedValue(status);
    harness.updateClient.mockResolvedValue({
      ...status,
      clients: [{ ...status.clients[0], status: "installed" }],
    });
    harness.updateSettings.mockImplementation(async (patch) => {
      harness.settings = { ...harness.settings!, ...patch };
      return harness.settings;
    });
    window.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local",
        wsBaseUrl: "ws://127.0.0.1:3774/",
        httpBaseUrl: "http://127.0.0.1:3774/",
      }),
    } as DesktopBridge;
  });
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
    if (originalBridge) window.desktopBridge = originalBridge;
    else delete window.desktopBridge;
  });

  it("installs, shows backend-confirmed status, and removes a registration", async () => {
    mounted = await mount();
    await page.getByRole("button", { name: "Install Cafe MCP for Codex", exact: true }).click();
    expect(harness.updateClient).toHaveBeenCalledWith({ client: "codex", operation: "install" });
    await expect
      .element(page.getByRole("button", { name: "Reinstall Cafe MCP for Codex" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Remove Cafe MCP from Codex" }).click();
    expect(harness.updateClient).toHaveBeenLastCalledWith({ client: "codex", operation: "remove" });
  });

  it("keeps desktop controls out of the MCP tab on Linux", async () => {
    harness.desktopStatus.mockResolvedValue({ supported: true, available: false });
    mounted = await mount();
    await expect.element(page.getByRole("switch", { name: "Enable Cafe Code MCP" })).toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: "Enable desktop control" }))
      .not.toBeInTheDocument();
    expect(harness.desktopStatus).not.toHaveBeenCalled();
  });

  it("keeps installation out of browsers and connections to another environment", async () => {
    delete window.desktopBridge;
    mounted = await mount();
    await expect
      .element(
        page.getByText(
          "Open this page in the local Cafe Code desktop app to install provider connections.",
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Install Cafe MCP for Codex", exact: true }))
      .not.toBeInTheDocument();
    await mounted.unmount();
    window.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local",
        wsBaseUrl: "ws://127.0.0.1:9999/",
        httpBaseUrl: "http://127.0.0.1:9999/",
      }),
    } as DesktopBridge;
    mounted = await mount();
    await expect
      .element(page.getByRole("button", { name: "Install Cafe MCP for Codex", exact: true }))
      .not.toBeInTheDocument();
    expect(harness.updateClient).not.toHaveBeenCalled();
  });

  it("disables conflicting installs and reports a failed toggle without displaying success", async () => {
    harness.updateSettings.mockRejectedValue(new Error("private-error-data"));
    mounted = await mount();
    await expect
      .element(page.getByRole("button", { name: "Install Cafe MCP for Claude Code" }))
      .toBeDisabled();
    await page.getByRole("switch", { name: "Enable Cafe Code MCP" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not change Cafe Code MCP access");
    expect(harness.applySettings).not.toHaveBeenCalled();
    await expect.element(page.getByRole("switch", { name: "Enable Cafe Code MCP" })).toBeChecked();
  });
});
