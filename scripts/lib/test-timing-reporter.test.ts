import { expect, it } from "vitest";
import type { TestModule } from "vitest/node";
import { moduleTiming } from "./test-timing-reporter.ts";
import { resolve } from "node:path";

it("records bounded timing labels without arbitrary errors, values or the invalid browser prepare counter", () => {
  const result = moduleTiming({
    moduleId: resolve(import.meta.dirname, "test-timing-reporter.test.ts"),
    project: { name: "browser-fixture" },
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
  expect(result.tests[0]!.name).toHaveLength(300);
  expect(result.tests[0]!.state).toBe("failed");
  const json = JSON.stringify(result);
  expect(json).not.toContain("private-received-error");
  expect(json).not.toContain("private-metadata");
  expect(json).not.toContain("999999");
});
