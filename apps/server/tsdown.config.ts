import { defineConfig } from "tsdown";

const internalPackagePrefixes = ["@cafecode/", "effect-acp", "effect-codex-app-server"];

export default defineConfig({
  entry: ["src/bin.ts"],
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) => internalPackagePrefixes.some((prefix) => id.startsWith(prefix)),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
});
