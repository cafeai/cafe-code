import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 5 changes this default to true. Some fixtures deliberately record
    // calls during shared setup; keep their call-history policy explicit so a
    // runner upgrade does not erase evidence before a test can assert on it.
    clearMocks: false,
    // Successful tests should not flood CI and local terminals with fixture logs.
    // Vitest still prints failures and their captured output in full.
    silent: "passed-only",
  },
  resolve: {
    alias: [
      {
        find: /^@cafecode\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "./packages/contracts/src/index.ts"),
      },
    ],
  },
});
