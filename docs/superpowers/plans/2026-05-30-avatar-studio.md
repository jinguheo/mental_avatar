# Avatar Studio Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 텍스트를 입력하면 Coqui XTTS v2로 내 목소리를 합성하고, SadTalker가 얼굴 사진에 립싱크 영상(mp4)을 생성한다. my-dashboard 내 단일 탭으로 제공한다.

**Architecture:** my-dashboard(React/Vite :5173)에 `avatar` 탭 추가. 최초 1회 목소리 샘플 등록(`/avatar/register_voice`), 이후 텍스트 + 얼굴사진 → `/avatar/tts_generate` → XTTS v2(TTS) → SadTalker(립싱크) → mp4 반환.

**Tech Stack:** Coqui TTS (XTTS v2, CUDA), SadTalker (PyTorch/CUDA 12.6), Flask + flask-cors, React + TypeScript, Tailwind CSS, conda env `avatar`, RTX 3090

---

## File Map

| 파일 | 변경 |
|------|------|
| `D:\MyWork\SadTalker\` | 신규 clone |
| `D:\MyWork\mental-avatar\api\server.py` | `/avatar/register_voice` + `/avatar/tts_generate` 추가 |
| `D:\MyWork\mental-avatar\data\voice_sample.wav` | 목소리 샘플 저장 위치 (자동 생성) |
| `D:\MyWork\my-dashboard\src\types\index.ts` | `View` 타입에 `'avatar'` 추가 |
| `D:\MyWork\my-dashboard\src\components\Sidebar.tsx` | nav 배열에 Avatar 항목 추가 |
| `D:\MyWork\my-dashboard\src\App.tsx` | AvatarStudio import + 라우팅 추가 |
| `D:\MyWork\my-dashboard\src\views\AvatarStudio.tsx` | 신규 생성 |

---

## Task 1: SadTalker + Coqui XTTS v2 설치

**Files:**
- Create: `D:\MyWork\SadTalker\` (git clone)

- [ ] **Step 1: SadTalker 저장소 클론**

```powershell
cd D:\MyWork
git clone https://github.com/OpenTalker/SadTalker.git
```

Expected: `D:\MyWork\SadTalker\inference.py` 존재 확인

- [ ] **Step 2: avatar 환경에 PyTorch + CUDA 설치**

```powershell
C:\Users\oem\miniconda3\Scripts\conda.exe run -n avatar pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
```

확인:
```powershell
C:\Users\oem\miniconda3\envs\avatar\python.exe -c "import torch; print(torch.cuda.is_available())"
```
Expected: `True`

- [ ] **Step 3: SadTalker 의존성 설치**

```powershell
C:\Users\oem\miniconda3\Scripts\conda.exe run -n avatar pip install -r D:\MyWork\SadTalker\requirements.txt
```

- [ ] **Step 4: Coqui XTTS v2 설치**

```powershell
C:\Users\oem\miniconda3\Scripts\conda.exe run -n avatar pip install TTS
```

확인:
```powershell
C:\Users\oem\miniconda3\envs\avatar\python.exe -c "from TTS.api import TTS; print('OK')"
```
Expected: `OK`

- [ ] **Step 5: SadTalker 모델 다운로드**

```powershell
cd D:\MyWork\SadTalker
C:\Users\oem\miniconda3\Scripts\conda.exe run -n avatar python scripts/download_models.py
```

`scripts/download_models.py` 없을 경우:
```powershell
New-Item -ItemType Directory -Force D:\MyWork\SadTalker\checkpoints
New-Item -ItemType Directory -Force D:\MyWork\SadTalker\gfpgan\weights
# https://github.com/OpenTalker/SadTalker#2-download-models 에서 수동 다운로드
```

Expected: `D:\MyWork\SadTalker\checkpoints\` 에 `.pth` 파일 존재

- [ ] **Step 6: SadTalker 샘플 실행으로 동작 확인**

```powershell
cd D:\MyWork\SadTalker
C:\Users\oem\miniconda3\Scripts\conda.exe run -n avatar python inference.py `
  --driven_audio examples/driven_audio/bus_chinese.wav `
  --source_image examples/source_image/full_body_2.png `
  --result_dir   results/test `
  --still --preprocess full --enhancer gfpgan --size 512
