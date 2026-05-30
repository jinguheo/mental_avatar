# Avatar Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 얼굴 사진 + 음성 파일을 업로드하면 SadTalker가 립싱크 영상을 생성하는 파이프라인을 my-dashboard 내 단일 탭으로 제공한다.

**Architecture:** my-dashboard(React/Vite :5173)에 `avatar` 탭을 추가하고, 파일 업로드 후 mental-avatar Flask(:8766)의 `/avatar/generate` 엔드포인트를 호출한다. Flask는 SadTalker subprocess를 RTX 3090 GPU로 실행하여 mp4를 반환한다.

**Tech Stack:** SadTalker (Python/PyTorch/CUDA 12.6), Flask + flask-cors, React + TypeScript, Tailwind CSS, conda env `avatar`

---

## File Map

| 파일 | 변경 |
|------|------|
| `D:\MyWork\SadTalker\` | 신규 clone |
| `D:\MyWork\mental-avatar\api\server.py` | `/avatar/generate` 엔드포인트 추가 |
| `D:\MyWork\my-dashboard\src\types\index.ts` | `View` 타입에 `'avatar'` 추가 |
| `D:\MyWork\my-dashboard\src\components\Sidebar.tsx` | nav 배열에 Avatar 항목 추가 |
| `D:\MyWork\my-dashboard\src\App.tsx` | AvatarStudio import + 라우팅 추가 |
| `D:\MyWork\my-dashboard\src\views\AvatarStudio.tsx` | 신규 생성 |

---

## Task 1: SadTalker 클론 및 모델 다운로드

**Files:**
- Create: `D:\MyWork\SadTalker\` (git clone)

- [ ] **Step 1: SadTalker 저장소 클론**

```powershell
cd D:\MyWork
git clone https://github.com/OpenTalker/SadTalker.git
cd SadTalker
```

Expected: `D:\MyWork\SadTalker\` 디렉토리 생성, `inference.py` 존재 확인

- [ ] **Step 2: avatar conda 환경에 PyTorch + CUDA 의존성 설치**

```powershell
C:\Users\oem\miniconda3\Scripts\conda.exe run -n avatar pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
```

Expected: torch 설치 완료, `import torch; torch.cuda.is_available()` → `True`

- [ ] **Step 3: SadTalker Python 의존성 설치**

```powershell
C:\Users\oem\miniconda3\Scripts\conda.exe run -n avatar pip install -r D:\MyWork\SadTalker\requirements.txt
```

Expected: 오류 없이 완료

- [ ] **Step 4: 모델 체크포인트 자동 다운로드 스크립트 실행**

```powershell
cd D:\MyWork\SadTalker
C:\Users\oem\miniconda3\Scripts\conda.exe run -n avatar python scripts/download_models.py
```

Expected: `checkpoints\` 디렉토리에 `.pth` 파일들 생성

만약 `download_models.py`가 없으면 수동으로:
```powershell
# checkpoints 디렉토리 생성 후 huggingface에서 수동 다운로드
mkdir D:\MyWork\SadTalker\checkpoints
mkdir D:\MyWork\SadTalker\gfpgan\weights
# 브라우저에서 https://github.com/OpenTalker/SadTalker#2-download-models 참고
```

- [ ] **Step 5: SadTalker 동작 확인 (샘플 실행)**

```powershell
cd D:\MyWork\SadTalker
C:\Users\oem\miniconda3\Scripts\conda.exe run -n avatar python inference.py `
  --driven_audio examples/driven_audio/bus_chinese.wav `
  --source_image examples/source_image/full_body_2.png `
  --result_dir results\test `
  --still `
  --preprocess full `
  --enhancer gfpgan
```

Expected: `results\test\` 에 `.mp4` 파일 생성 (30초~2분 소요)

- [ ] **Step 6: 커밋 (mental-avatar 에서)**

```bash
cd D:\MyWork\mental-avatar
git add .
git commit -m "chore: SadTalker installed at D:/MyWork/SadTalker"
```

---

## Task 2: Flask `/avatar/generate` 엔드포인트 추가

**Files:**
- Modify: `D:\MyWork\mental-avatar\api\server.py`

- [ ] **Step 1: server.py 하단에 엔드포인트 추가**

`D:\MyWork\mental-avatar\api\server.py` 에서 마지막 `if __name__ == '__main__':` 블록 바로 위에 다음을 삽입:

```python
import uuid, subprocess, tempfile
from pathlib import Path
from flask import send_file

SADTALKER_DIR = Path(r"D:\MyWork\SadTalker")
AVATAR_TMP    = Path(__file__).parent.parent / "tmp" / "avatar"
PYTHON_EXE    = r"C:\Users\oem\miniconda3\envs\avatar\python.exe"

