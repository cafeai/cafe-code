import {
  discoverLocalTypecheckPrograms,
  LocalTypecheckError,
  parseLocalTypecheckArguments,
  prioritizeLocalTypecheckPrograms,
  runLocalTypecheckPrograms,
} from "./lib/local-typecheck.ts";
import { testRepositoryRoot } from "./lib/test-run-plan.ts";

// There is deliberately no public root, script, compiler or selection option.
// The repository's canonical Yarn metadata owns the complete admitted set.
const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  const concurrency = parseLocalTypecheckArguments(process.argv.slice(2));
  const admitted = await discoverLocalTypecheckPrograms(testRepositoryRoot, controller.signal);
  const programs = concurrency > 1 ? prioritizeLocalTypecheckPrograms(admitted) : admitted;
  process.stdout.write(
    `Complete local typechecking: ${programs.length} programs; at most ${concurrency} native compilers, 4 GiB V8 heap each.\n`,
  );
  const result = await runLocalTypecheckPrograms(programs, concurrency, controller.signal);
  if (result.passed)
    process.stdout.write(`Complete local typechecking passed: ${result.completed} programs.\n`);
  else {
    for (const failure of result.failures)
      process.stderr.write(`Typechecking ${failure.workspace} failed (${failure.reason}).\n`);
    process.stderr.write(
      result.cancelled
        ? "Local typechecking cancelled; no complete qualification was granted.\n"
        : "Local typechecking failed; no complete qualification was granted.\n",
    );
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(
    (error instanceof LocalTypecheckError
      ? error.message
      : "Local typechecking failed; no complete qualification was granted. Use corepack yarn typecheck to investigate.") +
      "\n",
  );
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
