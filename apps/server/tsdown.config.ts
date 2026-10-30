import { defineConfig } from "tsdown";
// This bundler callback is outside an Effect runtime and binds emitted files
// to the native host namespace used by the version/ownership receipt writer.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { relative, resolve, sep } from "node:path";
import { publishSourceDebugBuildManifest } from "../../packages/shared/src/sourceDebugBuild.ts";
import {
  publishApplicationBuildVersionManifest,
  resolveApplicationBuildVersion,
} from "../../packages/shared/src/applicationBuildVersion.ts";
import packageJson from "./package.json" with { type: "json" };
import { prepareRuntimeDependencies } from "../../scripts/lib/prepare-runtime-dependencies.ts";

const internalPackagePrefixes = ["@cafecode/", "effect-acp", "effect-codex-app-server"];
const applicationVersion = resolveApplicationBuildVersion(
  process.env.APP_VERSION,
  packageJson.version,
);

export default defineConfig([
  {
    entry: { bin: "src/runtimeEntry.ts", backend: "src/bin.ts", launcher: "src/launcher.ts" },
    outDir: "dist",
    sourcemap: false,
    clean: true,
    // Bake identity into the emitted module, not the provider/backend's later
    // environment. Daemon health and native-client identification must agree
    // with the selected artifact even when source manifests have not been bumped.
    define: {
      __CAFE_CODE_BUILD_VERSION__: JSON.stringify(applicationVersion),
    },
    hooks: {
      "build:done": ({ options, chunks }) => {
        const root = resolve(options.cwd, options.outDir);
        const output = chunks.filter((chunk) => chunk.type === "chunk");
        const dependencies = prepareRuntimeDependencies(resolve(options.cwd, "../.."), root);
        publishSourceDebugBuildManifest(
          resolve(root, "bin.mjs"),
          "server",
          [
            ...output.map((chunk) => resolve(options.cwd, chunk.outDir, chunk.fileName)),
            dependencies.file,
          ],
          {
            ...Object.fromEntries(
              output.map((chunk) => [
                resolve(options.cwd, chunk.outDir, chunk.fileName),
                chunk.code,
              ]),
            ),
            [dependencies.file]: dependencies.code,
          },
        );
        publishApplicationBuildVersionManifest(
          root,
          "server",
          applicationVersion,
          Object.fromEntries(
            output.map((chunk) => [
              relative(root, resolve(options.cwd, chunk.outDir, chunk.fileName))
                .split(sep)
                .join("/"),
              chunk.code,
            ]),
          ),
        );
      },
    },
    deps: {
      // The backend needs only patch parsing. Bundling this side-effect-aware
      // package lets the compiler discard its browser renderers/highlighters.
      alwaysBundle: (id) =>
        internalPackagePrefixes.some((prefix) => id.startsWith(prefix)) ||
        id === "@pierre/diffs" ||
        id.startsWith("@pierre/diffs/"),
      onlyBundle: false,
    },
    // The server package publishes CLI/runtime entrypoints, not a typed library API.
    // rolldown-plugin-dts currently fails or takes a very high-memory eager path here.
    dts: false,
    checks: {
      pluginTimings: false,
    },
    banner: {
      js: "#!/usr/bin/env node\n",
    },
  },
  // Providers execute a private copy of just one bridge entrypoint. Separate
  // builds are required: bundling both entries together factors their shared
  // transport into a sibling chunk that is absent from that private directory.
  // Disable splitting within each build as well so future dynamic imports do
  // not reintroduce a dependency on dist or a transient AppImage mount.
  ...Object.entries({
    "mcp-bridge": "src/mcp/localBridgeEntry.ts",
    "scheduling-mcp-bridge": "src/mcp/schedulingBridgeEntry.ts",
    "visualization-mcp-bridge": "src/mcp/visualizationBridgeEntry.ts",
    "glide-mcp-bridge": "src/mcp/glideBridgeEntry.ts",
  }).map(([name, entry]) => ({
    entry: { [name]: entry },
    outDir: "dist",
    clean: false,
    deps: { alwaysBundle: () => true },
    outputOptions: { codeSplitting: false },
    dts: false,
    checks: { pluginTimings: false },
  })),
  // The historical Glide MCP name is an authenticated bridge alias. The
  // kernel remains a separate disposable process owned by the chat broker.
  ...Object.entries({
    "glide-mcp": "src/glide/entry.ts",
    "glide-worker": "src/glide/worker.ts",
  }).map(([name, entry]) => ({
    entry: { [name]: entry },
    outDir: "dist",
    clean: false,
    deps: { alwaysBundle: () => true },
    outputOptions: { codeSplitting: false },
    dts: false,
    checks: { pluginTimings: false },
  })),
]);
