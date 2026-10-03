import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerProviderAccountRateLimits,
} from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { applyInterfaceScalePercent } from "../../interfaceScale";
import { TooltipProvider } from "../ui/tooltip";
import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";

const api = vi.hoisted(() => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("Layout fixtures must not contact a provider or redeem usage resets");
  }),
}));
vi.mock("../../localApi", () => ({ ensureLocalApi: api.ensureLocalApi }));

const privateEmail = `${"private-account".repeat(10)}@example.invalid`;
const creditBalance = "123456789012345678901234567890.0000001234";
const longName = `Research ${"UnbrokenProviderName".repeat(10)}`;
const checkedAt = "2026-09-29T00:00:00.000Z";
const bucket = {
  limitId: "codex",
  primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
  secondary: { usedPercent: 60, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
};

function accountQuota(multiple: boolean, realistic: boolean): ServerProviderAccountRateLimits {
  return {
    checkedAt,
    rateLimits: bucket,
    ...(multiple
      ? {
          rateLimitsByLimitId: {
            codex: bucket,
            research: {
              ...bucket,
              limitId: "research",
              limitName: "Research quota",
              credits: {
                hasCredits: true,
                unlimited: false,
                balance: realistic ? "120.000" : creditBalance,
              },
              ...(realistic ? { spendControlReached: false } : {}),
            },
            extended: {
              ...bucket,
              limitId: "extended",
              limitName: "Extended quota",
              credits: { hasCredits: true, unlimited: true, balance: null },
            },
          },
        }
      : {}),
    rateLimitResetCredits: { availableCount: 0 },
  };
}

function cardFixture(kind: "minimal" | "multiple" | "login", realistic: boolean) {
  const displayName =
    kind === "multiple"
      ? realistic
        ? "Research Codex"
        : longName
      : kind === "login"
        ? "Login Codex"
        : "Personal Codex";
  const instanceId = ProviderInstanceId.make(
    kind === "multiple" && !realistic
      ? `codex-${"long-instance-id-".repeat(3)}account`
      : `codex-${kind}`,
  );
  const instance: ProviderInstanceConfig = {
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    config: {},
    environment: [],
  };
  const provider: ServerProvider = {
    instanceId,
    driver: instance.driver,
    enabled: true,
    installed: true,
    version: "0.163.0",
    status: "ready",
    auth:
      kind === "login"
        ? { status: "unauthenticated" }
        : {
            status: "authenticated",
            type: "chatgpt",
            label: "ChatGPT Pro (Max) Subscription",
            ...(kind === "multiple"
              ? { email: realistic ? "researcher@example.invalid" : privateEmail }
              : {}),
          },
    ...(kind === "multiple"
      ? {
          message: realistic
            ? "Account ready"
            : `Account detail: ${"unbroken-auth-detail".repeat(12)}`,
        }
      : {}),
    ...(kind === "login"
      ? {}
      : { accountRateLimits: accountQuota(kind === "multiple", realistic) }),
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
  };
  return {
    kind,
    displayName,
    instanceId,
    instance,
    provider,
    onSettingsOpenChange: vi.fn<(open: boolean) => void>(),
    onSetDefaultProvider: vi.fn<(next: boolean) => void>(),
    onUpdate: vi.fn<(next: ProviderInstanceConfig) => void>(),
    onRestartRuntime: vi.fn<() => void>(),
    onLogIn: vi.fn<() => void>(),
    onDelete: vi.fn<() => void>(),
  };
}

function usageResetCardFixture(availableCount: 1 | 0 | null | undefined) {
  const fixture = cardFixture("multiple", true);
  const availabilityId =
    availableCount === undefined ? "omitted" : availableCount === null ? "null" : availableCount;
  const instanceId = ProviderInstanceId.make(`codex-reset-${availabilityId}`);
  const accountRateLimits: ServerProviderAccountRateLimits = {
    checkedAt,
    rateLimits: {
      ...bucket,
      // Only the weekly window is low. A positive account-wide reset count
      // should make the action available without inventing per-window credits
      // or requiring the otherwise healthy primary window to be exhausted.
      secondary: { ...bucket.secondary, usedPercent: 99 },
    },
    ...(availableCount === undefined
      ? {}
      : { rateLimitResetCredits: availableCount === null ? null : { availableCount } }),
  };
  return {
    ...fixture,
    instanceId,
    provider: {
      ...fixture.provider,
      instanceId,
      auth: { ...fixture.provider.auth, email: privateEmail },
      accountRateLimits,
    },
  };
}

let mounted: Awaited<ReturnType<typeof render>> | undefined;
let host: HTMLDivElement | undefined;

afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  host?.remove();
  host = undefined;
  applyInterfaceScalePercent(undefined);
  expect(api.ensureLocalApi).not.toHaveBeenCalled();
  api.ensureLocalApi.mockClear();
});

