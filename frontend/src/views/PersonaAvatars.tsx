import { useEffect, useState } from 'react'
import { API_BASE } from '@/config'

// 유명인 아바타 시험 — 일대기·발언이 잘 알려진 인물의 아바타를 만들어, 그 사람이 실제로 한 답과 비교한다.
// 목적: 정답이 공개되어 있는 사람으로 "내 아바타 구조"가 얼마나 본인과 일치하는지 처음으로 수치로 재 본다.
type Kind = { docs: number; chars: number }
type Person = { id: string; name: string; docs: number; chars: number; by_kind: Record<string, Kind>; qa_total: number; qa_build: number; qa_test: number }
type Status = { people: Person[]; root: string }

const KIND: Record<string, string> = { primary: '본인 글·연설·편지', interview: '인터뷰·질의응답', quotes: '출처 확인된 발언', lecture: '강의·강연', bio: '전기·백과' }
const VERDICT: Record<string, { text: string; cls: string }> = {
  buffett: { text: '충분', cls: 'bg-green-100 text-green-800' },
  einstein: { text: '부족(질문-답 거의 없음)', cls: 'bg-amber-100 text-amber-800' },
  feynman: { text: '부족(대표 인터뷰 전문 접근 불가)', cls: 'bg-amber-100 text-amber-800' },
  jobs: { text: '부족(인터뷰 전문 접근 불가)', cls: 'bg-amber-100 text-amber-800' },
  songhae: { text: '검토 중(한국어 기사 14건, 질의응답 형식은 적음)', cls: 'bg-blue-100 text-blue-800' },
  brucelee: { text: '불가(공개 녹취 없음) → 대체 배우 필요', cls: 'bg-red-100 text-red-800' },
}

type Todo = { text: string; status: 'done' | 'doing' | 'todo' }
const TODO: Todo[] = [
  { text: '후보 5명 공개 자료 수집(버핏·아인슈타인·파인만·잡스·이소룡) 및 자료 유무 확인', status: 'done' },
  { text: '버핏: 주주총회 녹취에서 질문·답 짝 추출, 2018년 이후는 시험용으로 분리(구성용에서 같은 해 이후 서한도 제외)', status: 'done' },
  { text: '질의응답 없는 인물용 시험 선택: 입장 예측·진짜 vs 오귀속 발언·시기 분리·글 이어쓰기·문체 일치(3-1)', status: 'todo' },
  { text: '대체 배우 선정 — 이소룡은 공개 녹취가 없음(자료가 충분한 인물로 교체)', status: 'todo' },
  { text: '질문 은행(60문항)으로 인물별 고유 정보 찾기 — 찾은 것만 남기고 근거(자료·원문 주소) 표시(3-2)', status: 'doing' },
  { text: '송해(한국어) 자료 보강 — 신문·잡지 인터뷰, 평전, 다큐 기사. 한국어 검색은 별도 구현 필요', status: 'doing' },
  { text: '시험 문제에 영역 표시(가치관·결정·감정·관계·유머·취향·이력·모순) — 영역별 점수를 보기 위해', status: 'todo' },
  { text: '아바타 구성: 일반 층 + 특정 층(발언 검색·말투) + 결합 규칙, 근거 없는 쟁점은 "기록에 없는 추정"으로 표시', status: 'todo' },
  { text: '시험 실행: 시험용 질문에 아바타가 답하고 실제 답과 비교(판정 모델, 5×5 식별 표, 이름 가림 시험)', status: 'todo' },
  { text: '결합 효과 측정: 일반만 / 특정만 / 결합을 같은 문제로 비교 + 기록에 없는 새 상황에서의 차이', status: 'todo' },
  { text: '채점에 쓸 더 큰 모델 여부 결정(로컬 모델은 채점이 거칠 수 있음)', status: 'todo' },
  { text: '결과를 내 아바타에 적용: 내 기록(특정)과 일반 지식을 섞는 방식 선택', status: 'todo' },
]
const BADGE = { done: { text: '완료', cls: 'bg-green-100 text-green-800' }, doing: { text: '진행', cls: 'bg-indigo-100 text-indigo-800' }, todo: { text: '대기', cls: 'bg-gray-200 text-gray-700' } }

