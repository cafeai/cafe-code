import "../../index.css";
import { EnvironmentId, EventId, ThreadId, type EnvironmentApi } from "@cafecode/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { ProviderDiagnosticWorkEntry } from "./ProviderDiagnosticWorkEntry";

/** Runs only in the existing provider-owned reduced-motion browser context. */
describe("diagnostic disclosure reduced motion", () => {
  let mounted: Awaited<ReturnType<typeof render>> | undefined;
  afterEach(async () => {
    await mounted?.unmount();
    __resetEnvironmentApiOverridesForTests();
  });

  it("uses actual reduced-motion media without weakening keyboard/privacy semantics", async () => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const environmentId = EnvironmentId.make("diagnostic-motion-fixture-environment");
    const read = vi.fn(async (input: unknown) => ({ ...(input as object), diagnostic: null }));
    __setEnvironmentApiOverrideForTests(environmentId, {
      orchestration: { getThreadActivityDiagnostic: read },
    } as unknown as EnvironmentApi);
    mounted = await render(
      <ProviderDiagnosticWorkEntry
        environmentId={environmentId}
        threadId={ThreadId.make("diagnostic-motion-fixture-chat")}
        turnId={null}
        activityId={EventId.make("diagnostic-motion-fixture-event")}
        createdAt="2026-10-12T05:32:08.000Z"
        timestampFormat="locale"
        diagnostic={{
          recorded: true,
          summary: { version: 1, status: "error", subject: { kind: "root" } },
        }}
      />,
    );
    const trigger = page.getByRole("button", {
      name: "Inspect provider diagnostic: Root · Provider error",
      exact: true,
    });
    expect(read).not.toHaveBeenCalled();
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(
        page.getByText("Diagnostic details were not recorded for this event.", { exact: true }),
      )
      .toBeVisible();
    const panel = document.querySelector<HTMLElement>(
      '[data-provider-diagnostic] [data-slot="collapsible-panel"]',
    )!;
    expect(getComputedStyle(panel).transitionDuration).toBe("0s");
    const chevron = trigger.element().querySelector<SVGElement>("svg:last-child")!;
    expect(getComputedStyle(chevron).transitionDuration).toBe("0s");
    expect(read).toHaveBeenCalledOnce();
    await userEvent.keyboard(" ");
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("[data-provider-diagnostic-details]")).toBeNull();
  });
});
