import {
  localVerificationPlan,
  parseLocalVerificationArguments,
} from "./lib/local-verification-plan.ts";
import { runTestPlan } from "./lib/run-test-plan.ts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const options = parseLocalVerificationArguments(process.argv.slice(2));
const nodeSchedule =
  options.testConcurrency === "ci"
    ? "Node tests use the unchanged host-specific CI schedule and execute fresh"
    : `bounded local Node tests: workspace concurrency ${options.testConcurrency}, at most two Vitest workers each, exclusive server/scripts barriers; not CI scheduling parity`;
const reusePolicy = options.fresh
  ? "fresh results only (--fresh)"
  : options.testConcurrency === "ci"
    ? "eligible local type/browser exact-input success reuse enabled; each hit is labelled, not freshly executed"
    : "eligible local type/Node/browser exact-input success reuse enabled; each hit is labelled, not freshly executed";
Effect.runSync(
  Console.log(
    `Complete local verification: all required local tasks; typecheck workspace concurrency ${options.typecheckConcurrency}; ${nodeSchedule}; ${reusePolicy}; no hosted result reuse. Final forced desktop build is always fresh and last.`,
  ),
);
await runTestPlan(localVerificationPlan(options));