const LAYERS = [
  { name: '일반 층', text: '시대·분야·문화 배경, 그 분야의 일반 상식, 사람들이 보통 어떻게 판단하는지.' },
  { name: '특정 층', text: '그 사람의 실제 발언·결정 사례·말투·습관·인생 이력·모순된 면. 모든 문장에 출처를 붙인다.' },
  { name: '결합', text: '질문의 쟁점을 일반 정보로 이해하고, 관련된 그 사람의 기록을 근거로 그 사람이라면 어떻게 할지 정한다. 기록에 없는 쟁점은 일반 정보로 추론하되 추정이라고 표시한다.' },
]
const NO_QA: { name: string; how: string; truth: string; fit: string }[] = [
  { name: '입장 예측', how: '보류한 문서에서 "이 사람이 이 주장에 동의했나"를 판정하는 문장 시험을 만들고 아바타가 동의·반대를 예측', truth: '본인 글·발언에 적힌 입장', fit: '5명 모두(발언 모음 + 에세이)' },
  { name: '진짜 vs 오귀속 발언', how: '실제 발언과, 널리 퍼졌지만 본인이 하지 않은 발언(위키인용 오귀속 구역) 중 아바타가 진짜를 고름', truth: '출처가 확인된 발언 / 오귀속으로 판정된 발언', fit: '아인슈타인·잡스·이소룡(오귀속 사례가 많음)' },
  { name: '시기 분리 예측', how: '앞 시기 자료로 만들고 뒤 시기의 입장을 예측(발언이 연대별로 정리되어 있음)', truth: '이후 시기의 실제 발언', fit: '아인슈타인(1890년대~1950년대 연대별 발언)' },
  { name: '글 이어쓰기·논증 완성', how: '보류한 글의 앞부분이나 전제를 주고 결론·다음 주장을 쓰게 한 뒤 원문과 비교', truth: '원문', fit: '파인만(보고서·강연)·버핏 서한·아인슈타인 에세이' },
  { name: '문체 일치(기계 측정)', how: '아바타 글과 실제 글의 문장 길이·접속어·어휘 분포를 비교, 사람 눈 없이 계산', truth: '실제 글의 통계', fit: '5명 모두' },
  { name: '편지·청문회 질의응답', how: '받은 편지→답장 짝, 청문회에서 질문한 사람과 답한 사람 짝(인터뷰와 같은 구조)', truth: '실제 답장·답변', fit: '아인슈타인 편지, 파인만(챌린저 조사위원회 청문회 녹취, 공개 문서)' },
  { name: '기록된 결정 지점', how: '결정 직전 상황만 주고 무엇을 할지 예측(서명·사임·복귀·거절 등)', truth: '실제로 한 결정', fit: '아인슈타인·파인만·잡스(모델이 이미 아는 유명 결정은 제외해야 함)' },
]
const DOMAINS = ['가치관·신념·윤리', '일과 결정', '감정·갈등', '관계', '유머·말투', '취향·습관', '인생 이력', '모순된 면']

type Evidence = { text: string; doc: string; title: string; kind: string; tier: 'own' | 'reported'; score: number; source_url?: string; file?: string }
type AnswerRow = { qid: string; domain: string; question: string; question_en: string; answered: boolean; evidence: Evidence[] }
type QSummary = { total: number; answered: number; own_answered: number; by_domain: Record<string, { total: number; answered: number; own: number }> }
type QStatus = { running: boolean; person: string; done: number; total: number; last_error: string | null; questions: number; people: Record<string, QSummary> }
const TIER: Record<string, string> = { own: '본인이 쓴/말한 것', reported: '전기·기사에 적힌 것' }
const KIND2: Record<string, string> = { primary: '본인 글·연설·편지', interview: '인터뷰·질의응답', quotes: '출처 확인된 발언', lecture: '강의·강연', bio: '전기·백과' }

