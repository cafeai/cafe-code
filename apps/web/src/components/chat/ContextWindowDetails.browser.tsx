import "../../index.css";

import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ContextWindowDetails } from "./ContextWindowDetails";

const rateLimits: ServerProviderAccountRateLimits = {
  checkedAt: "2026-09-24T00:00:00.000Z",
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 98, windowDurationMins: 300, resetsAt: 1_780_000_000 },
  },
  rateLimitResetCredits: { availableCount: 0 },
};

describe("ContextWindowDetails reset availability", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    mounted = undefined;
  });

  it.each(["popover", "panel"] as const)(
    "puts the known count last in the %s summary, including zero",
    async (layout) => {
      mounted = await render(
        <ContextWindowDetails usage={null} rateLimits={rateLimits} layout={layout} />,
      );
      const count = page.getByText("Usage limit resets available: 0", { exact: true });
      await expect.element(count).toBeVisible();
      expect(count.element().parentElement?.lastElementChild).toBe(count.element());

      await mounted.rerender(
        <ContextWindowDetails
          usage={null}
          rateLimits={{ ...rateLimits, rateLimitResetCredits: { availableCount: 2 } }}
          layout={layout}
        />,
      );
      await expect.element(page.getByText("Usage limit resets available: 2")).toBeVisible();
    },
  );

  it("shows a known count without window usage and omits an unknown count", async () => {
    const countOnly = { ...rateLimits, rateLimits: { limitId: "codex" } };
    mounted = await render(<ContextWindowDetails usage={null} rateLimits={countOnly} />);
    await expect.element(page.getByText("Usage limit resets available: 0")).toBeVisible();

    await mounted.rerender(
      <ContextWindowDetails
        usage={null}
        rateLimits={{ ...countOnly, rateLimitResetCredits: null }}
      />,
    );
    await expect.element(page.getByText("Usage limit resets available: 0")).not.toBeInTheDocument();
    await expect.element(page.getByText("Waiting for usage from this thread.")).toBeVisible();
  });
});
