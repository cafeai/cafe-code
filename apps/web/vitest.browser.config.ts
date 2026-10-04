import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));

export default mergeConfig(
  viteConfig,
  defineConfig({
    // Keep the browser runner's transformed dependency cache apart from the
    // application dev server and Node tests, whose module environments differ.
    cacheDir: "node_modules/.vite/vitest-browser",
    optimizeDeps: {
      // Vitest 5 no longer brings Vite as its own dependency. Prebundle all
      // React entrypoints before assertions begin;
      // discovering react-dom/client later reloads the iframe mid-test.
      include: [
        "react",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "effect/Cron",
      ],
    },
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    server: {
      // The app dev server uses a fixed port, but browser tests need to allow
      // concurrent runs to claim the next available port.
      strictPort: false,
    },
    test: {
      include: ["src/components/**/*.browser.tsx"],
      // Vitest 5 serves the browser runner through the common API server.
      // Keep concurrent browser runs free to claim the next available port.
      api: {
        strictPort: false,
      },
      // Preserve fixtures' explicit setup/call-history behavior across the
      // Vitest 5 default change, matching the shared Node test configuration.
      clearMocks: false,
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
        locators: {
          // Existing browser fixtures use partial accessible-name queries, with
          // exact: true on queries that deliberately require the complete name.
          // Make that established matching policy explicit after the v5 change.
          exact: false,
        },
      },
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
);
