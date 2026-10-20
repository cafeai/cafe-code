import { describe, expect, it } from "vitest";
import {
  localVerificationPlan,
  parseLocalVerificationArguments,
  type LocalVerificationOptions,
} from "./local-verification-plan.ts";

describe("complete local verification", () => {
  it("qualifies the installed compiler before any typecheck can attest success", () => {
    const steps = localVerificationPlan();
    const compiler = steps.findIndex((step) =>
      step.args.some((arg) => arg.endsWith("qualify-effect-compiler.ts")),
    );
    expect(compiler).toBeGreaterThanOrEqual(0);
    expect(compiler).toBeLessThan(steps.findIndex((step) => step.args[0] === "typecheck"));
  });
  it("runs the whole uncached Node graph with two workspace owners and bounded workers", () => {
    const steps = localVerificationPlan();
    const node = steps.find((step) => step.args[0] === "test");
    expect(node?.args).toContain("--concurrency=2");
    expect(node?.args).toContain("--maxWorkers=2");
    expect(
      node?.args.some(
        (arg) => arg.includes("filter") || arg.includes("changed") || arg.includes("related"),
      ),
    ).toBe(false);
    expect(steps.find((step) => step.args[0] === "typecheck")?.args).toContain("--concurrency=1");
  });

  it("requires complete native browser qualification before a forced final build", () => {
    const steps = localVerificationPlan();
    const browser = steps.findIndex((step) => step.args[0] === "test:browser:local");
    expect(browser).toBeGreaterThan(steps.findIndex((step) => step.args[0] === "test"));
    expect(browser).toBeLessThan(steps.length - 1);
    expect(steps.at(-1)?.args).toEqual(["build:desktop", "--force", "--concurrency=1"]);
    expect(steps.find((step) => step.args[0] === "typecheck")?.env).toEqual({
      NODE_OPTIONS: "--max-old-space-size=4096",
    });
    expect(
      steps
        .filter((step) => step.args[0] !== "typecheck")
        .every((step) => step.env?.NODE_OPTIONS === undefined),
    ).toBe(true);
    expect(steps.at(-1)?.env?.CAFE_CODE_ASSET_COMPRESSION_CACHE).toMatch(
      /[/\\]\.logs[/\\]local-asset-compression$/,
    );
  });

  it.each([1, 2] as const)(
    "applies the explicit %s-workspace limit only to typechecking, without increasing compiler heap or test/build admission",
    (typecheckConcurrency) => {
      const steps = localVerificationPlan({ typecheckConcurrency, testConcurrency: 2 });
      const typecheck = steps.find((step) => step.args[0] === "typecheck")!;
      expect(typecheck.args).toEqual(["typecheck", `--concurrency=${typecheckConcurrency}`]);
      expect(typecheck.env).toEqual({ NODE_OPTIONS: "--max-old-space-size=4096" });
      const node = steps.find((step) => step.args[0] === "test")!;
      expect(node.args).toContain("--concurrency=2");
      expect(node.args).toContain("--maxWorkers=2");
      expect(steps.at(-1)?.args).toEqual(["build:desktop", "--force", "--concurrency=1"]);
      expect(steps.some((step) => step.args[0] === "test:browser:local")).toBe(true);
      expect(
        steps
          .filter((step) => step !== typecheck && step !== node)
          .every((step) => !step.args.includes("--concurrency=2")),
      ).toBe(true);
    },
  );

  it("defaults to one compiler and two test workspaces, retaining either independent override", () => {
    expect(parseLocalVerificationArguments([])).toEqual({
      typecheckConcurrency: 1,
      testConcurrency: 2,
    });
    for (const typecheckConcurrency of [1, 2] as const)
      expect(
        parseLocalVerificationArguments([`--typecheck-concurrency=${typecheckConcurrency}`]),
      ).toEqual({ typecheckConcurrency, testConcurrency: 2 });
    for (const testConcurrency of [1, 2, 3] as const)
      expect(parseLocalVerificationArguments([`--test-concurrency=${testConcurrency}`])).toEqual({
        typecheckConcurrency: 1,
        testConcurrency,
      });
  });

  it("accepts both exact options in either order without coupling their task limits", () => {
    for (const typecheckConcurrency of [1, 2] as const) {
      for (const testConcurrency of [1, 2, 3] as const) {
        const args = [
          `--typecheck-concurrency=${typecheckConcurrency}`,
          `--test-concurrency=${testConcurrency}`,
        ];
        for (const ordered of [args, [...args].reverse()]) {
          const options = parseLocalVerificationArguments(ordered);
          expect(options).toEqual({ typecheckConcurrency, testConcurrency });
          const steps = localVerificationPlan(options);
          expect(steps.find((step) => step.args[0] === "typecheck")?.args).toEqual([
            "typecheck",
            `--concurrency=${typecheckConcurrency}`,
          ]);
          const node = steps.find((step) => step.args[0] === "test")!;
          expect(node.args.slice(0, 3)).toEqual(["test", `--concurrency=${testConcurrency}`, "--"]);
          expect(node.args).toContain("--maxWorkers=2");
          expect(steps.find((step) => step.args[0] === "test:browser:local")?.args).toEqual([
            "test:browser:local",
          ]);
          expect(steps.at(-1)?.args).toEqual(["build:desktop", "--force", "--concurrency=1"]);
        }
      }
    }
  });

  it("rejects duplicate, ambiguous and out-of-policy arguments rather than selecting less coverage", () => {
    for (const args of [
      ["--typecheck-concurrency=0"],
      ["--typecheck-concurrency=3"],
      ["--typecheck-concurrency=02"],
      ["--typecheck-concurrency=2.0"],
      ["--typecheck-concurrency", "2"],
      ["--typecheck-concurrency=2", "--typecheck-concurrency=2"],
      ["--typecheck-concurrency=1", "--typecheck-concurrency=2"],
      ["--test-concurrency=0"],
      ["--test-concurrency=4"],
      ["--test-concurrency=02"],
      ["--test-concurrency=3.0"],
      ["--test-concurrency", "3"],
      ["--test-concurrency=3", "--test-concurrency=3"],
      ["--test-concurrency=1", "--test-concurrency=2"],
      ["--test-concurrency=2", "--typecheck-concurrency=1", "--test-concurrency=3"],
      ["--typecheck-concurrency=2", "--test-concurrency=1", "--typecheck-concurrency=1"],
      ["--skip=browser"],
      ["--filter=@cafecode/web"],
      ["src/selected.test.ts"],
      ["--typecheck-concurrency=2", "--skip=build"],
      ["--test-concurrency=3", "--filter=@cafecode/scripts"],
      ["--test-concurrency=3", "--skip=browser"],
      ["--test-concurrency=3", "selected.test.ts"],
      ["--"],
    ])
      expect(() => parseLocalVerificationArguments(args)).toThrow("selection and skip");
  });

  it("refuses an unsupported programmatic limit rather than constructing a broader task graph", () => {
    for (const typecheckConcurrency of [0, 3, Number.NaN, Number.POSITIVE_INFINITY, "2"])
      expect(() =>
        localVerificationPlan({
          typecheckConcurrency,
          testConcurrency: 2,
        } as unknown as LocalVerificationOptions),
      ).toThrow("exactly 1 or 2");
    for (const testConcurrency of [0, 4, Number.NaN, Number.POSITIVE_INFINITY, "2", undefined])
      expect(() =>
        localVerificationPlan({
          typecheckConcurrency: 1,
          testConcurrency,
        } as unknown as LocalVerificationOptions),
      ).toThrow("exactly 1, 2 or 3");
  });
});
