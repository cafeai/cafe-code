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
import type { VisualizationInlineResult } from "@cafecode/contracts/visualizationApi";
import { uiText } from "@cafecode/shared/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { VisualizationCard } from "./VisualizationCard";
import { VisualizationViewerProvider } from "./VisualizationViewerProvider";
import { visualizationPresentation } from "./visualizationPresentation";
import { createFluidFixture } from "./visualizationFluid.fixture";

/** Uses only the existing provider-owned reduced-motion project. No raw CDP
 * device changes, matchMedia replacements or input-policy workarounds exist. */
describe("visualization native reduced-motion presentation", () => {
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
  it("rebuilds a visible static fluid at the real resized common-ratio resolution without RAF", async () => {
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const fixture = await createFluidFixture({ visible: true });
    try {
      expect(fixture.window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      const canvas = fixture.canvas();
      const before = fixture.recorder.summary();
      expect(Number(canvas.dataset.cafeFluidFrames)).toBe(12);
      // Real CSS layout and the browser's own ResizeObserver deliver the
      // resize. Neither a received counter nor a fabricated observer callback
      // establishes that this static canvas followed its actual geometry.
      canvas.style.width = "600px";
      canvas.style.height = "400px";
      await expect.poll(() => Number(canvas.dataset.cafeFluidFrames)).toBe(24);
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(
        fixture.window.devicePixelRatio,
        512 / Math.max(rect.width, rect.height),
      );
      expect(canvas.width).toBe(Math.max(1, Math.floor(rect.width * scale)));
      expect(canvas.height).toBe(Math.max(1, Math.floor(rect.height * scale)));
      expect(canvas.dataset.cafeFluidState).toBe("static");
      const resized = fixture.recorder.summary();
      expect(resized.createdTextures - before.createdTextures).toBe(8);
      expect(resized.deletedTextures - before.deletedTextures).toBe(8);
      expect(resized).toMatchObject({
        textures: 8,
        framebuffers: 8,
        programs: 10,
        shaders: 12,
        buffers: 2,
        peakTextures: 8,
        maxPending: 0,
        solverClearsAfterDraw: 0,
      });
      // The independent live-object peak proves replacement did not retain
      // old textures while allocating a second set. Logical half-float bytes
      // are not a physical GPU memory or process-RSS measurement.
      expect(resized.peakTextureBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(fixture.recorder.pending()).toBe(0);
      canvas.style.width = "600px";
      canvas.style.height = "400px";
      fixture.window.dispatchEvent(new Event("cafe-presentation-changed"));
      fixture.visible(true);
      for (let time = 40; time <= 400_000; time += 40) fixture.recorder.flush(time);
      expect(Number(canvas.dataset.cafeFluidFrames)).toBe(24);
      expect(fixture.recorder.summary()).toEqual(resized);
      expect(fixture.recorder.pending()).toBe(0);
    } finally {
      fixture.dispose();
    }
    expect(fixture.recorder.summary()).toMatchObject({
      textures: 0,
      framebuffers: 0,
      programs: 0,
      shaders: 0,
      buffers: 0,
      textureBytes: 0,
      listeners: 0,
      resizeObservers: 0,
      mutationObservers: 0,
    });
  });
  it("does no later hidden static resize work and rebuilds once only after actual visible admission", async () => {
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const fixture = await createFluidFixture({ visible: true });
    try {
      const canvas = fixture.canvas();
      fixture.visible(false);
      const hidden = fixture.recorder.summary();
      canvas.style.width = "0px";
      canvas.style.height = "0px";
      // Two actual owner-page frames allow genuine ResizeObserver delivery;
      // the guest scheduler remains recorded and has no pending RAF.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      fixture.window.dispatchEvent(new Event("cafe-presentation-changed"));
      expect(canvas.getBoundingClientRect().width).toBe(0);
      expect(canvas.dataset.cafeFluidState).toBe("paused");
      expect(Number(canvas.dataset.cafeFluidFrames)).toBe(12);
      expect(fixture.recorder.summary()).toEqual(hidden);
      canvas.style.width = "600px";
      canvas.style.height = "400px";
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      fixture.window.dispatchEvent(new Event("cafe-presentation-changed"));
      expect(fixture.recorder.summary()).toEqual(hidden);
      expect(fixture.recorder.pending()).toBe(0);
      fixture.visible(true);
      await expect.poll(() => Number(canvas.dataset.cafeFluidFrames)).toBe(24);
      expect(canvas.dataset.cafeFluidState).toBe("static");
      expect(fixture.recorder.summary()).toMatchObject({
        textures: 8,
        framebuffers: 8,
        programs: 10,
        buffers: 2,
        peakTextures: 8,
        maxPending: 0,
      });
      expect(fixture.recorder.pending()).toBe(0);
    } finally {
      fixture.dispose();
    }
  });
  it("retains the eight static size admissions and permanently cleans up the ninth real resize", async () => {
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const fixture = await createFluidFixture({ visible: true });
    try {
      const canvas = fixture.canvas();
      // Initial layout is admission one. Every pair has a genuinely different
      // physical common-ratio size on the unchanged provider-owned context.
      for (let index = 0; index < 7; index++) {
        canvas.style.width = `${300 + index * 40}px`;
        canvas.style.height = `${180 + index * 20}px`;
        await expect.poll(() => Number(canvas.dataset.cafeFluidFrames)).toBe(24 + index * 12);
        expect(canvas.dataset.cafeFluidState).toBe("static");
        expect(fixture.recorder.pending()).toBe(0);
        expect(fixture.recorder.summary()).toMatchObject({
          textures: 8,
          framebuffers: 8,
          programs: 10,
          buffers: 2,
          peakTextures: 8,
          maxPending: 0,
        });
      }
      expect(Number(canvas.dataset.cafeFluidFrames)).toBe(96);
      canvas.style.width = "580px";
      canvas.style.height = "320px";
      await expect.poll(() => canvas.dataset.cafeFluidState).toBe("unsupported");
      const refused = fixture.recorder.summary();
      expect(refused).toMatchObject({
        textures: 0,
        framebuffers: 0,
        programs: 0,
        shaders: 0,
        buffers: 0,
        textureBytes: 0,
        listeners: 0,
        resizeObservers: 0,
        mutationObservers: 0,
        peakTextures: 8,
        maxPending: 0,
      });
      expect(Number(canvas.dataset.cafeFluidFrames)).toBe(96);
      canvas.style.width = "620px";
      canvas.style.height = "340px";
      fixture.visible(false);
      fixture.visible(true);
      fixture.window.dispatchEvent(new Event("cafe-presentation-changed"));
      for (let time = 40; time <= 400_000; time += 40) fixture.recorder.flush(time);
      expect(canvas.dataset.cafeFluidState).toBe("unsupported");
      expect(Number(canvas.dataset.cafeFluidFrames)).toBe(96);
      expect(fixture.recorder.summary()).toEqual(refused);
      expect(fixture.recorder.pending()).toBe(0);
    } finally {
      fixture.dispose();
    }
  });
  it("renders finite static fluid and never schedules motion in the native reduced-motion context", async () => {
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    const fixture = await createFluidFixture({ visible: true });
    try {
      expect(fixture.window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      expect(fixture.canvas().dataset.cafeFluidState).toBe("static");
      expect(Number(fixture.canvas().dataset.cafeFluidFrames)).toBe(12);
      expect(fixture.recorder.pending()).toBe(0);
      const draws = fixture.recorder.summary().draws;
      fixture.visible(false);
      fixture.visible(true);
      fixture.window.dispatchEvent(new Event("cafe-presentation-changed"));
      for (let time = 40; time <= 400_000; time += 40) fixture.recorder.flush(time);
      expect(Number(fixture.canvas().dataset.cafeFluidFrames)).toBe(12);
      expect(fixture.recorder.summary().draws).toBe(draws);
      expect(fixture.recorder.pending()).toBe(0);
      expect(fixture.document.body.textContent).toContain(
        "Readable chart labels remain ordinary DOM.",
      );
    } finally {
      fixture.dispose();
    }
    expect(fixture.recorder.summary()).toMatchObject({
      textures: 0,
      framebuffers: 0,
      programs: 0,
      shaders: 0,
      buffers: 0,
      textureBytes: 0,
      listeners: 0,
    });
  });
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
    const trigger = page.getByRole("button", { name: "Visualization actions", exact: true });
    const triggerElement = trigger.element();
    triggerElement.focus();
    expect(details).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    const inspection = page.getByRole("menuitem", { name: "Private source and JSON", exact: true });
    await expect.element(inspection).toBeVisible();
    inspection.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("private-motion-source", { exact: true })).toBeVisible();
    const panel = document.querySelector<HTMLElement>("[data-visualization-inspection]")!;
    expect(getComputedStyle(panel).transitionDuration).toBe("0s");
    expect(getComputedStyle(triggerElement.querySelector("svg")!).transitionDuration).toBe("0s");
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
    expect(document.body.textContent).not.toContain("private-motion-json");
  });
});
