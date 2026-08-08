param(
  [Parameter(Mandatory = $true)][string]$RepoRoot,
  [string[]]$CandidatePaths = @()
)

$ErrorActionPreference = "Stop"
$resolvedRepo = (Resolve-Path -LiteralPath $RepoRoot).Path
$packageJsonPath = Join-Path $resolvedRepo "package.json"
$launcherPath = Join-Path $resolvedRepo "Start-CafeCode.ps1"
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
  throw "Validated Cafe Code launcher is missing: $launcherPath"
}
$package = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
if ($package.name -ne "@cafecode/monorepo") {
  throw "Refusing shortcut repair because RepoRoot is not a Cafe Code checkout."
}

$trustedPowerShell = Join-Path ([Environment]::GetFolderPath("System")) "WindowsPowerShell\v1.0\powershell.exe"
if (-not (Test-Path -LiteralPath $trustedPowerShell -PathType Leaf)) {
  throw "Trusted Windows PowerShell is missing: $trustedPowerShell"
}
$userProfileRoot = [IO.Path]::GetFullPath([Environment]::GetFolderPath("UserProfile")).TrimEnd('\')
$applicationDataRoot = [Environment]::GetFolderPath("ApplicationData")
$expectedArguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$launcherPath`" -Wait"

function Resolve-NormalizedPath {
  param([AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    return $null
  }
  try {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
  } catch {
    return $null
  }
}

function Test-LauncherArguments {
  param([AllowEmptyString()][string]$Arguments)
  if ([string]::IsNullOrWhiteSpace($Arguments)) {
    return $false
  }
  $matches = [regex]::Matches($Arguments, '(?i)(?:^|\s)-File\s+(?:"([^"]+)"|(\S+))')
  if ($matches.Count -ne 1) {
    return $false
  }
  $rawPath = if ($matches[0].Groups[1].Success) { $matches[0].Groups[1].Value } else { $matches[0].Groups[2].Value }
  $argumentPath = Resolve-NormalizedPath -Path $rawPath
  return $null -ne $argumentPath -and $argumentPath.Equals($launcherPath, [StringComparison]::OrdinalIgnoreCase)
}

if ($CandidatePaths.Count -eq 0) {
  $CandidatePaths = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Cafe Code.lnk"),
    (Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs\Cafe Code.lnk"),
    (Join-Path $applicationDataRoot "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Cafe Code.lnk")
  )
}

$shell = New-Object -ComObject WScript.Shell
try {
  foreach ($path in $CandidatePaths) {
    $candidate = Resolve-NormalizedPath -Path $path
    if (
      $null -eq $candidate -or
      [IO.Path]::GetExtension($candidate) -ine ".lnk" -or
      -not $candidate.StartsWith("$userProfileRoot\", [StringComparison]::OrdinalIgnoreCase) -or
      -not (Test-Path -LiteralPath $candidate -PathType Leaf)
    ) {
      continue
    }
    $shortcut = $null
    try {
      $shortcut = $shell.CreateShortcut($candidate)
      $shortcutTarget = Resolve-NormalizedPath -Path $shortcut.TargetPath
      $shortcutWorkingDirectory = Resolve-NormalizedPath -Path $shortcut.WorkingDirectory
      $identifiesCheckout =
        ($null -ne $shortcutTarget -and $shortcutTarget.Equals($launcherPath, [StringComparison]::OrdinalIgnoreCase)) -or
        (
          $null -ne $shortcutTarget -and
          $shortcutTarget.Equals($trustedPowerShell, [StringComparison]::OrdinalIgnoreCase) -and
          $null -ne $shortcutWorkingDirectory -and
          $shortcutWorkingDirectory.Equals($resolvedRepo, [StringComparison]::OrdinalIgnoreCase) -and
          (Test-LauncherArguments -Arguments $shortcut.Arguments)
        )
      if (-not $identifiesCheckout) {
        Write-Output "Skipped shortcut owned by another checkout or application: $candidate"
        continue
      }
      $shortcut.TargetPath = $trustedPowerShell
      $shortcut.Arguments = $expectedArguments
      $shortcut.WorkingDirectory = $resolvedRepo
      $shortcut.Save()
      Write-Output "Updated Cafe Code shortcut: $candidate"
    } finally {
      if ($null -ne $shortcut) {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
      }
    }
  }
} finally {
  [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
}
