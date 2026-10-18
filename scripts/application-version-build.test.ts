import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { build, normalizePath, type Plugin, type UserConfig } from "vite";

import serverPackageJson from "../apps/server/package.json" with { type: "json" };
import webPackageJson from "../apps/web/package.json" with { type: "json" };
import {
  APPLICATION_BUILD_VERSION_MANIFEST_FILENAME,
  publishApplicationBuildVersionManifest,
  verifyApplicationBuildVersionManifest,
} from "../packages/shared/src/applicationBuildVersion.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtureRoots = new Set<string>();
const inFlightBuilds = new Set<Promise<unknown>>();
const MAX_FIXTURE_OUTPUT_BYTES = 64 * 1024;

interface FixtureManifest {
  readonly applicationVersion: string;
  readonly files: readonly { readonly file: string }[];
}

async function compile(config: Parameters<typeof build>[0]): Promise<void> {
  const pending = build(config);
  inFlightBuilds.add(pending);
  try {
    await pending;
  } finally {
    inFlightBuilds.delete(pending);
  }
}

async function readSmallFile(filename: string): Promise<string> {
  const metadata = await stat(filename);
  assert.ok(metadata.isFile() && metadata.size <= MAX_FIXTURE_OUTPUT_BYTES);
  return readFile(filename, "utf8");
}

async function readManifest(directory: string): Promise<FixtureManifest> {
  return JSON.parse(
    await readSmallFile(join(directory, APPLICATION_BUILD_VERSION_MANIFEST_FILENAME)),
  ) as FixtureManifest;
}

function applicationVersionPlugin(config: UserConfig): Plugin {
  // Select the actual receipt plugin installed by the production config. The
  // other application plugins must not load a router, React app or Tailwind
  // graph merely to compile this inert version-only fixture.
  const selected = config.plugins?.find(
    (candidate): candidate is Plugin =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      "name" in candidate &&
      candidate.name === "cafe-application-build-version",
  );
  assert.ok(selected, "The real renderer config must publish its build version receipt.");
  return selected;
}

function serverReceiptPlugin(applicationVersion: string): Plugin {
  return {
    name: "fixture-server-build-version-receipt",
    apply: "build",
    writeBundle(options, bundle) {
      assert.ok(options.dir);
      const files: Record<string, string> = {};
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") files[output.fileName] = output.code;
      }
      // These are the compiler's exact successful chunks, not hand-written
      // receipt payloads or source text substituted for generated JavaScript.
      publishApplicationBuildVersionManifest(
        resolve(options.dir),
        "server",
        applicationVersion,
        files,
      );
    },
  };
}

afterEach(async () => {
  // Even a failed test owns the compiler before removing its temporary output
  // or restoring the selected build environment. No late bundler publication
  // may race cleanup or the next case's environment selection.
  await Promise.allSettled([...inFlightBuilds]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const directory of fixtureRoots) {
    await rm(directory, { recursive: true, force: true });
    fixtureRoots.delete(directory);
  }
});

