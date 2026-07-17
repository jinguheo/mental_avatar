import { useState, useRef, useEffect, useCallback } from 'react'
import { API_BASE } from '@/config'
import { clearFaceImageCaches, getRegisteredFaceImageUrl, saveTrackingVideoSource } from '@/faceAlignment'

const API = API_BASE

const LAST_TEXT_KEY = 'mental-avatar-studio-last-text'
const RECOMMENDED_TEXTS = [
  '안녕하세요, 저는 저를 대신하는 디지털 아바타입니다. 만나서 반갑습니다.',
  '오늘 날씨가 정말 좋네요. 산책하기 딱 좋은 날인 것 같아요.',
  '이 프로젝트는 제 지식과 말투를 그대로 담아내는 것을 목표로 하고 있습니다.',
  '와, 정말 놀라운 결과네요! 기대했던 것보다 훨씬 좋아요.',
]

interface YtHistory { job_id: string; title: string; url: string; video_path: string; duration: number; video_url: string }

function getYoutubeVideoId(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1).split('/')[0] || null
    const queryId = url.searchParams.get('v')
    if (queryId) return queryId
    const match = url.pathname.match(/\/(?:shorts|embed|live)\/([^/?]+)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((n, i) => i === 0 ? String(n).padStart(2, '0') : String(n).padStart(2, '0')).join(':')
}

function youtubePlaybackError(code: number): string {
  if (code === 2) return 'YouTube 영상 ID 또는 링크 형식이 올바르지 않습니다.'
  if (code === 5) return '브라우저에서 재생할 수 없는 형식의 영상입니다.'
  if (code === 100) return '영상이 삭제되었거나 비공개 상태입니다.'
  if (code === 101 || code === 150) return '영상 소유자가 외부 사이트 재생을 제한했습니다. YouTube에서만 재생할 수 있습니다.'
  if (code === 153) return 'YouTube가 이 환경의 임베드 재생을 허용하지 않았습니다.'
  return `YouTube 재생이 제한되었습니다. (오류 코드 ${code})`
}

function youtubeDownloadError(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('private') || lower.includes('sign in') || lower.includes('age')) return '비공개·로그인 필요·연령 제한 영상이라 다운로드할 수 없습니다.'
  if (lower.includes('not available') || lower.includes('unavailable') || lower.includes('removed')) return '삭제되었거나 현재 이용할 수 없는 영상입니다.'
  if (lower.includes('copyright')) return '저작권 제한으로 다운로드가 거부되었습니다.'
  if (lower.includes('unsupported url')) return '지원하지 않는 YouTube 링크 형식입니다.'
  return `YouTube 다운로드에 실패했습니다: ${message}`
}

function YoutubeSegmentPicker({ url, onStart, onEnd }: { url: string; onStart: (value: string) => void; onEnd: (value: string) => void }) {
  const videoId = getYoutubeVideoId(url)
  const containerRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<any>(null)
  const [ready, setReady] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackError, setPlaybackError] = useState('')

  useEffect(() => {
    if (!videoId || !containerRef.current) return
    setReady(false); setCurrent(0); setDuration(0); setPlaybackError('')
    const createPlayer = () => {
      if (!containerRef.current || !(window as any).YT?.Player) return
      playerRef.current?.destroy?.()
      playerRef.current = new (window as any).YT.Player(containerRef.current, {
        videoId,
        playerVars: { playsinline: 1, rel: 0 },
        events: {
          onReady: (event: any) => { setReady(true); setDuration(event.target.getDuration() || 0) },
          onError: (event: any) => { setReady(false); setPlaybackError(youtubePlaybackError(event.data)) },
        },
      })
    }
    const w = window as any
    if (w.YT?.Player) createPlayer()
    else {
      const script = document.getElementById('youtube-iframe-api') || document.createElement('script')
      script.id = 'youtube-iframe-api'; script.setAttribute('src', 'https://www.youtube.com/iframe_api')
      if (!script.parentNode) document.head.appendChild(script)
      const previous = w.onYouTubeIframeAPIReady
      w.onYouTubeIframeAPIReady = () => { previous?.(); createPlayer() }
    }
    return () => { playerRef.current?.destroy?.(); playerRef.current = null }
  }, [videoId])

  useEffect(() => {
    if (!ready) return
    const timer = window.setInterval(() => {
      const player = playerRef.current
      if (player?.getCurrentTime) { setCurrent(player.getCurrentTime() || 0); setDuration(player.getDuration() || 0) }
    }, 500)
    return () => window.clearInterval(timer)
  }, [ready])

  if (!videoId) return <p className="text-[10px] text-red-500 mb-2">YouTube 링크 형식을 확인해주세요.</p>
  return <div className="mb-2 rounded-xl border border-red-100 bg-red-50/30 p-2">
    <div ref={containerRef} className="aspect-video w-full overflow-hidden rounded-lg bg-black" />
    {playbackError && <p className="mt-2 rounded-md bg-red-100 px-2 py-1.5 text-[10px] leading-relaxed text-red-700">재생 불가: {playbackError}</p>}
    <div className="flex items-center justify-between gap-2 mt-2 text-[10px] text-gray-500">
      <span>현재 위치 {formatTimestamp(current)} / {formatTimestamp(duration)}</span>
      <div className="flex gap-1">
        <button type="button" disabled={!ready} onClick={() => onStart(formatTimestamp(current))}
          className="px-2 py-1 rounded-md bg-white border border-gray-200 hover:border-indigo-400 disabled:opacity-40">현재 위치를 시작</button>
        <button type="button" disabled={!ready} onClick={() => onEnd(formatTimestamp(current))}
          className="px-2 py-1 rounded-md bg-white border border-gray-200 hover:border-indigo-400 disabled:opacity-40">현재 위치를 종료</button>
      </div>
    </div>
  </div>
}

interface FaceSwapProps {
  sharedFaceFile: File | null
  sharedFaceUrl: string | null
  onFaceSelect: (file: File, url: string) => void | Promise<void>
  avatarHistory: HistoryItem[]
  faceRegistered: boolean
  onYoutubeSaved?: (item: YtHistory) => void
}

