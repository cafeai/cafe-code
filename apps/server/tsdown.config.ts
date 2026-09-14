import { defineConfig } from "tsdown";

const internalPackagePrefixes = ["@cafecode/", "effect-acp", "effect-codex-app-server"];

export default defineConfig([
  {
    entry: ["src/bin.ts", "src/launcher.ts"],
    outDir: "dist",
    sourcemap: true,
    clean: true,
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
    "desktop-mcp-bridge": "src/mcp/desktopBridgeEntry.ts",
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
