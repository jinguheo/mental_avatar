# setup_new_pc.ps1 — 새 PC에서 mental-avatar 실행 환경 구성
# 전제: git clone 으로 D:\MyWork\mental-avatar 와 D:\MyWork\my-dashboard 가 이미 받아져 있음
#       miniconda(또는 anaconda)와 Node.js, Ollama 가 설치돼 있음
# 사용법: powershell -ExecutionPolicy Bypass -File setup_new_pc.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "==== mental-avatar 새 PC 셋업 ====" -ForegroundColor Cyan

# 0) 경로 확인 — 같은 경로(D:\MyWork\mental-avatar) 사용 강력 권장
if ($ProjectRoot -ne "D:\MyWork\mental-avatar") {
    Write-Warning "현재 경로가 D:\MyWork\mental-avatar 가 아닙니다 ($ProjectRoot)."
    Write-Warning "DB에 일부 문서의 원본 경로가 D:\MyWork\mental-avatar\docs\... 로 박혀 있어,"
    Write-Warning "경로가 다르면 해당 문서의 '원본 열기'만 동작하지 않습니다(검색/내용/임베딩은 정상)."
}

# 1) conda avatar 환경 생성 (Python 3.11)
Write-Host "`n[1/4] conda 'avatar' 환경 생성 (python 3.11)..." -ForegroundColor Yellow
conda create -y -n avatar python=3.11
conda run -n avatar python -m pip install --upgrade pip

# 2) Python 의존성 설치
#    중요: chromadb 는 db/vectors 호환을 위해 1.5.9 로 고정
Write-Host "`n[2/4] Python 패키지 설치 (chromadb==1.5.9 고정)..." -ForegroundColor Yellow
conda run -n avatar python -m pip install -r (Join-Path $ProjectRoot "requirements.txt")
conda run -n avatar python -m pip install "chromadb==1.5.9"
# torch(CUDA)는 GPU에 맞춰 별도 설치 필요 — 음성/영상 기능 쓸 때만:
#   conda run -n avatar python -m pip install torch==2.5.1 --index-url https://download.pytorch.org/whl/cu121

# 3) frontend 의존성 설치 (mental-avatar / my-dashboard 둘 다)
Write-Host "`n[3/4] frontend npm install..." -ForegroundColor Yellow
Push-Location (Join-Path $ProjectRoot "frontend"); npm install; Pop-Location
$dashFront = "D:\MyWork\my-dashboard"
if (Test-Path $dashFront) { Push-Location $dashFront; npm install; Pop-Location }
else { Write-Warning "my-dashboard 가 $dashFront 에 없습니다. git clone 후 npm install 하세요." }

# 4) 데이터 복원
Write-Host "`n[4/4] 데이터 복원 (restore_data.ps1)..." -ForegroundColor Yellow
& (Join-Path $ScriptDir "restore_data.ps1")

Write-Host "`n==== 완료 ====" -ForegroundColor Green
Write-Host "추가로 필요한 것:"
Write-Host "  - Ollama 설치 + 모델 받기 (기본 LLM): ollama pull gemma2:2b  (또는 사용 중인 모델)"
Write-Host "  - 서버 기동: conda run -n avatar python api\server.py   (포트 8766)"
Write-Host "  - watcher 기동: conda run -n avatar python watcher\file_watcher.py"
Write-Host "  - 프론트: cd frontend; npm run dev  (5174) / cd D:\MyWork\my-dashboard; npm run dev (5173)"
