# Avatar Studio — Design Spec (v2)
Date: 2026-05-30

## Goal
텍스트를 입력하면 Coqui XTTS v2로 내 목소리를 합성하고, SadTalker가 얼굴 사진에 립싱크 영상을 생성한다.
my-dashboard(localhost:5173) 내 단일 탭으로 제공한다.

## Phases
- **Phase 1 (현재 구현)**: 로컬 파이프라인 완성 — 텍스트 → 내 목소리 TTS → 립싱크 영상
- **Phase 2 (추후)**: 클라우드 배포 + 공개 embed URL (클라우드 미정)

---

## Architecture (Phase 1)

```
[my-dashboard :5173]
  Sidebar.tsx  →  AvatarStudio.tsx
                      ↓ POST /avatar/register_voice  (최초 1회 목소리 샘플 등록)
                      ↓ POST /avatar/tts_generate    (텍스트 + 얼굴사진 → mp4)
[mental-avatar Flask :8766]
  /avatar/register_voice  →  voice_sample.wav 저장
  /avatar/tts_generate    →  Coqui XTTS v2 (텍스트 → 음성)
                          →  SadTalker subprocess (얼굴 + 음성 → mp4)
                          →  mp4 반환
```

---

## Components

### 1. 설치
- **SadTalker**: `D:\MyWork\SadTalker\` — 얼굴 + 음성 → 립싱크 영상
- **Coqui XTTS v2**: `conda avatar` 환경에 `TTS` 패키지 설치 — 텍스트 + 목소리 샘플 → 음성
- GPU: RTX 3090 (CUDA 12.6), 영상 생성 30초~2분 예상

### 2. Flask API 엔드포인트

#### `POST /avatar/register_voice`
- 입력: `sample` (wav 파일, 6~30초 본인 목소리)
- 처리: `mental-avatar/data/voice_sample.wav` 로 저장 (덮어쓰기)
- 출력: `{"status": "ok", "duration": <초>}`

#### `POST /avatar/tts_generate`
- 입력: `face` (jpg/png), `text` (문자열, form field)
- 처리:
  1. XTTS v2로 `data/voice_sample.wav` 기반 TTS 생성 → `tmp/<uuid>/speech.wav`
  2. SadTalker로 `face` + `speech.wav` → `tmp/<uuid>/result/*.mp4`
- 출력: `video/mp4` 스트림
- 에러: voice_sample 미등록, 텍스트 없음, 처리 실패 시 JSON error

### 3. AvatarStudio.tsx UI

```
┌─────────────────────────────────────────────┐
│  🎭 아바타 스튜디오                            │
├──────────────────┬──────────────────────────┤
│  얼굴 사진 업로드  │  내 목소리 샘플 등록        │
│  [드래그&드롭]    │  (6~30초 wav, 최초 1회)    │
│  미리보기 이미지   │  등록됨 ✓ / 미등록 표시     │
├──────────────────┴──────────────────────────┤
│  텍스트 입력 (아바타가 할 말)                   │
│  [                                    ]     │
├─────────────────────────────────────────────┤
│              [ 영상 생성 ]                    │
│          (스피너 + 소요시간 안내)               │
├─────────────────────────────────────────────┤
│  결과 영상 미리보기 (video 태그)                │
│  [ 다운로드 ]                                 │
└─────────────────────────────────────────────┘
```

### 4. Sidebar.tsx
- 기존 `knowledge` 항목 아래 `avatar` 항목 추가 (`◉ 아바타`)

---

## SadTalker 실행 파라미터
```bash
python inference.py \
  --driven_audio <speech.wav> \
  --source_image <face.jpg> \
  --result_dir   <output_dir> \
  --still \
  --preprocess full \
  --enhancer gfpgan \
  --size 512
```

## XTTS v2 실행 방식 (Python)
```python
from TTS.api import TTS
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda")
tts.tts_to_file(
    text=text,
    speaker_wav="data/voice_sample.wav",
    language="ko",
    file_path="tmp/<uuid>/speech.wav"
)
```

## File Structure
```
D:\MyWork\SadTalker\                   # SadTalker 저장소
D:\MyWork\mental-avatar\
  api\server.py                        # 엔드포인트 2개 추가
  data\voice_sample.wav                # 등록된 목소리 샘플 (최초 1회)
  tmp\avatar\<uuid>\                   # 요청별 임시 파일
D:\MyWork\my-dashboard\src\
  views\AvatarStudio.tsx               # 신규
  components\Sidebar.tsx               # avatar 항목 추가
  types\index.ts                       # View 타입에 'avatar' 추가
  App.tsx                              # 라우팅 추가
```

## Out of Scope (Phase 1)
- 클라우드 배포 / 공개 embed URL → Phase 2
- GPT 대본 자동 생성 → 추후
- 영상 히스토리 저장 → 추후