@app.route("/avatar/generate", methods=["POST"])
def avatar_generate():
    face_file  = request.files.get("face")
    audio_file = request.files.get("audio")

    if not face_file or not audio_file:
        return jsonify({"error": "face and audio files are required"}), 400

    job_id     = str(uuid.uuid4())
    job_dir    = AVATAR_TMP / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    face_ext  = Path(face_file.filename).suffix or ".jpg"
    audio_ext = Path(audio_file.filename).suffix or ".wav"
    face_path  = job_dir / f"face{face_ext}"
    audio_path = job_dir / f"audio{audio_ext}"
    face_file.save(str(face_path))
    audio_file.save(str(audio_path))

    cmd = [
        PYTHON_EXE, str(SADTALKER_DIR / "inference.py"),
        "--driven_audio", str(audio_path),
        "--source_image", str(face_path),
        "--result_dir",   str(job_dir / "result"),
        "--still",
        "--preprocess", "full",
        "--enhancer", "gfpgan",
    ]

    try:
        subprocess.run(cmd, check=True, cwd=str(SADTALKER_DIR),
                       capture_output=True, timeout=300)
    except subprocess.CalledProcessError as e:
        return jsonify({"error": "SadTalker failed", "detail": e.stderr.decode()}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "timeout after 300s"}), 500

    mp4_files = list((job_dir / "result").glob("*.mp4"))
    if not mp4_files:
        return jsonify({"error": "no output video found"}), 500

    return send_file(str(mp4_files[0]), mimetype="video/mp4",
                     as_attachment=False, download_name="avatar.mp4")
```

- [ ] **Step 2: Flask 서버 재시작 후 엔드포인트 수동 테스트**

PowerShell에서:
```powershell
# 서버 시작
C:\Users\oem\miniconda3\envs\avatar\python.exe D:\MyWork\mental-avatar\api\server.py

# 별도 터미널에서 curl 테스트
curl -X POST http://127.0.0.1:8766/avatar/generate `
  -F "face=@D:\MyWork\SadTalker\examples\source_image\full_body_2.png" `
  -F "audio=@D:\MyWork\SadTalker\examples\driven_audio\bus_chinese.wav" `
  --output test_result.mp4
```

Expected: `test_result.mp4` 파일 생성 (재생 가능)

- [ ] **Step 3: 커밋**

```bash
cd D:\MyWork\mental-avatar
git add api/server.py
git commit -m "feat: add /avatar/generate endpoint (SadTalker subprocess)"
```

---

## Task 3: View 타입 및 Sidebar 업데이트

**Files:**
- Modify: `D:\MyWork\my-dashboard\src\types\index.ts`
- Modify: `D:\MyWork\my-dashboard\src\components\Sidebar.tsx`

- [ ] **Step 1: `View` 타입에 `'avatar'` 추가**

`D:\MyWork\my-dashboard\src\types\index.ts` line 2 수정:

```typescript
export type View = 'dashboard' | 'todos' | 'notes' | 'calendar' | 'ai' | 'email' | 'chat' | 'settings' | 'history' | 'knowledge' | 'avatar'
```

- [ ] **Step 2: Sidebar nav 배열에 Avatar 항목 추가**

`D:\MyWork\my-dashboard\src\components\Sidebar.tsx` 의 `nav` 배열에서 `knowledge` 항목 다음에 추가:

```typescript
const nav: NavItem[] = [
  { id: 'dashboard', label: '홈',    icon: '⊞' },
  { id: 'todos',     label: '할 일', icon: '✓' },
  { id: 'notes',     label: '노트',  icon: '✎' },
  { id: 'calendar',  label: '캘린더', icon: '◫' },
  { id: 'email',     label: '이메일', icon: '✉' },
  { id: 'chat',      label: '채팅',  icon: '◎' },
  { id: 'ai',        label: 'AI',       icon: '✦' },
  { id: 'knowledge', label: '지식 그래프', icon: '⬡' },
  { id: 'avatar',    label: '아바타',    icon: '◉' },
  { id: 'history',   label: '기록',      icon: '◷' },
]
```

- [ ] **Step 3: 커밋**

```bash
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
import { useState, useRef } from 'react'

const API = 'http://127.0.0.1:8766'

