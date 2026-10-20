#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EffectCompilerQualificationError,
  qualifyInstalledEffectCompiler,
  runEffectCompilerApiWorker,
} from "./lib/effect-compiler-qualification.ts";

// This explicit local preflight is not imported as an ambient compiler job by
// default unit tests. It neither patches dependencies nor alters saved caches.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (process.argv[2] === "--api-worker" && process.argv.length === 4) {
      process.stdout.write(
        JSON.stringify(await runEffectCompilerApiWorker(process.argv[3]!)) + "\n",
      );
    } else if (process.argv.length === 2) {
      const report = await qualifyInstalledEffectCompiler(controller.signal);
      process.stdout.write(
        `[effect-compiler] qualified fresh TypeScript ${report.typescriptVersion} API/CLI and Effect ${report.languageServiceVersion} diagnostics; repository build-info validity is separate.\n`,
      );
    } else throw new EffectCompilerQualificationError("fixture");
  } catch (error) {
    process.stderr.write(
      (error instanceof EffectCompilerQualificationError
        ? error.message
        : "Effect compiler qualification failed; no typecheck qualification was granted.") + "\n",
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
