[CmdletBinding()]
param(
  [switch]$Enabled,
  [string]$InstallDir = "",
  [string]$LocalAppData = "",
  [string]$UserProfile = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 3.0

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

function Copy-DirectoryContents {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Source directory does not exist: $Source"
  }

  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporaryDestination = Join-Path $parent ("current.tmp-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $temporaryDestination -Force | Out-Null

  try {
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $temporaryDestination -Recurse -Force
    }

    if (Test-Path -LiteralPath $Destination) {
      Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    Move-Item -LiteralPath $temporaryDestination -Destination $Destination -Force
  } catch {
    Remove-Item -LiteralPath $temporaryDestination -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
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
      (Test-Path -LiteralPath (Join-Path $candidate "node.exe") -PathType Leaf) -and
      (Test-Path -LiteralPath (Join-Path $candidate "npm.cmd") -PathType Leaf)
    ) {
      return $candidate
    }
  }

  throw "Could not find packaged managed Node runtime under $nodeRoot."
}

function Seed-FirstRunProviderSettings {
  param([string]$UserProfile)

  $settingsPath = Join-Path $UserProfile ".cafe-code\userdata\settings.json"
  if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    Write-InstallerLog "Existing Cafe settings found; preserving provider runtime settings at $settingsPath."
    return
  }

  $settings = [ordered]@{
    providers = [ordered]@{
      codex = [ordered]@{
        runtimeSource = "bundled"
      }
      claudeAgent = [ordered]@{
        runtimeSource = "bundled"
      }
    }
  }
  Write-JsonFile -Path $settingsPath -Value $settings
  Write-InstallerLog "Seeded first-run provider runtime settings at $settingsPath."
}

function Install-ProviderPackage {
  param(
    [string]$Name,
    [string]$PackageName,
    [string]$ProviderSlug,
    [string]$BinaryName,
    [string]$ManagedRoot,
    [string]$NodeTarget,
    [string]$NpmPath,
    [string]$NpmCache,
    [string]$NpmUserConfig
  )

  $installRoot = Join-Path $ManagedRoot "providers\$ProviderSlug\current"
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null

  $originalPath = [Environment]::GetEnvironmentVariable("PATH", "Process")
  [Environment]::SetEnvironmentVariable("PATH", "$NodeTarget;$originalPath", "Process")
  [Environment]::SetEnvironmentVariable("npm_config_cache", $NpmCache, "Process")
  [Environment]::SetEnvironmentVariable("npm_config_prefix", $installRoot, "Process")
  [Environment]::SetEnvironmentVariable("npm_config_userconfig", $NpmUserConfig, "Process")
  [Environment]::SetEnvironmentVariable("npm_config_update_notifier", "false", "Process")
  [Environment]::SetEnvironmentVariable("npm_config_fund", "false", "Process")
  [Environment]::SetEnvironmentVariable("npm_config_audit", "false", "Process")

  $arguments = @(
    "install",
    "--prefix",
    $installRoot,
    "--cache",
    $NpmCache,
    "--no-audit",
    "--no-fund",
    "--loglevel",
    "warn",
    "$PackageName@latest"
  )

  Write-InstallerLog "Installing $Name provider package $PackageName into $installRoot."
  $output = & $NpmPath @arguments 2>&1
  $exitCode = $LASTEXITCODE
  if ($null -ne $output) {
    foreach ($line in $output) {
      Write-InstallerLog "npm[$Name]: $line"
    }
  }

  $shimPath = Join-Path $installRoot "node_modules\.bin\$BinaryName.cmd"
  $shimExists = Test-Path -LiteralPath $shimPath -PathType Leaf
  Write-InstallerLog "Provider package install finished for $Name with exit code $exitCode; shim exists: $shimExists."

  return [ordered]@{
    provider = $Name
    packageName = $PackageName
    installRoot = $installRoot
    binaryPath = $shimPath
    exitCode = $exitCode
    installed = ($exitCode -eq 0 -and $shimExists)
  }
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

try {
  $resolvedInstallDir = Resolve-InstallerPath -Value $InstallDir -EnvironmentName "ProgramFiles" -Description "installation directory"
  New-Item -ItemType Directory -Path $managedRoot -Force | Out-Null

  $nodeSource = Resolve-ManagedNodeSource -InstallDir $resolvedInstallDir
  $nodeTarget = Join-Path $managedRoot "node\current"
  Copy-DirectoryContents -Source $nodeSource -Destination $nodeTarget

  $nodePath = Join-Path $nodeTarget "node.exe"
  $npmPath = Join-Path $nodeTarget "npm.cmd"
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "Managed node.exe was not copied to $nodePath."
  }
  if (-not (Test-Path -LiteralPath $npmPath -PathType Leaf)) {
    throw "Managed npm.cmd was not copied to $npmPath."
  }
  Write-InstallerLog "Copied managed Node/npm from $nodeSource to $nodeTarget."

  Seed-FirstRunProviderSettings -UserProfile $resolvedUserProfile

  $npmCache = Join-Path $managedRoot "npm-cache"
  New-Item -ItemType Directory -Path $npmCache -Force | Out-Null
  $npmUserConfig = Join-Path $managedRoot "npmrc"
  @(
    "audit=false",
    "fund=false",
    "progress=false",
    "update-notifier=false"
  ) | Set-Content -LiteralPath $npmUserConfig -Encoding UTF8

  $results = @(
    Install-ProviderPackage -Name "Codex" -PackageName "@openai/codex" -ProviderSlug "codex" -BinaryName "codex" -ManagedRoot $managedRoot -NodeTarget $nodeTarget -NpmPath $npmPath -NpmCache $npmCache -NpmUserConfig $npmUserConfig
    Install-ProviderPackage -Name "Claude" -PackageName "@anthropic-ai/claude-code" -ProviderSlug "claude" -BinaryName "claude" -ManagedRoot $managedRoot -NodeTarget $nodeTarget -NpmPath $npmPath -NpmCache $npmCache -NpmUserConfig $npmUserConfig
  )

  Write-JsonFile -Path (Join-Path $managedRoot "install-result.json") -Value ([ordered]@{
    managedProviderRuntimeEnabled = $true
    nodePath = $nodePath
    npmPath = $npmPath
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    providers = $results
  })
} catch {
  $message = $_.Exception.Message
  Write-InstallerLog "Managed provider runtime bootstrap failed: $message"
  Write-JsonFile -Path (Join-Path $managedRoot "install-result.json") -Value ([ordered]@{
    managedProviderRuntimeEnabled = $true
    failed = $true
    error = $message
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  })
}

exit 0
