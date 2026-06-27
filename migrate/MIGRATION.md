# Mental Avatar — 다른 PC로 이전 가이드

이 폴더(`migrate/`)는 mental-avatar를 다른 PC로 옮기기 위한 데이터 번들과 스크립트를 담습니다.

## 핵심 원칙
- **데이터(db/data)는 파일 복사로 옮겨집니다.** 대화·지식그래프·프로필(MBTI 등)·임베딩·얼굴/목소리 전부 포함.
- **코드는 git clone, 환경(conda/Node/Ollama)은 새로 설치**해야 앱이 실행됩니다.
- **같은 경로(`D:\MyWork\mental-avatar`) 사용을 강력 권장** — DB에 일부 문서 원본 경로가
  `D:\MyWork\mental-avatar\docs\...` 로 박혀 있어, 경로가 다르면 그 문서의 "원본 열기"만 깨집니다
  (검색/내용/임베딩/아바타 답변은 정상).

## 옮기는 것 / 새로 만드는 것

| 구분 | 항목 | 방법 |
|------|------|------|
| 복사 | `db/knowledge.db`, `db/vectors/`, `data/` | 이 폴더의 `data_bundle_*.zip` 전달 |
| git | mental-avatar, my-dashboard 코드 | `git clone` |
| 설치 | conda `avatar` env (Python 3.11) | `setup_new_pc.ps1` |
| 설치 | frontend node_modules (양쪽) | `npm install` (스크립트가 수행) |
| 설치 | Ollama + 모델 | 수동 (`ollama pull ...`) |

## 버전 주의
- **chromadb == 1.5.9** : `db/vectors/`(임베딩) 호환을 위해 반드시 이 버전. setup 스크립트가 고정 설치함.
- Python 3.11, flask 3.1.x

## 새 PC에서 절차

```powershell
# 1) 코드 받기 (같은 경로 권장)
git clone https://github.com/jinguheo/mental_avatar.git  D:\MyWork\mental-avatar
git clone https://github.com/jinguheo/my_dashboard.git   D:\MyWork\my-dashboard

# 2) 이 migrate 폴더의 data_bundle_*.zip 을 새 PC의 D:\MyWork\mental-avatar\migrate\ 에 복사

# 3) 환경 구성 + 데이터 복원 (한 번에)
cd D:\MyWork\mental-avatar\migrate
powershell -ExecutionPolicy Bypass -File setup_new_pc.ps1

# 4) Ollama 모델 (기본 LLM)
ollama pull gemma2:2b   # 또는 현재 사용 중인 모델

# 5) 실행
conda run -n avatar python D:\MyWork\mental-avatar\api\server.py          # API 8766
conda run -n avatar python D:\MyWork\mental-avatar\watcher\file_watcher.py # watcher(자동백업/측정)
cd D:\MyWork\mental-avatar\frontend; npm run dev    # 5174
cd D:\MyWork\my-dashboard;          npm run dev    # 5173
```

## 데이터만 다시 복원하고 싶을 때
```powershell
cd D:\MyWork\mental-avatar\migrate
powershell -ExecutionPolicy Bypass -File restore_data.ps1   # 가장 최근 번들 자동 선택
# 또는 특정 번들 지정:
powershell -ExecutionPolicy Bypass -File restore_data.ps1 .\data_bundle_YYYYMMDD_HHMMSS.zip
```
복원 전 기존 데이터는 `backups\pre_restore_<시각>\` 에 자동 백업됩니다.

## 최신 데이터 번들 다시 만들기 (이전 PC에서)
```powershell
conda run -n avatar python D:\MyWork\mental-avatar\migrate\make_bundle.py
```
(또는 `backups\<시각>\` 폴더를 그대로 zip 해도 동일 — db/vectors/data 구조가 같음)

## 주의
- GLB 아바타 파일, 웹캠 저장 얼굴 스냅샷, 채팅 UI 설정은 **브라우저**(IndexedDB/localStorage)에 있어
  데이터 번들에 포함되지 않습니다. 새 PC 브라우저에서는 다시 설정/업로드해야 합니다.
- xtts_server.py(8768, 음성합성)는 별도 `xtts` conda env가 필요하며 수동 기동입니다(선택).
