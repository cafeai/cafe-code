// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { execFile } from "node:child_process";
import { X509Certificate, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, win32 as win32Path } from "node:path";
import { promisify } from "node:util";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { ServerConfigShape } from "./config.ts";
import { isWildcardHost } from "./startupAccess.ts";

const execFileAsync = promisify(execFile);
const CERT_VALID_DAYS = 397;
const CERT_RENEWAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const OPENSSL_EXECUTABLE_NAME = "openssl";
const OPENSSL_GENERATION_TIMEOUT_MS = 20_000;
const WINDOWS_OPENSSL_GENERATION_TIMEOUT_MS = 60_000;

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

interface ResolveOpenSslExecutableOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly access?: (path: string) => Promise<void>;
}

const windowsOpenSslCandidates = (env: NodeJS.ProcessEnv): readonly string[] => {
  const candidates = new Set<string>();
  const addGitCandidates = (root: string | undefined) => {
    if (!root) {
      return;
    }

    candidates.add(win32Path.join(root, "Git", "usr", "bin", "openssl.exe"));
    candidates.add(win32Path.join(root, "Git", "mingw64", "bin", "openssl.exe"));
  };

  addGitCandidates(env.ProgramFiles);
  addGitCandidates(env.ProgramW6432);
  addGitCandidates(env["ProgramFiles(x86)"]);
  if (env.LocalAppData) {
    addGitCandidates(win32Path.join(env.LocalAppData, "Programs"));
  }

  candidates.add("C:\\Program Files\\Git\\usr\\bin\\openssl.exe");
  candidates.add("C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe");
  candidates.add("C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe");
  candidates.add("C:\\Program Files (x86)\\Git\\mingw64\\bin\\openssl.exe");
  candidates.add("C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe");
  candidates.add("C:\\Program Files\\OpenSSL-Win32\\bin\\openssl.exe");
  candidates.add("C:\\msys64\\usr\\bin\\openssl.exe");
  candidates.add("C:\\msys64\\mingw64\\bin\\openssl.exe");
  candidates.add("C:\\Strawberry\\c\\bin\\openssl.exe");

  return [...candidates];
};

export const resolveOpenSslExecutable = async (
  options: ResolveOpenSslExecutableOptions = {},
): Promise<string> => {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return OPENSSL_EXECUTABLE_NAME;
  }

  const access = options.access ?? fs.access;
  for (const candidate of windowsOpenSslCandidates(options.env ?? process.env)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking; the final fallback preserves PATH-based behavior.
    }
  }

  return OPENSSL_EXECUTABLE_NAME;
};

export const openSslGenerationTimeoutMs = (platform: NodeJS.Platform = process.platform): number =>
  platform === "win32" ? WINDOWS_OPENSSL_GENERATION_TIMEOUT_MS : OPENSSL_GENERATION_TIMEOUT_MS;

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
    const opensslExecutable = await resolveOpenSslExecutable();
    await execFileAsync(
      opensslExecutable,
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
      // Git for Windows OpenSSL can be substantially slower under parallel CI load.
      { timeout: openSslGenerationTimeoutMs() },
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
