import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { createPrivateKey, webcrypto, X509Certificate } from "node:crypto";
import {
  AuthorityKeyIdentifierExtension,
  PemConverter,
  SubjectKeyIdentifierExtension,
  X509Certificate as ParsedCertificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { afterEach, vi } from "vitest";

const interfaces = vi.hoisted(() => vi.fn());
const externalCommand = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Certificate generation must not invoke an external command");
  }),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  exec: externalCommand,
  execFile: externalCommand,
  spawn: externalCommand,
  execSync: externalCommand,
  execFileSync: externalCommand,
  spawnSync: externalCommand,
}));
vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    networkInterfaces: () =>
      interfaces.getMockImplementation() ? interfaces() : original.networkInterfaces(),
  };
});
afterEach(() => {
  interfaces.mockReset();
  externalCommand.mockClear();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

import { ensureHttpsCertificateMaterial } from "./httpsCertificate.ts";

it.layer(NodeServices.layer)("ensureHttpsCertificateMaterial", (it) => {
  it.effect(
    "refreshes a Cafe-generated certificate after the LAN address changes, then reuses it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "cafe-dhcp-certificate-test-",
        });
        const config = {
          host: "0.0.0.0",
          httpsCertPath: path.join(baseDir, "server-cert.pem"),
          httpsKeyPath: path.join(baseDir, "server-key.pem"),
        };
        interfaces.mockReturnValue({ lan: [{ address: "10.0.0.187" }] });
        const first = yield* ensureHttpsCertificateMaterial(config);
        assert.ok(new X509Certificate(first.cert).checkIP("10.0.0.187"));
        assert.equal(new X509Certificate(first.cert).checkIP("10.0.0.108"), undefined);
        interfaces.mockReturnValue({ lan: [{ address: "10.0.0.108" }] });
        const changed = yield* ensureHttpsCertificateMaterial(config);
        assert.notEqual(changed.cert, first.cert);
        assert.ok(new X509Certificate(changed.cert).checkIP("10.0.0.108"));
        const reused = yield* ensureHttpsCertificateMaterial(config);
        assert.equal(reused.cert, changed.cert);
        assert.equal(reused.key, changed.key);
      }).pipe(Effect.scoped),
  );
  it.effect("renews within thirty days of expiry while retaining a fresh certificate", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-tls-renewal-" });
      const config = {
        host: "127.0.0.1",
        httpsCertPath: path.join(baseDir, "cert.pem"),
        httpsKeyPath: path.join(baseDir, "key.pem"),
      };
      const first = yield* ensureHttpsCertificateMaterial(config);
      const expiry = Date.parse(new X509Certificate(first.cert).validTo);
      vi.setSystemTime(expiry - 31 * 24 * 60 * 60 * 1000);
      assert.deepEqual(yield* ensureHttpsCertificateMaterial(config), first);
      vi.setSystemTime(expiry - 29 * 24 * 60 * 60 * 1000);
      const renewed = yield* ensureHttpsCertificateMaterial(config);
      assert.notEqual(renewed.cert, first.cert);
      assert.notEqual(renewed.key, first.key);
      assert.ok(new X509Certificate(renewed.cert).checkPrivateKey(createPrivateKey(renewed.key)));
      assert.deepEqual(yield* ensureHttpsCertificateMaterial(config), renewed);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves valid externally provisioned certificate identity across LAN changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cafe-tls-custom-" });
      const config = {
        host: "0.0.0.0",
        httpsCertPath: path.join(baseDir, "cert.pem"),
        httpsKeyPath: path.join(baseDir, "key.pem"),
      };
      const material = yield* Effect.promise(async () => {
        const keys = await webcrypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign", "verify"],
        );
        const certificate = await X509CertificateGenerator.createSelfSigned(
          {
            name: "CN=Custom local certificate",
            keys,
            signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
          },
          webcrypto,
        );
        return {
          cert: certificate.toString("pem"),
          key: PemConverter.encode(
            await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
            "PRIVATE KEY",
          ),
        };
      });
      yield* fs.writeFileString(config.httpsCertPath, material.cert);
      yield* fs.writeFileString(config.httpsKeyPath, material.key);
      interfaces.mockReturnValue({ lan: [{ address: "10.0.0.108" }] });
      assert.deepEqual(yield* ensureHttpsCertificateMaterial(config), material);
    }).pipe(Effect.scoped),
  );

  it.effect("generates reusable, private certificates without PATH or external tools", () =>
    Effect.gen(function* () {
      vi.stubEnv("PATH", "");
      interfaces.mockReturnValue({ lan: [{ address: "10.0.0.187" }] });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-https-certificate-test-",
      });
      const config = {
        host: "cafe.example.test",
        httpsCertPath: path.join(baseDir, "server-cert.pem"),
        httpsKeyPath: path.join(baseDir, "server-key.pem"),
      };

      const first = yield* ensureHttpsCertificateMaterial(config);
      const second = yield* ensureHttpsCertificateMaterial(config);

      assert.match(first.cert, /BEGIN CERTIFICATE/);
      assert.match(first.key, /BEGIN (?:RSA )?PRIVATE KEY/);
      assert.equal(second.cert, first.cert);
      assert.equal(second.key, first.key);
      const certificate = new X509Certificate(first.cert);
      const key = createPrivateKey(first.key);
      assert.equal(certificate.subject, "CN=Cafe Code Local HTTPS");
      assert.equal(certificate.issuer, certificate.subject);
      assert.equal(certificate.ca, true);
      const parsed = new ParsedCertificate(first.cert);
      const subjectKeyId = parsed.getExtension(SubjectKeyIdentifierExtension)?.keyId;
      assert.ok(subjectKeyId);
      assert.equal(parsed.getExtension(AuthorityKeyIdentifierExtension)?.keyId, subjectKeyId);
      assert.ok(certificate.verify(certificate.publicKey));
      assert.ok(certificate.checkPrivateKey(key));
      assert.equal(key.asymmetricKeyType, "rsa");
      assert.equal(key.asymmetricKeyDetails?.modulusLength, 2048);
      assert.equal(
        Date.parse(certificate.validTo) - Date.parse(certificate.validFrom),
        397 * 24 * 60 * 60 * 1000,
      );
      assert.ok(certificate.checkHost("localhost", { subject: "never" }));
      assert.ok(certificate.checkHost(config.host, { subject: "never" }));
      assert.ok(certificate.checkIP("127.0.0.1"));
      assert.ok(certificate.checkIP("::1"));
      assert.ok(certificate.checkIP("10.0.0.187"));
      assert.equal(certificate.checkIP("10.0.0.108"), undefined);
      if (process.platform !== "win32") {
        const keyInfo = yield* fs.stat(config.httpsKeyPath);
        assert.equal(keyInfo.mode & 0o777, 0o600);
        const directoryInfo = yield* fs.stat(baseDir);
        assert.equal(directoryInfo.mode & 0o777, 0o700);
      }
      const independent = yield* ensureHttpsCertificateMaterial({
        ...config,
        httpsCertPath: path.join(baseDir, "independent-cert.pem"),
        httpsKeyPath: path.join(baseDir, "independent-key.pem"),
      });
      assert.notEqual(independent.key, first.key);
      assert.notEqual(independent.cert, first.cert);
      assert.equal(externalCommand.mock.calls.length, 0);
    }).pipe(Effect.scoped),
  );
});
