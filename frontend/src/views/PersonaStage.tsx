import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '@/config'

type Person = { id: string; name: string; field: string; greeting: string; suggestions: string[]; docs: number; state: 'ready' | 'building' | 'idle' | 'error'; error?: string | null }
type Source = { title: string; kind: string; tier: 'own' | 'reported'; url?: string | null; excerpt: string }
type Turn = { question: string; answer?: string; sources?: Source[]; grounded?: boolean; error?: string; feedback?: string }
type Visual = { ready: boolean; generic_presenter?: boolean; disclaimer?: string; frames?: { label: string; url: string }[] }

async function call(path: string, body?: object) {
  const response = await fetch(API_BASE + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}

function Sources({ items }: { items: Source[] }) {
  return <details className="mt-2 text-xs text-slate-600"><summary className="cursor-pointer text-slate-500">근거 {items.length}건</summary>
    <div className="mt-2 space-y-2">{items.map((item, index) => <article key={index} className="rounded-lg bg-white/80 p-2"><strong>{item.title}</strong><p className="mt-1 leading-5">{item.excerpt}</p>{item.url && <a className="mt-1 block break-all text-indigo-700 underline" href={item.url} target="_blank" rel="noreferrer">원문</a>}</article>)}</div>
  </details>
}

export default function PersonaStage() {
  const [people, setPeople] = useState<Person[]>([])
  const [who, setWho] = useState('buffett')
  const [visual, setVisual] = useState<Visual | null>(null)
  const [frame, setFrame] = useState(0)
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [feedbackFor, setFeedbackFor] = useState<number | null>(null)
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const person = people.find(item => item.id === who)

  useEffect(() => { void call('/persona/chat/people').then(data => setPeople(data.people || [])).catch(cause => setError(String(cause.message || cause))) }, [])
  useEffect(() => {
    if (!who) return
    setTurns([]); setFrame(0); setError(''); setReady(false)
    void call('/persona/visuals/' + who).then(setVisual).catch(cause => setError(String(cause.message || cause)))
    void (async () => {
      try {
        await call('/persona/chat/' + who + '/warm', {})
        for (let i = 0; i < 45; i += 1) {
          const data = await call('/persona/chat/people')
          const state = (data.people || []).find((item: Person) => item.id === who)?.state
          if (state === 'ready') { setReady(true); return }
          if (state === 'error') throw new Error('자료 색인을 준비하지 못했습니다.')
          await new Promise(resolve => window.setTimeout(resolve, 1200))
        }
        throw new Error('자료 색인 준비 시간이 초과되었습니다.')
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    })()
  }, [who])
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [turns])

  async function ask(value: string) {
    const q = value.trim()
    if (!q || busy || !ready) return
    setBusy(true); setQuestion(''); setTurns(previous => [...previous, { question: q }])
    try {
      const result = await call('/persona/chat/' + who + '/ask', { question: q })
      setTurns(previous => previous.map((item, index) => index === previous.length - 1 ? { ...item, answer: result.answer, sources: result.sources, grounded: result.grounded } : item))
      if (result.answer && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel()
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(result.answer))
      }
    } catch (cause) { setTurns(previous => previous.map((item, index) => index === previous.length - 1 ? { ...item, error: cause instanceof Error ? cause.message : String(cause) } : item)) }
    finally { setBusy(false) }
  }
  async function sendFeedback(index: number, verdict: 'confirmed' | 'corrected') {
    const turn = turns[index]
    if (!turn.answer || (verdict === 'corrected' && !feedbackText.trim())) return
    setFeedbackBusy(true)
    try {
      await call('/persona/qbank/conversation_feedback/' + who, { question: turn.question, answer: turn.answer, verdict, text: feedbackText, reviewer: '대화 사용자', relation: '대화 후 피드백' })
      setFeedbackFor(null); setFeedbackText('')
      setTurns(previous => previous.map((item, i) => i === index ? { ...item, feedback: verdict === 'confirmed' ? '이 답이 적절하다고 확인해 프로필 검토 근거에 저장했습니다.' : '수정 의견을 프로필 검토 근거에 저장했습니다.' } : item))
    } catch (cause) { setTurns(previous => previous.map((item, i) => i === index ? { ...item, feedback: cause instanceof Error ? cause.message : String(cause) } : item)) }
    finally { setFeedbackBusy(false) }
  }

  const image = visual?.frames?.[frame]
  const feedbackGuide = (index: number) => [
    '이 사람이 실제로 자주 보였던 판단 방식과 닮았는지 떠올려 보세요.',
    '말투보다도, 이 사람이 중요하게 여겼을 가치나 선택 기준이 맞는지 살펴보세요.',
    '기억나는 실제 사례가 있다면 한 문장만 보태 주세요. 다음 대화의 검토 근거가 됩니다.'
  ][index % 3]
  return <div className="view-canvas h-full overflow-y-auto"><div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
    <header className="view-header -mx-4 -mt-5 border-x-0 px-4 py-4 sm:-mx-6 sm:px-6"><p className="dashboard-kicker">2D 기반 가상 3D · 근거 기반 대화</p><h1 className="mt-1 text-xl font-semibold text-gray-950">그대로</h1><p className="mt-1 text-sm text-gray-600">인물을 고르면 자료·성향·지식 DB를 가진 가상 진행자가 나타납니다. 실제 인물의 얼굴·음성 복제가 아닌 2D 기반의 비식별 3D 표현입니다.</p></header>
    <div className="flex flex-wrap gap-2">{people.map(item => <button key={item.id} onClick={() => setWho(item.id)} className={'rounded-full border px-3 py-1.5 text-sm ' + (who === item.id ? 'border-indigo-700 bg-indigo-700 text-white' : 'border-gray-300 bg-white text-gray-700')}><strong>{item.name}</strong><span className="ml-1 text-xs opacity-75">{item.field}</span></button>)}</div>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,.9fr)]">
      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[radial-gradient(circle_at_50%_20%,#334155_0%,#0f172a_55%,#020617_100%)] p-4 shadow-xl">
        <div className="flex items-center justify-between text-xs text-slate-200"><span>{person?.name || who} · 가상 3D 스테이지</span><span>{image?.label || '준비 중'}</span></div>
        <div className="relative mx-auto mt-3 flex aspect-[4/5] max-h-[34rem] max-w-md items-end justify-center overflow-hidden [perspective:1100px]">
          <div className="absolute bottom-4 h-10 w-3/4 rounded-[50%] bg-black/50 blur-xl" />
          {image ? <img src={API_BASE + image.url} alt={person?.name + ' 가상 3D 모습'} className="relative h-[94%] max-w-[94%] rounded-2xl object-cover shadow-2xl transition-transform duration-700 hover:[transform:rotateY(-8deg)_rotateX(2deg)_translateY(-6px)] [transform:rotateY(4deg)_rotateX(1deg)]" /> : <p className="text-sm text-slate-300">시각자료를 준비하는 중입니다.</p>}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-slate-950/90 to-transparent p-4 pt-12"><p className="text-sm font-semibold text-white">{person?.field}</p><p className="mt-1 text-xs text-slate-300">질문에 답할 때 인물별 지식·성향·확인 근거를 함께 참조합니다.</p></div>
        </div>
        <div className="mt-3 grid grid-cols-5 gap-1.5">{visual?.frames?.map((item, index) => <button key={item.url} onClick={() => setFrame(index)} className={'overflow-hidden rounded border ' + (frame === index ? 'border-indigo-300 ring-2 ring-indigo-300' : 'border-slate-600')}><img src={API_BASE + item.url} alt={item.label} className="aspect-[3/4] w-full object-cover" /></button>)}</div>
        <p className="mt-3 text-xs text-slate-300">{visual?.disclaimer || '공개 자료를 바탕으로 한 가상 표현입니다.'}</p>
      </section>
      <section className="flex min-h-[38rem] flex-col rounded-2xl border border-gray-200 bg-white p-4 shadow-sm"><div><p className="text-sm font-semibold text-gray-900">{person?.name || '인물'}에게 질문</p><p className="mt-1 text-xs text-gray-500">{ready ? '지식 DB와 원문 자료를 준비했습니다.' : '인물별 자료 색인을 준비하는 중입니다…'}</p></div>
        <div className="mt-4 flex-1 space-y-3 overflow-y-auto" aria-live="polite">{turns.length === 0 && <div className="flex flex-wrap gap-2">{person?.suggestions.map(item => <button key={item} disabled={!ready || busy} onClick={() => void ask(item)} className="rounded-full border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-40">{item}</button>)}</div>}
          {turns.map((turn, index) => <div key={index}><p className="ml-auto w-fit max-w-[90%] rounded-2xl rounded-br-sm bg-slate-900 px-3 py-2 text-sm text-white">{turn.question}</p>{turn.answer === undefined && !turn.error && <p className="mt-2 text-xs text-gray-500">자료를 찾아 답하는 중…</p>}{turn.error && <p className="mt-2 text-sm text-red-700">{turn.error}</p>}{turn.answer && <div className="mt-2 rounded-2xl rounded-bl-sm bg-indigo-50 p-3 text-sm leading-6 text-slate-800"><p>{turn.answer}</p><p className="mt-2 text-[11px] text-slate-500">{turn.grounded ? '원문 근거를 찾은 AI 가상 답변' : '기록에 없는 내용 — 답변 보류'}</p>{turn.sources && <Sources items={turn.sources} />}<div className="mt-3 border-t border-indigo-100 pt-2 text-xs"><p className="font-medium text-slate-700">{feedbackGuide(index)}</p><p className="mt-1 text-slate-600">이 답변은 그 사람답게 들렸나요?</p><div className="mt-1 flex gap-2"><button onClick={() => void sendFeedback(index, 'confirmed')} disabled={feedbackBusy} className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-800">이 사람답습니다</button><button onClick={() => setFeedbackFor(feedbackFor === index ? null : index)} className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">실제와 달라요</button></div>{feedbackFor === index && <div className="mt-2 space-y-1"><p className="text-slate-600">어떤 선택·말투·가치가 달랐나요? 기억나는 사례를 짧게 남겨 주세요.</p><div className="flex gap-1"><input value={feedbackText} onChange={event => setFeedbackText(event.target.value)} placeholder="예: 이 사람은 성과보다 동료의 안전을 먼저 말했어요" className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1" /><button onClick={() => void sendFeedback(index, 'corrected')} disabled={feedbackBusy || !feedbackText.trim()} className="rounded bg-violet-700 px-2 py-1 text-white disabled:opacity-40">검토에 반영</button></div></div>}{turn.feedback && <p className="mt-1 text-[11px] text-violet-800">{turn.feedback}</p>}</div></div>}</div>)}<div ref={end} /></div>
        <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void ask(question) }}><input value={question} onChange={event => setQuestion(event.target.value)} disabled={!ready || busy} placeholder={ready ? '질문을 입력하세요' : '자료를 읽는 중입니다…'} className="min-w-0 flex-1 rounded-full border border-gray-300 px-4 py-2 text-sm disabled:bg-gray-100" /><button disabled={!ready || busy || !question.trim()} className="rounded-full bg-indigo-700 px-4 py-2 text-sm text-white disabled:opacity-40">{busy ? '답변 중' : '질문'}</button></form>
      </section>
    </div>
  </div></div>
}
