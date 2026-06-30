import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@cafecode/contracts";

import {
  CAFE_CODE_BUNDLED_NODE_DIR_ENV,
  CAFE_CODE_BUNDLED_NPM_PATH_ENV,
  CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV,
  resolveProviderRuntimeEnvironment,
} from "./managedProviderRuntime.ts";

const codexDriver = ProviderDriverKind.make("codex");
const codexMaintenance = {
  provider: codexDriver,
  npmPackageName: "@openai/codex",
  homebrewFormula: "codex",
  nativeUpdate: null,
} as const;

describe("managedProviderRuntime", () => {
  it("resolves Windows bundled Codex to Cafe-managed provider and npm paths", () => {
    const runtime = resolveProviderRuntimeEnvironment({
      provider: codexDriver,
      runtimeSource: "bundled",
      systemBinaryPath: "codex",
      packageMaintenance: codexMaintenance,
      platform: "win32",
      baseEnv: {
        LOCALAPPDATA: "C:\\Users\\sshuser\\AppData\\Local",
        PATH: "C:\\Windows\\System32",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
    });

    expect(runtime.unavailableReason).toBeNull();
    expect(runtime.layout).toMatchObject({
      providerRoot: "C:\\Users\\sshuser\\AppData\\Local\\CafeCode\\managed\\providers\\codex",
      installRoot:
        "C:\\Users\\sshuser\\AppData\\Local\\CafeCode\\managed\\providers\\codex\\current",
      binaryDir:
        "C:\\Users\\sshuser\\AppData\\Local\\CafeCode\\managed\\providers\\codex\\current\\node_modules\\.bin",
      binaryPath:
        "C:\\Users\\sshuser\\AppData\\Local\\CafeCode\\managed\\providers\\codex\\current\\node_modules\\.bin\\codex.cmd",
      nodeDir: "C:\\Users\\sshuser\\AppData\\Local\\CafeCode\\managed\\node\\current",
      npmPath: "C:\\Users\\sshuser\\AppData\\Local\\CafeCode\\managed\\node\\current\\npm.cmd",
    });
    expect(runtime.binaryPath).toBe(runtime.layout!.binaryPath);
    expect(runtime.env.PATH?.split(";").slice(0, 3)).toEqual([
      runtime.layout!.binaryDir,
      runtime.layout!.nodeDir,
      "C:\\Windows\\System32",
    ]);
    expect(runtime.env.npm_config_prefix).toBe(runtime.layout!.npmPrefixDir);
    expect(runtime.env.npm_config_cache).toBe(runtime.layout!.npmCacheDir);
    expect(runtime.maintenanceCapabilities.update).toEqual({
      command: `${runtime.layout!.npmPath} install --prefix ${runtime.layout!.npmPrefixDir} --cache ${runtime.layout!.npmCacheDir} @openai/codex@latest`,
      executable: runtime.layout!.npmPath,
      args: [
        "install",
        "--prefix",
        runtime.layout!.npmPrefixDir,
        "--cache",
        runtime.layout!.npmCacheDir,
        "@openai/codex@latest",
      ],
      lockKey: "managed-npm:codex",
    });
  });

  it("honors explicit managed runtime path overrides on Windows", () => {
    const runtime = resolveProviderRuntimeEnvironment({
      provider: codexDriver,
      runtimeSource: "bundled",
      systemBinaryPath: "codex",
      packageMaintenance: codexMaintenance,
      platform: "win32",
      baseEnv: {
        [CAFE_CODE_MANAGED_RUNTIME_ROOT_ENV]: "D:\\CafeManaged",
        [CAFE_CODE_BUNDLED_NODE_DIR_ENV]: "D:\\CafeNode",
        [CAFE_CODE_BUNDLED_NPM_PATH_ENV]: "D:\\CafeNode\\npm.cmd",
        PATH: "C:\\Windows\\System32",
      },
    });

    expect(runtime.layout).toMatchObject({
      providerRoot: "D:\\CafeManaged\\providers\\codex",
      binaryPath: "D:\\CafeManaged\\providers\\codex\\current\\node_modules\\.bin\\codex.cmd",
      nodeDir: "D:\\CafeNode",
      npmPath: "D:\\CafeNode\\npm.cmd",
    });
  });

  it("does not fall back to a system command when bundled mode is selected off Windows", () => {
    const runtime = resolveProviderRuntimeEnvironment({
      provider: codexDriver,
      runtimeSource: "bundled",
      systemBinaryPath: "codex",
      packageMaintenance: codexMaintenance,
      platform: "linux",
      baseEnv: {
        PATH: "/usr/local/bin:/usr/bin",
      },
    });

    expect(runtime.layout).toBeNull();
    expect(runtime.binaryPath).toBe("/__cafecode_bundled_runtime_unavailable__/codex");
    expect(runtime.unavailableReason).toBe(
      "Cafe Code bundled provider runtimes are currently supported only on Windows.",
    );
    expect(runtime.maintenanceCapabilities.update).toBeNull();
  });
});
