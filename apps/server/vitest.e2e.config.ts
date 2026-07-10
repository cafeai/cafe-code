import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ["integration/**/*.e2e.test.ts"],
      exclude: configDefaults.exclude,
      env: {
        CAFE_CODE_PROVIDER_DAEMON_E2E: "1",
      },
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);
