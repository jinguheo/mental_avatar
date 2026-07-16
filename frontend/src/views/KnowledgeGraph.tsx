import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { streamClaudeWeb } from '@/services/claudeWeb'
import { streamChatOllama } from '@/services/ollama'
import type { Settings } from '@/types'
import { API_BASE, MCP_ENDPOINT } from '@/config'
import KgDataManager from './KgDataManager'

const API = API_BASE

// ── 타입 ──────────────────────────────────────────────
interface SearchResult {
  id: string; title: string; document: string
  source_type: string; distance: number
  file_path?: string
  _source?: string; community?: string  // 백엔드 /search가 KG/graphify 결과 구분용으로 덧붙이는 필드
}
interface AvatarSummary {
  summary: string
  core_interests: { topic: string; doc_count: number; importance: number }[]
  trends: { topic: string; recent: number; total: number; growth: string }[]
  gaps: { topic: string; doc_count: number }[]
}
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
  project: '#0ea5e9',
  conversation: '#64748b',
  graphify: '#14b8a6',
}

interface GraphNode {
  id: string
  title: string
  content?: string
  type?: string
  source_type?: string
  importance?: number
  file_path?: string
  updated_at?: string
  created_at?: string
}

interface GraphEdge {
  from_id: string
  to_id: string
  relation: string
  weight?: number
}