async function mountCards(
  width: number,
  scale: number,
  realistic = false,
  fixtures = [
    cardFixture("minimal", realistic),
    cardFixture("multiple", realistic),
    cardFixture("login", realistic),
  ],
) {
  // The middle width deliberately lives inside a large desktop viewport.
  // A viewport breakpoint would miss narrow cards in a settings column.
  await page.viewport(width === 520 ? 1200 : width, 1000);
  applyInterfaceScalePercent(scale);
  host = document.createElement("div");
  host.style.width = `${width}px`;
  document.body.append(host);
  mounted = await render(
    <TooltipProvider>
      {fixtures.map((fixture) => (
        <ProviderInstanceCard
          key={fixture.instanceId}
          instanceId={fixture.instanceId}
          instance={fixture.instance}
          driverOption={DRIVER_OPTION_BY_VALUE[fixture.instance.driver]}
          liveProvider={fixture.provider}
          isSettingsOpen={false}
          onSettingsOpenChange={fixture.onSettingsOpenChange}
          isDefaultProvider={fixture.kind !== "minimal"}
          onSetDefaultProvider={fixture.onSetDefaultProvider}
          onUpdate={fixture.onUpdate}
          onRestartRuntime={fixture.kind === "minimal" ? undefined : fixture.onRestartRuntime}
          onLogIn={fixture.kind === "login" ? fixture.onLogIn : undefined}
          onDelete={fixture.kind === "multiple" ? fixture.onDelete : undefined}
          hiddenModels={[]}
          favoriteModels={[]}
          modelOrder={[]}
          onHiddenModelsChange={vi.fn()}
          onFavoriteModelsChange={vi.fn()}
          onModelOrderChange={vi.fn()}
        />
      ))}
    </TooltipProvider>,
    { container: host },
  );
  return { fixtures, host };
}

function expectNoHorizontalOverflow(element: HTMLElement) {
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
}

it("edits a scoped new-chat concurrency default without changing runtime config or restarting", async () => {
  const fixture = cardFixture("minimal", true);
  const instance = { ...fixture.instance, config: { maxConcurrentSubagents: 6 } };
  const card = (current: ProviderInstanceConfig) => (
    <TooltipProvider>
      <ProviderInstanceCard
        instanceId={fixture.instanceId}
        instance={current}
        driverOption={DRIVER_OPTION_BY_VALUE[fixture.instance.driver]}
        liveProvider={fixture.provider}
        isSettingsOpen
        onSettingsOpenChange={fixture.onSettingsOpenChange}
        isDefaultProvider={false}
        onSetDefaultProvider={fixture.onSetDefaultProvider}
        onUpdate={fixture.onUpdate}
        onRestartRuntime={fixture.onRestartRuntime}
        hiddenModels={[]}
        favoriteModels={[]}
        modelOrder={[]}
        onHiddenModelsChange={vi.fn()}
        onFavoriteModelsChange={vi.fn()}
        onModelOrderChange={vi.fn()}
      />
    </TooltipProvider>
  );
  mounted = await render(card(instance));
  const input = page.getByRole("spinbutton", { name: "Default subagent limit", exact: true });
  await input.fill("12");
  await page.getByRole("heading", { name: `${fixture.displayName} settings`, exact: true }).click();
  expect(fixture.onUpdate).toHaveBeenLastCalledWith(
    expect.objectContaining({
      defaultMaxConcurrentSubagents: 12,
      config: { maxConcurrentSubagents: 6 },
    }),
  );
  // Mirror the settings acknowledgement before testing reset: an unchanged
  // blank value is deliberately not an update in the shared blur editor.
  await mounted.rerender(card({ ...instance, defaultMaxConcurrentSubagents: 12 }));
  fixture.onUpdate.mockClear();
  await input.fill("65");
  await page.getByRole("heading", { name: `${fixture.displayName} settings`, exact: true }).click();
  expect(fixture.onUpdate).not.toHaveBeenCalled();
  await input.fill("");
  await page.getByRole("heading", { name: `${fixture.displayName} settings`, exact: true }).click();
  expect(fixture.onUpdate).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ defaultMaxConcurrentSubagents: expect.anything() }),
  );
  expect(fixture.onRestartRuntime).not.toHaveBeenCalled();
});

