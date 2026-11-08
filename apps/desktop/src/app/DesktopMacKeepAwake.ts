import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { MacKeepAwakeState } from "@cafecode/contracts";
import { MacKeepAwakeController, type MacBackendPowerOwner } from "./MacKeepAwakeController.ts";
import { startMacPowerLease } from "./MacKeepAwakeNative.ts";
import { DesktopEnvironment } from "./DesktopEnvironment.ts";

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
      start: (input) => startMacPowerLease(candidates, input),
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
