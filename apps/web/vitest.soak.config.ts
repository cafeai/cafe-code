import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.config.ts";
import viteConfig from "./vite.config.ts";
export default mergeConfig(
  mergeConfig(viteConfig, baseConfig),
  defineConfig({ test: { include: ["src/rpc/*.soak.test.ts"] } }),
);
