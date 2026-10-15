import { defineConfig } from "tsdown";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    deps: {
      alwaysBundle: (id) => id.startsWith("@cafecode/"),
    },
  },
  {
    ...shared,
    // Electron's sandboxed preload has only a restricted `require`. Bundling
    // these two entries together lets tsdown extract their shared IPC channel
    // constants into a relative CommonJS chunk that the preload cannot load.
    // Keep each preload in its own build so each output is self-contained.
    entry: ["src/preload.ts"],
  },
  {
    ...shared,
    entry: ["src/globalDictationPreload.ts"],
  },
]);
