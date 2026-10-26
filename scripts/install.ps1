# Installs Taste Profile into Spicetify and restarts Spotify.
# From a clone: .\scripts\install.ps1
# From the web: iwr -useb https://raw.githubusercontent.com/GZHN/taste-profile/main/scripts/install.ps1 | iex

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (Get-Variable -Name 'PSNativeCommandUseErrorActionPreference' -ErrorAction SilentlyContinue) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$AppName = 'taste-profile'
$ArchiveUrl = 'https://github.com/GZHN/taste-profile/archive/refs/heads/main.zip'
$AppFiles = @('index.js', 'manifest.json', 'style.css')

function Invoke-Spicetify {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$SpicetifyArgs
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & spicetify @SpicetifyArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }

    $lines = @(
        $output | ForEach-Object {
            $text = if ($_ -is [System.Management.Automation.ErrorRecord]) {
                if (-not [string]::IsNullOrWhiteSpace("$($_.TargetObject)")) { "$($_.TargetObject)" } else { '' }
            } else {
                "$_"
            }
            ($text -replace '\x1b\[[0-9;]*[A-Za-z]', '').Trim()
        } | Where-Object { $_ -and $_ -ne 'System.Management.Automation.RemoteException' }
    )
    return [pscustomobject]@{
        Lines = $lines
        Code  = $code
    }
}

function Invoke-SpicetifyShown {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$SpicetifyArgs
    )

    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & cmd.exe /c "spicetify $($SpicetifyArgs -join ' ')"
        $script:SpicetifyExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Test-SamePath {
    param([string]$Left, [string]$Right)
    $leftFull = [System.IO.Path]::GetFullPath($Left).TrimEnd('\', '/')
    $rightFull = [System.IO.Path]::GetFullPath($Right).TrimEnd('\', '/')
    return $leftFull.Equals($rightFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function Resolve-AppDirectory {
    param([string]$Root)

    foreach ($folder in @('dist', 'app')) {
        $nested = Join-Path $Root $folder
        if (
            (Test-Path -LiteralPath (Join-Path $nested 'index.js')) -and
            (Test-Path -LiteralPath (Join-Path $nested 'manifest.json'))
        ) {
            return $nested
        }
    }

    if (
        (Test-Path -LiteralPath (Join-Path $Root 'index.js')) -and
        (Test-Path -LiteralPath (Join-Path $Root 'manifest.json'))
    ) {
        return $Root
    }

    return $null
}

function Copy-AppFiles {
    param([string]$Source, [string]$Destination)

    foreach ($name in $AppFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $Source $name))) {
            throw "Missing $name in $Source"
        }
    }

    if (Test-SamePath $Source $Destination) {
        return
    }

    $stage = "$Destination.installing"
    $backup = "$Destination.bak"
    if (Test-Path -LiteralPath $stage) {
        Remove-Item -LiteralPath $stage -Recurse -Force
    }

    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    foreach ($name in $AppFiles) {
        Copy-Item -LiteralPath (Join-Path $Source $name) -Destination $stage
    }

    if (Test-Path -LiteralPath $backup) {
        Remove-Item -LiteralPath $backup -Recurse -Force
    }
    if (Test-Path -LiteralPath $Destination) {
        Rename-Item -LiteralPath $Destination -NewName ([System.IO.Path]::GetFileName($backup))
    }

    try {
        Rename-Item -LiteralPath $stage -NewName $AppName
    } catch {
        if ((Test-Path -LiteralPath $backup) -and -not (Test-Path -LiteralPath $Destination)) {
            Rename-Item -LiteralPath $backup -NewName $AppName
        }
        throw
    }

    if (Test-Path -LiteralPath $backup) {
        Remove-Item -LiteralPath $backup -Recurse -Force
    }
}

function Get-SourceDirectory {
    if ($PSScriptRoot) {
        $repoRoot = Split-Path -Parent $PSScriptRoot
        $localApp = Resolve-AppDirectory -Root $repoRoot
        if ($localApp) {
            Write-Host 'Copying Taste Profile...'
            return $localApp
        }
    }

    Write-Host 'Downloading Taste Profile...'
    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('taste-profile-' + [guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    $script:DownloadTemp = $temp

    $zip = Join-Path $temp 'taste-profile.zip'
    try {
        Invoke-WebRequest -Uri $ArchiveUrl -OutFile $zip -UseBasicParsing
    } catch {
        throw "Could not download Taste Profile. Check your connection, or clone the repo and run .\scripts\install.ps1"
    }

    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $temp 'src') -Force
    $extractedApp = $null
    foreach ($top in Get-ChildItem -LiteralPath (Join-Path $temp 'src') -Directory) {
        $app = Resolve-AppDirectory -Root $top.FullName
        if ($app) {
            $extractedApp = $app
            break
        }
    }
    if (-not $extractedApp) {
        throw 'The download did not contain Taste Profile (need dist/ from npm run build-local).'
    }
    return $extractedApp
}

if (-not (Get-Command -Name 'spicetify' -ErrorAction SilentlyContinue)) {
    throw "Spicetify is not installed or not on PATH. Install it from https://spicetify.app/ and run 'spicetify backup apply' once."
}

Write-Host 'Installing Taste Profile...'
$pathResult = Invoke-Spicetify path userdata
$userdata = $pathResult.Lines |
    ForEach-Object { ($_ -replace '\x1b\[[0-9;]*m', '').Trim() } |
    Where-Object { $_ -match '[\\/]' } |
    Select-Object -Last 1

if ($pathResult.Code -ne 0 -or -not $userdata) {
    $fallback = Join-Path $env:APPDATA 'spicetify'
    if (Test-Path -LiteralPath $fallback) {
        $userdata = $fallback
    } else {
        throw "Could not find the Spicetify config folder. Run 'spicetify' once, then try this again."
    }
}

$destination = Join-Path (Join-Path $userdata 'CustomApps') $AppName
$script:DownloadTemp = $null
try {
    $source = Get-SourceDirectory
    Copy-AppFiles -Source $source -Destination $destination
} finally {
    if ($script:DownloadTemp -and (Test-Path -LiteralPath $script:DownloadTemp)) {
        Remove-Item -LiteralPath $script:DownloadTemp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$enabled = Invoke-Spicetify config custom_apps
$alreadyEnabled = @($enabled.Lines | ForEach-Object { $_.Trim() }) -contains $AppName
if (-not $alreadyEnabled) {
    Write-Host 'Enabling Taste Profile...'
    Invoke-SpicetifyShown config custom_apps $AppName
    if ($script:SpicetifyExit -ne 0) {
        throw "Could not enable Taste Profile. Run: spicetify config custom_apps $AppName"
    }
}

Write-Host 'Restarting Spotify...'
Invoke-SpicetifyShown apply
if ($script:SpicetifyExit -ne 0) {
    throw "Taste Profile is installed, but Spotify was not updated. If Spicetify has not been applied yet, run: spicetify backup apply"
}

Write-Host 'Taste Profile is installed. Open it from the Spotify sidebar.'
