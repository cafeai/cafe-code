import {
  LocalVerificationCacheError,
  type LocalVerificationCache,
} from "./local-verification-cache.ts";
import type { LocalVerificationTask } from "./local-verification-cache-contract.ts";

export function eligibleForLocalVerificationReuse(task: LocalVerificationTask): boolean {
  switch (task.scope.kind) {
    case "node":
      return task.scope.workspace === "apps/server";
    case "typecheck":
      return (
        task.scope.workspace === "packages/effect-codex-app-server" ||
        task.scope.workspace === "apps/server"
      );
    case "browser":
      return (
        task.id === "browser:Desktop and touch features" ||
        task.id === "browser:Mermaid security" ||
        task.id === "browser:Mermaid families"
      );
  }
}

/** Fingerprint admission has a real cost. Only these reviewed expensive local
 * lanes amortize it; this fixed policy never guesses from elapsed time, skips a
 * task, or changes native execution limits. Unknown future lanes run fresh.
 * The underlying coordinator still owns every cryptographic/input/close proof
 * for eligible work, without a second or weaker receipt implementation here. */
export function withLocalVerificationReusePolicy(
  cache: LocalVerificationCache,
): LocalVerificationCache {
  const assertActive = (signal: AbortSignal) => {
    // Abort reasons are opaque, including on the fresh bypass path.
    if (signal.aborted) throw new LocalVerificationCacheError("cancelled");
  };
  return {
    async run(task, signal, execute, observe) {
      assertActive(signal);
      if (eligibleForLocalVerificationReuse(task)) {
        const result = await cache.run(task, signal, execute, observe);
        assertActive(signal);
        return result;
      }
      // This is a cache bypass, not a test-selection rule. Resolving only after
      // the original callback preserves its exact native close/cleanup owner;
      // original failures propagate unchanged and no receipt APIs are entered.
      await execute();
      assertActive(signal);
      return {
        status: "fresh",
        message: "Freshly executed; this lane bypasses local result reuse.",
      };
    },
  };
}
