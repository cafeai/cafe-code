// Opt-in real Node / Chromium / Electron relay qualification, no live provider.
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.ts";
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["test/Relay.e2e.test.ts"],
      exclude: configDefaults.exclude,
      fileParallelism: false,
      maxWorkers: 1,
      hookTimeout: 30_000,
    },
  }),
);