function FaceSwapPanel({ sharedFaceFile, sharedFaceUrl, onFaceSelect, avatarHistory, faceRegistered, onYoutubeSaved }: FaceSwapProps) {
  // 마운트 시점 한 번만 고정되는 캐시 버스팅 값 — 등록된 얼굴 사진이 서버에서 바뀐 뒤에도
  // 브라우저가 예전 이미지를 계속 붙들고 있지 않도록, 이 탭을 새로 열 때마다 최신본을 받아온다.
  const [faceVersion] = useState(() => Date.now())
  const [targetVideo, setTargetVideo] = useState<File | null>(null)
  const [targetPreviewUrl, setTargetPreviewUrl] = useState<string | null>(null)
  const [ytUrl, setYtUrl] = useState('')
  const [ytTitle, setYtTitle] = useState('')
  const [ytDownloading, setYtDownloading] = useState(false)
  const [ytDownloadStatus, setYtDownloadStatus] = useState('')
  const [ytJobId, setYtJobId] = useState<string | null>(null)
  const [ytStart, setYtStart] = useState('')
  const [ytEnd, setYtEnd] = useState('')
  const [ytHistory, setYtHistory] = useState<YtHistory[]>([])
  const [poseSamples, setPoseSamples] = useState<{name:string, video_url:string}[]>([])
  // CUDA/ONNX 네이티브 충돌로 API가 종료되는 환경이 있어 CPU를 안전한 기본값으로 사용한다.
  const [useGpu, setUseGpu] = useState(false)
  const [stage, setStage] = useState('')
  const [progress, setProgress] = useState(0)
  const [processedFrames, setProcessedFrames] = useState(0)
  const [totalFrames, setTotalFrames] = useState(0)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [serverRestarting, setServerRestarting] = useState(false)
  const [faceswapHistory, setFaceswapHistory] = useState<{job_id:string, created_at:string, video_url:string, thumb_url:string}[]>([])
  const [activeFaceswapJobs, setActiveFaceswapJobs] = useState<{job_id:string, stage:string, progress:number, processed_frames:number, total_frames:number}[]>([])
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadFaceswapHistory = useCallback(() => {
    fetch(`${API}/avatar/faceswap/history`).then(r => r.json())
      .then(d => setFaceswapHistory(d.history ?? [])).catch(() => {})
  }, [])

  useEffect(() => {
    const loadActiveJobs = async () => {
      try {
        const r = await fetch(`${API}/avatar/faceswap/active`)
        if (r.ok) setActiveFaceswapJobs((await r.json()).jobs ?? [])
      } catch { /* status-only request */ }
    }
    loadActiveJobs()
    const timer = window.setInterval(loadActiveJobs, 3000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    fetch(`${API}/avatar/ytdl/history`).then(r => r.json())
      .then(d => setYtHistory(d.history ?? [])).catch(() => {})
    // 모드 A(TTS+립싱크)의 "포즈 참조 영상" 후보를 여기서도 대상 영상으로 재활용
    fetch(`${API}/avatar/ref_pose/samples`).then(r => r.json())
      .then(d => setPoseSamples(d.samples ?? [])).catch(() => {})
    loadFaceswapHistory()
  }, [loadFaceswapHistory])

  // 다른 화면으로 이동해도 진행 중인 얼굴교체 작업의 상태를 다시 복원한다.
  useEffect(() => {
    const savedJobId = sessionStorage.getItem('mental-avatar-faceswap-job')
    if (!savedJobId) return
    let stopped = false
    setActiveJobId(savedJobId)
    setStage('얼굴 교체 작업 복원 중')
    const resume = async () => {
      try {
        const r = await fetch(`${API}/avatar/faceswap/${savedJobId}`)
        if (r.status === 404) {
          sessionStorage.removeItem('mental-avatar-faceswap-job')
          setActiveJobId(null)
          setStage('')
          setProgress(0)
          setTimeout(() => setError(null), 0)
          setError('이전 얼굴교체 작업은 서버 재시작으로 종료되었습니다. 원본을 선택해 다시 시작해주세요.')
          return
        }
        if (!r.ok) throw new Error(`작업 상태 응답 ${r.status}`)
        const s = await r.json()
        if (stopped) return
        if (typeof s.progress === 'number') setProgress(s.progress)
        if (typeof s.processed_frames === 'number') setProcessedFrames(s.processed_frames)
        if (typeof s.total_frames === 'number') setTotalFrames(s.total_frames)
        if (s.stage === 'done') {
          sessionStorage.removeItem('mental-avatar-faceswap-job')
          setProgress(100); setStage('완료'); setResultUrl(`${API}${s.video_url}`); setActiveJobId(null)
          loadFaceswapHistory()
        } else if (s.stage === 'error') {
          sessionStorage.removeItem('mental-avatar-faceswap-job')
          setError(s.error || '얼굴교체 처리 오류'); setStage(''); setActiveJobId(null)
        } else if (s.stage === 'canceled') {
          sessionStorage.removeItem('mental-avatar-faceswap-job')
          setError('얼굴교체 작업이 취소되었습니다.'); setStage(''); setActiveJobId(null)
        } else {
          setStage(s.stage || '얼굴 교체 중')
        }
      } catch (e) {
        if (!stopped) setError(`작업 상태 복원 실패: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    resume()
    const timer = window.setInterval(resume, 3000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [loadFaceswapHistory])

  const selectPoseSampleAsTarget = async (videoUrl: string, name: string) => {
    setError(null)
    try {
      const res = await fetch(`${API}${videoUrl}`)
      const blob = await res.blob()
      setTargetVideo(new File([blob], name, { type: 'video/mp4' }))
      setTargetPreviewUrl(`${API}${videoUrl}`)
      setYtJobId(null); setYtTitle('')
    } catch (e) { setError(String(e)) }
  }

  const selectAvatarFace = async (thumbUrl: string) => {
    const res = await fetch(`${API}${thumbUrl}`)
    const blob = await res.blob()
    onFaceSelect(new File([blob], 'face.jpg', { type: 'image/jpeg' }), `${API}${thumbUrl}`)
  }

  const downloadYoutube = async () => {
    if (!ytUrl.trim()) return
    setYtDownloading(true); setYtDownloadStatus('다운로드 요청 중…'); setError(null); setYtTitle('')
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
          clearInterval(ytPoll); setYtDownloading(false); setYtDownloadStatus('다운로드 완료 · 포즈 참조에 추가됨')
          setYtTitle(s.title); setYtJobId(d.job_id)
          setTargetPreviewUrl(s.video_url?.startsWith('http') ? s.video_url : `${API}${s.video_url}`)
          onYoutubeSaved?.({
            job_id: d.job_id, title: s.title || 'pose.mp4', url: ytUrl,
            video_path: '', duration: s.duration || 0, video_url: s.video_url,
          })
          // 히스토리 갱신
          fetch(`${API}/avatar/ytdl/history`).then(r=>r.json()).then(h=>{
            setYtHistory(h.history??[])
            if (h.history?.[0]) onYoutubeSaved?.(h.history[0])
          }).catch(()=>{})
        } else if (s.stage === 'error') {
          clearInterval(ytPoll); setYtDownloading(false); setYtDownloadStatus('다운로드 실패'); setError(youtubeDownloadError(s.error || '알 수 없는 오류'))
        }
      }, 2000)
    } catch(e) { setYtDownloading(false); setYtDownloadStatus('다운로드 실패'); setError(youtubeDownloadError(String(e))) }
  }

  const selectHistory = (h: YtHistory) => {
    setYtJobId(h.job_id); setYtTitle(h.title); setYtUrl(h.url); setTargetVideo(null)
    setTargetPreviewUrl(h.video_url?.startsWith('http') ? h.video_url : `${API}${h.video_url}`)
  }

  const deleteYoutube = async (h: YtHistory) => {
    if (!confirm(`'${h.title}' 영상을 삭제할까요?`)) return
    try {
      const res = await fetch(`${API}/avatar/ytdl/${h.job_id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error || '삭제 실패')
      setYtHistory(prev => prev.filter(item => item.job_id !== h.job_id))
      if (ytJobId === h.job_id) { setYtJobId(null); setTargetVideo(null); setTargetPreviewUrl(null); setYtTitle('') }
    } catch (e) { setError(String(e)) }
  }

  const startSwap = async () => {
    if (!targetVideo && !ytJobId) return
    setProgress(0); setProcessedFrames(0); setTotalFrames(0)
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
    form.append('use_gpu', String(useGpu))
    try {
      const res = await fetch(`${API}/avatar/faceswap`, { method: 'POST', body: form })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      setActiveJobId(d.job_id)
      sessionStorage.setItem('mental-avatar-faceswap-job', d.job_id)
      setCanceling(false)
      setStage('얼굴 교체 중…')
      pollRef.current = setInterval(async () => {
        try {
        const r = await fetch(`${API}/avatar/faceswap/${d.job_id}`)
        if (!r.ok) {
          clearInterval(pollRef.current!)
          setStage('')
          setError('얼굴 교체 작업 상태를 잃었습니다. 서버가 재시작되었거나 작업 정보가 만료되었습니다.')
          return
        }
        const s = await r.json()
        if (typeof s.progress === 'number') setProgress(s.progress)
        if (typeof s.processed_frames === 'number') setProcessedFrames(s.processed_frames)
        if (typeof s.total_frames === 'number') setTotalFrames(s.total_frames)
        if (s.stage === 'done') {
          clearInterval(pollRef.current!); setProgress(100); setStage('완료')
          setResultUrl(`${API}${s.video_url}`)
          setActiveJobId(null)
          sessionStorage.removeItem('mental-avatar-faceswap-job')
          loadFaceswapHistory()
        } else if (s.stage === 'error') {
          clearInterval(pollRef.current!); setError(s.error); setStage(''); setActiveJobId(null)
          sessionStorage.removeItem('mental-avatar-faceswap-job')
        }
        } catch (e) {
          clearInterval(pollRef.current!)
          setActiveJobId(null)
          setStage('')
          setError(`서버 연결 오류: ${e instanceof Error ? e.message : String(e)} (API 서버가 종료되었거나 재시작되었습니다.)`)
        }
      }, 3000)
    } catch(e) { setError(String(e)); setStage('') }
  }

  const canStart = (!!targetVideo || !!ytJobId) && (!stage || stage === '완료')

  const cancelSwap = async () => {
    if (!activeJobId || canceling) return
    setCanceling(true)
    try {
      const res = await fetch(`${API}/avatar/faceswap/${activeJobId}/cancel`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '취소 요청 실패')
      if (pollRef.current) clearInterval(pollRef.current)
      setStage('취소 중…')
      setError(null)
      const waitCanceled = window.setInterval(async () => {
        const status = await fetch(`${API}/avatar/faceswap/${activeJobId}`)
        if (!status.ok) { window.clearInterval(waitCanceled); setActiveJobId(null); setCanceling(false); setStage(''); return }
        const s = await status.json()
        if (s.stage === 'canceled' || s.stage === 'error') {
          window.clearInterval(waitCanceled)
          setActiveJobId(null); setCanceling(false); setStage(''); setProgress(0)
          setError(s.stage === 'canceled' ? '얼굴 교체 작업을 취소했습니다.' : s.error)
        }
      }, 500)
    } catch (e) {
      setCanceling(false)
      setError(String(e))
    }
  }

  const restartServer = async () => {
    setServerRestarting(true)
    setError('API 서버 재시작 요청 중…')
    try {
      const response = await fetch(`${API}/server/restart`, { method: 'POST', signal: AbortSignal.timeout(5000) })
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}))
        setServerRestarting(false)
        setError(detail.error || `서버 응답 ${response.status}`)
        return
      }
    } catch {
      // 서버가 종료되면 fetch가 끊길 수 있으므로 정상적인 재시작 과정으로 본다.
    }
    window.setTimeout(async () => {
      for (let i = 0; i < 12; i += 1) {
        try {
          const health = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) })
          if (health.ok) {
            setServerRestarting(false)
            setError('API 서버가 재시작되었습니다. 얼굴교체를 다시 시작해주세요.')
            return
          }
        } catch { /* 재시작 대기 */ }
        await new Promise(resolve => window.setTimeout(resolve, 1000))
      }
      setServerRestarting(false)
      setError('API 서버 재시작을 확인하지 못했습니다. start_dashboard.bat를 실행해주세요.')
    }, 1800)
  }

  return (
    <div className="flex gap-6 h-full p-6 overflow-auto bg-white">
      <div className="w-80 flex flex-col gap-4 shrink-0">
        <h2 className="text-sm font-semibold text-gray-900">모드 C — 얼굴 교체</h2>
        <p className="text-xs text-gray-400">대상 영상의 얼굴을 내 얼굴로 교체합니다</p>

        <div>
          <p className="text-xs font-medium text-gray-600 mb-2">내 얼굴 사진</p>
           <p className="text-xs font-semibold text-gray-800 mb-2">1. 얼굴 교체에 사용할 얼굴</p>
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
                <img src={`${API}/avatar/face?t=${faceVersion}`} className="w-full h-full object-cover" alt="내 얼굴" />
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
          <p className="text-xs font-semibold text-gray-800 mb-2">2. 교체 대상 영상</p>
          {/* YouTube URL */}
          {ytUrl.trim() && <YoutubeSegmentPicker url={ytUrl} onStart={setYtStart} onEnd={setYtEnd} />}
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
          {ytDownloadStatus && <p className={`text-[10px] mb-2 ${ytDownloadStatus.includes('실패') ? 'text-red-500' : ytDownloadStatus.includes('완료') ? 'text-green-600' : 'text-indigo-500'}`}>{ytDownloadStatus}</p>}
          {ytHistory.length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] text-gray-500 mb-1">이전 다운로드 목록</p>
              <div className="space-y-1 max-h-36 overflow-y-auto">
                {ytHistory.map(h => (
                  <div key={h.job_id} className="flex gap-1 items-stretch">
                  <button onClick={() => selectHistory(h)}
                    className={`w-full text-left px-2 py-1.5 rounded-lg border text-[10px] transition ${
                      ytJobId === h.job_id ? 'border-indigo-400 bg-indigo-50 text-indigo-700' : 'border-gray-200 hover:border-gray-400 text-gray-600'
                    }`}>
                    <div className="truncate font-medium">{h.title}</div>
                    <div className="text-gray-400">{h.duration ? `${Math.floor(h.duration/60)}분 ${h.duration%60}초` : ''}</div>
                  </button>
                  <button onClick={() => deleteYoutube(h)} className="px-1.5 rounded-lg border border-gray-200 text-[10px] text-red-400 hover:bg-red-50" title="삭제">🗑</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 포즈 참조 영상 후보 (TTS+립싱크 모드와 공유) */}
          {poseSamples.length > 0 && (
            <div className="mb-2">
              <p className="text-[10px] text-gray-500 mb-1">포즈 참조 영상 후보에서 선택</p>
              <div className="space-y-1 max-h-36 overflow-y-auto">
                <p className="text-[10px] font-medium text-gray-600 mb-1">포즈 참조 영상 선택</p>
                {poseSamples.map(s => {
                  const label = s.name.replace(/\.mp4$/, '')
                  const selected = targetVideo?.name === s.name
                  return (
                    <button key={s.name} onClick={() => selectPoseSampleAsTarget(s.video_url, s.name)}
                      className={`w-full text-left px-2 py-1.5 rounded-lg border text-[10px] transition truncate ${
                        selected ? 'border-indigo-400 bg-indigo-50 text-indigo-700 font-medium' : 'border-gray-200 hover:border-gray-400 text-gray-600'
                      }`}>
                      {selected ? '✓ ' : '🎬 '}{label}
                    </button>
                  )
                })}
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
              onChange={e => {
                const f = e.target.files?.[0] ?? null
                setTargetVideo(f)
                if (f) { setTargetPreviewUrl(URL.createObjectURL(f)); setYtJobId(null); setYtTitle('') }
              }} />
          </label>
        </div>

        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {([[true,'⚡ GPU (빠름)'], [false,'CPU (느림)']] as [boolean, string][]).map(([gpu, label]) => (
            <button key={String(gpu)} onClick={() => setUseGpu(gpu)}
              className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition ${
                useGpu === gpu ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {label}
            </button>
          ))}
        </div>

        <button onClick={startSwap} disabled={!canStart}
          className="py-2.5 rounded-xl bg-gray-900 hover:bg-gray-700 disabled:opacity-40 text-white text-sm font-medium transition">
          {stage && stage !== '완료' ? stage : '얼굴 교체 시작'}
        </button>
        {activeJobId && <button onClick={cancelSwap} disabled={canceling}
          className="py-2 rounded-xl border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50 text-sm font-medium transition">
          {canceling ? '취소 중…' : '취소'}
        </button>}
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-600">
          <p className="break-words">{error}</p>
          <button onClick={restartServer} disabled={serverRestarting}
            className="mt-2 rounded-md border border-red-300 bg-white px-2 py-1 font-medium text-red-600 hover:bg-red-100 disabled:opacity-50">
            {serverRestarting ? '서버 재시작 중…' : 'API 서버 재시작'}
          </button>
        </div>}
      </div>

      <div className="relative flex-1 flex items-center justify-center bg-gray-50 rounded-2xl border border-gray-100 overflow-hidden">
        {!resultUrl && stage && targetPreviewUrl && <>
          <video src={targetPreviewUrl} controls autoPlay loop className="absolute inset-4 w-[calc(100%-2rem)] h-[calc(100%-2rem)] object-contain rounded-2xl shadow-lg bg-black z-10" />
          <div className="absolute left-8 right-8 bottom-8 z-20 rounded-xl bg-black/75 px-4 py-3 text-white">
            <div className="flex items-center justify-between text-xs mb-2"><span>{stage}</span><span>{Math.round(progress)}%{totalFrames > 0 ? ` · ${processedFrames}/${totalFrames}프레임` : ''}</span></div>
            <div className="h-2 rounded-full bg-white/25 overflow-hidden"><div className="h-full rounded-full bg-indigo-400 transition-all duration-500" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} /></div>
            {activeFaceswapJobs.length > 1 && <div className="mt-3 rounded-lg bg-black/35 p-2 text-[11px] text-white/80"><div className="mb-1 font-medium text-white">동시에 처리 중인 작업 {activeFaceswapJobs.length}개</div>{activeFaceswapJobs.map(job => <div key={job.job_id} className="flex items-center justify-between"><span>{job.job_id.slice(0, 8)}</span><span>{Math.round(job.progress)}% · {job.processed_frames}/{job.total_frames}프레임</span></div>)}</div>}
            <p className="text-[11px] text-white/70 mt-2">원본 영상은 그대로 재생되며, 교체 결과는 별도 파일로 저장됩니다.</p>
          </div>
        </>}
        {resultUrl
          ? <video src={resultUrl} controls autoPlay loop className="max-h-full rounded-2xl shadow-lg" />
          : stage && stage !== '완료'
            ? <div className="text-center text-gray-400">
                <div className="text-5xl mb-4 animate-pulse">🔄</div>
                <p className="text-sm">{stage}</p>
                <div className="w-64 mt-3 mx-auto">
                  <div className="h-2 rounded-full bg-gray-200 overflow-hidden">
                    <div className="h-full rounded-full bg-indigo-500 transition-all duration-500" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
                  </div>
                  <p className="text-xs mt-1 text-gray-400">{Math.round(progress)}% · 프레임 분석 및 얼굴 교체 중</p>
                </div>
                <p className="text-xs mt-1 text-gray-300">프레임별 처리 중 (1~5분)</p>
              </div>
            : targetPreviewUrl
              ? <div className="w-full h-full flex flex-col items-center justify-center gap-2 p-4">
                  <video src={targetPreviewUrl} controls autoPlay loop className="max-h-full max-w-full rounded-2xl shadow-lg" />
                  <p className="text-xs text-gray-400">원본 영상 미리보기</p>
                </div>
              : <div className="text-center text-gray-300">
                <div className="text-6xl mb-4">🎭</div>
                <p className="text-sm">교체된 영상이 여기에 표시됩니다</p>
              </div>
        }
      </div>

      {/* 오른쪽: 저장 목록 */}
      {faceswapHistory.length > 0 && (
        <div className="w-48 shrink-0 flex flex-col gap-2 overflow-hidden">
          <p className="text-xs font-semibold text-gray-600 shrink-0">저장 목록</p>
          <p className="text-[10px] text-gray-400 shrink-0">클릭: 재생</p>
          <div className="grid grid-cols-2 auto-rows-min gap-1.5 overflow-y-auto content-start items-start flex-1 min-h-0">
            {faceswapHistory.map(h => (
              <div key={h.job_id} className={`rounded-lg overflow-hidden border-2 transition ${
                resultUrl === `${API}${h.video_url}` ? 'border-gray-900' : 'border-transparent hover:border-gray-300'
              }`}>
                <img src={`${API}${h.thumb_url}`} className="w-full aspect-square object-cover cursor-pointer bg-gray-100"
                  alt="thumb"
                  onClick={() => setResultUrl(`${API}${h.video_url}`)}
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                <div className="flex gap-0.5 px-0.5 py-0.5 bg-white">
                  <button className="flex-1 text-[9px] text-gray-500 hover:text-gray-900 transition" title="재생"
                    onClick={() => setResultUrl(`${API}${h.video_url}`)}>▶</button>
                  <button className="flex-1 text-[9px] text-red-400 hover:text-red-600 font-medium transition" title="삭제"
                    onClick={async () => {
                      if (!confirm('이 영상을 삭제할까요?')) return
                      try {
                        await fetch(`${API}/avatar/faceswap/history/${h.job_id}`, { method: 'DELETE' })
                        if (resultUrl === `${API}${h.video_url}`) setResultUrl(null)
                        loadFaceswapHistory()
                      } catch { /* ignore */ }
                    }}>🗑</button>
                </div>
                <div className="text-[8px] text-gray-400 px-1 pb-0.5 bg-white truncate">{h.created_at}</div>
              </div>
            ))}
          </div>
        </div>
      )}
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
  // 마운트 시점 한 번만 고정되는 캐시 버스팅 값 — 서버 얼굴 사진이 바뀐 뒤에도
  // 브라우저가 예전 이미지를 계속 붙들고 있지 않도록, 탭을 새로 열 때마다 최신본을 받아온다.
  const [faceVersion] = useState(() => Date.now())
  const [text, setText]                       = useState(() => localStorage.getItem(LAST_TEXT_KEY) || '')
  const [voiceRegistered, setVoiceRegistered] = useState(false)
  // 모드 A/C 공유 얼굴 상태
  const [sharedFaceFile, setSharedFaceFile]   = useState<File | null>(null)
  const [sharedFaceUrl, setSharedFaceUrl]     = useState<string | null>(null)
  const [savingDefaultFace, setSavingDefaultFace] = useState(false)
  const registerSelectedFace = useCallback(async (file: File) => {
    const form = new FormData()
    form.append('face', file)
    const res = await fetch(`${API}/avatar/register_face`, { method: 'POST', body: form })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `face register failed (${res.status})`)
    clearFaceImageCaches()
    setFaceRegistered(true)
    return getRegisteredFaceImageUrl()
  }, [])

  useEffect(() => {
    const loadActiveJobs = async () => {
      try {
        const r = await fetch(`${API}/avatar/faceswap/active`)
        if (r.ok) await r.json()
      } catch { /* 상태 표시용 요청이므로 본 작업에는 영향 없음 */ }
    }
    loadActiveJobs()
    const timer = window.setInterval(loadActiveJobs, 3000)
    return () => window.clearInterval(timer)
  }, [])
  const onFaceSelect = (file: File, url: string) => {
    setSharedFaceFile(file); setSharedFaceUrl(url)
    setFaceFile(file); setFacePreview(url)
    setStage('얼굴 선택 완료 — 영상 생성에 사용됩니다')
  }
  const saveSelectedFaceAsDefault = async () => {
    if (!faceFile || savingDefaultFace) return
    setSavingDefaultFace(true)
    setError(null)
    try {
      const registeredUrl = await registerSelectedFace(faceFile)
      setSharedFaceUrl(registeredUrl)
      setFacePreview(registeredUrl)
      setStage('기본 얼굴 저장 완료')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingDefaultFace(false)
    }
  }
  const [refPoseFile, setRefPoseFile]         = useState<File | null>(null)
  const [refPoseName, setRefPoseName]         = useState<string | null>(null)
  const [poseSamples, setPoseSamples]         = useState<{name:string, video_url:string}[]>([])
  const [poseHistory, setPoseHistory]         = useState<YtHistory[]>([])
  const [poseYtUrl, setPoseYtUrl]             = useState('')
  const [poseYtBusy, setPoseYtBusy]           = useState(false)
  const [poseYtStatus, setPoseYtStatus]       = useState('')
  const [poseYtError, setPoseYtError]         = useState<string | null>(null)
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

  const loadPoseSamples = useCallback(async () => {
    try {
      const d = await (await fetch(`${API}/avatar/ref_pose/samples`)).json()
      setPoseSamples(d.samples ?? [])
    } catch { /* ignore */ }
  }, [])

  const loadPoseHistory = useCallback(async () => {
    try {
      const d = await (await fetch(`${API}/avatar/ytdl/history`)).json()
      setPoseHistory(d.history ?? [])
    } catch { /* ignore */ }
  }, [])

  const selectPoseVideo = async (videoUrl: string, name: string) => {
    setPoseYtError(null)
    try {
      const sourceUrl = videoUrl.startsWith('http') || videoUrl.startsWith('blob:')
        ? videoUrl
        : `${API}${videoUrl}`
      const res = await fetch(sourceUrl)
      const blob = await res.blob()
      setRefPoseFile(new File([blob], name, { type: 'video/mp4' }))
      setRefPoseName(name)
      setVideoUrl(sourceUrl)
    } catch (e) { setPoseYtError(String(e)) }
  }

  const deletePoseHistory = async (h: YtHistory) => {
    if (!confirm(`'${h.title}' 영상을 삭제할까요?`)) return
    try {
      const res = await fetch(`${API}/avatar/ytdl/${h.job_id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error((await res.json()).error || '삭제 실패')
      setPoseHistory(prev => prev.filter(item => item.job_id !== h.job_id))
      if (refPoseName === h.title) { setRefPoseFile(null); setRefPoseName(null); setVideoUrl(null) }
    } catch (e) { setPoseYtError(String(e)) }
  }

  const downloadPoseFromYoutube = async () => {
    if (!poseYtUrl.trim()) { setPoseYtStatus('YouTube 링크를 입력해주세요.'); return }
    setPoseYtBusy(true); setPoseYtStatus('다운로드 요청 중…'); setPoseYtError(null)
    try {
      const res = await fetch(`${API}/avatar/ytdl`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: poseYtUrl, max_sec: 30 })
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      const poll = setInterval(async () => {
        const r = await fetch(`${API}/avatar/ytdl/${d.job_id}`)
        const s = await r.json()
        if (s.stage === 'done') {
          clearInterval(poll); setPoseYtBusy(false); setPoseYtStatus('다운로드 완료 · 포즈 참조에 추가됨'); setPoseYtUrl('')
          const poseItem: YtHistory = {
            job_id: d.job_id, title: s.title || 'pose.mp4', url: poseYtUrl,
            video_path: '', duration: s.duration || 0, video_url: s.video_url,
          }
          setPoseHistory(prev => [poseItem, ...prev.filter(item => item.job_id !== poseItem.job_id)])
          await selectPoseVideo(s.video_url, poseItem.title)
          loadPoseHistory()
        } else if (s.stage === 'error') {
          clearInterval(poll); setPoseYtBusy(false); setPoseYtStatus('다운로드 실패'); setPoseYtError(s.error)
        }
      }, 2000)
    } catch (e) { setPoseYtBusy(false); setPoseYtStatus('다운로드 실패'); setPoseYtError(String(e)) }
  }

  useEffect(() => {
    fetch(`${API}/avatar/voice_status`)
      .then(r => r.json())
      .then(d => {
        setVoiceRegistered(d.registered ?? false)
        setFaceRegistered(d.face_registered ?? false)
      })
      .catch(() => {})
    loadHistory()
    loadPoseSamples()
    loadPoseHistory()
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
          const nextVideoUrl = `${API}/avatar/job/${id}/video`
          stopPolling(); setVideoUrl(nextVideoUrl); setLoading(false); loadHistory()
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
      onFaceSelect(file, canvas.toDataURL('image/jpeg'))
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
    onFaceSelect(f, URL.createObjectURL(f))
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
  const [pendingPoseSelection, setPendingPoseSelection] = useState<YtHistory | null>(null)

  useEffect(() => {
    if (mode !== 'A') return
    loadPoseHistory()
    if (pendingPoseSelection) {
      setPoseHistory(prev => prev.some(item => item.job_id === pendingPoseSelection.job_id)
        ? prev
        : [pendingPoseSelection, ...prev])
      selectPoseVideo(pendingPoseSelection.video_url, pendingPoseSelection.title)
      setPendingPoseSelection(null)
    }
  }, [mode, pendingPoseSelection, loadPoseHistory])

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
        onYoutubeSaved={setPendingPoseSelection}
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
    <div className="flex gap-4 flex-1 p-4 overflow-auto bg-gray-100">
      {/* ① 입력 */}
      <div className="w-[28rem] flex flex-col gap-4 shrink-0 bg-blue-50/40 rounded-2xl border-2 border-blue-200 p-5 overflow-y-auto">
        <div className="flex items-center gap-2 -mx-5 -mt-5 mb-1 px-5 py-2.5 rounded-t-2xl bg-blue-100 border-b-2 border-blue-200">
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold shrink-0">1</span>
          <h2 className="text-sm font-bold text-blue-900">입력 — 얼굴·목소리·텍스트</h2>
        </div>

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
          <textarea value={text} onChange={e => {
            setText(e.target.value)
            localStorage.setItem(LAST_TEXT_KEY, e.target.value)
          }} rows={4}
            placeholder="아바타가 말할 내용을 입력하세요"
            className="w-full border border-gray-200 rounded-xl p-3 text-sm text-gray-900 resize-none outline-none focus:border-gray-400 placeholder-gray-300 bg-white" />
          <div className="flex flex-wrap gap-1.5 mt-2">
            {RECOMMENDED_TEXTS.map((t, i) => (
              <button key={i} onClick={() => { setText(t); localStorage.setItem(LAST_TEXT_KEY, t) }}
                title={t}
                className="px-2.5 py-1 text-[11px] rounded-full border border-gray-200 text-gray-500 hover:border-gray-400 hover:bg-gray-50 transition truncate max-w-[9rem]">
                {t}
              </button>
            ))}
          </div>
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

      {/* ② 결과 & 옵션 */}
      <div className="flex-1 flex flex-col gap-3 min-w-0 min-h-0 bg-emerald-50/40 rounded-2xl border-2 border-emerald-200 p-5">
        <div className="flex items-center gap-2 -mx-5 -mt-5 mb-1 px-5 py-2.5 rounded-t-2xl bg-emerald-100 border-b-2 border-emerald-200 shrink-0">
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-emerald-600 text-white text-xs font-bold shrink-0">2</span>
          <h2 className="text-sm font-bold text-emerald-900">결과 &amp; 옵션</h2>
        </div>
        <div className="flex-[3] flex items-center justify-center bg-gray-50 rounded-2xl border border-gray-100 min-h-0">
          {videoUrl
            ? <video src={videoUrl} controls autoPlay loop className="max-h-full max-w-full rounded-2xl shadow-lg" />
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

        {/* 옵션 묶음 — 영상 재생 영역이 항상 크게 유지되도록 옵션들은 하단에 모아 최대 높이 제한 + 필요시 내부 스크롤 */}
        <div className="flex-[2] min-h-0 overflow-y-auto flex flex-col gap-3 pr-1">
        {/* 말투 & 성격 (왼쪽 패널이 너무 길어져서 여기로 이동) */}
        {(styleOptions.speech_style.length > 0 || styleOptions.persona.length > 0) && (
          <div className="shrink-0 space-y-2">
            <p className="text-xs font-medium text-gray-600">말투 & 성격</p>
            <div className="flex flex-wrap gap-1.5 items-center">
              {styleOptions.speech_style.map(opt => (
                <button key={opt} onClick={() => setSpeechStyle(p => p === opt ? '' : opt)}
                  className={`px-2.5 py-1 text-[11px] rounded-full border transition ${
                    speechStyle === opt ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500 hover:border-gray-400'
                  }`}>{opt}</button>
              ))}
              {styleOptions.persona.map(opt => (
                <button key={opt} onClick={() => setPersona(p => p === opt ? '' : opt)}
                  className={`px-2.5 py-1 text-[11px] rounded-full border transition ${
                    persona === opt ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-200 text-gray-500 hover:border-gray-400'
                  }`}>{opt}</button>
              ))}
              {(speechStyle || persona) && (
                <button onClick={async () => {
                  await fetch(`${API}/profile/me`, { method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ speech_style: speechStyle, persona }) })
                }} className="text-[10px] text-indigo-500 hover:text-indigo-700">저장</button>
              )}
            </div>
          </div>
        )}

        {/* 얼굴 선택 (히스토리, 왼쪽 패널이 너무 길어져서 여기로 이동) */}
        {history.length > 0 && (
          <div className="shrink-0">
            <p className="text-xs font-medium text-gray-600 mb-2">얼굴 선택</p>
            <div className="flex gap-2 flex-wrap pb-1">
              {/* 현재 등록된 얼굴 */}
              {faceRegistered && (
                <button
                  onClick={() => { setFacePreview(null); setFaceFile(null) }}
                  className={`relative shrink-0 w-14 h-14 rounded-xl overflow-hidden border-2 transition ring-1 ring-indigo-200 ${
                    !facePreview && !faceFile ? 'border-indigo-600 ring-indigo-300' : 'border-indigo-400 hover:border-indigo-600'
                  }`}
                  title="내 등록 얼굴">
                  <img src={`${API}/avatar/face?t=${faceVersion}`} className="w-full h-full object-cover" alt="나" />
                  <span className="absolute inset-x-0 bottom-0 bg-indigo-700/90 py-0.5 text-center text-[9px] font-semibold leading-tight text-white">
                    기본 얼굴
                  </span>
                </button>
              )}
              {/* 히스토리 얼굴들 — 클릭: 이 얼굴로 선택 / 우상단 ✕(hover): 이 생성 기록 삭제 */}
              {history.map(h => (
                <div key={h.job_id} className="relative shrink-0 group">
                  <button
                    onClick={async () => {
                      const res = await fetch(`${API}${h.thumb_url}`)
                      const blob = await res.blob()
                      const url = URL.createObjectURL(blob)
                      const file = new File([blob], 'face.jpg', { type: 'image/jpeg' })
                      onFaceSelect(file, url)
                    }}
                    className={`block w-14 h-14 rounded-xl overflow-hidden border-2 transition ${
                      facePreview && faceFile?.name === 'face.jpg' && facePreview.includes('blob')
                        ? 'border-indigo-500' : 'border-gray-200 hover:border-gray-400'
                    }`}
                    title={h.created_at}>
                    <img src={`${API}${h.thumb_url}`} className="w-full h-full object-cover" alt={h.created_at}
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  </button>
                  <button
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (!confirm('이 얼굴(생성 기록)을 삭제할까요? 함께 만든 영상도 삭제됩니다.')) return
                      try {
                        await fetch(`${API}/avatar/history/${h.job_id}`, { method: 'DELETE' })
                        if (videoUrl === `${API}${h.video_url}`) setVideoUrl(null)
                        loadHistory()
                      } catch { /* ignore */ }
                    }}
                    title="이 얼굴 삭제"
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-red-500 hover:bg-red-600 text-white text-[10px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100 transition shadow">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {faceFile && (
          <button
            type="button"
            onClick={saveSelectedFaceAsDefault}
            disabled={savingDefaultFace}
            className="w-fit rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
          >
            {savingDefaultFace ? '저장 중…' : '선택 얼굴을 기본 얼굴로 저장'}
          </button>
        )}

        {/* 참조 포즈 영상 */}
        <div className="shrink-0">
          <div className="flex items-center gap-2 mb-1.5">
            <p className="text-xs font-medium text-gray-600">
              포즈 참조 영상 <span className="text-gray-400 font-normal">(선택 — 이 영상의 동작으로 내 얼굴이 움직임)</span>
            </p>
            <button onClick={() => refPoseInputRef.current?.click()}
              className="text-xs px-3 py-1 rounded-lg border border-dashed border-gray-300 hover:border-gray-500 text-gray-500 hover:text-gray-700 transition">
              {refPoseName ? `🎬 ${refPoseName}` : '📂 영상 파일 선택'}
            </button>
            {refPoseFile && (
              <button onClick={() => { setRefPoseFile(null); setRefPoseName(null) }}
                className="text-xs px-2 py-1 rounded-lg border border-gray-200 text-gray-400 hover:text-red-500 transition">✕</button>
            )}
            <input value={poseYtUrl} onChange={e => setPoseYtUrl(e.target.value)}
              placeholder="유튜브 URL로 후보 추가 (30초만 사용)"
              className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1 text-[11px] outline-none focus:border-gray-400 placeholder-gray-300 bg-white" />
            <button onClick={downloadPoseFromYoutube} disabled={poseYtBusy || !poseYtUrl.trim()}
              className="px-2.5 py-1 text-[11px] rounded-lg border border-gray-200 text-gray-500 hover:border-gray-400 disabled:opacity-40 transition shrink-0">
              {poseYtBusy ? '받는 중…' : '추가'}
            </button>
          </div>
          {poseYtStatus && <p className={`text-[10px] mt-1 ${poseYtStatus.includes('실패') ? 'text-red-500' : poseYtStatus.includes('완료') ? 'text-green-600' : 'text-indigo-500'}`}>{poseYtStatus}</p>}
          <input ref={refPoseInputRef} type="file" accept="video/*" className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) {
                const sourceUrl = URL.createObjectURL(f)
                setRefPoseFile(f); setRefPoseName(f.name); setVideoUrl(sourceUrl)
              }
            }} />
          {refPoseFile && <p className="text-[10px] text-indigo-500 mb-1">✓ 이 영상의 포즈로 생성됩니다</p>}
          {poseYtError && <p className="text-[10px] text-red-500 mb-1">오류: {poseYtError}</p>}

          {/* 후보 영상 (번들 샘플 + 유튜브에서 받은 영상) — 재생 미리보기 + 선택, 넓은 공간이라 여러 열로 배치 */}
          {refPoseFile && videoUrl && (
            <button
              type="button"
              onClick={() => {
                saveTrackingVideoSource(videoUrl, refPoseName || refPoseFile.name)
                setStage('대화 탭 영상 등록 완료')
              }}
              className="mb-1 text-[11px] px-3 py-1.5 rounded-lg border border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 transition">
              대화 탭 영상으로 등록
            </button>
          )}

          {(poseSamples.length > 0 || poseHistory.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {poseSamples.map(s => {
                const label = s.name.replace(/\.mp4$/, '')
                const selected = refPoseName === s.name
                return (
                  <div key={s.name}
                    className={`flex items-center gap-2 p-1.5 rounded-xl border transition cursor-pointer w-48 ${
                      selected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-400'
                    }`}
                    onClick={() => { setVideoUrl(`${API}${s.video_url}`); selectPoseVideo(s.video_url, s.name) }}>
                    <div className="w-12 h-12 rounded-lg bg-gray-900 shrink-0 flex items-center justify-center text-white text-lg">▶</div>
                    <span className="flex-1 min-w-0 text-left text-[11px] text-gray-600 leading-snug truncate">
                      {selected && <span className="text-indigo-600 font-medium">✓ </span>}
                      {label}
                    </span>
                  </div>
                )
              })}
              {poseHistory.map(h => {
                const selected = refPoseName === h.title
                return (
                  <div key={h.job_id}
                    className={`flex items-center gap-2 p-1.5 rounded-xl border transition cursor-pointer w-48 ${
                      selected ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-400'
                    }`}
                    onClick={() => { setVideoUrl(`${API}${h.video_url}`); selectPoseVideo(h.video_url, h.title) }}>
                    <div className="w-12 h-12 rounded-lg bg-gray-900 shrink-0 flex items-center justify-center text-white text-lg">▶</div>
                    <span className="flex-1 min-w-0 text-left text-[11px] text-gray-600 leading-snug truncate">
                      {selected && <span className="text-indigo-600 font-medium">✓ </span>}
                      {h.title}
                    </span>
                    <button type="button" onClick={e => { e.stopPropagation(); deletePoseHistory(h) }}
                      className="shrink-0 text-[10px] text-red-400 hover:text-red-600" title="삭제">🗑</button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        </div>
      </div>

      {/* ③ 이전 생성 목록 */}
      {history.length > 0 && (
        <div className="w-52 shrink-0 flex flex-col gap-2 overflow-hidden bg-amber-50/40 rounded-2xl border-2 border-amber-200 p-4">
          <div className="flex items-center gap-2 -mx-4 -mt-4 mb-1 px-4 py-2.5 rounded-t-2xl bg-amber-100 border-b-2 border-amber-200 shrink-0">
            <span className="flex items-center justify-center w-6 h-6 rounded-full bg-amber-600 text-white text-xs font-bold shrink-0">3</span>
            <p className="text-xs font-bold text-amber-900">이전 생성 목록</p>
          </div>
          <p className="text-[10px] text-gray-400 shrink-0">클릭: 재생 · 길게 클릭: 이 얼굴로 설정</p>
          {/* 2열 그리드 — 항목이 컨테이너 높이에 맞춰 짜부라지지 않게(예전 flex-shrink 버그와 같은 종류) content-start만으론
              부족해서 auto-rows-min(행 높이를 내용 최소크기로) + items-start(기본 stretch 해제)까지 함께 필요했음 */}
          <div className="grid grid-cols-2 auto-rows-min gap-1.5 overflow-y-auto content-start items-start flex-1 min-h-0">
            {history.map(h => {
              const isSelected = facePreview === `${API}${h.thumb_url}`
              return (
              <div key={h.job_id} className={`rounded-lg overflow-hidden border-2 transition cursor-pointer ${
                videoUrl === `${API}${h.video_url}` ? 'border-gray-900' : isSelected ? 'border-indigo-500' : 'border-transparent hover:border-gray-300'
              }`}>
                <img src={`${API}${h.thumb_url}`} className="w-full aspect-square object-cover"
                  alt="thumb"
                  onClick={() => setVideoUrl(`${API}${h.video_url}`)}
                  onError={e => { (e.target as HTMLImageElement).src = '' }} />
                <div className="flex gap-0.5 px-0.5 py-0.5 bg-white">
                  <button className="flex-1 text-[9px] text-gray-500 hover:text-gray-900 transition" title="재생"
                    onClick={() => setVideoUrl(`${API}${h.video_url}`)}>▶</button>
                  <button className="flex-1 text-[9px] text-indigo-500 hover:text-indigo-700 font-medium transition" title="이 얼굴로 사용"
                    onClick={async () => {
                      const res = await fetch(`${API}${h.thumb_url}`)
                      const blob = await res.blob()
                      const url = URL.createObjectURL(blob)
                      await onFaceSelect(new File([blob], 'face.jpg', { type: 'image/jpeg' }), url)
                    }}>👤</button>
                  <button className="flex-1 text-[9px] text-red-400 hover:text-red-600 font-medium transition" title="삭제"
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (!confirm('이 영상을 삭제할까요?')) return
                      try {
                        await fetch(`${API}/avatar/history/${h.job_id}`, { method: 'DELETE' })
                        if (videoUrl === `${API}${h.video_url}`) setVideoUrl(null)
                        loadHistory()
                      } catch { /* ignore */ }
                    }}>🗑</button>
                </div>
                <div className="text-[8px] text-gray-400 px-1 pb-0.5 bg-white truncate">{h.created_at}</div>
              </div>
            )})}
          </div>
        </div>
      )}
    </div>
    </div>
  )
}
