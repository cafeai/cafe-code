import "../../index.css";

import {
  EnvironmentId,
  ProjectId,
  type ServerProjectSystemTelemetryResult,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import { StrictMode } from "react";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProjectTelemetryGraph } from "./ProjectTelemetryGraph";

const environmentA = EnvironmentId.make("environment-telemetry-a");
const environmentB = EnvironmentId.make("environment-telemetry-b");
const projectA = ProjectId.make("project-telemetry-a");
const projectB = ProjectId.make("project-telemetry-b");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function telemetryFixture(input: {
  readonly projectId: ProjectId;
  readonly cpuPercent?: number;
  readonly freeBytes?: number;
  readonly minimumSampleIntervalMs?: number;
}): ServerProjectSystemTelemetryResult {
  const freeBytes = input.freeBytes ?? 3 * 1024 ** 3;
  return {
    projectId: input.projectId,
    sampledAt: DateTime.makeUnsafe("2026-07-26T12:00:00.000Z"),
    minimumSampleIntervalMs: input.minimumSampleIntervalMs ?? 1_000,
    platform: "linux",
    architecture: "arm64",
    cpu: {
      status: "available",
      utilizationPercent: input.cpuPercent ?? 42,
      logicalProcessorCount: 8,
      detail: null,
    },
    memory: {
      status: "available",
      totalBytes: 8 * 1024 ** 3,
      usedBytes: 6 * 1024 ** 3,
      availableBytes: 2 * 1024 ** 3,
      utilizationPercent: 75,
      detail: null,
    },
    projectVolume: {
      status: "available",
      totalBytes: 10 * 1024 ** 3,
      usedBytes: 7 * 1024 ** 3,
      availableBytes: freeBytes,
      utilizationPercent: 70,
      projectVolumeOnly: true,
      detail: null,
    },
  };
}

