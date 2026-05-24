import { defineConfig } from "tsdown";

const internalPackagePrefixes = ["@cafecode/", "effect-acp", "effect-codex-app-server"];

export default defineConfig({
  entry: ["src/bin.ts", "src/launcher.ts"],
  outDir: "dist",
  sourcemap: true,
  clean: true,
  deps: {
    alwaysBundle: (id) => internalPackagePrefixes.some((prefix) => id.startsWith(prefix)),
    onlyBundle: false,
  },
  dts: {
    eager: true,
  },
  checks: {
    pluginTimings: false,
  },
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
