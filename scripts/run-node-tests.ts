import { runTestPlan } from "./lib/run-test-plan.ts";
import { nodeTestPlan } from "./lib/test-run-plan.ts";

await runTestPlan(nodeTestPlan(process.platform));
