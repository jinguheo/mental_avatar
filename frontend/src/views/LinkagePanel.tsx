import { useEffect, useRef, useState } from 'react'
import { API_BASE } from '@/config'

type Item = Record<string, unknown>
type Probe = { n: number; k: number; verdict: string; p_value?: number; chance?: number; items: Item[]
  follow_plus?: number; follow_minus?: number; invalid?: number; base?: { x: number; y: number; invalid: number } }
type Result = { model: string; probes: { propagation: Probe; honesty: Probe; invariance: Probe } }
type Latest = { id: string; created_at: string; result: Result } | Record<string, never>
type Job = { status: 'running' | 'done' | 'error'; progress: number; message: string; result?: Result }

const DILEMMA_NAME: Record<string, string> = { speed_cost: '속도↔비용', safe_novel: '안전↔새로움', accuracy_schedule: '정확↔일정', solo_team: '혼자↔팀' }
const CHOICE: Record<string, string> = { x: '선택지 1', y: '선택지 2' }

// 아직 만들지 않은 연결 검사 — 내 실제 기준·사실이 채워져야 의미가 있다.
const PENDING = [
  { name: '제거(ablation)', how: '내 실제 가치·신념 진술 하나를 빼고 같은 질문을 했을 때 그 입장이 사라지는지 본다. 안 사라지면 그 진술이 아니라 모델 기본값으로 답한 것이다.', need: '내가 정한 기준이 채워져 있어야 함' },
  { name: '근거 추적', how: '답에서 나에 대한 주장마다 근거 출처가 있는지 확인한다(Rashkin et al., Computational Linguistics 49(4), 2023의 귀속 평가 아이디어; 서지는 기억 기준이라 재확인 필요).', need: '주장 단위 판정 모델이 필요함' },
  { name: '사실 회수', how: '기본 정보와 핵심 기억에서 질문을 자동 생성해 아바타가 맞히는지 본다.', need: '기본 정보·핵심 기억이 채워져 있어야 함' },
]

function pText(p?: number) {
  if (p === undefined) return ''
  return p < 0.001 ? 'p<0.001' : 'p=' + p.toFixed(3)
}

function Verdict({ verdict, good, labels }: { verdict: string; good: string; labels: Record<string, string> }) {
  const cls = verdict === good ? 'bg-green-100 text-green-800' : verdict === 'invalid' ? 'bg-gray-200 text-gray-700' : 'bg-amber-100 text-amber-800'
  return <span className={'whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ' + cls}>{verdict === 'invalid' ? '측정 실패' : labels[verdict] || verdict}</span>
}

