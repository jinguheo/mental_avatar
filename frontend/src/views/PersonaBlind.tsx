// 이름을 가린 인물 식별 평가 화면 (논문 12절 E1).
// 평가자는 답만 보고 "누구의 답 같은가"를 고른다. 정답은 서버만 가지고 있어 화면에는 내려오지 않는다.
// 모델 평가자(사전 점검)의 결과도 같이 보이지만 사람 평가가 아니므로 평가자 종류를 항상 표시한다.
import { useEffect, useState } from 'react'
import { API_BASE } from '@/config'

type SetInfo = { id: string; created_at: string; persons: string[]; items: number; ratings: number }
type Item = { id: string; question: string; answer: string }
type SetData = { meta: { id: string; candidates: string[]; chance: number | null; note: string; no_record: { person: string; condition: string }[] }; items: Item[] }
type Cond = { n: number; correct: number; accuracy: number | null; ci95: (number | null)[]; p_vs_chance: number | null; by_person: Record<string, { n: number; correct: number }> }
type Rater = { ratings: number; unreadable: number; conditions: Record<string, Cond> }
type Results = { chance: number; raters: Record<string, Rater>; note: string }

const RATER_KEY = 'persona-blind-rater'
const COND_LABEL: Record<string, string> = { B1: 'B1 수집 자료 기반 페르소나', B0: 'B0 이름만 준 일반 LLM(대조군)' }

async function get(path: string) {
  const response = await fetch(API_BASE + path)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}

function pct(value: number | null | undefined) { return value == null ? '-' : Math.round(value * 100) + '%' }

export default function PersonaBlind() {
  const [sets, setSets] = useState<SetInfo[]>([])
  const [setId, setSetId] = useState('')
  const [data, setData] = useState<SetData | null>(null)
  const [results, setResults] = useState<Results | null>(null)
  const [rater, setRater] = useState(() => { try { return localStorage.getItem(RATER_KEY) || '' } catch { return '' } })
  const [done, setDone] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    get('/persona/blind/sets').then(r => { setSets(r.sets); if (r.sets[0]) setSetId(r.sets[0].id) }).catch(e => setMessage(String(e.message || e)))
  }, [])
  useEffect(() => {
    if (!setId) return
    setData(null); setResults(null); setDone(new Set())
    get('/persona/blind/' + setId).then(setData).catch(e => setMessage(String(e.message || e)))
    get('/persona/blind/' + setId + '/results').then(setResults).catch(() => undefined)
  }, [setId])

  const next = data?.items.find(item => !done.has(item.id))
  const total = data?.items.length ?? 0

  async function choose(guess: string) {
    if (!next || !rater.trim()) { setMessage('평가자 이름을 먼저 입력해 주세요.'); return }
    setBusy(true)
    try {
      try { localStorage.setItem(RATER_KEY, rater.trim()) } catch { /* 저장 못 해도 평가는 계속 */ }
      const response = await fetch(API_BASE + '/persona/blind/' + setId + '/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: next.id, guess, rater: rater.trim() }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || '저장하지 못했습니다')
      setDone(previous => new Set(previous).add(next.id)); setMessage('')
      get('/persona/blind/' + setId + '/results').then(setResults).catch(() => undefined)
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  if (!sets.length) return <div className="p-4 text-sm text-slate-600">아직 평가 세트가 없습니다. <code>python scripts/run_blind_eval.py</code>로 만들 수 있습니다. {message}</div>

  return (
    <div className="mx-auto max-w-3xl space-y-4 overflow-y-auto p-4">
      <header>
        <h2 className="text-lg font-semibold">이름을 가린 인물 식별</h2>
        <p className="mt-1 text-xs leading-5 text-slate-600">이름을 알려 주지 않고, 답만 보고 어느 인물의 답 같은지 고릅니다. 후보는 {data?.meta.candidates.length ?? '?'}명이라 아무렇게나 골라도 {pct(data?.meta.chance)} 정도 맞습니다. 로컬 모델 평가자 결과는 사전 점검용이며 사람 평가가 아닙니다.</p>
      </header>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={setId} onChange={event => setSetId(event.target.value)} className="rounded border px-2 py-1">
          {sets.map(item => <option key={item.id} value={item.id}>{item.id} · 문항 {item.items} · 평가 {item.ratings}</option>)}
        </select>
        <input value={rater} onChange={event => setRater(event.target.value)} placeholder="평가자 이름" className="rounded border px-2 py-1" />
        <span className="text-xs text-slate-500">내 진행 {done.size}/{total}</span>
      </div>
      {message && <p className="text-sm text-rose-700">{message}</p>}
      {data && next && (
        <section className="rounded-xl border bg-white p-4">
          <p className="text-xs text-slate-500">질문</p>
          <p className="text-sm font-medium">{next.question}</p>
          <p className="mt-3 text-xs text-slate-500">답 (이름은 ○○로 가렸습니다)</p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{next.answer}</p>
          <p className="mt-4 text-xs text-slate-500">누구의 답 같습니까?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.meta.candidates.map(name => <button key={name} disabled={busy} onClick={() => choose(name)} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50">{name}</button>)}
          </div>
        </section>
      )}
      {data && !next && <p className="rounded-xl border bg-emerald-50 p-4 text-sm text-emerald-800">이 세트의 문항을 모두 평가했습니다.</p>}
      {data && data.meta.no_record.length > 0 && <p className="text-xs text-slate-500">자료에서 답을 찾지 못해(또는 생성 실패로) 제외된 응답 {data.meta.no_record.length}건은 평가 문항에 없습니다. 인물별 “기록 없음” 비율은 별도로 봐야 합니다.</p>}
      {results && Object.keys(results.raters).length > 0 && (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">결과 (우연 수준 {pct(results.chance)})</h3>
          {Object.entries(results.raters).map(([name, rater]) => (
            <div key={name} className="rounded-xl border bg-white p-3 text-xs">
              <p className="font-medium">{name} · 평가 {rater.ratings}건{rater.unreadable ? ` · 판독 불가 ${rater.unreadable}` : ''}</p>
              <table className="mt-2 w-full">
                <thead><tr className="text-left text-slate-500"><th>조건</th><th>맞힘/문항</th><th>정확도(95% 구간)</th><th>우연 대비 p</th></tr></thead>
                <tbody>{Object.entries(rater.conditions).map(([cond, v]) => (
                  <tr key={cond} className="border-t"><td className="py-1 pr-2">{COND_LABEL[cond] || cond}</td><td>{v.correct}/{v.n}</td><td>{pct(v.accuracy)} ({pct(v.ci95[0])}~{pct(v.ci95[1])})</td><td>{v.p_vs_chance ?? '-'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          ))}
          <p className="text-xs text-slate-500">{results.note} B1이 B0보다 높아야 수집한 자료가 “그 사람다움”에 기여했다고 말할 수 있습니다.</p>
        </section>
      )}
    </div>
  )
}
