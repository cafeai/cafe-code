import { defineConfig } from "tsdown";

const internalPackagePrefixes = ["@cafecode/", "effect-codex-app-server"];

export default defineConfig({
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
});
