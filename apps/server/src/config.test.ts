import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { deriveServerPaths, ensureServerDirectories } from "./config.ts";

it.effect("removes the legacy anonymous analytics identifier without reading it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cafe-code-config-test-",
      });
      const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
      const legacyAnonymousIdPath = path.join(derivedPaths.stateDir, "anonymous-id");

      yield* fileSystem.makeDirectory(derivedPaths.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(legacyAnonymousIdPath, "legacy-stable-id");
      yield* ensureServerDirectories(derivedPaths);

      assert.isFalse(yield* fileSystem.exists(legacyAnonymousIdPath));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
