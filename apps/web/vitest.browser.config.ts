import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.ts";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const touchTimelineFile = "src/components/chat/MessagesTimeline.touch.browser.tsx";
const touchViewport = { width: 430, height: 932 };
const browserOptions = {
  enabled: true,
  headless: true,
  locators: {
    // Existing browser fixtures use partial accessible-name queries, with
    // exact: true on queries that deliberately require the complete name.
    // Make that established matching policy explicit after the v5 change.
    exact: false,
  },
};

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
      // Vitest 5 serves the browser runner through the common API server.
      // Keep concurrent browser runs free to claim the next available port.
      api: {
        strictPort: false,
      },
      // Preserve fixtures' explicit setup/call-history behavior across the
      // Vitest 5 default change, matching the shared Node test configuration.
      clearMocks: false,
      testTimeout: 30_000,
      hookTimeout: 30_000,
      // Vitest isolates files by replacing the tester iframe, but retains its
      // owning Playwright page/context across files. A CDP device/touch override
      // on that page can therefore outlive the iframe, including after an
      // awaited reset. Initialize the one actual touch fixture in a separate
      // provider-owned context instead of changing desktop worker media state.
      // Keep root include/browser arrays absent: extending projects concatenate
      // those arrays, which would duplicate unrelated fixtures in the touch run.
      projects: [
        {
          extends: true,
          test: {
            name: "desktop",
            include: ["src/components/**/*.browser.tsx"],
            exclude: [...configDefaults.exclude, touchTimelineFile],
            sequence: { groupOrder: 0 },
            browser: {
              ...browserOptions,
              provider: playwright(),
              // Retain the existing public project name and native mouse input.
              instances: [{ browser: "chromium", name: "chromium" }],
            },
          },
        },
        {
          extends: true,
          test: {
            name: "touch",
            include: [touchTimelineFile],
            // Supported project ordering makes the touch run wait for desktop
            // completion. Browser worker caps are per project; parallel projects
            // would add a worker above the existing aggregate limit. Neither
            // worker settings nor test/hook deadlines change, including the
            // native-host --maxWorkers=2 CLI policy inherited by both projects.
            sequence: { groupOrder: 1 },
            browser: {
              ...browserOptions,
              provider: playwright({
                contextOptions: {
                  hasTouch: true,
                  isMobile: true,
                  deviceScaleFactor: 1,
                  viewport: touchViewport,
                },
              }),
              viewport: touchViewport,
              // Vitest/Playwright owns and closes this context at runner exit;
              // it is never reused by any desktop fixture or live application.
              instances: [{ browser: "chromium", name: "chromium-touch" }],
            },
          },
        },
      ],
    },
  }),
);