describe("actual application version compilation", () => {
  it.each([
    { label: "stable override", selected: "0.2.2" },
    { label: "nightly override", selected: "0.2.3-nightly.20261019.1" },
    { label: "source manifest fallback", selected: undefined },
  ])(
    "bakes $label into emitted renderer and backend bytes",
    async ({ selected }) => {
      vi.stubEnv("APP_VERSION", selected);
      vi.resetModules();

      // Import the real compiler configurations after selecting the build
      // version. Reconstructing their define values inside this test would
      // hide the exact release-propagation bug this regression protects.
      const [{ default: webConfig }, { default: serverConfigs }] = await Promise.all([
        import("../apps/web/vite.config.ts"),
        import("../apps/server/tsdown.config.ts"),
      ]);
      assert.ok(Array.isArray(serverConfigs));
      const serverConfig = serverConfigs[0];
      assert.ok(serverConfig && typeof serverConfig === "object" && "define" in serverConfig);
      const webVersion = selected ?? webPackageJson.version;
      const serverVersion = selected ?? serverPackageJson.version;
      assert.ok(webConfig.define && serverConfig.define);

      const root = await mkdtemp(join(tmpdir(), "cafe-application-version-build-"));
      fixtureRoots.add(root);
      const webOutput = join(root, "web-output");
      const serverOutput = join(root, "server-output");
      const branding = normalizePath(resolve(repositoryRoot, "apps/web/src/branding.ts"));
      const serverVersionModule = normalizePath(
        resolve(repositoryRoot, "apps/server/src/applicationVersion.ts"),
      );
      await writeFile(
        join(root, "index.html"),
        '<!doctype html><script type="module" src="./renderer.ts"></script>\n',
      );
      await writeFile(
        join(root, "renderer.ts"),
        `import { APP_VERSION } from ${JSON.stringify(branding)};\n` +
          "globalThis.__cafeFixtureVersion = APP_VERSION;\n",
      );
      await writeFile(
        join(root, "bin.ts"),
        `export { APPLICATION_VERSION } from ${JSON.stringify(serverVersionModule)};\n`,
      );
      await writeFile(
        join(root, "launcher.ts"),
        `export { APPLICATION_VERSION } from ${JSON.stringify(serverVersionModule)};\n`,
      );

      await compile({
        configFile: false,
        root,
        logLevel: "silent",
        define: webConfig.define,
        plugins: [applicationVersionPlugin(webConfig)],
        build: {
          outDir: webOutput,
          emptyOutDir: true,
          sourcemap: false,
          minify: false,
          modulePreload: false,
        },
      });
      verifyApplicationBuildVersionManifest(webOutput, "web", webVersion);
      const webManifest = await readManifest(webOutput);
      expect(webManifest.applicationVersion).toBe(webVersion);
      const rendererChunks = webManifest.files.filter((entry) => /\.[cm]?js$/u.test(entry.file));
      assert.equal(
        rendererChunks.length,
        1,
        "The inert fixture needs one executable renderer chunk.",
      );
      const rendererCode = await readSmallFile(join(webOutput, rendererChunks[0]!.file));
      const rendererGlobal: Record<string, unknown> = {};
      runInNewContext(rendererCode, rendererGlobal, {
        timeout: 1_000,
        contextCodeGeneration: { strings: false, wasm: false },
      });
      expect(rendererGlobal.__cafeFixtureVersion).toBe(webVersion);

      await compile({
        configFile: false,
        root,
        logLevel: "silent",
        define: serverConfig.define,
        plugins: [serverReceiptPlugin(serverVersion)],
        build: {
          outDir: serverOutput,
          emptyOutDir: true,
          sourcemap: false,
          minify: false,
          modulePreload: false,
          target: "es2022",
          lib: {
            entry: { bin: join(root, "bin.ts"), launcher: join(root, "launcher.ts") },
            formats: ["es"],
            fileName: (_format, entryName) => `${entryName}.mjs`,
          },
          rolldownOptions: { output: { chunkFileNames: "shared-[hash].mjs" } },
        },
      });
      verifyApplicationBuildVersionManifest(serverOutput, "server", serverVersion);
      expect((await readManifest(serverOutput)).applicationVersion).toBe(serverVersion);

      // Runtime environment/global values cannot relabel the already compiled
      // backend. Import only the pure version facades, never a CLI or provider.
      vi.stubEnv("APP_VERSION", "88.77.66-untrusted-runtime");
      vi.stubGlobal("__CAFE_CODE_BUILD_VERSION__", "77.66.55-untrusted-global");
      const [emittedBin, emittedLauncher] = await Promise.all([
        import(/* @vite-ignore */ pathToFileURL(join(serverOutput, "bin.mjs")).href),
        import(/* @vite-ignore */ pathToFileURL(join(serverOutput, "launcher.mjs")).href),
      ]);
      expect(emittedBin.APPLICATION_VERSION).toBe(serverVersion);
      expect(emittedLauncher.APPLICATION_VERSION).toBe(serverVersion);
    },
    20_000,
  );
});
