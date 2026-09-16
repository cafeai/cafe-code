import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dirname, "..");

interface Workflow {
  readonly jobs: Record<
    string,
    {
      readonly steps?: ReadonlyArray<{
        readonly name?: string;
        readonly if?: string;
        readonly run?: string;
      }>;
    }
  >;
}

describe("Linux native build workflow prerequisites", () => {
  it.each(["ci.yml", "release.yml", "reliability.yml"])(
    "installs DRM headers in every Linux native prerequisite step in %s",
    (file) => {
      const workflow = parse(
        readFileSync(resolve(repoRoot, ".github/workflows", file), "utf8"),
      ) as Workflow;
      const prerequisiteSteps = Object.entries(workflow.jobs).flatMap(([job, config]) =>
        (config.steps ?? [])
          .filter((step) => step.run?.includes("libgbm-dev"))
          .map((step) => ({ job, step })),
      );

      // Parse all jobs, including matrix jobs, so newly added Linux package
      // paths cannot silently inherit the incomplete GBM-only dependency list.
      expect(prerequisiteSteps.length).toBeGreaterThan(0);
      for (const { job, step } of prerequisiteSteps) {
        const context = `${file}: ${job}: ${step.name}`;
        expect(step.if, context).toBe("runner.os == 'Linux'");
        expect(step.run, context).toMatch(/\bapt-get\s+install\b[^\n]*\blibdrm-dev\b/);
      }
    },
  );
});
