# restore_data.ps1 - restore a mental-avatar data bundle.
# Usage:
#   powershell -ExecutionPolicy Bypass -File restore_data.ps1 [bundle.zip]
# If bundle.zip is omitted, the newest data_bundle_*.zip in this folder is used.

param([string]$BundleZip = "")

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

if (-not $BundleZip) {
    $latest = Get-ChildItem -Path $ScriptDir -Filter "data_bundle_*.zip" | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $latest) {
        Write-Error "No data_bundle_*.zip found. Pass a bundle path as the first argument."
        exit 1
    }
    $BundleZip = $latest.FullName
}

if (-not (Test-Path $BundleZip)) {
    Write-Error "Bundle file not found: $BundleZip"
    exit 1
}

Write-Host "Restore bundle: $BundleZip"

$dbPath = Join-Path $ProjectRoot "db\knowledge.db"
$vectorsPath = Join-Path $ProjectRoot "db\vectors"
$dataPath = Join-Path $ProjectRoot "data"

if ((Test-Path $dbPath) -or (Test-Path $vectorsPath) -or (Test-Path $dataPath)) {
    $bk = Join-Path $ProjectRoot ("backups\pre_restore_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
    New-Item -ItemType Directory -Force -Path $bk | Out-Null
    if (Test-Path $dbPath) { Copy-Item $dbPath (Join-Path $bk "knowledge.db") -Force }
    if (Test-Path $vectorsPath) { Copy-Item $vectorsPath (Join-Path $bk "vectors") -Recurse -Force }
    if (Test-Path $dataPath) { Copy-Item $dataPath (Join-Path $bk "data") -Recurse -Force }
    Write-Host "Existing data backed up to: $bk"
}

$tmp = Join-Path $env:TEMP ("ma_restore_" + [guid]::NewGuid().ToString("N"))
Expand-Archive -Path $BundleZip -DestinationPath $tmp -Force

$bundleDb = Join-Path $tmp "knowledge.db"
$bundleVectors = Join-Path $tmp "vectors"
$bundleData = Join-Path $tmp "data"

if (-not (Test-Path $bundleDb)) { throw "Bundle is missing knowledge.db" }
if (-not (Test-Path $bundleVectors)) { throw "Bundle is missing vectors folder" }
if (-not (Test-Path $bundleData)) { throw "Bundle is missing data folder" }

New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "db") | Out-Null
Copy-Item $bundleDb $dbPath -Force

if (Test-Path $vectorsPath) { Remove-Item $vectorsPath -Recurse -Force }
Copy-Item $bundleVectors $vectorsPath -Recurse -Force

if (Test-Path $dataPath) { Remove-Item $dataPath -Recurse -Force }
Copy-Item $bundleData $dataPath -Recurse -Force

Remove-Item $tmp -Recurse -Force
Write-Host "Restore complete. db\knowledge.db, db\vectors, and data were replaced from the bundle."
