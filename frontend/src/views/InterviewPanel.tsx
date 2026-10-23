import { useCallback, useEffect, useState } from 'react'
import { API_BASE } from '../config'
import AutoDraft from './AutoDraft'

// 심층 인터뷰 — 사용자가 요청할 때만 질문을 생성한다.
// 각 답은 높은 신뢰의 self_interview 지식으로 저장되며, 필요하면 직전 답을 바탕으로 한 질문을 더 받는다.

type Interview = {
  id: string
  question: string
  answer: string
  topic: string
  source_kind?: string
  source_ref?: string
  observed_at?: string
  confidence?: number
  approval_status?: string
  conflict_status?: string
  created_at: string
}

const DECISION_TYPES = ['업무·품질', '일정·우선순위', '비용·위험', '관계·협업', '윤리·안전', '새로운 상황'] as const
type DecisionType = typeof DECISION_TYPES[number]
type DecisionForm = {
  topic: string
  decision_type: DecisionType
  situation: string
  options_text: string
  choice: string
  rationale: string
  rejected_options: string
  exception_rule: string
  confidence: number
  policy_version: string
}
type DecisionCoverage = {
  total: number
  types: { name: DecisionType; count: number }[]
  items: Array<DecisionForm & { id: string; created_at: string; source_kind?: string; source_ref?: string; observed_at?: string; approval_status?: string; conflict_status?: string; evidence_state?: string }>
  policy_versions?: { policy_version: string; count: number }[]
  needs_review?: Array<DecisionForm & { id: string; review_reasons: string[] }>
}

type CandidateField = 'situation' | 'choice' | 'rationale' | 'rejected_options' | 'options_text' | 'exception_rule'
type Candidate = Record<CandidateField, string> & {
  id: string; decision_type: DecisionType; topic: string; evidence_state: string
  source_reply: string; source_project: string; observed_at: string | null
}

const EMPTY_DECISION: DecisionForm = {
  topic: '', decision_type: '업무·품질', situation: '', options_text: '', choice: '', rationale: '',
  rejected_options: '', exception_rule: '', confidence: 70, policy_version: 'v1',
}

