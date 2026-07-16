// 지식그래프 데이터 관리 — 노드를 필터로 추려 보고, 체크해서 직접 지운다.
//
// 만든 이유: KG에 테스트하며 쌓인 잡담(STT 오인식 등)이 대량으로 남아 검색을 오염시키는데,
// 노드를 지울 방법이 어디에도 없었다(프로젝트만 삭제 가능했음).
//
// 삭제는 되돌리기 어려우니 두 겹으로 막는다:
//   1) 지우기 전 dry-run으로 "무엇이 함께 사라지는지"를 먼저 보여준다(서버가 실제로 지웠다
//      롤백해서 세므로 미리보기 수치가 실제와 어긋나지 않는다).
//   2) 서버가 삭제 직전 knowledge.db를 backups/ 에 복사한다.
import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '@/config'

interface NodeRow {
  id: string
  type: string
  title: string | null
  preview: string | null
  source_type: string | null
  file_path: string | null
  created_at: string
}

interface Facets { types: string[]; source_types: string[]; views: string[] }

interface DeletePreview {
  nodes: number
  edges: number
  conversations: number
  orphan_entities: number
}

const PAGE_SIZE = 50

export default function KgDataManager() {
  const [rows, setRows] = useState<NodeRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [facets, setFacets] = useState<Facets>({ types: [], source_types: [], views: [] })
  const [type, setType] = useState('')
  const [sourceType, setSourceType] = useState('')
  const [view, setView] = useState('')
  const [q, setQ] = useState('')

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [preview, setPreview] = useState<DeletePreview | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async (opts?: { page?: number }) => {
    const p = opts?.page ?? page
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(p * PAGE_SIZE) })
      if (type) params.set('type', type)
      if (sourceType) params.set('source_type', sourceType)
      if (view) params.set('view', view)
      if (q) params.set('q', q)
      const r = await fetch(`${API_BASE}/nodes?${params}`)
      if (!r.ok) throw new Error(`서버 응답 ${r.status}`)
      const d = await r.json()
      setRows(d.nodes ?? [])
      setTotal(d.total ?? 0)
    } catch (e) {
      setError(`목록을 불러오지 못했습니다: ${e instanceof Error ? e.message : e}`)
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [page, type, sourceType, view, q])

  useEffect(() => {
    fetch(`${API_BASE}/nodes/facets`)
      .then(r => r.json()).then(setFacets)
      .catch(() => { /* 필터 목록은 없어도 화면은 동작 */ })
  }, [])

  // 필터가 바뀌면 1페이지로 돌아가고 선택도 비운다(안 보이는 걸 지우는 사고 방지)
  useEffect(() => {
    setPage(0); setSelected(new Set())
  }, [type, sourceType, view, q])

  useEffect(() => { load() }, [load])

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev)
    next.has(id) ? next.delete(id) : next.add(id)
    return next
  })

  const pageIds = rows.map(r => r.id)
  const allOnPage = pageIds.length > 0 && pageIds.every(id => selected.has(id))
  const togglePage = () => setSelected(prev => {
    const next = new Set(prev)
    if (allOnPage) pageIds.forEach(id => next.delete(id))
    else pageIds.forEach(id => next.add(id))
    return next
  })

  const askDelete = async () => {
    if (!selected.size) return
    setError(''); setNotice('')
    try {
      const r = await fetch(`${API_BASE}/nodes/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], dry_run: true }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? `서버 응답 ${r.status}`)
      setPreview(await r.json())
    } catch (e) {
      setError(`미리보기 실패: ${e instanceof Error ? e.message : e}`)
    }
  }

  const confirmDelete = async () => {
    setDeleting(true); setError('')
    try {
      const r = await fetch(`${API_BASE}/nodes/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected], dry_run: false }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error ?? `서버 응답 ${r.status}`)
      setNotice(
        `삭제 완료 — 노드 ${d.nodes}개, 엣지 ${d.edges}개, 대화기록 ${d.conversations}건` +
        `${d.orphan_entities ? `, 고아 엔티티 ${d.orphan_entities}개` : ''} 정리됨. 백업: ${d.backup_dir ?? '-'}`
      )
      setSelected(new Set()); setPreview(null)
      await load()
    } catch (e) {
      setError(`삭제 실패: ${e instanceof Error ? e.message : e}`)
    } finally {
      setDeleting(false)
    }
  }

  const maxPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onChange={setType} label="종류" options={facets.types} />
        <Select value={sourceType} onChange={setSourceType} label="출처" options={facets.source_types} />
        <Select value={view} onChange={setView} label="화면" options={facets.views} />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="제목·내용 검색"
          className="h-8 min-w-[180px] flex-1 rounded-lg border border-surface-border px-2 text-xs"
        />
        <button onClick={() => load()} disabled={loading}
          className="h-8 rounded-lg border border-surface-border px-3 text-xs hover:bg-gray-50">
          {loading ? '로딩…' : '새로고침'}
        </button>
      </div>

      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span>전체 <b className="text-gray-800">{total.toLocaleString()}</b>건</span>
        <span>선택 <b className="text-gray-800">{selected.size}</b>건</span>
        <button
          onClick={askDelete}
          disabled={!selected.size}
          className="ml-auto rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-40"
        >
          선택 삭제
        </button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
      {notice && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-surface-border">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-gray-50 text-gray-500">
            <tr>
              <th className="w-8 p-2">
                <input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="이 페이지 전체 선택" />
              </th>
              <th className="w-24 p-2">종류</th>
              <th className="p-2">제목 / 내용</th>
              <th className="w-28 p-2">출처</th>
              <th className="w-36 p-2">날짜</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className={`border-t border-surface-border ${selected.has(r.id) ? 'bg-red-50/60' : ''}`}>
                <td className="p-2 align-top">
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                </td>
                <td className="p-2 align-top text-gray-500">{r.type}</td>
                <td className="p-2 align-top">
                  <div className="font-medium text-gray-800">{r.title || '(제목 없음)'}</div>
                  {r.preview && <div className="mt-0.5 line-clamp-1 text-gray-400">{r.preview}</div>}
                </td>
                <td className="p-2 align-top text-gray-500">{r.source_type || '-'}</td>
                <td className="p-2 align-top text-gray-400">{r.created_at}</td>
              </tr>
            ))}
            {!rows.length && !loading && (
              <tr><td colSpan={5} className="p-6 text-center text-gray-400">조건에 맞는 항목이 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-center gap-2 text-xs">
        <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page <= 0 || loading}
          className="rounded-lg border border-surface-border px-2 py-1 disabled:opacity-40">이전</button>
        <span className="text-gray-500">{page + 1} / {maxPage + 1}</span>
        <button onClick={() => setPage(p => Math.min(maxPage, p + 1))} disabled={page >= maxPage || loading}
          className="rounded-lg border border-surface-border px-2 py-1 disabled:opacity-40">다음</button>
      </div>

      {preview && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white p-4 shadow-xl">
            <h3 className="text-sm font-semibold text-gray-900">정말 삭제할까요?</h3>
            <p className="mt-1 text-xs text-gray-500">되돌릴 수 없습니다. 삭제 직전 DB가 backups/ 에 백업됩니다.</p>
            <ul className="mt-3 space-y-1 text-xs text-gray-700">
              <li>• 노드 <b>{preview.nodes}</b>개</li>
              <li>• 연결(엣지) <b>{preview.edges}</b>개</li>
              {preview.conversations > 0 && (
                <li>• 대화기록 <b>{preview.conversations}</b>건 <span className="text-gray-400">(말투학습 원본에서도 제거)</span></li>
              )}
              {preview.orphan_entities > 0 && (
                <li>• 고아 엔티티 <b>{preview.orphan_entities}</b>개 <span className="text-gray-400">(아무 문서도 참조 안 함)</span></li>
              )}
            </ul>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setPreview(null)} disabled={deleting}
                className="rounded-lg border border-surface-border px-3 py-1.5 text-xs hover:bg-gray-50">취소</button>
              <button onClick={confirmDelete} disabled={deleting}
                className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-60">
                {deleting ? '삭제 중…' : '삭제'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Select({ value, onChange, label, options }: {
  value: string; onChange: (v: string) => void; label: string; options: string[]
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="h-8 rounded-lg border border-surface-border bg-white px-2 text-xs text-gray-700"
    >
      <option value="">{label} 전체</option>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}
