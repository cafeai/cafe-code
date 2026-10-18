// @effect-diagnostics nodeBuiltinImport:off
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { BackendProfileGuardError } from "../backendProfileGuard.ts";
import { backendStartupTeardown } from "../backendStartupTeardown.ts";
import { DataProfileSelectionError } from "../cli/config.ts";

// This executable owns only a synthetic scoped effect and its stdout. It never
// launches the server, opens application data, or constructs a provider.
const scenario = process.argv[2];
const receipt = (value: string) =>
  Effect.callback<void>((resume) => {
    process.stdout.write(`${value}\n`, (error) =>
      resume(error ? Effect.die(new Error("Synthetic receipt failed.")) : Effect.void),
    );
  });
const finalize = Effect.callback<void>((resume) => {
  // A real asynchronous finalizer cannot be mistaken for callback invocation.
  // Complete its bounded native write before the root Exit reaches teardown.
  setImmediate(() => {
    process.stdout.write("finalized\n", (error) =>
      resume(error ? Effect.die(new Error("Synthetic finalizer failed.")) : Effect.void),
    );
  });
});
const failure = (() => {
  switch (scenario) {
    case "guard":
    case "finalizer-defect":
      return Effect.fail(new BackendProfileGuardError());
    case "profile":
      return Effect.fail(new DataProfileSelectionError({ message: "Synthetic profile refusal." }));
    case "ordinary":
      return Effect.fail(new Error("Synthetic ordinary failure."));
    case "mixed":
      return Effect.failCause(
        Cause.combine(
          Cause.fail(new BackendProfileGuardError()),
          Cause.die(new Error("Synthetic unrelated defect.")),
        ),
      );
    case "interrupt":
      return Effect.interrupt;
    case "success":
      return Effect.void;
    default:
      return Effect.die(new Error("Unknown synthetic teardown scenario."));
  }
})();
const program = Effect.scoped(
  Effect.gen(function* () {
    yield* Effect.acquireRelease(receipt("acquired"), () =>
      scenario === "finalizer-defect"
        ? finalize.pipe(Effect.andThen(Effect.die(new Error("Synthetic cleanup defect."))))
        : finalize,
    );
    return yield* failure;
  }),
);
NodeRuntime.runMain(program, {
  disableErrorReporting: true,
  teardown: backendStartupTeardown,
});
