import "../../index.css";
import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
} from "@cafecode/contracts";
import {
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { VisualizationCard } from "./VisualizationCard";
import { visualizationPresentation } from "./visualizationPresentation";

/** Uses only the existing provider-owned reduced-motion project. No raw CDP
 * device changes, matchMedia replacements or input-policy workarounds exist. */
describe("visualization native reduced-motion presentation", () => {
  afterEach(() => __resetEnvironmentApiOverridesForTests());
  it("observes native media and retains keyboard/private disclosure semantics", async () => {
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    expect(visualizationPresentation("en").reducedMotion).toBe(true);
    const environmentId = EnvironmentId.make("visualization-motion-fixture");
    const threadId = ThreadId.make("visualization-motion-chat");
    const artifactId = VisualizationArtifactId.make("a818e6a1-6151-45c9-b3f9-1d1819d2e24e");
    const revisionId = VisualizationRevisionId.make("65c5124c-dcbe-42c5-96c5-3640b4df300d");
    const details = vi.fn(async () => ({
      threadId,
      artifactId,
      revisionId,
      source: {
        version: 1,
        purpose: "generated-visualization",
        artifactId,
        revisionId,
        source: "private-motion-source",
        assets: [],
      },
      diagnostics: { version: 1, artifactId, revisionId, records: [], truncated: false },
      rawJson: '{"private-motion-json":true}',
    }));
    __setEnvironmentApiOverrideForTests(environmentId, {
      visualizations: { details },
    } as unknown as EnvironmentApi);
    await render(
      <VisualizationCard
        environmentId={environmentId}
        threadId={threadId}
        timestampFormat="locale"
        entry={{
          messageId: MessageId.make("motion-message"),
          turnId: TurnId.make("motion-turn"),
          originItemId: "motion-origin",
          occurredAt: "2026-10-12T12:14:15.000Z",
          actor: { type: "root" },
          reference: {
            version: 1,
            purpose: "generated-visualization",
            artifactId,
            revisionId,
            title: "Motion fixture",
            width: 640,
            height: 240,
          },
        }}
      />,
    );
    const trigger = page.getByRole("button", { name: "Private source and JSON", exact: true });
    trigger.element().focus();
    expect(details).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("private-motion-source", { exact: true })).toBeVisible();
    const panel = document.querySelector<HTMLElement>(
      '[data-visualization-card] [data-slot="collapsible-panel"]',
    )!;
    expect(getComputedStyle(panel).transitionDuration).toBe("0s");
    expect(getComputedStyle(trigger.element().querySelector("svg")!).transitionDuration).toBe("0s");
    trigger.element().focus();
    await userEvent.keyboard(" ");
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.body.textContent).not.toContain("private-motion-json");
  });
});