function unwrappedTextWidth(element: HTMLElement) {
  // Measure the same synthetic text/font without wrapping. Deriving the fit
  // from the rendered row alone would let a stretched half-card column hide
  // the regression: its extra whitespace would falsely look like text width.
  const sample = element.cloneNode(true) as HTMLElement;
  const style = getComputedStyle(element);
  Object.assign(sample.style, {
    position: "fixed",
    visibility: "hidden",
    display: "inline-block",
    width: "max-content",
    maxWidth: "none",
    whiteSpace: "nowrap",
    font: style.font,
    letterSpacing: style.letterSpacing,
  });
  document.body.append(sample);
  try {
    return sample.getBoundingClientRect().width;
  } finally {
    sample.remove();
  }
}

function expectContentSizedQuotaWindow(quotaWindow: HTMLElement) {
  const pair = quotaWindow.firstElementChild as HTMLElement;
  const label = pair.querySelector("span")!;
  const value = Array.from(pair.querySelectorAll("span")).find((span) =>
    /^\d+(?:\.\d+)?% left$/.test(span.textContent ?? ""),
  )!;
  const reset = quotaWindow.querySelector("p")!;
  const bounds = quotaWindow.getBoundingClientRect();
  const pairBounds = pair.getBoundingClientRect();
  const labelBounds = label.getBoundingClientRect();
  const valueBounds = value.getBoundingClientRect();
  const resetBounds = reset.getBoundingClientRect();
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const pairGap = Number.parseFloat(getComputedStyle(pair).columnGap);
  const resetGap = Number.parseFloat(getComputedStyle(quotaWindow).columnGap);
  const naturalPairWidth = unwrappedTextWidth(label) + pairGap + unwrappedTextWidth(value);
  const naturalResetWidth = unwrappedTextWidth(reset);
  expect(pairBounds.width).toBeLessThanOrEqual(naturalPairWidth + 1);
  expect(pairBounds.left).toBeCloseTo(bounds.left, 0);
  if (naturalPairWidth <= bounds.width + 1) {
    expect(valueBounds.top).toBeCloseTo(labelBounds.top, 0);
    expect(valueBounds.left - labelBounds.right).toBeGreaterThanOrEqual(0);
    expect(valueBounds.left - labelBounds.right).toBeLessThanOrEqual(0.75 * rem + 1);
  } else {
    expect(valueBounds.top).toBeGreaterThanOrEqual(labelBounds.bottom - 1);
    expect(valueBounds.left).toBeCloseTo(pairBounds.left, 0);
  }
  const fitsInline =
    Math.min(naturalPairWidth, bounds.width) +
      resetGap +
      Math.min(naturalResetWidth, bounds.width) <=
    bounds.width + 1;
  if (fitsInline) {
    expect(resetBounds.top).toBeCloseTo(pairBounds.top, 0);
    expect(resetBounds.left - pairBounds.right).toBeGreaterThanOrEqual(0);
    expect(resetBounds.left - pairBounds.right).toBeLessThanOrEqual(rem + 1);
  } else {
    expect(resetBounds.top).toBeGreaterThanOrEqual(pairBounds.bottom - 1);
    expect(resetBounds.left).toBeCloseTo(bounds.left, 0);
  }
  expect(resetBounds.width).toBeLessThanOrEqual(naturalResetWidth + 1);
  expectNoHorizontalOverflow(quotaWindow);
  return { label: label.textContent!, valueRight: valueBounds.right, fitsInline };
}

