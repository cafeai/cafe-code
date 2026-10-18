// @effect-diagnostics nodeBuiltinImport:off
import * as path from "node:path";
import { acquireBackendProfileGuard } from "../backendProfileGuard.ts";

// This peer owns only synthetic fixture directories and a private IPC channel.
// It never starts a server/provider or accesses an actual application profile.
const configuredBaseDir = process.argv[2];
const dataProfile = process.argv[3];
if (
  !configuredBaseDir ||
  (dataProfile !== "production" && dataProfile !== "debug") ||
  !process.send
)
  process.exit(2);
const baseDir =
  dataProfile === "debug" ? path.join(configuredBaseDir, ".debug") : configuredBaseDir;
const input = {
  configuredBaseDir,
  baseDir,
  dataProfile,
  stateDir: path.join(baseDir, "userdata"),
} as const;
try {
  const guard = await acquireBackendProfileGuard(input);
  process.send({ type: "held" });
  process.on("message", (message) => {
    if (message === "reenter") {
      void acquireBackendProfileGuard(input).then(
        async (unexpected) => {
          await unexpected.close();
          process.send?.({ type: "unexpected-reentry" });
        },
        () => process.send?.({ type: "reentry-refused" }),
      );
    } else if (message === "close") {
      void guard.close().then(
        () => process.exit(0),
        () => process.exit(2),
      );
    }
  });
} catch {
  process.send({ type: "refused" }, () => process.exit(0));
}
