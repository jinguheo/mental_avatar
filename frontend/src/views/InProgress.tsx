import { useEffect, useState } from 'react'
import { API_BASE } from '@/config'
import SyncRadar, { type SyncAxis } from './SyncRadar'
import ScienceBasis from './ScienceBasis'
import LinkagePanel from './LinkagePanel'
import SelfSummaryPanel from './SelfSummaryPanel'
import ProgressLog from './ProgressLog'

type SectionKey = 'judgment' | 'memory' | 'authority' | 'verification' | 'identity'
type Section = { section: SectionKey; draft: string; approved: string; updated_at: string | null; approved_at: string | null }
type Evaluation = { id: string; question: string; expected: string; observed: string; result: 'pending' | 'pass' | 'fail'; notes: string }
type Conversation = { id: string; content: string; created_at: string; node_id: string | null; corrected_text: string }
type State = { sections: Record<SectionKey, Section>; evaluations: Evaluation[] }
type Profile = Record<string, { value: string; updated_at: string }>
type Stats = { nodes: number; edges: number; vector_count: number; topics: number }

const SECTION_INFO: { key: SectionKey; title: string; purpose: string; example: string }[] = [
  { key: 'judgment', title: '판단 방식', purpose: '무엇을 우선하고, 무엇을 근거로 결론을 내리는지 적습니다.', example: '예: 비용보다 정확성을 우선한다. 근거가 부족하면 결론을 보류한다.' },
  { key: 'memory', title: '기억의 갱신', purpose: '새 정보의 출처·유효기간·충돌 시 처리 기준을 정합니다.', example: '예: 최근 직접 확인한 사실을 우선한다. 오래된 계획은 현재 계획과 비교한다.' },
  { key: 'authority', title: '행동 권한', purpose: '아바타가 답할 수 있는 범위와 사람의 승인이 필요한 일을 구분합니다.', example: '예: 정보 설명은 가능. 메시지 발송·결제·계정 변경은 내 승인 없이는 불가.' },
  { key: 'verification', title: '검증 기준', purpose: '어떤 답을 나답다고 인정할지 기준을 적습니다.', example: '예: 결론뿐 아니라 이유·불확실성·말투가 내 판단과 일치해야 한다.' },
  { key: 'identity', title: '신원·안전장치', purpose: 'AI 아바타 표시, 얼굴·음성 사용, 중지·철회 기준을 정합니다.', example: '예: 상대에게 AI 아바타임을 알린다. 내 요청 즉시 사용을 중단한다.' },
]

const BASIC_FIELDS = [
  { key: 'name', label: '이름' }, { key: 'role', label: '역할·직책' },
  { key: 'company', label: '소속' }, { key: 'expertise', label: '전문 분야' },
  { key: 'main_projects', label: '주요 프로젝트' }, { key: 'goals', label: '현재 목표' },
  { key: 'values', label: '중요한 가치' }, { key: 'work_style', label: '일하는 방식' },
  { key: 'relationships', label: '중요한 관계와 호칭' }, { key: 'biography', label: '내 이야기와 주요 경험' },
]

async function api(path: string, options?: RequestInit) {
  const response = await fetch(API_BASE + path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}
function json(method: string, data: object): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
}
function date(value?: string | null) {
  return value ? value.replace('T', ' ').slice(0, 16) : '아직 없음'
}

