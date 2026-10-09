import "../../index.css";

import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { EnvironmentId } from "@cafecode/contracts";
import { createModelCapabilities } from "@cafecode/shared/model";
import type { CDPSession } from "@vitest/browser-playwright";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderModelPicker } from "./ProviderModelPicker";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import type { ModelEsque } from "./providerIconUtils";
import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@cafecode/contracts/settings";
import { __resetLocalApiForTests } from "../../localApi";
import { applyInterfaceScalePercent } from "../../interfaceScale";

// Mock the environments/runtime module to provide a mock primary environment connection
vi.mock("../../environments/runtime", () => {
  const primaryConnection = {
    kind: "primary" as const,
    knownEnvironment: {
      id: "environment-local",
      label: "Local environment",
      source: "manual" as const,
      environmentId: EnvironmentId.make("environment-local"),
      target: {
        httpBaseUrl: "http://localhost:3000",
        wsBaseUrl: "ws://localhost:3000",
      },
    },
    environmentId: EnvironmentId.make("environment-local"),
    client: {
      server: {
        getConfig: vi.fn(),
        updateSettings: vi.fn().mockResolvedValue(undefined),
        getClientSettings: vi.fn().mockResolvedValue(null),
        updateClientSettings: vi.fn().mockResolvedValue(undefined),
      },
    },
    ensureBootstrapped: async () => undefined,
    reconnect: async () => undefined,
    dispose: async () => undefined,
  };

  return {
    getEnvironmentHttpBaseUrl: () => "http://localhost:3000",
    resolveEnvironmentHttpUrl: (input: { readonly pathname: string }) =>
      new URL(input.pathname, "http://localhost:3000").toString(),
    ensureEnvironmentConnectionBootstrapped: async () => undefined,
    getPrimaryEnvironmentConnection: () => primaryConnection,
    readEnvironmentConnection: () => primaryConnection,
    requireEnvironmentConnection: () => primaryConnection,
    resetEnvironmentServiceForTests: vi.fn(),
    startEnvironmentConnectionService: vi.fn(),
    subscribeEnvironmentConnections: () => () => {},
  };
});

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
) {
  return {
    id,
    label,
    type: "select" as const,
    options: [...options],
    ...(options.find((option) => option.isDefault)?.id
      ? { currentValue: options.find((option) => option.isDefault)?.id }
      : {}),
  };
}

function booleanDescriptor(id: string, label: string) {
  return {
    id,
    label,
    type: "boolean" as const,
  };
}

const TEST_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "gpt-5-codex",
        name: "GPT-5 Codex",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoningEffort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("fastMode", "Fast Mode"),
          ],
        }),
      },
      {
        slug: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("reasoningEffort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("fastMode", "Fast Mode"),
          ],
        }),
      },
    ],
  },
  {
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: ProviderInstanceId.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    slashCommands: [],
    skills: [],
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
              { id: "max", label: "max" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
              { id: "max", label: "max" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        isCustom: false,
        capabilities: createModelCapabilities({
          optionDescriptors: [
            selectDescriptor("effort", "Reasoning", [
              { id: "low", label: "low" },
              { id: "medium", label: "medium", isDefault: true },
              { id: "high", label: "high" },
            ]),
            booleanDescriptor("thinking", "Thinking"),
          ],
        }),
      },
    ],
  },
];

const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const CLAUDE_PARTNER_INSTANCE_ID = ProviderInstanceId.make("claude_partner");

function buildCodexProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    driver: ProviderDriverKind.make("codex"),
    instanceId: ProviderInstanceId.make("codex"),
    displayName: "Codex",
    enabled: true,
    installed: true,
    version: "0.116.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
    slashCommands: [],
    skills: [],
  };
}

function buildClaudePartnerProvider(models: ServerProvider["models"]): ServerProvider {
  return {
    driver: ProviderDriverKind.make("claudeAgent"),
    instanceId: CLAUDE_PARTNER_INSTANCE_ID,
    displayName: "Claude Partner",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: new Date().toISOString(),
    models,
    slashCommands: [],
    skills: [],
  };
}