export default function LinkagePanel() {
  const [latest, setLatest] = useState<Latest>({})
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const timer = useRef<number | null>(null)

  async function loadLatest() {
    try { setLatest(await (await fetch(API_BASE + '/linkage/latest')).json()) } catch { /* 서버가 꺼져 있으면 이전 결과 없음으로 표시 */ }
  }
  useEffect(() => { void loadLatest(); return () => { if (timer.current) window.clearInterval(timer.current) } }, [])

  async function run() {
    setError('')
    const response = await fetch(API_BASE + '/linkage/run', { method: 'POST' })
    const data = await response.json()
    if (!response.ok) { setError(data.error || '검사를 시작하지 못했습니다.'); return }
    setJob({ status: 'running', progress: 0, message: '시작' })
    timer.current = window.setInterval(async () => {
      try {
        const status: Job = await (await fetch(API_BASE + '/linkage/status/' + data.job_id)).json()
        setJob(status)
        if (status.status !== 'running') {
          if (timer.current) window.clearInterval(timer.current)
          if (status.status === 'done') await loadLatest()
          else setError(status.message)
        }
      } catch { /* 다음 주기에 재시도 */ }
    }, 1500)
  }

  const result = ('result' in latest ? latest.result : null) as Result | null
  const running = job?.status === 'running'
  const prop = result?.probes.propagation
  const honesty = result?.probes.honesty
  const inv = result?.probes.invariance

  return <section className="view-panel p-4 sm:p-5">
    <h2 className="text-lg font-semibold">6. 연결 검사 (자동 실험)</h2>
    <p className="mt-1 text-sm text-gray-600">용어를 나눕니다. <strong>기초 지식</strong>은 내가 입력한 것, <strong>연결</strong>은 그것이 아바타의 답을 실제로 바꾸는지, <strong>일치(sync)</strong>는 그 답이 내 답과 같은지입니다. 이 검사는 쌓인 답변이나 입력량에서 추정하지 않고, 기준을 일부러 바꿔서 답이 따라 바뀌는지만 봅니다(반사실적 의존: Lewis 1973, Woodward 2003). 연결이 확인돼도 일치를 뜻하지 않으며, 결과는 위 준비도에 섞지 않습니다.</p>
    <p className="mt-1 text-xs text-gray-500">내 실제 정보가 아니라 합성 상황으로 실험하고 데이터는 바꾸지 않습니다. 서버의 로컬 LLM으로 측정하므로 실제 대화에 쓰는 모델과 다를 수 있습니다. 선택은 글자(A/B) 파싱과 이항검정으로 판정해 LLM 판정자의 편향이 없습니다.</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button onClick={run} disabled={running} className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{running ? '검사 중…' : '연결 검사 실행'}</button>
      {running && <span className="text-sm text-gray-600">{job?.progress}% · {job?.message}</span>}
      {!running && 'created_at' in latest && <span className="text-xs text-gray-500">마지막 실행 {latest.created_at} · 모델 {result?.model}</span>}
    </div>
    {error && <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {running && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200"><div className="h-full bg-indigo-500" style={{ width: (job?.progress || 0) + '%' }} /></div>}
    {!result && !running && <p className="mt-3 text-sm text-gray-500">아직 실행한 적이 없습니다. 약 1~3분 걸립니다.</p>}

    {result && prop && honesty && inv && <div className="mt-4 grid gap-3 lg:grid-cols-3">
      <article className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
        <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">① 갱신 전파</h3><Verdict verdict={prop.verdict} good="linked" labels={{ linked: '연결 확인', weak: '연결 약함' }} /></div>
        <p className="mt-1 text-xs text-gray-500">기준을 반대로 바꾸면 같은 상황의 선택도 따라 반대로 바뀌는가</p>
        <p className="mt-2 text-gray-800"><strong>{prop.k}/{prop.n}</strong> 상황에서 두 기준 모두 따라 바뀜 (우연 {Math.round((prop.chance || 0) * 100)}% 대비 {pText(prop.p_value)})</p>
        <p className="mt-1 text-xs text-gray-600">기준 1 따름 {prop.follow_plus}/{prop.n} · 기준 2 따름 {prop.follow_minus}/{prop.n} · 판독 불가 {prop.invalid}건 · 기준 없을 때 기본 성향: 선택지 1 {prop.base?.x}, 선택지 2 {prop.base?.y}</p>
        <details className="mt-2 text-xs text-gray-600"><summary className="cursor-pointer">상황별 결과</summary>
          <ul className="mt-1 space-y-0.5">{prop.items.map((row, index) => <li key={index}>{DILEMMA_NAME[String(row.dilemma)]} ({row.order === 'normal' ? '정순' : '역순'}): 기준 없음 {CHOICE[String(row.base)] || '-'} · 기준1 {CHOICE[String(row.plus)] || '-'} · 기준2 {CHOICE[String(row.minus)] || '-'}</li>)}</ul>
        </details>
      </article>
      <article className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
        <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">② 모름의 정직성</h3><Verdict verdict={honesty.verdict} good="honest" labels={{ honest: '정직', fabricates: '지어낼 위험' }} /></div>
        <p className="mt-1 text-xs text-gray-500">알 수 없는 개인 정보를 지어내지 않고 모른다고 하는가(검색을 켠 실제 경로)</p>
        <p className="mt-2 text-gray-800"><strong>{honesty.k}/{honesty.n}</strong> 질문에서 모른다고 답함</p>
        <p className="mt-1 text-xs text-gray-600">모름 표현은 문구 규칙으로 판정하므로 아래 실제 답을 직접 확인하세요. 모든 질문을 일괄 거부하는 모델도 통과하는 약한 검사라서, 입력한 사실을 맞히는 ‘사실 회수’(아래 입력 필요)와 함께 읽어야 합니다. 해당 정보를 실제로 입력했다면 그 질문은 제외해야 합니다.</p>
        <details className="mt-2 text-xs text-gray-600"><summary className="cursor-pointer">질문과 실제 답</summary>
          <ul className="mt-1 space-y-1.5">{honesty.items.map((row, index) => <li key={index}><span className={row.abstained ? 'text-green-700' : 'text-red-700'}>{row.abstained ? '모름' : '지어냄?'}</span> · {String(row.q)}<br /><span className="text-gray-500">{String(row.answer)}</span></li>)}</ul>
        </details>
      </article>
      <article className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
        <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">③ 표현 불변성</h3><Verdict verdict={inv.verdict} good="stable" labels={{ stable: '안정', unstable: '불안정' }} /></div>
        <p className="mt-1 text-xs text-gray-500">기준을 고정하고 질문 표현만 바꿔도 같은 선택을 하는가</p>
        <p className="mt-2 text-gray-800"><strong>{inv.k}/{inv.n}</strong> 상황에서 세 표현 모두 같은 선택 (우연 {Math.round((inv.chance || 0) * 100)}% 대비 {pText(inv.p_value)})</p>
        <p className="mt-1 text-xs text-gray-600">항상 같은 글자만 고르는 편향이 있으면 안정으로 보이므로 ①과 함께 읽어야 합니다. 정순·역순을 모두 넣어 그 편향을 상쇄합니다.</p>
        <details className="mt-2 text-xs text-gray-600"><summary className="cursor-pointer">상황별 결과</summary>
          <ul className="mt-1 space-y-0.5">{inv.items.map((row, index) => <li key={index}>{DILEMMA_NAME[String(row.dilemma)]} ({row.order === 'normal' ? '정순' : '역순'}): {(row.choices as (string | null)[]).map(choice => CHOICE[String(choice)] || '-').join(' / ')} {row.consistent ? '✔' : '✘'}</li>)}</ul>
        </details>
      </article>
    </div>}

    <h3 className="mt-5 font-semibold">아직 없는 연결 검사</h3>
    <div className="mt-2 grid gap-3 lg:grid-cols-3">
      {PENDING.map(item => <article key={item.name} className="rounded-lg border border-dashed border-gray-300 p-3 text-sm">
        <div className="flex items-center justify-between gap-2"><h4 className="font-semibold text-gray-800">{item.name}</h4><span className="rounded bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">입력 필요</span></div>
        <p className="mt-1 text-gray-700">{item.how}</p>
        <p className="mt-1 text-xs text-gray-500">{item.need}</p>
      </article>)}
    </div>
  </section>
}
