// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
const root = resolve(import.meta.dirname, "..");
const workflow = (name: string) =>
  parse(readFileSync(resolve(root, ".github/workflows", name), "utf8"));

describe("release publication gates", () => {
  it("qualifies one selected source across every reliability job", () => {
    const reliability = workflow("reliability.yml");
    expect(reliability.on.workflow_call.inputs.source_ref).toEqual({
      type: "string",
      default: "",
    });
    expect(Object.keys(reliability.jobs).sort()).toEqual([
      "dependency-advisories",
      "packaged-runtime",
      "process-lifecycle",
    ]);
    for (const job of Object.values(reliability.jobs) as {
      steps: { uses?: string; with?: { ref?: string } }[];
    }[]) {
      const checkouts = job.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
      expect(checkouts).toHaveLength(1);
      // Release callers supply an immutable source SHA, manual runs qualify
      // their selected ref, and scheduled canaries retain the dev default.
      expect(checkouts[0]!.with?.ref).toBe(
        "${{ inputs.source_ref || (github.event_name == 'workflow_dispatch' && github.ref || 'dev') }}",
      );
    }
  });

  it("requires reusable native quality/lifecycle checks for the exact tag commit", () => {
    const release = workflow("release.yml");
    for (const name of ["quality", "reliability"]) {
      expect(release.jobs[name].with.source_ref).toBe("${{ needs.prepare.outputs.source-sha }}");
      expect(release.jobs[name].uses).toMatch(
        /^\.\/\.github\/workflows\/(?:ci|reliability)\.yml$/u,
      );
    }
    expect(release.jobs.quality.with.release_candidate).toBe(true);
    expect(release.jobs.publish.needs).toEqual(["prepare", "quality", "reliability", "artifacts"]);
    const ci = workflow("ci.yml");
    expect(
      ci.jobs.quality.steps.some(
        (step: { run?: string }) =>
          step.run === "corepack yarn npm audit --all --recursive --no-deprecations",
      ),
    ).toBe(true);
    expect(
      ci.jobs.quality.steps.some(
        (step: { run?: string }) => step.run === "corepack yarn release:smoke",
      ),
    ).toBe(true);
    expect(
      ci.jobs.quality.steps.filter((step: { name?: string }) => step.name === "Browser tests"),
    ).toEqual([
      {
        name: "Browser tests",
        if: "runner.os == 'Linux'",
        run: [
          "corepack yarn workspace @cafecode/web test:browser --project=desktop --project=touch",
          "corepack yarn workspace @cafecode/web test:browser --project=visualization-fluid-motion",
          "corepack yarn workspace @cafecode/web test:browser --project=context-reduced-motion",
          "",
        ].join("\n"),
      },
    ]);
  });
  it("qualifies uploaded bytes before sealing and checks the candidate feed before publishing", () => {
    const release = workflow("release.yml");
    const artifactSteps = release.jobs.artifacts.steps;
    const seal = artifactSteps.findIndex(
      (step: { name?: string }) => step.name === "Seal qualified artifact identities",
    );
    for (const run of [
      "corepack yarn test:native-windows-artifact",
      "corepack yarn test:native-macos-artifact",
      "xvfb-run -a corepack yarn test:native-linux-artifact",
    ]) {
      const index = artifactSteps.findIndex((step: { run?: string }) => step.run === run);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(seal);
    }
    expect(artifactSteps[seal].run).toContain('--sha "${{ needs.prepare.outputs.source-sha }}"');
    const steps = release.jobs.publish.steps;
    const publish = steps.findIndex(
      (step: { name?: string }) => step.name === "Create GitHub release",
    );
    for (const name of [
      "Verify qualified artifact identities",
      "Validate release manifests and checksums",
      "Qualify candidate update feed before publication",
    ]) {
      const index = steps.findIndex((step: { name?: string }) => step.name === name);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(publish);
    }
    expect(release.jobs.artifacts.env.CAFE_CODE_DESKTOP_SIGNED).toBe("false");
    for (const job of Object.values(release.jobs) as {
      steps?: { [key: string]: unknown }[];
      [key: string]: unknown;
    }[]) {
      expect(job).not.toHaveProperty("continue-on-error");
      for (const step of job.steps ?? []) expect(step).not.toHaveProperty("continue-on-error");
    }
  });
});
