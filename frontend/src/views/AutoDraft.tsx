import { useState } from 'react'
import { API_BASE } from '@/config'

// 이전 기록(대화·인터뷰 답)을 살펴 입력칸 초안을 만든다. 저장은 하지 않고, 읽고 고친 뒤 사용자가 저장해야 반영된다.
type Evidence = { text: string; date: string; source: string; label: string | null; project: string }
type Case = { question: string; expected: string; date: string; project: string }
type Result = { draft?: string; evidence?: Evidence[]; candidates?: (Evidence | Case)[]; message?: string }

const SOURCE: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', interview: '이전 인터뷰' }

type Props =
  | { kind: 'criterion' | 'interview'; query: string; slot: string; current: string; onFill: (text: string) => void }
  | { kind: 'memory'; onPick: (text: string) => void }
  | { kind: 'case'; onPickCase: (question: string, expected: string) => void }

export default function AutoDraft(props: Props) {
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run() {
    setBusy(true); setError(''); setResult(null)
    try {
      const body = props.kind === 'criterion' || props.kind === 'interview'
        ? { kind: props.kind, query: props.query, slot: props.slot }
        : { kind: props.kind }
      const response = await fetch(API_BASE + '/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '요청 실패')
      setResult(data)
      if ((props.kind === 'criterion' || props.kind === 'interview') && data.draft) {
        if (!props.current.trim() || window.confirm('입력칸의 내용을 초안으로 바꿀까요?')) props.onFill(data.draft)
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  const label = props.kind === 'memory' ? '이전 기록에서 후보 찾기' : props.kind === 'case' ? '이전 대화에서 질문·답 가져오기' : '이전 기록으로 초안 채우기'
  return <div className="mt-2 text-sm">
    <button type="button" onClick={run} disabled={busy} className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-indigo-900 disabled:opacity-50">{busy ? '기록 살피는 중…' : label}</button>
    {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
    {result?.message && <p className="mt-1 text-xs text-gray-600">{result.message}</p>}
    {result?.evidence && result.evidence.length > 0 && <details className="mt-1 text-xs text-gray-600">
      <summary className="cursor-pointer">{result.draft ? '근거로 쓴' : '검토한'} 이전 기록 {result.evidence.length}건{result.draft ? ' (관련 없으면 초안을 고치거나 지우세요)' : ''}</summary>
      <ul className="mt-1 space-y-1">{result.evidence.map((item, index) => <li key={index} className="rounded bg-gray-50 p-1.5">{item.text}<span className="block text-gray-400">{item.date} · {SOURCE[item.source] || item.source}</span></li>)}</ul>
    </details>}
    {props.kind === 'memory' && !!result?.candidates?.length && <ul className="mt-1 space-y-1">{(result.candidates as Evidence[]).map((item, index) => <li key={index} className="flex items-start gap-2 rounded bg-gray-50 p-1.5">
      <span className="min-w-0 flex-1 break-words">{item.text}<span className="block text-xs text-gray-400">{item.date} · {SOURCE[item.source] || item.source} · {item.label}</span></span>
      <button type="button" onClick={() => props.onPick(item.text)} className="whitespace-nowrap rounded border border-gray-300 px-2 py-1 text-xs">입력칸에 넣기</button>
    </li>)}</ul>}
    {props.kind === 'case' && !!result?.candidates?.length && <ul className="mt-1 space-y-1">{(result.candidates as Case[]).map((item, index) => <li key={index} className="flex items-start gap-2 rounded bg-gray-50 p-1.5">
      <span className="min-w-0 flex-1 break-words"><strong>질문:</strong> {item.question}<span className="block"><strong>내 답:</strong> {item.expected}</span><span className="block text-xs text-gray-400">{item.date}</span></span>
      <button type="button" onClick={() => props.onPickCase(item.question, item.expected)} className="whitespace-nowrap rounded border border-gray-300 px-2 py-1 text-xs">입력칸에 넣기</button>
    </li>)}</ul>}
  </div>
}
