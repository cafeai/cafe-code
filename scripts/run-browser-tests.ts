import { runTestPlan } from "./lib/run-test-plan.ts";
import { browserTestPlan } from "./lib/test-run-plan.ts";

await runTestPlan(browserTestPlan(process.platform));
