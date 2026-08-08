param(
  [Parameter(Mandatory = $true)][string]$ProjectDirectory,
  [Parameter(Mandatory = $true)][string]$ClaudePath,
  [Parameter(Mandatory = $true)][string]$CodexPath,
  [ValidateSet("recovery", "update-failed", "shutdown-failed")][string]$Mode = "recovery",
  [string]$LogPath = ""
)

$ErrorActionPreference = "Stop"
$resolvedProjectDirectory = (Resolve-Path -LiteralPath $ProjectDirectory).Path
Add-Type -AssemblyName System.Windows.Forms
if ($Mode -ne "recovery") {
  if (-not [IO.Path]::IsPathFullyQualified($LogPath) -or -not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
    throw "Provider update log is unavailable: $LogPath"
  }
  $message = if ($Mode -eq "shutdown-failed") {
    "Cafe Code could not prove that every existing process stopped, so it did not update providers or launch a second instance.`n`nDetails: $LogPath"
  } else {
    "The provider CLI update failed, but Cafe Code restarted successfully.`n`nDetails: $LogPath"
  }
  [void][System.Windows.Forms.MessageBox]::Show(
    $message,
    "Cafe Code provider update",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  exit 0
}

foreach ($providerPath in @($ClaudePath, $CodexPath)) {
  if (-not [IO.Path]::IsPathFullyQualified($providerPath) -or -not (Test-Path -LiteralPath $providerPath -PathType Leaf)) {
    throw "Recorded provider executable is unavailable: $providerPath"
  }
}

$recoveryLogDetail = if ([string]::IsNullOrWhiteSpace($LogPath)) { "" } else { "`n`nThe provider update also failed. Details: $LogPath" }
$choice = [System.Windows.Forms.MessageBox]::Show(
  "Cafe Code could not relaunch. Open a provider in the saved project directory?$recoveryLogDetail`n`nYes: Claude Code`nNo: Codex`nCancel: do nothing",
  "Cafe Code recovery",
  [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
  [System.Windows.Forms.MessageBoxIcon]::Warning
)

if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) {
  exit 0
}

$providerPath = if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) { $ClaudePath } else { $CodexPath }
Start-Process `
  -FilePath $providerPath `
  -WorkingDirectory $resolvedProjectDirectory
