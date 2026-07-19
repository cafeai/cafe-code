import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findDeniedReferences,
  listRepositoryFilesFromFilesystem,
  readDeniedTerms,
} from "./repository-audit.ts";

describe("repository audit", () => {
  it("reports classified terms with paths and line numbers", () => {
    expect(
      findDeniedReferences("docs/example.md", "safe\nlegacy-tool run\n", ["legacy-tool"]),
    ).toEqual([{ path: "docs/example.md", line: 2, term: "legacy-tool" }]);
  });

  it("uses token boundaries and skips binary content", () => {
    expect(findDeniedReferences("source.ts", "legacy-tooling", ["legacy-tool"])).toEqual([]);
    expect(findDeniedReferences("asset.bin", "\0legacy-tool", ["legacy-tool"])).toEqual([]);
  });

  it("always enforces the retired-toolchain classification", () => {
    const defaults = readDeniedTerms([]);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toHaveLength(3);
    expect(readDeniedTerms(["--deny", "legacy-tool"])).toEqual([defaults[0], "legacy-tool"]);
  });

  it("enumerates source archives without traversing generated dependency trees", () => {
    const root = mkdtempSync(join(tmpdir(), "cafecode-repository-audit-"));
    try {
      mkdirSync(join(root, "apps", "server", "src"), { recursive: true });
      mkdirSync(join(root, "apps", "server", "dist"), { recursive: true });
      mkdirSync(join(root, "node_modules", "dependency"), { recursive: true });
      mkdirSync(join(root, ".yarn", "patches"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}\n");
      writeFileSync(join(root, "apps", "server", "src", "server.ts"), "export {};\n");
      writeFileSync(join(root, "apps", "server", "dist", "server.js"), "generated\n");
      writeFileSync(join(root, "node_modules", "dependency", "index.js"), "dependency\n");
      writeFileSync(join(root, ".yarn", "patches", "effect.patch"), "patch\n");

      expect(listRepositoryFilesFromFilesystem(root)).toEqual([
        ".yarn/patches/effect.patch",
        "apps/server/src/server.ts",
        "package.json",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
