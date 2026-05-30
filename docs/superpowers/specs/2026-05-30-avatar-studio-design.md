# Avatar Studio — Design Spec
Date: 2026-05-30

## Goal
얼굴 사진 + 음성 파일을 업로드하면 SadTalker가 립싱크 영상을 생성하는 파이프라인을,
my-dashboard(localhost:5173) 내 단일 탭으로 제공한다.

## Architecture

```
[my-dashboard :5173]
  Sidebar.tsx  →  AvatarStudio.tsx
                      ↓ POST /avatar/generate (multipart)
[mental-avatar Flask :8766]
  api/server.py  →  SadTalker subprocess (GPU)
                      ↓ .mp4
  결과 파일 반환  →  video 태그 미리보기 + 다운로드
```

## Components

### 1. SadTalker 설치
- 위치: `D:\MyWork\SadTalker\`
- conda 환경: `avatar` (Python 3.11, CUDA 12.6, RTX 3090)
- 모델: checkpoints + gfpgan weights 다운로드

### 2. Flask API — `POST /avatar/generate`
- 입력: `face` (jpg/png), `audio` (wav/mp3) — multipart/form-data
- 처리: 임시 파일 저장 → SadTalker inference.py 서브프로세스 실행 → mp4 반환
- 출력: `video/mp4` 스트림
- 에러: 파일 미첨부, 처리 실패 시 JSON error 반환
- 임시 파일: `mental-avatar/tmp/avatar/` — 요청당 UUID 디렉토리, 완료 후 보존(다운로드용)

### 3. AvatarStudio.tsx
- 얼굴 사진 업로드 + 미리보기
- 음성 파일 업로드 + 파일명 표시
- "영상 생성" 버튼 + 로딩 스피너
- 결과 video 태그 미리보기 + 다운로드 버튼
- 기존 my-dashboard 컴포넌트 패턴(CardShell 등) 따름

### 4. Sidebar.tsx
- 기존 KnowledgeGraph 항목 아래 "Avatar" 항목 추가
- view 라우팅 방식 기존 패턴 동일하게 적용

## SadTalker 실행 파라미터
```bash
python inference.py \
  --driven_audio <audio_path> \
  --source_image <face_path> \
  --result_dir <output_dir> \
  --still \
  --preprocess full \
  --enhancer gfpgan
```

## Data Flow
1. 사용자가 얼굴 사진 + 음성 파일 선택
2. "영상 생성" 클릭 → `POST http://127.0.0.1:8766/avatar/generate`
3. Flask가 `tmp/avatar/<uuid>/` 에 파일 저장
4. SadTalker subprocess 실행 (30초~2분, RTX 3090 기준)
5. 완료 시 mp4를 response로 반환
6. 프론트엔드에서 Blob URL로 video 태그에 표시

## File Structure
```
D:\MyWork\SadTalker\               # SadTalker 저장소
D:\MyWork\mental-avatar\
  api\server.py                    # /avatar/generate 추가
  tmp\avatar\                      # 임시 파일 (자동 생성)
D:\MyWork\my-dashboard\src\
  views\AvatarStudio.tsx           # 신규
  components\Sidebar.tsx           # Avatar 항목 추가
```

## Out of Scope
- GPT 대본 자동 생성 (추후 확장)
- 음성 클로닝 / TTS 연동 (추후 확장)
- 영상 히스토리 저장 (추후 확장)
