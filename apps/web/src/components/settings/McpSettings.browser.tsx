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
import { getUiLocale, setUiLocale } from "@cafecode/shared/i18n";

const harness = vi.hoisted(() => ({
  getStatus: vi.fn(),
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

const status: CafeMcpStatus = { enabled: true, canManage: true };
let mounted: Awaited<ReturnType<typeof render>> | undefined;
const originalBridge = window.desktopBridge;
const originalLocale = getUiLocale();
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
    setUiLocale("en");
    vi.clearAllMocks();
    harness.settings = DEFAULT_SERVER_SETTINGS;
    harness.backendUrl = "http://127.0.0.1:3774/";
    harness.remote = false;
    harness.getStatus.mockResolvedValue(status);
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
    setUiLocale(originalLocale);
  });

  it("retranslates retained access failure without repeating the security toggle", async () => {
    harness.updateSettings.mockRejectedValueOnce(new Error("private fixture details"));
    mounted = await mount();
    const toggle = page.getByRole("switch", { name: "Enable Cafe management tools" });
    await expect.element(toggle).toBeEnabled();
    await toggle.click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not change Cafe management access. Refresh and try again.");
    setUiLocale("ko");
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "Cafe 관리 접근 권한을 변경하지 못했습니다. 새로고침한 뒤 다시 시도하세요.",
      );
    expect(harness.updateSettings).toHaveBeenCalledTimes(1);
    expect(harness.applySettings).not.toHaveBeenCalled();
    expect(harness.getStatus).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("private fixture details");
  });
  it.each([false, true])(
    "automatically connects tools without installer controls (remote=%s)",
    async (remote) => {
      harness.remote = remote;
      delete window.desktopBridge;
      mounted = await mount();
      await expect
        .element(page.getByRole("switch", { name: "Enable Cafe management tools" }))
        .toBeEnabled();
      await expect.element(page.getByText(/Cafe connects these tools automatically/)).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: /Install|Remove|Reinstall/ }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: "About Cafe management tools" }).hover();
      await expect
        .element(page.getByText(/Chat scheduling stays available separately/))
        .toBeVisible();
      expect(harness.updateSettings).not.toHaveBeenCalled();
    },
  );
  it("disables unauthorized or unavailable management controls and sanitizes failures", async () => {
    harness.getStatus.mockResolvedValue({ ...status, canManage: false });
    mounted = await mount();
    await expect
      .element(page.getByRole("switch", { name: "Enable Cafe management tools" }))
      .toBeDisabled();
    await mounted.unmount();
    harness.getStatus.mockRejectedValue(new Error("private-management-diagnostic"));
    mounted = await mount();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not load Cafe tools status. Refresh to try again.");
    await expect
      .element(page.getByRole("switch", { name: "Enable Cafe management tools" }))
      .toBeDisabled();
    expect(document.body.textContent).not.toContain("private-management-diagnostic");
    expect(harness.updateSettings).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "persists owner management access in its selected environment (remote=%s)",
    async (remote) => {
      harness.remote = remote;
      mounted = await mount();
      await expect
        .element(page.getByRole("switch", { name: "Enable Cafe management tools" }))
        .toBeEnabled();
      await page.getByRole("switch", { name: "Enable Cafe management tools" }).click();
      await vi.waitFor(() =>
        expect(harness.updateSettings).toHaveBeenCalledWith({ mcpEnabled: false }),
      );
      if (!remote) expect(harness.applySettings).toHaveBeenCalled();
      else expect(harness.applySettings).not.toHaveBeenCalled();
    },
  );
});
