import { useEffect, useState } from 'react'
import { API_BASE } from '@/config'

// 유명인 아바타 시험 — 일대기·발언이 잘 알려진 인물의 아바타를 만들어, 그 사람이 실제로 한 답과 비교한다.
// 목적: 정답이 공개되어 있는 사람으로 "내 아바타 구조"가 얼마나 본인과 일치하는지 처음으로 수치로 재 본다.
type Kind = { docs: number; chars: number }
type PersonaPolicy = { mode: string; label: string; short: string; analysis: boolean; face: boolean; voice: boolean; synthetic_voice?: boolean; consent_required: boolean; notice: string }
type Person = { id: string; name: string; docs: number; chars: number; by_kind: Record<string, Kind>; qa_total: number; qa_build: number; qa_test: number; policy?: PersonaPolicy }
type Status = { people: Person[]; root: string; historical_five?: string[] }

const KIND: Record<string, string> = { primary: '본인 글·연설·편지', interview: '인터뷰·질의응답', quotes: '출처 확인된 발언', lecture: '강의·강연', bio: '전기·백과' }
const VERDICT: Record<string, { text: string; cls: string }> = {
  buffett: { text: '충분', cls: 'bg-green-100 text-green-800' },
  einstein: { text: '부족(질문-답 거의 없음)', cls: 'bg-amber-100 text-amber-800' },
  feynman: { text: '부족(대표 인터뷰 전문 접근 불가)', cls: 'bg-amber-100 text-amber-800' },
  jobs: { text: '부족(인터뷰 전문 접근 불가)', cls: 'bg-amber-100 text-amber-800' },
  songhae: { text: '검토 중(한국어 기사 14건, 질의응답 형식은 적음)', cls: 'bg-blue-100 text-blue-800' },
  sejong: { text: '기록·일반 지식·추정으로 구성(78문항 중 21개, 리뷰 대기). 직접 평가 불가', cls: 'bg-purple-100 text-purple-800' },
}

type Todo = { text: string; status: 'done' | 'doing' | 'todo' }
const TODO: Todo[] = [
  { text: '후보 공개 자료 수집(버핏·아인슈타인·파인만·잡스·송해·세종대왕) 및 자료 유무 확인. 이소룡은 제외', status: 'done' },
  { text: '버핏: 주주총회 녹취에서 질문·답 짝 추출, 2018년 이후는 시험용으로 분리(구성용에서 같은 해 이후 서한도 제외)', status: 'done' },
  { text: '질의응답 없는 인물용 시험 선택: 입장 예측·진짜 vs 오귀속 발언·시기 분리·글 이어쓰기·문체 일치(3-1)', status: 'todo' },
  { text: '이소룡은 제외하고 세종대왕으로 교체(2026-10-11, 사용자 결정)', status: 'done' },
  { text: '질문 은행(78문항)으로 인물별 고유 정보 찾기 — 찾은 것만 남기고 근거(자료·원문 주소) 표시(3-2)', status: 'doing' },
  { text: '송해(한국어) 자료 보강 — 신문·잡지 인터뷰, 평전, 다큐 기사. 한국어 검색은 별도 구현 필요', status: 'doing' },
  { text: '시험 문제에 영역 표시(가치관·결정·감정·관계·유머·취향·이력·모순) — 영역별 점수를 보기 위해', status: 'todo' },
  { text: '아바타 구성: 일반 층 + 특정 층(발언 검색·말투) + 결합 규칙, 근거 없는 쟁점은 "기록에 없는 추정"으로 표시', status: 'todo' },
  { text: '시험 실행: 시험용 질문에 아바타가 답하고 실제 답과 비교(판정 모델, 5×5 식별 표, 이름 가림 시험)', status: 'todo' },
  { text: '결합 효과 측정: 일반만 / 특정만 / 결합을 같은 문제로 비교 + 기록에 없는 새 상황에서의 차이', status: 'todo' },
  { text: '채점에 쓸 더 큰 모델 여부 결정(로컬 모델은 채점이 거칠 수 있음)', status: 'todo' },
  { text: '결과를 내 아바타에 적용: 내 기록(특정)과 일반 지식을 섞는 방식 선택', status: 'todo' },
]
const BADGE = { done: { text: '완료', cls: 'bg-green-100 text-green-800' }, doing: { text: '진행', cls: 'bg-indigo-100 text-indigo-800' }, todo: { text: '대기', cls: 'bg-gray-200 text-gray-700' } }
const PERSONA_MODES: PersonaPolicy[] = [
  { mode: 'text_only_risk', label: '초상권 위험 인물 · 텍스트만', short: '공개 발언·저작물의 근거 분석만', analysis: true, face: false, voice: false, synthetic_voice: true, consent_required: false, notice: '실존 인물의 사진·음성·말투 복제는 사용하지 않고 비식별 가상 음성만 사용합니다.' },
  { mode: 'historical', label: '역사적 인물', short: '사료와 저작물에 근거한 역사적 페르소나', analysis: true, face: false, voice: false, synthetic_voice: true, consent_required: false, notice: '사료 기반 추정임을 표시하며 실제 인물처럼 보이는 영상·음성은 만들지 않습니다. 비식별 가상 음성은 사용할 수 있습니다.' },
  { mode: 'famous_ai', label: '가상 AI · 유명인 모드', short: '공개 자료를 바탕으로 한 비사칭 텍스트 시뮬레이션', analysis: true, face: false, voice: false, synthetic_voice: true, consent_required: false, notice: '가상 AI임을 표시하고 외형·음성은 독자적인 가상 캐릭터만 사용합니다.' },
  { mode: 'private_consent', label: '개인 아바타 · 동의 필수', short: '당사자가 허락한 자료로 하는 개인 페르소나', analysis: true, face: true, voice: true, synthetic_voice: true, consent_required: true, notice: '얼굴·음성·개인 기록을 넣기 전 당사자의 명시적 동의를 확인해야 합니다.' },
]
const MODE_CLASS: Record<string, string> = { text_only_risk: 'border-amber-200 bg-amber-50', historical: 'border-sky-200 bg-sky-50', famous_ai: 'border-violet-200 bg-violet-50', private_consent: 'border-emerald-200 bg-emerald-50' }

