import {
  localVerificationPlan,
  parseLocalVerificationArguments,
} from "./lib/local-verification-plan.ts";
import { runTestPlan } from "./lib/run-test-plan.ts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

const options = parseLocalVerificationArguments(process.argv.slice(2));
Effect.runSync(
  Console.log(
    `Complete local verification: all required local tasks; typecheck workspace concurrency ${options.typecheckConcurrency}; Node test workspace concurrency ${options.testConcurrency} with at most two Vitest workers each; ${options.fresh ? "fresh results only (--fresh)" : "local exact-input success reuse enabled; each hit is labelled, not freshly executed"}; no hosted result reuse. Final forced desktop build is always fresh and last.`,
  ),
);
await runTestPlan(localVerificationPlan(options));
