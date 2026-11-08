import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { MacKeepAwakeState } from "@cafecode/contracts";
import { MacKeepAwakeController, type MacBackendPowerOwner } from "./MacKeepAwakeController.ts";
import { startMacPowerLease } from "./MacKeepAwakeNative.ts";
import { DesktopEnvironment } from "./DesktopEnvironment.ts";
import { DesktopPowerSaveBlocker } from "./DesktopPowerSaveBlocker.ts";

export class DesktopMacKeepAwake extends Context.Service<
  DesktopMacKeepAwake,
  {
    readonly bindBackend: Effect.Effect<MacBackendPowerOwner>;
    readonly snapshot: Effect.Effect<MacKeepAwakeState>;
    readonly setIntent: (enabled: boolean) => Effect.Effect<void>;
  }
>()("cafecode/desktop/MacKeepAwake") {}

export const layer = Layer.effect(
  DesktopMacKeepAwake,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const powerPolicy = yield* DesktopPowerSaveBlocker;
    const runPolicy = Effect.runPromiseWith(yield* Effect.context<never>());
    if (environment.platform !== "darwin")
      return {
        bindBackend: Effect.die(new Error("Closed-lid work is available only on macOS")),
        snapshot: Effect.succeed({ phase: "unavailable", reason: "native-unavailable" } as const),
        setIntent: () => Effect.void,
      };
    const candidates = [
      ...environment.resolveResourcePathCandidates("mac-keep-awake"),
      ...(!environment.isPackaged
        ? [
            environment.path.join(
              environment.rootDir,
              "apps/desktop/native/build",
              environment.processArch,
              "mac-keep-awake",
            ),
          ]
        : []),
    ];
    const controller = new MacKeepAwakeController({
      supported: environment.platform === "darwin",
      start: async (input) => {
        if (!input.current()) return null;
        const display = await runPolicy(powerPolicy.bindClosedLid(input.current));
        if (!input.current()) {
          await display.close();
          return null;
        }
        try {
          const lease = await startMacPowerLease(candidates, { ...input, display });
          if (!lease) {
            await display.close();
            return null;
          }
          return {
            renew: () => lease.renew(),
            close: () => {
              // Retire native input synchronously; restore the ordinary
              // display policy only after this exact helper has closed.
              const closed = lease.close();
              return closed.then(() => display.close());
            },
          };
        } catch (error) {
          await display.close();
          throw error;
        }
      },
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => controller.close()));
    // Scoped Effect timer: native helpers own their independent dead-man timers.
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("1 second");
        controller.tick();
      }
    }).pipe(Effect.forkScoped);
    return {
      bindBackend: Effect.sync(() => controller.bindBackend()),
      snapshot: Effect.sync(() => controller.snapshot()),
      setIntent: (enabled: boolean) => Effect.sync(() => controller.setIntent(enabled)),
    };
  }),
);