```

Expected: `results/test/` 에 `.mp4` 생성 (30초~2분)

- [ ] **Step 7: 커밋**

```powershell
cd D:\MyWork\mental-avatar
git add .
git commit -m "chore: SadTalker + Coqui XTTS v2 installed"
```

---

## Task 2: Flask 엔드포인트 2개 추가

**Files:**
- Modify: `D:\MyWork\mental-avatar\api\server.py`

- [ ] **Step 1: server.py 상단 import 블록에 추가**

기존 `from flask import Flask, request, jsonify` 줄을 아래로 교체:

```python
from flask import Flask, request, jsonify, send_file
import uuid, subprocess
from pathlib import Path
```

- [ ] **Step 2: 상수 정의 — `if __name__ == '__main__':` 블록 바로 위에 삽입**

```python
# ── Avatar Studio ────────────────────────────────────────────
SADTALKER_DIR  = Path(r"D:\MyWork\SadTalker")
AVATAR_TMP     = Path(__file__).parent.parent / "tmp" / "avatar"
AVATAR_DATA    = Path(__file__).parent.parent / "data"
VOICE_SAMPLE   = AVATAR_DATA / "voice_sample.wav"
PYTHON_EXE     = r"C:\Users\oem\miniconda3\envs\avatar\python.exe"
```

- [ ] **Step 3: `/avatar/register_voice` 엔드포인트 추가 (상수 정의 바로 아래)**

```python
@app.route("/avatar/register_voice", methods=["POST"])
def avatar_register_voice():
    sample = request.files.get("sample")
    if not sample:
        return jsonify({"error": "sample file required"}), 400

    AVATAR_DATA.mkdir(parents=True, exist_ok=True)
    sample.save(str(VOICE_SAMPLE))

    import wave, contextlib
    duration = 0.0
    try:
        with contextlib.closing(wave.open(str(VOICE_SAMPLE), "r")) as f:
            duration = f.getnframes() / float(f.getframerate())
    except Exception:
        pass

    return jsonify({"status": "ok", "duration": round(duration, 1)})
```

- [ ] **Step 4: `/avatar/tts_generate` 엔드포인트 추가**

```python
@app.route("/avatar/tts_generate", methods=["POST"])
def avatar_tts_generate():
    face_file = request.files.get("face")
    text      = request.form.get("text", "").strip()

    if not face_file:
        return jsonify({"error": "face file required"}), 400
    if not text:
        return jsonify({"error": "text required"}), 400
    if not VOICE_SAMPLE.exists():
        return jsonify({"error": "voice sample not registered. POST /avatar/register_voice first"}), 400

    job_id  = str(uuid.uuid4())
    job_dir = AVATAR_TMP / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    face_ext  = Path(face_file.filename).suffix or ".jpg"
    face_path = job_dir / f"face{face_ext}"
    face_file.save(str(face_path))

    speech_path = job_dir / "speech.wav"

    # 1) XTTS v2 TTS
    tts_script = f"""
import sys
sys.stdout.reconfigure(encoding='utf-8')
from TTS.api import TTS
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda")
tts.tts_to_file(
    text={repr(text)},
    speaker_wav={repr(str(VOICE_SAMPLE))},
    language="ko",
    file_path={repr(str(speech_path))}
)
"""
    tts_script_path = job_dir / "run_tts.py"
    tts_script_path.write_text(tts_script, encoding="utf-8")

    try:
        subprocess.run([PYTHON_EXE, str(tts_script_path)],
                       check=True, capture_output=True, timeout=120)
    except subprocess.CalledProcessError as e:
        return jsonify({"error": "TTS failed", "detail": e.stderr.decode(errors="replace")}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "TTS timeout"}), 500

    # 2) SadTalker 립싱크
    result_dir = job_dir / "result"
    cmd = [
        PYTHON_EXE, str(SADTALKER_DIR / "inference.py"),
        "--driven_audio", str(speech_path),
        "--source_image", str(face_path),
        "--result_dir",   str(result_dir),
        "--still", "--preprocess", "full",
        "--enhancer", "gfpgan", "--size", "512",
    ]
    try:
        subprocess.run(cmd, check=True, cwd=str(SADTALKER_DIR),
                       capture_output=True, timeout=300)
    except subprocess.CalledProcessError as e:
        return jsonify({"error": "SadTalker failed", "detail": e.stderr.decode(errors="replace")}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "SadTalker timeout after 300s"}), 500

    mp4_files = list(result_dir.glob("*.mp4"))
    if not mp4_files:
        return jsonify({"error": "no output video found"}), 500

    return send_file(str(mp4_files[0]), mimetype="video/mp4",
                     as_attachment=False, download_name="avatar.mp4")
