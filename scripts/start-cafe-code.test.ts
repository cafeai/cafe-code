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
});
