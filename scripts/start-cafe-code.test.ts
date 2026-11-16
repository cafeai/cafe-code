import assert from "node:assert/strict";
// This boundary retains exact native child handles and close/signal ownership.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// The synchronous PowerShell fixture owns this private profile until native close.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// Construct the exact native temporary profile passed to the PowerShell child.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { describe, it } from "vitest";

const startCafeCodeScript = fileURLToPath(new URL("../Start-CafeCode.ps1", import.meta.url));

// A cold PowerShell process exceeded Vitest's five-second default on Linux
// under the full parallel CI task graph. Budget only these external-process
// fixtures, with additional Windows headroom; in-memory tests keep the default.
// Bound the child itself too: a synchronous native process cannot be cancelled
// reliably by Vitest's timer while it blocks the worker's JavaScript thread.
const powerShellProcessTimeoutMs = process.platform === "win32" ? 30_000 : 20_000;
const powerShellTestOptions = { timeout: powerShellProcessTimeoutMs + 5_000 };

function toPowerShellLiteralPath(path: string): string {
  return path.replaceAll("'", "''");
}

function hasPowerShell(): boolean {
  const result = spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
    {
      encoding: "utf8",
      timeout: powerShellProcessTimeoutMs,
      killSignal: "SIGKILL",
    },
  );
  if (result.error && "code" in result.error && result.error.code === "ENOENT") return false;
  // Missing optional PowerShell is a conditional skip; a present but broken or
  // hung executable must fail qualification instead of silently skipping it.
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  return true;
}

function runPowerShell(script: string): string {
  return execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: powerShellProcessTimeoutMs,
    killSignal: "SIGKILL",
  }).trim();
}

const powerShellIt = hasPowerShell() ? it : it.skip;

describe("Start-CafeCode PowerShell helpers", () => {
  powerShellIt(
    "preserves HTTPS without Git, OpenSSL or any executable on PATH",
    powerShellTestOptions,
    () => {
      const profile = mkdtempSync(join(tmpdir(), "cafe-launcher-tls-test-"));
      try {
        const result = JSON.parse(
          runPowerShell(`
. '${toPowerShellLiteralPath(startCafeCodeScript)}'
$env:USERPROFILE = '${toPowerShellLiteralPath(profile)}'
$env:PATH = ''
Remove-Item Env:CAFE_CODE_HTTPS_ENABLED -ErrorAction SilentlyContinue
function Resolve-FirstApplicationPath {
  param([string[]]$Names)
  if ($Names[0] -ne 'node.exe') { throw 'Unexpected external tool prerequisite' }
  return '${toPowerShellLiteralPath(process.execPath)}'
}
$script:launchCount = 0
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $RedirectStandardOutput, $RedirectStandardError, $WindowStyle, [switch]$PassThru)
  $script:launchCount += 1
  if ($FilePath -ne '${toPowerShellLiteralPath(process.execPath)}') { throw 'Unexpected runtime' }
  return [pscustomobject]@{ ExitCode = 0 }
}
Invoke-StartCafeCode
ConvertTo-Json -InputObject ([pscustomobject]@{
  launches = $script:launchCount
  httpsOverride = $env:CAFE_CODE_HTTPS_ENABLED
}) -Compress
`),
        ) as unknown;
        assert.deepEqual(result, { launches: 1, httpsOverride: null });
      } finally {
        rmSync(profile, { recursive: true, force: true });
      }
    },
  );

  powerShellIt(
    "selects the first Node executable when Get-Command returns multiple matches",
    powerShellTestOptions,
    () => {
      const selectedPath = runPowerShell(`
. '${toPowerShellLiteralPath(startCafeCodeScript)}'
function Get-Command {
  param([string]$Name, [string]$CommandType, [object]$ErrorAction)

  if ($Name -eq "node.exe") {
    return @(
      [pscustomobject]@{ Path = "C:\\hostedtoolcache\\windows\\node\\24.13.1\\x64\\node.exe" },
      [pscustomobject]@{ Path = "C:\\Program Files\\nodejs\\node.exe" }
    )
  }

  return $null
}

$resolved = Resolve-FirstApplicationPath -Names @("node.exe", "node")
[Console]::Out.Write($resolved)
`);

      assert.equal(selectedPath, "C:\\hostedtoolcache\\windows\\node\\24.13.1\\x64\\node.exe");
    },
  );

  powerShellIt(
    "falls back to the next candidate name when the first one is absent",
    powerShellTestOptions,
    () => {
      const selectedPath = runPowerShell(`
. '${toPowerShellLiteralPath(startCafeCodeScript)}'
function Get-Command {
  param([string]$Name, [string]$CommandType, [object]$ErrorAction)

  if ($Name -eq "node") {
    return [pscustomobject]@{ Path = "C:\\Program Files\\nodejs\\node.exe" }
  }

  return $null
}

$resolved = Resolve-FirstApplicationPath -Names @("node.exe", "node")
[Console]::Out.Write($resolved)
`);

      assert.equal(selectedPath, "C:\\Program Files\\nodejs\\node.exe");
    },
  );

  powerShellIt(
    "admits the canonical LTS line, not a newer Current major or malformed probe",
    powerShellTestOptions,
    () => {
      const result = JSON.parse(
        runPowerShell(`
. '${toPowerShellLiteralPath(startCafeCodeScript)}'
$required = Get-RepositoryNodeVersion
$exact = "v$required"
$newerPatch = "v$($required.Major).$($required.Minor).$($required.Build + 1)"
$older = "v$($required.Major).0.0"
$currentMajor = "v$($required.Major + 2).0.0"
$results = @(
  (Test-SupportedNodeVersion -VersionText $exact -RequiredVersion $required),
  (Test-SupportedNodeVersion -VersionText $newerPatch -RequiredVersion $required),
  (Test-SupportedNodeVersion -VersionText $older -RequiredVersion $required),
  (Test-SupportedNodeVersion -VersionText $currentMajor -RequiredVersion $required),
  (Test-SupportedNodeVersion -VersionText "$exact-rc.1" -RequiredVersion $required),
  (Test-SupportedNodeVersion -VersionText 'lts/*' -RequiredVersion $required),
  (Test-SupportedNodeVersion -VersionText '24.21.0.1' -RequiredVersion $required),
  (Test-SupportedNodeVersion -VersionText '024.21.0' -RequiredVersion $required),
  (Test-SupportedNodeVersion -VersionText '' -RequiredVersion $required)
)
ConvertTo-Json -InputObject $results -Compress
`),
      ) as unknown;
      assert.deepEqual(result, [true, true, false, false, false, false, false, false, false]);
    },
  );
});
