# Build the Windows artifacts: a zip always, plus an NSIS installer when
# makensis is on PATH. The zip is what the updater downloads; the installer is
# what a person downloads.
#
#   pwsh packaging/bundle-windows.ps1
#
#   BOSS_VERSION   override the version
#   RELEASE_TAG    tag the manifest URLs point at
#   SKIP_BUILD=1   reuse an existing target\release\boss.exe

$ErrorActionPreference = 'Stop'

$PackagingDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $PackagingDir
Set-Location $RepoRoot

$pkg = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$ProductName = $pkg.productName
$BundleId = $pkg.build.appId

# The version the binary reports lives in the workspace Cargo.toml, not in
# package.json — that one belongs to the Electron app.
if ($env:BOSS_VERSION) {
    $Version = $env:BOSS_VERSION
} else {
    $cargo = Get-Content (Join-Path $RepoRoot 'Cargo.toml') -Raw
    $Version = ([regex]::Match($cargo, '(?ms)^\[workspace\.package\].*?^version\s*=\s*"([^"]+)"')).Groups[1].Value
}
if (-not $Version) { throw 'version missing from the workspace Cargo.toml' }

# A prerelease suffix is what marks a beta, the same rule the other scripts use.
$Channel = if ($Version -like '*-*') { 'beta' } else { 'stable' }

$DistDir = if ($env:DIST_DIR) { $env:DIST_DIR } else { Join-Path $RepoRoot 'dist' }
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null

if ($env:SKIP_BUILD -ne '1') {
    Write-Host '==> cargo build --release -p boss-app'
    & cargo build --release -p boss-app
    if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
}

$Binary = Join-Path $RepoRoot 'target\release\boss.exe'
if (-not (Test-Path $Binary)) { throw "no $Binary; build first or unset SKIP_BUILD" }

$Stage = Join-Path $DistDir "$ProductName-$Version-win"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Copy-Item $Binary (Join-Path $Stage 'boss.exe')
Copy-Item (Join-Path $RepoRoot 'resources\icons\icon.ico') (Join-Path $Stage 'icon.ico')

# Bundled binaries are gitignored and fetched by CI, so an empty directory here
# is a local build without them rather than an error.
function Copy-ResourceDir([string]$From, [string]$To) {
    $src = Join-Path $RepoRoot $From
    if ((Test-Path $src) -and (Get-ChildItem $src -Force | Where-Object { $_.Name -ne '.gitkeep' })) {
        New-Item -ItemType Directory -Force -Path $To | Out-Null
        Copy-Item "$src\*" $To -Recurse -Force
        Write-Host "==> bundled $From"
    } else {
        Write-Warning "$From is empty; skipping (run the fetch scripts to include it)"
    }
}
Copy-ResourceDir 'resources\opencode'   (Join-Path $Stage 'resources\opencode')
Copy-ResourceDir 'resources\cua-driver' (Join-Path $Stage 'resources\cua-driver')
Copy-ResourceDir 'resources\cli'        (Join-Path $Stage 'resources\cli')
Copy-ResourceDir 'resources\sites-mcp'  (Join-Path $Stage 'resources\sites-mcp')

# sha512, base64, one line — the same shape the macOS and Linux manifests use.
function Get-Sha512B64([string]$Path) {
    $sha = [System.Security.Cryptography.SHA512]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try { [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $stream.Dispose() }
}

function Write-Manifest([string]$Path, [string]$File, [string]$Url) {
    $manifest = [ordered]@{
        version     = $Version
        name        = [System.IO.Path]::GetFileName($File)
        url         = $Url
        sha512      = Get-Sha512B64 $File
        size        = (Get-Item $File).Length
        releaseDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        channel     = $Channel
    }
    $manifest | ConvertTo-Json | Set-Content -Path $Path -Encoding utf8
    Write-Host "==> $([System.IO.Path]::GetFileName($Path))"
}

function Get-AssetUrl([string]$Name) {
    if ($env:RELEASE_TAG) { "https://github.com/jagonalez/BOSS/releases/download/$($env:RELEASE_TAG)/$Name" } else { $Name }
}

$Zip = Join-Path $DistDir "$ProductName-$Version-win.zip"
if (Test-Path $Zip) { Remove-Item -Force $Zip }
Write-Host "==> $([System.IO.Path]::GetFileName($Zip))"
Compress-Archive -Path "$Stage\*" -DestinationPath $Zip

# Signing is opt-in: signtool with a real certificate, skipped when absent so a
# local build still produces artifacts.
if ($env:WINDOWS_CERT_FILE -and $env:WINDOWS_CERT_PASSWORD) {
    Write-Host '==> signtool'
    & signtool sign /f $env:WINDOWS_CERT_FILE /p $env:WINDOWS_CERT_PASSWORD `
        /fd sha256 /tr http://timestamp.digicert.com /td sha256 (Join-Path $Stage 'boss.exe')
    if ($LASTEXITCODE -ne 0) { throw 'signtool failed' }
} else {
    Write-Warning 'WINDOWS_CERT_FILE / WINDOWS_CERT_PASSWORD not set; leaving the binary unsigned'
}

$Installer = $null
if (Get-Command makensis -ErrorAction SilentlyContinue) {
    $Installer = Join-Path $DistDir "$ProductName-Setup-$Version.exe"
    Write-Host "==> $([System.IO.Path]::GetFileName($Installer))"
    & makensis /DPRODUCT_NAME="$ProductName" /DBUNDLE_ID="$BundleId" /DVERSION="$Version" `
        /DSTAGE_DIR="$Stage" /DOUT_FILE="$Installer" (Join-Path $PackagingDir 'installer.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'makensis failed' }
    if ($env:WINDOWS_CERT_FILE -and $env:WINDOWS_CERT_PASSWORD) {
        & signtool sign /f $env:WINDOWS_CERT_FILE /p $env:WINDOWS_CERT_PASSWORD `
            /fd sha256 /tr http://timestamp.digicert.com /td sha256 $Installer
    }
} else {
    Write-Warning 'makensis not found; producing the zip only'
}

# The zip, not the installer: an update applies itself, and an installer needs
# someone to click through it.
Write-Manifest (Join-Path $DistDir 'latest-windows.json') $Zip (Get-AssetUrl ([System.IO.Path]::GetFileName($Zip)))

Write-Host "==> done: $DistDir"
