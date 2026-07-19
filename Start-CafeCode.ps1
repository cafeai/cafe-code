param(
  [switch]$Wait,
  [string[]]$DesktopArgs = @()
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $env:USERPROFILE ".cafe-code\launcher-logs"
$launcherLog = Join-Path $logDir "launcher.log"
$stdoutLog = Join-Path $logDir "desktop-start.stdout.log"
$stderrLog = Join-Path $logDir "desktop-start.stderr.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$node = Get-Command -Name "node.exe" -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $node) {
  $node = Get-Command -Name "node" -CommandType Application -ErrorAction SilentlyContinue
}
if ($null -eq $node) {
  throw "Node.js 24.13.1 or newer in the Node 24 release line was not found on PATH."
}

$nodeVersionText = (& $node.Source --version).Trim().TrimStart("v")
$nodeVersion = [Version]$nodeVersionText
if ($nodeVersion.Major -ne 24 -or $nodeVersion -lt [Version]"24.13.1") {
  throw "Cafe Code requires Node.js ^24.13.1; found $nodeVersionText at $($node.Source)."
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

$desktopProcess = Start-Process `
  -FilePath $node.Source `
  -ArgumentList (@("apps/desktop/scripts/start-electron.mjs") + $DesktopArgs) `
  -WorkingDirectory $repo `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog `
  -WindowStyle Hidden `
  -PassThru

if ($Wait) {
  $desktopProcess.WaitForExit()
  exit $desktopProcess.ExitCode
}