describe("ProjectTelemetryGraph", () => {
  beforeEach(async () => page.viewport(800, 600));

  it("renders selected-project disk free space and honest unavailable GPU fields", async () => {
    const first = deferred<ServerProjectSystemTelemetryResult>();
    const readTelemetry = vi.fn(() => first.promise);
    const mounted = await render(
      <ProjectTelemetryGraph
        environmentId={environmentA}
        projectId={projectA}
        projectName="Cafe workspace"
        readTelemetry={readTelemetry}
      />,
    );

    try {
      expect(
        document
          .querySelector('button[aria-label="Expand Resources"]')
          ?.hasAttribute("aria-controls"),
      ).toBe(false);
      await page.getByLabelText("Expand Resources").click();
      const collapseButton = document.querySelector(
        'button[aria-label="Collapse project resource graphs"]',
      );
      expect(document.getElementById(collapseButton?.getAttribute("aria-controls") ?? "")).not.toBe(
        null,
      );
      await vi.waitFor(() => expect(readTelemetry).toHaveBeenCalledTimes(1));
      await expect.element(page.getByLabelText(/GPU: Waiting/i)).toBeVisible();
      await expect.element(page.getByLabelText(/VRAM: Waiting/i)).toBeVisible();
      first.resolve(telemetryFixture({ projectId: projectA }));
      await expect.element(page.getByText("3 GiB free · selected project volume")).toBeVisible();
      await expect
        .element(page.getByLabelText(/GPU: Unavailable.*unavailable from this backend/i))
        .toBeVisible();
      await expect
        .element(page.getByLabelText(/VRAM: Unavailable.*unavailable from this backend/i))
        .toBeVisible();
      await expect
        .element(page.getByText(/Host metrics: selected environment.*selected project volume/i))
        .toBeVisible();
      expect(readTelemetry).toHaveBeenCalledExactlyOnceWith(environmentA, projectA);
      const panel = document.querySelector('[aria-label="Selected project system telemetry"]');
      expect(panel?.getAttribute("data-project-id")).toBe(projectA);
    } finally {
      await mounted.unmount();
    }
  });

  it("launches one request under StrictMode and stops future polling while collapsed", async () => {
    const first = deferred<ServerProjectSystemTelemetryResult>();
    const readTelemetry = vi.fn(() => first.promise);
    const mounted = await render(
      <StrictMode>
        <ProjectTelemetryGraph
          environmentId={environmentA}
          pollIntervalMs={250}
          projectId={projectA}
          readTelemetry={readTelemetry}
        />
      </StrictMode>,
    );

    try {
      await page.getByLabelText("Expand Resources").click();
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-label")).toBe(
          "Collapse project resource graphs",
        ),
      );
      await vi.waitFor(() => expect(readTelemetry).toHaveBeenCalledTimes(1));
      first.resolve(telemetryFixture({ projectId: projectA, minimumSampleIntervalMs: 250 }));
      await expect.element(page.getByText("3 GiB free · selected project volume")).toBeVisible();
      await page.getByLabelText("Collapse project resource graphs").click();
      await vi.waitFor(() =>
        expect(document.activeElement?.getAttribute("aria-label")).toBe("Expand Resources"),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(readTelemetry).toHaveBeenCalledTimes(1);

      await page.getByLabelText("Expand Resources").click();
      await vi.waitFor(() => expect(readTelemetry).toHaveBeenCalledTimes(2));
    } finally {
      await mounted.unmount();
    }
  });

  it("lets an old request finish before polling a newly selected environment and project", async () => {
    const requestA = deferred<ServerProjectSystemTelemetryResult>();
    const requestB = deferred<ServerProjectSystemTelemetryResult>();
    const readTelemetry = vi.fn((environmentId: EnvironmentId, projectId: ProjectId) => {
      if (environmentId === environmentA && projectId === projectA) return requestA.promise;
      if (environmentId === environmentB && projectId === projectB) return requestB.promise;
      throw new Error("Unexpected telemetry target.");
    });
    const mounted = await render(
      <ProjectTelemetryGraph
        environmentId={environmentA}
        projectId={projectA}
        readTelemetry={readTelemetry}
      />,
    );

    try {
      await page.getByLabelText("Expand Resources").click();
      await vi.waitFor(() => expect(readTelemetry).toHaveBeenCalledTimes(1));
      await mounted.rerender(
        <ProjectTelemetryGraph
          environmentId={environmentB}
          projectId={projectB}
          projectName="Second workspace"
          readTelemetry={readTelemetry}
        />,
      );
      expect(readTelemetry).toHaveBeenCalledTimes(1);

      requestA.resolve(telemetryFixture({ projectId: projectA, freeBytes: 1 * 1024 ** 3 }));
      await vi.waitFor(() => expect(readTelemetry).toHaveBeenCalledTimes(2));
      expect(readTelemetry).toHaveBeenLastCalledWith(environmentB, projectB);
      expect(document.body.textContent).not.toContain("1 GiB free · selected project volume");

      requestB.resolve(telemetryFixture({ projectId: projectB, freeBytes: 5 * 1024 ** 3 }));
      await expect.element(page.getByText("5 GiB free · selected project volume")).toBeVisible();
      const panel = document.querySelector('[aria-label="Selected project system telemetry"]');
      expect(panel?.getAttribute("data-project-id")).toBe(projectB);
    } finally {
      await mounted.unmount();
    }
  });

  it("does not schedule another request after unmount while one read finishes", async () => {
    const pending = deferred<ServerProjectSystemTelemetryResult>();
    const readTelemetry = vi.fn(() => pending.promise);
    const mounted = await render(
      <ProjectTelemetryGraph
        environmentId={environmentA}
        pollIntervalMs={250}
        projectId={projectA}
        readTelemetry={readTelemetry}
      />,
    );

    await page.getByLabelText("Expand Resources").click();
    await vi.waitFor(() => expect(readTelemetry).toHaveBeenCalledTimes(1));
    await mounted.unmount();
    pending.resolve(telemetryFixture({ projectId: projectA, minimumSampleIntervalMs: 250 }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(readTelemetry).toHaveBeenCalledTimes(1);
  });

  it("renders expanded without overlaying the message timeline on a wide viewport", async () => {
    await page.viewport(1_200, 800);
    const readTelemetry = vi.fn(async () => telemetryFixture({ projectId: projectA }));
    const mounted = await render(
      <div className="flex h-[500px] flex-col">
        <ProjectTelemetryGraph
          environmentId={environmentA}
          projectId={projectA}
          readTelemetry={readTelemetry}
        />
        <div className="min-h-0 flex-1" data-testid="telemetry-timeline-space" />
      </div>,
    );

    try {
      await expect.element(page.getByLabelText("Collapse project resource graphs")).toBeVisible();
      const panel = document.querySelector('[aria-label="Selected project system telemetry"]');
      const timeline = document.querySelector('[data-testid="telemetry-timeline-space"]');
      expect(panel?.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        (timeline?.getBoundingClientRect().top ?? 0) + 1,
      );
      expect(timeline?.getBoundingClientRect().height).toBeGreaterThan(0);
      await vi.waitFor(() => expect(readTelemetry).toHaveBeenCalledTimes(1));
    } finally {
      await mounted.unmount();
      await page.viewport(800, 600);
    }
  });

  it("lets an in-flight read drain while hidden, then resumes automatically", async () => {
    const pending = deferred<ServerProjectSystemTelemetryResult>();
    const readTelemetry = vi
      .fn()
      .mockResolvedValueOnce(
        telemetryFixture({ projectId: projectA, minimumSampleIntervalMs: 250 }),
      )
      .mockImplementation(() => pending.promise);
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    const mounted = await render(
      <ProjectTelemetryGraph
        environmentId={environmentA}
        pollIntervalMs={250}
        projectId={projectA}
        readTelemetry={readTelemetry}
      />,
    );

    try {
      await page.getByLabelText("Expand Resources").click();
      await expect.element(page.getByLabelText(/Host CPU: 42%/i)).toBeVisible();
      await vi.waitFor(() => expect(readTelemetry).toHaveBeenCalledTimes(2));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      pending.resolve(telemetryFixture({ projectId: projectA, minimumSampleIntervalMs: 250 }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(readTelemetry).toHaveBeenCalledTimes(2);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.waitFor(() => expect(readTelemetry).toHaveBeenCalledTimes(3));
      await vi.waitFor(() => {
        const paths = document.querySelectorAll(
          'svg[aria-label="Host CPU utilization history"] path',
        );
        expect(paths[1]?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
      });
    } finally {
      await mounted.unmount();
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });

  it("captures synchronous RPC failures without unsafe diagnostics or timer overflow", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readTelemetry = vi.fn(() => {
      throw { _tag: "ProjectLookupFailed", message: "sensitive backend detail" };
    });
    const mounted = await render(
      <ProjectTelemetryGraph
        environmentId={environmentA}
        pollIntervalMs={Number.MAX_SAFE_INTEGER}
        projectId={projectA}
        readTelemetry={readTelemetry}
      />,
    );

    try {
      await page.getByLabelText("Expand Resources").click();
      await expect
        .element(page.getByLabelText(/CPU: Unavailable. Telemetry unavailable/i))
        .toBeVisible();
      expect(diagnostic).toHaveBeenCalledWith(
        "[PROJECT_TELEMETRY] read failed",
        "ProjectLookupFailed",
      );
      expect(document.body.textContent).not.toContain("sensitive backend detail");

      const unsafeError = Object.assign(new Error("sensitive path"), {
        name: "Unsafe\nC:\\workspace",
      });
      const unsafeRead = vi.fn(() => {
        throw unsafeError;
      });
      await mounted.rerender(
        <ProjectTelemetryGraph
          environmentId={environmentA}
          pollIntervalMs={Number.MAX_SAFE_INTEGER}
          projectId={projectA}
          readTelemetry={unsafeRead}
        />,
      );
      await vi.waitFor(() =>
        expect(diagnostic).toHaveBeenLastCalledWith("[PROJECT_TELEMETRY] read failed", "Error"),
      );

      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(readTelemetry).toHaveBeenCalledTimes(1);
      expect(unsafeRead).toHaveBeenCalledTimes(1);
    } finally {
      diagnostic.mockRestore();
      await mounted.unmount();
    }
  });

  it("replaces stale values with an explicit outage state after a successful sample", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const readTelemetry = vi
      .fn()
      .mockResolvedValueOnce(
        telemetryFixture({ projectId: projectA, minimumSampleIntervalMs: 250 }),
      )
      .mockRejectedValue({ _tag: "TelemetryOffline" });
    const mounted = await render(
      <ProjectTelemetryGraph
        environmentId={environmentA}
        pollIntervalMs={250}
        projectId={projectA}
        readTelemetry={readTelemetry}
      />,
    );

    try {
      await page.getByLabelText("Expand Resources").click();
      await expect.element(page.getByLabelText(/Host CPU: 42%/i)).toBeVisible();
      await expect
        .element(page.getByLabelText(/Host CPU: Unavailable. Telemetry unavailable/i))
        .toBeVisible();
      await expect
        .element(page.getByLabelText(/Host GPU: Unavailable. Telemetry unavailable/i))
        .toBeVisible();
      expect(document.body.textContent).toContain("last successful");
    } finally {
      diagnostic.mockRestore();
      await mounted.unmount();
    }
  });
});
