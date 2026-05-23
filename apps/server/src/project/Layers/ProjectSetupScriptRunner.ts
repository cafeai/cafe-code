import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type ProjectSetupScriptRunnerShape,
  ProjectSetupScriptRunner,
} from "../Services/ProjectSetupScriptRunner.ts";

const makeProjectSetupScriptRunner = Effect.succeed({
  runForThread: () =>
    Effect.succeed({
      status: "no-script",
    } as const),
} satisfies ProjectSetupScriptRunnerShape);

export const ProjectSetupScriptRunnerLive = Layer.effect(
  ProjectSetupScriptRunner,
  makeProjectSetupScriptRunner,
);
