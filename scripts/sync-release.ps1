# Sync this package into the public Marketplace clone (build dist/ + copy files).
# From the package root:
#   .\scripts\sync-release.ps1
#   .\scripts\sync-release.ps1 -Push -Message "Bump UI copy"
#   npm run sync-release
#
# Default release dir: ..\..\..\taste-profile (sibling of the monorepo under GitHub/)

[CmdletBinding()]
param(
    [string]$ReleaseDir = '',
    [switch]$SkipBuild,
    [switch]$Push,
    [string]$Message = ''
)

$ErrorActionPreference = 'Stop'

$PackageRoot = Split-Path -Parent $PSScriptRoot
if (-not $ReleaseDir) {
    $ReleaseDir = [System.IO.Path]::GetFullPath((Join-Path $PackageRoot '..\..\..\taste-profile'))
}

$SkipNames = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]@('node_modules', '.git', '.tmp-revert'),
    [StringComparer]::OrdinalIgnoreCase
)

function Invoke-RobocopyMirror {
    param([string]$Source, [string]$Destination)

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    & robocopy $Source $Destination /MIR /NFL /NDL /NJH /NJS /nc /ns /np /XD node_modules .git .tmp-revert | Out-Null
    # robocopy: 0-7 = success / no fatal error
    if ($LASTEXITCODE -ge 8) {
        throw "robocopy failed ($LASTEXITCODE): $Source -> $Destination"
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot 'package.json'))) {
    throw "Package root not found: $PackageRoot"
}
if (-not (Test-Path -LiteralPath $ReleaseDir)) {
    throw @"
Release clone not found: $ReleaseDir

Clone it first:
  git clone https://github.com/GZHN/taste-profile.git `"$ReleaseDir`"
Or pass -ReleaseDir path.
"@
}
if (-not (Test-Path -LiteralPath (Join-Path $ReleaseDir '.git'))) {
    throw "Not a git repo: $ReleaseDir"
}

Push-Location $PackageRoot
try {
    if (-not $SkipBuild) {
        Write-Host 'Building dist/...'
        npm run build-local
        if ($LASTEXITCODE -ne 0) {
            throw "build-local failed with exit code $LASTEXITCODE"
        }
    }

    Write-Host "Syncing $PackageRoot -> $ReleaseDir"
    Get-ChildItem -Force -LiteralPath $PackageRoot | ForEach-Object {
        if ($SkipNames.Contains($_.Name)) { return }
        if ($_.Name -eq '.gitignore') { return }

        $dest = Join-Path $ReleaseDir $_.Name
        if ($_.PSIsContainer) {
            Invoke-RobocopyMirror -Source $_.FullName -Destination $dest
        } else {
            Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
        }
    }

    $releaseGitignore = @"
node_modules/
.tmp-revert/
*.log
.DS_Store
Thumbs.db
*.tsbuildinfo
"@
    Set-Content -LiteralPath (Join-Path $ReleaseDir '.gitignore') -Value $releaseGitignore.TrimEnd() -Encoding utf8

    foreach ($name in @('dist\index.js', 'dist\manifest.json', 'dist\style.css', 'manifest.json', 'README.md', 'scripts\install.ps1', 'scripts\sync-release.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $ReleaseDir $name))) {
            throw "Missing after sync: $name"
        }
    }
} finally {
    Pop-Location
}

Write-Host 'Sync complete.'

if (-not $Push) {
    Write-Host @"

Next (in release repo):
  cd `"$ReleaseDir`"
  git status
  git add -A
  git commit -m `"Describe the update`"
  git push
  # optional: gh release create vX.Y.Z
"@
    return
}

if (-not $Message) {
    $Message = "Update Taste Profile $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
}

Push-Location $ReleaseDir
try {
    git add -A
    $status = git status --porcelain
    if (-not $status) {
        Write-Host 'Nothing to commit in release repo.'
        return
    }
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) {
        throw "git commit failed with exit code $LASTEXITCODE"
    }
    git push
    if ($LASTEXITCODE -ne 0) {
        throw "git push failed with exit code $LASTEXITCODE"
    }
    Write-Host 'Pushed to origin.'
} finally {
    Pop-Location
}
