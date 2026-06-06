import { useState, useRef, useEffect, useCallback } from 'react'

const API = 'http://127.0.0.1:8766'

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
  const [videoUrl, setVideoUrl]               = useState<string | null>(null)
  const [loading, setLoading]                 = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [stage, setStage]                     = useState('')
  const [history, setHistory]                 = useState<HistoryItem[]>([])
  const [jobId, setJobId]                     = useState<string | null>(null)
  const [webcamActive, setWebcamActive]       = useState(false)
  const [micRecording, setMicRecording]       = useState(false)
  const [micStatus, setMicStatus]             = useState('')

  const faceInputRef  = useRef<HTMLInputElement>(null)
  const voiceInputRef = useRef<HTMLInputElement>(null)
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
      const res  = await fetch(`${API}/avatar/generate_async`, { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setJobId(data.job_id); setStage(STAGE_LABELS['queued']); pollJob(data.job_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); setStage(''); setLoading(false)
    }
  }

  return (
    <div className="flex gap-6 h-full p-6 overflow-auto bg-white">
      {/* 왼쪽: 입력 */}
      <div className="w-80 flex flex-col gap-4 shrink-0">
        <h2 className="text-sm font-semibold text-gray-900">모드 A — 영상 아바타</h2>

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
          <textarea value={text} onChange={e => setText(e.target.value)} rows={5}
            placeholder="아바타가 말할 내용을 입력하세요"
            className="w-full border border-gray-200 rounded-xl p-3 text-sm text-gray-900 resize-none outline-none focus:border-gray-400 placeholder-gray-300 bg-white" />
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
          {history.map(h => (
            <button key={h.job_id}
              onClick={() => setVideoUrl(`${API}${h.video_url}`)}
              className={`rounded-xl overflow-hidden border-2 transition ${
                videoUrl === `${API}${h.video_url}` ? 'border-gray-900' : 'border-transparent hover:border-gray-300'
              }`}>
              <img src={`${API}${h.thumb_url}`} className="w-full aspect-square object-cover" alt="thumb"
                onError={e => { (e.target as HTMLImageElement).src = '' }} />
              <div className="text-[10px] text-gray-500 px-1 py-0.5 bg-white">{h.created_at}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
