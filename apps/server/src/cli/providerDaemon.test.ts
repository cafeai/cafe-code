import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { resolveProviderDaemonServerConfig } from "./providerDaemon.ts";

it.effect("admits daemon migration progress only from its explicit private bootstrap field", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-daemon-config-" });
      const bootstrap = {
        mode: "provider-daemon" as const,
        cafeCodeHome: baseDir,
        token: "synthetic-bootstrap-token-000000000000000000000000",
      };
      const without = yield* resolveProviderDaemonServerConfig({
        bootstrap,
        logLevel: "Info",
        runtimeRole: "provider-daemon",
      });
      assert.isUndefined(without.startupProgressFd);
      const admitted = yield* resolveProviderDaemonServerConfig({
        bootstrap: { ...bootstrap, startupProgressFd: 4 },
        logLevel: "Info",
        runtimeRole: "provider-daemon",
      });
      assert.equal(admitted.startupProgressFd, 4);
      // The progress field never changes capability delivery or ordinary runtime
      // paths; no database, providers, profiles or credentials are opened here.
      assert.equal(admitted.dbPath, without.dbPath);
      assert.equal(admitted.providerDaemon, undefined);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