export default function InterviewPanel() {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [loadingQ, setLoadingQ] = useState(false)
  const [saving, setSaving] = useState(false)
  const [items, setItems] = useState<Interview[]>([])
  const [count, setCount] = useState(0)
  const [error, setError] = useState('')
  const [topic, setTopic] = useState('')   // 주제 지정(선택). 비우면 무작위
  const [focus, setFocus] = useState('')   // 초점 힌트(선택), 예: 사람들이 주로 헷갈리는 부분
  const [decision, setDecision] = useState<DecisionForm>(EMPTY_DECISION)
  const [coverage, setCoverage] = useState<DecisionCoverage | null>(null)
  const [savingDecision, setSavingDecision] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [candidateCounts, setCandidateCounts] = useState<Record<string, number>>({})
  const [candidateFilter, setCandidateFilter] = useState('')
  const [candidateEdits, setCandidateEdits] = useState<Record<string, Partial<Record<CandidateField, string>>>>({})
  const [candidateLimit, setCandidateLimit] = useState(10)
  const [candidateBusy, setCandidateBusy] = useState('')

  const loadList = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/interview/list`)
      const d = await r.json()
      setItems(d.items || [])
      setCount(d.count || 0)
    } catch {
      /* 서버 미연결 — 무시 */
    }
  }, [])

  const loadCoverage = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/interview/coverage`)
      if (r.ok) setCoverage(await r.json())
    } catch {
      /* 서버 미연결 — 무시 */
    }
  }, [])

  const loadCandidates = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/interview/candidates${candidateFilter ? `?decision_type=${encodeURIComponent(candidateFilter)}` : ''}`)
      if (!r.ok) return
      const d = await r.json()
      setCandidates(d.items || [])
      setCandidateCounts(d.counts || {})
    } catch {
      /* 서버 미연결 — 무시 */
    }
  }, [candidateFilter])

  const reviewCandidate = useCallback(async (id: string, action: 'approve' | 'reject', edits?: Partial<Record<CandidateField, string>>) => {
    setCandidateBusy(id)
    setError('')
    try {
      const r = await fetch(`${API_BASE}/interview/candidates/${id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edits || {}),
      })
      const d = await r.json()
      if (!r.ok) setError(d.error || '처리하지 못했습니다.')
      setCandidateEdits(previous => { const next = { ...previous }; delete next[id]; return next })
      await Promise.all([loadCandidates(), loadCoverage(), loadList()])
    } catch {
      setError('처리하지 못했습니다 (서버 연결 확인).')
    } finally {
      setCandidateBusy('')
    }
  }, [loadCandidates, loadCoverage, loadList])

  useEffect(() => {
    loadList()
    loadCoverage()
  }, [loadList, loadCoverage])

  useEffect(() => { void loadCandidates() }, [loadCandidates])

  const getQuestion = useCallback(async () => {
    setLoadingQ(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (topic.trim()) params.set('topic', topic.trim())
      if (focus.trim()) params.set('focus', focus.trim())
      const qs = params.toString()
      const r = await fetch(`${API_BASE}/interview/question${qs ? `?${qs}` : ''}`)
      const d = await r.json()
      if (d.error) setError(d.error)
      else {
        setQuestion(d.question || '')
        if (!topic.trim() && d.topic) setTopic(d.topic)
      }
      setAnswer('')
    } catch (e) {
      setError('질문을 가져오지 못했습니다 (서버 연결 확인).')
    } finally {
      setLoadingQ(false)
    }
  }, [topic, focus])

  const save = useCallback(async (): Promise<boolean> => {
    if (!question.trim() || !answer.trim()) return false
    setSaving(true)
    setError('')
    try {
      const r = await fetch(`${API_BASE}/interview/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer, topic }),
      })
      const d = await r.json()
      if (d.error) {
        setError(d.error)
        return false
      } else {
        setQuestion('')
        setAnswer('')
        await loadList()
        return true
      }
    } catch {
      setError('저장에 실패했습니다 (서버 연결 확인).')
      return false
    } finally {
      setSaving(false)
    }
  }, [question, answer, topic, loadList])

  const saveAndNext = useCallback(async () => {
    const saved = await save()
    if (saved) await getQuestion()
  }, [save, getQuestion])

  const saveAndDeepen = useCallback(async () => {
    const previousQuestion = question
    const previousAnswer = answer
    if (!previousQuestion.trim() || !previousAnswer.trim()) return
    const saved = await save()
    if (!saved) return

    setLoadingQ(true)
    setError('')
    try {
      const r = await fetch(`${API_BASE}/interview/followup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: previousQuestion, answer: previousAnswer, topic }),
      })
      const d = await r.json()
      if (d.error) setError(d.error)
      else setQuestion(d.question || '')
    } catch {
      setError('후속 질문을 만들지 못했습니다 (서버 연결 확인).')
    } finally {
      setLoadingQ(false)
    }
  }, [question, answer, topic, save])

  const remove = useCallback(
    async (id: string) => {
      try {
        await fetch(`${API_BASE}/interview/${id}`, { method: 'DELETE' })
        await loadList()
      } catch {
        /* ignore */
      }
    },
    [loadList],
  )

  const updateDecision = <K extends keyof DecisionForm>(key: K, value: DecisionForm[K]) => {
    setDecision(previous => ({ ...previous, [key]: value }))
  }

  const saveDecisionCase = useCallback(async () => {
    if (!decision.situation.trim() || !decision.choice.trim() || !decision.rationale.trim()) {
      setError('상황, 내 선택, 판단 이유는 꼭 적어주세요.')
      return
    }
    setSavingDecision(true)
    setError('')
    try {
      const r = await fetch(`${API_BASE}/interview/decision-case`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(decision),
      })
      const data = await r.json()
      if (!r.ok || data.error) setError(data.error || '판단 사례를 저장하지 못했습니다.')
      else {
        setDecision(EMPTY_DECISION)
        await Promise.all([loadList(), loadCoverage()])
      }
    } catch {
      setError('판단 사례를 저장하지 못했습니다 (서버 연결 확인).')
    } finally {
      setSavingDecision(false)
    }
  }, [decision, loadCoverage, loadList])

  return (
    <div className="view-canvas h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <header className="view-header -mx-4 -mt-5 border-x-0 px-4 py-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <p className="dashboard-kicker">나를 이해하는 대화</p>
          <h1 className="mt-1 text-xl font-semibold text-gray-950">심층 인터뷰</h1>
          <p className="mt-1 text-xs text-gray-500">
            경험, 가치관, 판단 기준을 차례로 기록합니다. 저장한 사례는 다음 대화에서 우선 검색하되, 보류해 둔 사례는 학습에 섞지 않고 일치 검증에 씁니다. 답을 저장한 뒤에는 근거·사례·예외를 묻는 후속 질문으로 더 깊게 이어갈 수 있습니다. (누적 {count}개)
          </p>
        </header>

        <section className="view-panel p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="dashboard-kicker">판단 사례</p>
              <h2 className="mt-1 text-base font-semibold text-gray-950">실제 선택을 구조화해 기록</h2>
              <p className="mt-1 text-xs leading-5 text-gray-500">나중에 보류 사례 평가와 판단 기준 추출에 쓰입니다. 사실을 지어내지 않고 당시 맥락과 선택하지 않은 대안까지 남깁니다.</p>
            </div>
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700">누적 {coverage?.total ?? 0}건</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-gray-700">판단 영역
              <select value={decision.decision_type} onChange={e => updateDecision('decision_type', e.target.value as DecisionType)} className="mt-1 block w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-normal text-gray-900">
                {DECISION_TYPES.map(item => <option key={item}>{item}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-gray-700">주제 (선택)
              <input value={decision.topic} onChange={e => updateDecision('topic', e.target.value)} placeholder="예: 고객 납기와 검사 정확도" className="mt-1 block w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-normal text-gray-900" />
            </label>
            <label className="text-xs font-medium text-gray-700">정책 버전
              <input value={decision.policy_version} onChange={e => updateDecision('policy_version', e.target.value)} placeholder="예: v1 또는 2026-Q4" maxLength={40} className="mt-1 block w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-normal text-gray-900" />
              <span className="mt-1 block font-normal text-gray-500">기준을 바꾼 뒤에는 새 버전으로 기록해 결과를 섞지 않습니다.</span>
            </label>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-gray-700">상황 <span className="text-red-600">*</span>
              <textarea value={decision.situation} onChange={e => updateDecision('situation', e.target.value)} rows={3} placeholder="어떤 문제가 있었나요? 누가, 무엇이, 언제 충돌했나요?" className="mt-1 block w-full resize-y rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-normal text-gray-900" />
            </label>
            <label className="text-xs font-medium text-gray-700">가능했던 선택지
              <textarea value={decision.options_text} onChange={e => updateDecision('options_text', e.target.value)} rows={3} placeholder="예: 납기를 맞춘다 / 검사를 더 한다 / 범위를 줄인다" className="mt-1 block w-full resize-y rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-normal text-gray-900" />
            </label>
            <label className="text-xs font-medium text-gray-700">내 선택 <span className="text-red-600">*</span>
              <textarea value={decision.choice} onChange={e => updateDecision('choice', e.target.value)} rows={3} placeholder="실제로 무엇을 선택했나요?" className="mt-1 block w-full resize-y rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-normal text-gray-900" />
            </label>
            <label className="text-xs font-medium text-gray-700">판단 이유 <span className="text-red-600">*</span>
              <textarea value={decision.rationale} onChange={e => updateDecision('rationale', e.target.value)} rows={3} placeholder="무엇을 가장 중요하게 봤나요?" className="mt-1 block w-full resize-y rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-normal text-gray-900" />
            </label>
            <label className="text-xs font-medium text-gray-700">선택하지 않은 대안과 이유
              <textarea value={decision.rejected_options} onChange={e => updateDecision('rejected_options', e.target.value)} rows={3} placeholder="무엇을 고려했지만 왜 제외했나요?" className="mt-1 block w-full resize-y rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-normal text-gray-900" />
            </label>
            <label className="text-xs font-medium text-gray-700">예외·적용 조건
              <textarea value={decision.exception_rule} onChange={e => updateDecision('exception_rule', e.target.value)} rows={3} placeholder="어떤 경우에는 다르게 판단하나요?" className="mt-1 block w-full resize-y rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-normal text-gray-900" />
            </label>
          </div>
          <label className="mt-3 block text-xs font-medium text-gray-700">당시 확신도: {decision.confidence}%
            <input type="range" min="0" max="100" step="5" value={decision.confidence} onChange={e => updateDecision('confidence', Number(e.target.value))} className="mt-2 block w-full accent-gray-950" />
          </label>
          <button type="button" onClick={saveDecisionCase} disabled={savingDecision} className="mt-4 rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{savingDecision ? '저장 중…' : '판단 사례 저장'}</button>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {(coverage?.types || DECISION_TYPES.map(name => ({ name, count: 0 }))).map(item => <div key={item.name} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs"><span className="text-gray-600">{item.name}</span><strong className="float-right text-gray-950">{item.count}건</strong></div>)}
          </div>
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-xs leading-5 text-emerald-950">
              <strong>판단 증거 묶음</strong>
              <p className="mt-1">직접 입력 사례에는 출처, 기록 시점, 승인 상태, 확신도, 충돌 확인 상태, 정책 버전을 함께 보관합니다. 현재 버전별 사례: {(coverage?.policy_versions || []).length ? (coverage?.policy_versions || []).map(item => `${item.policy_version} ${item.count}건`).join(' · ') : '아직 없음'}.</p>
            </div>
            <div className="rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
              <strong>보강·이양 대기</strong>
              <p className="mt-1">확신도 60% 미만, 대안·예외가 비어 있거나 충돌 검토가 필요한 사례는 확정 정책으로 쓰지 않고 보강 대상으로 남깁니다. 현재 {(coverage?.needs_review || []).length}건.</p>
              {(coverage?.needs_review || []).slice(0, 3).map(item => <p key={item.id} className="mt-1 truncate">· {item.decision_type}: {item.review_reasons.join(', ')}</p>)}
            </div>
          </div>
          <div className="mt-4 rounded-lg border border-indigo-100 bg-indigo-50 p-3 text-xs leading-5 text-indigo-950">
            <strong>사례가 닮음을 만드는 방식:</strong> 실제 사례를 증거 묶음으로 저장 → 정책 버전별로 관련 사례·이유·예외를 우선 참고 → 다른 상황에서 본인의 재판단과 비교 → 차이가 난 경우 새 버전의 기준이나 사례를 보강합니다. 단순히 사례 수가 많아졌다고 일치도가 높다고 표시하지 않습니다.
          </div>
        </section>

        <section className="view-panel p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="dashboard-kicker">승인 대기</p>
              <h2 className="mt-1 text-base font-semibold text-gray-950">대화 기록에서 추출한 판단 사례 후보</h2>
              <p className="mt-1 text-xs leading-5 text-gray-500">내 대화에서 제안을 고치거나 거절한 순간을 AI가 읽어 구조화한 후보입니다. 승인하기 전에는 검색·프롬프트·판단 사례 집계에 들어가지 않습니다. 사실과 다르면 고쳐서 승인하세요. 이유 항목의 (추정)은 대화에 드러나지 않은 부분을 AI가 짐작한 것입니다.</p>
            </div>
            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-900">대기 {candidateCounts.pending ?? 0}건 · 승인 {candidateCounts.approved ?? 0} · 거절 {candidateCounts.rejected ?? 0}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {['전체', ...DECISION_TYPES].map(name => <button key={name} type="button" onClick={() => setCandidateFilter(name === '전체' ? '' : name)} className={'rounded-full border px-3 py-1 text-xs ' + ((candidateFilter || '전체') === name ? 'border-gray-950 bg-gray-950 text-white' : 'border-gray-300 bg-white text-gray-700')}>{name}</button>)}
          </div>
          <div className="mt-3 space-y-3">
            {candidates.slice(0, candidateLimit).map(item => {
              const edit = candidateEdits[item.id] || {}
              const value = (key: CandidateField) => edit[key] ?? item[key] ?? ''
              const patch = (key: CandidateField, text: string) => setCandidateEdits(previous => ({ ...previous, [item.id]: { ...previous[item.id], [key]: text } }))
              return <article key={item.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                  <span><strong className="text-gray-800">{item.decision_type}</strong> · {item.topic} · {(item.observed_at || '').slice(0, 10)} · {item.source_project.replace(/^(D--MyWork-|codex--)/, '')}</span>
                  <span className={item.evidence_state === 'direct' ? 'text-green-700' : 'text-amber-700'}>{item.evidence_state === 'direct' ? '내 말에 직접 근거' : '추정 포함'}</span>
                </div>
                <p className="mt-2 rounded border border-gray-200 bg-white p-2 text-xs leading-5 text-gray-700"><span className="text-gray-400">내가 한 말 · </span>{item.source_reply}</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {([['situation', '상황'], ['choice', '내 선택'], ['rationale', '판단 이유'], ['rejected_options', '선택하지 않은 대안'], ['options_text', '선택지'], ['exception_rule', '예외·적용 조건']] as [CandidateField, string][]).map(([key, label]) => <label key={key} className="text-xs font-medium text-gray-600">{label}
                    <textarea value={value(key)} onChange={event => patch(key, event.target.value)} rows={2} className="mt-1 block w-full resize-y rounded border border-gray-300 bg-white px-2 py-1 text-xs font-normal text-gray-900" />
                  </label>)}
                </div>
                <div className="mt-2 flex gap-2">
                  <button type="button" disabled={candidateBusy === item.id} onClick={() => { void reviewCandidate(item.id, 'approve', candidateEdits[item.id]) }} className="rounded-lg bg-gray-950 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">{candidateEdits[item.id] ? '고쳐서 승인' : '승인'}</button>
                  <button type="button" disabled={candidateBusy === item.id} onClick={() => { void reviewCandidate(item.id, 'reject') }} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 disabled:opacity-50">거절</button>
                </div>
              </article>
            })}
            {candidates.length === 0 && <p className="text-sm text-gray-500">승인 대기 중인 후보가 없습니다.</p>}
            {candidates.length > candidateLimit && <button type="button" onClick={() => setCandidateLimit(limit => limit + 10)} className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700">더 보기 ({candidates.length - candidateLimit}건 남음)</button>}
          </div>
        </section>

        {/* 질문 받기 / 답변 */}
        <section className="view-panel p-4 sm:p-5">
          {/* 주제 지정(선택) — 비우면 내 관심사에서 무작위 */}
          <div className="mb-3 flex flex-col gap-2 rounded-lg border border-dashed border-surface-border bg-gray-50/60 px-3 py-3">
            <span className="dashboard-kicker">인터뷰 주제 (선택 — 비우면 내 기록에서 제안)</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={topic}
                onChange={e => setTopic(e.target.value)}
                placeholder="주제 (예: 일할 때의 판단 기준)"
                className="w-full rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-400 sm:w-1/3"
              />
              <input
                value={focus}
                onChange={e => setFocus(e.target.value)}
                placeholder="특히 알고 싶은 점 (예: 일정과 품질이 충돌할 때)"
                className="w-full flex-1 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-gray-400"
              />
            </div>
          </div>

          {!question ? (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <p className="text-sm text-gray-500">준비되면 첫 질문을 받아, 실제 경험과 생각을 편하게 들려주세요.</p>
              <button
                type="button"
                onClick={getQuestion}
                disabled={loadingQ}
                className="inline-flex items-center gap-2 rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:opacity-50"
              >
                {loadingQ ? '질문 생성 중…' : '인터뷰 시작'}
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border border-surface-border bg-gray-50 px-4 py-3">
                <span className="dashboard-kicker">아바타의 질문</span>
                <p className="mt-1 text-sm font-medium text-gray-950">{question}</p>
              </div>
              <textarea
                value={answer}
                onChange={e => setAnswer(e.target.value)}
                placeholder="실제 사례, 판단 근거, 상황에 따른 예외까지 편하게 적어주세요…"
                rows={5}
                className="w-full resize-y rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400"
              />
              <AutoDraft kind="interview" slot={question} query={topic} current={answer} onFill={setAnswer} />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={save}
                  disabled={saving || !answer.trim()}
                  className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:opacity-50"
                >
                  {saving ? '저장 중…' : '저장'}
                </button>
                <button
                  type="button"
                  onClick={saveAndNext}
                  disabled={saving || !answer.trim()}
                  className="rounded-lg border border-surface-border bg-white px-4 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
                >
                  저장하고 새 주제 질문
                </button>
                <button
                  type="button"
                  onClick={saveAndDeepen}
                  disabled={saving || loadingQ || !answer.trim()}
                  className="rounded-lg border border-gray-950 bg-gray-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:opacity-50"
                >
                  {loadingQ ? '후속 질문 생성 중…' : '저장하고 더 깊게 묻기'}
                </button>
                <button
                  type="button"
                  onClick={getQuestion}
                  disabled={loadingQ}
                  className="rounded-lg px-3 py-2 text-sm text-gray-500 transition hover:text-gray-900 disabled:opacity-50"
                >
                  다른 질문
                </button>
              </div>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </section>

        {/* 지난 자문자답 */}
        <section className="view-panel overflow-hidden">
          <div className="border-b border-surface-border px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold text-gray-950">인터뷰 기록 ({count})</h2>
          </div>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-400 sm:px-5">아직 저장된 인터뷰 답변이 없습니다.</p>
          ) : (
            <ul className="divide-y divide-surface-border">
              {items.map(it => (
                <li key={it.id} className="group flex items-start gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-gray-500">{it.question}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-gray-900">{it.answer}</p>
                    <p className="mt-1 text-[11px] text-gray-400">{it.created_at} · 출처: {it.source_ref || '심층 인터뷰 직접 입력'} · 신뢰도 {Math.round((it.confidence ?? 0.9) * 100)}% · {it.approval_status === 'approved' ? '사용자 저장·승인' : it.approval_status || '승인 상태 없음'} · {it.conflict_status === 'unchecked' ? '충돌 확인 전' : it.conflict_status || '충돌 상태 없음'}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(it.id)}
                    title="삭제"
                    className="shrink-0 rounded-md px-2 py-1 text-gray-300 transition hover:bg-red-50 hover:text-red-600"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
