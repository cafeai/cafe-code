[CmdletBinding()]
param(
  [switch]$Enabled,
  [string]$InstallDir = "",
  [string]$LocalAppData = "",
  [string]$UserProfile = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

# Resolve the two inbox modules directly from this Windows PowerShell install.
# With a fresh profile/cache, unqualified command discovery can scan unrelated
# installed modules before the first Join-Path. Explicit manifests also prevent
# a user-installed module from supplying these installer filesystem commands.
# Import within this invocation: no cache warm-up or security-policy changes.
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop

function Resolve-InstallerPath {
  param(
    [string]$Value,
    [string]$EnvironmentName,
    [string]$Description
  )

  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    return $Value.Trim()
  }

  $environmentValue = [Environment]::GetEnvironmentVariable($EnvironmentName)
  if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
    return $environmentValue.Trim()
  }

  throw "Could not resolve $Description from installer argument or $EnvironmentName."
}

function Write-JsonFile {
  param(
    [string]$Path,
    [object]$Value
  )

  $parent = Split-Path -Parent $Path
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $Value | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Resolve-ManagedNodeSource {
  param([string]$InstallDir)

  $nodeRoot = Join-Path $InstallDir "resources\managed-runtime\node"
  $processorArchitecture = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
  $processorArchitecture6432 = [Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITEW6432")
  $architecture = "$processorArchitecture $processorArchitecture6432"

  $candidateNames = if ($architecture -match "ARM64") {
    @("win-arm64", "win-x64")
  } else {
    @("win-x64", "win-arm64")
  }

  foreach ($candidateName in $candidateNames) {
    $candidate = Join-Path $nodeRoot $candidateName
    if (
      (Test-Path -LiteralPath (Join-Path $candidate "node.exe") -PathType Leaf)
    ) {
      return $candidate
    }
  }

  throw "Could not find packaged managed Node runtime under $nodeRoot."
}

function Assert-ManagedDirectory {
  param([string]$Path)
  $current = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrEmpty($current)) {
    if (Test-Path -LiteralPath $current) {
      $entry = Get-Item -LiteralPath $current -Force
      if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unsafe managed directory."
      }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }
    $current = $parent
  }
  [IO.Directory]::CreateDirectory($Path) | Out-Null
}

function Assert-RegularRecord {
  param([string]$Path)
  $entry = Get-Item -LiteralPath $Path -Force
  if ($entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.Length -gt 1048576) {
    throw "Unsafe managed record."
  }
}

function Write-ExclusiveUtf8 {
  param([string]$Path, [string]$Contents)
  $bytes = [Text.Encoding]::UTF8.GetBytes($Contents)
  $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}

function Publish-ManagedRecord {
  param([string]$Path, [string]$Contents)
  $id = [Guid]::NewGuid().ToString("N")
  $temporary = "$Path.$id.tmp"
  $backup = "$Path.$id.previous"
  Write-ExclusiveUtf8 -Path $temporary -Contents $Contents
  $existed = Test-Path -LiteralPath $Path
  if ($existed) {
    Assert-RegularRecord -Path $Path
    [IO.File]::Replace($temporary, $Path, $backup)
  } else { [IO.File]::Move($temporary, $Path) }
  return @{ Path = $Path; Contents = $Contents; Existed = $existed; Backup = $backup }
}

function Restore-ManagedRecord {
  param([object]$Record)
  if ($null -eq $Record) { return }
  Assert-RegularRecord -Path $Record.Path
  if ([IO.File]::ReadAllText($Record.Path) -cne $Record.Contents) {
    throw "Managed publication changed; recovery evidence retained."
  }
  if ($Record.Existed) {
    [IO.File]::Replace($Record.Backup, $Record.Path, ($Record.Path + ".interrupted-" + [Guid]::NewGuid().ToString("N")))
  } else { [IO.File]::Delete($Record.Path) }
}

$resolvedLocalAppData = Resolve-InstallerPath -Value $LocalAppData -EnvironmentName "LOCALAPPDATA" -Description "LOCALAPPDATA"
$resolvedUserProfile = Resolve-InstallerPath -Value $UserProfile -EnvironmentName "USERPROFILE" -Description "USERPROFILE"
$cafeRoot = Join-Path $resolvedLocalAppData "CafeCode"
$managedRoot = Join-Path $cafeRoot "managed"
$script:InstallerLogPath = Join-Path $cafeRoot "installer-managed-runtime.log"

New-Item -ItemType Directory -Path $cafeRoot -Force | Out-Null

function Write-InstallerLog {
  param([string]$Message)

  $timestamp = (Get-Date).ToUniversalTime().ToString("o")
  Add-Content -LiteralPath $script:InstallerLogPath -Encoding UTF8 -Value "[$timestamp] $Message"
}

Write-JsonFile -Path (Join-Path $cafeRoot "installer-options.json") -Value ([ordered]@{
  managedProviderRuntimeEnabled = [bool]$Enabled
  installDir = $InstallDir
  updatedAt = (Get-Date).ToUniversalTime().ToString("o")
})

