import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  instrumentManagedInstallerFixture,
  managedInstallerFixtureEnvironment,
} from "./windows-managed-installer-smoke.ts";

describe("native managed-installer fixture isolation", () => {
  it.each(["\n", "\r\n"])(
    "preserves every original installer statement with %j line endings",
    (newline) => {
      const source = readFileSync(
        new URL(
          "../apps/desktop/resources/managed-runtime/install-managed-provider-runtime.ps1",
          import.meta.url,
        ),
        "utf8",
      ).replace(/\r?\n/g, newline);
      const instrumented = instrumentManagedInstallerFixture(source);
      const marker = /^[ \t]*Write-Output 'cafe-installer-fixture:[a-z-]+'\r?\n/gm;
      expect(instrumented.match(marker)).toHaveLength(15);
      expect(instrumented.replace(marker, "")).toBe(source);
      expect(instrumented).toContain("cafe-installer-fixture:prepare-start");
      expect(instrumented).toContain("cafe-installer-fixture:prepare-complete");
    },
  );

  it("refuses missing or duplicated native trace anchors before launching a fixture", () => {
    const source = readFileSync(
      new URL(
        "../apps/desktop/resources/managed-runtime/install-managed-provider-runtime.ps1",
        import.meta.url,
      ),
      "utf8",
    );
    expect(() =>
      instrumentManagedInstallerFixture(source.replace("Set-StrictMode -Version 3.0", "")),
    ).toThrow("trace anchors require review");
    expect(() =>
      instrumentManagedInstallerFixture(source + "\nSet-StrictMode -Version 3.0\n"),
    ).toThrow("trace anchors require review");
  });

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