function expectControlsWithinHeader(card: HTMLElement, inline: boolean) {
  const header = card.querySelector<HTMLElement>("[data-provider-card-header]")!;
  const actions = card.querySelector<HTMLElement>("[data-provider-card-actions]")!;
  const details = card.querySelector<HTMLElement>("[data-provider-card-details]")!;
  const identity = header.firstElementChild!;
  const headerBounds = header.getBoundingClientRect();
  const actionsBounds = actions.getBoundingClientRect();
  const detailsBounds = details.getBoundingClientRect();
  const identityBounds = identity.getBoundingClientRect();

  expect(header.contains(actions)).toBe(true);
  expect(header.contains(details)).toBe(false);
  expect(actionsBounds.right).toBeCloseTo(headerBounds.right, 0);
  expect(actionsBounds.bottom).toBeLessThanOrEqual(headerBounds.bottom + 1);
  expect(detailsBounds.top).toBeGreaterThanOrEqual(headerBounds.bottom);
  expect(detailsBounds.left).toBeCloseTo(headerBounds.left, 0);
  expect(detailsBounds.right).toBeCloseTo(headerBounds.right, 0);
  if (inline) {
    expect(actionsBounds.top).toBeCloseTo(headerBounds.top, 0);
    expect(identityBounds.right).toBeLessThanOrEqual(actionsBounds.left + 1);
  } else {
    expect(actionsBounds.top).toBeGreaterThanOrEqual(identityBounds.bottom);
  }

  const controls = Array.from(actions.querySelectorAll<HTMLElement>("button, [role='switch']"));
  expect(controls.length).toBeGreaterThanOrEqual(3);
  for (const [index, control] of controls.entries()) {
    const bounds = control.getBoundingClientRect();
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
    expect(bounds.left).toBeGreaterThanOrEqual(headerBounds.left - 1);
    expect(bounds.right).toBeLessThanOrEqual(headerBounds.right + 1);
    expect(bounds.top).toBeGreaterThanOrEqual(headerBounds.top - 1);
    expect(bounds.bottom).toBeLessThanOrEqual(headerBounds.bottom + 1);
    for (const sibling of controls.slice(index + 1)) {
      const other = sibling.getBoundingClientRect();
      const horizontalIntersection =
        Math.min(bounds.right, other.right) - Math.max(bounds.left, other.left);
      const verticalIntersection =
        Math.min(bounds.bottom, other.bottom) - Math.max(bounds.top, other.top);
      expect(horizontalIntersection <= 1 || verticalIntersection <= 1).toBe(true);
    }
  }
  // A wrapped actions row must also stay right-aligned, not fall back to the
  // old left-aligned mobile layout when optional controls increase its width.
  expect(controls.at(-1)!.getBoundingClientRect().right).toBeCloseTo(headerBounds.right, 0);
  for (const element of [card, header, actions, details]) expectNoHorizontalOverflow(element);
}

