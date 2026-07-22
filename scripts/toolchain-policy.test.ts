import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), "utf8")) as Record<
    string,
    unknown
  >;
}

function readStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

describe("repository toolchain policy", () => {
  it("pins one exact Yarn and Node toolchain", () => {
    const rootPackage = readJson("package.json");

    expect(rootPackage.packageManager).toBe("yarn@4.17.1");
    expect(rootPackage.engines).toEqual({ node: "^24.13.1" });
    expect(rootPackage.workspaces).toEqual([
      "apps/*",
      "oxlint-plugin-cafecode",
      "packages/*",
      "scripts",
      "packaging/desktop-runtime",
    ]);

    const rootLockfiles = readdirSync(repoRoot).filter((entry) => entry.endsWith(".lock"));
    expect(rootLockfiles).toEqual(["yarn.lock"]);
  });

  it("uses a conventional node_modules install with explicit script trust", () => {
    const yarnConfig = readFileSync(resolve(repoRoot, ".yarnrc.yml"), "utf8");
    const rootPackage = readJson("package.json");

    expect(yarnConfig).toMatch(/^nodeLinker: node-modules$/m);
    expect(yarnConfig).toMatch(/^enableScripts: false$/m);
    expect(yarnConfig).toMatch(/^enableGlobalCache: true$/m);
    const buildPolicy = rootPackage.dependenciesMeta as Record<
      string,
      { readonly built?: boolean }
    >;
    expect(
      Object.entries(buildPolicy)
        .filter(([, policy]) => policy.built === true)
        .map(([name]) => name)
        .toSorted(),
    ).toEqual(["electron", "node-pty"]);
    expect(buildPolicy["msgpackr-extract"]).toEqual({ built: false });
    expect(buildPolicy.msw).toEqual({ built: false });
  });

  it("registers the RPC patch through Yarn resolutions", () => {
    const rootPackage = readJson("package.json");
    const resolutions = readStringMap(rootPackage.resolutions);
    const effectResolution = resolutions.effect;

    expect(rootPackage).not.toHaveProperty("patchedDependencies");
    expect(effectResolution).toMatch(
      /^patch:effect@npm%3A4\.0\.0-beta\.59#\.\/.yarn\/patches\/effect\.patch$/,
    );

    const patchPath = resolve(repoRoot, ".yarn/patches/effect.patch");
    expect(existsSync(patchPath)).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toContain("RequestHooks");
  });

  it("keeps the staged desktop dependency graph in a checked-in workspace", () => {
    const rootPackage = readJson("package.json");
    const desktopPackage = readJson("apps/desktop/package.json");
    const serverPackage = readJson("apps/server/package.json");
    const stagePackage = readJson("packaging/desktop-runtime/package.json");
    const desktopDependencies = readStringMap(desktopPackage.dependencies);
    const serverDependencies = readStringMap(serverPackage.dependencies);
    const expectedDependencies = Object.fromEntries(
      Object.entries({ ...serverDependencies, ...desktopDependencies }).filter(
        ([name, spec]) => name !== "electron" && !spec.startsWith("workspace:"),
      ),
    );

    expect(stagePackage.name).toBe("@cafecode/desktop-runtime");
    expect(stagePackage.private).toBe(true);
    expect(readStringMap(rootPackage.scripts)).not.toHaveProperty("postinstall");
    expect(readStringMap(stagePackage.scripts).postinstall).toBe(
      "node ../../scripts/ensure-desktop-runtime.ts",
    );
    expect(stagePackage.dependencies).toEqual(expectedDependencies);
    expect(stagePackage.devDependencies).toEqual({
      electron: desktopDependencies.electron,
      "electron-builder": readStringMap(rootPackage.devDependencies)["electron-builder"],
    });
  });
});
