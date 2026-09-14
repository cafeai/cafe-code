import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { DesktopManager } from "./DesktopManager.ts";
import { installDesktopSessionBroker } from "./sessionBroker.ts";
import { makeDesktopStore } from "./store.ts";
import { makeDesktopObservationStore } from "./observationStore.ts";

let manager: DesktopManager | undefined;
export const readDesktopManager = () => manager;

export const DesktopRuntimeLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    // The detached daemon is the sole owner when present. Supervisor deployments
    // advertise unsupported until that separate ownership mode is qualified.
    if (process.platform !== "linux" || config.providerDaemon || config.providerSupervisor) return;
    const settings = yield* ServerSettingsService;
    const policy = yield* settings.getSettings;
    const observations = yield* makeDesktopObservationStore(config.stateDir);
    yield* Effect.tryPromise(() =>
      observations.setRetention(policy.desktopObservationRetention, true),
    ).pipe(
      Effect.catch(() =>
        Effect.logWarning("Desktop observation cleanup deferred; maintenance will retry."),
      ),
    );
    // Only this owner collects retired files. Readers never recover pending
    // writes. Bounded sweeps also collect hard-deleted threads without waiting
    // for the next tool call or restarting the desktop runtime.
    const cleanupTimer = setInterval(() => {
      void observations.sweep().catch(() => undefined);
    }, 30_000);
    cleanupTimer.unref();
    const runtime = new DesktopManager({
      stateDir: config.stateDir,
      mcpPort: config.cafeMcpPort ?? config.port,
      store: yield* makeDesktopStore,
      observations,
      policy,
    });
    manager = runtime;
    const uninstall = installDesktopSessionBroker(runtime);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        uninstall();
        clearInterval(cleanupTimer);
        if (manager === runtime) manager = undefined;
        await runtime.close();
        await observations.close();
      }),
    );
    yield* settings.streamChanges.pipe(
      Stream.runForEach((value) => Effect.promise(() => runtime.setPolicy(value))),
      Effect.forkScoped,
    );
  }),
);
