// 시스템 상태 배너 — API 서버(8766)나 워처가 멈췄을 때만 나타난다. 정상이면 렌더 안 됨.
//
// 만든 이유 두 가지:
//  - 워처가 죽으면 새 문서가 지식그래프에 안 들어가고 시간별 백업도 멈추는데 화면 어디에도
//    표시가 없어서, 실제로 7일 동안(2026-07-09~16) 멈춘 걸 아무도 몰랐다.
//  - 8766이 죽으면 앱 전체가 무력해지는데, 그 경고가 아바타 3개 뷰에만 붙어 있어서
//    기억검색·설정 같은 다른 탭을 쓰는 동안엔 알 길이 없었다.
// 백엔드는 이미 둘 다 알고 있었으므로(하트비트, /status/services) 그 절반을 화면에 보여준다.
//
// 그래서 이 배너는 특정 뷰가 아니라 App 전역에 붙는다 — 어느 탭에 있든 배후에서 돌아야
// 하는 것들이라, 일부 화면에만 띄우면 또 놓치게 된다.
// 서버가 워처를 2분마다 자동 복구하므로 평소엔 잠깐 스치거나 아예 안 보이고, 이 배너는
// 자동 복구가 계속 실패할 때를 위한 안전망이다.
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '../config'

type SvcState = 'ready' | 'starting' | 'down'
interface Svc { state: SvcState; message: string }

export default function SystemStatusBanner({ pollMs = 15000 }: { pollMs?: number }) {
  const [watcher, setWatcher] = useState<Svc | null>(null)
  const [offline, setOffline] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/status/services`, { signal: AbortSignal.timeout(4000) })
      if (!r.ok) {
        // 응답은 왔으니 서버는 살아 있다(구버전이라 이 엔드포인트가 없는 등) → 경고하지 않는다
        setWatcher(null); setOffline(false); return
      }
      const data = await r.json()
      setWatcher(data.watcher ?? null)
      setOffline(false)
    } catch {
      setOffline(true)     // fetch 자체 실패 = 서버 무응답
      setWatcher(null)
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

  if (offline) {
    return (
      <Bar down>
        <span className="flex-1">
          ⚠️ <b>API 서버</b> — 127.0.0.1:8766에 연결할 수 없습니다. 서버가 실행 중인지 확인해주세요.
        </span>
      </Bar>
    )
  }
  if (!watcher || watcher.state === 'ready') return null

  const down = watcher.state === 'down'
  return (
    <Bar down={down}>
      <span className="flex-1">
        {down ? '⚠️' : '⏳'} <b>문서 감시</b> — {watcher.message}
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
    </Bar>
  )
}

function Bar({ down, children }: { down: boolean; children: React.ReactNode }) {
  return (
    <div className={`${down ? 'bg-rose-500/90' : 'bg-amber-500/90'} mx-3 mt-2 flex items-center gap-3 rounded-lg px-3 py-2 text-xs text-white shadow`}>
      {children}
    </div>
  )
}
