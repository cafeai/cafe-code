vi.mock("~/environments/workspace", () => ({
  useWorkspaceEnvironmentId: () => (harness.remote ? "test-remote" : "test-local"),
  useIsSavedRemoteEnvironment: () => harness.remote,
}));
vi.mock("~/environments/workspaceApi", () => ({ patchWorkspaceServerConfig: vi.fn() }));
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
  settings: null as ServerSettings | null,
  backendUrl: "http://127.0.0.1:3774/",
  remote: false,
}));

vi.mock("~/environments/primary", () => ({
  usePrimaryEnvironmentId: () => "test-local",
  readPrimaryEnvironmentDescriptor: () => ({ environmentId: "test-local" }),
}));
vi.mock("~/environments/runtime", () => ({
  getEnvironmentHttpBaseUrl: () => harness.backendUrl,
  requireEnvironmentConnection: () => ({
    client: {
      server: {
        getMcpStatus: harness.getStatus,
        updateMcpClient: harness.updateClient,
        updateSettings: harness.updateSettings,
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
    harness.backendUrl = "http://127.0.0.1:3774/";
    harness.remote = false;
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

  it.each(["disabled", "unavailable"] as const)(
    "keeps automatic chat/account scheduling visible when management MCP is %s",
    async (managementState) => {
      harness.settings = { ...DEFAULT_SERVER_SETTINGS, mcpEnabled: false };
      if (managementState === "unavailable") {
        harness.getStatus.mockRejectedValue(new Error("private-management-diagnostic"));
      } else {
        harness.getStatus.mockResolvedValue({ ...status, enabled: false });
      }
      mounted = await mount();
      await expect
        .element(page.getByRole("heading", { name: "Chat scheduling · built in", exact: true }))
        .toBeVisible();
      await expect
        .element(
          page.getByText(
            "Ask Codex, Claude or Grok to schedule a follow-up in a Cafe chat. Cafe connects the scheduling tools automatically for that chat and account, including separate account profiles. No installation is needed.",
            { exact: true },
          ),
        )
        .toBeVisible();
      await expect
        .element(
          page.getByText(
            "Review the proposal and the account that will run and pay for it in Tasks, then choose Approve & enable. Changing accounts requires another review. These chat-only tools are separate from the management access below.",
            { exact: true },
          ),
        )
        .toBeVisible();
      await expect
        .element(page.getByText("Built-in chat scheduling remains available.", { exact: false }))
        .toBeVisible();
      await expect
        .element(
          page.getByText("This installer is not needed for scheduling inside Cafe.", {
            exact: false,
          }),
        )
        .toBeVisible();
      await expect
        .element(page.getByRole("switch", { name: "Enable Cafe Code MCP" }))
        .not.toBeChecked();
      if (managementState === "unavailable") {
        await expect
          .element(page.getByRole("alert"))
          .toHaveTextContent("Could not load MCP status. Try refreshing.");
        await expect
          .element(page.getByRole("switch", { name: "Enable Cafe Code MCP" }))
          .toBeDisabled();
        expect(document.body.textContent).not.toContain("private-management-diagnostic");
      }
      expect(harness.updateClient).not.toHaveBeenCalled();
      expect(harness.updateSettings).not.toHaveBeenCalled();
    },
  );

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

  it("keeps retired desktop controls out of the MCP tab", async () => {
    mounted = await mount();
    await expect.element(page.getByRole("switch", { name: "Enable Cafe Code MCP" })).toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: "Enable desktop control" }))
      .not.toBeInTheDocument();
  });

  it("keeps installation unavailable for primary browser sessions", async () => {
    delete window.desktopBridge;
    mounted = await mount();
    await expect
      .element(page.getByRole("button", { name: "Install Cafe MCP for Codex", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Open this page in the local Cafe Code desktop app to install provider connections.",
          { exact: true },
        ),
      )
      .toBeVisible();
    expect(harness.updateClient).not.toHaveBeenCalled();
  });

  it("uses the server's installation capability for saved remote owners", async () => {
    harness.remote = true;
    delete window.desktopBridge;
    mounted = await mount();
    await expect
      .element(page.getByRole("button", { name: "Install Cafe MCP for Codex", exact: true }))
      .toBeEnabled();
    await mounted.unmount();
    harness.getStatus.mockResolvedValue({ ...status, canInstall: false });
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
      .toMatchTextContent("Could not change Cafe Code MCP access");
    expect(harness.applySettings).not.toHaveBeenCalled();
    await expect.element(page.getByRole("switch", { name: "Enable Cafe Code MCP" })).toBeChecked();
  });
});
