# Mental Avatar — 새 PC 설치 가이드

다른 PC에 mental-avatar(+ my-dashboard)를 처음부터 설치해 실행하는 방법입니다.
데이터 이전(대화/지식그래프/프로필)은 [migrate/MIGRATION.md](migrate/MIGRATION.md)와 함께 보세요.

> **요약**: 코드는 `git clone`, 환경(conda/Node/Ollama)은 새로 설치, 데이터는 번들 zip 복원.
> **같은 경로(`D:\MyWork\...`) 사용을 강력 권장** — DB·실행 스크립트에 절대경로가 박혀 있습니다.

---

## 0. 사전 준비 (한 번만 설치)

| 프로그램 | 용도 | 비고 |
|---|---|---|
| **Miniconda** | Python 환경 관리 | `D:\miniconda3` 또는 기본 위치 |
| **Node.js 18+** | 프론트엔드(Vite) | `npm` 사용 |
| **Ollama** | 로컬 LLM(기본 AI 제공자) | https://ollama.com |
| **Git** | 코드 받기 | |
| (선택) Google Chrome | Claude.ai 세션 브리지 | 로컬 LLM만 쓰면 불필요 |

---

## 1. 코드 받기

```powershell
git clone https://github.com/jinguheo/mental_avatar.git  D:\MyWork\mental-avatar
git clone https://github.com/jinguheo/my_dashboard.git   D:\MyWork\my-dashboard
```

> 경로를 `D:\MyWork\mental-avatar` 와 다르게 두면, DB에 박힌 일부 문서 원본 경로(44개)의
> "원본 열기" 기능과 `start_dashboard.bat`의 하드코딩 경로가 깨집니다. (검색/내용/아바타 답변은 정상)

---

## 2. Python 환경 구성

### avatar 환경 (API 서버 8766 + watcher)
```powershell
conda create -y -n avatar python=3.11
conda run -n avatar python -m pip install --upgrade pip
conda run -n avatar python -m pip install -r D:\MyWork\mental-avatar\requirements.txt
# 중요: 임베딩 DB(db/vectors) 호환을 위해 chromadb 버전 고정
conda run -n avatar python -m pip install "chromadb==1.5.9"
```

### base 환경 (my-dashboard MCP 서버 8765)
```powershell
conda run -n base python -m pip install flask flask-cors yfinance requests
```

> **음성/영상 기능**(SadTalker·XTTS)을 쓸 경우에만 추가로 GPU에 맞는 torch와 별도 `xtts` env가 필요합니다.
> 기본 채팅·지식그래프·성향(MBTI) 기능만 쓰면 위 두 환경으로 충분합니다.

---

## 3. 프론트엔드 의존성

```powershell
cd D:\MyWork\mental-avatar\frontend ; npm install
cd D:\MyWork\my-dashboard           ; npm install
```

---

## 4. Ollama 모델 받기 (기본 LLM)

```powershell
ollama pull gemma4:e2b
```
> 코드 기본값은 `gemma4:e2b`입니다(`core/pattern.py`). 다른 모델을 쓰려면 그 값을 바꾸세요.

---

## 5. 데이터 복원 (이전 PC에서 가져온 경우)

이전 PC에서 만든 `data_bundle_*.zip`을 `D:\MyWork\mental-avatar\migrate\`에 복사한 뒤:
```powershell
cd D:\MyWork\mental-avatar\migrate
powershell -ExecutionPolicy Bypass -File restore_data.ps1
```
> 복원 전 기존 데이터는 `backups\pre_restore_<시각>\`에 자동 백업됩니다.
> 데이터를 새로 시작하려면 이 단계를 건너뛰면 됩니다(첫 실행 시 빈 DB 자동 생성).

**2~5단계를 한 번에**: `powershell -ExecutionPolicy Bypass -File migrate\setup_new_pc.ps1`

---

## 6. 실행

### 방법 A — 수동 (권장, 경로 확실)
```powershell
# API 서버 (8766)
conda run -n avatar python D:\MyWork\mental-avatar\api\server.py

# watcher: 자동 백업(1시간) + 성향 자동측정
conda run -n avatar python D:\MyWork\mental-avatar\watcher\file_watcher.py

# MCP 서버 (8765, 주식/날씨/뉴스)
conda run -n base python D:\MyWork\my-dashboard\stock_mcp_server.py

# 프론트엔드
cd D:\MyWork\mental-avatar\frontend ; npm run dev    # 5174
cd D:\MyWork\my-dashboard           ; npm run dev    # 5173
```

### 방법 B — 일괄 스크립트
`D:\MyWork\my-dashboard\start_dashboard.bat` 가 위 전부를 한 번에 띄웁니다.
> ⚠️ 이 .bat에는 **이전 PC의 절대경로**(`C:\Users\oem\miniconda3\...`, Chrome 경로 등)가 하드코딩돼
> 있습니다. 새 PC의 사용자명/설치 위치가 다르면 그에 맞게 .bat 안의 경로를 수정해야 합니다.

---

## 7. 접속 주소

| 주소 | 화면 |
|---|---|
| http://localhost:5173 | **my-dashboard** (주 사용 앱 — 검색·AI대화·지식그래프·성향) |
| http://localhost:5174 | **mental-avatar** (아바타 스튜디오·3D·실사 아바타) |
| http://127.0.0.1:8766 | Avatar API (직접 접속용 아님) |
| http://127.0.0.1:8765 | MCP 서버 (주식/날씨/뉴스) |

---

## 8. 자주 겪는 문제

- **성향/검색이 비어 있음** → 데이터 복원(5단계)을 안 했거나, `chromadb` 버전이 1.5.9가 아니라 `db/vectors`를 못 읽는 경우. 버전 확인: `conda run -n avatar python -c "import chromadb; print(chromadb.__version__)"`
- **아바타 답변이 안 됨** → Ollama가 떠 있고 모델이 받아졌는지 확인: `ollama list`
- **포트 충돌(8766 등)** → 옛 python 프로세스가 같은 포트를 잡고 있을 수 있음. 해당 PID를 종료 후 단일 인스턴스로 재시작.
- **문서 "원본 열기"만 안 됨** → 경로가 `D:\MyWork\mental-avatar`와 다른 경우. 검색/답변은 정상이므로 무시 가능.

---

## 데이터가 들어 있는 곳 (참고)

| 데이터 | 경로 |
|---|---|
| 대화·지식그래프·프로필(MBTI 등) | `db\knowledge.db` |
| 임베딩(벡터 검색) | `db\vectors\` |
| 얼굴·목소리 | `data\face.jpg`, `data\voice_sample.wav` |
| 자동 백업(1시간마다, 24개 보관) | `backups\<시각>\` |
| GLB 아바타·웹캠 저장 얼굴·UI설정 | **브라우저**(IndexedDB/localStorage) — 번들에 미포함, 새 PC에서 재설정 |