describe("Provider instance card layout", () => {
  it.each([320, 520, 1152].flatMap((width) => [80, 100, 130].map((scale) => ({ width, scale }))))(
    "keeps eligible reset actions in the header without a quota spacer at $width px / $scale% scale",
    async ({ width, scale }) => {
      const availabilities = [1, 0, null, undefined] as const;
      const { fixtures, host } = await mountCards(
        width,
        scale,
        true,
        availabilities.map(usageResetCardFixture),
      );
      const cards = Array.from(host.querySelectorAll<HTMLElement>("[data-provider-card]"));
      expect(cards).toHaveLength(availabilities.length);
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const quotaGaps: number[] = [];

      for (const [index, card] of cards.entries()) {
        expectControlsWithinHeader(card, card.clientWidth >= 32 * rem);
        const actions = card.querySelector<HTMLElement>("[data-provider-card-actions]")!;
        const details = card.querySelector<HTMLElement>("[data-provider-card-details]")!;
        const auth = details.firstElementChild!;
        const quota = card.querySelector<HTMLElement>("[data-account-quota]")!;
        const quotaScroll = card.querySelector<HTMLElement>("[data-account-quota-scroll]")!;
        const resetButton = Array.from(card.querySelectorAll("button")).find(
          (button) => button.textContent?.trim() === "Redeem reset",
        );
        if (availabilities[index] === 1) {
          expect(resetButton).toBeDefined();
          expect(actions.contains(resetButton!)).toBe(true);
          expect(quota.contains(resetButton!)).toBe(false);
        } else {
          expect(resetButton).toBeUndefined();
        }

        // Measure the first quota facts, not the outer quota container: an
        // action rendered above those facts can leave an empty full-width row
        // even when the container itself has the correct authentication gap.
        // These cards differ only in reset availability, so that gap must be
        // independent of whether a reset action is visible or unavailable.
        const quotaGap =
          quotaScroll.getBoundingClientRect().top - auth.getBoundingClientRect().bottom;
        quotaGaps.push(quotaGap);
        expect(quotaGap).toBeGreaterThanOrEqual(0);
        expect(quotaGap).toBeLessThanOrEqual(0.5 * rem + 1);
        expect(quota.dataset.accountQuotaLayout).toBe("settings");
        expect(quota.getBoundingClientRect().width).toBeCloseTo(
          details.getBoundingClientRect().width,
          0,
        );

        const windows = Array.from(
          quota.querySelectorAll<HTMLElement>("[data-account-quota-window]"),
        );
        expect(windows).toHaveLength(2);
        for (const quotaWindow of windows) expectContentSizedQuotaWindow(quotaWindow);
        const percentages = Array.from(quota.querySelectorAll("span"))
          .map((span) => span.textContent)
          .filter((text) => /^\d+(?:\.\d+)?% left$/.test(text ?? ""));
        expect(percentages).toEqual(["75% left", "1% left"]);
        const resetCount = Array.from(quota.querySelectorAll("p")).find((element) =>
          element.textContent?.startsWith("Usage limit resets available:"),
        );
        const availableCount = availabilities[index];
        if (typeof availableCount === "number") {
          expect(resetCount?.textContent).toBe(`Usage limit resets available: ${availableCount}`);
          expect(quota.lastElementChild).toBe(resetCount);
          expect(quotaScroll.contains(resetCount!)).toBe(false);
          expect(resetCount!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
            quotaScroll.getBoundingClientRect().bottom - 1,
          );
        } else {
          expect(resetCount).toBeUndefined();
        }
        for (const element of [quota, quotaScroll]) expectNoHorizontalOverflow(element);
        expect(card.textContent).not.toContain(privateEmail);
        expect(card.innerHTML).not.toContain(privateEmail);
        expect(fixtures[index]!.onUpdate).not.toHaveBeenCalled();
      }
      expect(Math.max(...quotaGaps) - Math.min(...quotaGaps)).toBeLessThanOrEqual(1);
      expectNoHorizontalOverflow(host);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
      await expect
        .element(page.getByRole("button", { name: "Redeem reset", exact: true }))
        .toBeVisible();

      // The extra reset control must not cover the usual controls when the
      // action row wraps. Only injected callbacks are invoked here; opening
      // the reset preview would cross the provider-I/O boundary of this suite.
      const eligible = fixtures[0]!;
      await page
        .getByRole("button", { name: `Open ${eligible.displayName} settings`, exact: true })
        .first()
        .click();
      expect(eligible.onSettingsOpenChange).toHaveBeenCalledExactlyOnceWith(true);
      await page
        .getByRole("button", {
          name: `Clear ${eligible.displayName} as default provider`,
          exact: true,
        })
        .first()
        .click();
      expect(eligible.onSetDefaultProvider).toHaveBeenCalledExactlyOnceWith(false);
      await page
        .getByRole("button", { name: `Restart ${eligible.displayName} runtime`, exact: true })
        .first()
        .click();
      expect(eligible.onRestartRuntime).toHaveBeenCalledOnce();
      await page
        .getByRole("switch", { name: `Enable ${eligible.displayName}`, exact: true })
        .first()
        .click();
      expect(eligible.onUpdate).toHaveBeenCalledExactlyOnceWith({
        ...eligible.instance,
        enabled: false,
      });
      expect(api.ensureLocalApi).not.toHaveBeenCalled();
    },
  );

  it.each([320, 520, 760].flatMap((width) => [80, 100, 130].map((scale) => ({ width, scale }))))(
    "keeps header actions aligned and quota facts naturally spaced at $width px / $scale% scale",
    async ({ width, scale }) => {
      const { fixtures, host } = await mountCards(width, scale);
      const cards = Array.from(host.querySelectorAll<HTMLElement>("[data-provider-card]"));
      expect(cards).toHaveLength(3);
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      const percentRights = new Map<string, number[]>();

      for (const [index, card] of cards.entries()) {
        expectControlsWithinHeader(card, card.clientWidth >= 32 * rem);
        const details = card.querySelector<HTMLElement>("[data-provider-card-details]")!;
        const detailsBounds = details.getBoundingClientRect();
        const quota = card.querySelector<HTMLElement>("[data-account-quota]");
        const quotaScroll = card.querySelector<HTMLElement>("[data-account-quota-scroll]");
        if (quota) {
          const bounds = quota.getBoundingClientRect();
          expect(quota.dataset.accountQuotaLayout).toBe("settings");
          expect(bounds.left).toBeCloseTo(detailsBounds.left, 0);
          expect(bounds.width).toBeCloseTo(detailsBounds.width, 0);
        }
        const percentages = Array.from(
          card.querySelectorAll<HTMLElement>("[data-account-quota-bucket] span"),
        ).filter((span) => /^\d+(?:\.\d+)?% left$/.test(span.textContent ?? ""));
        expect(percentages).toHaveLength(index === 0 ? 2 : index === 1 ? 6 : 0);
        for (const value of percentages) {
          const quotaWindow = value.closest<HTMLElement>("[data-account-quota-window]")!;
          const row = expectContentSizedQuotaWindow(quotaWindow);
          // Equal labels stay aligned between accounts with different header
          // actions. Different label lengths deliberately do not create a
          // shared percentage column halfway across the settings card.
          percentRights.set(row.label, [...(percentRights.get(row.label) ?? []), row.valueRight]);
        }
        for (const quota of card.querySelectorAll<HTMLElement>(
          "[data-account-quota], [data-account-quota-scroll]",
        ))
          expectNoHorizontalOverflow(quota);
        if (quotaScroll) {
          expect(getComputedStyle(quotaScroll).scrollbarGutter).toBe("stable");
          const resetCount = Array.from(details.querySelectorAll("p")).find(
            (element) => element.textContent === "Usage limit resets available: 0",
          )!;
          expect(resetCount).toBeDefined();
          expect(quotaScroll.contains(resetCount)).toBe(false);
          expect(resetCount.getBoundingClientRect().top).toBeGreaterThanOrEqual(
            quotaScroll.getBoundingClientRect().bottom - 1,
          );
        }
        expect(card.textContent).not.toContain(privateEmail);
        expect(card.innerHTML).not.toContain(privateEmail);
        expect(fixtures[index]!.onUpdate).not.toHaveBeenCalled();
      }

      for (const rights of percentRights.values())
        expect(Math.max(...rights) - Math.min(...rights)).toBeLessThanOrEqual(1);
      expectNoHorizontalOverflow(host);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
      await expect
        .element(page.getByRole("button", { name: "Toggle account email visibility" }))
        .toBeVisible();
      await expect.element(page.getByText(privateEmail, { exact: true })).not.toBeInTheDocument();
      await expect
        .element(
          page.getByText("Credits: 123,456,789,012,345,678,901,234,567,890 available", {
            exact: true,
          }),
        )
        .toBeVisible();
      expect(host.textContent).not.toContain("Credit balance:");
    },
  );

  it("uses the available desktop width for single-line identity, authentication and quota rows", async () => {
    const { fixtures, host } = await mountCards(1152, 100, true);
    const cards = Array.from(host.querySelectorAll<HTMLElement>("[data-provider-card]"));
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const percentageRights = new Map<string, number[]>();
    for (const [index, card] of cards.entries()) {
      expectControlsWithinHeader(card, true);
      const header = card.querySelector<HTMLElement>("[data-provider-card-header]")!;
      const actions = card.querySelector<HTMLElement>("[data-provider-card-actions]")!;
      const title = header.querySelector("h3")!;
      const headerBounds = header.getBoundingClientRect();
      const actionsBounds = actions.getBoundingClientRect();
      const titleBounds = title.getBoundingClientRect();
      expect(titleBounds.top).toBeGreaterThanOrEqual(actionsBounds.top - 1);
      expect(titleBounds.bottom).toBeLessThanOrEqual(actionsBounds.bottom + 1);
      expect(headerBounds.height).toBeLessThanOrEqual(1.75 * rem + 1);
      const details = card.querySelector<HTMLElement>("[data-provider-card-details]")!;
      const auth = details.firstElementChild!;
      expect(auth.getBoundingClientRect().height).toBeLessThanOrEqual(
        Number.parseFloat(getComputedStyle(auth).lineHeight) + 1,
      );
      const quota = card.querySelector<HTMLElement>("[data-account-quota]");
      if (!quota) continue;
      expect(quota.dataset.accountQuotaLayout).toBe("settings");
      expect(quota.getBoundingClientRect().width).toBeCloseTo(
        details.getBoundingClientRect().width,
        0,
      );
      const windows = quota.querySelectorAll<HTMLElement>("[data-account-quota-window]");
      expect(windows).toHaveLength(index === 0 ? 2 : 6);
      for (const quotaWindow of windows) {
        const row = expectContentSizedQuotaWindow(quotaWindow);
        expect(row.fitsInline).toBe(true);
        const label = quotaWindow.querySelector("span")!;
        const value = Array.from(quotaWindow.querySelectorAll("span")).find((span) =>
          /^\d+(?:\.\d+)?% left$/.test(span.textContent ?? ""),
        )!;
        const reset = quotaWindow.querySelector("p")!;
        const labelBounds = label.getBoundingClientRect();
        const valueBounds = value.getBoundingClientRect();
        const resetBounds = reset.getBoundingClientRect();
        expect(labelBounds.top).toBeCloseTo(valueBounds.top, 0);
        expect(labelBounds.top).toBeCloseTo(resetBounds.top, 0);
        expect(resetBounds.left).toBeGreaterThan(valueBounds.right);
        for (const text of [label, value, reset]) {
          expect(text.getBoundingClientRect().height).toBeLessThanOrEqual(
            Number.parseFloat(getComputedStyle(text).lineHeight) + 1,
          );
        }
        percentageRights.set(row.label, [
          ...(percentageRights.get(row.label) ?? []),
          row.valueRight,
        ]);
      }
      expectNoHorizontalOverflow(quota);
      expect(fixtures[index]!.onUpdate).not.toHaveBeenCalled();
    }
    for (const rights of percentageRights.values())
      expect(Math.max(...rights) - Math.min(...rights)).toBeLessThanOrEqual(1);
    const credits = page.getByText("Credits: 120 available", { exact: true }).element();
    const spendControl = page.getByText("Spend control: Not reached", { exact: true }).element();
    expect(credits.getBoundingClientRect().top).toBeCloseTo(
      spendControl.getBoundingClientRect().top,
      0,
    );
    expect(spendControl.getBoundingClientRect().left).toBeGreaterThan(
      credits.getBoundingClientRect().right,
    );
    await expect
      .element(page.getByText("researcher@example.invalid", { exact: true }))
      .not.toBeInTheDocument();
    expectNoHorizontalOverflow(host);
  });

  it.each([320, 1152])(
    "keeps reset-only windows full-width without inventing utilization at %s px",
    async (width) => {
      const fixture = cardFixture("minimal", true);
      const resetOnlyFixture = {
        ...fixture,
        provider: {
          ...fixture.provider,
          accountRateLimits: {
            checkedAt,
            rateLimits: {
              primary: { windowDurationMins: 300, resetsAt: 1_800_000_000 },
              secondary: { usedPercent: null, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
            },
            rateLimitResetCredits: { availableCount: 0 },
          },
        },
      };
      const { host } = await mountCards(width, 100, true, [resetOnlyFixture]);
      const quota = host.querySelector<HTMLElement>("[data-account-quota]")!;
      expect(quota.dataset.accountQuotaLayout).toBe("settings");
      const windows = quota.querySelectorAll<HTMLElement>("[data-account-quota-window]");
      expect(windows).toHaveLength(2);
      for (const [index, quotaWindow] of Array.from(windows).entries()) {
        const reset = quotaWindow.querySelector("p")!;
        expect(reset.textContent).toMatch(index === 0 ? /^5h reset:/ : /^7d reset:/);
        expect(quotaWindow.querySelector("span")).toBeNull();
        expect(quotaWindow.textContent).not.toMatch(/% left/);
        expect(reset.getBoundingClientRect().left).toBeCloseTo(
          quotaWindow.getBoundingClientRect().left,
          0,
        );
        expect(reset.getBoundingClientRect().right).toBeCloseTo(
          quotaWindow.getBoundingClientRect().right,
          0,
        );
        expectNoHorizontalOverflow(quotaWindow);
      }
      const resetCount = page
        .getByText("Usage limit resets available: 0", { exact: true })
        .element();
      expect(quota.querySelector("[data-account-quota-scroll]")!.contains(resetCount)).toBe(false);
      expect(fixture.onUpdate).not.toHaveBeenCalled();
      expectNoHorizontalOverflow(host);
    },
  );

  it("keeps wrapped controls interactive without provider I/O or exposing email by default", async () => {
    const { fixtures, host } = await mountCards(320, 130);
    const [minimal, multiple, login] = fixtures;
    const emailToggle = page.getByRole("button", { name: "Toggle account email visibility" });
    await expect.element(page.getByText(privateEmail, { exact: true })).not.toBeInTheDocument();
    await emailToggle.click();
    await expect.element(page.getByText(privateEmail, { exact: true })).toBeVisible();
    for (const card of host.querySelectorAll<HTMLElement>("[data-provider-card]"))
      expectControlsWithinHeader(card, false);
    await emailToggle.click();
    await expect.element(page.getByText(privateEmail, { exact: true })).not.toBeInTheDocument();

    await page
      .getByRole("button", { name: `Open ${minimal!.displayName} settings`, exact: true })
      .click();
    expect(minimal!.onSettingsOpenChange).toHaveBeenCalledExactlyOnceWith(true);
    await page
      .getByRole("button", { name: `Set ${minimal!.displayName} as default provider`, exact: true })
      .click();
    expect(minimal!.onSetDefaultProvider).toHaveBeenCalledExactlyOnceWith(true);
    await page
      .getByRole("button", {
        name: `Clear ${multiple!.displayName} as default provider`,
        exact: true,
      })
      .click();
    expect(multiple!.onSetDefaultProvider).toHaveBeenCalledExactlyOnceWith(false);
    await page
      .getByRole("button", { name: `Restart ${multiple!.displayName} runtime`, exact: true })
      .click();
    expect(multiple!.onRestartRuntime).toHaveBeenCalledOnce();
    await page.getByRole("button", { name: "Log In", exact: true }).click();
    expect(login!.onLogIn).toHaveBeenCalledOnce();
    await page
      .getByRole("button", {
        name: `Delete provider instance ${multiple!.instanceId}`,
        exact: true,
      })
      .click();
    expect(multiple!.onDelete).toHaveBeenCalledOnce();
    await page.getByRole("switch", { name: `Enable ${login!.displayName}`, exact: true }).click();
    expect(login!.onUpdate).toHaveBeenCalledExactlyOnceWith({ ...login!.instance, enabled: false });
    expect(minimal!.onUpdate).not.toHaveBeenCalled();
    expect(multiple!.onUpdate).not.toHaveBeenCalled();
    expect(api.ensureLocalApi).not.toHaveBeenCalled();
  });
});
