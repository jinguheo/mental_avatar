// 워처(문서 감시 + 자동 백업) 상태 배너 — 멈춰 있을 때만 나타난다.
//
// 워처가 죽으면 새 문서가 지식그래프에 안 들어가고 시간별 백업도 멈추는데, 화면 어디에도
// 표시가 없어서 실제로 7일 동안 멈춘 걸 아무도 몰랐다(2026-07-09~16). 백엔드는 이미
// 하트비트로 생사를 알고 있었으므로(/watcher/health), 그 절반을 사용자에게 보여준다.
//
// 서버가 2분마다 자동 복구하므로 평소엔 잠깐 'starting'만 스치거나 아예 안 보인다.
// 이 배너는 자동 복구가 계속 실패할 때 사용자가 알아차리기 위한 안전망이다.
// 음성 배너(VoiceServiceBanner)와 달리 특정 뷰가 아니라 App 전역에 붙는다 — 워처는
// 어느 탭에 있든 배후에서 돌아야 하는 것이라, 아바타 화면에만 띄우면 또 놓치게 된다.
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '../config'

type SvcState = 'ready' | 'starting' | 'down'
interface Svc { state: SvcState; message: string }

export default function WatcherBanner({ pollMs = 15000 }: { pollMs?: number }) {
  const [svc, setSvc] = useState<Svc | null>(null)
  const [restarting, setRestarting] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/status/services`, { signal: AbortSignal.timeout(4000) })
      if (!r.ok) { setSvc(null); return }        // 구버전 서버(404 등) → 상태 미상, 배너 숨김
      const data = await r.json()
      setSvc(data.watcher ?? null)
    } catch {
      // API 서버 자체가 무응답이면 워처 상태를 알 수 없다. 그건 VoiceServiceBanner가
      // "8766 연결 불가"로 이미 알려주므로 여기서 중복 경고하지 않는다.
      setSvc(null)
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
      await fetch(`${API_BASE}/watcher/restart`, { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {})
      await poll()
    } finally {
      setTimeout(() => { setRestarting(false); poll() }, 3000)
    }
  }, [poll])

  if (!svc || svc.state === 'ready') return null   // 정상이면 아무것도 안 보임

  const down = svc.state === 'down'
  return (
    <div className={`${down ? 'bg-rose-500/90' : 'bg-amber-500/90'} mx-3 mt-2 flex items-center gap-3 rounded-lg px-3 py-2 text-xs text-white shadow`}>
      <span className="flex-1">
        {down ? '⚠️' : '⏳'} <b>문서 감시</b> — {svc.message}
      </span>
      {down && (
        <button
          onClick={restart}
          disabled={restarting}
          className="shrink-0 rounded-md bg-white/90 px-3 py-1 text-xs font-semibold text-slate-800 hover:bg-white disabled:opacity-60"
        >
          {restarting ? '재시작 중…' : '다시 시작'}
        </button>
      )}
    </div>
  )
}
