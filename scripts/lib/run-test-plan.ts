import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
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

export async function runTestPlan(steps: readonly TestStep[]) {
  for (const step of steps) {
    console.log(`\n${step.name}`);
    const { command, args } = corepackTestCommand(process.env.COREPACK_ROOT, step.args);
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: testRepositoryRoot,
        env: { ...process.env, ...step.env },
        stdio: "inherit",
        shell: false,
      });
      let cancelled = false;
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
      const cleanup = () => {
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("exit", (code, signal) => {
        cleanup();
        console.log(`${step.name}: ${((performance.now() - started) / 1000).toFixed(2)}s`);
        if (code === 0 && !cancelled) resolve();
        else reject(new Error(`${step.name} failed (${signal ?? code}).`));
      });
    });
  }
}
