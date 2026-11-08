// Canonical root-relative task identities must use the host's path grammar.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { relative } from "node:path";
import {
  launchLocalTypecheckCompiler,
  type LocalCompilerChild,
  type LocalCompilerExit,
  type LocalCompilerLaunch,
} from "./local-typecheck.ts";
import type { LocalVerificationCache } from "./local-verification-cache.ts";
import type { LocalVerificationTask } from "./local-verification-cache-contract.ts";
import { prepareLocalVerificationTaskEnvironment } from "./local-verification-environment.ts";
import { retireLocalTypecheckMetadata } from "./local-typecheck-metadata.ts";

/** Wrap admission rather than replacing the complete diagnostic queue. A cache
 * lookup occupies the same finite slot as its compiler, and the queue's exact
 * held cancellation owner fences lookup, native launch and publication alike.
 * Ordinary compiler failures retain their native status and do not suppress
 * the other discovered programs. */
export function cachedLocalTypecheckLaunch(
  root: string,
  cache: LocalVerificationCache | undefined,
  launch: LocalCompilerLaunch = launchLocalTypecheckCompiler,
  retireMetadata = retireLocalTypecheckMetadata,
): LocalCompilerLaunch {
  // Explicit fresh local runs still retire recognized semantic metadata. This
  // lane neither consults nor publishes result receipts; native close remains
  // owned by the same callback below. Canonical/Windows launchers are unchanged.
  const verifier: LocalVerificationCache = cache ?? {
    async run(_task, signal, execute) {
      if (signal.aborted) throw new Error("Local compiler admission cancelled.");
      await execute();
      if (signal.aborted) throw new Error("Local compiler admission cancelled.");
      return {
        status: "fresh",
        message: "Freshly executed; result reuse is disabled or unavailable.",
      };
    },
  };
  return (program) => {
    const controller = new AbortController();
    let native: LocalCompilerChild | undefined;
    let actual: LocalCompilerExit | undefined;
    let nativeUncertain = false;
    const terminate = () => {
      controller.abort();
      try {
        native?.terminate();
      } catch (error) {
        nativeUncertain = true;
        throw error;
      }
    };
    const task: LocalVerificationTask = {
      id: `typecheck:${program.name}`,
      cwd: program.cwd,
      args: [process.execPath, program.compiler, "--noEmit"],
      environment: Object.freeze({
        ...process.env,
        NODE_OPTIONS: "--max-old-space-size=4096",
      }),
      scope: {
        kind: "typecheck",
        workspace: relative(root, program.cwd).replaceAll("\\", "/"),
        compiler: program.compiler,
      },
    };
    // Fingerprint and native launch share this exact frozen child environment.
    // Disabled/unknown/unsupported lanes keep the original environment object.
    const environment = prepareLocalVerificationTaskEnvironment(task, cache !== undefined);
    const closed = verifier
      .run(
        {
          ...task,
          environment,
        },
        controller.signal,
        async () => {
          if (controller.signal.aborted) throw new Error("Local compiler admission cancelled.");
          await retireMetadata(program);
          if (controller.signal.aborted) throw new Error("Local compiler admission cancelled.");
          try {
            native = launch(program, environment);
          } catch (error) {
            nativeUncertain = true;
            throw error;
          }
          if (controller.signal.aborted) {
            try {
              native.terminate();
            } catch {
              // A failed retirement request does not release our exact child
              // owner. Join close before reporting the transport uncertainty.
              nativeUncertain = true;
            }
          }
          try {
            actual = await native.closed;
          } catch (error) {
            nativeUncertain = true;
            throw error;
          }
          if (
            nativeUncertain ||
            actual.code !== 0 ||
            actual.signal !== null ||
            actual.transportError
          )
            throw new Error("Local compiler did not complete successfully.");
        },
      )
      .then((result) => {
        process.stdout.write(`Typechecking ${program.name}: ${result.message}\n`);
        return actual ?? { code: 0, signal: null, transportError: false };
      })
      .catch((): LocalCompilerExit => {
        // An input-drift/cache-admission failure must not turn a real zero
        // compiler exit into success. Preserve nonzero native diagnostics.
        if (
          actual &&
          !nativeUncertain &&
          (actual.code !== 0 || actual.signal !== null || actual.transportError)
        )
          return actual;
        process.stderr.write(
          `Typechecking ${program.name}: qualification incomplete; no cache result accepted.\n`,
        );
        return {
          code: actual?.code && actual.code !== 0 ? actual.code : 1,
          signal: actual?.signal ?? null,
          transportError: nativeUncertain,
        };
      });
    return { closed, terminate };
  };
}
