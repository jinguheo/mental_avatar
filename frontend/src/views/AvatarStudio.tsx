import { useState, useRef, useEffect } from 'react'

const API = 'http://127.0.0.1:8766'

export default function AvatarStudio() {
  const [faceFile, setFaceFile]               = useState<File | null>(null)
  const [facePreview, setFacePreview]         = useState<string | null>(null)
  const [text, setText]                       = useState('')
  const [voiceRegistered, setVoiceRegistered] = useState(false)
  const [videoUrl, setVideoUrl]               = useState<string | null>(null)
  const [loading, setLoading]                 = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [status, setStatus]                   = useState('')
  const faceInputRef  = useRef<HTMLInputElement>(null)
  const voiceInputRef = useRef<HTMLInputElement>(null)

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
    const form = new FormData()
    form.append('sample', f)
    setError(null)
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

  const canGenerate = !!faceFile && !!text.trim() && voiceRegistered && !loading

  const handleGenerate = async () => {
    if (!canGenerate || !faceFile) return
    setLoading(true)
    setError(null)
    setVideoUrl(null)
    setStatus('생성 중… (5~8분 소요)')

    try {
      const form = new FormData()
      form.append('face', faceFile)
      form.append('text', text)
      const res = await fetch(`${API}/avatar/tts_generate`, { method: 'POST', body: form })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      setVideoUrl(URL.createObjectURL(blob))
      setStatus('완료')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('')
    } finally {
      setLoading(false)
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
          <button
            onClick={() => faceInputRef.current?.click()}
            className="w-full h-40 border-2 border-dashed border-gray-200 rounded-xl flex items-center justify-center hover:border-gray-400 transition overflow-hidden bg-gray-50"
          >
            {facePreview
              ? <img src={facePreview} className="w-full h-full object-cover" alt="face" />
              : <span className="text-gray-400 text-sm">클릭하여 이미지 선택</span>
            }
          </button>
          <input ref={faceInputRef} type="file" accept="image/*" className="hidden" onChange={onFaceChange} />
        </div>

        {/* 목소리 */}
        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">
            목소리 샘플 {voiceRegistered
              ? <span className="text-green-600">✓ 등록됨</span>
              : <span className="text-amber-500">미등록</span>}
          </p>
          <button
            onClick={() => voiceInputRef.current?.click()}
            className="w-full py-2 text-sm rounded-xl border border-gray-200 hover:border-gray-400 hover:bg-gray-50 transition text-gray-600"
          >
            WAV 파일 업로드
          </button>
          <input ref={voiceInputRef} type="file" accept="audio/*" className="hidden" onChange={onVoiceChange} />
        </div>

        {/* 텍스트 */}
        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">발화 텍스트</p>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
            placeholder="아바타가 말할 내용을 입력하세요"
            className="w-full border border-gray-200 rounded-xl p-3 text-sm text-gray-900 resize-none outline-none focus:border-gray-400 placeholder-gray-300 bg-white"
          />
        </div>

        <button
          onClick={handleGenerate}
          disabled={!canGenerate}
          className="py-2.5 rounded-xl bg-gray-900 hover:bg-gray-700 disabled:opacity-40 text-white text-sm font-medium transition"
        >
          {loading ? '생성 중…' : '영상 생성'}
        </button>

        {status && <p className="text-xs text-gray-500">{status}</p>}
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>

      {/* 오른쪽: 결과 */}
      <div className="flex-1 flex items-center justify-center bg-gray-50 rounded-2xl border border-gray-100">
        {videoUrl
          ? <video src={videoUrl} controls autoPlay loop className="max-h-full rounded-2xl shadow-lg" />
          : (
            <div className="text-center text-gray-300">
              <div className="text-6xl mb-4">🎬</div>
              <p className="text-sm">영상이 여기에 표시됩니다</p>
            </div>
          )
        }
      </div>
    </div>
  )
}