const LAYERS = [
  { name: '일반 층', text: '시대·분야·문화 배경, 그 분야의 일반 상식, 사람들이 보통 어떻게 판단하는지.' },
  { name: '특정 층', text: '그 사람의 실제 발언·결정 사례·말투·습관·인생 이력·모순된 면. 모든 문장에 출처를 붙인다.' },
  { name: '결합', text: '질문의 쟁점을 일반 정보로 이해하고, 관련된 그 사람의 기록을 근거로 그 사람이라면 어떻게 할지 정한다. 기록에 없는 쟁점은 일반 정보로 추론하되 추정이라고 표시한다.' },
]
const NO_QA: { name: string; how: string; truth: string; fit: string }[] = [
  { name: '입장 예측', how: '보류한 문서에서 "이 사람이 이 주장에 동의했나"를 판정하는 문장 시험을 만들고 아바타가 동의·반대를 예측', truth: '본인 글·발언에 적힌 입장', fit: '5명 모두(발언 모음 + 에세이)' },
  { name: '진짜 vs 오귀속 발언', how: '실제 발언과, 널리 퍼졌지만 본인이 하지 않은 발언(위키인용 오귀속 구역) 중 아바타가 진짜를 고름', truth: '출처가 확인된 발언 / 오귀속으로 판정된 발언', fit: '아인슈타인·잡스(오귀속 사례가 많음)' },
  { name: '시기 분리 예측', how: '앞 시기 자료로 만들고 뒤 시기의 입장을 예측(발언이 연대별로 정리되어 있음)', truth: '이후 시기의 실제 발언', fit: '아인슈타인(1890년대~1950년대 연대별 발언)' },
  { name: '글 이어쓰기·논증 완성', how: '보류한 글의 앞부분이나 전제를 주고 결론·다음 주장을 쓰게 한 뒤 원문과 비교', truth: '원문', fit: '파인만(보고서·강연)·버핏 서한·아인슈타인 에세이' },
  { name: '문체 일치(기계 측정)', how: '아바타 글과 실제 글의 문장 길이·접속어·어휘 분포를 비교, 사람 눈 없이 계산', truth: '실제 글의 통계', fit: '5명 모두' },
  { name: '편지·청문회 질의응답', how: '받은 편지→답장 짝, 청문회에서 질문한 사람과 답한 사람 짝(인터뷰와 같은 구조)', truth: '실제 답장·답변', fit: '아인슈타인 편지, 파인만(챌린저 조사위원회 청문회 녹취, 공개 문서)' },
  { name: '기록된 결정 지점', how: '결정 직전 상황만 주고 무엇을 할지 예측(서명·사임·복귀·거절 등)', truth: '실제로 한 결정', fit: '아인슈타인·파인만·잡스(모델이 이미 아는 유명 결정은 제외해야 함)' },
]
const DOMAINS = ['가치관·신념·윤리', '일과 결정', '감정·갈등', '관계', '유머·말투', '취향·습관', '인생 이력', '모순·한계', '전문지식·사고법', 'MBTI·인지·에너지', '성격·기질', '표현·문체', '시기·변화']
type Evidence = { text: string; doc: string; title: string; kind: string; tier: 'own' | 'reported' | 'secondary' | 'general' | 'estimate' | 'reviewed'; score: number; source_url?: string; file?: string; key?: string; observed_at?: string; confidence?: number; approval_status?: string; conflict_status?: string; source_refs?: { doc: string; title: string; kind: string }[]; reviews?: { reviewer: string; relation: string; verdict: string; at: string }[] }
type AnswerRow = { qid: string; domain: string; question: string; question_en: string; answered: boolean; evidence: Evidence[] }
type Material = { id: string; title: string; kind: string; source?: string; chars?: number; fetched_at?: string; available: boolean; used_by_questions: number }
type PersonaProfile = { ready: boolean; message?: string; generated_at?: string; axes?: { name: string; score: number; confidence: number; summary: string; qids: string[] }[]; mbti?: { type: string; confidence: number; reason: string }; personality?: string; expertise?: string; disclaimer?: string }
type HistoricalVisual = { ready: boolean; message?: string; disclaimer?: string; generic_presenter?: boolean; video?: string; videos?: { label: string; url: string }[]; frames?: { label: string; url: string }[] }
type ProfileAxis = NonNullable<PersonaProfile['axes']>[number]
type QSummary = { total: number; answered: number; real_answered?: number; own_answered: number; reviewed_answered?: number; by_domain: Record<string, { total: number; answered: number; own: number; real?: number; reviewed?: number; rejected?: number }> }
const REAL = ['own', 'reported']   // 수집한 자료에서 확인된 근거. 나머지(secondary·general·estimate)는 추정·미확인으로 따로 표시한다
type QStatus = { running: boolean; person: string; done: number; total: number; last_error: string | null; questions: number; queue?: string[]; queue_index?: number; queue_total?: number; people: Record<string, QSummary> }
type ImprovementStatus = { running?: boolean; last_run?: string | null; last_error?: string | null; changed?: string[]; plans?: Record<string, { pending?: number; generated_at?: string | null }> }
const TIER: Record<string, string> = { own: '본인이 쓴/말한 것', reported: '전기·기사에 적힌 것', secondary: '보도·해설 요약(원문 미확인, 리뷰 대기)', general: '일반 지식(출처 미확인, 리뷰 대기)', estimate: '가상 추정(본인 진술 아님, 리뷰 대기)', reviewed: '그 사람을 아는 사람의 리뷰' }
const KIND2: Record<string, string> = { primary: '본인 글·연설·편지', interview: '인터뷰·질의응답', quotes: '출처 확인된 발언', lecture: '강의·강연', bio: '전기·백과', news: '보도·해설', general: '일반 지식', estimate: '가상 추정', review: '리뷰' }

const VERDICT_TEXT: Record<string, string> = { confirmed: '맞다고 확인', rejected: '틀렸다고 표시' }

// 서비스 단계의 검수: 그 사람을 직접 아는 사람이 추정을 맞다/틀리다/이렇게 고쳐라 하고 남긴다. 원래 근거는 지우지 않고 그 위에 겹쳐 보인다.
function ReviewBox({ person, qid, item, onSaved }: { person: string; qid: string; item: Evidence; onSaved: () => void }) {
  const [reviewer, setReviewer] = useState('')
  const [relation, setRelation] = useState('')
  const [text, setText] = useState('')
  const [message, setMessage] = useState('')
  async function send(verdict: string) {
    setMessage('')
    try {
      await call('/persona/qbank/review/' + person, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ qid, key: item.key, reviewer, relation, verdict, text }) })
      setText(''); setMessage('저장했습니다.'); onSaved()
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)) }
  }
  return <details className="mt-1 text-xs">
    <summary className="cursor-pointer text-indigo-700">그 사람을 아는 사람의 리뷰{item.reviews?.length ? ' (' + item.reviews.length + '건)' : ''}</summary>
    {item.reviews?.map((rv, index) => <p key={index} className="mt-1 text-gray-700">· {rv.reviewer}({rv.relation}): {VERDICT_TEXT[rv.verdict] || rv.verdict} · {rv.at.slice(0, 10)}</p>)}
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <input value={reviewer} onChange={e => setReviewer(e.target.value)} placeholder="리뷰어 이름" className="w-28 rounded border border-gray-300 px-1.5 py-1" />
      <input value={relation} onChange={e => setRelation(e.target.value)} placeholder="그 사람과의 관계" className="w-36 rounded border border-gray-300 px-1.5 py-1" />
    </div>
    <textarea value={text} onChange={e => setText(e.target.value)} placeholder="고칠 내용 또는 더 알려줄 내용(맞다/틀리다만 표시할 때는 비워도 됩니다)" rows={2} className="mt-1 w-full rounded border border-gray-300 px-1.5 py-1" />
    <div className="mt-1 flex flex-wrap gap-1.5">
      <button onClick={() => void send('confirmed')} className="rounded bg-green-600 px-2 py-1 text-white">맞다</button>
      <button onClick={() => void send('rejected')} className="rounded bg-red-600 px-2 py-1 text-white">틀렸다</button>
      <button onClick={() => void send('corrected')} className="rounded bg-indigo-600 px-2 py-1 text-white">이렇게 고친다</button>
      <button onClick={() => void send('added')} className="rounded border border-gray-400 px-2 py-1">더 알려준다</button>
      {message && <span className="text-gray-600">{message}</span>}
    </div>
  </details>
}

