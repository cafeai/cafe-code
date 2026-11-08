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
import {
  localResultCacheArguments,
  openLocalVerificationCache,
} from "./lib/local-verification-session.ts";
import { runLocalBrowserTestPlan } from "./lib/local-browser-tests.ts";

const { requested, remaining } = localResultCacheArguments(process.argv.slice(2));
const mode = browserTestMode(remaining);
if (requested && mode !== "complete-local")
  throw new Error("Only complete local browser qualification may reuse local results.");
if (mode === "complete-local") {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const selection = resolveCompleteLocalBrowserSelection(testRepositoryRoot);
    Effect.runSync(
      Console.log(
        `Complete local browser qualification: ${selection.desktopFiles.length} ordinary desktop files; all native groups retained.`,
      ),
    );
    const cache = await openLocalVerificationCache(testRepositoryRoot, requested);
    await withBrowserArtifactDirectory(async (artifacts) => {
      await runLocalBrowserTestPlan(
        testRepositoryRoot,
        browserTestPlan(process.platform, { selection, artifacts }),
        selection,
        controller.signal,
        cache,
      );
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
} else {
  await runTestPlan(browserTestPlan(process.platform));
}
