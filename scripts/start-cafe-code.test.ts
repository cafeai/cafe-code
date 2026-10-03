import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, it } from "vitest";

const startCafeCodeScript = fileURLToPath(new URL("../Start-CafeCode.ps1", import.meta.url));

function toPowerShellLiteralPath(path: string): string {
  return path.replaceAll("'", "''");
}

function hasPowerShell(): boolean {
  const result = spawnSync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
    {
      encoding: "utf8",
    },
  );
  return result.error === undefined && result.status === 0;
}

function runPowerShell(script: string): string {
  return execFileSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", script], {
    encoding: "utf8",
  }).trim();
}

const powerShellIt = hasPowerShell() ? it : it.skip;

describe("Start-CafeCode PowerShell helpers", () => {
  powerShellIt(
    "selects the first Node executable when Get-Command returns multiple matches",
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

  powerShellIt("falls back to the next candidate name when the first one is absent", () => {
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
  });

  powerShellIt(
    "admits the canonical LTS line, not a newer Current major or malformed probe",
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
