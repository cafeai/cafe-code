import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  outDir: "dist",
  platform: "node",
  format: "esm",
  target: "node24",
  clean: true,
  sourcemap: true,
  deps: { alwaysBundle: [/.*/] },
});
