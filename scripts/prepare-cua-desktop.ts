import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Run before Turbo's cache lookup: a cached JS bundle cannot materialize an
// ignored native executable in a fresh worktree. Verified existing bytes are
// reused without network access; first preparation builds the exact source pin.
if (process.platform === "darwin") {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./prepare-cua-driver.ts", import.meta.url))],
    {
      env: process.env,
      shell: false,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
