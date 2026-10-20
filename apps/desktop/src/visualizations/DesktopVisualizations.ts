import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join } from "node:path";

import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { DesktopVisualizationHost } from "./DesktopVisualizationHost.ts";
import { registerVisualizationDiagnostics } from "./visualizationDiagnostics.ts";

export class DesktopVisualizations extends Context.Service<
  DesktopVisualizations,
  DesktopVisualizationHost
>()("cafecode/desktop/Visualizations") {}

/** Dormant construction only. Primary app startup publishes the broker after its lock. */
export const layer = Layer.effect(
  DesktopVisualizations,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const host = new DesktopVisualizationHost({
      stateDirectory: environment.stateDir,
      preloadPath: join(dirname(environment.preloadPath), "visualizationPreload.cjs"),
    });
    const unregister = registerVisualizationDiagnostics(() => host.diagnostics());
    yield* Effect.addFinalizer(() => Effect.sync(unregister));
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => host.close()).pipe(
        Effect.catchCause(() =>
          Effect.logWarning("Visualization host retirement remains uncertain."),
        ),
      ),
    );
    return host;
  }),
);