export default function InProgress() {
  const [state, setState] = useState<State | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [profile, setProfile] = useState<Profile>({})
  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({})
  const [stats, setStats] = useState<Stats | null>(null)
  const [voice, setVoice] = useState<{ registered: boolean; face_registered: boolean; model_registered: boolean } | null>(null)
  const [interviewCount, setInterviewCount] = useState(0)
  const [memoryCount, setMemoryCount] = useState(0)
  const [newMemory, setNewMemory] = useState('')
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [conversationDraft, setConversationDraft] = useState<Record<string, string>>({})
  const [newQuestion, setNewQuestion] = useState('')
  const [newExpected, setNewExpected] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  async function refresh() {
    setError('')
    try {
      const [governance, s, p, v, interviews, memories, conversationData] = await Promise.all([
        api('/governance'), api('/stats'), api('/profile/me'),
        api('/avatar/voice_status'), api('/interview/list'), api('/memory'),
        api('/governance/conversations'),
      ])
      setState(governance)
      setDrafts(Object.fromEntries(SECTION_INFO.map(item => [item.key, governance.sections[item.key].draft])))
      setStats(s)
      setProfile(p.profile || {})
      setProfileDraft(Object.fromEntries(BASIC_FIELDS.map(field => [field.key, p.profile?.[field.key]?.value || ''])))
      setVoice(v)
      setInterviewCount(interviews.count || 0)
      setMemoryCount((memories.items || []).length)
      setConversations(conversationData.items || [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '상태를 불러오지 못했습니다.')
    }
  }
  useEffect(() => { void refresh() }, [])

  async function perform(name: string, action: () => Promise<void>, message: string) {
    setBusy(name); setError(''); setNotice('')
    try { await action(); setNotice(message) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '저장하지 못했습니다.') }
    finally { setBusy('') }
  }

  async function saveProfile() {
    await perform('profile', async () => {
      const data = await api('/profile/me', json('POST', profileDraft))
      setProfile(data.profile)
      setProfileDraft(Object.fromEntries(BASIC_FIELDS.map(field => [field.key, data.profile?.[field.key]?.value || ''])))
    }, '기본 정보를 저장했습니다. 다음 대화부터 프로필에 반영됩니다.')
  }

  async function saveSection(key: SectionKey) {
    await perform(key, async () => {
      await api('/governance/' + key, json('PUT', { text: drafts[key] || '' }))
      setState(await api('/governance'))
    }, '기준을 저장하고 다음 아바타 답변에 반영했습니다.')
  }

  async function addMemory() {
    if (!newMemory.trim()) return
    await perform('memory-add', async () => {
      await api('/memory', json('POST', { content: newMemory.trim() }))
      setNewMemory('')
      const data = await api('/memory')
      setMemoryCount(data.items.length)
    }, '핵심 기억을 저장했습니다. 다음 답변부터 항상 참고합니다.')
  }

  async function correctConversation(item: Conversation) {
    await perform(item.id, async () => {
      await api('/governance/conversations/' + encodeURIComponent(item.id), json('PUT', { text: conversationDraft[item.id] || '' }))
      const updated = await api('/governance/conversations')
      setConversations(updated.items || [])
    }, '이 대화의 수정 내용을 KG와 검색 벡터에 반영했습니다.')
  }

  async function addEvaluation() {
    if (!newQuestion.trim() || !newExpected.trim()) return
    await perform('evaluation-add', async () => {
      await api('/governance/evaluations', json('POST', { question: newQuestion, expected: newExpected }))
      setNewQuestion(''); setNewExpected('')
      setState(await api('/governance'))
    }, '비교 질문을 저장했습니다.')
  }

  async function updateEvaluation(item: Evaluation) {
    await perform(item.id, async () => {
      await api('/governance/evaluations', json('POST', item))
      setState(await api('/governance'))
    }, '비교 결과를 저장했습니다.')
  }

  async function removeEvaluation(id: string) {
    await perform(id, async () => {
      await api('/governance/evaluations/' + encodeURIComponent(id), { method: 'DELETE' })
      setState(await api('/governance'))
    }, '비교 사례를 삭제했습니다.')
  }

  function editEvaluation(id: string, patch: Partial<Evaluation>) {
    setState(previous => previous && ({
      ...previous,
      evaluations: previous.evaluations.map(item => item.id === id ? { ...item, ...patch } : item),
    }))
  }

  const filled = BASIC_FIELDS.filter(field => profile[field.key]?.value?.trim()).length
  const approved = SECTION_INFO.filter(item => state?.sections[item.key].approved.trim()).length
  const passed = state?.evaluations.filter(item => item.result === 'pass').length || 0
  const failed = state?.evaluations.filter(item => item.result === 'fail').length || 0
  const recent = conversations.slice(0, 8)
  const synced = recent.filter(item => item.node_id).length
  const evaluated = passed + failed
  const matchRate = evaluated ? Math.round(passed / evaluated * 100) : 0
  const styleFilled = ['speech_style', 'persona', 'language_tone'].filter(key => profile[key]?.value?.trim()).length
  const axes: SyncAxis[] = [
    { label: '기본 정보', value: Math.round(filled / BASIC_FIELDS.length * 100), detail: filled + '/' + BASIC_FIELDS.length + '개 기본 사실 입력' },
    { label: '지식 색인', value: stats ? Math.min(100, Math.round(stats.vector_count / 10)) : 0, detail: '검색 벡터 ' + (stats?.vector_count || 0) + '개 / 임시 목표 1,000개' },
    { label: '판단 사례', value: Math.min(100, Math.round(Math.min(interviewCount, 10) * 7 + (state?.sections.judgment.approved ? 30 : 0))), detail: '자문자답 ' + interviewCount + '/10건 + 판단 기준' },
    { label: '대화 Recall', value: recent.length ? Math.round(synced / recent.length * 100) : 0, detail: '최근 발언 ' + synced + '/' + recent.length + '개 KG 자동 반영' },
    { label: '표현', value: Math.round(((voice?.face_registered ? 1 : 0) + (voice?.registered ? 1 : 0) + (voice?.model_registered ? 1 : 0) + styleFilled) / 6 * 100), detail: '얼굴·3D 모델·목소리·말투·성격·톤 등록 상태' },
    { label: '권한·신원', value: Math.round(((state?.sections.authority.approved ? 1 : 0) + (state?.sections.identity.approved ? 1 : 0)) / 2 * 100), detail: '행동 범위와 AI 신원 기준 설정' },
    { label: '검증', value: Math.min(100, passed * 10), detail: '비교 질문 통과 ' + passed + '/10건 (실제 일치율과 별도)' },
  ]
  const syncRate = Math.round(axes.reduce((sum, axis) => sum + axis.value, 0) / axes.length)

  return <div className="view-canvas h-full overflow-y-auto">
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 pb-24 sm:px-6">
      <header>
        <p className="dashboard-kicker">기초 지식 · 연결 · 일치</p>
        <h1 className="mt-1 text-2xl font-semibold text-gray-950">구현중</h1>
        <p className="mt-2 text-sm leading-6 text-gray-600">아바타는 대화를 자동으로 기억하고, 현재 정보와 과거 사례를 함께 Recall합니다. 기본 정보와 기준은 나중에 수정하면 바로 반영됩니다.</p>
      </header>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {notice && <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
      <ProgressLog />
      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">기초 지식 지도</h2>
        <p className="mt-1 text-sm text-gray-600">어느 축이 연결됐고 무엇이 부족한지 보여줍니다. 각 축은 아래에 적힌 입력량·설정 상태·검증 건수로 계산합니다.</p>
        <div className="mt-4"><SyncRadar axes={axes} overall={syncRate} /></div>
        <p className="mt-3 text-xs text-gray-500">전체 {syncRate}%는 7개 축의 평균 준비도(아바타가 알고 있는 기초 지식의 양과 상태)입니다. 내 정보가 답을 실제로 바꾸는지(연결)는 아래 6번, 나와 얼마나 같은지(sync)는 7번에 방법을 정리했고 아직 측정하지 못했습니다. 실제 답변 일치율: {evaluated ? matchRate + '% (' + passed + '/' + evaluated + ')' : '검증 사례 없음'}</p>
      </section>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['기본 정보', filled + ' / ' + BASIC_FIELDS.length],
          ['KG', stats ? stats.nodes.toLocaleString() + ' 노드 · ' + stats.edges.toLocaleString() + ' 관계' : '확인 중'],
          ['내 판단 사례', interviewCount + '건 · 핵심 기억 ' + memoryCount + '건'],
          ['내가 정한 기준', approved + ' / ' + SECTION_INFO.length],
        ].map(([label, value]) => <div key={label} className="view-panel p-4"><p className="text-xs text-gray-500">{label}</p><p className="mt-2 text-base font-semibold text-gray-950">{value}</p></div>)}
      </section>
      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">현재 확인된 것과 남은 일</h2>
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <p>얼굴: {voice?.face_registered ? '등록됨' : '미등록'} · 3D 모델: {voice?.model_registered ? '파일 확인' : '미등록'} · 목소리: {voice?.registered ? '등록됨' : '미등록'}</p>
          <p>검색 벡터: {stats?.vector_count?.toLocaleString() || '확인 중'}개 · 주제: {stats?.topics?.toLocaleString() || '확인 중'}개</p>
          <p>내 판단 사례: {interviewCount}건. 실제 선택의 이유를 자문자답에 더 남기면 정확도를 높일 수 있습니다.</p>
          <p>비교 검증: 통과 {passed}건 · 차이 발견 {failed}건. 아래 질문으로 반복해서 확인하세요.</p>
        </div>
        <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">현재 외부 메시지 발송·결제 같은 행동을 실행하는 승인 시스템은 연결되어 있지 않습니다. 아래 권한 기준은 아바타의 답변 지침으로 반영됩니다.</p>
      </section>
      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">1. 나는 누구인가</h2>
        <p className="mt-1 text-sm text-gray-600">기본 사실은 본인이 직접 확인해 저장합니다. 비어 있는 항목은 아바타가 알지 못한다고 취급합니다.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {BASIC_FIELDS.map(field => <label key={field.key} className="text-sm font-medium text-gray-700">{field.label}
            <textarea rows={field.key === 'biography' || field.key === 'relationships' ? 3 : 1} value={profileDraft[field.key] || ''} onChange={event => setProfileDraft(previous => ({ ...previous, [field.key]: event.target.value }))} className="mt-1 block w-full rounded-lg border border-gray-300 bg-white p-2 text-sm font-normal" />
          </label>)}
        </div>
        <button onClick={saveProfile} disabled={!!busy} className="mt-4 rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">기본 정보 저장</button>
      </section>
      <SelfSummaryPanel />
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">2. 나의 기준(판단 지침)</h2>
        <p className="text-sm text-gray-600">기준을 입력하면 저장과 동시에 다음 대화에 반영됩니다. 상황에 따라 달라지는 판단은 적용 조건도 함께 적으세요. 나중에 고치면 다시 반영됩니다.</p>
        {SECTION_INFO.map(info => {
          const item = state?.sections[info.key]
          return <article key={info.key} className="view-panel p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{info.title}</h3><span className="text-xs text-gray-500">마지막 반영: {date(item?.approved_at)}</span></div>
            <p className="mt-1 text-sm text-gray-600">{info.purpose}</p>
            <textarea rows={4} placeholder={info.example} value={drafts[info.key] || ''} onChange={event => setDrafts(previous => ({ ...previous, [info.key]: event.target.value }))} onBlur={() => { if (item?.approved !== (drafts[info.key] || '')) void saveSection(info.key) }} className="mt-3 w-full rounded-lg border border-gray-300 p-3 text-sm" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button onClick={() => saveSection(info.key)} disabled={!!busy} className="rounded-lg bg-gray-950 px-3 py-2 text-sm text-white disabled:opacity-50">지금 반영</button>
              <span className="text-xs text-gray-500">{item?.approved === (drafts[info.key] || '') ? '현재 아바타에 반영됨' : '입력칸을 벗어나면 자동 반영'}</span>
            </div>
          </article>
        })}
      </section>
      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">3. 대화를 통해 나를 알아가기</h2>
        <p className="mt-1 text-sm text-gray-600">내 발언은 대화와 동시에 KG에 자동 저장됩니다. 아바타 자신의 답은 내 사실로 학습하지 않습니다. 당시 상황이나 뜻은 나중에 고칠 수 있습니다.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-gray-600"><span className="rounded bg-gray-100 px-2 py-1">대화</span><span>→</span><span className="rounded bg-indigo-100 px-2 py-1 text-indigo-800">KG에 자동 저장</span><span>→</span><span className="rounded bg-gray-100 px-2 py-1">필요할 때 수정</span></div>
        <p className="mt-3 text-sm font-medium">최근 {recent.length}개 발언 중 {synced}개 KG 반영</p>
        <button onClick={() => { void refresh() }} className="mt-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs">최근 대화 새로고침</button>
        <div className="mt-3 space-y-3">
          {recent.map(item => <div key={item.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
            <div className="flex justify-between gap-2"><span className="text-xs text-gray-500">{date(item.created_at)}</span><span className={item.node_id ? 'text-green-700' : 'text-amber-700'}>{item.node_id ? 'KG에 자동 저장됨' : 'KG 반영 대기'}</span></div>
            <p className="mt-2 whitespace-pre-wrap text-gray-800">{item.content}</p>
            {item.node_id && <><textarea rows={2} value={conversationDraft[item.id] ?? item.corrected_text} onChange={event => setConversationDraft(previous => ({ ...previous, [item.id]: event.target.value }))} placeholder="필요하면 실제 의미나 적용 상황을 적으세요. 비우고 저장하면 원래 발언으로 돌아갑니다." className="mt-2 w-full rounded-lg border border-gray-300 bg-white p-2" /><button onClick={() => correctConversation(item)} disabled={!!busy} className="mt-2 rounded-lg border border-gray-300 px-3 py-2 disabled:opacity-50">이 사례 수정 반영</button></>}
          </div>)}
          {recent.length === 0 && <p className="text-sm text-gray-500">아직 기록된 사용자 대화가 없습니다. AI 대화 탭에서 대화하면 후보가 나타납니다.</p>}
        </div>
      </section>
      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">4. 꼭 기억할 사실</h2>
        <p className="mt-1 text-sm text-gray-600">항상 기억해야 하는 사실은 핵심 기억으로 저장됩니다. 추정이나 바뀔 수 있는 일정은 위 ‘기억의 갱신’ 기준에 출처와 확인 방법을 적으세요.</p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input value={newMemory} onChange={event => setNewMemory(event.target.value)} placeholder="예: 내가 가장 중요하게 여기는 원칙은…" className="min-w-0 flex-1 rounded-lg border border-gray-300 p-2 text-sm" />
          <button onClick={addMemory} disabled={!!busy || !newMemory.trim()} className="rounded-lg bg-gray-950 px-4 py-2 text-sm text-white disabled:opacity-50">핵심 기억 저장</button>
        </div>
      </section>
      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">5. 나와 비교해서 검증</h2>
        <p className="mt-1 text-sm text-gray-600">내가 실제로 답할 질문과 기대 답을 먼저 적습니다. 아바타 대화에서 같은 질문을 한 뒤 실제 답을 붙여넣고 통과 여부를 기록하세요.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <textarea rows={3} value={newQuestion} onChange={event => setNewQuestion(event.target.value)} placeholder="아바타에게 물어볼 질문" className="rounded-lg border border-gray-300 p-2 text-sm" />
          <textarea rows={3} value={newExpected} onChange={event => setNewExpected(event.target.value)} placeholder="내가 실제로 할 답과 판단 이유" className="rounded-lg border border-gray-300 p-2 text-sm" />
        </div>
        <button onClick={addEvaluation} disabled={!!busy || !newQuestion.trim() || !newExpected.trim()} className="mt-2 rounded-lg bg-gray-950 px-4 py-2 text-sm text-white disabled:opacity-50">비교 질문 저장</button>
        <div className="mt-4 space-y-3">
          {state?.evaluations.map(item => <div key={item.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
            <p className="font-semibold">{item.question}</p><p className="mt-1 text-gray-600">내 답: {item.expected}</p>
            <textarea rows={3} value={item.observed} onChange={event => editEvaluation(item.id, { observed: event.target.value })} placeholder="아바타의 실제 답을 붙여넣으세요" className="mt-2 w-full rounded-lg border border-gray-300 bg-white p-2" />
            <div className="mt-2 flex flex-wrap gap-2">
              <select value={item.result} onChange={event => editEvaluation(item.id, { result: event.target.value as Evaluation['result'] })} className="rounded-lg border border-gray-300 bg-white p-2"><option value="pending">미검증</option><option value="pass">일치</option><option value="fail">차이 발견</option></select>
              <button onClick={() => updateEvaluation(item)} disabled={!!busy} className="rounded-lg border border-gray-300 px-3 py-2 disabled:opacity-50">결과 저장</button>
              <button onClick={() => removeEvaluation(item.id)} disabled={!!busy} className="px-3 py-2 text-red-700 disabled:opacity-50">삭제</button>
            </div>
          </div>)}
          {state && state.evaluations.length === 0 && <p className="text-sm text-gray-500">아직 비교 질문이 없습니다.</p>}
        </div>
      </section>
      <LinkagePanel />
      <ScienceBasis interviewCount={interviewCount} evaluated={evaluated} passed={passed} userStatements={conversations.length} />
    </div>
  </div>
}
