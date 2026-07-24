import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '../config'

// 아바타 AI 대화 중 자동 생성되는 노트 — my-dashboard의 노트(별도 앱)와는 완전히 별개로,
// mental-avatar 자체 KG(knowledge.db)에 source_type='note'로 쌓인다.

type Note = {
  id: string
  view: string
  title: string
  content: string
  node_id: string
  created_at: string
}

const VIEW_LABELS: Record<string, string> = {
  avatar3d_chat: 'AI 대화',
  realistic_avatar: '실사 아바타',
}

export default function Notes() {
  const [items, setItems] = useState<Note[]>([])
  const [count, setCount] = useState(0)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (q: string) => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      const r = await fetch(`${API_BASE}/notes?${params.toString()}`)
      const d = await r.json()
      setItems(d.items || [])
      setCount(d.count || 0)
    } catch {
      setError('노트를 가져오지 못했습니다 (서버 연결 확인).')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load('')
  }, [load])

  const remove = useCallback(
    async (id: string) => {
      try {
        await fetch(`${API_BASE}/notes/${id}`, { method: 'DELETE' })
        await load(query)
      } catch {
        /* ignore */
      }
    },
    [load, query],
  )

  return (
    <div className="view-canvas h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <header className="view-header -mx-4 -mt-5 border-x-0 px-4 py-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <p className="dashboard-kicker">자동 캡처</p>
          <h1 className="mt-1 text-xl font-semibold text-gray-950">노트</h1>
          <p className="mt-1 text-xs text-gray-500">
            아바타와 대화할 때 다시 찾아볼 만한 내용이 있으면 자동으로 정리돼 쌓입니다. (누적 {count}개)
          </p>
        </header>

        {/* 검색 */}
        <section className="view-panel p-4 sm:p-5">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && load(query)}
              placeholder="노트 검색…"
              className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
            />
            <button
              type="button"
              onClick={() => load(query)}
              disabled={loading}
              className="shrink-0 rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:opacity-50"
            >
              {loading ? '검색 중…' : '검색'}
            </button>
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(''); load('') }}
                className="shrink-0 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-gray-500 transition hover:bg-gray-50"
              >
                지우기
              </button>
            )}
          </div>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </section>

        {/* 노트 목록 */}
        <section className="view-panel overflow-hidden">
          <div className="border-b border-surface-border px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold text-gray-950">
              {query ? `검색 결과 (${items.length})` : `전체 노트 (${items.length})`}
            </h2>
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-400 sm:px-5">
              {query ? '검색 결과가 없습니다.' : '아직 자동 생성된 노트가 없습니다. 아바타와 대화해보세요.'}
            </p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {items.map(n => (
                <li key={n.id} className="group flex items-start gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-950">{n.title}</p>
                      {VIEW_LABELS[n.view] && (
                        <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">
                          {VIEW_LABELS[n.view]}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-gray-700">{n.content}</p>
                    <p className="mt-1 text-[11px] text-gray-400">{n.created_at}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(n.id)}
                    title="삭제"
                    className="shrink-0 rounded-md px-2 py-1 text-gray-300 transition hover:bg-red-50 hover:text-red-600"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
