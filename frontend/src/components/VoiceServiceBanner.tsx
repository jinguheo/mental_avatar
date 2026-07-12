// 음성 서버(TTS·STT) 준비 상태 배너 — 서버가 준비 중이거나 꺼졌을 때만 나타난다.
//
// 사용자가 "말했는데 아무 반응이 없어서 마냥 기다리는" 상황을 없애기 위한 것.
// 백엔드 /status/services를 폴링해서
//   - starting: "준비 중…" 안내(대기하면 됨)
//   - down:     "재시작 필요" 경고 + [다시 시작] 버튼
// 을 보여준다. 모두 ready면 배너 자체가 렌더되지 않는다(평소엔 안 보임).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { API_BASE } from '../config'

type SvcState = 'ready' | 'starting' | 'down'
interface Svc { state: SvcState; message: string }
interface Status { xtts: Svc; stt: Svc }

export function useVoiceServiceStatus(pollMs = 5000) {
  const [status, setStatus] = useState<Status | null>(null)
  const [offline, setOffline] = useState(false)   // API 서버(8766) 자체가 응답 없음
  const [restarting, setRestarting] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/status/services`, { signal: AbortSignal.timeout(4000) })
      if (r.ok) {
        setStatus(await r.json())
        setOffline(false)
      } else {
        // 응답은 왔지만 이 엔드포인트가 없음(구버전 서버 = 404 등). 서버가 죽은 건 아니므로
        // "연결 불가" 빨간 경고를 띄우지 않는다 — 상태 미상으로 두고 배너를 숨긴다.
        setStatus(null)
        setOffline(false)
      }
    } catch {
      // fetch 자체 실패(네트워크 끊김/타임아웃) = 서버 무응답
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    poll()
    timer.current = setInterval(poll, pollMs)
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [poll, pollMs])

  const restart = useCallback(async () => {
    setRestarting(true)
    try {
      await fetch(`${API_BASE}/status/restart_voice`, { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {})
      await poll()
    } finally {
      // 재시작 트리거 후 모델 로딩에 시간이 걸리므로 잠시 뒤 상태가 starting→ready로 바뀐다
      setTimeout(() => setRestarting(false), 3000)
    }
  }, [poll])

  return { status, offline, restarting, restart, poll }
}

/** 준비 중/꺼짐일 때만 보이는 상단 배너. ready면 null 반환. */
export default function VoiceServiceBanner() {
  const { status, offline, restarting, restart } = useVoiceServiceStatus()

  if (offline) {
    return (
      <Bar tone="down">
        <span>⚠️ API 서버(127.0.0.1:8766)에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.</span>
      </Bar>
    )
  }
  if (!status) return null

  const items = [
    { key: 'tts', label: 'TTS', svc: status.xtts },
    { key: 'stt', label: 'STT', svc: status.stt },
  ].filter(i => i.svc.state !== 'ready')

  if (!items.length) return null   // 모두 준비됨 → 아무것도 안 보임

  const anyDown = items.some(i => i.svc.state === 'down')
  const tone: Tone = anyDown ? 'down' : 'starting'

  return (
    <Bar tone={tone}>
      <div className="flex-1 flex flex-col gap-0.5">
        {items.map(i => (
          <span key={i.key}>
            {i.svc.state === 'starting' ? '⏳' : '⚠️'} <b>{i.label}</b> — {i.svc.message}
          </span>
        ))}
      </div>
      {anyDown && (
        <button
          onClick={restart}
          disabled={restarting}
          className="shrink-0 px-3 py-1 rounded-md bg-white/90 text-slate-800 text-xs font-semibold hover:bg-white disabled:opacity-60"
        >
          {restarting ? '재시작 중…' : '다시 시작'}
        </button>
      )}
    </Bar>
  )
}

type Tone = 'starting' | 'down'
function Bar({ tone, children }: { tone: Tone; children: ReactNode }) {
  const bg = tone === 'down' ? 'bg-rose-500/90' : 'bg-amber-500/90'
  return (
    <div className={`${bg} text-white text-xs px-3 py-2 rounded-lg flex items-center gap-3 shadow`}>
      {children}
    </div>
  )
}
