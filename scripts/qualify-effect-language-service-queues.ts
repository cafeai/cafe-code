#!/usr/bin/env node
// Invocation identity must use the same native path spelling as Node.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EffectQueueQualificationError,
  qualifyEffectLanguageServiceQueues,
  runEffectQueueApiWorker,
} from "./lib/effect-language-service-queue-qualification.ts";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (process.argv.length === 5 && process.argv[2] === "--api-worker") {
      process.stdout.write(
        JSON.stringify(await runEffectQueueApiWorker(process.argv[3]!, process.argv[4]!)) + "\n",
      );
    } else if (process.argv.length === 2) {
      const result = await qualifyEffectLanguageServiceQueues(controller.signal);
      process.stdout.write(
        `[effect-fifo] identical ordered actual API/CLI diagnostics (${result.diagnostics}); ${result.phases} sequential owned phases; timing is informational only.\n`,
      );
      process.stdout.write(`[effect-fifo] exact bounded diagnostic evidence: ${result.evidence}\n`);
    } else throw new EffectQueueQualificationError();
  } catch {
    process.stderr.write(new EffectQueueQualificationError().message + "\n");
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
