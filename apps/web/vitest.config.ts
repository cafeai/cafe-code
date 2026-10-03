import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";
import viteConfig from "./vite.config.ts";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

// Vitest 5 no longer searches a parent directory for its shared configuration.
// A root-only --config invocation also bypasses this app's Vite configuration,
// losing its React transforms and source aliases. Explicitly compose both so
// Node tests retain the application resolver and the repository mock policy.
export default mergeConfig(
  mergeConfig(viteConfig, baseConfig),
  defineConfig({
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
  }),
);
