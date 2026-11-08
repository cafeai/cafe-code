// This is an explicitly requested local developer cache, not CI/release authority.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve, join } from "node:path";
// Only the OS's canonical temporary directory is queried, not user profiles.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createLocalVerificationCache } from "./local-verification-cache.ts";
import { createLocalVerificationReceiptStore } from "./local-verification-cache-store.ts";
import { createLocalVerificationFingerprint } from "./local-verification-inputs.ts";
import { withLocalVerificationReusePolicy } from "./local-verification-reuse-policy.ts";
import type {
  LocalVerificationReceiptStore,
  LocalVerificationTask,
} from "./local-verification-cache-contract.ts";

/** Diagnostic labels are a finite operational vocabulary, never received task
 * IDs, paths, argv or environment. Unknown future lanes retain a fixed label. */
function diagnosticLane(task?: LocalVerificationTask): string {
  if (task?.scope.kind === "node" && task.scope.workspace === "apps/server") return "server-node";
  if (task?.scope.kind === "typecheck") {
    if (task.scope.workspace === "apps/server") return "server-types";
    if (task.scope.workspace === "packages/effect-codex-app-server") return "codex-types";
  }
  if (task?.scope.kind === "browser") {
    if (task.id === "browser:Desktop and touch features") return "desktop-touch";
    if (task.id === "browser:Mermaid security") return "mermaid-security";
    if (task.id === "browser:Mermaid families") return "mermaid-families";
  }
  return "other";
}

/** No environment variable enables caching. Only the local coordinator's exact
 * structured argument opts in; hosted environments still execute everything.
 * A platform/namespace that cannot establish private ownership stays fresh. */
export async function openLocalVerificationCache(root: string, requested: boolean) {
  if (!requested || process.platform === "win32" || process.env.CI || process.env.GITHUB_ACTIONS)
    return undefined;
  // A home directory may legitimately be group-writable. Do not chmod it or
  // relax namespace admission just to enable caching. A canonical OS private
  // temp namespace also avoids persisting receipts under a shared checkout;
  // OS cleanup merely makes the next run cold. The canonical checkout identity
  // is still independently part of every task key.
  let store: LocalVerificationReceiptStore | undefined;
  try {
    const temporary = await realpath(tmpdir());
    const owner = createHash("sha256").update(resolve(root)).digest("hex");
    store = await createLocalVerificationReceiptStore(
      join(temporary, `cafe-code-local-verification-${owner}`),
    );
  } catch {
    /* Unavailable private storage is a fresh run, never skipped work. */
  }
  if (!store) {
    process.stdout.write("Local result cache unavailable; running checks fresh.\n");
    return undefined;
  }
  const cache = createLocalVerificationCache({
    store,
    fingerprint: createLocalVerificationFingerprint(root, store, (reason, _detail, task) => {
      // The producer invokes this at most once per snapshot. Discard source
      // detail entirely: ordinary operational logs need only the fixed category.
      process.stdout.write(`Local cache ${diagnosticLane(task)}: input-refused ${reason}.\n`);
    }),
  });
  return withLocalVerificationReusePolicy({
    run(task, signal, execute, observe) {
      return cache.run(task, signal, execute, (diagnostic) => {
        // These are internally constructed finite fields, not an error's raw
        // message/cause. The coordinator bounds and isolates this observation
        // from authority, including stream/observer failures.
        process.stdout.write(
          `Local cache ${diagnosticLane(task)} ${diagnostic.phase}: ${diagnostic.outcome}; key=${diagnostic.key}; fence=${diagnostic.fence}${diagnostic.reason ? `; reason=${diagnostic.reason}` : ""}.\n`,
        );
        observe?.(diagnostic);
      });
    },
  });
}

/** This internal opt-in is deliberately not an arbitrary selector or cache
 * location. Duplicates are refused rather than silently overriding a policy. */
export function localResultCacheArguments(args: readonly string[]) {
  const flags = args.filter((arg) => arg === "--reuse-local-results");
  if (flags.length > 1) throw new Error("Local result-cache option must occur only once.");
  return {
    requested: flags.length === 1,
    remaining: args.filter((arg) => arg !== "--reuse-local-results"),
  };
}
