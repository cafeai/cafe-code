import { discoverLocalNodeTestPrograms, runLocalNodeTestPrograms } from "./lib/local-node-tests.ts";
import {
  localResultCacheArguments,
  openLocalVerificationCache,
} from "./lib/local-verification-session.ts";
import { testRepositoryRoot } from "./lib/test-run-plan.ts";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const { requested, remaining } = localResultCacheArguments(process.argv.slice(2));
  if (
    remaining.length !== 2 ||
    !["--phase=main", "--phase=codex-tail"].includes(remaining[0]!) ||
    !["--concurrency=1", "--concurrency=2", "--concurrency=3"].includes(remaining[1]!)
  )
    throw new Error(
      "Local Node tests require an exact phase and bounded concurrency; arbitrary selection is unsupported.",
    );
  const concurrency =
    remaining[1] === "--concurrency=1" ? 1 : remaining[1] === "--concurrency=2" ? 2 : 3;
  const all = await discoverLocalNodeTestPrograms(testRepositoryRoot, controller.signal);
  const tail = remaining[0] === "--phase=codex-tail";
  if (tail && process.platform === "win32")
    throw new Error("Windows uses the complete main Node phase.");
  const programs = all.filter(
    (program) =>
      process.platform === "win32" || (program.name === "effect-codex-app-server") === tail,
  );
  if (!all.some((program) => program.name === "effect-codex-app-server"))
    throw new Error("The canonical native Codex Node task is missing.");
  const cache = await openLocalVerificationCache(testRepositoryRoot, requested);
  await runLocalNodeTestPrograms(
    testRepositoryRoot,
    programs,
    tail ? 1 : concurrency,
    controller.signal,
    cache,
  );
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
