import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";
import browserTestPolicy from "./browser-test-policy.json" with { type: "json" };
import viteConfig from "./vite.config.ts";
const { browserStressPattern } = browserTestPolicy;
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      clearMocks: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      include: ["src/components/" + browserStressPattern],
      browser: {
        enabled: true,
        headless: true,
        locators: { exact: false },
        provider: playwright({ contextOptions: { reducedMotion: "no-preference" } }),
        instances: [{ browser: "chromium", name: "chromium-stress" }],
      },
    },
  }),
);
