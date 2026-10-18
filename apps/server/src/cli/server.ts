import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig, type StartupPresentation } from "../config.ts";
import { runServer } from "../server.ts";
import { acquireBackendProfileGuard, BackendProfileGuardError } from "../backendProfileGuard.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    const program = runServer.pipe(Effect.provideService(ServerConfig, config));
    if (config.dataProfile === undefined) return yield* program;
    // The backend role's OS-held lock outlives all runServer layers/finalizers.
    // A crashed desktop's surviving backend keeps it; a new desktop cannot
    // create a competing writer just by selecting a different available port.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              acquireBackendProfileGuard({
                dataProfile: config.dataProfile!,
                configuredBaseDir: config.configuredBaseDir,
                baseDir: config.baseDir,
                stateDir: config.stateDir,
              }),
            catch: () => new BackendProfileGuardError(),
          }),
          (guard) =>
            Effect.promise(() => guard.close()).pipe(
              Effect.catchCause(() =>
                Effect.logError(
                  "Backend ownership release was inconclusive; native descriptors were preserved until process exit.",
                ),
              ),
            ),
        );
        return yield* program;
      }),
    );
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the Cafe Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the Cafe Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