async function call(path: string, options?: RequestInit) {
  const response = await fetch(API_BASE + path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}

type DomainCoverage = { domain: string; total: number; confirmed: number; inferred: number }

function PersonaEvidenceRadar({ person, rows }: { person: string; rows: AnswerRow[] }) {
  const domains = DOMAINS.map(domain => {
    const inDomain = rows.filter(row => row.domain === domain)
    const confirmed = inDomain.filter(row => row.evidence.some(item => REAL.includes(item.tier) || item.tier === 'reviewed')).length
    const inferred = inDomain.filter(row => row.answered && !row.evidence.some(item => REAL.includes(item.tier) || item.tier === 'reviewed')).length
    return { domain, total: inDomain.length, confirmed, inferred }
  }).filter(item => item.total > 0)

  if (!domains.length) return <p className="mt-3 text-sm text-gray-500">질문 은행 결과가 생기면 영역별 근거 지도가 표시됩니다.</p>

  const center = 135
  const radius = 90
  const point = (index: number, value: number) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / domains.length
    return [center + Math.cos(angle) * radius * value, center + Math.sin(angle) * radius * value]
  }
  const polygon = (value: number) => domains.map((_, index) => point(index, value).join(',')).join(' ')
  const coverage = (item: DomainCoverage, includeInferred: boolean) => (item.confirmed + (includeInferred ? item.inferred : 0)) / item.total
  const confirmedTotal = domains.reduce((sum, item) => sum + item.confirmed, 0)
  const inferredTotal = domains.reduce((sum, item) => sum + item.inferred, 0)

  return <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50/40 p-3 sm:p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <div><h3 className="font-semibold text-gray-950">{person}의 가치관·행동 근거 지도</h3><p className="mt-1 text-xs leading-5 text-gray-600">각 축은 그 성향의 높낮이가 아니라, 질문·답 자료로 파악된 범위입니다. 인물의 내면을 단정하는 차트가 아닙니다.</p></div>
      <p className="text-xs text-gray-600"><span className="font-medium text-green-700">확인 {confirmedTotal}개</span> · <span className="font-medium text-amber-700">추정 {inferredTotal}개</span></p>
    </div>
    <div className="mt-3 grid items-center gap-4 lg:grid-cols-[290px_1fr]">
      <div className="mx-auto w-full max-w-[290px]" role="img" aria-label={person + '의 영역별 질문 근거 범위 지도'}>
        <svg viewBox="-25 -25 320 320" className="w-full" aria-hidden="true">
          {[0.25, 0.5, 0.75, 1].map(level => <polygon key={level} points={polygon(level)} fill="none" stroke="#cbd5e1" strokeWidth="1" />)}
          {domains.map((item, index) => { const [x, y] = point(index, 1); return <line key={item.domain} x1={center} y1={center} x2={x} y2={y} stroke="#cbd5e1" /> })}
          <polygon points={domains.map((item, index) => point(index, coverage(item, true)).join(',')).join(' ')} fill="#f59e0b" fillOpacity=".16" stroke="#d97706" strokeWidth="2" strokeDasharray="5 4" />
          <polygon points={domains.map((item, index) => point(index, coverage(item, false)).join(',')).join(' ')} fill="#22c55e" fillOpacity=".22" stroke="#15803d" strokeWidth="2.5" />
          {domains.map((item, index) => {
            const [x, y] = point(index, coverage(item, false)); const [labelX, labelY] = point(index, 1.28)
            return <g key={item.domain}><circle cx={x} cy={y} r="3.4" fill="#15803d" /><text x={labelX} y={labelY} textAnchor="middle" dominantBaseline="middle" fontSize="10" fill="#374151">{item.domain.replace('·', ' ')}</text></g>
          })}
          <circle cx={center} cy={center} r="30" fill="white" stroke="#c7d2fe" />
          <text x={center} y={center - 5} textAnchor="middle" dominantBaseline="middle" fontSize="12" fontWeight="700" fill="#312e81">근거 범위</text>
          <text x={center} y={center + 11} textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="#4b5563">질문 은행</text>
        </svg>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {domains.map(item => {
          const total = item.confirmed + item.inferred
          return <div key={item.domain} className="rounded-lg border border-gray-200 bg-white p-2.5 text-sm">
            <div className="flex items-center justify-between gap-2"><strong>{item.domain}</strong><span className="text-xs text-gray-500">{total}/{item.total} 질문</span></div>
            <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-gray-100"><div className="h-full bg-green-500" style={{ width: (item.confirmed / item.total * 100) + '%' }} /><div className="h-full bg-amber-400" style={{ width: (item.inferred / item.total * 100) + '%' }} /></div>
            <p className="mt-1 text-xs text-gray-600"><span className="text-green-700">확인 {item.confirmed}</span> · <span className="text-amber-700">추정 {item.inferred}</span> · 미확인 {item.total - total}</p>
          </div>
        })}
      </div>
    </div>
    <p className="mt-2 text-xs text-gray-500"><span className="font-medium text-green-700">초록 실선</span>은 본인 발언·글, 확인 가능한 기록 또는 리뷰 근거가 있는 질문입니다. <span className="font-medium text-amber-700">주황 점선</span>은 보도·일반 지식·가상 추정까지 포함한 최대 범위이며, 아바타 대화의 사실 근거로는 사용하지 않습니다.</p>
  </div>
}

function EvidenceSummary({ rows }: { rows: AnswerRow[] }) {
  const domains = DOMAINS.map(domain => {
    const found = rows.filter(row => row.domain === domain && row.answered)
    const confirmed = found.filter(row => row.evidence.some(item => REAL.includes(item.tier) || item.tier === 'reviewed'))
    return { domain, found, confirmed }
  }).filter(item => item.found.length)
  if (!domains.length) return null
  return <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3">
    <h3 className="text-sm font-semibold">실제로 모인 정보 요약</h3>
    <p className="mt-1 text-xs text-gray-600">추상적인 성격 판정이 아니라, 어떤 질문에 근거가 발견됐는지와 그 근거의 첫 문장을 요약해 보여줍니다.</p>
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {domains.map(item => <article key={item.domain} className="rounded border border-gray-100 bg-gray-50 p-2 text-xs">
        <div className="flex items-center justify-between gap-2"><strong>{item.domain}</strong><span className={item.confirmed.length ? 'text-green-700' : 'text-amber-700'}>{item.confirmed.length ? '확인 ' + item.confirmed.length : '추정 ' + item.found.length}건</span></div>
        <ul className="mt-1.5 space-y-1 text-gray-700">{item.found.slice(0, 2).map(row => <li key={row.qid}>· <strong>{row.question}</strong>{row.evidence[0]?.text ? <span className="text-gray-500"> — {row.evidence[0].text.replace(/\s+/g, ' ').slice(0, 105)}{row.evidence[0].text.length > 105 ? '…' : ''}</span> : null}</li>)}</ul>
        {item.found.length > 2 && <p className="mt-1 text-gray-500">외 {item.found.length - 2}개 질문</p>}
      </article>)}
    </div>
  </div>
}

