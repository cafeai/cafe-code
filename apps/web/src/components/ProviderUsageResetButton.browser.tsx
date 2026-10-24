import "../index.css";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderUsageResetResult,
  type ServerProvider,
} from "@cafecode/contracts";
import {
  ProviderUsageResetButton,
  type RequestProviderUsageReset,
} from "./ProviderUsageResetButton";

const confirmationId = "00000000-0000-4000-8000-000000000001";
function provider(usedPercent = 96, secondaryUsedPercent = 50): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex-personal"),
    driver: ProviderDriverKind.make("codex"),
    displayName: "Personal Codex",
    enabled: true,
    installed: true,
    version: "0.153.4",
    status: "ready",
    checkedAt: "2026-09-09T00:00:00.000Z",
    auth: { status: "authenticated", type: "chatgpt", email: "user@example.test" },
    models: [],
    skills: [],
    slashCommands: [],
    accountRateLimits: {
      checkedAt: "2026-09-09T00:00:00.000Z",
      rateLimits: {
        primary: { usedPercent, windowDurationMins: 300 },
        secondary: { usedPercent: secondaryUsedPercent, windowDurationMins: 10_080 },
      },
      rateLimitResetCredits: { availableCount: 2, credits: null },
    },
  };
}
function preview(): ProviderUsageResetResult {
  return {
    rateLimits: provider().accountRateLimits!,
    confirmationId,
    outcome: null,
    retrying: false,
  };
}

