import { defineConfig } from "tsdown";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { resolve } from "node:path";
import { publishSourceDebugBuildManifest } from "../../packages/shared/src/sourceDebugBuild.ts";
import { prepareRuntimeDependencies } from "../../scripts/lib/prepare-runtime-dependencies.ts";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: false,
  outExtensions: () => ({ js: ".cjs" }),
};

export default defineConfig([
  {
    ...shared,
    entry: { main: "src/runtimeMain.ts", "desktop-main": "src/main.ts" },
    clean: true,
    hooks: {
      "build:done": ({ options, chunks }) => {
        const root = resolve(options.cwd, options.outDir);
        const output = chunks.filter((chunk) => chunk.type === "chunk");
        const dependencies = prepareRuntimeDependencies(resolve(options.cwd, "../.."), root);
        publishSourceDebugBuildManifest(
          resolve(root, "main.cjs"),
          "desktop",
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
