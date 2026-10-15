import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { managedInstallerFixtureEnvironment } from "./windows-managed-installer-smoke.ts";

describe("native managed-installer fixture isolation", () => {
  it("binds system modules and private module analysis without inheriting the invoking profile", () => {
    const root = resolve(tmpdir(), "cafe-installer-policy-fixture");
    const systemRoot = join(root, "Windows");
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const node = join(root, "runtime", "node.exe");
    const profile = join(root, "profile");
    const local = join(root, "local");
    expect(
      managedInstallerFixtureEnvironment({ systemRoot, powershell, node, profile, local, root }),
    ).toEqual({
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      USERPROFILE: profile,
      APPDATA: join(profile, "AppData", "Roaming"),
      LOCALAPPDATA: local,
      TEMP: root,
      TMP: root,
      PATH: join(root, "runtime"),
      PSModulePath: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules"),
      PSModuleAnalysisCachePath: join(root, "PowerShellModuleAnalysisCache"),
    });
  });
});
