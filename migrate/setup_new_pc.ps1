# setup_new_pc.ps1 - configure a new Windows PC for mental-avatar.
# Prerequisites:
#   - Repository cloned to D:\MyWork\mental-avatar
#   - Miniconda or Anaconda installed
#   - Node.js installed
# Usage:
#   powershell -ExecutionPolicy Bypass -File migrate\setup_new_pc.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "==== mental-avatar new PC setup ====" -ForegroundColor Cyan

if ($ProjectRoot -ne "D:\MyWork\mental-avatar") {
    Write-Warning "Current path is not D:\MyWork\mental-avatar ($ProjectRoot)."
    Write-Warning "Some saved source-document paths may only open correctly from the default path."
}

Write-Host "`n[1/4] Creating conda env 'avatar' (python 3.11)..." -ForegroundColor Yellow
conda create -y -n avatar python=3.11
conda run -n avatar python -m pip install --upgrade pip

Write-Host "`n[2/4] Installing Python packages..." -ForegroundColor Yellow
conda run -n avatar python -m pip install -r (Join-Path $ProjectRoot "requirements.txt")

Write-Host "`n[3/4] Installing frontend npm packages..." -ForegroundColor Yellow
Push-Location (Join-Path $ProjectRoot "frontend")
npm install
Pop-Location

$dashFront = "D:\MyWork\my-dashboard"
if (Test-Path $dashFront) {
    Push-Location $dashFront
    npm install
    Pop-Location
} else {
    Write-Warning "my-dashboard was not found at $dashFront. Clone it separately if you need dashboard integration."
}

Write-Host "`n[4/4] Checking for data bundle..." -ForegroundColor Yellow
$latestBundle = Get-ChildItem -Path $ScriptDir -Filter "data_bundle_*.zip" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($latestBundle) {
    Write-Host "Restoring data bundle: $($latestBundle.FullName)" -ForegroundColor Yellow
    & (Join-Path $ScriptDir "restore_data.ps1") $latestBundle.FullName
} else {
    Write-Host "No data_bundle_*.zip found. Skipping data restore for a fresh install." -ForegroundColor DarkYellow
}

Write-Host "`n==== Done ====" -ForegroundColor Green
Write-Host "Next steps:"
Write-Host "  - Optional Ollama model: ollama pull gemma4:e2b"
Write-Host "  - Start API: conda run -n avatar python api\server.py"
Write-Host "  - Optional watcher: conda run -n avatar python watcher\file_watcher.py"
Write-Host "  - Start frontend: cd frontend; npm run dev"
