// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { X509Certificate, randomUUID, webcrypto } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

import {
  AuthorityKeyIdentifierExtension,
  BasicConstraintsExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  SubjectKeyIdentifierExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ServerConfigShape } from "./config.ts";
import { isWildcardHost } from "./startupAccess.ts";

const CERT_VALID_DAYS = 397;
const CERT_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface HttpsCertificateMaterial {
  readonly cert: string;
  readonly key: string;
}

export class HttpsCertificateError extends Data.TaggedError("HttpsCertificateError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `Failed to ${this.operation} HTTPS certificate material.`;
  }
}

const normalizeHostForSan = (host: string): string => host.replace(/^\[(.*)\]$/, "$1");

const collectLocalInterfaceIps = (): readonly string[] => {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.address && isIP(entry.address) !== 0) {
        addresses.add(normalizeHostForSan(entry.address));
      }
    }
  }
  return [...addresses];
};

const collectSubjectAltNames = (host: string | undefined): string => {
  const names = new Set<string>(["DNS:localhost", "IP:127.0.0.1", "IP:0:0:0:0:0:0:0:1"]);

  if (host && !isWildcardHost(host)) {
    const normalizedHost = normalizeHostForSan(host);
    names.add(isIP(normalizedHost) === 0 ? `DNS:${normalizedHost}` : `IP:${normalizedHost}`);
  }

  for (const address of collectLocalInterfaceIps()) {
    names.add(`IP:${address}`);
  }

  return [...names].join(",");
};

const certificateIsFresh = async (
  certPath: string,
  keyPath: string,
  host: string | undefined,
): Promise<boolean> => {
  try {
    const [certPem, keyPem] = await Promise.all([
      fs.readFile(certPath, "utf8"),
      fs.readFile(keyPath, "utf8"),
    ]);
    if (keyPem.trim().length === 0) {
      return false;
    }

    const certificate = new X509Certificate(certPem);
    const validToMs = Date.parse(certificate.validTo);
    if (!Number.isFinite(validToMs) || validToMs <= Date.now() + CERT_RENEWAL_WINDOW_MS)
      return false;
    // Cafe-generated certificates include the current LAN addresses. DHCP or
    // interface changes must not leave a long-lived certificate bound only to
    // yesterday's address. Keep externally provisioned identities unchanged.
    if (
      certificate.subject === "CN=Cafe Code Local HTTPS" &&
      certificate.issuer === certificate.subject &&
      certificate.verify(certificate.publicKey)
    ) {
      return collectSubjectAltNames(host)
        .split(",")
        .every((name) =>
          name.startsWith("IP:")
            ? Boolean(certificate.checkIP(name.slice(3)))
            : Boolean(certificate.checkHost(name.slice(4), { subject: "never" })),
        );
    }
    return true;
  } catch {
    return false;
  }
};

const readCertificateMaterial = async (
  certPath: string,
  keyPath: string,
): Promise<HttpsCertificateMaterial> => {
  const [cert, key] = await Promise.all([
    fs.readFile(certPath, "utf8"),
    fs.readFile(keyPath, "utf8"),
  ]);
  return { cert, key };
};

const generateCertificate = async (input: {
  readonly certPath: string;
  readonly keyPath: string;
  readonly host: string | undefined;
}): Promise<void> => {
  await fs.mkdir(dirname(input.certPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(dirname(input.keyPath), { recursive: true, mode: 0o700 });
  await fs.chmod(dirname(input.certPath), 0o700);
  await fs.chmod(dirname(input.keyPath), 0o700);

  const suffix = `${process.pid}-${randomUUID()}`;
  const tempCertPath = join(dirname(input.certPath), `server-cert.${suffix}.tmp`);
  const tempKeyPath = join(dirname(input.keyPath), `server-key.${suffix}.tmp`);
  const ownedTempPaths = new Set<string>();
  const writeExclusive = async (path: string, content: string, mode: number) => {
    const file = await fs.open(path, "wx", mode);
    ownedTempPaths.add(path);
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
  };

  try {
    const notBefore = new Date();
    const algorithm = {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    };
    const keys = await webcrypto.subtle.generateKey(algorithm, true, ["sign", "verify"]);
    const certificate = await X509CertificateGenerator.createSelfSigned(
      {
        name: "CN=Cafe Code Local HTTPS",
        notBefore,
        notAfter: new Date(notBefore.getTime() + CERT_VALID_DAYS * 24 * 60 * 60 * 1000),
        signingAlgorithm: algorithm,
        keys,
        extensions: [
          // Preserve the downloadable self-signed trust certificate used by
          // existing clients, including its ability to be installed as a root.
          new BasicConstraintsExtension(true, undefined, true),
          await SubjectKeyIdentifierExtension.create(keys.publicKey, false, webcrypto),
          await AuthorityKeyIdentifierExtension.create(keys.publicKey, false, webcrypto),
          new SubjectAlternativeNameExtension(
            collectSubjectAltNames(input.host)
              .split(",")
              .map((name) =>
                name.startsWith("IP:")
                  ? { type: "ip", value: name.slice(3) }
                  : { type: "dns", value: name.slice(4) },
              ),
          ),
        ],
      },
      webcrypto,
    );
    const privateKey = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);

    await writeExclusive(tempKeyPath, PemConverter.encode(privateKey, "PRIVATE KEY"), 0o600);
    await writeExclusive(tempCertPath, certificate.toString("pem"), 0o644);
    await fs.rename(tempKeyPath, input.keyPath);
    ownedTempPaths.delete(tempKeyPath);
    await fs.rename(tempCertPath, input.certPath);
    ownedTempPaths.delete(tempCertPath);
  } finally {
    await Promise.all(
      [...ownedTempPaths].map((path) => fs.rm(path, { force: true }).catch(() => undefined)),
    );
  }
};

export const ensureHttpsCertificateMaterial = (
  config: Pick<ServerConfigShape, "host" | "httpsCertPath" | "httpsKeyPath">,
): Effect.Effect<HttpsCertificateMaterial, HttpsCertificateError> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await certificateIsFresh(config.httpsCertPath, config.httpsKeyPath, config.host))) {
        await generateCertificate({
          certPath: config.httpsCertPath,
          keyPath: config.httpsKeyPath,
          host: config.host,
        });
      }
      return readCertificateMaterial(config.httpsCertPath, config.httpsKeyPath);
    },
    catch: (cause) => new HttpsCertificateError({ operation: "prepare", cause }),
  });
