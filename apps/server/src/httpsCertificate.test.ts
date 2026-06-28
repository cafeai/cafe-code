import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensureHttpsCertificateMaterial, resolveOpenSslExecutable } from "./httpsCertificate.ts";

it.layer(NodeServices.layer)("ensureHttpsCertificateMaterial", (it) => {
  it.effect("resolves Git for Windows OpenSSL when it is installed outside PATH", () =>
    Effect.promise(async () => {
      const expected = "C:\\Program Files\\Git\\usr\\bin\\openssl.exe";
      const executable = await resolveOpenSslExecutable({
        platform: "win32",
        env: {
          PATH: "C:\\Program Files\\Git\\cmd",
          ProgramFiles: "C:\\Program Files",
        },
        access: async (path) => {
          if (path !== expected) {
            throw new Error(`missing ${path}`);
          }
        },
      });

      assert.equal(executable, expected);
    }),
  );

  it.effect("keeps PATH-based OpenSSL resolution on non-Windows platforms", () =>
    Effect.promise(async () => {
      let checkedFilesystem = false;
      const executable = await resolveOpenSslExecutable({
        platform: "linux",
        access: async () => {
          checkedFilesystem = true;
        },
      });

      assert.equal(executable, "openssl");
      assert.equal(checkedFilesystem, false);
    }),
  );

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
