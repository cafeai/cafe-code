import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = resolve(import.meta.dirname, "..");

interface Workflow {
  readonly env?: Readonly<Record<string, string>>;
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly uses?: string;
        readonly env?: Readonly<Record<string, string>>;
        readonly steps?: ReadonlyArray<{
          readonly name?: string;
          readonly env?: Readonly<Record<string, string>>;
          readonly run?: string;
        }>;
      }
    >
  >;
}

describe("CI typecheck resource budget", () => {
  it.each(["ci.yml", "release.yml"])(
    "bounds cold compiler memory without skipping packages or changing other steps in %s",
    (file) => {
      const workflow = parse(
        readFileSync(resolve(repoRoot, ".github/workflows", file), "utf8"),
      ) as Workflow;

      // Hosted macOS defaults to a ~2 GiB V8 heap, below the server's cold
      // compiler demand. Budget a single compiler at a time, not several
      // simultaneous 4 GiB heaps on a 7 GiB runner. Keep the entire task graph.
      const checked =
        file === "release.yml"
          ? (parse(readFileSync(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8")) as Workflow)
          : workflow;
      if (file === "release.yml")
        expect(workflow.jobs.quality?.uses).toBe("./.github/workflows/ci.yml");
      const typecheckSteps = Object.values(checked.jobs).flatMap((job) =>
        (job.steps ?? []).filter((step) => step.run?.includes("yarn typecheck")),
      );
      expect(typecheckSteps, file).toHaveLength(1);
      expect(typecheckSteps[0]?.run, file).toMatch(/\byarn typecheck\b/);
      expect(typecheckSteps[0]?.run, file).toMatch(/--concurrency(?:=| )1\b/);
      const heap = String(typecheckSteps[0]?.env?.NODE_OPTIONS ?? "").match(
        /--max-old-space-size(?:=| )(\d+)/,
      );
      expect(heap).not.toBeNull();
      expect(Number(heap![1])).toBe(4096);

      // Scope the larger heap to type checking only. Global/job-level options
      // would also affect tests, native packaging, and runtime smoke children.
      expect(workflow.env ?? {}, file).not.toHaveProperty("NODE_OPTIONS");
      for (const [jobName, job] of Object.entries(workflow.jobs)) {
        expect(job.env ?? {}, `${file}: ${jobName}`).not.toHaveProperty("NODE_OPTIONS");
        for (const step of job.steps ?? []) {
          if (!step.run?.includes("yarn typecheck")) {
            expect(step.env ?? {}, `${file}: ${jobName}: ${step.name}`).not.toHaveProperty(
              "NODE_OPTIONS",
            );
          }
        }
      }
    },
  );
});
