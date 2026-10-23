import { useState } from 'react'
import { API_BASE } from '@/config'

// 이전 기록(대화·인터뷰 답)을 살펴 입력칸 초안을 만든다. 저장은 하지 않고, 읽고 고친 뒤 사용자가 저장해야 반영된다.
type Evidence = { text: string; date: string; source: string; label: string | null; project: string; key?: string; why?: string[] }
type Case = { question: string; expected: string; date: string; project: string }
type Result = { draft?: string; evidence?: Evidence[]; candidates?: (Evidence | Case)[]; message?: string }

const SOURCE: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', interview: '이전 인터뷰' }

type Props =
  | { kind: 'criterion' | 'interview'; query: string; slot: string; current: string; onFill: (text: string) => void }
  | { kind: 'memory'; onPick: (text: string) => void; onSaved?: () => void }
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

  // 상시 기억 후보: 바로 저장(출처·원래 말한 시각 기록)하거나 후보에서 뺀다. 처리한 후보는 목록에서 지운다.
  async function decide(item: Evidence, action: 'pinned' | 'normal' | 'dismiss') {
    setError('')
    try {
      const response = action === 'dismiss'
        ? await fetch(API_BASE + '/memory/candidates/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: item.text }) })
        : await fetch(API_BASE + '/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          content: item.text, is_pinned: action === 'pinned', source_kind: 'transcript',
          source_ref: (SOURCE[item.source] || item.source) + ' 대화 · ' + item.date + (item.key ? ' · ' + item.key : ''), observed_at: item.date }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '요청 실패')
      setResult(previous => previous && { ...previous, candidates: (previous.candidates as Evidence[]).filter(candidate => candidate.text !== item.text),
        message: action === 'dismiss' ? '후보에서 뺐습니다. 다시 제안하지 않습니다.' : (action === 'pinned' ? '고정 기억으로 저장했습니다. 다음 답변부터 항상 참고합니다.' : '일반 기억으로 저장했습니다. 질문과 관련될 때 참고하고, 오래 안 쓰면 요약·보관으로 내려갑니다.') })
      if (action !== 'dismiss' && props.kind === 'memory') props.onSaved?.()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
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
      <span className="min-w-0 flex-1 break-words">{item.text}<span className="block text-xs text-gray-400">{item.date} · {SOURCE[item.source] || item.source} · {item.label}{item.why?.length ? ' · ' + item.why.join(', ') : ''}</span></span>
      <span className="flex shrink-0 flex-col gap-1">
        <button type="button" onClick={() => void decide(item, 'pinned')} className="whitespace-nowrap rounded bg-gray-950 px-2 py-1 text-xs text-white">고정 기억으로 저장</button>
        <button type="button" onClick={() => void decide(item, 'normal')} className="whitespace-nowrap rounded border border-gray-300 px-2 py-1 text-xs">일반 기억으로 저장</button>
        <button type="button" onClick={() => props.onPick(item.text)} className="whitespace-nowrap rounded border border-gray-300 px-2 py-1 text-xs">입력칸에 넣기</button>
        <button type="button" onClick={() => void decide(item, 'dismiss')} className="whitespace-nowrap rounded px-2 py-1 text-xs text-gray-500 underline">후보에서 빼기</button>
      </span>
    </li>)}</ul>}
    {props.kind === 'case' && !!result?.candidates?.length && <ul className="mt-1 space-y-1">{(result.candidates as Case[]).map((item, index) => <li key={index} className="flex items-start gap-2 rounded bg-gray-50 p-1.5">
      <span className="min-w-0 flex-1 break-words"><strong>질문:</strong> {item.question}<span className="block"><strong>내 답:</strong> {item.expected}</span><span className="block text-xs text-gray-400">{item.date}</span></span>
      <button type="button" onClick={() => props.onPickCase(item.question, item.expected)} className="whitespace-nowrap rounded border border-gray-300 px-2 py-1 text-xs">입력칸에 넣기</button>
    </li>)}</ul>}
  </div>
}