const normalizeResultGroupKey = (r: SearchResult) => {
  const title = (r.title || '').replace(/\s*\[\d+\]\s*$/, '').trim().toLowerCase()
  const file = (r.file_path || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() || ''
  return file || title || r.id
}

const compactSearchResults = (results: SearchResult[], limit = 5) => {
  const grouped = new Map<string, SearchResult>()
  for (const r of results) {
    const key = normalizeResultGroupKey(r)
    const prev = grouped.get(key)
    if (!prev || r.distance < prev.distance) grouped.set(key, r)
  }
  return Array.from(grouped.values()).slice(0, limit)
}

const RESULT_SUMMARY_PROMPT = (query: string, results: SearchResult[]) => {
  const topResults = compactSearchResults(results, 5)
  const body = topResults.length > 0
    ? topResults.map((r, idx) => [
        `${idx + 1}. ${r.title || '(제목 없음)'}`,
        `유형: ${r.source_type}`,
        `원본: ${r.file_path || '(원본 없음)'}`,
        `내용: ${(r.document || '').slice(0, 180)}`,
      ].join('\n')).join('\n\n')
    : '검색 결과가 없습니다.'

  return `당신은 지식 그래프 검색 결과를 한국어로 간단명료하게 요약하는 도우미입니다.

검색어:
${query}

검색 결과:
${body}

아래 형식으로만 답하세요.
1. 한 줄 핵심 요약
2. 핵심 결과 3개 정도만 짧게 정리
3. 다음에 이어서 볼 만한 관점 1개

중요:
- 같은 문서의 청크가 여러 개 있으면 하나로 묶어서 요약하세요.
- 반복되는 말이나 장황한 수식은 빼고, 결과 내용만 요약하세요.

3~5문장, 한국어, 중복 없이.`
}

// ── 탭 1: 검색 + 아바타 요약 ──────────────────────────
function SearchTab({ settings, onOpenProject }: { settings: Settings; onOpenProject: (pid: string) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<AvatarSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryMode, setSummaryMode] = useState<'result' | 'global'>('global')
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

  const normalizeDocumentTitle = (title: string) =>
    (title || '').replace(/\s*\[\d+\]\s*$/, '').trim().toLowerCase()

  const openResultSource = useCallback(async (r: SearchResult) => {
    if (r.source_type === 'project' && r.id.startsWith('project_')) {
      onOpenProject(r.id.slice('project_'.length))
      return
    }

    const path = r.file_path || results.find(x =>
      x.file_path &&
      x.source_type === r.source_type &&
      normalizeDocumentTitle(x.title) === normalizeDocumentTitle(r.title)
    )?.file_path || ''
    if (!path) return
    if (path.startsWith('conversation://') || path.startsWith('sync://')) return
    const fileUrl = `file:///${path.replace(/\\/g, '/')}`
    const opened = window.open(fileUrl, '_blank', 'noopener,noreferrer')
    if (opened) return
    await fetch(`${API}/files/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }).catch(() => {})
  }, [onOpenProject, results])

  const hasOriginalSource = useCallback((r: SearchResult) => {
    const path = r.file_path || results.find(x =>
      x.file_path &&
      x.source_type === r.source_type &&
      normalizeDocumentTitle(x.title) === normalizeDocumentTitle(r.title)
    )?.file_path || ''
    return !!path && !path.startsWith('conversation://') && !path.startsWith('sync://')
  }, [results])

  const loadGlobalSummary = useCallback(async () => {
    setSummaryLoading(true)
    setSummaryMode('global')
    try {
      const data = await apiFetch('/avatar/summary')
      setSummary(data)
    } catch (err) {
      console.warn('[KnowledgeGraph] avatar summary load failed:', err)
    } finally {
      setSummaryLoading(false)
    }
  }, [])

  const loadResultSummary = useCallback(async () => {
    setSummaryLoading(true)
    setSummaryMode('result')
    try {
      if (!results.length) {
        const emptySummary: AvatarSummary = {
          summary: '현재 검색 결과가 없어 요약할 항목이 없습니다. 검색어를 먼저 입력해 주세요.',
          core_interests: [],
          trends: [],
          gaps: [],
        }
        setSummary(emptySummary)
        return
      }

      const prompt = RESULT_SUMMARY_PROMPT(query.trim(), results)
      const emptySummary: AvatarSummary = {
        summary: '',
        core_interests: [],
        trends: [],
        gaps: [],
      }
      setSummary(emptySummary)
      let summaryText = ''
      await streamChatOllama(
        settings.ollamaEndpoint,
        settings.ollamaModel,
        [{ role: 'user', content: prompt }],
        '당신은 검색 결과를 짧고 명확한 한국어로 요약하는 도우미입니다.',
        (delta) => {
          summaryText += delta
          setSummary(prev => prev ? { ...prev, summary: summaryText } : emptySummary)
        },
      )
      setSummary(prev => prev ? { ...prev, summary: summaryText || prev.summary } : { ...emptySummary, summary: summaryText })
    } catch (err) {
      console.warn('[KnowledgeGraph] result summary load failed:', err)
      setSummary({
        summary: `검색어 "${query.trim() || '(없음)'}" 기준으로 ${results.length}개의 결과가 있습니다.`,
        core_interests: [],
        trends: [],
        gaps: [],
      })
    } finally {
      setSummaryLoading(false)
    }
  }, [settings.ollamaEndpoint, settings.ollamaModel, query, results])

  return (
    <div className="flex gap-5 h-full min-h-0">
      {/* 왼쪽: 검색 */}
      <div className="flex-[0.88] flex flex-col min-h-0">
        {/* 검색 입력 */}
        <div className="flex gap-2 mb-4">
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

        {/* 통계 요약 (검색 결과 없을 때만 표시) */}
        {results.length === 0 && stats && (() => {
          const DOC_TYPES = ['pdf','pptx','docx','note','txt','md','file']
          const docCount = DOC_TYPES.reduce((s, t) => s + (stats.by_source[t] ?? 0), 0)
          const conceptCount = stats.by_source['concept'] ?? 0
          const topSources = Object.entries(stats.by_source)
            .filter(([src]) => DOC_TYPES.includes(src) && stats.by_source[src] > 0)
            .sort((a, b) => b[1] - a[1])
          return (
            <div className="mb-4 space-y-3">
              {/* 핵심 수치 */}
              <div className="flex gap-3">
                {[
                  { label: '문서', value: docCount, color: '#6366f1' },
                  { label: '개념', value: conceptCount, color: '#f59e0b' },
                  { label: '토픽', value: stats.topics, color: '#10b981' },
                  { label: '연결', value: stats.edges, color: '#64748b' },
                ].map(s => (
                  <div key={s.label} className="flex-1 rounded-xl border border-surface-border px-3 py-2 text-center">
                    <div className="text-xl font-bold" style={{ color: s.color }}>{s.value}</div>
                    <div className="text-[10px] text-gray-500">{s.label}</div>
                  </div>
                ))}
              </div>
              {/* 문서 종류 */}
              {topSources.length > 0 && (
                <div className="flex gap-2 flex-wrap">
                  {topSources.map(([src, cnt]) => (
                    <span key={src} className="text-[11px] px-2.5 py-1 rounded-full border font-medium"
                      style={{ borderColor: SOURCE_COLOR[src] + '80', color: SOURCE_COLOR[src], background: SOURCE_COLOR[src] + '12' }}>
                      {src} {cnt}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })()}

        {/* 검색 결과 */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {results.length === 0 && !loading && (
            <div className="text-center text-gray-400 text-sm mt-10">검색어를 입력하고 Enter를 누르세요</div>
          )}
          {results.map(r => (
            <div key={r.id}
              className={`border rounded-xl p-3 hover:bg-gray-50 transition-colors cursor-pointer ${r._source === 'graphify' ? 'border-purple-200 bg-purple-50/30' : 'border-surface-border'}`}
              onClick={() => {
                apiFetch('/activity/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: r.id, action: 'view', context: r.title || '' }) }).catch(() => {})
                openResultSource(r)
              }}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <span className="font-medium text-sm text-gray-900 truncate">{r.title || '(제목 없음)'}</span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {r._source === 'graphify'
                    ? <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700">🕸 {r.community}</span>
                    : <>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
                          style={{ background: SOURCE_COLOR[r.source_type] + '20', color: SOURCE_COLOR[r.source_type] }}>
                          {r.source_type}
                        </span>
                        <span className="text-[10px] text-gray-400">{(1 - r.distance).toFixed(2)}</span>
                      </>
                  }
                </div>
              </div>
              <p className="text-sm text-gray-500 line-clamp-2">{r.document}</p>
              {hasOriginalSource(r) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    openResultSource(r)
                  }}
                  className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 active:bg-gray-100"
                >
                  <span>원본 열기</span>
                  <span className="text-gray-400">↗</span>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 오른쪽: 아바타 요약 */}
      <div className="w-96 shrink-0 flex flex-col gap-3 overflow-y-auto">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-700">아바타 요약</h3>
          <div className="flex rounded-lg border border-surface-border overflow-hidden">
            <button
              onClick={loadResultSummary}
              disabled={summaryLoading}
              className={`text-xs px-3 py-1 transition-colors ${summaryMode === 'result' ? 'bg-gray-900 text-white' : 'bg-white hover:bg-gray-50 text-gray-600'} disabled:opacity-50`}
            >
              결과 요약
            </button>
            <button
              onClick={loadGlobalSummary}
              disabled={summaryLoading}
              className={`text-xs px-3 py-1 transition-colors border-l border-surface-border ${summaryMode === 'global' ? 'bg-gray-900 text-white' : 'bg-white hover:bg-gray-50 text-gray-600'} disabled:opacity-50`}
            >
              전체 요약
            </button>
          </div>
        </div>

        {summary ? (
          <>
            <div className="bg-gray-50 border border-surface-border rounded-xl p-3 text-sm text-gray-700 leading-relaxed">
              {summary.summary}
            </div>

            {summary.core_interests.length > 0 && (
              <div>
                <div className="text-sm font-medium text-gray-500 mb-1.5">핵심 관심사</div>
                <div className="space-y-1">
                  {summary.core_interests.slice(0, 6).map(i => (
                    <div key={i.topic} className="flex items-center justify-between text-sm">
                      <span className="text-gray-700 truncate">{i.topic}</span>
                      <span className="text-gray-400 shrink-0 ml-2">{i.doc_count}개</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {summary.trends.length > 0 && (
              <div>
                <div className="text-sm font-medium text-gray-500 mb-1.5">토픽 트렌드</div>
                <div className="flex flex-wrap gap-1">
                  {summary.trends.slice(0, 8).map(t => (
                    <span key={t.topic} className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${GROWTH_COLOR[t.growth] ?? 'text-gray-500 bg-gray-50'}`}>
                      {t.topic} {t.growth}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {summary.gaps.length > 0 && (
              <div>
                <div className="text-sm font-medium text-gray-500 mb-1.5">지식 갭</div>
                <div className="space-y-1">
                  {summary.gaps.map(g => (
                    <div key={g.topic} className="text-sm text-orange-600 bg-orange-50 rounded-lg px-2 py-1">
                      {g.topic} <span className="text-orange-400">({g.doc_count}개)</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-gray-400 text-center mt-4">
            "생성" 버튼을 눌러<br />아바타 요약을 만드세요
          </div>
        )}
      </div>
    </div>
  )
}

// ── 탭 2: 그래프 (파일 목록으로 대체) ─────────────────
function GraphTab() {
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const d = await apiFetch('/graph/all?limit=80')
      setNodes(d.nodes ?? [])
      setEdges(d.edges ?? [])
    } catch {
      setNodes([])
      setEdges([])
      setError('\uADF8\uB798\uD504 \uB370\uC774\uD130\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const view = useMemo(() => {
    const degree = new Map<string, number>()
    for (const edge of edges) {
      degree.set(edge.from_id, (degree.get(edge.from_id) ?? 0) + 1)
      degree.set(edge.to_id, (degree.get(edge.to_id) ?? 0) + 1)
    }

    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const q = query.trim().toLowerCase()
    let visibleNodes = nodes
    if (q) {
      const matched = new Set(
        nodes
          .filter(node => `${node.title} ${node.content ?? ''} ${node.source_type ?? ''}`.toLowerCase().includes(q))
          .map(node => node.id)
      )
      for (const edge of edges) {
        if (matched.has(edge.from_id)) matched.add(edge.to_id)
        if (matched.has(edge.to_id)) matched.add(edge.from_id)
      }
      visibleNodes = nodes.filter(node => matched.has(node.id))
    } else {
      visibleNodes = [...nodes]
        .sort((a, b) => ((degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)) || ((b.importance ?? 0) - (a.importance ?? 0)))
        .slice(0, 90)
    }

    const visibleIds = new Set(visibleNodes.map(node => node.id))
    const visibleEdges = edges.filter(edge => visibleIds.has(edge.from_id) && visibleIds.has(edge.to_id)).slice(0, 450)
    const connectedIds = new Set<string>()
    for (const edge of visibleEdges) {
      connectedIds.add(edge.from_id)
      connectedIds.add(edge.to_id)
    }
    visibleNodes = visibleNodes.filter(node => connectedIds.has(node.id) || q)

    const groups: Record<string, GraphNode[]> = { center: [], middle: [], outer: [] }
    for (const node of visibleNodes) {
      const source = node.source_type || node.type || 'unknown'
      if (source === 'concept' || source === 'technology' || source === 'tool' || source === 'entity') groups.center.push(node)
      else if (source === 'conversation' || source === 'sync') groups.outer.push(node)
      else groups.middle.push(node)
    }

    const positions = new Map<string, { x: number; y: number }>()
    const place = (group: GraphNode[], radius: number, offset = 0) => {
      const count = Math.max(group.length, 1)
      group.forEach((node, index) => {
        const angle = offset + (Math.PI * 2 * index) / count
        positions.set(node.id, { x: 500 + Math.cos(angle) * radius, y: 310 + Math.sin(angle) * radius })
      })
    }
    place(groups.center.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)), 145, -Math.PI / 2)
    place(groups.middle.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)), 245, -Math.PI / 3)
    place(groups.outer.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)), 305, Math.PI / 8)

    const sourceCounts = visibleNodes.reduce<Record<string, number>>((acc, node) => {
      const source = node.source_type || node.type || 'unknown'
      acc[source] = (acc[source] ?? 0) + 1
      return acc
    }, {})

    return { nodeById, degree, visibleNodes, visibleEdges, positions, sourceCounts }
  }, [nodes, edges, query])

  const selected = (selectedId && view.nodeById.get(selectedId)) || view.visibleNodes[0] || null
  const selectedLinks = selected
    ? view.visibleEdges
        .filter(edge => edge.from_id === selected.id || edge.to_id === selected.id)
        .map(edge => ({ edge, node: view.nodeById.get(edge.from_id === selected.id ? edge.to_id : edge.from_id) }))
        .filter((item): item is { edge: GraphEdge; node: GraphNode } => Boolean(item.node))
        .slice(0, 18)
    : []

  const shortTitle = (title: string, max = 18) => title.length > max ? `${title.slice(0, max - 1)}?` : title
  const colorFor = (node: GraphNode) => SOURCE_COLOR[node.source_type || node.type || 'unknown'] ?? SOURCE_COLOR.unknown

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="KG 노드 검색"
          className="w-56 border border-surface-border rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-gray-400 bg-white"
        />
        <div className="flex-1 text-xs text-gray-500">
          노드 {view.visibleNodes.length.toLocaleString()}개 ? 연결 {view.visibleEdges.length.toLocaleString()}개
        </div>
        <button onClick={load} disabled={loading}
          className="text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50 disabled:opacity-50">
          {loading ? '로딩...' : '새로고침'}
        </button>
      </div>

      {error && <div className="text-xs text-red-500">{error}</div>}

      <div className="grid grid-cols-[minmax(0,1fr)_18rem] gap-4 flex-1 min-h-0">
        <div className="min-h-0 rounded-lg border border-surface-border bg-white overflow-hidden">
          <svg viewBox="0 0 1000 620" className="h-full w-full bg-gray-50">
            <g opacity="0.72">
              {view.visibleEdges.map((edge, index) => {
                const a = view.positions.get(edge.from_id)
                const b = view.positions.get(edge.to_id)
                if (!a || !b) return null
                const active = selected && (edge.from_id === selected.id || edge.to_id === selected.id)
                return (
                  <line
                    key={`${edge.from_id}-${edge.to_id}-${index}`}
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={active ? '#111827' : '#cbd5e1'}
                    strokeWidth={active ? 2.2 : Math.max(0.7, Math.min(2, edge.weight ?? 1))}
                  />
                )
              })}
            </g>
            <g>
              {view.visibleNodes.map(node => {
                const pos = view.positions.get(node.id)
                if (!pos) return null
                const degree = view.degree.get(node.id) ?? 0
                const active = selected?.id === node.id
                const radius = Math.max(8, Math.min(18, 7 + degree * 0.7))
                return (
                  <g key={node.id} transform={`translate(${pos.x} ${pos.y})`} onClick={() => setSelectedId(node.id)} className="cursor-pointer">
                    <circle r={radius + (active ? 4 : 0)} fill={active ? '#111827' : '#ffffff'} stroke={colorFor(node)} strokeWidth={active ? 4 : 2.5} />
                    <circle r={Math.max(4, radius - 4)} fill={colorFor(node)} opacity={active ? 1 : 0.85} />
                    <text y={radius + 14} textAnchor="middle" className="select-none fill-gray-700 text-[10px] font-medium">
                      {shortTitle(node.title || '(제목 없음)')}
                    </text>
                    <title>{node.title}</title>
                  </g>
                )
              })}
            </g>
          </svg>
        </div>

        <aside className="min-h-0 overflow-y-auto rounded-lg border border-surface-border bg-white p-3">
          <div className="mb-3">
            <div className="text-xs font-semibold text-gray-900">선택한 노드</div>
            {selected ? (
              <>
                <div className="mt-2 text-sm font-semibold text-gray-900 leading-5">{selected.title}</div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-500">
                  <span className="inline-flex h-2 w-2 rounded-full" style={{ background: colorFor(selected) }} />
                  <span>{selected.source_type || selected.type || 'unknown'}</span>
                  <span>연결 {view.degree.get(selected.id) ?? 0}</span>
                </div>
                {selected.content && <p className="mt-2 text-xs leading-5 text-gray-600 line-clamp-5">{selected.content}</p>}
              </>
            ) : <div className="mt-8 text-center text-sm text-gray-400">표시할 연결 정보가 없습니다</div>}
          </div>

          {selectedLinks.length > 0 && (
            <div className="border-t border-surface-border pt-3">
              <div className="mb-2 text-xs font-semibold text-gray-900">연결된 정보</div>
              <div className="space-y-1.5">
                {selectedLinks.map(({ edge, node }) => (
                  <button key={`${edge.from_id}-${edge.to_id}-${node.id}`} onClick={() => setSelectedId(node.id)}
                    className="w-full text-left rounded-lg border border-transparent px-2 py-1.5 hover:border-surface-border hover:bg-gray-50">
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
                      <span className="inline-flex h-1.5 w-1.5 rounded-full" style={{ background: colorFor(node) }} />
                      <span>{edge.relation || 'related'}</span>
                      <span>{node.source_type || node.type || 'unknown'}</span>
                    </div>
                    <div className="mt-0.5 truncate text-xs font-medium text-gray-800">{node.title}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 border-t border-surface-border pt-3">
            <div className="mb-2 text-xs font-semibold text-gray-900">유형</div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(view.sourceCounts).slice(0, 10).map(([source, count]) => (
                <span key={source} className="inline-flex items-center gap-1 rounded-full bg-gray-50 px-2 py-1 text-[10px] text-gray-500">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: SOURCE_COLOR[source] ?? SOURCE_COLOR.unknown }} />
                  {source} {count}
                </span>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

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
  const [files, setFiles] = useState<RawFile[]>([])
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)

  const loadFiles = useCallback(async () => {
    setLoading(true)
    try {
      const d = await apiFetch('/files/list').catch(() => ({ files: [] }))
      setFiles(d.files ?? [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadFiles() }, [loadFiles])

  const openFile = async (path: string) => {
    setOpening(path)
    await fetch(`${API}/files/open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path })
    }).finally(() => setTimeout(() => setOpening(null), 800))
  }

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <span className="text-xs text-gray-500 flex-1">docs/ 전체 파일</span>
        <button onClick={loadFiles} disabled={loading}
          className="text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50 disabled:opacity-50">
          {loading ? '로딩...' : '새로고침'}
        </button>
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
            {files.length === 0 && (
              <tr><td colSpan={4} className="py-8 text-center text-gray-400">{loading ? '로딩 중...' : '파일이 없습니다'}</td></tr>
            )}
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
}

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
      const mcpEndpoint = settings.mcpEndpoint || MCP_ENDPOINT
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
          [{ role: 'user', content: prompt }], '', (delta: string) => {
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
  node_id?: string  // KG 노드 연결용(백엔드가 함께 반환)
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
    // 완료될 때까지 폴링 후 자동 오픈
    const poll = setInterval(async () => {
      const res = await fetch(`${API}/graphify/status`)
      const data = await res.json()
      if (!data.running && data.html_ready && data.nodes > 0) {
        clearInterval(poll)
        await loadStatus()
        window.open(`${API}/graphify/graph.html`)
      }
    }, 3000)
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
              <div className="text-[10px] text-gray-400">완료되면 자동으로 결과가 열립니다</div>
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
              {gJob?.html_ready && (
                <button
                  onClick={() => window.open(`${API}/graphify/graph.html`)}
                  className="w-full text-[11px] py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 transition font-medium">
                  🕸 결과 보기
                </button>
              )}
              <button onClick={runGraphify} disabled={gJob?.running}
                className="w-full text-[10px] py-1.5 border border-surface-border rounded-lg hover:bg-gray-50 disabled:opacity-40 transition">
                {gJob?.html_ready ? '재빌드' : 'Graphify 실행'}
              </button>
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
            <button key={p.id} onClick={() => { setSelected(p); apiFetch('/activity/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node_id: p.node_id, action: 'wiki_view', context: p.title || '' }) }).catch(() => {}) }}
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

// ── 탭 6: Project (코드 레포 폴더 단위 요약) ──────────
interface ProjectSummary {
  id: string; name: string; folder_path: string; status: string; error?: string
  updated_at: string; graphified_at?: string | null
  stats: { total_files: number; code_files: number; md_files: number; total_size: number }
  overview?: string
}
interface ProjectDetail extends ProjectSummary {
  summary: string; changes: string; diagram?: string; export_path?: string
}

let mermaidInited = false
function MermaidDiagram({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const id = `mermaid-${Math.random().toString(36).slice(2)}`
    // mermaid.render()는 문법 오류여도 reject 대신 "Syntax error..." 에러 그림을 그린 svg로
    // resolve해버려서(.catch가 못 잡음) — mermaid.parse()로 먼저 문법을 검증해 그 경우를 걸러낸다.
    ;(async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        if (!mermaidInited) {
          mermaid.initialize({ startOnLoad: false, theme: 'neutral' })
          mermaidInited = true
        }
        await mermaid.parse(code.trim())
        const { svg } = await mermaid.render(id, code.trim())
        if (!cancelled && ref.current) { ref.current.innerHTML = svg; setError('') }
      } catch {
        if (!cancelled) setError('다이어그램 렌더링 실패')
      }
    })()
    return () => { cancelled = true }
  }, [code])

  if (error) return <pre className="text-[11px] text-gray-400 whitespace-pre-wrap">{code}</pre>
  return <div ref={ref} className="overflow-x-auto" />
}

function ProjectTab({ openProjectId, onProjectOpened }: { openProjectId?: string | null; onProjectOpened?: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [detail, setDetail] = useState<ProjectDetail | null>(null)
  const [folderPath, setFolderPath] = useState('')
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState('')
  const [gRunning, setGRunning] = useState(false)
  const [gMsg, setGMsg] = useState('')
  const [gAllRunning, setGAllRunning] = useState(false)
  const [gAllMsg, setGAllMsg] = useState('')

  const loadProjects = useCallback(async () => {
    const d = await apiFetch('/project/list').catch(() => ({ projects: [] }))
    setProjects(d.projects ?? [])
  }, [])

  useEffect(() => { loadProjects() }, [loadProjects])

  const loadDetail = async (id: string) => {
    const d = await apiFetch(`/project/${id}`).catch(() => null)
    setDetail(d)
  }

  useEffect(() => {
    if (openProjectId) {
      loadDetail(openProjectId)
      onProjectOpened?.()
    }
  }, [openProjectId])

  const scanFolder = async (pathOverride?: string) => {
    const target = (pathOverride ?? folderPath).trim()
    if (!target) return
    setScanning(true); setError('')
    try {
      const d = await apiFetch('/project/scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_path: target })
      })
      if (d.error) { setError(d.error); return }
      setFolderPath('')
      await loadProjects()
      await loadDetail(d.id)
    } catch {
      setError('스캔 실패 — 폴더 경로/서버 상태 확인')
    } finally { setScanning(false) }
  }

  const refresh = async (id: string) => {
    setScanning(true)
    try {
      await fetch(`${API}/project/${id}/refresh`, { method: 'POST' })
      await loadProjects(); await loadDetail(id)
    } finally { setScanning(false) }
  }

  const removeProject = async (id: string) => {
    await fetch(`${API}/project/${id}`, { method: 'DELETE' })
    if (detail?.id === id) setDetail(null)
    await loadProjects()
  }

  const openFolder = async (id: string) => {
    setError('')
    const d = await fetch(`${API}/project/${id}/open_folder`, { method: 'POST' })
      .then(r => r.json()).catch(() => ({ error: '요청 실패 — 서버 상태 확인' }))
    if (d.error) setError(d.error)
  }

  const openFolderPath = async () => {
    setError('')
    const d = await fetch(`${API}/project/open_folder_path`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: folderPath.trim() })
    }).then(r => r.json()).catch(() => ({ error: '요청 실패 — 서버 상태 확인' }))
    if (d.error) setError(d.error)
  }

  const pickFolder = async () => {
    setError('')
    const d = await fetch(`${API}/project/pick_folder`, { method: 'POST' })
      .then(r => r.json()).catch(() => ({ error: '요청 실패 — 서버 상태 확인' }))
    if (d.error) { setError(d.error); return }
    if (d.path) await scanFolder(d.path)
  }

  const pickFile = async () => {
    setError('')
    const d = await fetch(`${API}/project/pick_file`, { method: 'POST' })
      .then(r => r.json()).catch(() => ({ error: '요청 실패 — 서버 상태 확인' }))
    if (d.error) { setError(d.error); return }
    if (d.folder_path) await scanFolder(d.folder_path)
  }

  const runGraphify = async () => {
    if (!detail) return
    const pid = detail.id
    setGRunning(true); setGMsg('')
    await fetch(`${API}/graphify/run`, { method: 'POST' }).catch(() => {})
    const poll = setInterval(async () => {
      const data = await fetch(`${API}/graphify/status`).then(r => r.json()).catch(() => ({}))
      if (!data.running) {
        clearInterval(poll)
        setGRunning(false)
        if (data.error) setGMsg(data.error)
        else if (data.html_ready) {
          setGMsg(`완료 — 노드 ${data.nodes} · 엣지 ${data.edges} · 커뮤니티 ${data.communities}`)
          await fetch(`${API}/project/${pid}/graphify_mark`, { method: 'POST' }).catch(() => {})
          await loadProjects(); await loadDetail(pid)
          window.open(`${API}/graphify/graph.html`)
        }
      }
    }, 3000)
  }

  // 일괄 처리 — Graphify는 전체 wiki를 하나의 그래프로 묶어 처리하는 전역 작업이라
  // 한 번만 실행하면 모든 프로젝트의 md가 함께 포함됨. 실행 후 전체 프로젝트에 처리 표시.
  const runGraphifyAll = async () => {
    setGAllRunning(true); setGAllMsg('')
    await fetch(`${API}/graphify/run`, { method: 'POST' }).catch(() => {})
    const poll = setInterval(async () => {
      const data = await fetch(`${API}/graphify/status`).then(r => r.json()).catch(() => ({}))
      if (!data.running) {
        clearInterval(poll)
        setGAllRunning(false)
        if (data.error) setGAllMsg(data.error)
        else if (data.html_ready) {
          setGAllMsg(`전체 완료 — 노드 ${data.nodes} · 엣지 ${data.edges} · 커뮤니티 ${data.communities}`)
          await fetch(`${API}/project/graphify_mark_all`, { method: 'POST' }).catch(() => {})
          await loadProjects()
          if (detail) await loadDetail(detail.id)
        }
      }
    }, 3000)
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* 좌측: 폴더 등록 + 목록 */}
      <div className="w-72 shrink-0 flex flex-col gap-3 min-h-0">
        <div className="flex flex-col gap-1.5 shrink-0">
          <input value={folderPath} onChange={e => setFolderPath(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && scanFolder()}
            placeholder="D:\MyWork\project-name"
            className="border border-surface-border rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-gray-400 bg-white" />
          <div className="flex gap-1.5">
            <button onClick={() => scanFolder()} disabled={scanning}
              className="flex-1 text-xs px-3 py-1.5 bg-gray-900 text-white rounded-xl hover:bg-gray-700 disabled:opacity-50">
              {scanning ? '스캔 중...' : '폴더 스캔'}
            </button>
            <button onClick={openFolderPath}
              className="text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50">탐색기 열기</button>
          </div>
          <div className="flex gap-1.5">
            <button onClick={pickFolder}
              className="flex-1 text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50">📁 폴더 선택</button>
            <button onClick={pickFile}
              className="flex-1 text-xs px-3 py-1.5 border border-surface-border rounded-xl hover:bg-gray-50">📄 파일 선택</button>
          </div>
          {error && <div className="text-[11px] text-red-500">{error}</div>}
          {projects.length > 0 && (
            <button onClick={runGraphifyAll} disabled={gAllRunning}
              className="text-xs px-3 py-1.5 border border-purple-200 bg-purple-50 text-purple-700 rounded-xl hover:bg-purple-100 disabled:opacity-50">
              {gAllRunning ? '🕸 전체 처리 중...' : `🕸 전체 일괄 Graphify 처리 (${projects.length}개)`}
            </button>
          )}
          {gAllMsg && <div className="text-[11px] text-gray-500">{gAllMsg}</div>}
        </div>

        <div className="flex-1 overflow-y-auto space-y-1.5 min-h-0">
          {projects.map(p => (
            <div key={p.id} onClick={() => loadDetail(p.id)}
              className={`relative p-2.5 rounded-xl border cursor-pointer text-xs ${
                detail?.id === p.id ? 'border-gray-400 bg-gray-50' : 'border-surface-border hover:bg-gray-50'
              }`}>
              <button onClick={e => { e.stopPropagation(); removeProject(p.id) }}
                className="absolute top-1.5 right-1.5 w-4 h-4 flex items-center justify-center rounded-full text-gray-400 hover:bg-red-50 hover:text-red-500 text-[11px] leading-none">×</button>
              <div className="font-medium text-gray-900 truncate pr-4">{p.name}</div>
              <div className="text-gray-400 truncate text-[10px]">{p.folder_path}</div>
              <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
                <span>{p.status === 'error' ? '⚠ 오류' : `파일 ${p.stats?.total_files ?? 0}`}</span>
                <span>·</span>
                <span>{p.updated_at}</span>
                {p.graphified_at && (
                  <span className="ml-auto px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700 text-[9px] font-medium">✓ 처리됨</span>
                )}
              </div>
            </div>
          ))}
          {projects.length === 0 && (
            <div className="text-xs text-gray-400 text-center py-6">등록된 프로젝트가 없습니다</div>
          )}
        </div>
      </div>

      {/* 우측: 상세 */}
      <div className="flex-1 overflow-y-auto border border-surface-border rounded-xl p-4 min-h-0">
        {!detail ? (
          <div className="flex items-center justify-center h-full text-xs text-gray-400">
            좌측에서 폴더를 스캔하거나 프로젝트를 선택하세요
          </div>
        ) : detail.status === 'error' ? (
          <div className="text-xs text-red-500">스캔 오류: {detail.error}</div>
        ) : (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-semibold text-gray-900">{detail.name}</h3>
                <div className="text-[11px] text-gray-400">{detail.folder_path}</div>
                {detail.export_path && (
                  <div className="text-[10px] text-gray-400 mt-0.5">📄 {detail.export_path}</div>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={() => openFolder(detail.id)}
                  className="text-[11px] px-2.5 py-1 border border-surface-border rounded-lg hover:bg-gray-50">탐색기에서 열기</button>
                <button onClick={() => refresh(detail.id)} disabled={scanning}
                  className="text-[11px] px-2.5 py-1 border border-surface-border rounded-lg hover:bg-gray-50">새로고침</button>
                <button onClick={runGraphify} disabled={gRunning}
                  className="text-[11px] px-2.5 py-1 border border-surface-border rounded-lg hover:bg-gray-50 disabled:opacity-50">
                  {gRunning ? 'Graphify 처리 중...' : detail.graphified_at ? '🕸 다시 처리' : '🕸 Graphify로 처리'}
                </button>
                {detail.graphified_at && (
                  <span className="text-[10px] px-2 py-1 rounded-lg bg-purple-50 text-purple-700 self-center">✓ {detail.graphified_at} 처리됨</span>
                )}
                <button onClick={() => removeProject(detail.id)}
                  className="text-[11px] px-2.5 py-1 border border-surface-border rounded-lg hover:bg-red-50 text-red-500">삭제</button>
              </div>
            </div>

            {gMsg && <div className="text-[11px] text-gray-500">{gMsg}</div>}

            <div className="flex gap-4 text-[11px] text-gray-500">
              <span>전체 {detail.stats?.total_files ?? 0}개</span>
              <span>코드 {detail.stats?.code_files ?? 0}개</span>
              <span>md {detail.stats?.md_files ?? 0}개</span>
            </div>

            <section>
              <h4 className="text-xs font-semibold text-gray-700 mb-1.5">개요</h4>
              <p className="text-xs text-gray-600 whitespace-pre-wrap">{detail.overview || '(없음)'}</p>
            </section>

            <section>
              <h4 className="text-xs font-semibold text-gray-700 mb-1.5">요약</h4>
              <p className="text-xs text-gray-600 whitespace-pre-wrap">{detail.summary || '(없음)'}</p>
            </section>

            {detail.diagram && (
              <section>
                <h4 className="text-xs font-semibold text-gray-700 mb-1.5">플로우 다이어그램</h4>
                <div className="bg-gray-50 rounded-lg p-2.5">
                  <MermaidDiagram code={detail.diagram} />
                </div>
              </section>
            )}

            <section>
              <h4 className="text-xs font-semibold text-gray-700 mb-1.5">변경사항</h4>
              <pre className="text-[11px] text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-2.5">{detail.changes || '(없음)'}</pre>
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

// ── 메인 뷰 ──────────────────────────────────────────
type Tab = 'search' | 'ingest' | 'graph' | 'files' | 'preference' | 'wiki' | 'project' | 'data'

export default function KnowledgeGraph({ settings }: { settings: Settings }) {
  const [tab, setTab] = useState<Tab>('search')
  const [available, setAvailable] = useState<boolean | null>(null)
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)

  const openProject = (pid: string) => { setOpenProjectId(pid); setTab('project') }

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
          {([['search', '검색 · 요약'], ['ingest', '내용 추가'], ['graph', '그래프'], ['files', '파일'], ['preference', 'Preference'], ['wiki', 'Wiki'], ['project', '프로젝트'], ['data', '데이터 관리']] as [Tab, string][]).map(([id, label]) => (
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
            {tab === 'search'     && <SearchTab settings={settings} onOpenProject={openProject} />}
            {tab === 'ingest'     && <IngestTab />}
            {tab === 'graph'      && <GraphTab />}
            {tab === 'files'      && <FilesTab />}
            {tab === 'preference' && <PreferenceTab settings={settings} />}
            {tab === 'wiki'       && <WikiTab />}
            {tab === 'project'    && <ProjectTab openProjectId={openProjectId} onProjectOpened={() => setOpenProjectId(null)} />}
            {tab === 'data'       && <KgDataManager />}
          </>
        )}
      </div>
    </div>
  )
}

