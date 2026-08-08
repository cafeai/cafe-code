// @effect-diagnostics nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const scriptPath = fileURLToPath(new URL("./repair-cafe-code-shortcuts.ps1", import.meta.url));
const powershellPath = NodePath.join(
  process.env.SystemRoot ?? String.raw`C:\Windows`,
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

const quotePowerShellSingle = (value: string): string => `'${value.replaceAll("'", "''")}'`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Cafe Code shortcut repair", () => {
  it.skipIf(process.platform !== "win32")(
    "rewrites only a shortcut already bound to the validated checkout",
    () => {
      const root = mkdtempSync(NodePath.join(homedir(), "club-code-shortcut-test-"));
      temporaryDirectories.push(root);
      const repoRoot = NodePath.join(root, "checkout");
      mkdirSync(repoRoot, { recursive: true });
      writeFileSync(NodePath.join(repoRoot, "package.json"), '{"name":"@cafecode/monorepo"}\n');
      writeFileSync(NodePath.join(repoRoot, "Start-CafeCode.ps1"), "# fixture\n");

      const recognized = NodePath.join(root, "Cafe Code.lnk");
      const foreign = NodePath.join(root, "Foreign Cafe Code.lnk");
      const unrelated = NodePath.join(root, "Unrelated.lnk");
      const workingOnly = NodePath.join(root, "Working Only Cafe Code.lnk");
      const powershellOwned = NodePath.join(root, "PowerShell Owned Cafe Code.lnk");
      const testHarness = NodePath.join(root, "shortcut-test-harness.ps1");
      writeFileSync(
        testHarness,
        [
          "$ErrorActionPreference = 'Stop'",
          "$shell = New-Object -ComObject WScript.Shell",
          "function New-TestShortcut {",
          "  param([string]$Path, [string]$Target, [string]$Working = '', [string]$Arguments = '')",
          "  $shortcut = $shell.CreateShortcut($Path)",
          "  try {",
          "    $shortcut.TargetPath = $Target",
          "    if ($Working) { $shortcut.WorkingDirectory = $Working }",
          "    if ($Arguments) { $shortcut.Arguments = $Arguments }",
          "    $shortcut.Save()",
          "  } finally {",
          "    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)",
          "  }",
          "}",
          `New-TestShortcut ${quotePowerShellSingle(recognized)} ${quotePowerShellSingle(NodePath.join(repoRoot, "Start-CafeCode.ps1"))} ${quotePowerShellSingle(repoRoot)}`,
          `New-TestShortcut ${quotePowerShellSingle(foreign)} 'C:\\old\\Start-CafeCode.ps1' 'C:\\old'`,
          `New-TestShortcut ${quotePowerShellSingle(unrelated)} 'C:\\Windows\\notepad.exe'`,
          `New-TestShortcut ${quotePowerShellSingle(workingOnly)} 'C:\\Windows\\notepad.exe' ${quotePowerShellSingle(repoRoot)}`,
          `New-TestShortcut ${quotePowerShellSingle(powershellOwned)} ${quotePowerShellSingle(powershellPath)} ${quotePowerShellSingle(repoRoot)} ${quotePowerShellSingle(`-NoProfile -File "${NodePath.join(repoRoot, "Start-CafeCode.ps1")}" -Wait`)}`,
          "[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)",
          `& ${quotePowerShellSingle(scriptPath)} -RepoRoot ${quotePowerShellSingle(repoRoot)} -CandidatePaths @(${[recognized, powershellOwned, workingOnly, foreign].map(quotePowerShellSingle).join(", ")}) | Out-Null`,
          "$shell = New-Object -ComObject WScript.Shell",
          `$known = $shell.CreateShortcut(${quotePowerShellSingle(recognized)})`,
          `$foreign = $shell.CreateShortcut(${quotePowerShellSingle(foreign)})`,
          `$other = $shell.CreateShortcut(${quotePowerShellSingle(unrelated)})`,
          `$workingOnly = $shell.CreateShortcut(${quotePowerShellSingle(workingOnly)})`,
          `$powershellOwned = $shell.CreateShortcut(${quotePowerShellSingle(powershellOwned)})`,
          "[PSCustomObject]@{ KnownTarget = $known.TargetPath; KnownArguments = $known.Arguments; KnownWorking = $known.WorkingDirectory; ForeignTarget = $foreign.TargetPath; OtherTarget = $other.TargetPath; WorkingOnlyTarget = $workingOnly.TargetPath; PowershellOwnedArguments = $powershellOwned.Arguments } | ConvertTo-Json -Compress",
          "$known, $foreign, $other, $workingOnly, $powershellOwned | ForEach-Object { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($_) }",
          "[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)",
        ].join("\n"),
      );
      const observed = JSON.parse(
        execFileSync(
          powershellPath,
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", testHarness],
          { encoding: "utf8" },
        ),
      ) as {
        KnownTarget: string;
        KnownArguments: string;
        KnownWorking: string;
        ForeignTarget: string;
        OtherTarget: string;
        WorkingOnlyTarget: string;
        PowershellOwnedArguments: string;
      };
      expect(observed.KnownTarget.toLowerCase()).toBe(powershellPath.toLowerCase());
      expect(observed.KnownArguments).toContain(NodePath.join(repoRoot, "Start-CafeCode.ps1"));
      expect(observed.KnownWorking.toLowerCase()).toBe(repoRoot.toLowerCase());
      expect(observed.ForeignTarget.toLowerCase()).toBe(
        String.raw`C:\old\Start-CafeCode.ps1`.toLowerCase(),
      );
      expect(observed.OtherTarget.toLowerCase()).toBe(
        String.raw`C:\Windows\notepad.exe`.toLowerCase(),
      );
      expect(observed.WorkingOnlyTarget.toLowerCase()).toBe(
        String.raw`C:\Windows\notepad.exe`.toLowerCase(),
      );
      expect(observed.PowershellOwnedArguments).toContain("-NoLogo -NoProfile");
      expect(observed.PowershellOwnedArguments).toContain("-Wait");
    },
    process.platform === "win32" ? 120_000 : 5_000,
  );
});
