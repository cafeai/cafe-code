import { assert, describe, it } from "@effect/vitest";
import { join } from "node:path";

import { parseJsonText } from "./json-file.ts";
import {
  buildWindowsCmdCommand,
  buildWindowsCmdInvocation,
  buildManagedProviderProbeEnvironment,
  removePathWithRetries,
  selectInstalledWindowsExecutables,
  selectWindowsInstaller,
  waitForPathToDisappear,
} from "./windows-native-artifact-smoke.ts";

describe("Windows native artifact smoke", () => {
  it("selects the single x64 NSIS artifact", () => {
    assert.equal(
      selectWindowsInstaller([
        "Cafe-Code-0.0.51-x64.exe.blockmap",
        "Cafe-Code-0.0.51-x64.exe",
        "builder-debug.yml",
      ]),
      "Cafe-Code-0.0.51-x64.exe",
    );
  });

  it("rejects missing or ambiguous installers", () => {
    assert.throws(() => selectWindowsInstaller([]), /exactly one/);
    assert.throws(
      () => selectWindowsInstaller(["Cafe-Code-1.0.0-x64.exe", "Cafe-Code-2.0.0-x64.exe"]),
      /exactly one/,
    );
  });

  it("selects stable and channel-branded installed executable pairs", () => {
    assert.deepEqual(
      selectInstalledWindowsExecutables([
        "Cafe Code (Alpha).exe",
        "Uninstall Cafe Code (Alpha).exe",
        "resources",
      ]),
      {
        app: "Cafe Code (Alpha).exe",
        uninstaller: "Uninstall Cafe Code (Alpha).exe",
      },
    );
    assert.deepEqual(
      selectInstalledWindowsExecutables([
        "Cafe Code (Nightly).exe",
        "Uninstall Cafe Code (Nightly).exe",
      ]),
      {
        app: "Cafe Code (Nightly).exe",
        uninstaller: "Uninstall Cafe Code (Nightly).exe",
      },
    );
  });

  it("parses BOM-prefixed managed runtime JSON", () => {
    assert.deepEqual(parseJsonText('\uFEFF{"managedProviderRuntimeEnabled":true,"providers":[]}'), {
      managedProviderRuntimeEnabled: true,
      providers: [],
    });
  });

  it("probes managed provider shims with the bundled runtime environment", () => {
    const managedRoot = "C:\\Users\\runneradmin\\AppData\\Local\\CafeCode\\managed";
    const env = buildManagedProviderProbeEnvironment(managedRoot, "codex", {
      Path: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
    const installRoot = join(managedRoot, "providers", "codex", "current");

    assert.equal(
      env.PATH,
      [
        join(installRoot, "node_modules", ".bin"),
        join(managedRoot, "node", "current"),
        "C:\\Windows\\System32",
      ].join(";"),
    );
    assert.equal(env.Path, undefined);
    assert.equal(env.npm_config_prefix, installRoot);
    assert.equal(env.npm_config_cache, join(managedRoot, "npm-cache"));
  });

  it("quotes managed Windows shim commands for cmd.exe", () => {
    const shim =
      "C:\\Users\\runneradmin\\AppData\\Local\\CafeCode\\managed\\providers\\codex\\current\\node_modules\\.bin\\codex.cmd";
    assert.equal(buildWindowsCmdCommand(shim, ["--version"]), `""${shim}" --version"`);
    assert.deepEqual(buildWindowsCmdInvocation(shim, ["--version"]), {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `""${shim}" --version"`],
      windowsVerbatimArguments: true,
    });
  });

  it("supports managed Windows shim commands without arguments", () => {
    const shim =
      "C:\\Users\\runneradmin\\AppData\\Local\\CafeCode\\managed\\providers\\claude\\current\\node_modules\\.bin\\claude.cmd";
    assert.equal(buildWindowsCmdCommand(shim, []), `""${shim}""`);
  });

  it("retries transient Windows cleanup errors before removing the smoke root", async () => {
    let attempts = 0;
    const waits: number[] = [];
    await removePathWithRetries("C:\\temp\\cafecode-smoke", {
      platform: "win32",
      remove: async () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("busy") as NodeJS.ErrnoException;
          error.code = "EBUSY";
          throw error;
        }
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [250, 250]);
  });

  it("does not retry non-Windows cleanup failures", async () => {
    let attempts = 0;
    let error: unknown;
    try {
      await removePathWithRetries("/tmp/cafecode-smoke", {
        platform: "linux",
        remove: async () => {
          attempts += 1;
          const busyError = new Error("busy") as NodeJS.ErrnoException;
          busyError.code = "EBUSY";
          throw busyError;
        },
        sleep: async () => undefined,
      });
    } catch (caught) {
      error = caught;
    }
    assert.instanceOf(error, Error);
    assert.match((error as Error).message, /busy/);
    assert.equal(attempts, 1);
  });

  it("waits for Windows uninstall side effects to remove the app executable", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const disappeared = await waitForPathToDisappear("C:\\temp\\Cafe Code\\Cafe Code.exe", {
      platform: "win32",
      exists: () => {
        attempts += 1;
        return attempts < 3;
      },
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    assert.equal(disappeared, true);
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [250, 250]);
  });

  it("fails fast for persistent uninstall leftovers on non-Windows", async () => {
    const disappeared = await waitForPathToDisappear("/tmp/Cafe Code/Cafe Code.exe", {
      platform: "linux",
      exists: () => true,
      sleep: async () => undefined,
    });
    assert.equal(disappeared, false);
  });
});
