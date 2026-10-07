import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pinnedRelease from "../native/cua-driver/release.json" with { type: "json" };

const repository = "trycua/cua";
const maxMetadataBytes = 2 * 1024 * 1024;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const targetLabels = {
  "darwin-universal": "darwin-universal",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x86_64",
  "win32-arm64": "windows-arm64",
  "win32-x64": "windows-x86_64",
} as const;
export type CuaReleaseTarget = keyof typeof targetLabels;
export interface CuaReleaseAsset {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface CuaRelease {
  readonly schemaVersion: number;
  readonly version: string;
  readonly tag: string;
  readonly sourceCommit: string;
  readonly repository: string;
  readonly license: string;
  readonly certificateIdentity: string;
  readonly certificateIssuer: string;
  readonly assets: Record<CuaReleaseTarget, CuaReleaseAsset>;
  readonly auditedAt?: string | null;
  readonly reviewRequired?: boolean;
  readonly checksumManifest?: CuaReleaseAsset | null;
}

/** Network policy for future trusted launches, never an agent-settable option.
 * The 0.34.0 embedded SDK drops the update-check override: see the audit before
 * choosing a host launcher. This object does not claim to fix that SDK path. */
export const CUA_LOCAL_ENVIRONMENT = Object.freeze({
  CUA_DRIVER_RS_TELEMETRY_ENABLED: "0",
  CUA_TELEMETRY_ENABLED: "0",
  CUA_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
  CUA_DRIVER_RS_UPDATE_CHECK: "false",
});

function assetName(version: string, target: CuaReleaseTarget): string {
  return `cua-driver-rs-${version}-${targetLabels[target]}-binary.${target.startsWith("win32") ? "zip" : "tar.gz"}`;
}

export function validateCuaRelease(release: CuaRelease): void {
  if (
    release.schemaVersion !== 1 ||
    !versionPattern.test(release.version) ||
    release.tag !== `cua-driver-rs-v${release.version}` ||
    !/^[a-f0-9]{40}$/u.test(release.sourceCommit) ||
    release.repository !== repository ||
    release.license !== "MIT" ||
    release.certificateIssuer !== "https://token.actions.githubusercontent.com" ||
    release.certificateIdentity !==
      `https://github.com/${repository}/.github/workflows/cd-rust-cua-driver.yml@refs/tags/${release.tag}` ||
    Object.keys(release.assets).length !== Object.keys(targetLabels).length
  ) {
    throw new Error("Invalid Cua Driver release identity.");
  }
  for (const target of Object.keys(targetLabels) as CuaReleaseTarget[]) {
    const asset = release.assets[target];
    if (
      !asset ||
      asset.name !== assetName(release.version, target) ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      asset.bytes > 128 * 1024 * 1024
    ) {
      throw new Error(`Invalid Cua Driver artifact for ${target}.`);
    }
  }
}

export const CUA_DRIVER_RELEASE: CuaRelease = pinnedRelease;
validateCuaRelease(CUA_DRIVER_RELEASE);

function requireAuditedPin(release: CuaRelease): void {
  if (
    !release.auditedAt ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(release.auditedAt) ||
    release.reviewRequired === true ||
    release.checksumManifest?.name !== "SHA256SUMS" ||
    !/^[a-f0-9]{64}$/u.test(release.checksumManifest.sha256) ||
    !Number.isSafeInteger(release.checksumManifest.bytes) ||
    release.checksumManifest.bytes < 1
  ) {
    throw new Error("Cua Driver candidate requires a completed audit before artifact fetching.");
  }
}
requireAuditedPin(CUA_DRIVER_RELEASE);

export function verifyCuaArtifact(bytes: Uint8Array, asset: CuaReleaseAsset): void {
  if (
    bytes.byteLength !== asset.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== asset.sha256
  ) {
    throw new Error("Cua Driver artifact failed its pinned size/SHA-256 check.");
  }
}

async function boundedDownload(
  url: string,
  maxBytes: number,
  request: typeof fetch,
): Promise<Buffer> {
  const response = await request(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error("Cua release download failed.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks, size);
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error("Cua release download exceeded its size limit.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Fetch only the audited archive. Never extract/run installers, configure
 * providers, mutate PATH, or automatically enable host control. */
export async function fetchPinnedCuaArtifact(options: {
  readonly target: CuaReleaseTarget;
  readonly outputDirectory: string;
  readonly release?: CuaRelease;
  readonly request?: typeof fetch;
}): Promise<string> {
  const release = options.release ?? CUA_DRIVER_RELEASE;
  validateCuaRelease(release);
  requireAuditedPin(release);
  const asset = release.assets[options.target];
  if (!asset) throw new Error("Unsupported Cua Driver target.");
  const bytes = await boundedDownload(
    `https://github.com/${repository}/releases/download/${release.tag}/${asset.name}`,
    asset.bytes,
    options.request ?? fetch,
  );
  verifyCuaArtifact(bytes, asset);
  // Publish only verified bytes, with exclusive creation. Existing files are
  // never trusted by filename and never overwritten (including symlinks).
  await fs.mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
  const path = join(options.outputDirectory, asset.name);
  await fs.writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  return path;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid upstream Cua release metadata.");
  return value as Record<string, unknown>;
}

/** Discovery generates review material, never a new trusted production pin.
 * Hashes supplied by a new release still need independent signature review. */
export async function reviewCuaRelease(
  version: string,
  request: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!versionPattern.test(version)) throw new Error("Use an exact stable Cua version.");
  const tag = `cua-driver-rs-v${version}`;
  const release = record(
    JSON.parse(
      (
        await boundedDownload(
          `https://api.github.com/repos/${repository}/releases/tags/${tag}`,
          maxMetadataBytes,
          request,
        )
      ).toString("utf8"),
    ),
  );
  if (release.tag_name !== tag || release.draft !== false || !Array.isArray(release.assets))
    throw new Error("Unexpected upstream Cua release identity.");
  const ref = record(
    JSON.parse(
      (
        await boundedDownload(
          `https://api.github.com/repos/${repository}/git/ref/tags/${tag}`,
          maxMetadataBytes,
          request,
        )
      ).toString("utf8"),
    ),
  );
  const commit = record(ref.object);
  if (
    commit.type !== "commit" ||
    typeof commit.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(commit.sha)
  )
    throw new Error("Review annotated or unsupported Cua tags manually.");
  const upstreamAssets = release.assets.map(record);
  const assets = { ...CUA_DRIVER_RELEASE.assets };
  for (const target of Object.keys(targetLabels) as CuaReleaseTarget[]) {
    const name = assetName(version, target);
    const asset = upstreamAssets.find((candidate) => candidate.name === name);
    if (
      !asset ||
      typeof asset.size !== "number" ||
      typeof asset.digest !== "string" ||
      !asset.digest.startsWith("sha256:")
    )
      throw new Error(`Missing Cua artifact identity for ${target}.`);
    assets[target] = { name, bytes: asset.size, sha256: asset.digest.slice(7) };
  }
  const candidate = {
    ...pinnedRelease,
    version,
    tag,
    sourceCommit: commit.sha,
    certificateIdentity: `https://github.com/${repository}/.github/workflows/cd-rust-cua-driver.yml@refs/tags/${tag}`,
    assets,
    auditedAt: null,
    checksumManifest: null,
    audit: { status: "candidate", integrationApproved: false },
    reviewRequired: true,
  };
  validateCuaRelease(candidate);
  return candidate;
}

async function main(argv: readonly string[]): Promise<void> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const [command, flag, value, ...extra] = argv;
  if (extra.length || !value)
    throw new Error("Use fetch --target <target> or review --version <version>.");
  if (command === "fetch" && flag === "--target" && Object.hasOwn(targetLabels, value)) {
    const directory = await fs.mkdtemp(join(await ensureReviewRoot(root), "download-"));
    try {
      process.stdout.write(
        `${await fetchPinnedCuaArtifact({ target: value as CuaReleaseTarget, outputDirectory: directory })}\n`,
      );
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  } else if (command === "review" && flag === "--version") {
    const candidate = await reviewCuaRelease(value);
    const path = join(await ensureReviewRoot(root), `candidate-${value}-${randomUUID()}.json`);
    await fs.writeFile(path, `${JSON.stringify(candidate, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    process.stdout.write(`Review candidate saved to ${path}. The production pin is unchanged.\n`);
  } else {
    throw new Error("Use fetch --target <target> or review --version <version>.");
  }
}

async function ensureReviewRoot(root: string): Promise<string> {
  const path = join(root, ".explorations", "cua-driver");
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Cua release operation failed. Use an exact version/target and check the audit instructions.\n",
    );
    process.exitCode = 1;
  });
}
