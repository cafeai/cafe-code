import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

const RETIRED_TOOL_TOKEN = String.fromCharCode(98, 117, 110);

const DENIED_ARTIFACT_NAMES = new Set([
  ".env",
  ".npmrc",
  ".pnp.cjs",
  ".pnp.js",
  ".pnp.loader.mjs",
  ".yarnrc",
  ".yarnrc.yml",
  "auth.json",
  RETIRED_TOOL_TOKEN,
  `${RETIRED_TOOL_TOKEN}.exe`,
  `${RETIRED_TOOL_TOKEN}.lock`,
  `${RETIRED_TOOL_TOKEN}.lockb`,
  `${RETIRED_TOOL_TOKEN}fig.toml`,
  `${RETIRED_TOOL_TOKEN}x`,
  `${RETIRED_TOOL_TOKEN}x.exe`,
  "credentials.json",
  "package-lock.json",
  "secrets.json",
  "yarn.lock",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".md",
  ".mjs",
  ".ps1",
  ".sh",
  ".txt",
  ".webmanifest",
  ".yaml",
  ".yml",
]);

const DENIED_DEPENDENCY_PROTOCOL = /^(?:catalog|file|link|patch|portal|workspace):/iu;
const DENIED_TOOLCHAIN_REFERENCE = new RegExp(
  `(^|[^a-z0-9_])${RETIRED_TOOL_TOKEN}(?=$|[^a-z0-9_])`,
  "iu",
);
const PRIVATE_KEY_MATERIAL = /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u;
const GITHUB_TOKEN_MATERIAL = /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/u;
const AWS_ACCESS_KEY_MATERIAL = /\bAKIA[A-Z0-9]{16}\b/u;
const OPENAI_KEY_MATERIAL = /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/gu;

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validDependencyMap(value: unknown): boolean {
  const dependencies = readRecord(value);
  return (
    dependencies !== undefined &&
    Object.values(dependencies).every(
      (spec) => typeof spec === "string" && !DENIED_DEPENDENCY_PROTOCOL.test(spec),
    )
  );
}

export function isDesktopRuntimeManifestValid(value: unknown): boolean {
  const manifest = readRecord(value);
  if (
    manifest?.name !== "@cafecode/desktop-runtime" ||
    manifest.private !== true ||
    manifest.main !== "apps/desktop/dist-electron/main.cjs" ||
    !validDependencyMap(manifest.dependencies)
  ) {
    return false;
  }

  return ["devDependencies", "packageManager", "resolutions", "scripts", "workspaces"].every(
    (field) => manifest[field] === undefined,
  );
}

export function containsDesktopArtifactSecretMaterial(source: string): boolean {
  if (
    PRIVATE_KEY_MATERIAL.test(source) ||
    GITHUB_TOKEN_MATERIAL.test(source) ||
    AWS_ACCESS_KEY_MATERIAL.test(source)
  ) {
    return true;
  }

  // Avoid treating ordinary identifiers such as `sk-prompt-state` in syntax
  // grammars as keys. Real generated API keys contain at least one digit.
  return [...source.matchAll(OPENAI_KEY_MATERIAL)].some((match) => /\d/u.test(match[0]));
}

export function containsDesktopArtifactResidue(path: string, source?: string): boolean {
  if (DENIED_ARTIFACT_NAMES.has(basename(path).toLowerCase())) return true;
  return (
    source !== undefined &&
    (DENIED_TOOLCHAIN_REFERENCE.test(source) || containsDesktopArtifactSecretMaterial(source))
  );
}

export function isDesktopUpdateMetadataValid(source: string): boolean {
  return (
    /^provider:\s*github\s*$/mu.test(source) &&
    /^owner:\s*cafeai\s*$/mu.test(source) &&
    /^repo:\s*cafe-code\s*$/mu.test(source)
  );
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await visit(root);
  return files;
}

async function auditTextFiles(root: string, files: readonly string[]): Promise<boolean> {
  for (const path of files) {
    const artifactPath = relative(root, path);
    if (containsDesktopArtifactResidue(artifactPath)) return false;
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue;
    const source = await readFile(path, "utf8");
    if (containsDesktopArtifactResidue(artifactPath, source)) return false;
  }
  return true;
}

export async function auditPackagedDesktopArtifact(
  resourcesPath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const appArchive = join(resourcesPath, "app.asar");
  const manifest = JSON.parse(await readFile(join(appArchive, "package.json"), "utf8")) as unknown;
  if (!isDesktopRuntimeManifestValid(manifest)) return false;

  // Electron exposes ASAR contents through the regular filesystem API. Scan
  // first-party bundles and source maps, while treating vendored dependencies
  // as third-party inputs governed by the lockfile and package audit.
  const appFiles = await listFiles(join(appArchive, "apps"));
  if (appFiles.length === 0 || !(await auditTextFiles(appArchive, appFiles))) return false;

  const resourceEntries = await readdir(resourcesPath, { withFileTypes: true });
  const expectedTopLevelEntries = new Set([
    "app.asar",
    "app.asar.unpacked",
    "app-update.yml",
    ...(platform === "darwin" ? ["icon.icns"] : []),
    ...(platform === "win32" ? ["elevate.exe", "managed-runtime"] : []),
  ]);
  if (resourceEntries.some((entry) => !expectedTopLevelEntries.has(entry.name))) return false;
  if (
    !isDesktopUpdateMetadataValid(await readFile(join(resourcesPath, "app-update.yml"), "utf8"))
  ) {
    return false;
  }

  const externalFiles = (await listFiles(resourcesPath)).filter((path) => {
    const artifactPath = relative(resourcesPath, path).split("\\").join("/");
    return (
      artifactPath !== "app.asar" &&
      !artifactPath.startsWith("app.asar.unpacked/node_modules/") &&
      !artifactPath.startsWith("managed-runtime/node/")
    );
  });
  return await auditTextFiles(resourcesPath, externalFiles);
}
