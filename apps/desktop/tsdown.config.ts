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
    entry: ["src/preload.ts"],
  },
]);