async function call(path: string, options?: RequestInit) {
  const response = await fetch(API_BASE + path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}

export default function PersonaAvatars() {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [qstatus, setQstatus] = useState<QStatus | null>(null)
  const [who, setWho] = useState('einstein')
  const [answers, setAnswers] = useState<AnswerRow[]>([])
  const [only, setOnly] = useState<'all' | 'answered'>('answered')
  const load = () => call('/persona/status').then(setStatus).catch(cause => setError(String(cause.message || cause)))
  useEffect(() => { void load() }, [])

  const loadQ = () => call('/persona/qbank/status').then(setQstatus).catch(() => undefined)
  useEffect(() => { void loadQ(); const timer = window.setInterval(() => { void loadQ() }, 8000); return () => window.clearInterval(timer) }, [])
  useEffect(() => { call('/persona/qbank/answers/' + who).then(data => setAnswers(data.rows || [])).catch(() => setAnswers([])) }, [who, qstatus?.running, qstatus?.people[who]?.total])

  async function runQ() {
    setError(''); setNotice('')
    try { const result = await call('/persona/qbank/run/' + who, { method: 'POST' }); if (result.error) setError(result.error); else setNotice('질문 은행으로 자료를 찾는 중입니다(몇 분 걸립니다).'); await loadQ() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function buildQa() {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await call('/persona/build_qa', { method: 'POST' })
      setNotice('버핏 질문·답 ' + result.total + '쌍을 뽑았습니다(구성용 ' + result.build + ', 시험용 ' + result.test + ').')
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) }
  }

  return <div className="view-canvas h-full overflow-y-auto">
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
      <header className="view-header -mx-4 -mt-5 border-x-0 px-4 py-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <p className="dashboard-kicker">정답이 공개된 사람으로 시험하기</p>
        <h1 className="mt-1 text-xl font-semibold text-gray-950">유명인 아바타</h1>
        <p className="mt-1 text-xs text-gray-500">일대기와 발언이 잘 알려진 인물의 자료로 아바타를 만들고, 그 사람이 실제로 한 답과 아바타의 답을 비교합니다. 내 아바타는 정답(내가 직접 내린 판단)이 아직 없지만, 이 인물들은 정답이 공개되어 있어서 구조의 일치도를 처음으로 수치로 잴 수 있습니다. 글로만 만들며 얼굴·목소리는 만들지 않습니다.</p>
      </header>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">1. 모은 자료와 시험 가능 여부</h2>
        <p className="mt-1 text-sm text-gray-600">공개 자료만 모아 내 컴퓨터에 보관합니다(저장소에는 올리지 않음). 시험은 질문과 그 사람의 실제 답이 짝지어진 자료가 있어야 가능합니다.</p>
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs text-gray-500"><tr><th className="py-1 pr-3">인물</th><th className="pr-3">문서</th><th className="pr-3">글자 수</th><th className="pr-3">인터뷰·질의응답</th><th className="pr-3">질문·답 짝(구성/시험)</th><th>판정</th></tr></thead>
          <tbody>{status?.people.map(person => {
            const verdict = VERDICT[person.id]
            return <tr key={person.id} className="border-t border-gray-100 align-top">
              <td className="py-2 pr-3 font-medium">{person.name}</td>
              <td className="pr-3">{person.docs}</td>
              <td className="pr-3">{Math.round(person.chars / 1000).toLocaleString()}천</td>
              <td className="pr-3">{person.by_kind.interview ? person.by_kind.interview.docs + '건 · ' + Math.round(person.by_kind.interview.chars / 1000).toLocaleString() + '천자' : '없음'}</td>
              <td className="pr-3">{person.qa_total ? person.qa_total + '쌍 (' + person.qa_build + ' / ' + person.qa_test + ')' : '—'}</td>
              <td>{verdict && <span className={'rounded px-2 py-0.5 text-xs font-medium ' + verdict.cls}>{verdict.text}</span>}</td>
            </tr>
          })}</tbody>
        </table></div>
        <details className="mt-2 text-xs text-gray-600"><summary className="cursor-pointer">자료 종류별 내역</summary>
          <ul className="mt-1 space-y-1">{status?.people.map(person => <li key={person.id}><strong>{person.name}</strong>: {Object.entries(person.by_kind).map(([kind, value]) => (KIND[kind] || kind) + ' ' + value.docs + '건/' + Math.round(value.chars / 1000).toLocaleString() + '천자').join(' · ') || '없음'}</li>)}</ul>
          <p className="mt-1 text-gray-500">저장 위치: {status?.root}</p>
        </details>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button onClick={buildQa} disabled={busy} className="rounded-lg bg-gray-950 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? '추출 중…' : '버핏 질문·답 짝 다시 뽑기'}</button>
          <span className="text-xs text-gray-500">구성용/시험용은 연도로 나눕니다. 2018년 이후 주주총회가 시험용이고, 그 이후 주주서한은 구성 자료에서 뺍니다.</span>
        </div>
        {error && <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {notice && <div role="status" className="mt-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">2. 아바타 구조: 일반 정보 + 특정 정보</h2>
        <ol className="mt-3 grid gap-2 text-sm sm:grid-cols-3">{LAYERS.map(layer => <li key={layer.name} className="rounded-lg border border-gray-200 bg-gray-50 p-3"><strong>{layer.name}</strong><p className="mt-1 text-gray-700">{layer.text}</p></li>)}</ol>
        <p className="mt-3 text-sm text-gray-700">모을 영역: {DOMAINS.join(' · ')}. 시험 문제도 영역별로 고르게 뽑아 영역별 점수를 봅니다. 자료가 부족한 영역은 시험에서 빼고 이유를 적습니다.</p>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">3. 채점 방법</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
          <li><strong>구별 시험:</strong> 판정 모델이 실제 답과 아바타 답 중 진짜를 고를 수 있는가(구별이 안 될수록 좋음).</li>
          <li><strong>5×5 식별 표:</strong> A의 아바타가 B의 실제 답보다 A의 실제 답에 더 가까운가(성격이 실제로 구분되는지).</li>
          <li><strong>기준 비교:</strong> 이름만 준 모델, 이름을 가린 시험, 다른 사람 자료를 넣은 아바타와 비교(모델이 이미 아는 것과 구분).</li>
          <li><strong>결합 효과:</strong> 일반만 / 특정만 / 결합을 같은 문제로 비교, 기록에 없는 새 상황에서의 차이를 따로 봄.</li>
          <li>구성 자료와 시험 자료는 연도·문서 단위로 분리해 정답이 새어 들어가지 않게 합니다.</li>
        </ul>
        <p className="mt-2 text-xs text-gray-500">주의: 인터뷰 답은 대중에게 보이는 모습이라, 이 시험은 “그 사람의 공적 모습”과의 일치를 잽니다. 실존 인물의 얼굴·목소리 아바타는 사칭 문제가 있어 만들지 않습니다.</p>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">3-1. 인터뷰 질의응답이 없어도 가능한 시험</h2>
        <p className="mt-1 text-sm text-gray-600">질문과 실제 답이 짝지어진 자료가 없는 인물(아인슈타인·파인만·잡스·대체 배우)도 아래 방식으로 시험할 수 있습니다. 정답은 모두 본인이 실제로 쓰거나 한 것에서 옵니다.</p>
        <div className="mt-3 space-y-2">{NO_QA.map(item => <article key={item.name} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
          <h3 className="font-semibold">{item.name}</h3>
          <p className="mt-1 text-gray-700">{item.how}</p>
          <p className="mt-1 text-xs text-gray-500">정답: {item.truth} · 적용 대상: {item.fit}</p>
        </article>)}</div>
        <p className="mt-2 text-xs text-gray-500">주의: 널리 알려진 입장과 결정은 모델이 이미 알고 있을 수 있어서, 이름을 가린 시험과 이름만 준 시험을 함께 돌려 구분합니다.</p>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">3-2. 질문 은행으로 찾은 그 사람 고유의 정보 (근거 포함)</h2>
        <p className="mt-1 text-sm text-gray-600">성격·가치관·결정·감정·관계·유머·습관·이력·모순을 묻는 인터뷰 질문 {qstatus?.questions ?? 60}개를 우리가 만들고, 수집한 자료에서 <strong>본인이 직접 답한 대목</strong>을 찾습니다. 찾은 것만 남기고 못 찾은 질문은 "답 없음"입니다(100%를 목표로 하지 않음). 모든 답에 자료 제목·종류·원문 주소와 저장 파일을 붙입니다.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <select value={who} onChange={event => setWho(event.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" aria-label="인물">
            {status?.people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
          <button onClick={runQ} disabled={!!qstatus?.running} className="rounded-lg bg-gray-950 px-3 py-1.5 text-white disabled:opacity-50">{qstatus?.running ? (qstatus.person + ' 찾는 중 ' + qstatus.done + '/' + qstatus.total) : '이 인물로 찾기 실행'}</button>
          <button onClick={() => setOnly(only === 'all' ? 'answered' : 'all')} className="rounded-lg border border-gray-300 px-2.5 py-1.5">{only === 'all' ? '답 있는 것만 보기' : '답 없는 것도 보기'}</button>
          {qstatus?.people[who]?.total ? <span className="text-xs text-gray-500">답 있음 {qstatus.people[who].answered}/{qstatus.people[who].total} · 본인 직접 {qstatus.people[who].own_answered}</span> : <span className="text-xs text-gray-500">아직 실행하지 않았습니다.</span>}
        </div>
        {qstatus?.last_error && <p className="mt-1 text-xs text-amber-700">일부 판정 실패: {qstatus.last_error}</p>}
        {qstatus?.people[who]?.total ? <div className="mt-2 flex flex-wrap gap-1.5 text-xs">{Object.entries(qstatus.people[who].by_domain).map(([domain, value]) => <span key={domain} className="rounded bg-gray-100 px-2 py-1 text-gray-700">{domain} {value.answered}/{value.total}</span>)}</div> : null}
        <div className="mt-3 space-y-2">{answers.filter(row => only === 'all' || row.answered).map(row => <details key={row.qid} className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-sm">
          <summary className="cursor-pointer"><span className="text-xs text-gray-500">{row.domain}</span> · {row.question} <span className={'ml-1 rounded px-1.5 py-0.5 text-xs ' + (row.answered ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600')}>{row.answered ? '답 ' + row.evidence.length + '건' : '답 없음'}</span></summary>
          <div className="mt-2 space-y-2">{row.evidence.map((item, index) => <div key={index} className="rounded bg-white p-2">
            <p className="whitespace-pre-wrap break-words text-gray-800">{item.text}</p>
            <p className="mt-1 text-xs text-gray-600"><strong>자료:</strong> {item.title} · {KIND2[item.kind] || item.kind} · {TIER[item.tier]}</p>
            {item.source_url && <p className="break-all text-xs text-gray-500"><strong>원문:</strong> {item.source_url}</p>}
            {item.file && <p className="break-all text-xs text-gray-400"><strong>저장 파일:</strong> {item.file}</p>}
          </div>)}{row.evidence.length === 0 && <p className="text-xs text-gray-500">수집한 자료에서 본인이 직접 답한 대목을 찾지 못했습니다.</p>}</div>
        </details>)}
          {answers.length === 0 && <p className="text-sm text-gray-500">아직 결과가 없습니다. 인물을 고르고 "찾기 실행"을 누르세요.</p>}
        </div>
        <p className="mt-2 text-xs text-gray-500">판정은 로컬 모델이 하므로 틀릴 수 있습니다. 근거 문단을 직접 확인하세요. 본인 단계는 본인이 쓰거나 말한 자료, 전기 단계는 제3자가 적은 행동·일화입니다.</p>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">4. 할 일</h2>
        <ul className="mt-2 space-y-1.5 text-sm">{TODO.map(item => <li key={item.text} className="flex items-start gap-2"><span className={'mt-0.5 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ' + BADGE[item.status].cls}>{BADGE[item.status].text}</span><span className="text-gray-800">{item.text}</span></li>)}</ul>
      </section>
    </div>
  </div>
}