function CoverageGaps({ summary }: { summary?: QSummary }) {
  if (!summary) return null
  const domains = Object.entries(summary.by_domain).map(([name, value]) => {
    const confirmed = value.real ?? 0
    const estimated = Math.max(0, value.answered - confirmed)
    const missing = Math.max(0, value.total - value.answered)
    return { name, confirmed, estimated, missing, total: value.total }
  }).sort((a, b) => b.missing - a.missing || a.confirmed - b.confirmed)
  const weak = domains.filter(item => item.missing || item.estimated > item.confirmed)
  return <section className="mt-4 rounded-xl border border-amber-200 bg-amber-50/50 p-3 sm:p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><div><h3 className="font-semibold text-gray-950">한눈에 보는 근거 부족 지도</h3><p className="mt-1 text-xs text-gray-600">빨강이 클수록 아직 자료에서 답을 못 찾은 질문이 많습니다. 주황은 추정·미확인 근거만 있는 질문입니다.</p></div><p className="text-xs font-medium text-amber-900">우선 보강 필요: {weak.length}개 영역</p></div>
    <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{domains.map(item => {
      const complete = item.missing === 0 && item.estimated === 0
      const cls = complete ? 'border-green-200 bg-green-50' : item.missing >= Math.ceil(item.total / 2) ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'
      return <article key={item.name} className={'rounded-lg border p-2.5 text-xs ' + cls}><div className="flex items-center justify-between gap-2"><strong>{item.name}</strong><span className={complete ? 'text-green-700' : item.missing ? 'text-red-700' : 'text-amber-700'}>{complete ? '충분' : item.missing ? '보강 필요' : '검토 필요'}</span></div><div className="mt-2 flex h-2 overflow-hidden rounded-full bg-white/80"><div className="bg-green-500" style={{ width: (item.confirmed / item.total * 100) + '%' }} /><div className="bg-amber-400" style={{ width: (item.estimated / item.total * 100) + '%' }} /><div className="bg-red-400" style={{ width: (item.missing / item.total * 100) + '%' }} /></div><p className="mt-1.5 text-gray-700"><span className="text-green-700">확인 {item.confirmed}</span> · <span className="text-amber-700">추정 {item.estimated}</span> · <span className="text-red-700">미확인 {item.missing}</span> / {item.total}</p></article>
    })}</div>
    <p className="mt-2 text-xs text-gray-500">새로 추가한 질문은 재검색 전까지 빨강(미확인)으로 나타납니다. 인물별로 “찾기 실행”을 다시 수행하면 실제 자료 검색 결과로 갱신됩니다.</p>
  </section>
}

const RADAR_DOMAINS = [
  ['가치관·신념·윤리', '가치관'], ['일과 결정', '결정'], ['전문지식·사고법', '전문'], ['MBTI·인지·에너지', 'MBTI'], ['성격·기질', '성격'], ['시기·변화', '변화'],
  ['관계', '관계'], ['감정·갈등', '감정'], ['취향·습관', '습관'], ['표현·문체', '문체'], ['유머·말투', '유머'], ['인생 이력', '이력'], ['모순·한계', '모순'],
] as const

function CelebrityCoverageRadar({ person, summary }: { person: Person; summary?: QSummary }) {
  const axes = RADAR_DOMAINS.map(([domain, label]) => { const value = summary?.by_domain[domain]; return { label, total: value?.total || 0, confirmed: value?.real || 0, covered: value?.answered || 0, reviewed: value?.reviewed || 0, rejected: value?.rejected || 0 } })
  const center = 110, radius = 70
  const point = (index: number, value: number) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / axes.length; return [center + Math.cos(angle) * radius * value, center + Math.sin(angle) * radius * value] }
  const polygon = (value: number) => axes.map((_, index) => point(index, value).join(',')).join(' ')
  const confirmed = axes.reduce((sum, axis) => sum + axis.confirmed, 0)
  const covered = axes.reduce((sum, axis) => sum + axis.covered, 0)
  const estimated = Math.max(0, covered - confirmed)
  const reviewed = axes.reduce((sum, axis) => sum + axis.reviewed, 0)
  const rejected = axes.reduce((sum, axis) => sum + axis.rejected, 0)
  const sufficiency = summary?.total ? Math.round(confirmed / summary.total * 100) : 0
  return <article className="rounded-xl border border-gray-200 bg-white p-3"><div className="flex items-start justify-between gap-2"><div><h3 className="font-semibold text-gray-950">{person.name}</h3><p className="text-xs text-gray-500">13축 근거 레이더</p></div><span className={sufficiency >= 60 ? 'rounded bg-green-100 px-2 py-1 text-xs text-green-800' : sufficiency >= 30 ? 'rounded bg-amber-100 px-2 py-1 text-xs text-amber-800' : 'rounded bg-red-100 px-2 py-1 text-xs text-red-800'}>확인 {sufficiency}%</span></div><svg viewBox="-18 -18 256 256" className="mx-auto mt-2 w-full max-w-[250px]" role="img" aria-label={person.name + '의 13축 근거 레이더'}>{[.25, .5, .75, 1].map(level => <polygon key={level} points={polygon(level)} fill="none" stroke="#d1d5db" />)}{axes.map((axis, index) => { const [x, y] = point(index, 1); return <line key={axis.label} x1={center} y1={center} x2={x} y2={y} stroke="#e5e7eb" /> })}<polygon points={axes.map((axis, index) => point(index, axis.total ? axis.covered / axis.total : 0).join(',')).join(' ')} fill="#f59e0b" fillOpacity=".14" stroke="#d97706" strokeWidth="1.7" strokeDasharray="4 3" /><polygon points={axes.map((axis, index) => point(index, axis.total ? axis.confirmed / axis.total : 0).join(',')).join(' ')} fill="#22c55e" fillOpacity=".22" stroke="#15803d" strokeWidth="2" />{axes.map((axis, index) => { const [lx, ly] = point(index, 1.26); return <text key={axis.label} x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize="8" fill="#374151">{axis.label}</text> })}</svg><div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1 text-xs"><span className="text-green-700">● 원문 확인 {confirmed}/{summary?.total || 78}</span><span className="text-amber-700">┄ 추정 포함 {estimated}</span><span className="text-indigo-700">● 리뷰 확인 {reviewed}</span><span className={rejected ? 'text-red-700' : 'text-gray-500'}>반려 {rejected}</span></div><p className="mt-2 text-[11px] leading-4 text-gray-500">초록은 원문·기록 근거, 주황 점선은 추정까지 포함한 범위입니다. 리뷰 확인 전 추정은 정확하다고 판정하지 않습니다.</p></article>
}

