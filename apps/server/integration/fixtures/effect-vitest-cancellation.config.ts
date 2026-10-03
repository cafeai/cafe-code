import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    include: ["integration/fixtures/effect-vitest-cancellation.fixture.ts"],
    // The parent checks fixed lifecycle markers even from the succeeding case.
    silent: false,
    fileParallelism: false,
  },
});
