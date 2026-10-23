// Exact native script/cache paths are structured child arguments, not IO services.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import { nodeTestPlan, testRepositoryRoot, type TestStep } from "./test-run-plan.ts";

export interface LocalVerificationOptions {
  readonly typecheckConcurrency: 1 | 2 | 3;
  readonly testConcurrency: 1 | 2 | 3;
  readonly fresh?: boolean;
}

/** Keep the local opt-in separate from selection or skipping. In particular,
 * duplicate options cannot silently override a previously reviewed limit. */
export function parseLocalVerificationArguments(args: readonly string[]): LocalVerificationOptions {
  let typecheckConcurrency: 1 | 2 | 3 = 3;
  let testConcurrency: 1 | 2 | 3 = 2;
  let hasTypecheckOption = false;
  let hasTestOption = false;
  let fresh = false;
  for (const arg of args) {
    if (arg === "--fresh" && !fresh) {
      fresh = true;
      continue;
    }
    if (
      !hasTypecheckOption &&
      (arg === "--typecheck-concurrency=1" ||
        arg === "--typecheck-concurrency=2" ||
        arg === "--typecheck-concurrency=3")
    ) {
      typecheckConcurrency =
        arg === "--typecheck-concurrency=1" ? 1 : arg === "--typecheck-concurrency=2" ? 2 : 3;
      hasTypecheckOption = true;
      continue;
    }
    if (
      !hasTestOption &&
      (arg === "--test-concurrency=1" ||
        arg === "--test-concurrency=2" ||
        arg === "--test-concurrency=3")
    ) {
      testConcurrency = arg === "--test-concurrency=1" ? 1 : arg === "--test-concurrency=2" ? 2 : 3;
      hasTestOption = true;
      continue;
    }
    throw new Error(
      "Complete local verification accepts --fresh, --typecheck-concurrency=1, =2 or =3 and --test-concurrency=1, =2 or =3 once each; selection and skip arguments are not supported.",
    );
  }
  return { typecheckConcurrency, testConcurrency, ...(fresh ? { fresh: true } : {}) };
}

/** Complete local qualification: each required task is either freshly executed
 * or reuses an authenticated prior success for its exact reviewed inputs.
 * Typechecking defaults to three workspaces, and the Node graph defaults to two.
 * Explicit local limits do not change each Vitest owner's worker policy or
 * server file isolation. Children inherit the caller's low priority.
 * Native browser contexts retain their separate sequential owners.
 * The forced desktop build is deliberately last, even on a warm checkout. */
export function localVerificationPlan(
  options: LocalVerificationOptions = { typecheckConcurrency: 3, testConcurrency: 2 },
  platform: NodeJS.Platform = process.platform,
): readonly TestStep[] {
  const typecheckConcurrency = options.typecheckConcurrency;
  const testConcurrency = options.testConcurrency;
  if (typecheckConcurrency !== 1 && typecheckConcurrency !== 2 && typecheckConcurrency !== 3)
    throw new Error("Local typecheck concurrency must be exactly 1, 2 or 3.");
  if (testConcurrency !== 1 && testConcurrency !== 2 && testConcurrency !== 3)
    throw new Error("Local test concurrency must be exactly 1, 2 or 3.");
  const reuse = options.fresh ? [] : ["--reuse-local-results"];
  const nodes = nodeTestPlan(platform, { concurrency: testConcurrency });
  return [
    { name: "Formatting", args: ["fmt:check"] },
    { name: "Lint and interface-language validation", args: ["lint"] },
    { name: "Repository audit", args: ["audit:repository"] },
    {
      name: "Qualify actual Effect compiler diagnostics",
      args: ["exec", "node", resolve(import.meta.dirname, "../qualify-effect-compiler.ts")],
    },
    {
      name: "Complete typechecking",
      args: [
        "exec",
        "node",
        resolve(import.meta.dirname, "../typecheck-local.ts"),
        `--concurrency=${typecheckConcurrency}`,
        ...reuse,
      ],
      // Use the already qualified compiler ceiling only for this step, never
      // leak it into tests, browser processes, build outputs or the shipped app.
      env: { NODE_OPTIONS: "--max-old-space-size=4096" },
    },
    ...(options.fresh
      ? nodes
      : nodes.map((step, index) => ({
          name: step.name,
          args: [
            "exec",
            "node",
            resolve(import.meta.dirname, "../node-tests-local.ts"),
            index === 0 ? "--phase=main" : "--phase=codex-tail",
            `--concurrency=${index === 0 ? testConcurrency : 1}`,
            ...reuse,
          ],
        }))),
    { name: "Complete native browser qualification", args: ["test:browser:local", ...reuse] },
    {
      name: "Forced desktop build (last)",
      args: ["build:desktop", "--force", "--concurrency=1"],
      // This is reusable compression INPUT, not a build/test-result cache.
      // The compressor validates both representations against the current raw
      // bytes and falls back to normal compression if admission is uncertain.
      env: {
        CAFE_CODE_ASSET_COMPRESSION_CACHE: resolve(
          testRepositoryRoot,
          ".logs/local-asset-compression",
        ),
      },
    },
  ];
}