function AllCelebrityCoverage({ status, summaries }: { status: Status | null; summaries: QStatus | null }) {
  if (!status || !summaries) return null
  return <section className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 sm:p-4"><h3 className="font-semibold text-gray-950">전체 인물 13축 근거 레이더 비교</h3><p className="mt-1 text-xs text-gray-600">각 카드는 한 명의 공개 인물 또는 역사 인물입니다. 초록 면적이 클수록 실제 기록 근거가 충분하고, 주황 점선만 넓을수록 추정·검증 보강이 필요합니다.</p><div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{status.people.map(person => <CelebrityCoverageRadar key={person.id} person={person} summary={summaries.people[person.id]} />)}</div></section>
}

function MiniProfileRadar({ title, axes }: { title: string; axes: ProfileAxis[] }) {
  const center = 115, radius = 72
  const point = (index: number, value: number) => { const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(axes.length, 1); return [center + Math.cos(angle) * radius * value, center + Math.sin(angle) * radius * value] }
  const polygon = (value: number) => axes.map((_, index) => point(index, value).join(',')).join(' ')
  if (axes.length < 3) return null
  return <div className="rounded-lg border border-violet-100 bg-white p-2"><h4 className="text-xs font-semibold text-gray-800">{title}</h4><svg viewBox="-18 -18 266 266" className="mx-auto mt-1 w-full max-w-[260px]" role="img" aria-label={title + ' 레이더 차트'}>{[.25, .5, .75, 1].map(level => <polygon key={level} points={polygon(level)} fill="none" stroke="#c4b5fd" />)}{axes.map((axis, index) => { const [x, y] = point(index, 1); return <line key={axis.name} x1={center} y1={center} x2={x} y2={y} stroke="#ddd6fe" /> })}<polygon points={axes.map((axis, index) => point(index, Math.max(0, Math.min(100, axis.score)) / 100).join(',')).join(' ')} fill="#8b5cf6" fillOpacity=".25" stroke="#6d28d9" strokeWidth="2" />{axes.map((axis, index) => { const [x, y] = point(index, axis.score / 100); const [lx, ly] = point(index, 1.28); return <g key={axis.name}><circle cx={x} cy={y} r="2.7" fill="#6d28d9" /><text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize="8.5" fill="#374151">{axis.name.replace('·', ' ')}</text></g> })}</svg></div>
}

