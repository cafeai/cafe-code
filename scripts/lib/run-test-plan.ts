// This boundary owns native child handles through close, rather than inferring
// completion from a wrapper exit or launching arguments through a shell.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawn } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { existsSync } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { testRepositoryRoot, type TestStep } from "./test-run-plan.ts";

/** Use Corepack's JS entry through the pinned Node, including on Windows;
 * neither a package-manager batch shim nor a shell receives test arguments. */
export function corepackTestCommand(root: string | undefined, args: readonly string[]) {
  if (!root)
    throw new Error("Run test plans through Corepack Yarn (corepack yarn test:browser:ci).");
  const entry = resolve(root, "dist/yarn.js");
  if (!existsSync(entry)) throw new Error("The active Corepack Yarn entry is unavailable.");
  return { command: process.execPath, args: [entry, ...args] };
}

export interface TestPlanExecution {
  /** An explicit local owner may fence queued work as well as its current child.
   * Ordinary CI callers keep the same uncached, sequential default. */
  readonly signal?: AbortSignal;
  readonly cwd?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
}

export async function runTestPlan(steps: readonly TestStep[], execution: TestPlanExecution = {}) {
  for (const step of steps) {
    if (execution.signal?.aborted) throw new Error("Test plan cancelled before admission.");
    Effect.runSync(Console.log(`\n${step.name}`));
    const { command, args } = corepackTestCommand(
      (execution.environment ?? process.env).COREPACK_ROOT,
      step.args,
    );
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: execution.cwd ?? testRepositoryRoot,
        env: { ...(execution.environment ?? process.env), ...step.env },
        stdio: "inherit",
        shell: false,
      });
      let cancelled = false;
      let processError: Error | undefined;
      const interrupt = () => {
        cancelled = true;
        child.kill("SIGINT");
      };
      const terminate = () => {
        cancelled = true;
        child.kill("SIGTERM");
      };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);
      execution.signal?.addEventListener("abort", terminate, { once: true });
      const cleanup = () => {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
        execution.signal?.removeEventListener("abort", terminate);
      };
      child.once("error", (error) => {
        // A spawn/transport error does not authorize the next invocation while
        // this owned child's stdio or process lifetime is still unsettled.
        processError = error;
      });
      child.once("close", (code, signal) => {
        cleanup();
        Effect.runSync(
          Console.log(`${step.name}: ${((performance.now() - started) / 1000).toFixed(2)}s`),
        );
        if (code === 0 && !cancelled && !processError) resolve();
        else if (processError) reject(processError);
        else
          reject(
            new Error(`${step.name} ${cancelled ? "cancelled" : "failed"} (${signal ?? code}).`),
          );
      });
      // Native spawn can synchronously deliver cancellation before this exact
      // held child has registered its listener. Never admit the next step from
      // a zero close after that race.
      if (execution.signal?.aborted) terminate();
    });
  }
}
