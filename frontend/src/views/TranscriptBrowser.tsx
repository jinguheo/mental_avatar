import { useEffect, useState } from 'react'
import { API_BASE } from '@/config'

type Item = { key: string; created_at: string | null; text: string; label: string; saved: number; project: string; session: string }
type Group = { k: string; n: number; saved: number; last: string | null; items: Item[] }
type Result = { source: string; group: string; total: number; saved: number; groups: Group[] }

const SOURCES = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }]
const GROUPS = [{ id: 'date', name: '날짜별' }, { id: 'project', name: '프로젝트(주제 영역)별' }, { id: 'label', name: '종류별' }]
const LABELS = ['기준', '사실', '목표', '결정', '지시', '반응', '질문', '잡담', '붙여넣기', '로그', '대기']
const KEEP = new Set(['기준', '사실', '목표', '결정', '기준(직접)'])

export default function TranscriptBrowser() {
  const [source, setSource] = useState('claude')
  const [group, setGroup] = useState('date')
  const [label, setLabel] = useState('')
  const [query, setQuery] = useState('')
  const [applied, setApplied] = useState('')
  const [data, setData] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const params = new URLSearchParams({ source, group, q: applied, label, groups: '60', per_group: '40' })
    fetch(API_BASE + '/transcripts/browse?' + params)
      .then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error || '요청 실패'); return body as Result })
      .then(body => { setData(body); setError(''); setOpen({}) })
      .catch(cause => setError(String(cause.message || cause)))
  }, [source, group, label, applied])

  const tab = (active: boolean) => 'rounded px-2.5 py-1 text-sm ' + (active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700')
  return <section className="view-panel p-4 sm:p-5">
    <h2 className="text-lg font-semibold">3-3. 대화 기록 보기 (Claude Code / Codex)</h2>
    <p className="mt-1 text-sm text-gray-600">내가 쓴 메시지를 도구별로 나눠 날짜·프로젝트·종류별로 봅니다. <strong>KG</strong> 표시는 KG에 저장된 것이고, 나머지는 원본과 판단 사례에만 있습니다. 프로젝트별은 어떤 일을 하던 대화인지 보는 주제 영역입니다(내용 기반 주제 분류는 아직 없음).</p>
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      {SOURCES.map(item => <button key={item.id} onClick={() => setSource(item.id)} className={tab(source === item.id)}>{item.name}</button>)}
      <span className="mx-1 text-gray-300">|</span>
      {GROUPS.map(item => <button key={item.id} onClick={() => setGroup(item.id)} className={tab(group === item.id)}>{item.name}</button>)}
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
      <form onSubmit={event => { event.preventDefault(); setApplied(query.trim()) }} className="flex gap-1">
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="내용 검색" className="w-44 rounded-lg border border-gray-300 px-2 py-1" />
        <button type="submit" className="rounded-lg border border-gray-300 px-2.5 py-1">검색</button>
      </form>
      <select value={label} onChange={event => setLabel(event.target.value)} className="rounded-lg border border-gray-300 px-2 py-1" aria-label="종류">
        <option value="">모든 종류</option>
        {LABELS.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      {data && <span className="text-xs text-gray-500">{data.total}건 중 KG 저장 {data.saved}건</span>}
    </div>
    {error && <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <div className="mt-3 space-y-1.5">
      {data?.groups.map(item => {
        const isOpen = !!open[item.k]
        return <div key={item.k} className="rounded-lg border border-gray-200">
          <button onClick={() => setOpen(previous => ({ ...previous, [item.k]: !isOpen }))} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm" aria-expanded={isOpen}>
            <span className="font-medium">{item.k}</span>
            <span className="text-xs text-gray-500">{item.n}건 · KG {item.saved}건 {isOpen ? '▲' : '▼'}</span>
          </button>
          {isOpen && <ul className="space-y-1 border-t border-gray-200 bg-gray-50 p-2 text-sm">
            {item.items.map(message => <li key={message.key} className="rounded bg-white p-2">
              <p className="break-words text-gray-800">{message.text.length > 300 ? message.text.slice(0, 300) + '…' : message.text}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                <span>{(message.created_at || '').slice(0, 16)}</span>
                <span className={'rounded px-1.5 py-0.5 ' + (KEEP.has(message.label) ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700')}>{message.label}</span>
                {message.saved ? <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-indigo-800">KG</span> : null}
                {group !== 'project' && <span>{message.project.replace(/^(codex--|[dD]--MyWork-?)/, '') || '루트'}</span>}
              </p>
            </li>)}
            {item.n > item.items.length && <li className="text-xs text-gray-500">최근 {item.items.length}건만 표시합니다. 검색이나 종류로 좁혀 보세요.</li>}
          </ul>}
        </div>
      })}
      {data && data.groups.length === 0 && <p className="text-sm text-gray-500">조건에 맞는 메시지가 없습니다.{source === 'codex' && ' Codex 대화는 서버가 새로 시작된 뒤 가져오는 중일 수 있습니다.'}</p>}
    </div>
  </section>
}
