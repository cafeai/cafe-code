import type { CompleteLocalBrowserSelection } from "./browser-test-selection.ts";
import type { LocalVerificationCache } from "./local-verification-cache.ts";
import type { LocalVerificationTask } from "./local-verification-cache-contract.ts";
import { prepareLocalVerificationTaskEnvironment } from "./local-verification-environment.ts";
import { runTestPlan } from "./run-test-plan.ts";
import type { TestStep } from "./test-run-plan.ts";

/** Reuse only a whole existing native owner. Bridge preparation and copied
 * artifacts always execute; neither cached state nor a cached render can stand
 * in for their current exclusively owned files. The caller owns fresh complete
 * selection and artifact retirement around this sequential plan. */
export async function runLocalBrowserTestPlan(
  root: string,
  steps: readonly TestStep[],
  selection: CompleteLocalBrowserSelection,
  signal: AbortSignal,
  cache?: LocalVerificationCache,
  execute = runTestPlan,
) {
  for (const step of steps) {
    if (signal.aborted) throw new Error("Local browser qualification cancelled before admission.");
    const environment = Object.freeze({ ...process.env, ...step.env });
    const run = () => execute([step], { signal, cwd: root, environment });
    const projects = step.args
      .filter((arg) => arg.startsWith("--project="))
      .map((arg) => arg.slice("--project=".length));
    const inventory = new Set(Object.values(selection).flat());
    const namedFiles = step.args.filter((arg) => inventory.has(arg));
    const files = namedFiles.length
      ? namedFiles
      : projects.length === 1 && projects[0] === "visualization-fluid-motion"
        ? selection.fluidFiles
        : projects.length === 1 && projects[0] === "context-reduced-motion"
          ? selection.reducedMotionFiles
          : undefined;
    if (
      cache &&
      files &&
      files.length > 0 &&
      step.args[0] === "workspace" &&
      step.args[1] === "@cafecode/web" &&
      step.args[2] === "test:browser"
    ) {
      const task: LocalVerificationTask = {
        id: `browser:${step.name}`,
        cwd: root,
        args: step.args,
        environment,
        scope: {
          kind: "browser",
          files: [...files].sort(),
          projects: projects.length ? projects : ["desktop"],
        },
      };
      // runTestPlan re-merges explicit step.env at native launch. Such an
      // override must remain literal in both owners, not be stripped then
      // silently restored after fingerprinting. Only inherited tracing goes.
      const prepared = prepareLocalVerificationTaskEnvironment(
        task,
        !Object.hasOwn(step.env ?? {}, "CODEX_TOOL_CALL_ID"),
      );
      const result = await cache.run({ ...task, environment: prepared }, signal, () =>
        execute([step], { signal, cwd: root, environment: prepared }),
      );
      process.stdout.write(`${step.name}: ${result.message}\n`);
    } else await run();
    if (signal.aborted) throw new Error("Local browser qualification cancelled after close.");
  }
}
