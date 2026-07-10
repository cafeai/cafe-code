import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Real provider/process handoff tests are opt-in. Keeping them out of default
      // discovery avoids paying transform and worker startup costs for skipped E2E files.
      exclude: [...configDefaults.exclude, "integration/**/*.e2e.test.ts"],
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // Keep process and module isolation explicit. Threads were slower in measurement;
      // shared-module and vm-fork runs exposed cross-file auth/sqlite state and could hang.
      pool: "forks",
      isolate: true,
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide parallel runs they regularly exceed the default 15s budget.
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);