async function mountPicker(props: {
  activeInstanceId?: ProviderInstanceId;
  model: string;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  providers?: ReadonlyArray<ServerProvider>;
  settings?: UnifiedSettings;
  triggerVariant?: "ghost" | "outline";
  compact?: boolean;
  hostWidth?: number;
  onRequestModelsRefresh?: (instanceId: ProviderInstanceId) => void;
}) {
  const host = document.createElement("div");
  if (props.hostWidth !== undefined) {
    host.style.display = "flex";
    host.style.width = `${props.hostWidth}px`;
  }
  document.body.append(host);
  const onInstanceModelChange = vi.fn();
  const onRequestModelsRefresh = props.onRequestModelsRefresh ?? vi.fn();
  const providers = props.providers ?? TEST_PROVIDERS;
  const instanceEntries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
  const activeInstanceId = props.activeInstanceId ?? CODEX_INSTANCE_ID;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    props.settings ?? DEFAULT_UNIFIED_SETTINGS,
    providers,
    activeInstanceId,
    props.model,
  );
  const screen = await render(
    <ProviderModelPicker
      activeInstanceId={activeInstanceId}
      model={props.model}
      lockedProvider={props.lockedProvider}
      lockedContinuationGroupKey={props.lockedContinuationGroupKey ?? null}
      instanceEntries={instanceEntries}
      modelOptionsByInstance={modelOptionsByInstance}
      {...(props.compact !== undefined ? { compact: props.compact } : {})}
      triggerVariant={props.triggerVariant}
      onRequestModelsRefresh={onRequestModelsRefresh}
      onInstanceModelChange={onInstanceModelChange}
    />,
    { container: host },
  );

  return {
    host,
    onInstanceModelChange,
    onRequestModelsRefresh,
    // Back-compat alias used by callers that still assert on the old callback
    // name. Delegates to the instance-aware mock so existing expectations work.
    get onProviderModelChange() {
      return onInstanceModelChange;
    },
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

function getModelPickerListElement() {
  const modelPickerList = document.querySelector<HTMLElement>(".model-picker-list");
  expect(modelPickerList).not.toBeNull();
  return modelPickerList!;
}

function getModelPickerListText() {
  return getModelPickerListElement().textContent ?? "";
}

function getVisibleModelNames() {
  return Array.from(getModelPickerListElement().querySelectorAll<HTMLDivElement>("div.font-medium"))
    .map((element) => element.textContent?.replace(/New$/u, "").trim() ?? "")
    .filter((text) => text.length > 0);
}

function getSidebarProviderOrder() {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-model-picker-provider]")).map(
    (element) => element.dataset.modelPickerProvider ?? "",
  );
}

/**
 * Keep the account-scroll fixture entirely in memory. Every account has its
 * own model names and routing ids so a scroll-induced account/model change
 * cannot pass by accidentally finding an identically named provider model.
 */
function buildManyAccountProviders(): ReadonlyArray<ServerProvider> {
  return Array.from({ length: 24 }, (_, index) => {
    const ordinal = String(index + 1).padStart(2, "0");
    const isCodex = index % 2 === 0;
    const displayName = `${isCodex ? "Codex" : "Claude"} account ${ordinal}`;
    return {
      driver: ProviderDriverKind.make(isCodex ? "codex" : "claudeAgent"),
      instanceId: ProviderInstanceId.make(`scroll_${isCodex ? "codex" : "claude"}_${ordinal}`),
      displayName,
      enabled: true,
      installed: true,
      version: "fixture-only",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-10T00:00:00.000Z",
      slashCommands: [],
      skills: [],
      // The first account also overflows the model pane. Other accounts use
      // short catalogues to verify that their bottom rail icons stay usable
      // independently of the selected catalogue's natural height.
      models: Array.from({ length: index === 0 ? 24 : 3 }, (_, modelIndex) => ({
        slug: `fixture-account-${ordinal}-model-${modelIndex + 1}`,
        name: `${displayName} model ${modelIndex + 1}`,
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      })),
    };
  });
}

/** CDP input uses the runner viewport, including the test iframe's scale. */
function modelPickerBrowserPoint(point: { x: number; y: number }) {
  let { x, y } = point;
  let frame = window.frameElement;
  while (frame) {
    const element = frame as HTMLElement;
    const rect = element.getBoundingClientRect();
    x = rect.left + (x + element.clientLeft) * (rect.width / element.offsetWidth);
    y = rect.top + (y + element.clientTop) * (rect.height / element.offsetHeight);
    frame = frame.ownerDocument.defaultView?.frameElement ?? null;
  }
  return { x, y };
}

/** Real Chromium wheel input exercises native scrolling; a DOM event cannot. */
async function wheelModelPickerViewport(input: CDPSession, viewport: HTMLElement, deltaY: number) {
  const rect = viewport.getBoundingClientRect();
  const point = modelPickerBrowserPoint({
    x: rect.left + rect.width / 2,
    y: rect.top + Math.min(rect.height / 2, 100),
  });
  await input.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await input.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    ...point,
    deltaX: 0,
    deltaY,
  });
}

function getModelPickerScrollRegions() {
  const sidebar = document.querySelector<HTMLElement>("[data-model-picker-sidebar]");
  const railViewport = sidebar?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
  const modelViewport = getModelPickerListElement().closest<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  );
  const surface = sidebar?.parentElement;
  const popupViewport = sidebar?.closest<HTMLElement>('[data-slot="popover-viewport"]');
  expect(railViewport).toBeInstanceOf(HTMLElement);
  expect(modelViewport).toBeInstanceOf(HTMLElement);
  expect(surface).toBeInstanceOf(HTMLElement);
  expect(popupViewport).toBeInstanceOf(HTMLElement);
  return {
    railViewport: railViewport!,
    modelViewport: modelViewport!,
    surface: surface!,
    popupViewport: popupViewport!,
  };
}

