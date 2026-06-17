import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  removeLegacySavedEnvironmentRegistry,
  resolveLegacySavedEnvironmentRegistryPath,
} from "./DesktopLegacySavedEnvironmentCleanup.ts";

const runCleanupCase = <A, E, R>(
  effect: Effect.Effect<A, E, R | FileSystem.FileSystem | Path.Path>,
) => effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopLegacySavedEnvironmentCleanup", () => {
  it.effect("removes a legacy saved environment file", () =>
    runCleanupCase(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafecode-legacy-saved-env-cleanup-",
        });
        const registryPath = resolveLegacySavedEnvironmentRegistryPath({ path, stateDir });
        yield* fileSystem.writeFileString(
          registryPath,
          [
            "{",
            '  "version": 1,',
            '  "records": [',
            "    {",
            '      "environmentId": "environment-1",',
            '      "encryptedBearerToken": "secret-token-container"',
            "    }",
            "  ]",
            "}",
          ].join("\n"),
        );

        yield* removeLegacySavedEnvironmentRegistry({ fileSystem, registryPath });

        assert.isFalse(yield* fileSystem.exists(registryPath));
      }),
    ),
  );

  it.effect("removes malformed legacy files without parsing them", () =>
    runCleanupCase(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafecode-legacy-saved-env-cleanup-",
        });
        const registryPath = resolveLegacySavedEnvironmentRegistryPath({ path, stateDir });
        yield* fileSystem.writeFileString(registryPath, "{not-json");

        yield* removeLegacySavedEnvironmentRegistry({ fileSystem, registryPath });

        assert.isFalse(yield* fileSystem.exists(registryPath));
      }),
    ),
  );

  it.effect("is idempotent when the legacy file is absent", () =>
    runCleanupCase(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "cafecode-legacy-saved-env-cleanup-",
        });
        const registryPath = resolveLegacySavedEnvironmentRegistryPath({ path, stateDir });

        yield* removeLegacySavedEnvironmentRegistry({ fileSystem, registryPath });
        yield* removeLegacySavedEnvironmentRegistry({ fileSystem, registryPath });

        assert.isFalse(yield* fileSystem.exists(registryPath));
      }),
    ),
  );
});
