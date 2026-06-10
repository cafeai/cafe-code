import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensureHttpsCertificateMaterial } from "./httpsCertificate.ts";

it.layer(NodeServices.layer)("ensureHttpsCertificateMaterial", (it) => {
  it.effect("generates and reuses self-signed certificate material", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-https-certificate-test-",
      });
      const config = {
        host: "127.0.0.1",
        httpsCertPath: path.join(baseDir, "server-cert.pem"),
        httpsKeyPath: path.join(baseDir, "server-key.pem"),
      };

      const first = yield* ensureHttpsCertificateMaterial(config);
      const second = yield* ensureHttpsCertificateMaterial(config);

      assert.match(first.cert, /BEGIN CERTIFICATE/);
      assert.match(first.key, /BEGIN (?:RSA )?PRIVATE KEY/);
      assert.equal(second.cert, first.cert);
      assert.equal(second.key, first.key);
    }).pipe(Effect.scoped),
  );
});
