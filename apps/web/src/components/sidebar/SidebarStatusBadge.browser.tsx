import "../../index.css";

import { EnvironmentId, type DesktopSourceUpdateState } from "@cafecode/contracts";
import type { CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  sourceUpdate: null as DesktopSourceUpdateState | null,
  retryPrimary: vi.fn(async () => {}),
  retrySaved: vi.fn(async () => {}),
}));
vi.mock("../../lib/desktopSourceUpdateReactQuery", () => ({
  useDesktopSourceUpdateState: () => ({ data: fixture.sourceUpdate }),
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => undefined,
  ensureLocalApi: () => {
    throw new Error("Footer fixtures must not start a real transport.");
  },
}));
vi.mock("../../environments/runtime", async () => ({
  ...(await import("../../environments/runtime/catalog")),
  getPrimaryEnvironmentConnection: () => ({ reconnect: fixture.retryPrimary }),
  reconnectSavedEnvironment: fixture.retrySaved,
}));

import {
  resetPrimaryEnvironmentDescriptorForTests,
  writePrimaryEnvironmentDescriptor,
} from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import {
  resetWorkspaceEnvironmentForTests,
  selectWorkspaceEnvironment,
} from "../../environments/workspace";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import {
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "../../rpc/wsConnectionState";
import { SidebarFooterNavigation } from "../SidebarFooterNavigation";
import { Sidebar, SidebarFooter, SidebarProvider } from "../ui/sidebar";
import { SidebarStatusBadge } from "./SidebarStatusBadge";

const LOCAL = EnvironmentId.make("footer-local");
const REMOTE = EnvironmentId.make("footer-remote");
const NOW = "2026-10-07T12:00:00.000Z";
const behindState: DesktopSourceUpdateState = {
  status: "behind",
  branch: "dev",
  trackedBranch: "dev",
  runtimeHash: "1111111111111111111111111111111111111111",
  localHash: "1111111111111111111111111111111111111111",
  remoteHash: "2222222222222222222222222222222222222222",
  mergeBaseHash: "1111111111111111111111111111111111111111",
  dirty: false,
  checkedAt: NOW,
  message: null,
};

let originalFontSize: string;
let originalDark: boolean;
beforeEach(async () => {
  await page.viewport(800, 600);
  originalFontSize = document.documentElement.style.fontSize;
  originalDark = document.documentElement.classList.contains("dark");
  resetWsConnectionStateForTests();
  resetWorkspaceEnvironmentForTests();
  fixture.sourceUpdate = behindState;
  fixture.retryPrimary.mockClear();
  fixture.retrySaved.mockClear();
  writePrimaryEnvironmentDescriptor({
    environmentId: LOCAL,
    label: "Local fixture",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  });
  recordWsConnectionOpened({ connectionLabel: "Local fixture" });
  useSavedEnvironmentRegistryStore.setState({
    byId: {
      [REMOTE]: {
        environmentId: REMOTE,
        label: "Remote fixture",
        httpBaseUrl: "https://footer-fixture.invalid",
        wsBaseUrl: "wss://footer-fixture.invalid",
        createdAt: NOW,
        lastConnectedAt: NOW,
      },
    },
  });
  useSavedEnvironmentRuntimeStore.setState({ byId: {} });
  useSavedEnvironmentRuntimeStore.getState().patch(REMOTE, {
    connectionState: "connected",
    connectedAt: NOW,
  });
});

afterEach(() => {
  document.documentElement.style.fontSize = originalFontSize;
  document.documentElement.classList.toggle("dark", originalDark);
  resetWsConnectionStateForTests();
  resetWorkspaceEnvironmentForTests();
  resetPrimaryEnvironmentDescriptorForTests();
  useSavedEnvironmentRegistryStore.setState({ byId: {} });
  useSavedEnvironmentRuntimeStore.setState({ byId: {} });
});

async function mountFooter(width = 320) {
  const host = document.createElement("div");
  host.style.width = `${width}px`;
  host.style.height = "600px";
  document.body.append(host);
  const screen = await render(
    <AppAtomRegistryProvider>
      <SidebarProvider
        className="h-full min-h-0"
        style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      >
        <Sidebar collapsible="none">
          <SidebarFooter className="mt-auto p-2">
            <SidebarFooterNavigation
              atriumEnabled={false}
              atriumOpen={false}
              settingsActive={false}
              onOpenAtrium={vi.fn()}
              onOpenSettings={vi.fn()}
              settingsTrailing={<SidebarStatusBadge />}
            />
          </SidebarFooter>
        </Sidebar>
      </SidebarProvider>
    </AppAtomRegistryProvider>,
    { container: host },
  );
  return {
    host,
    screen,
    async cleanup() {
      await screen.unmount();
      host.remove();
    },
  };
}

function connectionChip(host: HTMLElement) {
  return host.querySelector<HTMLButtonElement>("[data-cafe-connection-status]");
}

async function waitForReconnect(host: HTMLElement) {
  await vi.waitFor(
    () => {
      expect(connectionChip(host)?.textContent).toBe("Reconnecting…");
      expect(host.querySelector("[data-cafe-source-update-badge]")).toBeNull();
    },
    { timeout: 5_000 },
  );
}

describe("SidebarStatusBadge", () => {
  it("replaces the build badge beside Settings during reconnect, then restores it", async () => {
    const mounted = await mountFooter();
    try {
      expect(mounted.host.textContent).toContain("Newer dev");
      recordWsConnectionClosed();
      // Brief reconnects keep the lower-priority badge without flashing.
      expect(connectionChip(mounted.host)).toBeNull();
      await waitForReconnect(mounted.host);
      expect(
        connectionChip(mounted.host)?.closest('[data-sidebar="menu-item"]')?.textContent,
      ).toContain("Settings");

      await mounted.screen.getByRole("button", { name: "Connection Reconnecting…" }).click();
      await expect.element(page.getByText("Disconnected from Local fixture")).toBeVisible();
      await page.getByRole("button", { name: "Retry now", exact: true }).click();
      expect(fixture.retryPrimary).toHaveBeenCalledOnce();
      expect(fixture.retrySaved).not.toHaveBeenCalled();

      recordWsConnectionOpened();
      await vi.waitFor(
        () => {
          expect(connectionChip(mounted.host)).toBeNull();
          expect(mounted.host.textContent).toContain("Newer dev");
        },
        { timeout: 5_000 },
      );
      await expect
        .element(page.getByText("Disconnected from Local fixture"))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("never swaps the badge for a reconnect that finishes before the display delay", async () => {
    const mounted = await mountFooter();
    const observer = new MutationObserver(() => {
      if (connectionChip(mounted.host)) shown = true;
    });
    let shown = false;
    observer.observe(mounted.host, { childList: true, subtree: true });
    try {
      recordWsConnectionClosed();
      await new Promise((resolve) => setTimeout(resolve, 150));
      recordWsConnectionOpened();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(shown).toBe(false);
      expect(mounted.host.textContent).toContain("Newer dev");
    } finally {
      observer.disconnect();
      await mounted.cleanup();
    }
  });

  it("uses the selected remote server and discards its warning when switching servers", async () => {
    selectWorkspaceEnvironment(REMOTE);
    recordWsConnectionClosed();
    const mounted = await mountFooter();
    try {
      // Losing the primary transport does not mislabel a healthy selected remote.
      expect(mounted.host.textContent).toContain("Newer dev");
      useSavedEnvironmentRuntimeStore.getState().patch(REMOTE, {
        connectionState: "disconnected",
        disconnectedAt: NOW,
        reconnectPhase: "waiting",
        reconnectAttemptCount: 1,
      });
      await waitForReconnect(mounted.host);
      await mounted.screen.getByRole("button", { name: "Connection Reconnecting…" }).click();
      await expect.element(page.getByText("Disconnected from Remote fixture")).toBeVisible();
      await page.getByRole("button", { name: "Retry now", exact: true }).click();
      expect(fixture.retrySaved).toHaveBeenCalledExactlyOnceWith(REMOTE);
      expect(fixture.retryPrimary).not.toHaveBeenCalled();

      recordWsConnectionOpened();
      selectWorkspaceEnvironment(LOCAL);
      await vi.waitFor(() => {
        expect(connectionChip(mounted.host)).toBeNull();
        expect(mounted.host.textContent).toContain("Newer dev");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows connection issues even without an available build badge", async () => {
    fixture.sourceUpdate = null;
    const mounted = await mountFooter();
    try {
      recordWsConnectionClosed();
      await waitForReconnect(mounted.host);
      recordWsConnectionOpened();
      await vi.waitFor(
        () => {
          expect(connectionChip(mounted.host)).toBeNull();
          expect(mounted.host.querySelector("[data-cafe-source-update-badge]")).toBeNull();
        },
        { timeout: 5_000 },
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it.each([
    [false, 80],
    [false, 130],
    [true, 80],
    [true, 130],
  ] as const)(
    "keeps the footer inside a narrow sidebar (dark=%s, scale=%s)",
    async (dark, scale) => {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.fontSize = `${scale}%`;
      const mounted = await mountFooter(208);
      try {
        recordWsConnectionClosed();
        await waitForReconnect(mounted.host);
        const settings = mounted.host.querySelector<HTMLButtonElement>(
          '[data-sidebar="menu-button"]',
        )!;
        const chip = connectionChip(mounted.host)!;
        const settingsBounds = settings.getBoundingClientRect();
        const chipBounds = chip.getBoundingClientRect();
        const hostBounds = mounted.host.getBoundingClientRect();
        expect(settingsBounds.width).toBeGreaterThan(40);
        expect(settingsBounds.right).toBeLessThanOrEqual(chipBounds.left);
        expect(chipBounds.right).toBeLessThanOrEqual(hostBounds.right);
        chip.focus();
        await userEvent.keyboard("{Enter}");
        await expect.element(page.getByText("Disconnected from Local fixture")).toBeVisible();
        await vi.waitFor(() => {
          const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
          expect(popup.getBoundingClientRect().bottom).toBeLessThanOrEqual(chipBounds.top);
        });
      } finally {
        await mounted.cleanup();
      }
    },
  );
});
