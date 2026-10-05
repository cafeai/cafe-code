import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

// Explicit native qualification: starts a separate Electron with an isolated
// profile and synthetic localhost peers. It never uses Cafe/user credentials.
it.runIf(process.env.CAFE_CODE_REMOTE_TLS_E2E === "1")(
  "qualifies exact-origin certificate approval in real Electron HTTPS and WSS",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-electron-tls-test-"));
    try {
      const source = await readFile(
        new URL("./remoteCertificatePolicy.ts", import.meta.url),
        "utf8",
      );
      await writeFile(join(directory, "policy.mjs"), stripTypeScriptTypes(source));
      for (const name of ["test-only-cert.pem", "test-only-key.pem"]) {
        await copyFile(
          new URL(`./__fixtures__/remote-tls/${name}`, import.meta.url),
          join(directory, name),
        );
      }
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;
      const { stdout } = await execFileAsync(
        require("electron") as string,
        [
          fileURLToPath(new URL("./__fixtures__/remote-tls/electron-probe.cjs", import.meta.url)),
          directory,
        ],
        { env, timeout: 25_000, maxBuffer: 65_536 },
      );
      expect(JSON.parse(stdout.trim())).toEqual({
        https: "passed",
        wss: "passed",
        unapprovedPort: "rejected",
        accepted: 2,
        rejected: 2,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
