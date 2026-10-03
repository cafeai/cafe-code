import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { REPOSITORY_NODE_VERSION } from "./lib/node-version.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

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
    expect(rootPackage.engines).toEqual({ node: `^${REPOSITORY_NODE_VERSION}` });
    expect(readJson("apps/server/package.json").engines).toEqual({
      node: `^${REPOSITORY_NODE_VERSION}`,
    });
    expect(readFileSync(resolve(repoRoot, ".mise.toml"), "utf8")).toMatch(
      new RegExp(`^node = "${REPOSITORY_NODE_VERSION.replaceAll(".", "\\.")}"$`, "m"),
    );
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

  it("keeps Node declarations on the standalone runtime major, not Current", () => {
    const yarnConfig = parse(readFileSync(resolve(repoRoot, ".yarnrc.yml"), "utf8")) as {
      catalog: Readonly<Record<string, string>>;
    };
    const typeVersion = yarnConfig.catalog["@types/node"]!;
    expect(typeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeVersion.split(".")[0]).toBe(REPOSITORY_NODE_VERSION.split(".")[0]);
  });

  it("keeps developer and clean-room setup on the canonical standalone version", () => {
    const devcontainer = readJson(".devcontainer/devcontainer.json") as {
      features: Readonly<Record<string, { version?: string }>>;
    };
    expect(devcontainer.features["ghcr.io/devcontainers/features/node:1"]?.version).toBe(
      REPOSITORY_NODE_VERSION,
    );
    const dockerfile = readFileSync(
      resolve(repoRoot, "tooling/docker/clean-room.Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toMatch(
      new RegExp(
        `^FROM node:${REPOSITORY_NODE_VERSION.replaceAll(".", "\\.")}-bookworm@sha256:[a-f0-9]{64} AS toolchain$`,
        "m",
      ),
    );
    // The image tag names the intended release, but only executing its binary
    // against the canonical file rejects a mismatched newly reviewed digest.
    expect(dockerfile).toContain(
      'RUN test "$(node --version)" = "v$(tr -d \'\\r\\n\' < .node-version)"',
    );
  });

  it("selects the reviewed LTS-only Arch build package rather than generic Current Node", () => {
    // Arch's generic nodejs package follows Current. The release codename is a
    // separate reviewed distro identity and must be updated with a new LTS
    // major, never guessed from a moving generic package or an even number.
    const ltsPackageByMajor: Readonly<Record<string, string>> = { "24": "nodejs-lts-krypton" };
    const ltsPackage = ltsPackageByMajor[REPOSITORY_NODE_VERSION.split(".")[0]!];
    expect(ltsPackage).toBeDefined();
    const expectedDependency = `${ltsPackage}>=${REPOSITORY_NODE_VERSION}`;
    const packageBuild = readFileSync(
      resolve(repoRoot, "packaging/aur/cafe-code/PKGBUILD"),
      "utf8",
    );
    const sourceInfo = readFileSync(resolve(repoRoot, "packaging/aur/cafe-code/.SRCINFO"), "utf8");
    expect(packageBuild).toContain(`'${expectedDependency}'`);
    expect(sourceInfo).toContain(`makedepends = ${expectedDependency}`);
    expect(packageBuild).not.toMatch(/['"]nodejs(?:[<>=]|['"])/);
    expect(sourceInfo).not.toMatch(/makedepends = nodejs(?:[<>=]|$)/m);
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

  it("keeps the qualified Electron security release synchronized without weakening sandboxing", () => {
    // Electron's sandboxed-preload cache-poisoning advisory has no application
    // workaround. Bind source and packaged runtimes to the reviewed fixed
    // release rather than accepting a matching but vulnerable pair of pins.
    for (const packagePath of ["apps/desktop/package.json", "apps/server/package.json"]) {
      expect(readStringMap(readJson(packagePath).dependencies).electron, packagePath).toBe(
        "42.10.0",
      );
    }
    expect(
      readStringMap(readJson("packaging/desktop-runtime/package.json").devDependencies).electron,
    ).toBe("42.10.0");
  });

  it("retains fixed security floors in every installed URI, IP and brace-expansion branch", () => {
    const resolutions = readStringMap(readJson("package.json").resolutions);
    expect(resolutions["fast-uri"]).toBe("^3.1.8");
    expect(resolutions["ip-address"]).toBe("^10.7.1");
    const lock = parse(readFileSync(resolve(repoRoot, "yarn.lock"), "utf8")) as Record<
      string,
      { version?: string }
    >;
    const minimums: Record<string, Record<number, readonly [number, number]>> = {
      "brace-expansion": { 1: [1, 21], 2: [1, 7], 5: [0, 12] },
      "fast-uri": { 3: [1, 8] },
      "ip-address": { 10: [7, 1] },
    };
    for (const [name, branches] of Object.entries(minimums)) {
      const entries = Object.entries(lock).filter(([descriptor]) =>
        descriptor.startsWith(`${name}@npm:`),
      );
      expect(entries.length, name).toBeGreaterThan(0);
      for (const [descriptor, entry] of entries) {
        // Reject unreviewed new majors and prereleases as well as old vulnerable
        // copies hidden behind a second transitive descriptor in the same lock.
        expect(entry.version, descriptor).toMatch(/^\d+\.\d+\.\d+$/);
        const [major, minor, patch] = entry.version!.split(".").map(Number);
        const minimum = branches[major!];
        expect(minimum, descriptor).toBeDefined();
        expect(
          minor! > minimum![0] || (minor === minimum![0] && patch! >= minimum![1]),
          descriptor,
        ).toBe(true);
      }
    }
  });

  it("bounds Vitest 5 qualification to the exact runner and the cancellation backport", () => {
    const rootPackage = readJson("package.json");
    const resolutions = readStringMap(rootPackage.resolutions);
    const yarnConfig = readFileSync(resolve(repoRoot, ".yarnrc.yml"), "utf8");
    const webPackage = readJson("apps/web/package.json");

    // The beta.59 adapter's upstream peer metadata predates Vitest 5. Its
    // narrow backport is qualified for this exact runner, not all future v5
    // releases and not a coordinated migration of the protected Effect graph.
    expect(yarnConfig).toMatch(/^  vitest: 5\.0\.2$/m);
    expect(yarnConfig).toMatch(/^  "@effect\/vitest": 4\.0\.0-beta\.59$/m);
    expect(readStringMap(webPackage.devDependencies)["@vitest/browser-playwright"]).toBe("5.0.2");
    expect(resolutions["@effect/vitest"]).toBe(
      "patch:@effect/vitest@npm%3A4.0.0-beta.59#./.yarn/patches/effect-vitest.patch",
    );

    const installedRunner = JSON.parse(
      readFileSync(require.resolve("vitest/package.json"), "utf8"),
    ) as { version: string };
    const installedAdapterPath = require.resolve("@effect/vitest/package.json");
    const installedAdapter = JSON.parse(readFileSync(installedAdapterPath, "utf8")) as {
      version: string;
      peerDependencies: { vitest: string };
    };
    expect(installedRunner.version).toBe("5.0.2");
    expect(installedAdapter.version).toBe("4.0.0-beta.59");
    expect(installedAdapter.peerDependencies.vitest).toBe("^3.0.0 || ^4.0.0 || 5.0.2");

    // Qualification exercises these public APIs in the normal adapter tests
    // and proves timed-out scopes retire before the next case in the isolated
    // opt-in EffectVitestCompatibility fixture. Bind this guard to both the
    // committed patch and the fetched JavaScript, not just a manifest claim.
    // The cancellation-only wait is backported from the official rc.113 source:
    // https://github.com/Effect-TS/effect/blob/d3b837aee836f35d625d55205f7d6e61305fc198/packages/vitest/src/internal/internal.ts
    const patch = readFileSync(resolve(repoRoot, ".yarn/patches/effect-vitest.patch"), "utf8");
    const adapterRuntime = readFileSync(
      resolve(dirname(installedAdapterPath), "dist/internal/internal.js"),
      "utf8",
    );
    for (const source of [patch, adapterRuntime]) {
      expect(source).toContain("ctx.onTestFinished(() => promise.then(() => {}, () => {}))");
      expect(source).toContain('ctx.signal.addEventListener("abort", onAbort, { once: true })');
      expect(source).toContain('ctx.signal.removeEventListener("abort", onAbort)');
      expect(source).toContain("if (ctx.signal.aborted) onAbort()");
    }
  });

  it("supplies Vitest 5's Vite peer and explicit shared configuration in every test workspace", () => {
    const sharedConfigPackages = [
      "apps/desktop/package.json",
      "apps/web/package.json",
      "packages/client-runtime/package.json",
      "packages/contracts/package.json",
      "packages/effect-acp/package.json",
      "packages/effect-codex-app-server/package.json",
      "packages/shared/package.json",
      "scripts/package.json",
    ];
    for (const packagePath of [...sharedConfigPackages, "apps/server/package.json"]) {
      const manifest = readJson(packagePath);
      const dependencies = readStringMap(manifest.devDependencies);
      expect(dependencies.vitest, packagePath).toBe("catalog:");
      expect(dependencies.vite, packagePath).toBe("catalog:");
      if (sharedConfigPackages.includes(packagePath)) {
        const configPath =
          packagePath === "apps/web/package.json"
            ? ""
            : packagePath === "scripts/package.json"
              ? "../"
              : "../../";
        expect(readStringMap(manifest.scripts).test, packagePath).toContain(
          `--config ${configPath}vitest.config.ts`,
        );
      }
    }
    // The server intentionally retains its own isolation/time-budget config;
    // unlike removed parent lookup, this explicit merge keeps shared defaults.
    expect(readFileSync(resolve(repoRoot, "apps/server/vitest.config.ts"), "utf8")).toContain(
      'import baseConfig from "../../vitest.config.ts"',
    );
    expect(readFileSync(resolve(repoRoot, "vitest.config.ts"), "utf8")).toContain(
      "clearMocks: false",
    );
    const webConfig = readFileSync(resolve(repoRoot, "apps/web/vitest.config.ts"), "utf8");
    expect(webConfig).toContain('import baseConfig from "../../vitest.config.ts"');
    expect(webConfig).toContain('import viteConfig from "./vite.config.ts"');
    expect(webConfig).toContain("mergeConfig(viteConfig, baseConfig)");
    expect(webConfig).toContain('"~": srcPath');
    expect(readStringMap(readJson("apps/web/package.json").scripts)["test:browser"]).toBe(
      "vitest run --config vitest.browser.config.ts",
    );
  });

  it("keeps the server, scripts, and staged Claude SDK on one exact version", () => {
    const sdkName = "@anthropic-ai/claude-agent-sdk";
    const packagePaths = [
      "apps/server/package.json",
      "scripts/package.json",
      "packaging/desktop-runtime/package.json",
    ];
    const pins = packagePaths.map(
      (packagePath) => readStringMap(readJson(packagePath).dependencies)[sdkName],
    );

    // The general staged-graph check compares the desktop runtime with the
    // server, but cannot detect the scripts workspace retaining an older SDK.
    // All three must move together so source tools and shipped sessions use
    // the same vetted lifecycle contract; ranges and absent pins fail too.
    for (const [index, pin] of pins.entries()) {
      expect(pin, packagePaths[index]).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pin, packagePaths[index]).toBe(pins[0]);
    }
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