describe("ProviderUsageResetButton (mocked account only)", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  let retirePreviewCancellationCase: (() => Promise<void>) | undefined;
  beforeEach(() => {
    // A timed-out hook cannot grant another case the held render/native owner.
    if (retirePreviewCancellationCase) throw new Error("Usage reset fixture is still retiring");
  });
  afterEach(async () => {
    // Vitest runs shared afterEach before onTestFinished. Join the same exact
    // owner here; never discard its lease just because a hook stopped waiting.
    if (retirePreviewCancellationCase) {
      await retirePreviewCancellationCase();
      return;
    }
    await mounted?.unmount();
    mounted = undefined;
  });

  it.each([94, 95])(
    "does not appear at %s percent used and never probes on render",
    async (used) => {
      const request = vi.fn<RequestProviderUsageReset>();
      mounted = await render(
        <ProviderUsageResetButton provider={provider(used)} request={request} />,
      );
      await expect
        .element(page.getByRole("button", { name: "Redeem reset", exact: true }))
        .not.toBeInTheDocument();
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each([
    [95.01, 50],
    [10, 96],
    [100, 100],
  ])("shows below 5%% in either window (%s, %s)", async (primary, secondary) => {
    const request = vi.fn<RequestProviderUsageReset>();
    mounted = await render(
      <ProviderUsageResetButton provider={provider(primary, secondary)} request={request} />,
    );
    await expect
      .element(page.getByRole("button", { name: "Redeem reset", exact: true }))
      .toBeVisible();
    expect(request).not.toHaveBeenCalled();
  });

  it("never offers another provider's or unauthenticated account's reset", async () => {
    const request = vi.fn<RequestProviderUsageReset>();
    mounted = await render(
      <ProviderUsageResetButton
        provider={{ ...provider(), driver: ProviderDriverKind.make("claudeAgent") }}
        request={request}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Redeem reset", exact: true }))
      .not.toBeInTheDocument();
    await mounted.rerender(
      <ProviderUsageResetButton
        provider={{ ...provider(), auth: { status: "unauthenticated" } }}
        request={request}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Redeem reset", exact: true }))
      .not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it("hides when reset availability is zero or unknown without probing", async () => {
    const request = vi.fn<RequestProviderUsageReset>();
    const cached = provider();
    mounted = await render(
      <ProviderUsageResetButton
        provider={{
          ...cached,
          accountRateLimits: {
            ...cached.accountRateLimits!,
            rateLimitResetCredits: { availableCount: 0 },
          },
        }}
        request={request}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Redeem reset", exact: true }))
      .not.toBeInTheDocument();
    await mounted.rerender(
      <ProviderUsageResetButton
        provider={{
          ...cached,
          accountRateLimits: { ...cached.accountRateLimits!, rateLimitResetCredits: null },
        }}
        request={request}
      />,
    );
    await expect
      .element(page.getByRole("button", { name: "Redeem reset", exact: true }))
      .not.toBeInTheDocument();
    const withoutRateLimits = { ...cached };
    delete withoutRateLimits.accountRateLimits;
    await mounted.rerender(
      <ProviderUsageResetButton provider={withoutRateLimits} request={request} />,
    );
    await expect
      .element(page.getByRole("button", { name: "Redeem reset", exact: true }))
      .not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });

  it("only reads on opening and cancellation when availability is positive", async (context) => {
    const request = vi.fn<RequestProviderUsageReset>().mockResolvedValue(preview());
    type Phase =
      | "render"
      | "open"
      | "reset-count"
      | "spend-description"
      | "cancel"
      | "retirement"
      | "unmount";
    const started = performance.now();
    const phases: {
      phase: Phase;
      state: "entered" | "settled";
      count: number;
      elapsedMs: number;
    }[] = [];
    let observationsRetired = false;
    let retired = false;
    let nativeStarts = 0;
    let ownedScreen: Awaited<ReturnType<typeof render>> | undefined;
    let pendingRender: ReturnType<typeof render> | undefined;
    let cleanupPromise: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    const mark = (phase: Phase, state: "entered" | "settled") => {
      try {
        if (observationsRetired) return;
        if (phases.length === 16) phases.shift();
        const elapsed = performance.now() - started;
        phases.push({
          phase,
          state,
          count: Math.min(2, nativeStarts),
          elapsedMs: Number.isFinite(elapsed)
            ? Math.max(0, Math.min(60_000, Math.floor(elapsed)))
            : 0,
        });
      } catch {
        /* Passive fixed diagnostics never replace the original failure. */
      }
    };
    const assertActive = () => {
      if (retired || context.signal.aborted) throw new Error("Usage reset fixture retired");
    };
    const own = <T,>(phase: Phase, start: () => Promise<T>, native = false): Promise<T> => {
      assertActive();
      if (native) nativeStarts += 1;
      mark(phase, "entered");
      const result = start();
      pending.add(result);
      // Accounting observes the original promise without translating its error
      // or giving a retired continuation permission for another native action.
      void result.then(
        () => {
          pending.delete(result);
          if (!retired && !context.signal.aborted) mark(phase, "settled");
        },
        () => {
          pending.delete(result);
        },
      );
      return result;
    };
    const retire = () => {
      if (retired) return;
      retired = true;
      mark("retirement", "entered");
    };
    const cleanup = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      retire();
      cleanupPromise = (async () => {
        try {
          // Retire admission first, then join exact original operations before
          // unmount. The body/finalizer is deliberately not a pending operation.
          await Promise.allSettled([...pending]);
          const acquired = pendingRender
            ? (await Promise.allSettled([pendingRender]))[0]
            : undefined;
          const screen =
            ownedScreen ?? (acquired?.status === "fulfilled" ? acquired.value : undefined);
          mark("unmount", "entered");
          await screen?.unmount();
          mark("unmount", "settled");
          if (mounted === screen) mounted = undefined;
          mark("retirement", "settled");
          // Retain a rejected lease: failure is not evidence that native close
          // settled. A successor must not replace this owner's shared handle.
          if (retirePreviewCancellationCase === cleanup) retirePreviewCancellationCase = undefined;
        } finally {
          observationsRetired = true;
          context.signal.removeEventListener("abort", retire);
        }
      })();
      return cleanupPromise;
    };
    // Register timeout/completion ownership before the first render acquisition.
    // A late render is retained by pendingRender and never assigned after retire.
    retirePreviewCancellationCase = cleanup;
    context.signal.addEventListener("abort", retire, { once: true });
    context.onTestFinished(cleanup);
    context.onTestFailed(() => {
      try {
        console.error(
          `Synthetic usage reset phases (phase:state:count:ms): ${phases.map(({ phase, state, count, elapsedMs }) => `${phase}:${state}:${count}:${elapsedMs}`).join(",")}`,
        );
      } catch {
        /* No provider payload, DOM, path, account or raw error is projected. */
      }
    });
    if (context.signal.aborted) retire();
    let bodyFailed = false;
    try {
      assertActive();
      pendingRender = own("render", () =>
        render(<ProviderUsageResetButton provider={provider()} request={request} />),
      );
      const screen = await pendingRender;
      assertActive();
      ownedScreen = screen;
      mounted = screen;
      await own(
        "open",
        () => page.getByRole("button", { name: "Redeem reset", exact: true }).click(),
        true,
      );
      assertActive();
      await own("reset-count", () =>
        expect.element(page.getByText("2 usage limit resets available")).toBeVisible(),
      );
      assertActive();
      await own("spend-description", () =>
        expect
          .element(page.getByText("This spends one of your earned resets", { exact: false }))
          .toBeVisible(),
      );
      assertActive();
      await own(
        "cancel",
        () => page.getByRole("button", { name: "Cancel", exact: true }).click(),
        true,
      );
      assertActive();
      expect(request.mock.calls).toEqual([[{ action: "preview", instanceId: "codex-personal" }]]);
    } catch (error) {
      bodyFailed = true;
      throw error;
    } finally {
      try {
        await cleanup();
      } catch (error) {
        if (!bodyFailed) throw error;
      }
    }
  });

  it("requires confirmation, prevents repeated clicks, and renders authoritative usage", async () => {
    let resolve!: (value: ProviderUsageResetResult) => void;
    const request = vi
      .fn<RequestProviderUsageReset>()
      .mockResolvedValueOnce(preview())
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    mounted = await render(<ProviderUsageResetButton provider={provider()} request={request} />);
    await page.getByRole("button", { name: "Redeem reset", exact: true }).click();
    await page.getByRole("button", { name: "Redeem 1 reset", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Redeem 1 reset", exact: true }))
      .toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    resolve({
      ...preview(),
      outcome: "reset",
      rateLimits: {
        ...provider(0, 0).accountRateLimits!,
        rateLimitResetCredits: { availableCount: 1 },
      },
    });
    await expect.element(page.getByText("Your usage limit reset was redeemed.")).toBeVisible();
    await expect.element(page.getByText("1 usage limit reset available")).toBeVisible();
    expect(request.mock.calls[1]).toEqual([
      { action: "redeem", instanceId: "codex-personal", confirmationId },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("reuses the confirmation after a lost response and keeps the original account/transport", async () => {
    const request = vi
      .fn<RequestProviderUsageReset>()
      .mockResolvedValueOnce(preview())
      .mockRejectedValueOnce(new Error("lost ACK"))
      .mockResolvedValueOnce({ ...preview(), outcome: "alreadyRedeemed" });
    const otherRequest = vi.fn<RequestProviderUsageReset>();
    mounted = await render(<ProviderUsageResetButton provider={provider()} request={request} />);
    await page.getByRole("button", { name: "Redeem reset", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Redeem 1 reset", exact: true }))
      .toBeEnabled();
    await mounted.rerender(
      <ProviderUsageResetButton
        provider={{ ...provider(), instanceId: ProviderInstanceId.make("codex-work") }}
        request={otherRequest}
      />,
    );
    await page.getByRole("button", { name: "Redeem 1 reset", exact: true }).click();
    await page.getByRole("button", { name: "Retry same reset", exact: true }).click();
    await expect
      .element(page.getByText("This reset was already redeemed.", { exact: false }))
      .toBeVisible();
    expect(request.mock.calls[1]).toEqual(request.mock.calls[2]);
    expect(otherRequest).not.toHaveBeenCalled();
  });

  it.each(["noCredit", "nothingToReset"] as const)(
    "shows %s without offering a second spend",
    async (outcome) => {
      const request = vi
        .fn<RequestProviderUsageReset>()
        .mockResolvedValueOnce(preview())
        .mockResolvedValueOnce({ ...preview(), outcome });
      mounted = await render(<ProviderUsageResetButton provider={provider()} request={request} />);
      await page.getByRole("button", { name: "Redeem reset", exact: true }).click();
      await page.getByRole("button", { name: "Redeem 1 reset", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "Usage reset result" })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Redeem 1 reset", exact: true }))
        .not.toBeInTheDocument();
    },
  );

  it("disables redemption when a fresh read has zero or unknown credits", async () => {
    const request = vi.fn<RequestProviderUsageReset>().mockResolvedValue({
      ...preview(),
      confirmationId: null,
      rateLimits: { ...preview().rateLimits!, rateLimitResetCredits: { availableCount: 0 } },
    });
    mounted = await render(<ProviderUsageResetButton provider={provider()} request={request} />);
    await page.getByRole("button", { name: "Redeem reset", exact: true }).click();
    await expect
      .element(page.getByText("You have no earned resets available.", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Redeem 1 reset", exact: true }))
      .not.toBeInTheDocument();
  });

  it("can refresh an expired confirmation without attempting another redemption", async () => {
    const request = vi
      .fn<RequestProviderUsageReset>()
      .mockResolvedValueOnce(preview())
      .mockRejectedValueOnce({
        _tag: "ProviderUsageResetError",
        message: "This reset confirmation expired. Reopen the dialog.",
      })
      .mockResolvedValueOnce({
        ...preview(),
        confirmationId: "00000000-0000-4000-8000-000000000002",
      });
    mounted = await render(<ProviderUsageResetButton provider={provider()} request={request} />);
    await page.getByRole("button", { name: "Redeem reset", exact: true }).click();
    await page.getByRole("button", { name: "Redeem 1 reset", exact: true }).click();
    await expect
      .element(page.getByText("This reset confirmation expired.", { exact: false }))
      .toBeVisible();
    await page.getByRole("button", { name: "Check availability", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Redeem 1 reset", exact: true }))
      .toBeEnabled();
    expect(request.mock.calls.map(([input]) => input.action)).toEqual([
      "preview",
      "redeem",
      "preview",
    ]);
  });

  it("keeps the confirmation readable and cancellable on a narrow scaled display", async () => {
    const original = { width: window.innerWidth, height: window.innerHeight };
    const request = vi.fn<RequestProviderUsageReset>().mockResolvedValue(preview());
    try {
      await page.viewport(390, 844);
      document.documentElement.style.fontSize = "130%";
      mounted = await render(<ProviderUsageResetButton provider={provider()} request={request} />);
      await page.getByRole("button", { name: "Redeem reset", exact: true }).click();
      await expect
        .element(page.getByRole("button", { name: "Redeem 1 reset", exact: true }))
        .toBeVisible();
      const popup = document.querySelector('[data-slot="dialog-popup"]')!;
      expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1);
      await vi.waitFor(() => expect(Number(getComputedStyle(popup).opacity)).toBe(1));
      await page.screenshot({ path: "../../../../build/reset-ui/dialog-mobile.png" });
      await page.viewport(1100, 800);
      document.documentElement.style.fontSize = "";
      await page.screenshot({ path: "../../../../build/reset-ui/dialog-desktop.png" });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(request.mock.calls.every(([input]) => input.action === "preview")).toBe(true);
    } finally {
      document.documentElement.style.fontSize = "";
      await page.viewport(original.width, original.height);
    }
  });
});
