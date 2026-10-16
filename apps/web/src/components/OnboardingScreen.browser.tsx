import "../index.css";

import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@cafecode/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@cafecode/contracts/settings";
import { getUiLocale, setUiLocale } from "@cafecode/shared/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  config: null as Pick<ServerConfig, "providers" | "settings"> | null,
  listeners: new Set<() => void>(),
  refresh: vi.fn(async () => {}),
  updateSettings: vi.fn(),
}));

// Native host identity is fixed before imports. Only server/settings projection
// and outbound actions are synthetic; status, titlebar hooks and CSS are real.
vi.mock("../env", () => ({ isElectron: true }));
vi.mock("../rpc/serverState", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useServerConfig: () =>
      useSyncExternalStore(
        (listener) => {
          fixture.listeners.add(listener);
          return () => fixture.listeners.delete(listener);
        },
        () => fixture.config,
      ),
  };
});
vi.mock("../hooks/useSettings", () => ({
  useSettings: (select: (settings: UnifiedSettings) => unknown) => select(DEFAULT_UNIFIED_SETTINGS),
  useUpdateSettings: () => ({ updateSettings: fixture.updateSettings }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }));
vi.mock("../localApi", () => ({
  ensureLocalApi: () => ({ server: { refreshProviders: fixture.refresh } }),
}));

import { applyInterfaceScalePercent } from "../interfaceScale";
import { OnboardingScreen } from "./OnboardingScreen";

const originalLocale = getUiLocale();
let mounted: Awaited<ReturnType<typeof render>> | undefined;

beforeEach(async () => {
  fixture.config = { providers: [], settings: DEFAULT_SERVER_SETTINGS };
  vi.clearAllMocks();
  setUiLocale("en");
  applyInterfaceScalePercent(100);
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  await page.viewport(1100, 900);
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  applyInterfaceScalePercent(100);
  setUiLocale(originalLocale);
  vi.restoreAllMocks();
});

async function openProviders() {
  mounted = await render(<OnboardingScreen />);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.element(page.getByRole("heading", { name: "Connect a provider" })).toBeVisible();
}

function axiomCard() {
  const heading = page.getByRole("heading", { name: "Axiom", exact: true }).element();
  return heading.closest("li")!;
}

function configureAxiom() {
  fixture.config = {
    providers: [],
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("personal_axiom")]: {
          driver: ProviderDriverKind.make("axiom"),
          enabled: true,
          config: { binaryPath: "axiomcli" },
        },
      },
    },
  };
}

function publishConfig(config: NonNullable<typeof fixture.config>) {
  fixture.config = config;
  for (const listener of fixture.listeners) listener();
}

describe("onboarding provider status", () => {
  it("awaits the default Axiom probe and settles a missing CLI, including after refresh", async () => {
    await openProviders();
    expect(axiomCard().textContent).toContain("Checking…");
    expect(fixture.config!.settings.providerInstances[ProviderInstanceId.make("axiom")]).toEqual({
      driver: "axiom",
      enabled: true,
    });
    publishConfig({
      ...fixture.config!,
      providers: [
        {
          instanceId: ProviderInstanceId.make("axiom"),
          driver: ProviderDriverKind.make("axiom"),
          enabled: true,
          installed: false,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          checkedAt: "2026-10-15T00:00:00.000Z",
          message: "Fixture CLI missing",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ],
    });
    await expect.element(page.getByText("Not found", { exact: true })).toBeVisible();
    expect(axiomCard().textContent).not.toContain("Checking");
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    expect(fixture.refresh).toHaveBeenCalledTimes(1);
    expect(axiomCard().textContent).toContain("Not found");
    expect(fixture.updateSettings).not.toHaveBeenCalled();
  });

  it("retains checking until the server reports the default account", async () => {
    fixture.config = null;
    await openProviders();
    expect(page.getByText("Checking…", { exact: true }).elements()).toHaveLength(5);
    expect(axiomCard().textContent).not.toContain("Not configured");
    publishConfig({ providers: [], settings: DEFAULT_SERVER_SETTINGS });
    expect(page.getByText("Checking…", { exact: true }).elements()).toHaveLength(5);
    expect(axiomCard().textContent).not.toContain("Not configured");
  });

  it("awaits an explicitly configured Axiom account and then displays its exact status", async () => {
    configureAxiom();
    await openProviders();
    expect(axiomCard().textContent).toContain("Checking…");
    expect(axiomCard().textContent).not.toContain("Not configured");
    const provider: ServerProvider = {
      instanceId: ProviderInstanceId.make("personal_axiom"),
      driver: ProviderDriverKind.make("axiom"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", label: "Fixture account" },
      checkedAt: "2026-10-15T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    publishConfig({ ...fixture.config!, providers: [provider] });
    await expect
      .element(page.getByText("Authenticated · Fixture account", { exact: true }))
      .toBeVisible();
    expect(axiomCard().textContent).not.toContain("Checking");
    publishConfig({
      ...fixture.config!,
      providers: [
        { ...provider, installed: false, status: "error", message: "Fixture CLI missing" },
      ],
    });
    await expect.element(page.getByText("Not found", { exact: true })).toBeVisible();
    expect(axiomCard().textContent).toContain("Fixture CLI missing");
  });
});

describe("onboarding native titlebar", () => {
  it.each([80, 100, 130].flatMap((scale) => [390, 1100].map((width) => ({ scale, width }))))(
    "reserves fixed macOS clearance at $scale% and width=$width",
    async ({ scale, width }) => {
      applyInterfaceScalePercent(scale);
      await page.viewport(width, 900);
      mounted = await render(<OnboardingScreen />);
      const header = document.querySelector("[data-testid='onboarding-screen'] header")!;
      const label = header.querySelector("span")!;
      const skip = page.getByRole("button", { name: "Skip", exact: true }).element();
      const bounds = header.getBoundingClientRect();
      expect(header.getAttribute("data-mac-titlebar")).toBe("true");
      expect(bounds.height).toBe(50);
      expect(label.getBoundingClientRect().left - bounds.left).toBe(90);
      expect(skip.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right);
      expect(skip.getBoundingClientRect().top).toBeGreaterThan(bounds.top);
      expect(skip.getBoundingClientRect().bottom).toBeLessThan(bounds.bottom);
      expect(getComputedStyle(header).getPropertyValue("-webkit-app-region")).toBe("drag");
      expect(getComputedStyle(skip).getPropertyValue("-webkit-app-region")).toBe("no-drag");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      expect(label.textContent).toBe("Connect a provider");
      expect(label.getBoundingClientRect().left - bounds.left).toBe(90);
      await page.getByRole("button", { name: "Skip", exact: true }).click();
      expect(fixture.updateSettings).toHaveBeenCalledExactlyOnceWith({ onboardingCompleted: true });
    },
  );

  it.each(["Win32", "Linux x86_64"])(
    "preserves ordinary desktop insets on %s",
    async (platform) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      mounted = await render(<OnboardingScreen />);
      const header = document.querySelector("[data-testid='onboarding-screen'] header")!;
      expect(header.getAttribute("data-mac-titlebar")).toBe("false");
      expect(header.getBoundingClientRect().height).toBe(44);
      expect(parseFloat(getComputedStyle(header).paddingLeft)).toBe(16);
    },
  );
});
