import "../../index.css";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSessionQuotaInput,
  type ProviderSessionQuotaResult,
  type ServerProvider,
} from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { applyInterfaceScalePercent } from "../../interfaceScale";
import { ProviderInstanceCard } from "../settings/ProviderInstanceCard";
import { DRIVER_OPTION_BY_VALUE } from "../settings/providerDriverMeta";
import { TooltipProvider } from "../ui/tooltip";
import { SessionRail } from "./SessionRail";
import { ContextWindowMeter } from "./ContextWindowMeter";
import type { ProviderQuotaContext } from "./useProviderQuota";

const { subscribe, unexpected } = vi.hoisted(() => ({
  subscribe:
    vi.fn<
      (
        input: ProviderSessionQuotaInput,
        listener: (result: ProviderSessionQuotaResult) => void,
      ) => () => void
    >(),
  unexpected: vi.fn(() => {
    throw new Error("Quota presentation must not invoke provider probes or native actions");
  }),
}));
vi.mock("../../environments/runtime", () => ({
  resolveEnvironmentHttpUrl: unexpected,
  getEnvironmentHttpBaseUrl: unexpected,
  getSavedEnvironmentRecord: () => null,
  getSavedEnvironmentRuntimeState: () => null,
  hasSavedEnvironmentRegistryHydrated: () => true,
  listSavedEnvironmentRecords: () => [],
  resetSavedEnvironmentRegistryStoreForTests: unexpected,
  resetSavedEnvironmentRuntimeStoreForTests: unexpected,
  useSavedEnvironmentRegistryStore: unexpected,
  useSavedEnvironmentRuntimeStore: unexpected,
  waitForSavedEnvironmentRegistryHydration: unexpected,
  subscribeEnvironmentConnections: () => () => {},
  readEnvironmentConnection: () => null,
  getPrimaryEnvironmentConnection: () => null,
  addSavedEnvironment: unexpected,
  disconnectSavedEnvironment: unexpected,
  ensureEnvironmentConnectionBootstrapped: unexpected,
  reconnectSavedEnvironment: unexpected,
  removeSavedEnvironment: unexpected,
  resetEnvironmentServiceForTests: unexpected,
  startEnvironmentConnectionService: unexpected,
  requireEnvironmentConnection: () => ({
    client: { server: { subscribeProviderQuota: subscribe } },
  }),
}));
vi.mock("../../environments/workspaceApi", () => ({
  ensureWorkspaceApi: unexpected,
  getWorkspaceServerConfig: () => null,
  patchWorkspaceServerConfig: unexpected,
}));
const instanceId = ProviderInstanceId.make("claude-personal");
const context: ProviderQuotaContext = {
  environmentId: EnvironmentId.make("local"),
  input: {
    instanceId,
    session: {
      threadId: ThreadId.make("exact-chat"),
      runtimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  },
  scopeRevision: "config-1",
  connected: true,
};
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  version: "2.1.288",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-09T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const usage = {
  usedTokens: 200,
  maxTokens: 1_000,
  usedPercentage: 20,
  remainingTokens: 800,
  remainingPercentage: 80,
  updatedAt: "2026-10-09T00:00:00.000Z",
  compactsAutomatically: true,
  totalProcessedTokens: null,
  autoCompactTokenLimit: null,
};
const result = (): ProviderSessionQuotaResult => ({
  report: {
    source: "claude-session",
    observedAt: new Date().toISOString(),
    meters: [
      {
        kind: "session",
        group: "session",
        usedPercent: 25,
        resetsAt: null,
        severity: "normal",
        isActive: true,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        usedPercent: 40,
        resetsAt: null,
        severity: "normal",
        isActive: false,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        usedPercent: 99,
        modelLabel: "Native model",
        resetsAt: null,
        severity: "warning",
        isActive: false,
      },
    ],
  },
});
let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  applyInterfaceScalePercent(undefined);
  document.documentElement.classList.remove("dark");
  expect(unexpected).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

function Card() {
  return (
    <ProviderInstanceCard
      instanceId={instanceId}
      instance={{
        driver: provider.driver,
        displayName: "Personal Claude",
        config: {},
        environment: [],
      }}
      driverOption={DRIVER_OPTION_BY_VALUE[provider.driver]}
      liveProvider={provider}
      quotaContext={{ ...context, input: { instanceId } }}
      isSettingsOpen={false}
      onSettingsOpenChange={() => {}}
      isDefaultProvider={false}
      onSetDefaultProvider={() => {}}
      onUpdate={unexpected}
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onModelOrderChange={() => {}}
    />
  );
}
describe("shared passive quota surfaces", () => {
  it("uses instance-only Settings and exact chat/runtime rail input, with the same common report presentation", async () => {
    subscribe.mockReturnValue(vi.fn());
    mounted = await render(
      <TooltipProvider>
        <div data-testid="settings">
          <Card />
        </div>
        <div data-testid="rail" style={{ height: 600 }}>
          <SessionRail
            plan={null}
            usage={usage}
            quotaContext={context}
            onShowInComposer={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    await expect.poll(() => subscribe.mock.calls.length).toBe(2);
    expect(subscribe.mock.calls.map((call) => call[0])).toEqual([{ instanceId }, context.input]);
    const report = result();
    for (const call of subscribe.mock.calls) call[1](report);
    await expect.element(page.getByTestId("settings")).toMatchTextContent(/75% left/u);
    await expect.element(page.getByTestId("rail")).toMatchTextContent(/75% left/u);
    for (const surface of ["settings", "rail"]) {
      const element = page.getByTestId(surface).element();
      expect(element.querySelectorAll("[data-claude-quota-meter]")).toHaveLength(3);
      expect(element.textContent).toContain("60% left");
      expect(element.textContent).toContain("1% left");
      expect(element.textContent).toContain("Session-reported · not account-verified");
    }
    expect(page.getByTestId("rail").element().textContent).toContain("20%⋅200/1k context used");
  });

  it("requests only metadata while the context popover is actually open and clears on closing", async () => {
    const close = vi.fn();
    subscribe.mockReturnValue(close);
    mounted = await render(<ContextWindowMeter usage={usage} quotaContext={context} />);
    expect(subscribe).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Context window 20% used", exact: true }).click();
    await expect.poll(() => subscribe.mock.calls.length).toBe(1);
    expect(subscribe).toHaveBeenCalledWith(context.input, expect.any(Function), expect.any(Object));
    subscribe.mock.calls[0]![1](result());
    await expect.element(page.getByText("75% left", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Context window 20% used", exact: true }).click();
    expect(close).toHaveBeenCalledOnce();
    await expect.element(page.getByText("75% left", { exact: true })).not.toBeInTheDocument();
  });

  it("keeps a missing or mismatched Claude runtime unavailable without borrowing legacy account numbers", async () => {
    const close = vi.fn();
    subscribe.mockReturnValue(close);
    const rateLimits = {
      checkedAt: new Date().toISOString(),
      rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } },
    };
    mounted = await render(
      <SessionRail
        plan={null}
        usage={usage}
        rateLimits={rateLimits}
        quotaContext={context}
        onShowInComposer={() => {}}
      />,
    );
    await expect.poll(() => subscribe.mock.calls.length).toBe(1);
    const old = subscribe.mock.calls[0]![1];
    old(result());
    await expect.element(page.getByText("75% left", { exact: true })).toBeVisible();
    await mounted.rerender(
      <SessionRail
        plan={null}
        usage={usage}
        rateLimits={rateLimits}
        quotaContext={{ ...context, input: null }}
        onShowInComposer={() => {}}
      />,
    );
    old(result());
    await expect
      .element(page.getByText("No session quota report available.", { exact: true }))
      .toBeVisible();
    expect(document.body.textContent).not.toContain("75% left");
    expect(document.body.textContent).not.toContain("90% left");
    expect(subscribe).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    [false, 80],
    [false, 130],
    [true, 80],
    [true, 130],
  ] as const)(
    "keeps narrow shared Settings/rail rows usable (dark=%s, scale=%s)",
    async (dark, scale) => {
      await page.viewport(750, 800);
      applyInterfaceScalePercent(scale);
      document.documentElement.classList.toggle("dark", dark);
      subscribe.mockReturnValue(vi.fn());
      mounted = await render(
        <TooltipProvider>
          <div style={{ width: 270 }}>
            <Card />
            <div style={{ height: 380 }}>
              <SessionRail
                plan={null}
                usage={usage}
                quotaContext={context}
                onShowInComposer={() => {}}
              />
            </div>
          </div>
        </TooltipProvider>,
      );
      await expect.poll(() => subscribe.mock.calls.length).toBe(2);
      const report = result();
      for (const call of subscribe.mock.calls) call[1](report);
      await expect
        .poll(() => document.querySelectorAll("[data-claude-quota-meter]").length)
        .toBe(6);
      for (const element of document.querySelectorAll<HTMLElement>("[data-claude-session-quota]")) {
        expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
        expect(element.querySelectorAll("[data-account-quota-scroll]")).toHaveLength(1);
      }
      const bar = document.querySelector<HTMLElement>(
        '[data-session-rail-usage-bar="claude-meter-0"] > div',
      )!;
      expect(bar.style.width).toBe("75%");
      expect(bar.classList.contains("motion-reduce:transition-none")).toBe(true);
      // The opt-in reduced-motion run also qualifies the generated CSS rather
      // than merely checking that the accessibility utility is present.
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        // transition-none disables every animated property; a retained duration
        // value is inert and need not be rewritten to zero by the utility.
        expect(getComputedStyle(bar).transitionProperty).toBe("none");
      }
      if (import.meta.env.VITE_CAPTURE_CLAUDE_QUOTA === "1")
        await page.screenshot({
          path: `../../../../../.explorations/130-claude-quota/${dark ? "dark" : "light"}-${scale}.png`,
        });
    },
  );
});
