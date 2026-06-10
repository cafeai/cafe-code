// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { execFile } from "node:child_process";
import { X509Certificate, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ServerConfigShape } from "./config.ts";
import { isWildcardHost } from "./startupAccess.ts";

const execFileAsync = promisify(execFile);
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

const certificateIsFresh = async (certPath: string, keyPath: string): Promise<boolean> => {
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
    return Number.isFinite(validToMs) && validToMs > Date.now() + CERT_RENEWAL_WINDOW_MS;
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

  try {
    await execFileAsync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        String(CERT_VALID_DAYS),
        "-nodes",
        "-subj",
        "/CN=Cafe Code Local HTTPS",
        "-addext",
        `subjectAltName=${collectSubjectAltNames(input.host)}`,
        "-keyout",
        tempKeyPath,
        "-out",
        tempCertPath,
      ],
      { timeout: 20_000 },
    );

    await fs.chmod(tempKeyPath, 0o600);
    await fs.chmod(tempCertPath, 0o644);
    await fs.rename(tempKeyPath, input.keyPath);
    await fs.rename(tempCertPath, input.certPath);
  } finally {
    await Promise.all([
      fs.rm(tempCertPath, { force: true }).catch(() => undefined),
      fs.rm(tempKeyPath, { force: true }).catch(() => undefined),
    ]);
  }
};

export const ensureHttpsCertificateMaterial = (
  config: Pick<ServerConfigShape, "host" | "httpsCertPath" | "httpsKeyPath">,
): Effect.Effect<HttpsCertificateMaterial, HttpsCertificateError> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await certificateIsFresh(config.httpsCertPath, config.httpsKeyPath))) {
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
