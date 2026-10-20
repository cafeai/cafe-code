import { runTestPlan } from "./lib/run-test-plan.ts";
import { browserTestPlan } from "./lib/test-run-plan.ts";
import { testRepositoryRoot } from "./lib/test-run-plan.ts";
import {
  browserTestMode,
  resolveCompleteLocalBrowserSelection,
} from "./lib/browser-test-selection.ts";
import { withBrowserArtifactDirectory } from "./lib/browser-test-artifacts.ts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

if (browserTestMode(process.argv.slice(2)) === "complete-local") {
  const selection = resolveCompleteLocalBrowserSelection(testRepositoryRoot);
  Effect.runSync(
    Console.log(
      `Complete local browser qualification: ${selection.desktopFiles.length} ordinary desktop files; all native groups retained.`,
    ),
  );
  await withBrowserArtifactDirectory(async (artifacts) => {
    await runTestPlan(browserTestPlan(process.platform, { selection, artifacts }));
  });
} else {
  await runTestPlan(browserTestPlan(process.platform));
}
