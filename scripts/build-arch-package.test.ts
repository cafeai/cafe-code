import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ARCH_RUNTIME_DEPENDENCIES } from "./build-arch-package.ts";

const repoRoot = resolve(import.meta.dirname, "..");

function readPkgbuildDependencies(): ReadonlyArray<string> {
  const source = readFileSync(resolve(repoRoot, "packaging/aur/cafe-code/PKGBUILD"), "utf8");
  const block = source.match(/^depends=\(\n(?<body>[\s\S]*?)^\)$/mu)?.groups?.body;
  if (!block) throw new Error("Could not parse the PKGBUILD depends block.");
  return [...block.matchAll(/^\s*'(?<name>[^']+)'$/gmu)].map((match) => match.groups?.name ?? "");
}

function readSrcInfoDependencies(): ReadonlyArray<string> {
  const source = readFileSync(resolve(repoRoot, "packaging/aur/cafe-code/.SRCINFO"), "utf8");
  return [...source.matchAll(/^\s*depends = (?<name>.+)$/gmu)].map(
    (match) => match.groups?.name ?? "",
  );
}

describe("Arch runtime dependency policy", () => {
  it("keeps local, PKGBUILD, and SRCINFO dependency declarations identical", () => {
    expect(ARCH_RUNTIME_DEPENDENCIES).toEqual(readPkgbuildDependencies());
    expect(ARCH_RUNTIME_DEPENDENCIES).toEqual(readSrcInfoDependencies());
  });
});
