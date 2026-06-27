# restore_data.ps1 — 데이터 번들(zip)을 mental-avatar에 복원
# 사용법: powershell -ExecutionPolicy Bypass -File restore_data.ps1 [번들.zip 경로]
#   인자 생략 시 같은 폴더에서 가장 최근 data_bundle_*.zip 자동 선택

param([string]$BundleZip = "")

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir   # migrate/ 의 부모 = 프로젝트 루트

# 번들 zip 결정
if (-not $BundleZip) {
    $latest = Get-ChildItem -Path $ScriptDir -Filter "data_bundle_*.zip" | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $latest) { Write-Error "data_bundle_*.zip 을 찾을 수 없습니다. 번들 경로를 인자로 주세요."; exit 1 }
    $BundleZip = $latest.FullName
}
Write-Host "복원 번들: $BundleZip"

# 기존 데이터가 있으면 안전하게 백업
$dbPath = Join-Path $ProjectRoot "db\knowledge.db"
$vectorsPath = Join-Path $ProjectRoot "db\vectors"
$dataPath = Join-Path $ProjectRoot "data"
if ((Test-Path $dbPath) -or (Test-Path $vectorsPath) -or (Test-Path $dataPath)) {
    $bk = Join-Path $ProjectRoot ("backups\pre_restore_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
    New-Item -ItemType Directory -Force -Path $bk | Out-Null
    if (Test-Path $dbPath)      { Copy-Item $dbPath      (Join-Path $bk "knowledge.db") -Force }
    if (Test-Path $vectorsPath) { Copy-Item $vectorsPath (Join-Path $bk "vectors") -Recurse -Force }
    if (Test-Path $dataPath)    { Copy-Item $dataPath    (Join-Path $bk "data") -Recurse -Force }
    Write-Host "기존 데이터를 안전 백업: $bk"
}

# 번들 압축 해제 (임시 폴더)
$tmp = Join-Path $env:TEMP ("ma_restore_" + [guid]::NewGuid().ToString("N"))
Expand-Archive -Path $BundleZip -DestinationPath $tmp -Force

# 복원: db/knowledge.db, db/vectors, data
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "db") | Out-Null
Copy-Item (Join-Path $tmp "knowledge.db") $dbPath -Force
if (Test-Path $vectorsPath) { Remove-Item $vectorsPath -Recurse -Force }
Copy-Item (Join-Path $tmp "vectors") $vectorsPath -Recurse -Force
if (Test-Path $dataPath) { Remove-Item $dataPath -Recurse -Force }
Copy-Item (Join-Path $tmp "data") $dataPath -Recurse -Force

Remove-Item $tmp -Recurse -Force
Write-Host "복원 완료 — db\knowledge.db, db\vectors, data 가 번들로 교체되었습니다."