if (-not $Enabled) {
  Write-InstallerLog "Managed provider runtime disabled by installer option."
  exit 0
}

$script:InstallerPhase = "resolve"
$script:PreparationExit = "unknown"
try {
  $resolvedInstallDir = Resolve-InstallerPath -Value $InstallDir -EnvironmentName "ProgramFiles" -Description "installation directory"
  Assert-ManagedDirectory -Path $managedRoot

  $nodeSource = Resolve-ManagedNodeSource -InstallDir $resolvedInstallDir
  $architecture = Split-Path -Leaf $nodeSource
  $bundleSource = Join-Path $resolvedInstallDir "resources\managed-runtime\providers\$architecture"
  $nodePath = Join-Path $nodeSource "node.exe"
  $installer = Join-Path $resolvedInstallDir "resources\managed-runtime\install-runtime.mjs"
  $settingsPath = Join-Path $resolvedUserProfile ".cafe-code\userdata\settings.json"
  # Hold an OS-enforced installer guard. A dead installer releases it without
  # granting authority based on a PID or stale timestamp.
  $guardPath = Join-Path $managedRoot "installer.guard"
  $script:InstallerPhase = "guard"
  $guard = [IO.File]::Open($guardPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    [Environment]::SetEnvironmentVariable("NODE_OPTIONS", $null, "Process")
    [Environment]::SetEnvironmentVariable("NODE_PATH", $null, "Process")
    $script:InstallerPhase = "prepare"
    $prepared = @(& $nodePath $installer --prepare $bundleSource $managedRoot)
    $nativeExit = $ExecutionContext.SessionState.PSVariable.GetValue("LASTEXITCODE")
    if ($nativeExit -is [int]) { $script:PreparationExit = [string]$nativeExit }
    if ($LASTEXITCODE -ne 0 -or $prepared.Count -ne 1 -or $prepared[0] -cnotmatch '^[a-f0-9]{32}$') {
      throw "Managed runtime preparation failed."
    }
    $generation = [string]$prepared[0]
    $script:InstallerPhase = "generation"
    $generationRoot = Join-Path $managedRoot "generations\$generation"
    if (-not (Test-Path -LiteralPath $generationRoot -PathType Container)) { throw "Prepared generation is absent." }
    Assert-ManagedDirectory -Path $generationRoot
    $settingsParent = Split-Path -Parent $settingsPath
    $script:InstallerPhase = "settings"
    Assert-ManagedDirectory -Path $settingsParent
    $settingsTemporary = Join-Path $settingsParent (".managed-settings-" + $generation + ".tmp")
    $settingsJson = @{ providers = @{ codex = @{ runtimeSource = "bundled" }; claudeAgent = @{ runtimeSource = "bundled" } } } | ConvertTo-Json -Depth 6 -Compress
    Write-ExclusiveUtf8 -Path $settingsTemporary -Contents $settingsJson
    $activation = $null
    $result = $null
    try {
      $script:InstallerPhase = "publication"
      $activationJson = @{ version = 1; generation = $generation } | ConvertTo-Json -Compress
      $activation = Publish-ManagedRecord -Path (Join-Path $managedRoot "active-runtime.json") -Contents $activationJson
      $resultJson = @{
        managedProviderRuntimeEnabled = $true
        generation = $generation
        nodePath = (Join-Path $generationRoot "node\node.exe")
        providers = @(@{ provider = "Codex"; installed = $true }, @{ provider = "Claude"; installed = $true })
      } | ConvertTo-Json -Depth 6 -Compress
      $result = Publish-ManagedRecord -Path (Join-Path $managedRoot "install-result.json") -Contents $resultJson
      if (Test-Path -LiteralPath $settingsPath) { Assert-RegularRecord -Path $settingsPath }
      else {
        try { [IO.File]::Move($settingsTemporary, $settingsPath) }
        catch {
          # A concurrently created valid preference wins; never overwrite it.
          if (-not (Test-Path -LiteralPath $settingsPath)) { throw }
          Assert-RegularRecord -Path $settingsPath
        }
      }
      # Settings publication is the final fallible commit operation. Orphaned
      # temporaries/backups are retained for repair, never blindly removed.
    } catch {
      Restore-ManagedRecord -Record $result
      Restore-ManagedRecord -Record $activation
      throw
    }
  } finally { $guard.Dispose() }
  try { Write-InstallerLog "Verified managed provider generation activated." } catch { }

} catch {
  # Fixed phase and numeric metadata only: no exception text, provider output,
  # credentials or user paths enter the persistent installer diagnostics.
  $failureLine = [int]$_.InvocationInfo.ScriptLineNumber
  $failureCode = [int]$_.Exception.HResult
  try { Write-InstallerLog "Bootstrap failure phase=$script:InstallerPhase nativeExit=$script:PreparationExit line=$failureLine hresult=$failureCode" } catch { }
  try { Write-InstallerLog "Managed provider runtime bootstrap failed. Re-run the installer to repair; the prior generation is retained." } catch { }
  exit 1
}

exit 0