function assertModelPickerRailBounds(railViewport: HTMLElement, surface: HTMLElement) {
  const railBounds = railViewport.getBoundingClientRect();
  const surfaceBounds = surface.getBoundingClientRect();
  // Include concrete browser geometry in failure output so the regression
  // distinguishes a clipped, naturally sized viewport from a wheel issue.
  const geometry = JSON.stringify({
    rail: {
      clientHeight: railViewport.clientHeight,
      scrollHeight: railViewport.scrollHeight,
      top: railBounds.top,
      bottom: railBounds.bottom,
    },
    surface: { top: surfaceBounds.top, bottom: surfaceBounds.bottom, height: surfaceBounds.height },
  });
  expect(railViewport.clientHeight, geometry).toBeGreaterThan(0);
  expect(railBounds.bottom, geometry).toBeLessThanOrEqual(surfaceBounds.bottom + 1);
  expect(railViewport.scrollHeight, geometry).toBeGreaterThan(railViewport.clientHeight);
}

function assertAccountFitsRail(button: HTMLElement, railViewport: HTMLElement) {
  const buttonBounds = button.getBoundingClientRect();
  const railBounds = railViewport.getBoundingClientRect();
  expect(buttonBounds.top).toBeGreaterThanOrEqual(railBounds.top - 1);
  expect(buttonBounds.bottom).toBeLessThanOrEqual(railBounds.bottom + 1);
  // Account icons must retain their square hit area instead of shrinking to
  // make a long list appear to fit without providing an actual scroll owner.
  expect(buttonBounds.height).toBeCloseTo(buttonBounds.width, 0);
}

