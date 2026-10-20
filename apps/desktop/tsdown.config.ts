import { defineConfig } from "tsdown";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import { publishSourceDebugBuildManifest } from "../../packages/shared/src/sourceDebugBuild.ts";

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
    hooks: {
      "build:done": ({ options, chunks }) => {
        const root = resolve(options.cwd, options.outDir);
        const output = chunks.filter((chunk) => chunk.type === "chunk");
        publishSourceDebugBuildManifest(
          resolve(root, "main.cjs"),
          "desktop",
          output.map((chunk) => resolve(options.cwd, chunk.outDir, chunk.fileName)),
          Object.fromEntries(
            output.map((chunk) => [resolve(options.cwd, chunk.outDir, chunk.fileName), chunk.code]),
          ),
        );
      },
    },
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
