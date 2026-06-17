import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

export const LEGACY_SAVED_ENVIRONMENTS_FILE_NAME = "saved-environments.json";

export function resolveLegacySavedEnvironmentRegistryPath(input: {
  readonly path: Path.Path;
  readonly stateDir: string;
}): string {
  return input.path.join(input.stateDir, LEGACY_SAVED_ENVIRONMENTS_FILE_NAME);
}

export const removeLegacySavedEnvironmentRegistry = Effect.fn(
  "desktop.legacySavedEnvironmentCleanup.removeRegistry",
)(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly registryPath: string;
}): Effect.fn.Return<void> {
  yield* input.fileSystem.remove(input.registryPath, { force: true }).pipe(Effect.ignore);
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* removeLegacySavedEnvironmentRegistry({
      fileSystem,
      registryPath: resolveLegacySavedEnvironmentRegistryPath({
        path,
        stateDir: environment.stateDir,
      }),
    });
  }),
);