export default function AvatarStudio() {
  const [faceFile, setFaceFile]     = useState<File | null>(null)
  const [audioFile, setAudioFile]   = useState<File | null>(null)
  const [facePreview, setFacePreview] = useState<string | null>(null)
  const [videoUrl, setVideoUrl]     = useState<string | null>(null)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const faceInputRef  = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)

  const onFaceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFaceFile(f)
    setFacePreview(URL.createObjectURL(f))
  }

  const onAudioChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setAudioFile(f)
  }

  const handleGenerate = async () => {
    if (!faceFile || !audioFile) return
    setLoading(true)
    setError(null)
    setVideoUrl(null)

    const form = new FormData()
    form.append('face', faceFile)
    form.append('audio', audioFile)

    try {
      const res = await fetch(`${API}/avatar/generate`, { method: 'POST', body: form })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      setVideoUrl(URL.createObjectURL(blob))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h1 className="text-xl font-bold text-gray-900 mb-6">아바타 스튜디오</h1>

      <div className="grid grid-cols-2 gap-4 mb-6">
        {/* 얼굴 사진 업로드 */}
        <div
          onClick={() => faceInputRef.current?.click()}
          className="border-2 border-dashed border-gray-200 rounded-2xl p-6 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-gray-400 transition-colors min-h-[180px]"
        >
          {facePreview ? (
            <img src={facePreview} alt="얼굴 미리보기" className="w-24 h-24 rounded-full object-cover" />
          ) : (
            <span className="text-4xl text-gray-300">◉</span>
          )}
          <span className="text-sm text-gray-500">{faceFile ? faceFile.name : '얼굴 사진 업로드 (jpg/png)'}</span>
          <input ref={faceInputRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={onFaceChange} />
        </div>

        {/* 음성 파일 업로드 */}
        <div
          onClick={() => audioInputRef.current?.click()}
          className="border-2 border-dashed border-gray-200 rounded-2xl p-6 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-gray-400 transition-colors min-h-[180px]"
        >
          <span className="text-4xl text-gray-300">♪</span>
          <span className="text-sm text-gray-500">{audioFile ? audioFile.name : '음성 파일 업로드 (wav/mp3)'}</span>
          <input ref={audioInputRef} type="file" accept="audio/wav,audio/mpeg,audio/mp3" className="hidden" onChange={onAudioChange} />
        </div>
      </div>

      {/* 생성 버튼 */}
      <button
        onClick={handleGenerate}
        disabled={!faceFile || !audioFile || loading}
        className={`
          w-full py-3 rounded-2xl text-sm font-semibold transition-all
          ${faceFile && audioFile && !loading
            ? 'bg-gray-900 text-white hover:bg-gray-700'
            : 'bg-gray-100 text-gray-400 cursor-not-allowed'}
        `}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            영상 생성 중… (30초~2분 소요)
          </span>
        ) : '영상 생성'}
      </button>

      {/* 에러 */}
      {error && (
        <div className="mt-4 p-3 bg-red-50 text-red-600 text-sm rounded-xl">{error}</div>
      )}

      {/* 결과 영상 */}
      {videoUrl && (
        <div className="mt-6">
          <video
            src={videoUrl}
            controls
            autoPlay
            className="w-full max-w-lg mx-auto rounded-2xl shadow-md"
          />
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

```bash
cd D:\MyWork\my-dashboard
git add src/views/AvatarStudio.tsx
git commit -m "feat: add AvatarStudio view"
```

---

## Task 5: App.tsx에 AvatarStudio 라우팅 추가

**Files:**
- Modify: `D:\MyWork\my-dashboard\src\App.tsx`

- [ ] **Step 1: import 추가**

`App.tsx` 상단 import 목록에 추가 (KnowledgeGraph import 다음 줄):

```typescript
import AvatarStudio from '@/views/AvatarStudio'
```

- [ ] **Step 2: 라우팅 추가**

`App.tsx` 의 `{view === 'knowledge' && <KnowledgeGraph settings={settings} />}` 다음 줄에 추가:

```typescript
{view === 'avatar'    && <AvatarStudio />}
```

- [ ] **Step 3: 개발 서버 시작 후 동작 확인**

```powershell
cd D:\MyWork\my-dashboard
npm run dev
```

브라우저에서 `localhost:5173` 접속 → 사이드바에 `◉ 아바타` 버튼 확인 → 클릭 시 AvatarStudio 뷰 표시 확인

- [ ] **Step 4: 커밋**

```bash
cd D:\MyWork\my-dashboard
git add src/App.tsx
git commit -m "feat: wire AvatarStudio into App router"
```

---

## Task 6: 전체 E2E 동작 검증

- [ ] **Step 1: mental-avatar 서버 시작**

```powershell
C:\Users\oem\miniconda3\envs\avatar\python.exe D:\MyWork\mental-avatar\api\server.py
```

- [ ] **Step 2: my-dashboard 개발 서버 시작**

```powershell
cd D:\MyWork\my-dashboard
npm run dev
```

- [ ] **Step 3: 브라우저에서 전체 플로우 테스트**

1. `localhost:5173` 접속
2. 사이드바 `◉ 아바타` 클릭
3. 얼굴 사진 업로드 (jpg/png)
4. 음성 파일 업로드 (wav/mp3)
5. `영상 생성` 버튼 클릭
6. 로딩 스피너 확인 (30초~2분)
7. 결과 영상 재생 확인
8. 다운로드 버튼으로 `avatar.mp4` 저장 확인

- [ ] **Step 4: start_dashboard.bat 업데이트 (선택)**

`D:\MyWork\my-dashboard\start_dashboard.bat` 에서 Avatar API가 이미 자동 시작되는지 확인. 미포함 시:

```bat
start "Avatar API" C:\Users\oem\miniconda3\envs\avatar\python.exe D:\MyWork\mental-avatar\api\server.py
```

---

## 완료 기준

- [ ] SadTalker가 샘플 이미지+오디오로 mp4를 생성함
- [ ] `POST http://127.0.0.1:8766/avatar/generate` 가 mp4를 반환함
- [ ] my-dashboard 사이드바에 `◉ 아바타` 버튼이 표시됨
- [ ] AvatarStudio 뷰에서 파일 2개 업로드 후 영상 생성이 완료됨
- [ ] 결과 영상이 브라우저에서 재생되고 다운로드됨