```

- [ ] **Step 5: Flask 서버 재시작 후 curl 테스트**

터미널 1 — 서버 시작:
```powershell
C:\Users\oem\miniconda3\envs\avatar\python.exe D:\MyWork\mental-avatar\api\server.py
```

터미널 2 — 목소리 등록:
```powershell
curl -X POST http://127.0.0.1:8766/avatar/register_voice `
  -F "sample=@D:\MyWork\SadTalker\examples\driven_audio\bus_chinese.wav"
```
Expected: `{"status":"ok","duration":...}`

터미널 2 — 영상 생성 테스트:
```powershell
curl -X POST http://127.0.0.1:8766/avatar/tts_generate `
  -F "face=@D:\MyWork\SadTalker\examples\source_image\full_body_2.png" `
  -F "text=안녕하세요. 저는 AI 아바타입니다." `
  --output test_avatar.mp4
```
Expected: `test_avatar.mp4` 생성 및 재생 가능

- [ ] **Step 6: 커밋**

```powershell
cd D:\MyWork\mental-avatar
git add api/server.py
git commit -m "feat: add /avatar/register_voice and /avatar/tts_generate endpoints"
```

---

## Task 3: View 타입 및 Sidebar 업데이트

**Files:**
- Modify: `D:\MyWork\my-dashboard\src\types\index.ts`
- Modify: `D:\MyWork\my-dashboard\src\components\Sidebar.tsx`

- [ ] **Step 1: `View` 타입에 `'avatar'` 추가**

`D:\MyWork\my-dashboard\src\types\index.ts` line 2:

```typescript
export type View = 'dashboard' | 'todos' | 'notes' | 'calendar' | 'ai' | 'email' | 'chat' | 'settings' | 'history' | 'knowledge' | 'avatar'
```

- [ ] **Step 2: Sidebar nav 배열에 Avatar 항목 추가**

`D:\MyWork\my-dashboard\src\components\Sidebar.tsx` 의 `nav` 배열에서 `knowledge` 다음에 삽입:

```typescript
const nav: NavItem[] = [
  { id: 'dashboard', label: '홈',       icon: '⊞' },
  { id: 'todos',     label: '할 일',    icon: '✓' },
  { id: 'notes',     label: '노트',     icon: '✎' },
  { id: 'calendar',  label: '캘린더',   icon: '◫' },
  { id: 'email',     label: '이메일',   icon: '✉' },
  { id: 'chat',      label: '채팅',     icon: '◎' },
  { id: 'ai',        label: 'AI',       icon: '✦' },
  { id: 'knowledge', label: '지식 그래프', icon: '⬡' },
  { id: 'avatar',    label: '아바타',   icon: '◉' },
  { id: 'history',   label: '기록',     icon: '◷' },
]
```

- [ ] **Step 3: 커밋**

```powershell
cd D:\MyWork\my-dashboard
git add src/types/index.ts src/components/Sidebar.tsx
git commit -m "feat: add avatar view to sidebar nav"
```

---

## Task 4: AvatarStudio.tsx 뷰 생성

**Files:**
- Create: `D:\MyWork\my-dashboard\src\views\AvatarStudio.tsx`

- [ ] **Step 1: AvatarStudio.tsx 파일 생성**

```typescript
import { useState, useRef, useEffect } from 'react'

const API = 'http://127.0.0.1:8766'

