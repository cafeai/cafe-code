#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { desktopDir } from "./electron-launcher.mjs";

export function desktopDevProcessMarker(root = desktopDir) {
  return `--cafecode-dev-root=${root}`;
}

export function terminateDesktopDevApps({ force = false, root = desktopDir } = {}) {
  const marker = desktopDevProcessMarker(root);

  if (process.platform === "win32") {
    // Query the Windows process table directly in PowerShell. Passing the
    // marker through the environment avoids composing a path into source code
    // interpreted by PowerShell, and shell mode remains disabled.
    const command = [
      "$marker = $env:CAFE_CODE_DEV_PROCESS_MARKER",
      "Get-CimInstance Win32_Process",
      "| Where-Object { $_.CommandLine -like ('*' + $marker + '*') -and $_.ProcessId -ne $PID }",
      `| ForEach-Object { Stop-Process -Id $_.ProcessId${force ? " -Force" : ""} -ErrorAction SilentlyContinue }`,
    ].join(" ");
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      env: { ...process.env, CAFE_CODE_DEV_PROCESS_MARKER: marker },
      stdio: "ignore",
      shell: false,
    });
    return;
  }

  spawnSync("pkill", [force ? "-KILL" : "-TERM", "-f", "--", marker], {
    stdio: "ignore",
    shell: false,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  terminateDesktopDevApps({ force: process.argv.includes("--force") });
}
