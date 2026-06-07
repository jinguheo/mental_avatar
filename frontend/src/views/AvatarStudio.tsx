import { useState, useRef, useEffect, useCallback } from 'react'

const API = 'http://127.0.0.1:8766'

interface YtHistory { job_id: string; title: string; url: string; video_path: string; duration: number; video_url: string }

interface FaceSwapProps {
  sharedFaceFile: File | null
  sharedFaceUrl: string | null
  onFaceSelect: (file: File, url: string) => void
  avatarHistory: HistoryItem[]
  faceRegistered: boolean
}

function FaceSwapPanel({ sharedFaceFile, sharedFaceUrl, onFaceSelect, avatarHistory, faceRegistered }: FaceSwapProps) {
  const [targetVideo, setTargetVideo] = useState<File | null>(null)
  const [ytUrl, setYtUrl] = useState('')
  const [ytTitle, setYtTitle] = useState('')
  const [ytDownloading, setYtDownloading] = useState(false)
  const [ytJobId, setYtJobId] = useState<string | null>(null)
  const [ytStart, setYtStart] = useState('')
  const [ytEnd, setYtEnd] = useState('')
  const [ytHistory, setYtHistory] = useState<YtHistory[]>([])
  const [stage, setStage] = useState('')
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    fetch(`${API}/avatar/ytdl/history`).then(r => r.json())
      .then(d => setYtHistory(d.history ?? [])).catch(() => {})
  }, [])

  const selectAvatarFace = async (thumbUrl: string) => {
    const res = await fetch(`${API}${thumbUrl}`)
    const blob = await res.blob()
    onFaceSelect(new File([blob], 'face.jpg', { type: 'image/jpeg' }), `${API}${thumbUrl}`)
  }

  const downloadYoutube = async () => {
    if (!ytUrl.trim()) return
    setYtDownloading(true); setError(null); setYtTitle('')
    try {
      const res = await fetch(`${API}/avatar/ytdl`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ url: ytUrl, start: ytStart, end: ytEnd })
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      const ytPoll = setInterval(async () => {
        const r = await fetch(`${API}/avatar/ytdl/${d.job_id}`)
        const s = await r.json()
        if (s.stage === 'done') {
          clearInterval(ytPoll); setYtDownloading(false)
          setYtTitle(s.title); setYtJobId(d.job_id)
          // 히스토리 갱신
          fetch(`${API}/avatar/ytdl/history`).then(r=>r.json()).then(h=>setYtHistory(h.history??[])).catch(()=>{})
        } else if (s.stage === 'error') {
          clearInterval(ytPoll); setYtDownloading(false); setError(s.error)
        }
      }, 2000)
    } catch(e) { setYtDownloading(false); setError(String(e)) }
  }

  const selectHistory = (h: YtHistory) => {
    setYtJobId(h.job_id); setYtTitle(h.title); setYtUrl(h.url)
  }

  const startSwap = async () => {
    if (!targetVideo && !ytJobId) return
    setStage('업로드 중…'); setError(null); setResultUrl(null)
    const form = new FormData()
    if (sharedFaceFile) {
      form.append('source_face', sharedFaceFile)
    } else {
      const res = await fetch(`${API}/avatar/face`)
      const blob = await res.blob()
      form.append('source_face', blob, 'face.jpg')
    }
    if (ytJobId) {
      // YouTube 다운로드된 영상을 서버에서 직접 사용
      form.append('yt_job_id', ytJobId)
    } else {
      form.append('target_video', targetVideo!)
    }
    try {
      const res = await fetch(`${API}/avatar/faceswap`, { method: 'POST', body: form })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setStage('얼굴 교체 중…')
      pollRef.current = setInterval(async () => {
        const r = await fetch(`${API}/avatar/faceswap/${d.job_id}`)
        const s = await r.json()
        if (s.stage === 'done') {
          clearInterval(pollRef.current!); setStage('완료')
          setResultUrl(`${API}${s.video_url}`)
        } else if (s.stage === 'error') {
          clearInterval(pollRef.current!); setError(s.error); setStage('')
        }
      }, 3000)
    } catch(e) { setError(String(e)); setStage('') }
  }

  const canStart = (!!targetVideo || !!ytJobId) && (!stage || stage === '완료')

  return (
    <div className="flex gap-6 h-full p-6 overflow-auto bg-white">
      <div className="w-80 flex flex-col gap-4 shrink-0">
        <h2 className="text-sm font-semibold text-gray-900">모드 C — 얼굴 교체</h2>
        <p className="text-xs text-gray-400">대상 영상의 얼굴을 내 얼굴로 교체합니다</p>

        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">내 얼굴 사진</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {/* 등록된 내 얼굴 */}
            {faceRegistered && (
              <button onClick={async () => {
                const res = await fetch(`${API}/avatar/face`)
                const blob = await res.blob()
                onFaceSelect(new File([blob], 'face.jpg', { type: 'image/jpeg' }), `${API}/avatar/face`)
              }}
                className={`shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 transition ${
                  sharedFaceUrl === `${API}/avatar/face` ? 'border-gray-900' : 'border-gray-200 hover:border-gray-400'
                }`} title="등록된 내 얼굴">
                <img src={`${API}/avatar/face`} className="w-full h-full object-cover" alt="내 얼굴" />
              </button>
            )}
            {avatarHistory.map(h => (
              <button key={h.job_id} onClick={() => selectAvatarFace(h.thumb_url)}
                className={`shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 transition ${
                  sharedFaceUrl === `${API}${h.thumb_url}` ? 'border-indigo-500' : 'border-gray-200 hover:border-gray-400'
                }`} title={h.created_at}>
                <img src={`${API}${h.thumb_url}`} className="w-full h-full object-cover" alt={h.created_at}
                  onError={e => { (e.target as HTMLImageElement).style.display='none' }} />
              </button>
            ))}
            <label className="shrink-0 w-14 h-14 rounded-xl border-2 border-dashed border-gray-200 hover:border-gray-400 flex items-center justify-center cursor-pointer text-gray-400 text-lg transition"
              title="파일에서 선택">
              +
              <input type="file" accept="image/*" className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) onFaceSelect(f, URL.createObjectURL(f))
                }} />
            </label>
          </div>
          {sharedFaceFile && <p className="text-[10px] text-indigo-500 mt-1">✓ {sharedFaceFile.name} 선택됨</p>}
          {!sharedFaceFile && <p className="text-[10px] text-gray-400 mt-1">미선택 시 등록된 얼굴 자동 사용</p>}
        </div>

        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">대상 영상 <span className="text-red-400">*</span></p>
          {/* YouTube URL */}
          <div className="flex gap-2 mb-2">
            <input value={ytUrl} onChange={e => setYtUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && downloadYoutube()}
              placeholder="YouTube URL 붙여넣기…"
              className="flex-1 border border-gray-200 rounded-xl px-3 py-1.5 text-xs outline-none focus:border-indigo-400" />
            <button onClick={downloadYoutube} disabled={!ytUrl.trim() || ytDownloading}
              className="px-3 py-1.5 text-xs rounded-xl bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 transition whitespace-nowrap">
              {ytDownloading ? '⬇…' : '⬇ 받기'}
            </button>
          </div>
          {/* 구간 선택 */}
          <div className="flex gap-2 mb-2">
            <div className="flex-1">
              <p className="text-[10px] text-gray-400 mb-0.5">시작 (선택)</p>
              <input value={ytStart} onChange={e => setYtStart(e.target.value)}
                placeholder="00:01:30" className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-indigo-400" />
            </div>
            <div className="flex-1">
              <p className="text-[10px] text-gray-400 mb-0.5">끝 (선택)</p>
              <input value={ytEnd} onChange={e => setYtEnd(e.target.value)}
                placeholder="00:02:00" className="w-full border border-gray-200 rounded-lg px-2 py-1 text-xs outline-none focus:border-indigo-400" />
            </div>
          </div>
          <p className="text-[10px] text-gray-400 mb-2">미입력 시 최대 120초 자동 자르기</p>
          {ytTitle && <p className="text-[10px] text-green-600 mb-2">✓ {ytTitle}</p>}

          {/* YouTube 히스토리 */}
          {ytHistory.length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] text-gray-500 mb-1">이전 다운로드 목록</p>
              <div className="space-y-1 max-h-36 overflow-y-auto">
                {ytHistory.map(h => (
                  <button key={h.job_id} onClick={() => selectHistory(h)}
                    className={`w-full text-left px-2 py-1.5 rounded-lg border text-[10px] transition ${
                      ytJobId === h.job_id ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-200 hover:border-gray-400 text-gray-600'
                    }`}>
                    <div className="truncate font-medium">{h.title}</div>
                    <div className="text-gray-400">{h.duration ? `${Math.floor(h.duration/60)}분 ${h.duration%60}초` : ''}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 mb-2">
            <div className="flex-1 h-px bg-gray-200" />
            <span className="text-[10px] text-gray-400">또는 파일 선택</span>
            <div className="flex-1 h-px bg-gray-200" />
          </div>
          <label className={`w-full py-2 text-xs rounded-xl border border-dashed transition cursor-pointer flex items-center justify-center ${
            targetVideo ? 'border-indigo-400 text-indigo-600' : 'border-gray-300 text-gray-500 hover:border-gray-500'
          }`}>
            {targetVideo ? `🎬 ${targetVideo.name}` : '📂 영상 선택 (mp4, avi, mov…)'}
            <input type="file" accept="video/*" className="hidden"
              onChange={e => setTargetVideo(e.target.files?.[0] ?? null)} />
          </label>
        </div>

        <button onClick={startSwap} disabled={!canStart}
          className="py-2.5 rounded-xl bg-gray-900 hover:bg-gray-700 disabled:opacity-40 text-white text-sm font-medium transition">
          {stage && stage !== '완료' ? stage : '얼굴 교체 시작'}
        </button>
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-2xl border border-gray-100">
        {resultUrl
          ? <video src={resultUrl} controls autoPlay loop className="max-h-full rounded-2xl shadow-lg" />
          : stage && stage !== '완료'
            ? <div className="text-center text-gray-400">
                <div className="text-5xl mb-4 animate-pulse">🔄</div>
                <p className="text-sm">{stage}</p>
                <p className="text-xs mt-1 text-gray-300">프레임별 처리 중 (1~5분)</p>
              </div>
            : <div className="text-center text-gray-300">
                <div className="text-6xl mb-4">🎭</div>
                <p className="text-sm">교체된 영상이 여기에 표시됩니다</p>
              </div>
        }
      </div>
    </div>
  )
}

const STAGE_LABELS: Record<string, string> = {
  queued:     '대기 중…',
  tts:        '1/2 — 음성 합성 중 (XTTS)…',
  sadtalker:  '2/2 — 립싱크 영상 생성 중 (SadTalker)…',
  done:       '완료',
  error:      '오류 발생',
}

interface HistoryItem { job_id: string; created_at: string; video_url: string; thumb_url: string }

export default function AvatarStudio() {
  const [faceFile, setFaceFile]               = useState<File | null>(null)
  const [facePreview, setFacePreview]         = useState<string | null>(null)
  const [faceRegistered, setFaceRegistered]   = useState(false)
  const [text, setText]                       = useState('')
  const [voiceRegistered, setVoiceRegistered] = useState(false)
  // 모드 A/C 공유 얼굴 상태
  const [sharedFaceFile, setSharedFaceFile]   = useState<File | null>(null)
  const [sharedFaceUrl, setSharedFaceUrl]     = useState<string | null>(null)
  const onFaceSelect = (file: File, url: string) => {
    setSharedFaceFile(file); setSharedFaceUrl(url)
    setFaceFile(file); setFacePreview(url)
  }
  const [refPoseFile, setRefPoseFile]         = useState<File | null>(null)
  const [refPoseName, setRefPoseName]         = useState<string | null>(null)
  const [speechStyle, setSpeechStyle]         = useState('')
  const [persona, setPersona]                 = useState('')
  const [styleOptions, setStyleOptions]       = useState<{speech_style:string[], persona:string[]}>({speech_style:[], persona:[]})
  const [videoUrl, setVideoUrl]               = useState<string | null>(null)
  const [loading, setLoading]                 = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [stage, setStage]                     = useState('')
  const [history, setHistory]                 = useState<HistoryItem[]>([])
  const [jobId, setJobId]                     = useState<string | null>(null)
  const [webcamActive, setWebcamActive]       = useState(false)
  const [micRecording, setMicRecording]       = useState(false)
  const [micStatus, setMicStatus]             = useState('')

  const faceInputRef    = useRef<HTMLInputElement>(null)
  const voiceInputRef   = useRef<HTMLInputElement>(null)
  const refPoseInputRef = useRef<HTMLInputElement>(null)
  const webcamRef     = useRef<HTMLVideoElement>(null)
  const webcamStream  = useRef<MediaStream | null>(null)
  const micRecorder   = useRef<MediaRecorder | null>(null)
  const micChunks     = useRef<Blob[]>([])
  const pollRef       = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const d = await (await fetch(`${API}/avatar/history`)).json()
      setHistory(d.history ?? [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    fetch(`${API}/avatar/voice_status`)
      .then(r => r.json())
      .then(d => {
        setVoiceRegistered(d.registered ?? false)
        setFaceRegistered(d.face_registered ?? false)
      })
      .catch(() => {})
    loadHistory()
    fetch(`${API}/profile/me`).then(r => r.json()).then(d => {
      setStyleOptions({ speech_style: d.options?.speech_style ?? [], persona: d.options?.persona ?? [] })
      setSpeechStyle(d.profile?.speech_style?.value ?? '')
      setPersona(d.profile?.persona?.value ?? '')
    }).catch(() => {})
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      webcamStream.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  const pollJob = useCallback((id: string) => {
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`${API}/avatar/job/${id}`)
        const data = await res.json()
        setStage(STAGE_LABELS[data.stage] ?? data.stage)
        if (data.stage === 'done') {
          stopPolling(); setVideoUrl(`${API}/avatar/job/${id}/video`); setLoading(false); loadHistory()
        } else if (data.stage === 'error') {
          stopPolling(); setError(data.error || '알 수 없는 오류'); setStage(''); setLoading(false)
        }
      } catch { /* 계속 폴링 */ }
    }, 3000)
  }, [])

  // 웹캠 열기
  const openWebcam = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      webcamStream.current = stream
      setWebcamActive(true)
      setTimeout(() => {
        if (webcamRef.current) {
          webcamRef.current.srcObject = stream
          webcamRef.current.play()
        }
      }, 100)
    } catch { setError('웹캠 접근 실패') }
  }

  // 웹캠 닫기
  const closeWebcam = () => {
    webcamStream.current?.getTracks().forEach(t => t.stop())
    webcamStream.current = null
    setWebcamActive(false)
  }

  // 웹캠에서 캡처
  const captureFromWebcam = () => {
    const video = webcamRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 640
    canvas.height = video.videoHeight || 480
    const ctx = canvas.getContext('2d')!
    // 미러 해제하여 자연스러운 얼굴로 저장
    ctx.translate(canvas.width, 0); ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0)
    canvas.toBlob(blob => {
      if (!blob) return
      const file = new File([blob], 'webcam.jpg', { type: 'image/jpeg' })
      setFaceFile(file)
      setFacePreview(canvas.toDataURL('image/jpeg'))
      closeWebcam()
    }, 'image/jpeg', 0.95)
  }

  // 마이크 녹음 시작
  const startMicRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      micChunks.current = []
      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' })
      recorder.ondataavailable = e => { if (e.data.size > 0) micChunks.current.push(e.data) }
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setMicStatus('등록 중…')
        const blob = new Blob(micChunks.current, { type: 'audio/webm' })
        const form = new FormData()
        form.append('sample', blob, 'voice.webm')
        try {
          const res  = await fetch(`${API}/avatar/register_voice`, { method: 'POST', body: form })
          const data = await res.json()
          if (res.ok) {
            setVoiceRegistered(true)
            setMicStatus(`✓ 등록 완료 (${data.duration}초)`)
          } else {
            setMicStatus('등록 실패: ' + data.error)
          }
        } catch { setMicStatus('등록 실패') }
        setMicRecording(false)
      }
      recorder.start()
      micRecorder.current = recorder
      setMicRecording(true)
      setMicStatus('녹음 중… (말하세요)')
    } catch { setMicStatus('마이크 접근 실패') }
  }

  const stopMicRecording = () => {
    micRecorder.current?.stop()
    micRecorder.current = null
  }

  const onFaceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    setFaceFile(f)
    setFacePreview(URL.createObjectURL(f))
  }

  const onVoiceChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    const form = new FormData(); form.append('sample', f)
    setError(null)
    try {
      const res  = await fetch(`${API}/avatar/register_voice`, { method: 'POST', body: form })
      const data = await res.json()
      if (res.ok) { setVoiceRegistered(true); setStage(`목소리 등록 완료 (${data.duration}초)`) }
      else setError(data.error)
    } catch { setError('목소리 등록 실패') }
  }

  const canGenerate = (!!faceFile || faceRegistered) && !!text.trim() && voiceRegistered && !loading

  const handleGenerate = async () => {
    if (!canGenerate) return
    stopPolling(); setLoading(true); setError(null); setVideoUrl(null); setStage('요청 전송 중…')
    try {
      const form = new FormData()
      if (faceFile) {
        form.append('face', faceFile)
      } else {
        // 등록된 얼굴 사진을 서버에서 Blob으로 가져와서 첨부
        const faceRes = await fetch(`${API}/avatar/face`)
        const faceBlob = await faceRes.blob()
        form.append('face', faceBlob, 'face.jpg')
      }
      form.append('text', text)
      if (refPoseFile) form.append('ref_pose', refPoseFile)
      const res  = await fetch(`${API}/avatar/generate_async`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setJobId(data.job_id); setStage(STAGE_LABELS['queued']); pollJob(data.job_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setStage(''); setLoading(false)
    }
  }

  const [mode, setMode] = useState<'A'|'C'>('A')

  if (mode === 'C') return (
    <div className="flex flex-col h-full">
      <div className="flex gap-2 px-6 pt-4 shrink-0">
        {(['A','C'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`px-4 py-1.5 text-xs rounded-full border transition ${
              mode === m ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-600 hover:border-gray-400'
            }`}>
            {m === 'A' ? '🎬 TTS + 립싱크' : '🎭 얼굴 교체'}
          </button>
        ))}
      </div>
      <FaceSwapPanel
        sharedFaceFile={sharedFaceFile}
        sharedFaceUrl={sharedFaceUrl}
        onFaceSelect={onFaceSelect}
        avatarHistory={history}
        faceRegistered={faceRegistered}
      />
    </div>
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-2 px-6 pt-4 shrink-0">
        {(['A','C'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)}
            className={`px-4 py-1.5 text-xs rounded-full border transition ${
              mode === m ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-600 hover:border-gray-400'
            }`}>
            {m === 'A' ? '🎬 TTS + 립싱크' : '🎭 얼굴 교체'}
          </button>
        ))}
      </div>
    <div className="flex gap-6 flex-1 p-6 overflow-auto bg-white">
      {/* 왼쪽: 입력 */}
      <div className="w-80 flex flex-col gap-4 shrink-0">
        <h2 className="text-sm font-semibold text-gray-900">TTS + 립싱크</h2>

        {/* 얼굴 사진 */}
        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">얼굴 사진</p>

          {webcamActive ? (
            /* 웹캠 미리보기 */
            <div className="flex flex-col gap-2">
              <video ref={webcamRef} autoPlay playsInline muted
                className="w-full h-40 object-cover rounded-xl bg-black"
                style={{ transform: 'scaleX(-1)' }} />
              <div className="flex gap-2">
                <button onClick={captureFromWebcam}
                  className="flex-1 py-2 text-sm rounded-xl bg-gray-900 text-white hover:bg-gray-700 transition">
                  📸 찍기
                </button>
                <button onClick={closeWebcam}
                  className="px-3 py-2 text-sm rounded-xl border border-gray-200 text-gray-500 hover:bg-gray-50 transition">
                  취소
                </button>
              </div>
            </div>
          ) : (
            /* 사진 선택 영역 */
            <div className="flex flex-col gap-2">
              <button
                onClick={() => faceInputRef.current?.click()}
                className="w-full h-40 border-2 border-dashed border-gray-200 rounded-xl flex items-center justify-center hover:border-gray-400 transition overflow-hidden bg-gray-50"
              >
                {facePreview
                  ? <img src={facePreview} className="w-full h-full object-cover" alt="face" />
                  : faceRegistered
                    ? <img src={`${API}/avatar/face?t=${Date.now()}`} className="w-full h-full object-cover" alt="등록된 얼굴" />
                    : <span className="text-gray-400 text-sm">클릭하여 이미지 선택</span>
                }
              </button>
              <button onClick={openWebcam}
                className="w-full py-2 text-sm rounded-xl border border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition text-gray-600">
                📷 웹캠으로 촬영
              </button>
              <input ref={faceInputRef} type="file" accept="image/*" className="hidden" onChange={onFaceChange} />
            </div>
          )}
        </div>

        {/* 목소리 */}
        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">
            목소리 샘플 {voiceRegistered
              ? <span className="text-green-600">✓ 등록됨</span>
              : <span className="text-amber-500">미등록</span>}
          </p>
          <div className="flex gap-2">
            {micRecording ? (
              <button onClick={stopMicRecording}
                className="flex-1 py-2 text-sm rounded-xl bg-red-600 text-white hover:bg-red-500 transition animate-pulse">
                ⏹ 녹음 완료
              </button>
            ) : (
              <button onClick={startMicRecording}
                className="flex-1 py-2 text-sm rounded-xl border border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition text-gray-600">
                🎙 마이크 녹음
              </button>
            )}
            <button onClick={() => voiceInputRef.current?.click()}
              className="flex-1 py-2 text-sm rounded-xl border border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition text-gray-600">
              📁 파일 선택
            </button>
          </div>
          {micStatus && <p className="text-xs mt-1 text-gray-500">{micStatus}</p>}
          {voiceRegistered && (
            <div className="mt-2">
              <p className="text-[10px] text-gray-400 mb-1">등록된 목소리 샘플</p>
              <audio controls src={`${API}/avatar/voice_sample`} className="w-full h-8" style={{ height: '32px' }} />
            </div>
          )}
          <input ref={voiceInputRef} type="file" accept="audio/*" className="hidden" onChange={onVoiceChange} />
        </div>

        {/* 텍스트 */}
        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">발화 텍스트</p>
          <textarea value={text} onChange={e => setText(e.target.value)} rows={4}
            placeholder="아바타가 말할 내용을 입력하세요"
            className="w-full border border-gray-200 rounded-xl p-3 text-sm text-gray-900 resize-none outline-none focus:border-gray-400 placeholder-gray-300 bg-white" />
        </div>

        {/* 말투 & 성격 */}
        {(styleOptions.speech_style.length > 0 || styleOptions.persona.length > 0) && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-gray-600">말투 & 성격</p>
            {styleOptions.speech_style.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {styleOptions.speech_style.map(opt => (
                  <button key={opt} onClick={() => setSpeechStyle(p => p === opt ? '' : opt)}
                    className={`px-2.5 py-1 text-[11px] rounded-full border transition ${
                      speechStyle === opt ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500 hover:border-gray-400'
                    }`}>{opt}</button>
                ))}
              </div>
            )}
            {styleOptions.persona.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {styleOptions.persona.map(opt => (
                  <button key={opt} onClick={() => setPersona(p => p === opt ? '' : opt)}
                    className={`px-2.5 py-1 text-[11px] rounded-full border transition ${
                      persona === opt ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-500 hover:border-gray-400'
                    }`}>{opt}</button>
                ))}
              </div>
            )}
            {(speechStyle || persona) && (
              <button onClick={async () => {
                await fetch(`${API}/profile/me`, { method: 'POST', headers: {'Content-Type':'application/json'},
                  body: JSON.stringify({ speech_style: speechStyle, persona }) })
              }} className="text-[10px] text-indigo-500 hover:text-indigo-700">저장</button>
            )}
          </div>
        )}

        {/* 얼굴 선택 (히스토리) */}
        {history.length > 0 && (
          <div>
            <p className="text-xs font-medium text-gray-600 mb-2">얼굴 선택</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {/* 현재 등록된 얼굴 */}
              {faceRegistered && (
                <button
                  onClick={() => { setFacePreview(null); setFaceFile(null) }}
                  className={`shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 transition ${
                    !facePreview && !faceFile ? 'border-gray-900' : 'border-gray-200 hover:border-gray-400'
                  }`}
                  title="내 등록 얼굴">
                  <img src={`${API}/avatar/face`} className="w-full h-full object-cover" alt="나" />
                </button>
              )}
              {/* 히스토리 얼굴들 */}
              {history.map(h => (
                <button key={h.job_id}
                  onClick={async () => {
                    const res = await fetch(`${API}${h.thumb_url}`)
                    const blob = await res.blob()
                    const url = URL.createObjectURL(blob)
                    const file = new File([blob], 'face.jpg', { type: 'image/jpeg' })
                    onFaceSelect(file, url)
                  }}
                  className={`shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 transition ${
                    facePreview && faceFile?.name === 'face.jpg' && facePreview.includes('blob')
                      ? 'border-indigo-500' : 'border-gray-200 hover:border-gray-400'
                  }`}
                  title={h.created_at}>
                  <img src={`${API}${h.thumb_url}`} className="w-full h-full object-cover" alt={h.created_at}
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 참조 포즈 영상 */}
        <div>
          <p className="text-xs font-medium text-gray-600 mb-1">
            포즈 참조 영상 <span className="text-gray-400 font-normal">(선택 — 이 영상의 동작으로 내 얼굴이 움직임)</span>
          </p>
          <div className="flex gap-2 items-center">
            <button onClick={() => refPoseInputRef.current?.click()}
              className="flex-1 py-2 text-xs rounded-xl border border-dashed border-gray-300 hover:border-gray-500 text-gray-500 hover:text-gray-700 transition">
              {refPoseName ? `🎬 ${refPoseName}` : '📂 영상 파일 선택 (mp4, avi, mov…)'}
            </button>
            {refPoseFile && (
              <button onClick={() => { setRefPoseFile(null); setRefPoseName(null) }}
                className="text-xs px-2 py-2 rounded-xl border border-gray-200 text-gray-400 hover:text-red-500 transition">✕</button>
            )}
          </div>
          <input ref={refPoseInputRef} type="file" accept="video/*" className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) { setRefPoseFile(f); setRefPoseName(f.name) }
            }} />
          {refPoseFile && <p className="text-[10px] text-indigo-500 mt-1">✓ 이 영상의 포즈로 생성됩니다</p>}
        </div>

        <button onClick={handleGenerate} disabled={!canGenerate}
          className="py-2.5 rounded-xl bg-gray-900 hover:bg-gray-700 disabled:opacity-40 text-white text-sm font-medium transition">
          {loading ? '생성 중…' : '영상 생성'}
        </button>

        {loading && stage && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-blue-500 animate-pulse shrink-0" />
              <p className="text-xs text-gray-600">{stage}</p>
            </div>
            <div className="flex gap-1 mt-1">
              {['tts', 'sadtalker'].map((s, i) => {
                const currentIdx = stage.includes('1/2') ? 0 : stage.includes('2/2') ? 1 : -1
                return (
                  <div key={s} className={`h-1 flex-1 rounded-full transition-colors ${
                    i < currentIdx ? 'bg-green-400' : i === currentIdx ? 'bg-blue-400' : 'bg-gray-200'
                  }`} />
                )
              })}
            </div>
            {jobId && <p className="text-[10px] text-gray-300 mt-0.5">job: {jobId.slice(0, 8)}…</p>}
          </div>
        )}
        {!loading && stage && !error && <p className="text-xs text-gray-500">{stage}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      {/* 가운데: 결과 영상 */}
      <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-2xl border border-gray-100 min-w-0">
        {videoUrl
          ? <video src={videoUrl} controls autoPlay loop className="max-h-full rounded-2xl shadow-lg" />
          : loading
            ? (
              <div className="text-center text-gray-400">
                <div className="text-5xl mb-4 animate-pulse">⏳</div>
                <p className="text-sm font-medium">{stage || '처리 중…'}</p>
                <p className="text-xs mt-1 text-gray-300">총 5~8분 소요 (3초마다 상태 확인)</p>
              </div>
            )
            : (
              <div className="text-center text-gray-300">
                <div className="text-6xl mb-4">🎬</div>
                <p className="text-sm">영상이 여기에 표시됩니다</p>
              </div>
            )
        }
      </div>

      {/* 오른쪽: 이전 생성 목록 */}
      {history.length > 0 && (
        <div className="w-48 shrink-0 flex flex-col gap-2 overflow-y-auto">
          <p className="text-xs font-semibold text-gray-600 shrink-0">이전 생성 목록</p>
          <p className="text-[10px] text-gray-400 shrink-0">클릭: 재생 · 길게 클릭: 이 얼굴로 설정</p>
          {history.map(h => {
            const isSelected = facePreview === `${API}${h.thumb_url}`
            return (
            <div key={h.job_id} className={`rounded-xl overflow-hidden border-2 transition cursor-pointer ${
              videoUrl === `${API}${h.video_url}` ? 'border-gray-900' : isSelected ? 'border-indigo-500' : 'border-transparent hover:border-gray-300'
            }`}>
              <img src={`${API}${h.thumb_url}`} className="w-full aspect-square object-cover"
                alt="thumb"
                onClick={() => setVideoUrl(`${API}${h.video_url}`)}
                onError={e => { (e.target as HTMLImageElement).src = '' }} />
              <div className="flex gap-1 px-1 py-1 bg-white">
                <button className="flex-1 text-[9px] text-gray-500 hover:text-gray-900 transition"
                  onClick={() => setVideoUrl(`${API}${h.video_url}`)}>▶ 재생</button>
                <button className="flex-1 text-[9px] text-indigo-500 hover:text-indigo-700 font-medium transition"
                  onClick={async () => {
                    const res = await fetch(`${API}${h.thumb_url}`)
                    const blob = await res.blob()
                    const url = URL.createObjectURL(blob)
                    setFacePreview(url)
                    setFaceFile(new File([blob], 'face.jpg', { type: 'image/jpeg' }))
                  }}>👤 사용</button>
              </div>
              <div className="text-[9px] text-gray-400 px-1 pb-0.5 bg-white">{h.created_at}</div>
            </div>
          )})}
        </div>
      )}
    </div>
    </div>
  )
}