export default function AvatarStudio() {
  const [faceFile, setFaceFile]         = useState<File | null>(null)
  const [facePreview, setFacePreview]   = useState<string | null>(null)
  const [text, setText]                 = useState('')
  const [voiceRegistered, setVoiceRegistered] = useState(false)
  const [voiceSample, setVoiceSample]   = useState<File | null>(null)
  const [videoUrl, setVideoUrl]         = useState<string | null>(null)
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [status, setStatus]             = useState('')
  const faceInputRef  = useRef<HTMLInputElement>(null)
  const voiceInputRef = useRef<HTMLInputElement>(null)

  // 목소리 등록 여부 확인 (서버에서 voice_sample.wav 존재 여부)
  useEffect(() => {
    fetch(`${API}/avatar/voice_status`)
      .then(r => r.json())
      .then(d => setVoiceRegistered(d.registered ?? false))
      .catch(() => {})
  }, [])

  const onFaceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFaceFile(f)
    setFacePreview(URL.createObjectURL(f))
  }

  const onVoiceChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setVoiceSample(f)

    const form = new FormData()
    form.append('sample', f)
    try {
      const res = await fetch(`${API}/avatar/register_voice`, { method: 'POST', body: form })
      const data = await res.json()
      if (res.ok) {
        setVoiceRegistered(true)
        setStatus(`목소리 등록 완료 (${data.duration}초)`)
      } else {
        setError(data.error)
      }
    } catch {
      setError('목소리 등록 실패')
    }
  }

  const handleGenerate = async () => {
    if (!faceFile || !text.trim() || !voiceRegistered) return
    setLoading(true)
    setError(null)
    setVideoUrl(null)
    setStatus('TTS 음성 생성 중…')

    const form = new FormData()
    form.append('face', faceFile)
    form.append('text', text)

    try {
      setStatus('립싱크 영상 합성 중… (30초~2분 소요)')
      const res = await fetch(`${API}/avatar/tts_generate`, { method: 'POST', body: form })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      setVideoUrl(URL.createObjectURL(blob))
      setStatus('완료')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
      setStatus('')
    } finally {
      setLoading(false)
    }
  }

  const canGenerate = !!faceFile && !!text.trim() && voiceRegistered && !loading

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto">
      <h1 className="text-xl font-bold text-gray-900 mb-6">아바타 스튜디오</h1>

      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* 얼굴 사진 */}
        <div
          onClick={() => faceInputRef.current?.click()}
          className="border-2 border-dashed border-gray-200 rounded-2xl p-6 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-gray-400 transition-colors min-h-[160px]"
        >
          {facePreview
            ? <img src={facePreview} alt="얼굴" className="w-20 h-20 rounded-full object-cover" />
            : <span className="text-4xl text-gray-300">◉</span>
          }
          <span className="text-xs text-gray-500 text-center">
            {faceFile ? faceFile.name : '얼굴 사진 업로드\n(jpg/png)'}
          </span>
          <input ref={faceInputRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={onFaceChange} />
        </div>

        {/* 목소리 샘플 */}
        <div
          onClick={() => voiceInputRef.current?.click()}
          className="border-2 border-dashed border-gray-200 rounded-2xl p-6 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-gray-400 transition-colors min-h-[160px]"
        >
          <span className={`text-3xl ${voiceRegistered ? 'text-green-500' : 'text-gray-300'}`}>
            {voiceRegistered ? '✓' : '♪'}
          </span>
          <span className="text-xs text-gray-500 text-center">
            {voiceRegistered
              ? '목소리 등록됨\n(재업로드 가능)'
              : '내 목소리 샘플 등록\n(wav, 6~30초)'}
          </span>
          <input ref={voiceInputRef} type="file" accept="audio/wav" className="hidden" onChange={onVoiceChange} />
        </div>
      </div>

      {/* 텍스트 입력 */}
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="아바타가 할 말을 입력하세요…"
        rows={4}
        className="w-full border border-gray-200 rounded-2xl p-4 text-sm text-gray-900 resize-none focus:outline-none focus:border-gray-400 mb-4"
      />

      {/* 생성 버튼 */}
      <button
        onClick={handleGenerate}
        disabled={!canGenerate}
        className={`
          w-full py-3 rounded-2xl text-sm font-semibold transition-all mb-2
          ${canGenerate
            ? 'bg-gray-900 text-white hover:bg-gray-700'
            : 'bg-gray-100 text-gray-400 cursor-not-allowed'}
        `}
      >
        {loading
          ? <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              {status || '처리 중…'}
            </span>
          : '영상 생성'}
      </button>

      {!voiceRegistered && (
        <p className="text-xs text-amber-600 text-center mb-2">목소리 샘플을 먼저 등록해주세요</p>
      )}

      {error && (
        <div className="mt-2 p-3 bg-red-50 text-red-600 text-sm rounded-xl">{error}</div>
      )}

      {videoUrl && (
        <div className="mt-6">
          <video src={videoUrl} controls autoPlay className="w-full rounded-2xl shadow-md" />
          <div className="flex justify-center mt-3">
            <a
              href={videoUrl}
              download="avatar.mp4"
              className="px-4 py-2 bg-gray-900 text-white text-sm rounded-xl hover:bg-gray-700 transition-colors"
            >
              다운로드
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 커밋**

```powershell
cd D:\MyWork\my-dashboard
git add src/views/AvatarStudio.tsx
git commit -m "feat: add AvatarStudio view with text input and voice clone"
```

---

## Task 5: `/avatar/voice_status` 엔드포인트 추가 + App.tsx 라우팅

**Files:**
- Modify: `D:\MyWork\mental-avatar\api\server.py`
- Modify: `D:\MyWork\my-dashboard\src\App.tsx`

- [ ] **Step 1: `/avatar/voice_status` 엔드포인트 추가**

`server.py` 의 `/avatar/register_voice` 엔드포인트 바로 아래에 추가:

```python
@app.route("/avatar/voice_status", methods=["GET"])
def avatar_voice_status():
    return jsonify({"registered": VOICE_SAMPLE.exists()})
```

- [ ] **Step 2: App.tsx에 import + 라우팅 추가**

`App.tsx` 상단 import (KnowledgeGraph 다음 줄):
```typescript
import AvatarStudio from '@/views/AvatarStudio'
```

`App.tsx` main 렌더링 (`{view === 'knowledge' && ...}` 다음 줄):
```typescript
{view === 'avatar' && <AvatarStudio />}
```

- [ ] **Step 3: 커밋**

```powershell
cd D:\MyWork\mental-avatar
git add api/server.py
git commit -m "feat: add /avatar/voice_status endpoint"

cd D:\MyWork\my-dashboard
git add src/App.tsx
git commit -m "feat: wire AvatarStudio into App router"
```

---

## Task 6: E2E 검증

- [ ] **Step 1: 서버 시작**

```powershell
C:\Users\oem\miniconda3\envs\avatar\python.exe D:\MyWork\mental-avatar\api\server.py
```

- [ ] **Step 2: 프론트엔드 시작**

```powershell
cd D:\MyWork\my-dashboard
npm run dev
```

- [ ] **Step 3: 전체 플로우 테스트**

1. `localhost:5173` → 사이드바 `◉ 아바타` 클릭
2. 얼굴 사진 업로드 → 미리보기 이미지 표시 확인
3. 목소리 wav 업로드 → `✓ 목소리 등록됨` 표시 확인
4. 텍스트 입력: `"안녕하세요. 저는 디지털 아바타입니다."`
5. `영상 생성` 버튼 클릭 → 스피너 + 상태 메시지 확인
6. 결과 영상 재생 확인
7. 다운로드 버튼으로 `avatar.mp4` 저장 확인

---

## 완료 기준

- [ ] SadTalker + Coqui XTTS v2 설치 완료, 샘플 실행 성공
- [ ] `POST /avatar/register_voice` — wav 업로드 → `voice_sample.wav` 저장
- [ ] `GET /avatar/voice_status` — 등록 여부 반환
- [ ] `POST /avatar/tts_generate` — 텍스트 + 얼굴 → mp4 반환
- [ ] 사이드바에 `◉ 아바타` 버튼 표시
- [ ] AvatarStudio에서 텍스트 입력 → 영상 생성 → 재생 + 다운로드
