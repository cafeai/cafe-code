// Native checkout/fixture IO retains its existing descriptor, identity and lifetime semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { readFileSync } from "node:fs";
// Host-native path spelling must agree with the existing native file and tool boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
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
          readonly if?: string;
          readonly "continue-on-error"?: boolean | string;
          readonly env?: Readonly<Record<string, string>>;
          readonly run?: string;
        }>;
      }
    >
  >;
}

type CompilerStep = NonNullable<Workflow["jobs"][string]["steps"]>[number];

/** Compiler policy is an execution prerequisite, not an install-hook guess.
 * Only the explicit supported preparation followed by the actual fresh probe
 * may precede the canonical complete typecheck, on every native runner. */
function hasIntendedCompilerAdmission(
  steps: readonly CompilerStep[],
  prepareScript: string | undefined,
): boolean {
  const prepare = steps.findIndex((step) => step.run?.trim() === "corepack yarn prepare");
  const qualify = steps.findIndex(
    (step) => step.run?.trim() === "corepack yarn exec node scripts/qualify-effect-compiler.ts",
  );
  const typecheck = steps.findIndex((step) => step.run?.trim() === "corepack yarn typecheck");
  return (
    prepareScript === "effect-language-service patch --force" &&
    prepare >= 0 &&
    qualify > prepare &&
    typecheck > qualify &&
    [steps[prepare], steps[qualify]].every(
      (step) =>
        step !== undefined &&
        step.if === undefined &&
        (step["continue-on-error"] === undefined || step["continue-on-error"] === false),
    )
  );
}

describe("CI typecheck resource budget", () => {
  const rootPackage = parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>;
  };
  const typecheckArguments = rootPackage.scripts.typecheck!.split(/\s+/);

  it("refuses skipped, softened or reordered compiler preparation and qualification", () => {
    const prepare: CompilerStep = { run: "corepack yarn prepare" };
    const qualify: CompilerStep = {
      run: "corepack yarn exec node scripts/qualify-effect-compiler.ts",
    };
    const typecheck: CompilerStep = { run: "corepack yarn typecheck" };
    const script = "effect-language-service patch --force";
    expect(hasIntendedCompilerAdmission([prepare, qualify, typecheck], script)).toBe(true);
    for (const steps of [
      [qualify, typecheck],
      [prepare, typecheck],
      [qualify, prepare, typecheck],
      [prepare, typecheck, qualify],
      [prepare, qualify, { ...typecheck, run: "corepack yarn typecheck -- --filter=changed" }],
      [{ ...prepare, if: "runner.os == 'Linux'" }, qualify, typecheck],
      [prepare, { ...qualify, if: "runner.os == 'Linux'" }, typecheck],
      [prepare, { ...qualify, "continue-on-error": true }, typecheck],
      [{ ...prepare, "continue-on-error": "${{ inputs.ignore }}" }, qualify, typecheck],
    ])
      expect(hasIntendedCompilerAdmission(steps, script)).toBe(false);
    expect(hasIntendedCompilerAdmission([prepare, qualify, typecheck], undefined)).toBe(false);
    expect(hasIntendedCompilerAdmission([prepare, qualify, typecheck], "echo patched")).toBe(false);
  });

  it.each(["ci.yml", "release.yml"])(
    "bounds cold compiler memory without skipping packages or changing other steps in %s",
    (file) => {
      const workflow = parse(
        readFileSync(resolve(repoRoot, ".github/workflows", file), "utf8"),
      ) as Workflow;

      // Hosted macOS defaults to a ~2 GiB V8 heap, below the server's cold
      // compiler demand. The canonical command admits at most three tasks;
      // separate heap ceilings do not guarantee an aggregate memory budget.
      // Keep that bound and the entire graph, including release's CI reuse.
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
      expect(typecheckSteps[0]?.run?.trim(), file).toBe("corepack yarn typecheck");
      for (const job of Object.values(checked.jobs)) {
        const steps = job.steps ?? [];
        if (steps.some((step) => step.run?.trim() === "corepack yarn typecheck")) {
          expect(hasIntendedCompilerAdmission(steps, rootPackage.scripts.prepare), file).toBe(true);
        }
      }
      expect(typecheckArguments.slice(0, 3)).toEqual(["turbo", "run", "typecheck"]);
      expect(typecheckArguments.filter((arg) => arg.startsWith("--concurrency"))).toEqual([
        "--concurrency=3",
      ]);
      expect(
        typecheckArguments.some((arg) =>
          /^(?:--filter|--affected|--only|--parallel)(?:=|$)/.test(arg),
        ),
      ).toBe(false);
      // Inherit the one canonical limit rather than duplicating a CLI option
      // that Turbo rejects when a package-script default is already present.
      expect(typecheckSteps[0]?.run, file).not.toMatch(/--concurrency\b/);
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
