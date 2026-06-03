import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { streamClaudeWeb } from '@/services/claudeWeb'
import type { Settings } from '@/types'

const API = 'http://127.0.0.1:8766'

// ── 타입 ──────────────────────────────────────────────
interface SearchResult {
  id: string; title: string; document: string
  source_type: string; distance: number
}
interface AvatarSummary {
  summary: string
  core_interests: { topic: string; doc_count: number; importance: number }[]
  trends: { topic: string; recent: number; total: number; growth: string }[]
  gaps: { topic: string; doc_count: number }[]
}
interface GraphNode {
  id: string; title: string; type: string; source_type: string; importance: number
  x: number; y: number; vx: number; vy: number
}
interface GraphEdge { from_id: string; to_id: string; relation: string; weight: number }
interface GraphData { nodes: GraphNode[]; edges: GraphEdge[] }
interface Stats { nodes: number; edges: number; topics: number; vector_count: number; by_source: Record<string, number> }

// ── 헬퍼 ──────────────────────────────────────────────
async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(`${API}${path}`, opts)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

const GROWTH_COLOR: Record<string, string> = {
  '상승': 'text-green-600 bg-green-50',
  '신규': 'text-blue-600 bg-blue-50',
  '유지': 'text-gray-600 bg-gray-50',
  '하락': 'text-red-500 bg-red-50',
  '휴면': 'text-gray-400 bg-gray-50',
}

const SOURCE_COLOR: Record<string, string> = {
  pdf: '#ef4444', note: '#3b82f6', docx: '#8b5cf6',
  excel: '#10b981', pptx: '#f59e0b', text: '#6b7280', unknown: '#9ca3af',
  // entity 노드 (개념 연결)
  concept: '#a855f7', technology: '#06b6d4', organization: '#f97316',
  tool: '#84cc16', entity: '#a855f7',
}

const AVATAR_PROMPT = (interests: string, trends: string, gaps: string) =>
  `당신은 한 사람의 '정신적 아바타'입니다. 아래는 그 사람이 최근 모아온 지식의 패턴입니다.

핵심 관심사 (중요도순):
${interests}

토픽 트렌드 (최근 30일):
${trends}

보강이 필요한 영역:
${gaps}

이 데이터를 바탕으로, 그 사람의 1인칭 시점에서 자기 자신을 요약하세요.
"나는 요즘 ~를 깊이 파고들고 있고, ~쪽으로 관심이 옮겨가고 있다. ~는 아직 부족하다" 같은 식으로.
3~5문장. 한국어. 통찰력 있게.`

