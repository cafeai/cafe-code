import * as path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
