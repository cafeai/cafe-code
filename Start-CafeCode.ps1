$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$bun = Join-Path $env:APPDATA "npm\bun.cmd"
$logDir = Join-Path $env:USERPROFILE ".cafe-code\launcher-logs"
$launcherLog = Join-Path $logDir "launcher.log"
$stdoutLog = Join-Path $logDir "desktop-start.stdout.log"
$stderrLog = Join-Path $logDir "desktop-start.stderr.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path -LiteralPath $bun)) {
  throw "Bun was not found at $bun"
}

# The current dev build defaults local HTTPS on. Source installs on Windows do
# not always have OpenSSL available on PATH, so only disable backend HTTPS when
# the helper the backend uses to mint the local certificate is not discoverable.
# Use CommandType Application so aliases/functions cannot spoof this readiness
# check; if OpenSSL exists, let the normal desktop settings/exposure flow decide.
$openssl = Get-Command -Name "openssl.exe" -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $openssl) {
  $openssl = Get-Command -Name "openssl" -CommandType Application -ErrorAction SilentlyContinue
}

if ($null -eq $openssl) {
  $env:CAFE_CODE_HTTPS_ENABLED = "false"
  "OpenSSL was not found on PATH; starting Cafe Code with local backend HTTPS disabled." |
    Add-Content -LiteralPath $launcherLog
} else {
  "OpenSSL was found on PATH; preserving Cafe Code local backend HTTPS defaults." |
    Add-Content -LiteralPath $launcherLog
}

Start-Process `
  -FilePath $bun `
  -ArgumentList @("run", "--cwd", "apps/desktop", "start") `
  -WorkingDirectory $repo `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -WindowStyle Hidden
