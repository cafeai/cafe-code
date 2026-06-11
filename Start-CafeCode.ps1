$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$bun = Join-Path $env:APPDATA "npm\bun.cmd"
$logDir = Join-Path $env:USERPROFILE ".cafe-code\launcher-logs"
$stdoutLog = Join-Path $logDir "desktop-start.stdout.log"
$stderrLog = Join-Path $logDir "desktop-start.stderr.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path -LiteralPath $bun)) {
  throw "Bun was not found at $bun"
}

# The current dev build defaults local HTTPS on, but Windows source installs may
# not have openssl.exe on PATH. Tailscale HTTPS can still front the HTTP backend.
$env:CAFE_CODE_HTTPS_ENABLED = "false"

Start-Process `
  -FilePath $bun `
  -ArgumentList @("run", "--cwd", "apps/desktop", "start") `
  -WorkingDirectory $repo `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -WindowStyle Hidden