function PersonaProfileRadar({ person }: { person: string }) {
  const [profile, setProfile] = useState<PersonaProfile | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { setProfile(null); setError(''); call('/persona/qbank/profile/' + person).then(setProfile).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))) }, [person])
  async function generate() {
    setBusy(true); setError('')
    try { setProfile(await call('/persona/qbank/profile/' + person, { method: 'POST' })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const allAxes = profile?.axes || []
  const thinkingNames = ['가치관·신념', '판단·결정', '전문지식·사고법', 'MBTI·인지·에너지', '성격·기질', '시기·변화']
  const axes = allAxes.filter(axis => thinkingNames.includes(axis.name))
  const expressionAxes = allAxes.filter(axis => !thinkingNames.includes(axis.name))
  return <div className="mt-4 rounded-xl border border-violet-200 bg-violet-50/50 p-3 sm:p-4">
    <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="font-semibold text-gray-950">{person}을 닮기 위한 인물 프로필 지도</h3><p className="mt-1 text-xs leading-5 text-gray-600">질문 은행의 공개 근거만 바탕으로 성향의 두드러짐을 추정합니다. 사람의 실제 내면이나 능력을 측정하는 차트는 아닙니다.</p></div><button type="button" onClick={() => void generate()} disabled={busy} className="rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">{busy ? '근거 분석 중…' : profile?.ready ? '다시 추정' : '프로필 추정'}</button></div>
    {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    {!profile?.ready && <p className="mt-3 text-sm text-gray-600">{profile?.message || '질문 은행 결과를 불러오는 중입니다.'}</p>}
    {profile?.ready && allAxes.length > 2 && <><div className="mt-3 grid gap-3 lg:grid-cols-2"><MiniProfileRadar title="① 사고·판단 지도" axes={axes} /><MiniProfileRadar title="② 성격·표현 지도" axes={expressionAxes} /></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{allAxes.map(axis => <article key={axis.name} className="rounded-lg border border-violet-100 bg-white p-2.5 text-xs"><div className="flex justify-between gap-2"><strong>{axis.name}</strong><span className="font-medium text-violet-800">성향 {axis.score}/100</span></div><p className="mt-1 text-gray-700">{axis.summary}</p><p className="mt-1 text-gray-500">근거 신뢰 {axis.confidence}% · 질문 {axis.qids?.join(', ') || '없음'}</p></article>)}</div><div className="mt-3 rounded-lg border border-violet-100 bg-white p-3 text-sm"><p><strong>MBTI 가설:</strong> {profile.mbti?.type || '판단 보류'} <span className="text-xs text-gray-500">(신뢰 {profile.mbti?.confidence ?? 0}%)</span></p><p className="mt-1 text-gray-700">{profile.mbti?.reason}</p><p className="mt-2"><strong>성격:</strong> {profile.personality}</p><p className="mt-1"><strong>전문지식:</strong> {profile.expertise}</p></div><p className="mt-2 text-xs text-gray-500">{profile.disclaimer}</p></>}
  </div>
}

function MaterialsBrowser({ person }: { person: string }) {
  const [materials, setMaterials] = useState<Material[]>([])
  const [query, setQuery] = useState('')
  const [opened, setOpened] = useState<{ id: string; title: string; text: string; source?: string } | null>(null)
  const [loading, setLoading] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { setOpened(null); setQuery(''); setError(''); call('/persona/qbank/materials/' + person).then(data => setMaterials(data.materials || [])).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))) }, [person])
  const filtered = materials.filter(item => (item.title + ' ' + item.kind).toLowerCase().includes(query.toLowerCase()))
  async function open(item: Material) {
    setLoading(item.id); setError('')
    try { const data = await call('/persona/qbank/materials/' + person + '/' + encodeURIComponent(item.id)); setOpened(data) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading('') }
  }
  return <div className="mt-4 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
    <div className="flex flex-wrap items-baseline justify-between gap-2"><div><h3 className="font-semibold">수집한 모든 자료 ({materials.length}건)</h3><p className="mt-1 text-xs text-gray-600">자료를 열면 로컬에 보관한 전체 텍스트를 읽을 수 있습니다. “질문에 사용”은 질문 은행의 근거로 연결된 횟수입니다.</p></div><input value={query} onChange={event => setQuery(event.target.value)} placeholder="제목·자료 종류 검색" className="rounded border border-gray-300 px-2 py-1 text-xs" /></div>
    {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
    <div className="mt-3 max-h-64 overflow-y-auto rounded border border-gray-100">
      {filtered.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 p-2 text-xs last:border-b-0"><div className="min-w-0"><p className="truncate font-medium text-gray-800">{item.title}</p><p className="mt-0.5 text-gray-500">{KIND[item.kind] || item.kind} · {Math.round((item.chars || 0) / 1000).toLocaleString()}천자 · 질문에 사용 {item.used_by_questions}회 · {item.available ? '원문 보관됨' : '원문 없음'}</p></div><div className="flex shrink-0 gap-2">{item.source && <a href={item.source} target="_blank" rel="noreferrer" className="text-indigo-700 underline">출처</a>}<button type="button" disabled={!item.available || loading === item.id} onClick={() => void open(item)} className="rounded border border-gray-300 px-2 py-1 disabled:opacity-40">{loading === item.id ? '여는 중…' : '원문 보기'}</button></div></div>)}
      {filtered.length === 0 && <p className="p-3 text-xs text-gray-500">맞는 자료가 없습니다.</p>}
    </div>
    {opened && <details open className="mt-3 rounded border border-indigo-100 bg-indigo-50/40 p-2"><summary className="cursor-pointer text-sm font-medium">원문: {opened.title}</summary>{opened.source && <a href={opened.source} target="_blank" rel="noreferrer" className="mt-2 block break-all text-xs text-indigo-700 underline">원 출처 열기</a>}<pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded bg-white p-3 text-xs leading-5 text-gray-800">{opened.text}</pre></details>}
  </div>
}

function PersonaVisualViewer({ person, policy }: { person: string; policy?: PersonaPolicy }) {
  const [visual, setVisual] = useState<HistoricalVisual | null>(null)
  useEffect(() => {
    setVisual(null)
    if (!policy || policy.mode === 'private_consent') return
    call('/persona/visuals/' + person).then(setVisual).catch(() => setVisual({ ready: false, message: '시각자료를 불러오지 못했습니다.' }))
  }, [person, policy?.mode])
  if (!policy || policy.mode === 'private_consent') return null
  const historical = policy.mode === 'historical'
  const title = historical ? person + ' · 가상 역사 재현 5뷰' : person + ' 대화용 가상 진행자 5뷰'
  const description = historical ? '사료·시대 초상화의 복식·시대 특징을 참고한 AI 재현 시안입니다. 실제 인물의 얼굴 또는 음성이라고 주장하지 않습니다.' : '특정 인물과 닮지 않는 독립적인 현실형 가상 진행자입니다. 대화는 공개 자료를 바탕으로 한 가상 AI 페르소나이며, 실제 모습·음성·본인 발언이 아닙니다.'
  return <section className={'mt-4 rounded-xl border p-3 sm:p-4 ' + (historical ? 'border-sky-200 bg-sky-50/50' : 'border-violet-200 bg-violet-50/50')}>
    <h3 className="font-semibold text-gray-950">{title}</h3>
    <p className="mt-1 text-xs leading-5 text-gray-600">{description}</p>
    {!visual?.ready && <p className="mt-2 text-sm text-gray-500">{visual?.message || '시각자료를 불러오는 중입니다.'}</p>}
    {visual?.ready && <><video className="mt-3 aspect-video w-full rounded-lg bg-black" controls preload="metadata" src={API_BASE + visual.video} aria-label={person + ' 가상 역사 재현 5뷰 영상'} />
      <div className="mt-3 grid gap-2 sm:grid-cols-5">{visual.videos?.map(video => <div key={video.url} className="overflow-hidden rounded-lg border border-sky-100 bg-white"><video className="aspect-[3/4] w-full bg-black object-cover" controls preload="metadata" src={API_BASE + video.url} aria-label={person + ' ' + video.label + ' 영상'} /><p className="p-1.5 text-center text-[10px] text-gray-600">{video.label}</p></div>)}</div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">{visual.frames?.map(frame => <figure key={frame.url} className="overflow-hidden rounded-lg border border-sky-100 bg-white"><img src={API_BASE + frame.url} alt={person + ' ' + frame.label} className="aspect-[3/4] w-full object-cover" /><figcaption className="p-1.5 text-center text-[10px] text-gray-600">{frame.label}</figcaption></figure>)}</div>
      <p className="mt-2 text-xs text-gray-500">{visual.disclaimer}</p></>}
  </section>
}

export default function PersonaAvatars() {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [qstatus, setQstatus] = useState<QStatus | null>(null)
  const [improvement, setImprovement] = useState<ImprovementStatus | null>(null)
  const [who, setWho] = useState('sejong')
  const [answers, setAnswers] = useState<AnswerRow[]>([])
  const [only, setOnly] = useState<'all' | 'answered'>('answered')
  const load = () => call('/persona/status').then(setStatus).catch(cause => setError(String(cause.message || cause)))
  useEffect(() => { void load() }, [])

  const loadQ = () => call('/persona/qbank/status').then(setQstatus).catch(() => undefined)
  useEffect(() => { void loadQ(); const timer = window.setInterval(() => { void loadQ() }, 8000); return () => window.clearInterval(timer) }, [])
  const loadImprovement = () => call('/persona/improvement/status').then(setImprovement).catch(() => undefined)
  useEffect(() => { void loadImprovement(); const timer = window.setInterval(() => { void loadImprovement() }, 15000); return () => window.clearInterval(timer) }, [])
  useEffect(() => { call('/persona/qbank/answers/' + who).then(data => setAnswers(data.rows || [])).catch(() => setAnswers([])) }, [who, qstatus?.running, qstatus?.people[who]?.total])

  async function runQ() {
    setError(''); setNotice('')
    try { const result = await call('/persona/qbank/run/' + who, { method: 'POST' }); if (result.error) setError(result.error); else setNotice('질문 은행으로 자료를 찾는 중입니다(몇 분 걸립니다).'); await loadQ() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function runHistorical() {
    setError(''); setNotice('')
    try {
      const result = await call('/persona/qbank/run_historical', { method: 'POST' })
      if (result.error) setError(result.error)
      else setNotice('역사 인물 5명 분석을 시작했습니다. 세종은 기존 사료 기반 답을 보존하고, 나머지 인물을 한 명씩 근거 판정합니다.')
      await loadQ()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function runAll() {
    setError(''); setNotice('')
    try {
      const result = await call('/persona/qbank/run_all', { method: 'POST' })
      if (result.error) setError(result.error)
      else setNotice('전체 11명 중 세종의 기존 사료 기반 답은 보존하고, 나머지 10명을 차례로 다시 판정합니다. 각 인물 안에서는 질문 4개씩 병렬 처리합니다.')
      await loadQ()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function inferMissing() {
    setError(''); setNotice('')
    try {
      const result = await call('/persona/qbank/infer_missing/' + who, { method: 'POST' })
      if (result.error) setError(result.error)
      else setNotice('직접 답변이 없는 질문은 수집 자료를 근거로 낮은 신뢰도의 추정을 만들고 있습니다. 나중에 원문 근거나 리뷰가 추가되면 그 근거가 우선됩니다.')
      await loadQ()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function runImprovement() {
    setError(''); setNotice('')
    try {
      const result = await call('/persona/improvement/run', { method: 'POST' })
      if (result.error) setError(result.error)
      else setNotice('자율 보강을 시작했습니다. 새 원문은 근거를 다시 찾고, 없는 영역은 수집 후보로 기록합니다.')
      await loadImprovement()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
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
        <h1 className="mt-1 text-xl font-semibold text-gray-950">인물 페르소나 분석</h1>
        <p className="mt-1 text-xs text-gray-500">공개 사료·저작물·발언에서 근거를 찾고, 확인 범위와 추정 범위를 분리해 텍스트 페르소나를 분석합니다. 얼굴·목소리는 만들지 않습니다.</p>
      </header>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">0. 분석 대상과 허용 범위</h2>
        <p className="mt-1 text-sm text-gray-600">같은 공개 자료 분석이라도 대상 유형에 따라 결과를 쓰는 범위가 다릅니다. 이 정책은 텍스트 페르소나와 3D·음성 기능을 분리하는 기준입니다.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {PERSONA_MODES.map(mode => <article key={mode.mode} className={'rounded-lg border p-3 text-sm ' + MODE_CLASS[mode.mode]}>
            <h3 className="font-semibold text-gray-900">{mode.label}</h3><p className="mt-1 text-gray-700">{mode.short}</p>
            <p className="mt-2 text-xs text-gray-600">근거 텍스트 분석 가능 · 얼굴 {mode.face ? '동의 후 가능' : '사용 안 함'} · 음성 {mode.voice ? '동의 후 가능' : mode.synthetic_voice ? '비식별 가상 음성만' : '사용 안 함'}</p>
            <p className="mt-1 text-xs text-gray-500">{mode.notice}</p>
          </article>)}
        </div>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">1. 모은 자료와 시험 가능 여부</h2>
        <p className="mt-1 text-sm text-gray-600">공개 자료만 모아 내 컴퓨터에 보관합니다(저장소에는 올리지 않음). 역사 인물 5명은 사료와 저작물을 중심으로 같은 질문 은행을 적용합니다. 직접 답변이 없는 항목은 답 없음으로 남기며 억지로 채우지 않습니다.</p>
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm">
          <thead className="text-xs text-gray-500"><tr><th className="py-1 pr-3">인물</th><th className="pr-3">문서</th><th className="pr-3">글자 수</th><th className="pr-3">인터뷰·질의응답</th><th className="pr-3">질문·답 짝(구성/시험)</th><th>판정</th></tr></thead>
          <tbody>{status?.people.map(person => {
            const verdict = VERDICT[person.id]
            return <tr key={person.id} className="border-t border-gray-100 align-top">
              <td className="py-2 pr-3 font-medium">{person.name}<span className="mt-1 block text-xs font-normal text-gray-500">{person.policy?.label || '정책 확인 전'}</span></td>
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
        <p className="mt-1 text-sm text-gray-600">질문과 실제 답이 짝지어진 자료가 없는 인물(아인슈타인·파인만·잡스)도 아래 방식으로 시험할 수 있습니다. 정답은 모두 본인이 실제로 쓰거나 한 것에서 옵니다.</p>
        <div className="mt-3 space-y-2">{NO_QA.map(item => <article key={item.name} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
          <h3 className="font-semibold">{item.name}</h3>
          <p className="mt-1 text-gray-700">{item.how}</p>
          <p className="mt-1 text-xs text-gray-500">정답: {item.truth} · 적용 대상: {item.fit}</p>
        </article>)}</div>
        <p className="mt-2 text-xs text-gray-500">주의: 널리 알려진 입장과 결정은 모델이 이미 알고 있을 수 있어서, 이름을 가린 시험과 이름만 준 시험을 함께 돌려 구분합니다.</p>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">3-2. 질문 은행으로 찾은 그 사람 고유의 정보 (근거 포함)</h2>
        <p className="mt-1 text-sm text-gray-600">성격·가치관·결정·감정·관계·유머·습관·이력·모순뿐 아니라 전문성·인지 성향·표현·시간에 따른 변화를 묻는 질문 {qstatus?.questions ?? 78}개를 만들고, 수집한 자료에서 <strong>본인이 직접 답한 대목</strong>을 찾습니다. 찾은 것만 남기고 못 찾은 질문은 "답 없음"입니다(100%를 목표로 하지 않음). 모든 답에 자료 제목·종류·원문 주소와 저장 파일을 붙입니다.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <select value={who} onChange={event => setWho(event.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5" aria-label="인물">
            <optgroup label="역사 인물 5명">
              {status?.people.filter(person => (status.historical_five || []).includes(person.id)).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </optgroup>
            <optgroup label="그 밖의 공개 인물">
              {status?.people.filter(person => !(status.historical_five || []).includes(person.id)).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </optgroup>
          </select>
          <button onClick={runQ} disabled={!!qstatus?.running} className="rounded-lg bg-gray-950 px-3 py-1.5 text-white disabled:opacity-50">{qstatus?.running ? (qstatus.person + ' 찾는 중 ' + qstatus.done + '/' + qstatus.total) : '이 인물로 찾기 실행'}</button>
          <button onClick={runAll} disabled={!!qstatus?.running} className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-emerald-950 disabled:opacity-50">전체 11명 근거 재판정</button>
          <button onClick={runHistorical} disabled={!!qstatus?.running} className="rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-indigo-950 disabled:opacity-50">역사 인물 5명 분석 실행</button>
          <button onClick={inferMissing} disabled={!!qstatus?.running || !qstatus?.people[who]?.answered} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-amber-950 disabled:opacity-50">답 없는 항목 추정</button>
          <button onClick={runImprovement} disabled={!!improvement?.running} className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-violet-950 disabled:opacity-50">{improvement?.running ? '자율 보강 중…' : '자율 보강 지금 실행'}</button>
          <button onClick={() => setOnly(only === 'all' ? 'answered' : 'all')} className="rounded-lg border border-gray-300 px-2.5 py-1.5">{only === 'all' ? '답 있는 것만 보기' : '답 없는 것도 보기'}</button>
          {qstatus?.people[who]?.total ? <span className="text-xs text-gray-500"><strong className="text-green-700">자료로 확인 {qstatus.people[who].real_answered ?? 0}/{qstatus.people[who].total}</strong> (본인 직접 {qstatus.people[who].own_answered}) · <strong className="text-amber-700">추정·미확인만 {qstatus.people[who].answered - (qstatus.people[who].real_answered ?? 0)}</strong> · 답 없음 {qstatus.people[who].total - qstatus.people[who].answered}</span> : <span className="text-xs text-gray-500">아직 실행하지 않았습니다.</span>}
        </div>
        {qstatus?.running && qstatus.queue_total ? <p className="mt-2 text-xs text-emerald-700">전체 대기열 {qstatus.queue_index}/{qstatus.queue_total}명 · 현재 {qstatus.person} · 질문 {qstatus.done}/{qstatus.total}</p> : null}
        {qstatus?.last_error && <p className="mt-1 text-xs text-amber-700">일부 판정 실패: {qstatus.last_error}</p>}
        {improvement && <p className="mt-1 text-xs text-violet-700">자율 보강: {improvement.running ? '실행 중' : improvement.last_run ? '최근 ' + improvement.last_run : '아직 실행 전'} · 이 인물 수집 후보 {improvement.plans?.[who]?.pending ?? '—'}개{improvement.last_error ? ' · 오류: ' + improvement.last_error : ''}</p>}
        {qstatus?.people[who]?.total ? <div className="mt-2 flex flex-wrap gap-1.5 text-xs">{Object.entries(qstatus.people[who].by_domain).map(([domain, value]) => <span key={domain} className="rounded bg-gray-100 px-2 py-1 text-gray-700">{domain} 확인 {value.real ?? 0} · 추정 {value.answered - (value.real ?? 0)} / {value.total}</span>)}</div> : null}
        <CoverageGaps summary={qstatus?.people[who]} />
        <AllCelebrityCoverage status={status} summaries={qstatus} />
        <PersonaEvidenceRadar person={status?.people.find(person => person.id === who)?.name || who} rows={answers} />
        <PersonaProfileRadar person={who} />
        <PersonaVisualViewer person={who} policy={status?.people.find(person => person.id === who)?.policy} />
        <EvidenceSummary rows={answers} />
        <div className="mt-3 space-y-2">{answers.filter(row => only === 'all' || row.answered).map(row => <details key={row.qid} className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-sm">
          <summary className="cursor-pointer"><span className="text-xs text-gray-500">{row.domain}</span> · {row.question} <span className={'ml-1 rounded px-1.5 py-0.5 text-xs ' + (row.evidence.some(e => REAL.includes(e.tier)) ? 'bg-green-100 text-green-800' : row.answered ? 'bg-amber-100 text-amber-800' : 'bg-gray-200 text-gray-600')}>{row.evidence.some(e => REAL.includes(e.tier)) ? '자료 확인 ' + row.evidence.filter(e => REAL.includes(e.tier)).length + '건' : row.answered ? '추정·미확인 ' + row.evidence.length + '건' : '답 없음'}</span></summary>
          <div className="mt-2 space-y-2">{row.evidence.map((item, index) => <div key={index} className={'rounded bg-white p-2 border-l-4 ' + (item.tier === 'reviewed' ? 'border-indigo-500' : REAL.includes(item.tier) ? 'border-green-500' : 'border-amber-400')}>
            <p className="whitespace-pre-wrap break-words text-gray-800">{item.text}</p>
            <p className="mt-1 text-xs text-gray-600"><span className={'mr-1 rounded px-1.5 py-0.5 font-medium ' + (item.tier === 'reviewed' ? 'bg-indigo-100 text-indigo-800' : REAL.includes(item.tier) ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800')}>{item.tier === 'reviewed' ? '리뷰 반영' : REAL.includes(item.tier) ? '실제 자료' : '추정·미확인'}</span><strong>자료:</strong> {item.title} · {KIND2[item.kind] || item.kind} · {TIER[item.tier]}</p>
            {item.source_url && <p className="break-all text-xs text-gray-500"><strong>원문:</strong> {item.source_url}</p>}
            {item.source_refs?.length ? <p className="mt-1 text-xs text-gray-500"><strong>추정에 사용한 수집 자료:</strong> {item.source_refs.map(ref => ref.title).join(' · ')}</p> : null}
            <p className="mt-1 text-xs text-gray-500"><strong>상태:</strong> {item.observed_at ? '시점 ' + item.observed_at : '시점 미기록'} · 신뢰도 {Math.round((item.confidence ?? item.score ?? 0) * 100)}% · {item.approval_status === 'reviewed' ? '리뷰 승인' : item.approval_status === 'source_checked' ? '원문 확인' : '검토 대기'} · {item.conflict_status === 'rejected' ? '충돌·반려' : item.conflict_status === 'no_conflict' ? '충돌 없음 확인' : '충돌 확인 전'}</p>
            {item.file && <p className="break-all text-xs text-gray-400"><strong>저장 파일:</strong> {item.file}</p>}
            {item.key && item.tier !== 'reviewed' && <ReviewBox person={who} qid={row.qid} item={item} onSaved={() => { void call('/persona/qbank/answers/' + who).then(data => setAnswers(data.rows || [])) }} />}
          </div>)}{row.evidence.length === 0 && <p className="text-xs text-gray-500">수집한 자료에서 본인이 직접 답한 대목을 찾지 못했습니다.</p>}</div>
        </details>)}
          {answers.length === 0 && <p className="text-sm text-gray-500">아직 결과가 없습니다. 인물을 고르고 "찾기 실행"을 누르세요.</p>}
        </div>
        <p className="mt-2 text-xs text-gray-500">초록 표시는 수집한 자료에서 확인된 실제 정보이고, 주황 표시는 직접 답변이 없을 때 수집 원문·보도 요약·드러난 사실에서 만든 낮은 신뢰도의 추정입니다. 추정은 사실이나 본인 발언으로 쓰지 않으며, 더 좋은 원문 근거나 리뷰가 추가되면 자동으로 그 근거가 우선됩니다. 서비스 단계에서는 그 사람을 직접 아는 사람이 각 근거에 리뷰(맞다/틀렸다/고친다)를 남겨 추정을 바로잡고, 리뷰는 파란 표시로 겹쳐 보입니다. 판정은 로컬 모델이 하므로 틀릴 수 있습니다. 근거 문단을 직접 확인하세요. 본인 단계는 본인이 쓰거나 말한 자료, 전기 단계는 제3자가 적은 행동·일화입니다.</p>
        <MaterialsBrowser person={who} />
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">3-3. 외형·음성 분리 원칙</h2>
        <p className="mt-1 text-sm text-gray-600">현재 공개 인물 코퍼스는 텍스트 근거 분석용입니다. 3D Mix에는 유명인 사진 선택을 제공하지 않고, 당사자가 동의한 개인 자료 또는 비실존 가상 캐릭터만 넣을 수 있습니다.</p>
        <p className="mt-2 text-xs text-gray-500">유명인 모드는 외형·음성·특징을 연상시키는 시각자료도 제공하지 않습니다. 역사 인물만 사료·시대 초상화의 특징을 참고한 “AI 역사 재현” 5뷰를 제공하며, 실제 초상·사진·음성이 아님을 표시합니다.</p>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">4. 할 일</h2>
        <ul className="mt-2 space-y-1.5 text-sm">{TODO.map(item => <li key={item.text} className="flex items-start gap-2"><span className={'mt-0.5 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ' + BADGE[item.status].cls}>{BADGE[item.status].text}</span><span className="text-gray-800">{item.text}</span></li>)}</ul>
      </section>
    </div>
  </div>
}
