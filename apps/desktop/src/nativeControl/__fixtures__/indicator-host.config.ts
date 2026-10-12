import { defineConfig } from "tsdown";
export default defineConfig({
  entry: [new URL("./indicator-host.ts", import.meta.url).pathname],
  format: "cjs",
  outExtensions: () => ({ js: ".cjs" }),
  deps: {
    alwaysBundle: (id) =>
      id.startsWith("@cafecode/") || id === "effect" || id.startsWith("effect/"),
    neverBundle: ["electron"],
  },
});