describe("ProviderModelPicker", () => {
  beforeEach(async () => {
    // Reset test environment before each test
    await __resetLocalApiForTests();
    localStorage.clear();
  });

  afterEach(async () => {
    document.body.innerHTML = "";
    localStorage.clear();
    await __resetLocalApiForTests();
  });

  it("requests one bounded catalogue refresh for each closed-to-open transition", async () => {
    const onRequestModelsRefresh = vi.fn();
    const mounted = await mountPicker({
      activeInstanceId: CODEX_INSTANCE_ID,
      model: "gpt-5.6-sol",
      lockedProvider: ProviderDriverKind.make("codex"),
      onRequestModelsRefresh,
    });

    try {
      // Keep the trigger distinct from favorite buttons that can remain in
      // the closing popup until its exit transition retires the portal.
      const trigger = page.getByRole("button", { name: "GPT-5 Codex", exact: true });
      await trigger.click();
      await vi.waitFor(() => {
        expect(onRequestModelsRefresh).toHaveBeenCalledTimes(1);
        expect(onRequestModelsRefresh).toHaveBeenLastCalledWith(CODEX_INSTANCE_ID);
      });

      // Rerenders while the picker remains open must not generate duplicate
      // model/list requests; close and reopen is the next explicit refresh.
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
      await trigger.click();
      await vi.waitFor(() => {
        expect(onRequestModelsRefresh).toHaveBeenCalledTimes(2);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses available compact-footer width to show Daybreak Blue without clipping", async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(477, Math.max(700, originalViewport.height));

    const daybreakModel = {
      slug: "gpt-daybreak-blue-latest",
      name: "Daybreak Blue",
      isCustom: false,
      capabilities: createModelCapabilities({ optionDescriptors: [] }),
    };
    const mounted = await mountPicker({
      activeInstanceId: CODEX_INSTANCE_ID,
      model: daybreakModel.slug,
      lockedProvider: ProviderDriverKind.make("codex"),
      providers: [buildCodexProvider([daybreakModel])],
      compact: true,
      hostWidth: 260,
    });

    try {
      await vi.waitFor(() => {
        const trigger = document.querySelector<HTMLElement>(
          '[data-chat-provider-model-picker="true"]',
        );
        const title = document.querySelector<HTMLElement>(
          '[data-provider-model-trigger-title="true"]',
        );
        expect(trigger).not.toBeNull();
        expect(title?.textContent).toBe("Daybreak Blue");
        expect(title!.scrollWidth).toBeLessThanOrEqual(title!.clientWidth);
        expect(trigger!.getBoundingClientRect().right).toBeLessThanOrEqual(
          mounted.host.getBoundingClientRect().right,
        );
      });

      mounted.host.style.width = "120px";
      await vi.waitFor(() => {
        const trigger = document.querySelector<HTMLElement>(
          '[data-chat-provider-model-picker="true"]',
        );
        expect(trigger!.getBoundingClientRect().right).toBeLessThanOrEqual(
          mounted.host.getBoundingClientRect().right,
        );
      });
    } finally {
      await mounted.cleanup();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });

  it("shows provider sidebar in unlocked mode", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).not.toContain("Codex");
        expect(text).toContain("Claude");
        expect(text).toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows favorites first in the provider sidebar", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder().slice(0, 3)).toEqual([
          "favorites",
          "codex",
          "claudeAgent",
        ]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it.each(
    (["light", "dark"] as const).flatMap((theme) => [80, 130].map((scale) => ({ theme, scale }))),
  )(
    "independently scrolls many account icons and models at narrow $theme/$scale%",
    async ({ theme, scale }) => {
      const root = document.documentElement;
      const originalFontSize = root.style.fontSize;
      const originallyDark = root.classList.contains("dark");
      const originalViewport = { width: window.innerWidth, height: window.innerHeight };
      const originalReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const input: CDPSession = cdp();
      const providers = buildManyAccountProviders();
      const firstAccount = providers[0]!;
      const lastAccount = providers.at(-1)!;
      const firstModel = firstAccount.models[0]!;
      const lastAccountModel = lastAccount.models[0]!;
      let mounted: Awaited<ReturnType<typeof mountPicker>> | undefined;

      try {
        await page.viewport(390, 700);
        applyInterfaceScalePercent(scale);
        root.classList.toggle("dark", theme === "dark");
        // Exercise the same layout with native reduced-motion preferences at
        // the large interface bound; no animation deadline is relaxed.
        await input.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-reduced-motion", value: scale === 130 ? "reduce" : "no-preference" },
          ],
        });
        mounted = await mountPicker({
          activeInstanceId: firstAccount.instanceId,
          model: firstModel.slug,
          lockedProvider: null,
          providers,
        });
        await page.getByRole("button", { name: firstModel.name, exact: true }).click();
        await expect.element(page.getByPlaceholder("Search models...")).toHaveFocus();
        const { railViewport, modelViewport, surface, popupViewport } =
          getModelPickerScrollRegions();
        await vi.waitFor(() => assertModelPickerRailBounds(railViewport, surface));
        expect(getSidebarProviderOrder()[0]).toBe("favorites");
        expect(modelViewport.scrollHeight).toBeGreaterThan(modelViewport.clientHeight);
        const lastButton = page
          .getByRole("button", { name: lastAccount.displayName!, exact: true })
          .element() as HTMLElement;
        expect(lastButton.getBoundingClientRect().top).toBeGreaterThan(
          railViewport.getBoundingClientRect().bottom,
        );
        const initialModelScrollTop = modelViewport.scrollTop;
        const initialPopupScrollTop = popupViewport.scrollTop;
        const initialListText = getModelPickerListText();

        await wheelModelPickerViewport(input, railViewport, 10_000);
        await vi.waitFor(() => {
          expect(railViewport.scrollTop).toBeGreaterThan(0);
          assertAccountFitsRail(lastButton, railViewport);
        });
        expect(modelViewport.scrollTop).toBe(initialModelScrollTop);
        expect(popupViewport.scrollTop).toBe(initialPopupScrollTop);
        expect(getModelPickerListText()).toBe(initialListText);
        expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
        const railScrollTop = railViewport.scrollTop;

        await wheelModelPickerViewport(input, modelViewport, 240);
        await vi.waitFor(() =>
          expect(modelViewport.scrollTop).toBeGreaterThan(initialModelScrollTop),
        );
        expect(railViewport.scrollTop).toBe(railScrollTop);
        expect(popupViewport.scrollTop).toBe(initialPopupScrollTop);
        expect(getModelPickerListText()).toBe(initialListText);
        expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();

        // Restore only the rail with native wheel input, then focus the last
        // account. Native focus must reveal it inside its own scroll viewport
        // without moving the model pane or committing the composer choice.
        const modelScrollTop = modelViewport.scrollTop;
        await wheelModelPickerViewport(input, railViewport, -10_000);
        await vi.waitFor(() => expect(railViewport.scrollTop).toBe(0));
        expect(modelViewport.scrollTop).toBe(modelScrollTop);
        expect(popupViewport.scrollTop).toBe(initialPopupScrollTop);
        lastButton.focus();
        await vi.waitFor(() => {
          expect(document.activeElement).toBe(lastButton);
          assertAccountFitsRail(lastButton, railViewport);
        });
        expect(modelViewport.scrollTop).toBe(modelScrollTop);
        expect(popupViewport.scrollTop).toBe(initialPopupScrollTop);
        expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
        await userEvent.keyboard("{Enter}");
        await expect.element(page.getByPlaceholder("Search models...")).toHaveFocus();
        await vi.waitFor(() => {
          expect(getModelPickerListText()).toContain(lastAccountModel.name);
          expect(getModelPickerListText()).not.toContain(firstModel.name);
        });
        expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
        // Browsing another account is local picker state. Only the explicit
        // model row choice may publish the exact account-and-model tuple.
        await page.getByText(lastAccountModel.name, { exact: true }).click();
        expect(mounted.onInstanceModelChange).toHaveBeenCalledExactlyOnceWith(
          lastAccount.instanceId,
          lastAccountModel.slug,
        );
        expect(mounted.onRequestModelsRefresh).toHaveBeenCalledExactlyOnceWith(
          firstAccount.instanceId,
        );
      } finally {
        await mounted?.cleanup();
        root.style.fontSize = originalFontSize;
        root.classList.toggle("dark", originallyDark);
        await input.send("Emulation.setEmulatedMedia", {
          features: [
            {
              name: "prefers-reduced-motion",
              value: originalReducedMotion ? "reduce" : "no-preference",
            },
          ],
        });
        await page.viewport(originalViewport.width, originalViewport.height);
      }
    },
  );

  it.each([
    { mode: "compact", lockedProvider: null },
    { mode: "locked", lockedProvider: ProviderDriverKind.make("codex") },
  ])("keeps bottom accounts reachable in the $mode picker", async ({ lockedProvider }) => {
    const providers = buildManyAccountProviders();
    const firstAccount = providers[0]!;
    const eligibleProviders = lockedProvider
      ? providers.filter((provider) => provider.driver === lockedProvider)
      : providers;
    const lastAccount = eligibleProviders.at(-1)!;
    const lastModel = lastAccount.models[0]!;
    const mounted = await mountPicker({
      activeInstanceId: firstAccount.instanceId,
      model: firstAccount.models[0]!.slug,
      lockedProvider,
      compact: true,
      providers,
    });
    try {
      await page.getByRole("button").click();
      await expect.element(page.getByPlaceholder("Search models...")).toHaveFocus();
      const { railViewport, surface, popupViewport } = getModelPickerScrollRegions();
      await vi.waitFor(() => assertModelPickerRailBounds(railViewport, surface));
      expect(getSidebarProviderOrder()).toEqual([
        ...(lockedProvider ? [] : ["favorites"]),
        ...sortProviderInstanceEntries(deriveProviderInstanceEntries(eligibleProviders)).map(
          (entry) => entry.instanceId,
        ),
      ]);
      const initialPopupScrollTop = popupViewport.scrollTop;
      await wheelModelPickerViewport(cdp(), railViewport, 10_000);
      const lastButton = page.getByRole("button", { name: lastAccount.displayName!, exact: true });
      await vi.waitFor(() =>
        assertAccountFitsRail(lastButton.element() as HTMLElement, railViewport),
      );
      expect(popupViewport.scrollTop).toBe(initialPopupScrollTop);
      await lastButton.click();
      await expect.element(page.getByPlaceholder("Search models...")).toHaveFocus();
      expect(getModelPickerListText()).toContain(lastModel.name);
      expect(mounted.onInstanceModelChange).not.toHaveBeenCalled();
      await page.getByText(lastModel.name, { exact: true }).click();
      expect(mounted.onInstanceModelChange).toHaveBeenCalledExactlyOnceWith(
        lastAccount.instanceId,
        lastModel.slug,
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("filters models by selected provider in sidebar", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      // Start with Claude models visible
      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).not.toContain("GPT-5 Codex");
        expect(text).toContain("Claude Opus 4.6");
      });

      // Click on Codex provider in sidebar
      await vi.waitFor(() => {
        expect(document.querySelector('[data-model-picker-provider="codex"]')).not.toBeNull();
      });
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      // Now should only show Codex models
      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("GPT-5 Codex");
        expect(listText).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("uses client model visibility and ordering preferences", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerModelPreferences: {
          [CLAUDE_INSTANCE_ID]: {
            hiddenModels: ["claude-opus-4-6"],
            modelOrder: ["claude-haiku-4-5", "claude-sonnet-4-6"],
          },
        },
      },
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Claude Haiku 4.5", "Claude Sonnet 4.6"]);
        expect(getModelPickerListText()).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("focuses the search input after selecting a sidebar provider", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-model-picker-provider="codex"]')).not.toBeNull();
      });
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      await vi.waitFor(() => {
        const searchInput = document.querySelector<HTMLInputElement>(
          'input[placeholder="Search models..."]',
        );
        expect(searchInput).not.toBeNull();
        expect(document.activeElement).toBe(searchInput);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows locked provider header and only its models in locked mode", async () => {
    localStorage.setItem(
      "cafecode:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [
          { provider: "codex", model: "gpt-5-codex" },
          { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        ],
      }),
    );

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        // Should show locked provider label
        expect(text).toContain("Claude");
        expect(getVisibleModelNames()).toEqual([
          "Claude Sonnet 4.6",
          "Claude Opus 4.6",
          "Claude Haiku 4.5",
        ]);
      });
    } finally {
      localStorage.removeItem("cafecode:client-settings:v1");
      await mounted.cleanup();
    }
  });

  it("keeps an instance sidebar in locked mode when that provider has multiple instances", async () => {
    const defaultCodexModels: ServerProvider["models"] = [
      {
        slug: "gpt-work",
        name: "GPT Work",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ];
    const personalCodexModels: ServerProvider["models"] = [
      {
        slug: "gpt-personal",
        name: "GPT Personal",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ];
    const isolatedCodexModels: ServerProvider["models"] = [
      {
        slug: "gpt-isolated",
        name: "GPT Isolated",
        isCustom: false,
        capabilities: createModelCapabilities({ optionDescriptors: [] }),
      },
    ];
    const providers: ReadonlyArray<ServerProvider> = [
      {
        ...buildCodexProvider(defaultCodexModels),
        instanceId: "codex" as ProviderInstanceId,
        displayName: "Codex Work",
        accentColor: "#2563eb",
        continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      },
      {
        ...buildCodexProvider(personalCodexModels),
        instanceId: "codex_personal" as ProviderInstanceId,
        displayName: "Codex Personal",
        accentColor: "#dc2626",
        continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      },
      {
        ...buildCodexProvider(isolatedCodexModels),
        instanceId: "codex_isolated" as ProviderInstanceId,
        displayName: "Codex Isolated",
        accentColor: "#16a34a",
        continuation: { groupKey: "codex:home:/Users/julius/.codex_isolated" },
      },
      TEST_PROVIDERS[1]!,
    ];
    const mounted = await mountPicker({
      activeInstanceId: "codex" as ProviderInstanceId,
      model: "gpt-work",
      lockedProvider: ProviderDriverKind.make("codex"),
      lockedContinuationGroupKey: "codex:home:/Users/julius/.codex",
      providers,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder()).toEqual(["codex", "codex_personal"]);
        expect(getModelPickerListText()).not.toContain("Codex Isolated");
        expect(
          document.querySelector<HTMLElement>('[data-model-picker-provider="codex_personal"]')
            ?.dataset.providerAccentColor,
        ).toBe("#dc2626");
        // The sidebar names the single selected instance; rows don't repeat it.
        expect(getModelPickerListText()).not.toContain("Codex Work");
        expect(getVisibleModelNames()).toEqual(["GPT Work"]);
      });

      await page.getByRole("button", { name: "Codex Personal" }).click();

      await vi.waitFor(() => {
        expect(getModelPickerListText()).not.toContain("Codex Personal");
        expect(getVisibleModelNames()).toEqual(["GPT Personal"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("falls back to the active provider's first model when props.model belongs to another provider (#1982)", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const onInstanceModelChange = vi.fn();
    const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
      [
        "claudeAgent" as ProviderInstanceId,
        [
          { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
          { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        ],
      ],
      ["codex" as ProviderInstanceId, [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }]],
    ]);
    const instanceEntries = sortProviderInstanceEntries(
      deriveProviderInstanceEntries(TEST_PROVIDERS),
    );
    const screen = await render(
      <ProviderModelPicker
        activeInstanceId={"claudeAgent" as ProviderInstanceId}
        model="gpt-5-codex"
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        onInstanceModelChange={onInstanceModelChange}
      />,
      { container: host },
    );

    try {
      const trigger = document.querySelector<HTMLElement>(
        '[data-chat-provider-model-picker="true"]',
      );
      expect(trigger).not.toBeNull();
      const label = trigger?.textContent ?? "";
      expect(label).not.toContain("gpt-5-codex");
      expect(label).toContain("Claude Opus 4.6");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("uses the trigger label for locked Claude subprovider rows", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildClaudePartnerProvider([
        {
          slug: "acme-models/claude-opus-4.5",
          name: "Claude Opus 4.5",
          subProvider: "Acme Models",
          shortName: "Opus 4.5",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
    ];
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_PARTNER_INSTANCE_ID,
      model: "acme-models/claude-opus-4.5",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
      providers,
    });

    try {
      await vi.waitFor(() => {
        const trigger = document.querySelector<HTMLElement>(
          '[data-chat-provider-model-picker="true"]',
        );
        expect(trigger?.textContent).toContain("Acme Models");
        expect(trigger?.textContent).toContain("Opus 4.5");
      });

      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames()).toEqual(["Acme Models · Opus 4.5"]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches models by name in flat list", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
        expect(text).not.toContain("GPT-5 Codex");
      });

      // Find and type in search box
      const searchInput = page.getByPlaceholder("Search models...");
      await searchInput.fill("claude");

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
        expect(text).not.toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("supports arrow-key navigation in the model picker", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
    });

    try {
      await page.getByRole("button").click();

      const searchInput = page.getByPlaceholder("Search models...");
      await userEvent.click(searchInput);
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const highlightedItem = document.querySelector<HTMLElement>(
          '[data-slot="combobox-item"][data-highlighted]',
        );
        expect(highlightedItem).not.toBeNull();
        expect(highlightedItem?.textContent).toContain("Claude Opus 4.6");
      });
      await userEvent.keyboard("{ArrowDown}");
      await vi.waitFor(() => {
        const highlightedItem = document.querySelector<HTMLElement>(
          '[data-slot="combobox-item"][data-highlighted]',
        );
        expect(highlightedItem).not.toBeNull();
        expect(highlightedItem?.textContent).toContain("Claude Sonnet 4.6");
      });
      await userEvent.keyboard("{Enter}");

      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides the provider sidebar while searching", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder().length).toBeGreaterThan(0);
      });

      await page.getByPlaceholder("Search models...").fill("cla");

      await vi.waitFor(() => {
        expect(getSidebarProviderOrder()).toEqual([]);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("closes the picker when escape is pressed in search", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      const searchInput = page.getByPlaceholder("Search models...");
      await searchInput.click();
      const searchInputElement = document.querySelector<HTMLInputElement>(
        'input[placeholder="Search models..."]',
      );
      expect(searchInputElement).not.toBeNull();
      searchInputElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      await vi.waitFor(() => {
        expect(document.querySelector(".model-picker-list")).toBeNull();
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("searches models by provider name", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
        expect(text).not.toContain("GPT-5 Codex");
      });

      // Search by provider name
      const searchInput = page.getByPlaceholder("Search models...");
      await searchInput.fill("codex");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("GPT-5 Codex");
        expect(listText).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("matches fuzzy multi-token queries across provider and model text", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5-codex",
          name: "GPT-5 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      buildClaudePartnerProvider([
        {
          slug: "acme-models/claude-opus-4.7",
          name: "Claude Opus 4.7",
          subProvider: "Acme Models",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
    ];
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_PARTNER_INSTANCE_ID,
      model: "acme-models/claude-opus-4.7",
      lockedProvider: null,
      providers,
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models...").fill("acm op");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("Claude Opus 4.7");
        expect(listText).not.toContain("GPT-5 Codex");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders each search result with its own provider branding", async () => {
    const providers: ReadonlyArray<ServerProvider> = [
      buildClaudePartnerProvider([
        {
          slug: "acme-models/claude-opus-4.7",
          name: "Claude Opus 4.7",
          subProvider: "Acme Models",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
            ],
          }),
        },
      ]),
      {
        ...TEST_PROVIDERS[1]!,
        models: [
          {
            slug: "claude-opus-4-6",
            name: "Claude Opus 4.6",
            isCustom: false,
            capabilities: createModelCapabilities({
              optionDescriptors: [
                selectDescriptor("effort", "Reasoning", [
                  { id: "low", label: "low" },
                  { id: "medium", label: "medium", isDefault: true },
                  { id: "high", label: "high" },
                  { id: "max", label: "max" },
                ]),
                booleanDescriptor("thinking", "Thinking"),
              ],
            }),
          },
        ],
      },
    ];
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_PARTNER_INSTANCE_ID,
      model: "acme-models/claude-opus-4.7",
      lockedProvider: null,
      providers,
    });

    try {
      await page.getByRole("button").click();
      await page.getByPlaceholder("Search models...").fill("opus");

      await vi.waitFor(() => {
        const listText = getModelPickerListText();
        expect(listText).toContain("Claude Partner · Acme Models");
        expect(listText).toContain("Claude");
        expect(listText).not.toContain("Claude PartnerClaude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("toggles favorite stars when clicked", async () => {
    localStorage.removeItem("cafecode:client-settings:v1");

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
      });

      const getFirstStarButton = () => {
        const starButton = document.querySelector<HTMLButtonElement>(
          'button[aria-label*="favorites"]',
        );
        expect(starButton).not.toBeNull();
        return starButton!;
      };

      const firstStar = getFirstStarButton();
      const initialAriaLabel = firstStar.getAttribute("aria-label");
      expect(
        initialAriaLabel === "Add to favorites" || initialAriaLabel === "Remove from favorites",
      ).toBe(true);

      await page.getByRole("button", { name: initialAriaLabel! }).first().click();

      const expectedAriaLabel =
        initialAriaLabel === "Add to favorites" ? "Remove from favorites" : "Add to favorites";

      await vi.waitFor(() => {
        expect(getFirstStarButton().getAttribute("aria-label")).toBe(expectedAriaLabel);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("cafecode:client-settings:v1");
    }
  });

  it("does not duplicate favorited models across favorites and all models sections", async () => {
    localStorage.removeItem("cafecode:client-settings:v1");

    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Opus 4.6");
      });

      const favoriteButton = page.getByRole("button", {
        name: "Add to favorites",
      });
      await favoriteButton.first().click();

      await vi.waitFor(async () => {
        const favoritedModelRows = Array.from(
          getModelPickerListElement().querySelectorAll<HTMLDivElement>("div.font-medium"),
        ).filter((element) => element.textContent?.trim() === "Claude Opus 4.6");
        expect(favoritedModelRows.length).toBe(1);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("cafecode:client-settings:v1");
    }
  });

  it("shows favorited models first within the selected provider list", async () => {
    localStorage.setItem(
      "cafecode:client-settings:v1",
      JSON.stringify({
        ...DEFAULT_CLIENT_SETTINGS,
        favorites: [{ provider: "codex", model: "gpt-5.3-codex" }],
      }),
    );

    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: null,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("button", { name: "Codex", exact: true }).click();

      await vi.waitFor(() => {
        expect(getVisibleModelNames().slice(0, 2)).toEqual(["GPT-5.3 Codex", "GPT-5 Codex"]);
      });
    } finally {
      await mounted.cleanup();
      localStorage.removeItem("cafecode:client-settings:v1");
    }
  });

  it("dispatches callback with correct provider and model when selected", async () => {
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Claude Sonnet 4.6");
      });

      // Click on a model
      const modelRow = page.getByText("Claude Sonnet 4.6").first();
      await modelRow.click();

      // Verify callback was called with correct values
      expect(mounted.onProviderModelChange).toHaveBeenCalledWith(
        "claudeAgent",
        "claude-sonnet-4-6",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows and selects Claude Fable 5.1 when the server advertises it", async () => {
    const providersWithFable = TEST_PROVIDERS.map((provider) =>
      provider.instanceId === CLAUDE_INSTANCE_ID
        ? {
            ...provider,
            models: [
              ...provider.models,
              {
                slug: "claude-fable-5-1",
                name: "Claude Fable 5.1",
                isCustom: false,
                capabilities: createModelCapabilities({
                  optionDescriptors: [
                    selectDescriptor("effort", "Reasoning", [
                      { id: "low", label: "low" },
                      { id: "medium", label: "medium" },
                      { id: "high", label: "high", isDefault: true },
                      { id: "xhigh", label: "xhigh" },
                      { id: "max", label: "max" },
                    ]),
                    selectDescriptor("contextWindow", "Context window", [
                      { id: "1m", label: "1m", isDefault: true },
                    ]),
                  ],
                }),
              },
            ],
          }
        : provider,
    );
    const mounted = await mountPicker({
      activeInstanceId: CLAUDE_INSTANCE_ID,
      model: "claude-opus-4-6",
      lockedProvider: ProviderDriverKind.make("claudeAgent"),
      providers: providersWithFable,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(getModelPickerListText()).toContain("Claude Fable 5.1");
      });

      await page.getByText("Claude Fable 5.1", { exact: true }).click();

      expect(mounted.onInstanceModelChange).toHaveBeenCalledWith(
        CLAUDE_INSTANCE_ID,
        "claude-fable-5-1",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("only shows codex spark when the server reports it", async () => {
    const providersWithoutSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];
    const providersWithSpark: ReadonlyArray<ServerProvider> = [
      buildCodexProvider([
        {
          slug: "gpt-5.3-codex",
          name: "GPT-5.3 Codex",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
        {
          slug: "gpt-5.3-codex-spark",
          name: "GPT-5.3 Codex Spark",
          isCustom: false,
          capabilities: createModelCapabilities({
            optionDescriptors: [
              selectDescriptor("reasoningEffort", "Reasoning", [
                { id: "low", label: "low" },
                { id: "medium", label: "medium", isDefault: true },
                { id: "high", label: "high" },
              ]),
              booleanDescriptor("fastMode", "Fast Mode"),
            ],
          }),
        },
      ]),
      TEST_PROVIDERS[1]!,
    ];

    const hidden = await mountPicker({
      model: "gpt-5.3-codex",
      lockedProvider: null,
      providers: providersWithoutSpark,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5.3 Codex");
        expect(text).not.toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await hidden.cleanup();
    }

    const visible = await mountPicker({
      model: "gpt-5.3-codex",
      lockedProvider: null,
      providers: providersWithSpark,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("GPT-5.3 Codex Spark");
      });
    } finally {
      await visible.cleanup();
    }
  });

  it("shows disabled providers grayed out in sidebar", async () => {
    const disabledProviders = TEST_PROVIDERS.slice();
    const claudeIndex = disabledProviders.findIndex(
      (provider) => provider.instanceId === ProviderInstanceId.make("claudeAgent"),
    );
    if (claudeIndex >= 0) {
      const claudeProvider = disabledProviders[claudeIndex]!;
      disabledProviders[claudeIndex] = {
        ...claudeProvider,
        enabled: false,
        status: "disabled",
      };
    }

    const mounted = await mountPicker({
      model: "gpt-5-codex",
      lockedProvider: null,
      providers: disabledProviders,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("GPT-5 Codex");
        // Disabled provider should not have its models shown
        expect(text).not.toContain("Claude Opus 4.6");
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
