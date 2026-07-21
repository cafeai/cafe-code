#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export interface RepositoryFinding {
  readonly path: string;
  readonly line: number;
  readonly term: string;
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Assemble the classified retired-tool token so the audit policy does not
// preserve the prohibited token in the maintained tree it verifies.
const DEFAULT_DENIED_TERMS = [String.fromCharCode(98, 117, 110)] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findDeniedReferences(
  path: string,
  source: string,
  deniedTerms: ReadonlyArray<string>,
): ReadonlyArray<RepositoryFinding> {
  if (source.includes("\0")) return [];

  const findings: RepositoryFinding[] = [];
  const lines = source.split(/\r?\n/u);
  for (const term of deniedTerms) {
    const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(term)}(?=$|[^a-z0-9_])`, "iu");
    for (const [index, line] of lines.entries()) {
      if (pattern.test(line)) {
        findings.push({ path, line: index + 1, term });
      }
    }
  }
  return findings;
}

const ignoredFilesystemDirectoryNames = new Set([
  ".astro",
  ".git",
  ".plans",
  ".startup-profiles",
  ".turbo",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "dist-electron",
  "node_modules",
  "release",
  "target",
]);

function isIgnoredFilesystemPath(path: string): boolean {
  const normalizedPath = toRepositoryPath(path);
  return (
    normalizedPath === ".yarn/install-state.gz" ||
    normalizedPath === "packaging/aur/cafe-code/pkg" ||
    normalizedPath.startsWith("packaging/aur/cafe-code/pkg/") ||
    normalizedPath === "packaging/aur/cafe-code/src" ||
    normalizedPath.startsWith("packaging/aur/cafe-code/src/")
  );
}

function toRepositoryPath(path: string): string {
  return path.split(sep).join("/");
}

export function listRepositoryFilesFromFilesystem(root: string): ReadonlyArray<string> {
  const files: string[] = [];

  function visit(relativeDirectory: string): void {
    const absoluteDirectory = resolve(root, relativeDirectory);
    for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      if (isIgnoredFilesystemPath(relativePath)) continue;
      if (entry.isDirectory()) {
        if (!ignoredFilesystemDirectoryNames.has(entry.name)) visit(relativePath);
        continue;
      }
      if (entry.isFile()) files.push(toRepositoryPath(relativePath));
    }
  }

  visit("");
  return files.toSorted();
}

function listRepositoryFiles(root: string): ReadonlyArray<string> {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
    },
  );
  if (result.status !== 0) {
    // Release archives and clean-room Docker contexts intentionally omit
    // `.git`. Keep the fallback bounded to the candidate source tree and use
    // the same generated/dependency exclusions as the repository tooling.
    return listRepositoryFilesFromFilesystem(root);
  }
  return result.stdout.split("\0").filter(Boolean);
}

export function readDeniedTerms(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  const terms: string[] = [...DEFAULT_DENIED_TERMS];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--deny") continue;
    const term = argv[index + 1]?.trim();
    if (!term) throw new Error("--deny requires a non-empty term.");
    if (!terms.includes(term)) terms.push(term);
    index += 1;
  }
  return terms;
}

export function auditRepository(
  root: string,
  deniedTerms: ReadonlyArray<string>,
): ReadonlyArray<RepositoryFinding> {
  const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    packageManager?: unknown;
  };
  if (rootPackage.packageManager !== "yarn@4.17.1") {
    throw new Error("The repository must declare the exact supported Yarn release.");
  }

  const rootLocks = readdirSync(root).filter((entry) => entry.endsWith(".lock"));
  if (rootLocks.length !== 1 || rootLocks[0] !== "yarn.lock") {
    throw new Error(
      `Expected yarn.lock to be the only root lockfile; found: ${rootLocks.join(", ")}`,
    );
  }

  return listRepositoryFiles(root).flatMap((path) => {
    const absolutePath = resolve(root, path);
    // `git ls-files --cached` includes tracked paths deleted in the working
    // tree until the change is committed. They have no maintained content to
    // audit in the candidate tree.
    if (!existsSync(absolutePath)) return [];
    // The lock is separately constrained above. Its generated third-party
    // dependency metadata may legitimately name optional peers that Cafe does
    // not use, so it is not first-party prose or executable policy.
    if (path === "yarn.lock") return [];
    return findDeniedReferences(
      toRepositoryPath(relative(root, absolutePath)),
      readFileSync(absolutePath, "utf8"),
      deniedTerms,
    );
  });
}

function main(): void {
  const deniedTerms = readDeniedTerms(process.argv.slice(2));
  const findings = auditRepository(repositoryRoot, deniedTerms);
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`${finding.path}:${finding.line}: denied term '${finding.term}'\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Repository audit passed (${deniedTerms.length} classified term${deniedTerms.length === 1 ? "" : "s"}).\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
