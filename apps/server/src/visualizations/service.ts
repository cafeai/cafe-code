import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeVisualizationArtifactService, type VisualizationArtifactService } from "./store.ts";

/** One admission counter belongs to this scoped backend, not each HTTP request. */
export class VisualizationArtifacts extends Context.Service<
  VisualizationArtifacts,
  VisualizationArtifactService
>()("cafecode/VisualizationArtifacts") {}
let current:
  | {
      readonly service: VisualizationArtifactService;
      readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
    }
  | undefined;
/** Native adapter observers use this owner-scoped service, never a renderer
 * injected implementation or a second database/store instance. */
export const readVisualizationArtifactService = () => current;
export const VisualizationArtifactsLive = Layer.effect(
  VisualizationArtifacts,
  Effect.gen(function* () {
    const service = yield* makeVisualizationArtifactService();
    yield* service.sweep;
    const context = yield* Effect.context<never>();
    const installed = { service, run: Effect.runPromiseWith(context) };
    current = installed;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (current === installed) current = undefined;
      }),
    );
    return service;
  }),
);