// ── 탭 1: 검색 + 아바타 요약 ──────────────────────────
function SearchTab({ settings }: { settings: Settings }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<AvatarSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [stats, setStats] = useState<Stats | null>(null)

  useEffect(() => {
    apiFetch('/stats').then(setStats).catch(() => {})
  }, [])

  const search = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    try {
      const data = await apiFetch(`/search?q=${encodeURIComponent(query)}&limit=10`)
      setResults(data.results ?? [])
    } catch {
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [query])

  const loadSummary = useCallback(async () => {
    const mcpEndpoint = settings.mcpEndpoint || 'http://127.0.0.1:8765/mcp'
    const sessionKey = settings.claudeSessionKey || ''
    setSummaryLoading(true)
    setSummary(null)
    try {
      // 1. 8766에서 구조 데이터(관심사·트렌드·갭) 가져오기
      const data = await apiFetch('/avatar/summary')

      // 2. Claude.ai 세션으로 요약 텍스트 직접 생성
      if (sessionKey && mcpEndpoint) {
        const prompt = AVATAR_PROMPT(
          JSON.stringify(data.core_interests, null, 2),
          JSON.stringify(data.trends?.slice(0, 8), null, 2),
          JSON.stringify(data.gaps?.slice(0, 5), null, 2),
        )
        let summaryText = ''
        setSummary({ ...data, summary: '' })
        await streamClaudeWeb(sessionKey, mcpEndpoint,
          [{ role: 'user', content: prompt }], '', (delta) => {
            summaryText += delta
            setSummary(prev => prev ? { ...prev, summary: summaryText } : null)
          })
      } else {
        setSummary(data)
      }
    } catch {
      setSummary(null)
    } finally {
      setSummaryLoading(false)
    }
  }, [settings])

  return (
    <div className="flex gap-5 h-full min-h-0">
      {/* 왼쪽: 검색 */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* 통계 바 */}
        {stats && (
          <div className="flex gap-3 mb-4 flex-wrap">
            {[
              { label: '노드', value: stats.nodes },
              { label: '엣지', value: stats.edges },
              { label: '토픽', value: stats.topics },
              { label: '벡터', value: stats.vector_count },
            ].map(s => (
              <div key={s.label} className="bg-gray-50 border border-surface-border rounded-xl px-3 py-1.5 text-center">
                <div className="text-lg font-bold text-gray-900">{s.value}</div>
                <div className="text-[10px] text-gray-500">{s.label}</div>
              </div>
            ))}
            {Object.entries(stats.by_source).map(([src, cnt]) => (
              <div key={src} className="border border-surface-border rounded-xl px-3 py-1.5 text-center" style={{ borderColor: SOURCE_COLOR[src] + '60' }}>
                <div className="text-lg font-bold" style={{ color: SOURCE_COLOR[src] }}>{cnt}</div>
                <div className="text-[10px] text-gray-500">{src}</div>
              </div>
            ))}
          </div>
        )}

        {/* 검색 입력 */}
        <div className="flex gap-2 mb-3">
          <input
            className="flex-1 border border-surface-border rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-gray-400 bg-white"
            placeholder="지식 그래프 시맨틱 검색..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
          />
          <button
            onClick={search}
            disabled={loading}
            className="px-4 py-2 bg-gray-900 text-white text-sm rounded-xl hover:bg-gray-700 disabled:opacity-50 transition-colors"
          >
            {loading ? '...' : '검색'}
          </button>
        </div>

        {/* 검색 결과 */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {results.length === 0 && !loading && (
            <div className="text-center text-gray-400 text-sm mt-10">검색어를 입력하고 Enter를 누르세요</div>
          )}
          {results.map(r => (
            <div key={r.id} className="border border-surface-border rounded-xl p-3 hover:bg-gray-50 transition-colors">
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="font-medium text-sm text-gray-900 truncate">{r.title || '(제목 없음)'}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                    style={{ background: SOURCE_COLOR[r.source_type] + '20', color: SOURCE_COLOR[r.source_type] }}>
                    {r.source_type}
                  </span>
                  <span className="text-[10px] text-gray-400">{(1 - r.distance).toFixed(2)}</span>
                </div>
              </div>
              <p className="text-xs text-gray-500 line-clamp-2">{r.document}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 오른쪽: 아바타 요약 */}
      <div className="w-72 shrink-0 flex flex-col gap-3 overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700">아바타 요약</h3>
          <button
            onClick={loadSummary}
            disabled={summaryLoading}
            className="text-xs px-3 py-1 border border-surface-border rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {summaryLoading ? '생성 중...' : '생성'}
          </button>
        </div>

        {summary ? (
          <>
            <div className="bg-gray-50 border border-surface-border rounded-xl p-3 text-xs text-gray-700 leading-relaxed">
              {summary.summary}
            </div>

            {summary.core_interests.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1.5">핵심 관심사</div>
                <div className="space-y-1">
                  {summary.core_interests.slice(0, 6).map(i => (
                    <div key={i.topic} className="flex items-center justify-between text-xs">
                      <span className="text-gray-700 truncate">{i.topic}</span>
                      <span className="text-gray-400 shrink-0 ml-2">{i.doc_count}개</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {summary.trends.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1.5">토픽 트렌드</div>
                <div className="flex flex-wrap gap-1">
                  {summary.trends.slice(0, 8).map(t => (
                    <span key={t.topic} className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${GROWTH_COLOR[t.growth] ?? 'text-gray-500 bg-gray-50'}`}>
                      {t.topic} {t.growth}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {summary.gaps.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1.5">지식 갭</div>
                <div className="space-y-1">
                  {summary.gaps.map(g => (
                    <div key={g.topic} className="text-xs text-orange-600 bg-orange-50 rounded-lg px-2 py-1">
                      {g.topic} <span className="text-orange-400">({g.doc_count}개)</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-gray-400 text-center mt-4">
            "생성" 버튼을 눌러<br />아바타 요약을 만드세요
          </div>
        )}
      </div>
    </div>
  )
}

// ── 탭 2: 그래프 시각화 ───────────────────────────────
const NODE_RADIUS = 18
const W = 900
const H = 600

function useForceLayout(nodes: GraphNode[], edges: GraphEdge[]) {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({})
  const frameRef = useRef<number>(0)
  const nodesRef = useRef<GraphNode[]>([])

  useEffect(() => {
    if (!nodes.length) return
    cancelAnimationFrame(frameRef.current)

    const ns = nodes.map((n, i) => ({
      ...n,
      x: W / 2 + Math.cos((i / nodes.length) * Math.PI * 2) * 200,
      y: H / 2 + Math.sin((i / nodes.length) * Math.PI * 2) * 180,
      vx: 0, vy: 0,
    }))
    nodesRef.current = ns

    const edgeMap: Record<string, string[]> = {}
    edges.forEach(e => {
      ;(edgeMap[e.from_id] = edgeMap[e.from_id] || []).push(e.to_id)
      ;(edgeMap[e.to_id]   = edgeMap[e.to_id]   || []).push(e.from_id)
    })

    let tick = 0
    const step = () => {
      const cur = nodesRef.current
      for (let i = 0; i < cur.length; i++) {
        let fx = 0, fy = 0
        // 반발력
        for (let j = 0; j < cur.length; j++) {
          if (i === j) continue
          const dx = cur[i].x - cur[j].x, dy = cur[i].y - cur[j].y
          const d2 = dx * dx + dy * dy + 1
          const f = 8000 / d2
          fx += (dx / Math.sqrt(d2)) * f
          fy += (dy / Math.sqrt(d2)) * f
        }
        // 인력 (엣지)
        ;(edgeMap[cur[i].id] || []).forEach(nid => {
          const nb = cur.find(n => n.id === nid)
          if (!nb) return
          const dx = nb.x - cur[i].x, dy = nb.y - cur[i].y
          const d = Math.sqrt(dx * dx + dy * dy) + 1
          fx += (dx / d) * (d - 120) * 0.05
          fy += (dy / d) * (d - 120) * 0.05
        })
        // 중심 인력
        fx += (W / 2 - cur[i].x) * 0.01
        fy += (H / 2 - cur[i].y) * 0.01
        cur[i].vx = (cur[i].vx + fx) * 0.7
        cur[i].vy = (cur[i].vy + fy) * 0.7
        cur[i].x = Math.max(NODE_RADIUS, Math.min(W - NODE_RADIUS, cur[i].x + cur[i].vx))
        cur[i].y = Math.max(NODE_RADIUS, Math.min(H - NODE_RADIUS, cur[i].y + cur[i].vy))
      }
      nodesRef.current = [...cur]
      if (tick % 3 === 0) {
        setPositions(Object.fromEntries(cur.map(n => [n.id, { x: n.x, y: n.y }])))
      }
      tick++
      if (tick < 200) frameRef.current = requestAnimationFrame(step)
    }
    frameRef.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frameRef.current)
  }, [nodes.length, edges.length]) // eslint-disable-line

  return positions
}

type GraphFilter = 'docs' | 'concepts' | 'all'

function GraphTab() {
  const [rawGraph, setRawGraph] = useState<GraphData>({ nodes: [], edges: [] })
  const [filter, setFilter] = useState<GraphFilter>('docs')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)

  // 필터 적용
  const graph = useMemo(() => {
    if (filter === 'all') return rawGraph
    const isDoc = (n: GraphNode) => n.type !== 'entity'
    const isConcept = (n: GraphNode) => n.type === 'entity'
    const keep = filter === 'docs'
      ? rawGraph.nodes.filter(n => isDoc(n) || (selected && rawGraph.edges.some(
          e => (e.from_id === selected.id && e.to_id === n.id) || (e.to_id === selected.id && e.from_id === n.id)
        )))
      : rawGraph.nodes.filter(isConcept)
    const keepIds = new Set(keep.map(n => n.id))
    return {
      nodes: keep,
      edges: rawGraph.edges.filter(e => keepIds.has(e.from_id) && keepIds.has(e.to_id))
    }
  }, [rawGraph, filter, selected])

  const positions = useForceLayout(graph.nodes, graph.edges)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/graph/all?limit=200')
      setRawGraph(data)
      setSelected(null)
    } catch {
      setRawGraph({ nodes: [], edges: [] })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const selectedNeighbors = new Set(
    selected
      ? rawGraph.edges
          .filter(e => e.from_id === selected.id || e.to_id === selected.id)
          .flatMap(e => [e.from_id, e.to_id])
      : []
  )

  return (
    <div className="flex gap-4 h-full min-h-0">
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            {/* 필터 */}
            <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
              {([['docs','문서'], ['concepts','개념'], ['all','전체']] as [GraphFilter, string][]).map(([id, label]) => (
                <button key={id} onClick={() => { setFilter(id); setSelected(null) }}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all ${
                    filter === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                  }`}>
                  {label}
                </button>
              ))}
            </div>
            {/* 범례 */}
            <div className="flex gap-2 text-[10px] text-gray-400">
              {(['pdf','note','pptx'] as const).map(src => (
                <span key={src} className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: SOURCE_COLOR[src] }} />
                  {src}
                </span>
              ))}
              <span className="flex items-center gap-1 pl-2 border-l border-gray-200">
                <span className="w-2 h-2 inline-block rotate-45 bg-purple-400" />
                개념
              </span>
            </div>
          </div>
          <button onClick={load} disabled={loading}
            className="text-xs px-3 py-1 border border-surface-border rounded-lg hover:bg-gray-50 disabled:opacity-50">
            {loading ? '로딩...' : '새로고침'}
          </button>
        </div>

        {graph.nodes.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm border border-surface-border rounded-2xl">
            {loading ? '그래프 로딩 중...' : '노드가 없습니다. 문서를 추가해주세요.'}
          </div>
        ) : (
          <div className="flex-1 border border-surface-border rounded-2xl overflow-hidden bg-gray-50">
            <svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
              {/* 엣지 */}
              {graph.edges.map((e, i) => {
                const a = positions[e.from_id], b = positions[e.to_id]
                if (!a || !b) return null
                const active = selected && (e.from_id === selected.id || e.to_id === selected.id)
                return (
                  <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={active ? '#6b7280' : '#d1d5db'}
                    strokeWidth={active ? 1.5 : 1}
                    strokeOpacity={active ? 0.8 : 0.4}
                  />
                )
              })}

              {/* 노드 */}
              {graph.nodes.map(n => {
                const pos = positions[n.id]
                if (!pos) return null
                const isEntity = n.type === 'entity'
                const color = isEntity
                  ? (SOURCE_COLOR[n.source_type] ?? '#a855f7')
                  : (SOURCE_COLOR[n.source_type] ?? '#9ca3af')
                const isSelected = selected?.id === n.id
                const isNeighbor = selectedNeighbors.has(n.id)
                const isHover = hoverId === n.id
                const dimmed = selected && !isSelected && !isNeighbor
                const r = isEntity
                  ? 10  // 개념 노드는 작고 일정
                  : NODE_RADIUS * (0.7 + (n.importance ?? 0.5) * 0.6)
                const boost = isSelected || isHover ? 3 : 0
                // 다이아몬드 path (entity) vs 원 (document)
                const diamond = `M 0 ${-(r+boost)} L ${r+boost} 0 L 0 ${r+boost} L ${-(r+boost)} 0 Z`
                return (
                  <g key={n.id} transform={`translate(${pos.x},${pos.y})`}
                    style={{ cursor: 'pointer', opacity: dimmed ? 0.15 : 1 }}
                    onClick={() => setSelected(isSelected ? null : n)}
                    onMouseEnter={() => setHoverId(n.id)}
                    onMouseLeave={() => setHoverId(null)}
                  >
                    {isEntity ? (
                      <path d={diamond}
                        fill={isSelected ? color : isHover ? color + 'dd' : color + '55'}
                        stroke={color}
                        strokeWidth={isSelected ? 2 : 1.5}
                      />
                    ) : (
                      <circle r={r + boost}
                        fill={isSelected ? color : isHover ? color + 'dd' : color + '99'}
                        stroke={isSelected ? color : '#fff'}
                        strokeWidth={isSelected ? 2.5 : 1.5}
                      />
                    )}
                    <text textAnchor="middle" dy="0.35em"
                      fontSize={isEntity ? 8 : 9}
                      fill={isSelected ? (isEntity ? color : '#fff') : '#374151'}
                      style={{ pointerEvents: 'none', userSelect: 'none' }}>
                      {isEntity ? '◆' : n.source_type === 'pdf' ? '📄' : n.source_type === 'note' ? '✎' : '◈'}
                    </text>
                    {(isSelected || isHover) && (
                      <text textAnchor="middle" y={r + boost + 12}
                        fontSize={9} fill={isEntity ? color : '#374151'}
                        fontWeight={isEntity ? 'bold' : 'normal'}
                        style={{ pointerEvents: 'none', userSelect: 'none' }}>
                        {n.title.length > 16 ? n.title.slice(0, 16) + '…' : n.title}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>
          </div>
        )}
      </div>

      {/* 선택 노드 상세 */}
      <div className="w-56 shrink-0 flex flex-col gap-3">
        <div className="text-xs font-medium text-gray-500">
          {selected ? '선택된 노드' : '노드를 클릭하세요'}
        </div>
        {selected ? (
          <div className="border border-surface-border rounded-xl p-3 space-y-2">
            <div className="font-medium text-sm text-gray-900">{selected.title}</div>
            <div className="flex flex-wrap gap-1">
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                style={{ background: SOURCE_COLOR[selected.source_type] + '20', color: SOURCE_COLOR[selected.source_type] }}>
                {selected.source_type}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">
                중요도 {((selected.importance ?? 0.5) * 100).toFixed(0)}%
              </span>
            </div>
            <div className="text-xs text-gray-500">
              연결: {selectedNeighbors.size - 1}개 노드
            </div>
          </div>
        ) : (
          <div className="text-xs text-gray-400 border border-dashed border-gray-200 rounded-xl p-4 text-center">
            노드 클릭 시<br />상세 정보 표시
          </div>
        )}

        {/* 노드 수 요약 */}
        <div className="mt-auto text-xs text-gray-400 space-y-1">
          <div>표시 {graph.nodes.length} / 전체 {rawGraph.nodes.length}개 노드</div>
          <div>엣지 {graph.edges.length}개</div>
        </div>
      </div>
    </div>
  )
}

// ── 탭 3: 파일 + 주체별 처리 큐 ──────────────────────
interface RawFile { name: string; path: string; rel: string; ext: string; size: number; modified: number }
interface Subject { id: string; name: string; folder_path: string; description: string; priority: number; total: number; pending: number; done: number; processing: number; error: number }
interface QueueItem { id: string; subject_id: string; subject_name: string; file_name: string; file_path: string; status: string; stage: string; error: string; queued_at: string }

const EXT_COLOR: Record<string, string> = {
  pdf: '#ef4444', md: '#3b82f6', txt: '#3b82f6',
  docx: '#8b5cf6', doc: '#8b5cf6',
  xlsx: '#10b981', xls: '#10b981',
  pptx: '#f59e0b', ppt: '#f59e0b',
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function fmtDate(ts: number) {
  return new Date(ts * 1000).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
}

const STATUS_BADGE: Record<string, string> = {
  pending:    'bg-gray-100 text-gray-500',
  processing: 'bg-blue-50 text-blue-600',
  done:       'bg-green-50 text-green-600',
  error:      'bg-red-50 text-red-500',
}

function FilesTab() {
  const [subjects, setSubjects]     = useState<Subject[]>([])
  const [selected, setSelected]     = useState<Subject | null>(null)
  const [queue, setQueue]           = useState<QueueItem[]>([])
  const [files, setFiles]           = useState<RawFile[]>([])
  const [view, setView]             = useState<'subjects' | 'queue' | 'files'>('subjects')
  const [newName, setNewName]       = useState('')
  const [processing, setProcessing] = useState(false)
  const [opening, setOpening]       = useState<string | null>(null)

  const loadSubjects = useCallback(async () => {
    const d = await apiFetch('/subjects').catch(() => ({ subjects: [] }))
    setSubjects(d.subjects ?? [])
  }, [])

  const loadQueue = useCallback(async (sid: string) => {
    const d = await apiFetch(`/queue?subject_id=${sid}`).catch(() => ({ items: [] }))
    setQueue(d.items ?? [])
  }, [])

  const loadFiles = useCallback(async () => {
    const d = await apiFetch('/files/list').catch(() => ({ files: [] }))
    setFiles(d.files ?? [])
  }, [])

  useEffect(() => { loadSubjects() }, [loadSubjects])

  const discover = async () => {
    await fetch(`${API}/subjects/discover`, { method: 'POST' })
    await loadSubjects()
  }

  const createSubject = async () => {
    if (!newName.trim()) return
    await fetch(`${API}/subjects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() })
    })
    setNewName('')
    await loadSubjects()
  }

  const selectSubject = async (s: Subject) => {
    setSelected(s); setView('queue')
    await loadQueue(s.id)
  }

  const scan = async (sid: string) => {
    await fetch(`${API}/subjects/${sid}/scan`, { method: 'POST' })
    await loadQueue(sid); await loadSubjects()
  }

  const processNext = async (sid: string, limit = 3) => {
    setProcessing(true)
    try {
      await fetch(`${API}/queue/process`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject_id: sid, limit })
      })
      await loadQueue(sid); await loadSubjects()
    } finally { setProcessing(false) }
  }

  const resetErrors = async (sid: string) => {
    await fetch(`${API}/queue/reset_errors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: sid })
    })
    await loadQueue(sid); await loadSubjects()
  }

  const openFile = async (path: string) => {
    setOpening(path)
    await fetch(`${API}/files/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }).finally(() => setTimeout(() => setOpening(null), 800))
  }

  // ── 주체 목록 뷰 ──
  if (view === 'subjects') return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <input value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createSubject()}
          placeholder="새 주체 이름..."
          className="flex-1 border border-surface-border rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:border-gray-400 bg-white" />
        <button onClick={createSubject} className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded-xl hover:bg-gray-700">추가</button>
        <button onClick={discover} className="text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50">폴더 자동감지</button>
        <button onClick={() => { setView('files'); loadFiles() }} className="text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50">파일 목록</button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {subjects.length === 0 && (
          <div className="text-center text-gray-400 text-sm mt-10">
            "폴더 자동감지"로 docs/ 하위 폴더를 주체로 등록하세요
          </div>
        )}
        {subjects.map(s => (
          <div key={s.id} onClick={() => selectSubject(s)}
            className="border border-surface-border rounded-xl p-3 hover:bg-gray-50 cursor-pointer transition-colors">
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-medium text-sm text-gray-900">{s.name}</span>
              <span className="text-[10px] text-gray-400">우선순위 {s.priority}</span>
            </div>
            <div className="flex gap-2 text-[10px]">
              <span className="text-gray-400">전체 {s.total ?? 0}</span>
              <span className="text-gray-500">대기 {s.pending ?? 0}</span>
              <span className="text-green-600">완료 {s.done ?? 0}</span>
              {(s.error ?? 0) > 0 && <span className="text-red-500">오류 {s.error}</span>}
            </div>
            {s.total > 0 && (
              <div className="mt-2 h-1 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-green-400 rounded-full transition-all"
                  style={{ width: `${Math.round(((s.done ?? 0) / s.total) * 100)}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )

  // ── 파일 목록 뷰 ──
  if (view === 'files') return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={() => setView('subjects')} className="text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50">← 주체</button>
        <span className="text-xs text-gray-500 flex-1">docs/ 전체 파일</span>
        <button onClick={loadFiles} className="text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50">새로고침</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white border-b border-surface-border">
            <tr className="text-gray-400 text-left">
              <th className="py-2 pr-3 font-medium">파일명</th>
              <th className="py-2 pr-3 font-medium">형식</th>
              <th className="py-2 pr-3 font-medium text-right">크기</th>
              <th className="py-2 w-12" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {files.map(f => (
              <tr key={f.path} className="hover:bg-gray-50 group transition-colors">
                <td className="py-2 pr-3">
                  <div className="font-medium text-gray-900 truncate max-w-xs">{f.name}</div>
                  <div className="text-gray-400 text-[10px]">{f.rel.split('/').slice(0,-1).join('/')}</div>
                </td>
                <td className="py-2 pr-3">
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium text-white"
                    style={{ background: EXT_COLOR[f.ext] ?? '#9ca3af' }}>{f.ext}</span>
                </td>
                <td className="py-2 pr-3 text-right text-gray-500">
                  {f.size < 1024*1024 ? `${(f.size/1024).toFixed(0)}KB` : `${(f.size/1024/1024).toFixed(1)}MB`}
                </td>
                <td className="py-2">
                  <button onClick={() => openFile(f.path)} disabled={opening === f.path}
                    className="opacity-0 group-hover:opacity-100 text-[10px] px-2 py-1 bg-gray-900 text-white rounded-lg disabled:opacity-50 transition-all">
                    {opening === f.path ? '여는 중' : '열기'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )

  // ── 큐 뷰 ──
  const pending = queue.filter(q => q.status === 'pending').length
  const errors  = queue.filter(q => q.status === 'error').length
  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <button onClick={() => setView('subjects')} className="text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50">← 주체</button>
        <span className="font-medium text-sm text-gray-900 flex-1">{selected?.name}</span>
        <button onClick={() => selected && scan(selected.id)} className="text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50">스캔</button>
        {errors > 0 && (
          <button onClick={() => selected && resetErrors(selected.id)} className="text-xs px-3 py-1.5 border border-red-200 text-red-500 rounded-xl hover:bg-red-50">오류 재시도</button>
        )}
        {pending > 0 && (
          <button onClick={() => selected && processNext(selected.id, 5)} disabled={processing}
            className="text-xs px-3 py-1.5 bg-gray-900 text-white rounded-xl hover:bg-gray-700 disabled:opacity-50">
            {processing ? '처리 중...' : `처리 (${pending}개 대기)`}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-white border-b border-surface-border">
            <tr className="text-gray-400 text-left">
              <th className="py-2 pr-3 font-medium">파일명</th>
              <th className="py-2 pr-3 font-medium w-20">상태</th>
              <th className="py-2 w-12" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {queue.length === 0 && (
              <tr><td colSpan={3} className="py-8 text-center text-gray-400">큐가 비어있습니다. "스캔"을 눌러 파일을 추가하세요.</td></tr>
            )}
            {queue.map(q => (
              <tr key={q.id} className="hover:bg-gray-50 group transition-colors">
                <td className="py-2 pr-3">
                  <div className="font-medium text-gray-900 truncate max-w-sm">{q.file_name}</div>
                  {q.error && <div className="text-[10px] text-red-400 truncate">{q.error}</div>}
                </td>
                <td className="py-2 pr-3">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_BADGE[q.status] ?? 'bg-gray-50 text-gray-400'}`}>
                    {q.status}
                  </span>
                </td>
                <td className="py-2">
                  <button onClick={() => openFile(q.file_path)} disabled={opening === q.file_path}
                    className="opacity-0 group-hover:opacity-100 text-[10px] px-2 py-1 bg-gray-900 text-white rounded-lg disabled:opacity-50 transition-all">
                    {opening === q.file_path ? '여는 중' : '열기'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[10px] text-gray-400 shrink-0">
        전체 {queue.length} · 대기 {pending} · 완료 {queue.filter(q=>q.status==='done').length} · 오류 {errors}
      </div>
    </div>
  )
}

// ── 탭 4: Preference ─────────────────────────────────
interface BehaviorData {
  days: number
  file_opens: { path: string; cnt: number; last_open: string }[]
  searches: { query: string; cnt: number }[]
  hourly_activity: { hour: string; cnt: number }[]
  topic_access: { name: string; access_cnt: number }[]
}

function PreferenceTab({ settings }: { settings: Settings }) {
  const [behavior, setBehavior] = useState<BehaviorData | null>(null)
  const [analysis, setAnalysis] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [days, setDays] = useState(30)
  const [loading, setLoading] = useState(false)

  const loadBehavior = useCallback(async (d: number) => {
    setLoading(true)
    try {
      const data = await apiFetch(`/profile/behavior?days=${d}`)
      setBehavior(data)
    } catch { setBehavior(null) }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadBehavior(days) }, [days, loadBehavior])

  const analyze = async () => {
    setAnalyzing(true)
    setAnalysis('')
    try {
      const mcpEndpoint = settings.mcpEndpoint || 'http://127.0.0.1:8765/mcp'
      const sessionKey  = settings.claudeSessionKey || ''

      if (sessionKey && mcpEndpoint) {
        // 행동 데이터를 직접 프롬프트에 담아 streamClaudeWeb 호출
        const b = behavior!
        const prompt = `당신은 한 사람의 행동 데이터를 분석하는 전문가입니다.
아래는 최근 ${days}일간의 행동 패턴입니다.

자주 열어본 파일:
${b.file_opens.slice(0,8).map(f => `- ${f.path.split(/[\\/]/).pop()} (${f.cnt}회)`).join('\n') || '(없음)'}

자주 검색한 키워드:
${b.searches.slice(0,8).map(s => `- ${s.query} (${s.cnt}회)`).join('\n') || '(없음)'}

시간대별 활동:
${b.hourly_activity.map(h => `${h.hour}시:${h.cnt}회`).join(', ') || '(없음)'}

자주 접근한 토픽:
${b.topic_access.slice(0,8).map(t => `- ${t.name} (${t.access_cnt}회)`).join('\n') || '(없음)'}

이 데이터를 바탕으로 이 사람의 성향을 한국어로 분석해주세요.

## 주요 관심 분야
## 업무 스타일
## 집중 시간대
## 현재 몰두하는 것
## 지식 갭 & 성장 방향

데이터에서 보이는 것만 기반으로, 구체적이고 통찰력 있게 작성하세요.`

        await streamClaudeWeb(sessionKey, mcpEndpoint,
          [{ role: 'user', content: prompt }], '', (delta) => {
            setAnalysis(prev => prev + delta)
          })
      } else {
        // MCP 없으면 서버 API 호출
        const data = await apiFetch(`/profile/analysis?days=${days}`)
        setAnalysis(data.analysis)
      }
    } catch (e) {
      setAnalysis('분석 실패: Claude 세션을 확인해주세요.')
    } finally { setAnalyzing(false) }
  }

  const maxOpen = Math.max(...(behavior?.file_opens.map(f => f.cnt) ?? [1]), 1)
  const maxSearch = Math.max(...(behavior?.searches.map(s => s.cnt) ?? [1]), 1)
  const maxHour = Math.max(...(behavior?.hourly_activity.map(h => h.cnt) ?? [1]), 1)

  return (
    <div className="flex gap-5 h-full min-h-0">
      {/* 왼쪽: 행동 데이터 */}
      <div className="flex-1 flex flex-col gap-4 min-h-0 overflow-y-auto pr-1">
        {/* 기간 선택 */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-gray-500">기간:</span>
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDays(d)}
              className={`text-xs px-3 py-1 rounded-lg border transition-colors ${days === d ? 'bg-gray-900 text-white border-gray-900' : 'border-surface-border hover:bg-gray-50'}`}>
              {d}일
            </button>
          ))}
          {loading && <span className="text-xs text-gray-400">로딩...</span>}
        </div>

        {behavior && (
          <>
            {/* 파일 열기 이력 */}
            {behavior.file_opens.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-2">자주 열어본 파일</div>
                <div className="space-y-1.5">
                  {behavior.file_opens.slice(0, 8).map((f, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="text-[10px] text-gray-600 w-36 truncate shrink-0">
                        {f.path.split(/[\\/]/).pop()}
                      </div>
                      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-400 rounded-full" style={{ width: `${(f.cnt / maxOpen) * 100}%` }} />
                      </div>
                      <span className="text-[10px] text-gray-400 w-6 text-right shrink-0">{f.cnt}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 검색 키워드 */}
            {behavior.searches.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-2">검색 키워드</div>
                <div className="flex flex-wrap gap-1.5">
                  {behavior.searches.slice(0, 12).map((s, i) => (
                    <span key={i} className="text-[10px] px-2 py-1 bg-gray-100 text-gray-700 rounded-full"
                      style={{ fontSize: `${10 + Math.round((s.cnt / maxSearch) * 4)}px` }}>
                      {s.query}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 시간대별 활동 */}
            {behavior.hourly_activity.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-2">시간대별 활동</div>
                <div className="flex items-end gap-0.5 h-12">
                  {Array.from({ length: 24 }, (_, h) => {
                    const item = behavior.hourly_activity.find(a => parseInt(a.hour) === h)
                    const cnt = item?.cnt ?? 0
                    return (
                      <div key={h} className="flex-1 flex flex-col items-center gap-0.5" title={`${h}시: ${cnt}회`}>
                        <div className="w-full bg-indigo-400 rounded-sm transition-all"
                          style={{ height: `${cnt ? (cnt / maxHour) * 40 + 2 : 0}px` }} />
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between text-[9px] text-gray-300 mt-0.5">
                  <span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>23시</span>
                </div>
              </div>
            )}

            {/* 토픽 접근 */}
            {behavior.topic_access.length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-2">관심 토픽</div>
                <div className="flex flex-wrap gap-1.5">
                  {behavior.topic_access.map((t, i) => (
                    <span key={i} className="text-[10px] px-2 py-1 rounded-full font-medium"
                      style={{ background: `hsl(${220 + i * 20},70%,${92 - i * 2}%)`, color: `hsl(${220 + i * 20},60%,35%)` }}>
                      {t.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {behavior.file_opens.length === 0 && behavior.searches.length === 0 && (
              <div className="text-sm text-gray-400 text-center mt-8">
                아직 행동 데이터가 없습니다.<br />
                <span className="text-xs">파일을 열거나 검색하면 자동으로 기록됩니다.</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* 오른쪽: 성향 분석 */}
      <div className="w-80 shrink-0 flex flex-col gap-3">
        <div className="flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-gray-700">성향 분석</h3>
          <button onClick={analyze} disabled={analyzing || !behavior}
            className="text-xs px-3 py-1 bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 transition-colors">
            {analyzing ? '분석 중...' : '분석 생성'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {analysis ? (
            <div className="prose prose-sm prose-gray max-w-none text-xs leading-relaxed">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{analysis}</ReactMarkdown>
            </div>
          ) : (
            <div className="text-xs text-gray-400 text-center mt-8 leading-relaxed">
              "분석 생성"을 눌러<br />
              행동 데이터 기반<br />
              성향 분석을 시작하세요
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 탭 5: Wiki ────────────────────────────────────────
interface WikiPage {
  id: string; title: string; file_path: string
  status: string; updated_at: string; wiki_content: string
}
interface AutoJob {
  running: boolean; total: number; done: number; failed: number
  current: string; missing: number; cancel?: boolean
  graphify?: GraphifyJob
}
interface GraphifyJob {
  running: boolean; stage: string; nodes: number; edges: number
  communities: number; exported: number; error: string; html_ready?: boolean
}

function WikiTab() {
  const [pages, setPages]       = useState<WikiPage[]>([])
  const [selected, setSelected] = useState<WikiPage | null>(null)
  const [generating, setGenerating] = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)
  const [job, setJob]           = useState<AutoJob | null>(null)
  const [gJob, setGJob]         = useState<GraphifyJob | null>(null)
  const pollRef                 = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadPages = useCallback(async () => {
    setLoading(true)
    try { const data = await apiFetch('/wiki/list'); setPages(data.pages ?? []) }
    catch { setPages([]) }
    finally { setLoading(false) }
  }, [])

  const loadStatus = useCallback(async () => {
    try {
      const data = await apiFetch('/wiki/auto_summarize/status')
      setJob(data)
      if (data.graphify) setGJob(data.graphify)
    }
    catch { /* ignore */ }
  }, [])

  useEffect(() => { loadPages(); loadStatus() }, [loadPages, loadStatus])

  // 요약 또는 graphify 실행 중일 때 3초마다 폴링
  useEffect(() => {
    const active = job?.running || gJob?.running
    if (active) {
      pollRef.current = setInterval(async () => {
        await loadStatus()
        await loadPages()
      }, 3000)
    } else {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [job?.running, gJob?.running, loadStatus, loadPages])

  const startAuto = async () => {
    if (job?.missing === 0) {
      await fetch(`${API}/wiki/generate_all`, { method: 'POST' })
      await loadPages()
    } else {
      await fetch(`${API}/wiki/auto_summarize/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 200 }) })
      await loadStatus()
    }
  }

  const runGraphify = async () => {
    await fetch(`${API}/graphify/run`, { method: 'POST' })
    await loadStatus()
  }

  const cancelAuto = async () => {
    await fetch(`${API}/wiki/auto_summarize/cancel`, { method: 'POST' })
    await loadStatus()
  }

  const generateOne = async (nodeId: string, title: string) => {
    setGenerating(nodeId)
    try {
      const r = await fetch(`${API}/wiki/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: nodeId }) })
      const data = await r.json()
      if (data.success) { await loadPages(); setSelected({ ...data, title } as WikiPage) }
    } finally { setGenerating(null) }
  }

  const STATUS_LABEL: Record<string, string> = { done: '완료', ollama_only: 'Ollama', pending: '대기', error: '오류' }
  const STATUS_COLOR: Record<string, string> = {
    done: 'bg-green-50 text-green-600', ollama_only: 'bg-yellow-50 text-yellow-600',
    pending: 'bg-gray-50 text-gray-400', error: 'bg-red-50 text-red-500'
  }

  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0

  return (
    <div className="flex gap-4 h-full min-h-0">
      {/* 왼쪽: 페이지 목록 */}
      <div className="w-64 shrink-0 flex flex-col gap-2">

        {/* 자동 요약 패널 */}
        <div className="border border-surface-border rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">자동 요약</span>
            {job && (
              <span className="text-[10px] text-gray-400">
                미요약 {job.missing ?? 0}개
              </span>
            )}
          </div>

          {job?.running ? (
            <>
              <div className="text-[10px] text-gray-500 truncate">
                처리 중: {job.current || '…'}
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-500">{job.done} / {job.total} ({pct}%)</span>
                <button onClick={cancelAuto} className="text-[10px] px-2 py-0.5 border border-red-200 text-red-500 rounded-lg hover:bg-red-50">중단</button>
              </div>
            </>
          ) : (
            <div className="flex gap-1">
              <button onClick={startAuto} disabled={!job}
                className="flex-1 text-[10px] py-1.5 bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40 transition">
                {job?.missing === 0 ? '전체 재요약' : `미요약 ${job?.missing ?? '…'}개 자동 요약`}
              </button>
              <button onClick={loadStatus} className="text-[10px] px-2 py-1.5 border border-surface-border rounded-lg hover:bg-gray-50">↺</button>
            </div>
          )}
          {job && !job.running && job.done > 0 && (
            <p className="text-[10px] text-green-600">완료 {job.done}개 {job.failed > 0 && <span className="text-red-400">· 실패 {job.failed}개</span>}</p>
          )}
        </div>

        {/* Graphify 패널 */}
        <div className="border border-surface-border rounded-xl p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-gray-700">🕸 지식 그래프</span>
            {gJob?.html_ready && (
              <span className="text-[10px] text-green-600">● 준비됨</span>
            )}
          </div>

          {gJob?.running ? (
            <div className="space-y-1">
              <div className="text-[10px] text-blue-600 truncate">{gJob.stage}…</div>
              <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-blue-400 rounded-full animate-pulse w-full" />
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              {gJob?.html_ready && (
                <div className="text-[10px] text-gray-500">
                  노드 {gJob.nodes} · 엣지 {gJob.edges} · 커뮤니티 {gJob.communities}
                </div>
              )}
              {gJob?.error && (
                <div className="text-[10px] text-red-500 truncate">{gJob.error}</div>
              )}
              <div className="flex gap-1">
                <button onClick={runGraphify} disabled={gJob?.running}
                  className="flex-1 text-[10px] py-1.5 border border-surface-border rounded-lg hover:bg-gray-50 disabled:opacity-40 transition">
                  {gJob?.html_ready ? '재빌드' : 'Graphify 실행'}
                </button>
                {gJob?.html_ready && (
                  <button
                    onClick={() => window.open('http://127.0.0.1:8766/graphify/graph.html')}
                    className="text-[10px] px-2 py-1.5 bg-gray-900 text-white rounded-lg hover:bg-gray-700 transition">
                    열기
                  </button>
                )}
              </div>
            </div>
          )}
          <p className="text-[10px] text-gray-400">요약 완료 후 자동 실행됨</p>
        </div>

        {/* 목록 헤더 */}
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-gray-500">Wiki {pages.length}페이지</span>
          <button onClick={loadPages} disabled={loading}
            className="text-[10px] px-2 py-1 border border-surface-border rounded-lg hover:bg-gray-50 disabled:opacity-50">
            {loading ? '...' : '새로고침'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
          {pages.length === 0 && !loading && (
            <div className="text-xs text-gray-400 text-center mt-6 leading-relaxed">
              위 "자동 요약"으로<br />Wiki를 만드세요
            </div>
          )}
          {pages.map(p => (
            <button key={p.id} onClick={() => setSelected(p)}
              className={`w-full text-left px-3 py-2 rounded-xl border transition-colors ${
                selected?.id === p.id ? 'border-gray-400 bg-gray-50' : 'border-surface-border hover:bg-gray-50'
              }`}>
              <div className="flex items-center justify-between gap-1 mb-0.5">
                <span className="text-xs font-medium text-gray-900 truncate">{p.title}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full shrink-0 ${STATUS_COLOR[p.status] ?? 'bg-gray-50 text-gray-400'}`}>
                  {STATUS_LABEL[p.status] ?? p.status}
                </span>
              </div>
              <div className="text-[10px] text-gray-400 truncate">{p.file_path.split(/[\\/]/).pop()}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 오른쪽: Wiki 내용 */}
      <div className="flex-1 flex flex-col min-h-0 border border-surface-border rounded-2xl overflow-hidden">
        {selected ? (
          <>
            <div className="flex items-center justify-between px-5 py-3 border-b border-surface-border bg-gray-50 shrink-0">
              <h2 className="text-sm font-semibold text-gray-900">{selected.title}</h2>
              <button onClick={() => generateOne(selected.id, selected.title)} disabled={!!generating}
                className="text-xs px-3 py-1 border border-surface-border rounded-lg hover:bg-white disabled:opacity-50">
                {generating === selected.id ? '재생성 중...' : '재생성'}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 prose prose-sm prose-gray max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.wiki_content || '(내용 없음)'}</ReactMarkdown>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
            왼쪽에서 Wiki 페이지를 선택하세요
          </div>
        )}
      </div>
    </div>
  )
}

// ── 탭 0: Ingest ─────────────────────────────────────
function IngestTab() {
  const [text, setText]         = useState('')
  const [title, setTitle]       = useState('')
  const [srcType, setSrcType]   = useState('note')
  const [loading, setLoading]   = useState(false)
  const [msg, setMsg]           = useState<{ ok: boolean; text: string } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [fileResults, setFileResults] = useState<{ name: string; ok: boolean; msg: string }[]>([])

  const ingestText = async () => {
    if (!text.trim()) return
    setLoading(true); setMsg(null)
    try {
      await apiFetch('/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title || '(제목 없음)', content: text, source_type: srcType }),
      })
      setMsg({ ok: true, text: '✓ KG에 추가됐습니다.' })
      setText(''); setTitle('')
    } catch (e) {
      setMsg({ ok: false, text: '오류: ' + String(e) })
    } finally { setLoading(false) }
  }

  const ingestTextFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const content = await file.text()
        await apiFetch('/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: file.name, content, source_type: file.name.split('.').pop() ?? 'text' }),
        })
        setFileResults(prev => [...prev, { name: file.name, ok: true, msg: 'KG에 추가 완료' }])
      } catch {
        setFileResults(prev => [...prev, { name: file.name, ok: false, msg: '추가 실패' }])
      }
    }
  }

  const uploadBinaryFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const form = new FormData()
        form.append('file', file)
        const res  = await fetch(`${API}/upload`, { method: 'POST', body: form })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        const queued = data.queued === false ? '이미 큐에 있음' : '큐에 등록됨 (파일 탭에서 처리)'
        setFileResults(prev => [...prev, { name: file.name, ok: true, msg: queued }])
      } catch (e) {
        setFileResults(prev => [...prev, { name: file.name, ok: false, msg: String(e) }])
      }
    }
  }

  const ingestFiles = async (files: File[]) => {
    setFileResults([])
    const textFiles = files.filter(f => /\.(txt|md|csv)$/i.test(f.name))
    const binFiles  = files.filter(f => /\.(pdf|docx?|xlsx?|pptx?)$/i.test(f.name))
    const unsupported = files.filter(f => !textFiles.includes(f) && !binFiles.includes(f))
    if (textFiles.length) await ingestTextFiles(textFiles)
    if (binFiles.length)  await uploadBinaryFiles(binFiles)
    for (const f of unsupported) {
      setFileResults(prev => [...prev, { name: f.name, ok: false, msg: '지원하지 않는 형식' }])
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null)

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    ingestFiles(Array.from(e.dataTransfer.files))
  }

  return (
    <div className="flex gap-5 h-full min-h-0">
      {/* 텍스트 입력 */}
      <div className="flex-1 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-gray-700">텍스트 직접 추가</h3>
          <span className="text-[10px] text-gray-400">노트, 아이디어, 회의록 등 바로 KG에 추가</span>
        </div>

        <div className="flex gap-2">
          <input value={title} onChange={e => setTitle(e.target.value)}
            placeholder="제목 (선택)"
            className="flex-1 border border-surface-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-gray-400 bg-white" />
          <select value={srcType} onChange={e => setSrcType(e.target.value)}
            className="border border-surface-border rounded-xl px-3 py-2 text-sm focus:outline-none bg-white text-gray-700">
            <option value="note">노트</option>
            <option value="text">텍스트</option>
            <option value="memo">메모</option>
            <option value="meeting">회의록</option>
            <option value="idea">아이디어</option>
          </select>
        </div>

        <textarea value={text} onChange={e => setText(e.target.value)}
          rows={12}
          placeholder="내용을 붙여넣거나 직접 입력하세요..."
          className="flex-1 border border-surface-border rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:border-gray-400 bg-white leading-relaxed placeholder-gray-300" />

        <div className="flex items-center gap-3">
          <button onClick={ingestText} disabled={!text.trim() || loading}
            className="px-5 py-2 rounded-xl bg-gray-900 hover:bg-gray-700 disabled:opacity-40 text-white text-sm font-medium transition">
            {loading ? '추가 중…' : 'KG에 추가'}
          </button>
          {msg && (
            <span className={`text-xs ${msg.ok ? 'text-green-600' : 'text-red-500'}`}>{msg.text}</span>
          )}
          {text && <span className="ml-auto text-[10px] text-gray-400">{text.length}자</span>}
        </div>
      </div>

      {/* 파일 드롭 */}
      <div className="w-72 flex flex-col gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold text-gray-700">파일 업로드</h3>
          <span className="text-[10px] text-gray-400">txt/md → 즉시 KG · PDF/DOCX → 큐 등록</span>
        </div>

        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex-1 border-2 border-dashed rounded-2xl flex flex-col items-center justify-center gap-3 transition cursor-pointer
            ${dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50 hover:border-gray-400 hover:bg-gray-100'}`}
        >
          <div className="text-3xl">📂</div>
          <p className="text-xs text-gray-500 text-center leading-relaxed font-medium">
            파일을 드래그하거나 클릭
          </p>
          <div className="text-[10px] text-gray-400 text-center leading-relaxed">
            <div className="flex gap-1 flex-wrap justify-center">
              {['txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx'].map(ext => (
                <span key={ext} className="px-1.5 py-0.5 bg-white border border-gray-200 rounded text-gray-500">{ext}</span>
              ))}
            </div>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".txt,.md,.csv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
          className="hidden"
          onChange={e => { if (e.target.files) ingestFiles(Array.from(e.target.files)); e.target.value = '' }}
        />

        {fileResults.length > 0 && (
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {fileResults.map((r, i) => (
              <div key={i} className={`text-[10px] px-2 py-1.5 rounded-lg flex items-start gap-1.5
                ${r.ok ? 'bg-green-50 text-green-700' : 'bg-gray-50 text-gray-500'}`}>
                <span className="shrink-0">{r.ok ? '✓' : '!'}</span>
                <div>
                  <div className="font-medium truncate">{r.name}</div>
                  <div className="opacity-70">{r.msg}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 메인 뷰 ──────────────────────────────────────────
type Tab = 'search' | 'ingest' | 'graph' | 'files' | 'preference' | 'wiki'

export default function KnowledgeGraph({ settings }: { settings: Settings }) {
  const [tab, setTab] = useState<Tab>('search')
  const [available, setAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    fetch(`${API}/health`).then(r => r.ok ? setAvailable(true) : setAvailable(false)).catch(() => setAvailable(false))
  }, [])

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 헤더 */}
      <div className="h-14 flex items-center justify-between px-6 border-b border-surface-border shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-gray-900">지식 그래프</h1>
          {available !== null && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${available ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-500'}`}>
              {available ? 'Avatar API ✓' : 'Avatar API 오프라인'}
            </span>
          )}
        </div>
        <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {([['search', '검색 · 요약'], ['ingest', '내용 추가'], ['graph', '그래프'], ['files', '파일'], ['preference', 'Preference'], ['wiki', 'Wiki']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
                tab === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 컨텐츠 */}
      <div className="flex-1 overflow-hidden p-5">
        {available === false ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400">
            <div className="text-4xl">⚠</div>
            <div className="text-sm">Avatar API(8766)에 연결할 수 없습니다</div>
            <code className="text-xs bg-gray-50 border border-surface-border rounded-lg px-3 py-2">
              python D:\MyWork\mental-avatar\api\server.py
            </code>
          </div>
        ) : (
          <>
            {tab === 'search'     && <SearchTab settings={settings} />}
            {tab === 'ingest'     && <IngestTab />}
            {tab === 'graph'      && <GraphTab />}
            {tab === 'files'      && <FilesTab />}
            {tab === 'preference' && <PreferenceTab settings={settings} />}
            {tab === 'wiki'       && <WikiTab />}
          </>
        )}
      </div>
    </div>
  )
}
