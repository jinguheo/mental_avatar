// 홍보 페이지 체험: 공개 자료로 만든 "글 전용" 유명인 아바타가 인사하고, 자기 전문 관점으로 이 서비스를 논평하고, 질문에 답한다.
// 원칙: 얼굴·목소리를 만들지 않고, 모든 답에 "AI가 만든 가상의 답, 실제 발언이 아님"을 붙이며, 근거(출처)를 보여 주고,
// 근거가 없으면 "기록에 없음"으로 답한다. 서버(core/persona_chat.py)가 꺼져 있으면 체험은 동작하지 않는다.
import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE } from '@/config'

type Person = { id: string; name: string; field: string; lens: string; greeting: string; suggestions: string[]; docs: number; state: 'ready' | 'building' | 'idle' | 'error'; error?: string | null }
type Source = { title: string; kind: string; tier: 'own' | 'reported'; url?: string | null; excerpt: string }
type Comment = { state: string; comment: string; sources: Source[]; grounded: boolean; lens: string }
type Turn = { q: string; a?: string; sources?: Source[]; grounded?: boolean; error?: string }

const TIER: Record<string, string> = { own: '본인이 쓴·말한 것', reported: '기록·전기에 적힌 것' }

async function call(path: string, body?: object) {
  const response = await fetch(API_BASE + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}

function Sources({ items }: { items: Source[] }) {
  if (!items.length) return null
  return <details className="mt-2 text-xs text-slate-600">
    <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-800">근거 자료 {items.length}건 보기</summary>
    <ul className="mt-2 space-y-2">{items.map((item, index) => <li key={index} className="rounded-lg bg-white/70 p-2">
      <p className="font-medium text-slate-800">{item.title} <span className={'ml-1 rounded px-1.5 py-0.5 text-[10px] ' + (item.tier === 'own' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800')}>{TIER[item.tier]}</span></p>
      <p className="mt-1 leading-5 text-slate-600">“{item.excerpt}…”</p>
      {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-indigo-700 underline">{item.url}</a>}
    </li>)}</ul>
  </details>
}

export default function PromoPersonaDemo() {
  const [people, setPeople] = useState<Person[]>([])
  const [offline, setOffline] = useState(false)
  const [who, setWho] = useState('')
  const [comment, setComment] = useState<Comment | null>(null)
  const [commentBusy, setCommentBusy] = useState(false)
  const [commentError, setCommentError] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const run = useRef(0)           // 인물을 바꾸면 이전 요청의 늦은 응답을 버린다
  const endRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try { const data = await call('/persona/chat/people'); setPeople(data.people); setOffline(false); return data.people as Person[] }
    catch { setOffline(true); return null }
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  const person = people.find(item => item.id === who)

  // 인물을 고르면 자료 인덱스를 준비시키고(큰 자료는 수십 초), 준비가 끝나면 그 사람의 관점으로 서비스를 논평한다.
  useEffect(() => {
    if (!who) return
    const id = ++run.current
    setComment(null); setCommentError(''); setTurns([]); setCommentBusy(true)
    void (async () => {
      try {
        await call('/persona/chat/' + who + '/warm', {})
        for (let i = 0; i < 90 && run.current === id; i += 1) {
          const list = await refresh()
          const current = list?.find(item => item.id === who)
          if (current?.state === 'ready') break
          if (current?.state === 'error') throw new Error(current.error || '자료를 읽지 못했습니다')
          await new Promise(resolve => window.setTimeout(resolve, 2000))
        }
        if (run.current !== id) return
        const result = await call('/persona/chat/' + who + '/comment', {}) as Comment
        if (run.current === id) setComment(result)
      } catch (cause) {
        if (run.current === id) setCommentError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (run.current === id) setCommentBusy(false)
      }
    })()
  }, [who, refresh])

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [turns])

  async function ask(text: string) {
    const q = text.trim()
    if (!q || !who || asking) return
    const id = run.current
    setAsking(true); setQuestion('')
    setTurns(previous => [...previous, { q }])
    try {
      const result = await call('/persona/chat/' + who + '/ask', { question: q })
      if (run.current !== id) return
      setTurns(previous => previous.map((turn, index) => index === previous.length - 1 ? { ...turn, a: result.answer, sources: result.sources, grounded: result.grounded } : turn))
    } catch (cause) {
      if (run.current === id) setTurns(previous => previous.map((turn, index) => index === previous.length - 1 ? { ...turn, error: cause instanceof Error ? cause.message : String(cause) } : turn))
    } finally { setAsking(false) }
  }

  return <section id="demo" className="bg-[#f3eee4] py-16">
    <div className="mx-auto max-w-6xl px-4 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">직접 체험</p>
      <h2 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">공개 자료로 만든 아바타와 이야기해 보세요</h2>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">누구를 고르면 그 사람이 인사하고, 자기 전문 분야의 관점으로 이 서비스를 논평하고, 질문에 답합니다. 얼굴과 목소리는 만들지 않고 글로만 답하며, 근거가 있는 답에만 출처를 붙입니다.</p>
      <p role="note" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-900">여기 나오는 모든 말은 <strong>AI가 공개 자료를 바탕으로 만든 가상의 답</strong>이며 해당 인물이 실제로 한 말이 아닙니다. 서비스 소개를 위한 연구용 체험이고, 자료에 없는 질문에는 지어내지 않고 “기록에 없음”이라고 답합니다.</p>

      {offline && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">체험 서버에 연결할 수 없습니다. 이 체험은 아바타 서버가 켜져 있을 때만 동작합니다.</p>}

      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="체험할 인물">
        {people.map(item => <button key={item.id} role="tab" aria-selected={who === item.id} onClick={() => setWho(item.id)}
          className={'flex items-center gap-2 rounded-full border px-3 py-2 text-left text-sm transition ' + (who === item.id ? 'border-slate-900 bg-slate-900 text-white' : 'border-stone-300 bg-white text-slate-700 hover:border-slate-500')}>
          <span className={'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ' + (who === item.id ? 'bg-amber-300 text-slate-900' : 'bg-stone-200 text-slate-700')} aria-hidden="true">{item.name.slice(0, 1)}</span>
          <span><span className="block font-medium leading-4">{item.name}</span><span className={'block text-[11px] leading-4 ' + (who === item.id ? 'text-slate-300' : 'text-slate-500')}>{item.field}</span></span>
        </button>)}
      </div>

      {person ? <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-medium text-slate-500">AI 인사말 · {person.name}의 공개 자료 {person.docs}건 기반</p>
            <p className="mt-2 text-sm leading-6 text-slate-800">{person.greeting}</p>
          </div>
          <div className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-5">
            <p className="text-xs font-semibold text-indigo-900">이 서비스를 {person.name}의 관점({person.lens})으로 본다면</p>
            {commentBusy && <p className="mt-3 text-sm text-slate-600" role="status">{person.state === 'ready' ? '논평을 만드는 중…' : '자료를 읽는 중입니다(처음에는 수십 초 걸릴 수 있습니다)…'}</p>}
            {commentError && <p className="mt-3 text-sm text-rose-700" role="alert">{commentError}</p>}
            {comment && <>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-800">{comment.comment}</p>
              <p className="mt-2 text-[11px] leading-4 text-indigo-900/80">{comment.grounded ? `${person.lens} 관련 자료를 이 서비스에 적용해 AI가 만든 가상의 논평입니다. ${person.name}이 이 서비스에 대해 실제로 한 말이 아닙니다.` : '이 관점에서 서비스와 연결할 만한 기록을 찾지 못했습니다.'}</p>
              <Sources items={comment.sources} />
            </>}
          </div>
        </div>

        <div className="flex min-h-[22rem] flex-col rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-medium text-slate-500">{person.name}에게 물어보기</p>
          <div className="mt-3 flex-1 space-y-3 overflow-y-auto pr-1" aria-live="polite">
            {turns.length === 0 && <div className="flex flex-wrap gap-2">{person.suggestions.map(text => <button key={text} onClick={() => void ask(text)} disabled={asking || person.state !== 'ready'} className="rounded-full border border-stone-300 bg-stone-50 px-3 py-1.5 text-xs text-slate-700 hover:border-slate-500 disabled:opacity-50">{text}</button>)}</div>}
            {turns.map((turn, index) => <div key={index} className="space-y-2">
              <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-slate-900 px-4 py-2 text-sm text-white">{turn.q}</p>
              {turn.a === undefined && !turn.error && <p className="text-xs text-slate-500" role="status">자료를 찾아 답을 만드는 중…</p>}
              {turn.error && <p className="text-xs text-rose-700" role="alert">{turn.error}</p>}
              {turn.a !== undefined && <div className={'max-w-[92%] rounded-2xl rounded-bl-sm px-4 py-3 text-sm leading-6 ' + (turn.grounded ? 'bg-amber-50 text-slate-800' : 'bg-stone-100 text-slate-700')}>
                <p className="whitespace-pre-wrap">{turn.a}</p>
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className={'rounded px-1.5 py-0.5 ' + (turn.grounded ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-300 text-slate-800')}>{turn.grounded ? `근거 있음 · 출처 ${turn.sources?.length ?? 0}건` : '기록에 없음'}</span>
                  <span className="text-slate-500">AI가 만든 가상의 답 · 실제 발언 아님</span>
                </p>
                {turn.sources && <Sources items={turn.sources} />}
              </div>}
            </div>)}
            <div ref={endRef} />
          </div>
          <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void ask(question) }}>
            <input value={question} onChange={event => setQuestion(event.target.value)} maxLength={300} aria-label={person.name + '에게 할 질문'} placeholder={person.state === 'ready' ? '궁금한 것을 물어보세요' : '자료를 읽는 중입니다…'} disabled={asking || person.state !== 'ready'} className="min-w-0 flex-1 rounded-full border border-stone-300 px-4 py-2 text-sm disabled:bg-stone-100" />
            <button type="submit" disabled={asking || !question.trim() || person.state !== 'ready'} className="rounded-full bg-slate-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40">{asking ? '…' : '보내기'}</button>
          </form>
        </div>
      </div> : !offline && <p className="mt-6 text-sm text-slate-500">위에서 인물을 고르면 인사와 논평이 시작됩니다.</p>}
    </div>
  </section>
}
