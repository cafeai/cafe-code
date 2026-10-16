import {
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
} from "@cafecode/contracts";
import type { VisualizationInlineResult } from "@cafecode/contracts/visualizationApi";
import {
  VisualizationArtifactId,
  VisualizationRevisionId,
} from "@cafecode/contracts/visualizations";
import { uiText } from "@cafecode/shared/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import "../../index.css";
import { VisualizationCard } from "./VisualizationCard";
import { VisualizationViewerProvider } from "./VisualizationViewerProvider";
import { createFluidFixture } from "./visualizationFluid.fixture";

/** Uses only the existing provider-owned reduced-motion project. No raw CDP
 * device changes, matchMedia replacements or input-policy workarounds exist. */
describe("visualization reduced-motion behavior", () => {
  afterEach(() => __resetEnvironmentApiOverridesForTests());
  it("shows a static semantic sparkle for genuinely held source readiness and removes it for the actual loaded document", async () => {
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const environmentId = EnvironmentId.make("visualization-motion-loading-environment"),
      threadId = ThreadId.make("visualization-motion-loading-chat"),
      artifactId = VisualizationArtifactId.make("5425cfd5-7aa2-407d-9f85-990180fa9ebc"),
      revisionId = VisualizationRevisionId.make("dd837826-6887-42dd-ac2e-5d07629c0906");
    let release!: (value: VisualizationInlineResult) => void;
    const source = new Promise<VisualizationInlineResult>((resolve) => {
      release = resolve;
    });
    const inline = vi.fn<NonNullable<NonNullable<EnvironmentApi["visualizations"]>["inline"]>>(
        () => source,
      ),
      touchInlineFrame = vi.fn<
        NonNullable<NonNullable<EnvironmentApi["visualizations"]>["touchInlineFrame"]>
      >(async ({ ticket: _ticket, ...input }) => ({ ...input, expiresAtMs: Date.now() + 30_000 })),
      retireInlineFrame = vi.fn<
        NonNullable<NonNullable<EnvironmentApi["visualizations"]>["retireInlineFrame"]>
      >(async ({ ticket: _ticket, ...input }) => ({ ...input, retired: true }));
    __setEnvironmentApiOverrideForTests(environmentId, {
      visualizations: { inline, touchInlineFrame, retireInlineFrame },
    } as unknown as EnvironmentApi);
    await render(
      <VisualizationViewerProvider>
        <VisualizationCard
          environmentId={environmentId}
          threadId={threadId}
          runtimeMode="full-access"
          timestampFormat="locale"
          entry={{
            messageId: MessageId.make("motion-loading-message"),
            turnId: TurnId.make("motion-loading-turn"),
            originItemId: "motion-loading-origin",
            occurredAt: "2026-10-12T12:14:15.000Z",
            actor: { type: "root" },
            reference: {
              version: 1,
              purpose: "generated-visualization",
              artifactId,
              revisionId,
              title: "Static loading fixture",
              width: 640,
              height: 240,
            },
          }}
        />
      </VisualizationViewerProvider>,
    );
    await expect
      .element(page.getByText(uiText("Loading visualization…"), { exact: true }))
      .toBeVisible();
    const status = document.querySelector<HTMLElement>("[data-visualization-loading]")!,
      sparkle = status.querySelector<SVGElement>("svg")!;
    expect(getComputedStyle(sparkle).animationName).toBe("none");
    expect(sparkle.classList.contains("text-status-running")).toBe(true);
    expect(sparkle.getAttribute("aria-hidden")).toBe("true");
    expect(status.getAttribute("role")).toBe("status");
    expect(document.querySelector("[data-visualization-card] iframe")).toBeNull();
    expect(inline).toHaveBeenCalledOnce();
    release({
      threadId,
      artifactId,
      revisionId,
      purpose: "generated-visualization",
      fullAccess: true,
      html: '<main style="height:240px"><button id="ready">Ready chart</button></main>',
      frameId: crypto.randomUUID(),
      ticket: "a".repeat(64),
      expiresAtMs: Date.now() + 30_000,
    });
    await vi.waitFor(() =>
      expect(
        document
          .querySelector<HTMLIFrameElement>("[data-visualization-card] iframe")
          ?.contentDocument?.getElementById("ready") ?? null,
      ).not.toBeNull(),
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-visualization-loading]")).toBeNull(),
    );
    expect(inline).toHaveBeenCalledOnce();
    expect(retireInlineFrame).not.toHaveBeenCalled();
  });
  it("keeps a visible decoration static without an idle frame loop", async () => {
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const value = await createFluidFixture({ visible: true });
    try {
      expect(value.canvas().dataset.cafeFluidState).toBe("static");
      expect(value.recorder.pending()).toBe(0);
      value.dispose();
      expect(value.recorder.pending()).toBe(0);
      expect(value.recorder.summary().textures).toBe(0);
    } finally {
      value.dispose();
    }
  });
});
