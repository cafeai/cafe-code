import { expect, it } from "vitest";
import type { TestModule } from "vitest/node";
import { moduleTiming, runTiming } from "./test-timing-reporter.ts";
import { resolve } from "node:path";

it("records bounded timing labels without arbitrary errors, values or the invalid browser prepare counter", () => {
  const result = moduleTiming({
    moduleId: resolve(import.meta.dirname, "test-timing-reporter.test.ts"),
    project: { name: "browser-fixture" },
    state: () => "failed",
    diagnostic: () => ({
      duration: 25,
      collectDuration: 10,
      setupDuration: 2,
      prepareDuration: 999_999,
    }),
    children: {
      allTests: () => [
        {
          fullName: "Synthetic test " + "x".repeat(500),
          diagnostic: () => ({ duration: 20 }),
          result: () => ({ state: "failed", errors: [new Error("private-received-error")] }),
          meta: () => ({ secret: "private-metadata" }),
        },
      ],
    },
  } as unknown as TestModule);
  expect(result.executionMs).toBe(25);
  expect(result.collectionMs).toBe(10);
  expect(result.state).toBe("failed");
  expect(result.tests[0]!.name).toHaveLength(300);
  expect(result.tests[0]!.state).toBe("failed");
  const json = JSON.stringify(result);
  expect(json).not.toContain("private-received-error");
  expect(json).not.toContain("private-metadata");
  expect(json).not.toContain("999999");
});

it("distinguishes an interrupted partial run and a zero-work run from completed passing tests", () => {
  const files = [
    {
      file: "synthetic.test.ts",
      project: "fixture",
      state: "pending" as const,
      executionMs: 10,
      collectionMs: 2,
      setupMs: 0,
      tests: [
        { name: "completed before cancellation", durationMs: 3, state: "passed" as const },
        { name: "not completed", durationMs: 0, state: "pending" as const },
        { name: "intentionally skipped", durationMs: 0, state: "skipped" as const },
      ],
    },
  ];
  expect(runTiming(files, "interrupted", 0)).toEqual({
    reason: "interrupted",
    unhandledErrorCount: 0,
    fileCount: 1,
    testCounts: { passed: 1, failed: 0, pending: 1, skipped: 1 },
  });
  expect(runTiming([], "passed", 0)).toEqual({
    reason: "passed",
    unhandledErrorCount: 0,
    fileCount: 0,
    testCounts: { passed: 0, failed: 0, pending: 0, skipped: 0 },
  });
  expect(runTiming(files, "failed", 1)).toMatchObject({
    reason: "failed",
    unhandledErrorCount: 1,
  });
});
