import { defineConfig } from "tsdown";
import { relative, resolve, sep } from "node:path";
import { publishSourceDebugBuildManifest } from "../../packages/shared/src/sourceDebugBuild.ts";
import {
  publishApplicationBuildVersionManifest,
  resolveApplicationBuildVersion,
} from "../../packages/shared/src/applicationBuildVersion.ts";
import packageJson from "./package.json" with { type: "json" };

const internalPackagePrefixes = ["@cafecode/", "effect-acp", "effect-codex-app-server"];
const applicationVersion = resolveApplicationBuildVersion(
  process.env.APP_VERSION,
  packageJson.version,
);

export default defineConfig([
  {
    entry: ["src/bin.ts", "src/launcher.ts"],
    outDir: "dist",
    sourcemap: true,
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
        publishSourceDebugBuildManifest(
          resolve(root, "bin.mjs"),
          "server",
          output.map((chunk) => resolve(options.cwd, chunk.outDir, chunk.fileName)),
          Object.fromEntries(
            output.map((chunk) => [resolve(options.cwd, chunk.outDir, chunk.fileName), chunk.code]),
          ),
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
      alwaysBundle: (id) => internalPackagePrefixes.some((prefix) => id.startsWith(prefix)),
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
