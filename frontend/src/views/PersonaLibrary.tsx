import { useEffect, useMemo, useState } from 'react'
import { API_BASE } from '@/config'

type Person = { id: string; name: string; docs: number; chars: number; policy?: { label: string; mode: string } }
type Status = { people: Person[]; historical_five?: string[] }
type Material = { id: string; title: string; kind: string; source?: string; chars?: number; used_by_questions: number; available: boolean }
type Evidence = { tier: string }
type Answer = { qid: string; domain: string; evidence: Evidence[] }
type Axis = { name: string; score: number; confidence: number; summary: string; qids: string[] }
type Profile = { ready: boolean; axes?: Axis[]; mbti?: { type: string; confidence: number; reason: string }; personality?: string; expertise?: string; disclaimer?: string; generated_at?: string }

async function get(path: string) {
  const response = await fetch(API_BASE + path)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}
async function post(path: string, body: object) {
  const response = await fetch(API_BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '저장하지 못했습니다')
  return data
}
function radarPoints(axes: Axis[], size = 250) {
  const center = size / 2, radius = size * 0.36
  return axes.map((axis, index) => {
    const angle = -Math.PI / 2 + Math.PI * 2 * index / Math.max(axes.length, 1)
    const value = Math.max(0, Math.min(100, axis.score)) / 100
    return `${center + Math.cos(angle) * radius * value},${center + Math.sin(angle) * radius * value}`
  }).join(' ')
}
function Guide({ axes }: { axes: Axis[] }) {
  const size = 250, c = size / 2, r = size * 0.36
  return <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto w-full max-w-[330px]" role="img" aria-label="성향 추정 거미줄">
    {[.25, .5, .75, 1].map(level => <polygon key={level} points={axes.map((_, i) => { const a = -Math.PI / 2 + Math.PI * 2 * i / axes.length; return `${c + Math.cos(a) * r * level},${c + Math.sin(a) * r * level}` }).join(' ')} fill="none" stroke="#dbeafe" strokeWidth="1" />)}
    {axes.map((axis, i) => { const a = -Math.PI / 2 + Math.PI * 2 * i / axes.length; const x = c + Math.cos(a) * r; const y = c + Math.sin(a) * r; return <g key={axis.name}><line x1={c} y1={c} x2={x} y2={y} stroke="#dbeafe" /><text x={c + Math.cos(a) * (r + 20)} y={c + Math.sin(a) * (r + 20)} textAnchor="middle" dominantBaseline="middle" fontSize="9" fill="#334155">{axis.name.replace('·', ' ')}</text></g> })}
    <polygon points={radarPoints(axes, size)} fill="rgba(79,70,229,.22)" stroke="#4f46e5" strokeWidth="2" />
  </svg>
}

export default function PersonaLibrary() {
  const [status, setStatus] = useState<Status | null>(null)
  const [who, setWho] = useState('buffett')
  const [materials, setMaterials] = useState<Material[]>([])
  const [answers, setAnswers] = useState<Answer[]>([])
  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState('')
  const [axis, setAxis] = useState('')
  const [feedback, setFeedback] = useState('')
  const [reviewer, setReviewer] = useState('사용자')
  const [relation, setRelation] = useState('페르소나 검토')
  const [perspective, setPerspective] = useState<'self' | 'other'>('self')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  useEffect(() => { void get('/persona/status').then(setStatus).catch(cause => setError(String(cause.message || cause))) }, [])
  useEffect(() => { void Promise.all([get('/persona/qbank/materials/' + who), get('/persona/qbank/answers/' + who), get('/persona/qbank/profile/' + who)])
    .then(([m, a, p]) => { setMaterials(m.materials || []); setAnswers(a.rows || []); setProfile(p) }).catch(cause => setError(String(cause.message || cause))) }, [who])
  const person = status?.people.find(item => item.id === who)
  const verified = useMemo(() => answers.filter(row => row.evidence.some(item => item.tier === 'own' || item.tier === 'reported')).length, [answers])
  const estimated = useMemo(() => answers.filter(row => row.evidence.some(item => item.tier === 'estimate')).length, [answers])
  const byKind = useMemo(() => Object.entries(materials.reduce<Record<string, number>>((out, item) => ({ ...out, [item.kind]: (out[item.kind] || 0) + 1 }), {})), [materials])
  useEffect(() => { setAxis(profile?.axes?.[0]?.name || ''); setFeedback(''); setNotice('') }, [who, profile?.generated_at])
  useEffect(() => {
    setReviewer(perspective === 'self' ? '본인' : '제3자 검토자')
    setRelation(perspective === 'self' ? '당사자 자기 확인' : '가족·동료·지인의 관찰')
  }, [perspective])
  async function saveFeedback() {
    const selected = profile?.axes?.find(item => item.name === axis)
    const qid = selected?.qids?.[0]
    if (!qid || !feedback.trim()) { setError('수정할 성향 축과 구체적인 의견을 입력해 주세요.'); return }
    setSaving(true); setError(''); setNotice('')
    try {
      await post('/persona/qbank/review/' + who, { qid, key: 'profile-' + axis, reviewer, relation, verdict: 'added', text: feedback.trim() })
      const updated = await post('/persona/qbank/profile/' + who, { fallback_only: true }) as Profile
      setProfile(updated); setFeedback(''); setNotice('의견을 근거로 저장하고 성향 초안을 다시 만들었습니다. 다음 대화부터 지식 DB에도 반영됩니다.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  return <div className="view-canvas h-full overflow-y-auto"><div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
    <header className="view-header -mx-4 -mt-5 border-x-0 px-4 py-4 sm:-mx-6 sm:px-6"><p className="dashboard-kicker">11명 페르소나 자료실 · 수정 가능한 추정</p><h1 className="mt-1 text-xl font-semibold text-gray-950">인물 지식</h1><p className="mt-1 text-sm text-gray-600">인물별 원문 자료, 질문은행 답변, 추정 프로필과 성향 레이더를 한 곳에서 확인합니다. 레이더는 확정 성격 검사가 아니라 자료 기반 초기 추정입니다.</p></header>
    <div className="flex flex-wrap gap-2">{status?.people.map(item => <button key={item.id} onClick={() => setWho(item.id)} className={'rounded-full border px-3 py-1.5 text-sm ' + (item.id === who ? 'border-violet-700 bg-violet-700 text-white' : 'border-gray-300 bg-white text-gray-700')}>{item.name}</button>)}</div>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{notice}</p>}
    <section className="grid gap-3 sm:grid-cols-4"><article className="view-panel p-3"><p className="text-xs text-gray-500">수집 자료</p><strong className="mt-1 block text-xl">{materials.length}건</strong><p className="mt-1 text-xs text-gray-500">{person?.policy?.label}</p></article><article className="view-panel p-3"><p className="text-xs text-gray-500">질문은행</p><strong className="mt-1 block text-xl">{answers.length}/78</strong><p className="mt-1 text-xs text-gray-500">자료·추정 답변 포함</p></article><article className="view-panel p-3"><p className="text-xs text-gray-500">원문 확인</p><strong className="mt-1 block text-xl text-emerald-700">{verified}</strong><p className="mt-1 text-xs text-gray-500">본인 글·발언 또는 기록</p></article><article className="view-panel p-3"><p className="text-xs text-gray-500">초기 추정</p><strong className="mt-1 block text-xl text-amber-700">{estimated}</strong><p className="mt-1 text-xs text-gray-500">나중에 근거로 수정 가능</p></article></section>
    <div className="grid gap-4 lg:grid-cols-2"><section className="view-panel p-4"><h2 className="text-lg font-semibold">성격·성향 거미줄</h2>{profile?.ready && profile.axes ? <><Guide axes={profile.axes} /><p className="text-sm"><strong>MBTI 가설:</strong> {profile.mbti?.type === 'unknown' ? '판단 보류' : profile.mbti?.type} <span className="text-xs text-gray-500">신뢰 {profile.mbti?.confidence ?? 0}%</span></p><p className="mt-1 text-xs text-gray-600">{profile.mbti?.reason}</p></> : <p className="mt-3 text-sm text-gray-500">프로필을 불러오는 중입니다.</p>}</section>
      <section className="view-panel p-4"><h2 className="text-lg font-semibold">이 인물의 페르소나</h2><p className="mt-3 text-sm leading-6 text-gray-700">{profile?.personality}</p><p className="mt-3 text-sm leading-6 text-gray-700"><strong>전문·활동 영역:</strong> {profile?.expertise}</p><p className="mt-4 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">{profile?.disclaimer}</p></section></div>
    <section className="view-panel p-4"><h2 className="text-lg font-semibold">12개 성향 축과 근거</h2><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{profile?.axes?.map(axis => <article key={axis.name} className="rounded-lg border border-violet-100 bg-violet-50/40 p-3"><div className="flex justify-between gap-2"><strong className="text-sm">{axis.name}</strong><span className="text-sm text-violet-800">{axis.score}/100</span></div><p className="mt-1 text-xs text-gray-500">근거 신뢰 {axis.confidence}% · {axis.qids.join(', ') || '근거 보류'}</p><p className="mt-2 text-xs leading-5 text-gray-700">{axis.summary}</p></article>)}</div></section>
    <section className="view-panel p-4"><h2 className="text-lg font-semibold">사용해 보며 성향 다듬기</h2><p className="mt-1 text-sm text-gray-600">한 번 추정하고 끝내지 않습니다. ① 실제 대화에서 답을 확인하고 ② 본인 또는 그 사람을 아는 사람이 수정 의견을 남기고 ③ 의견을 새 근거로 저장해 레이더와 다음 답변을 갱신합니다.</p><div className="mt-3 flex flex-wrap gap-2"><button onClick={() => setPerspective('self')} className={'rounded-lg border px-3 py-1.5 text-sm ' + (perspective === 'self' ? 'border-violet-700 bg-violet-700 text-white' : 'border-gray-300 bg-white')}>본인 관점으로 확인</button><button onClick={() => setPerspective('other')} className={'rounded-lg border px-3 py-1.5 text-sm ' + (perspective === 'other' ? 'border-violet-700 bg-violet-700 text-white' : 'border-gray-300 bg-white')}>가족·동료 관점으로 검토</button></div><p className="mt-2 text-xs text-gray-500">{perspective === 'self' ? '당사자가 직접 “이 판단은 내 기준과 맞다/다르다”를 확인하는 의견입니다.' : '가족·동료·지인이 관찰한 사례를 추가합니다. 관찰 의견은 본인 확인과 구분되어 남습니다.'}</p><div className="mt-3 grid gap-2 sm:grid-cols-[12rem_1fr]"><select value={axis} onChange={event => setAxis(event.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">{profile?.axes?.map(item => <option key={item.name}>{item.name}</option>)}</select><textarea value={feedback} onChange={event => setFeedback(event.target.value)} rows={3} placeholder="예: 중요한 결정을 할 때 속도보다 충분한 검토와 구성원의 신뢰를 우선했다는 기록을 더 반영해 주세요." className="rounded-lg border border-gray-300 p-2 text-sm" /></div><div className="mt-2 flex flex-wrap gap-2"><input value={reviewer} onChange={event => setReviewer(event.target.value)} aria-label="검토자" className="w-28 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /><input value={relation} onChange={event => setRelation(event.target.value)} aria-label="관계" className="w-44 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" /><button onClick={() => void saveFeedback()} disabled={saving || !feedback.trim()} className="rounded-lg bg-violet-700 px-3 py-1.5 text-sm text-white disabled:opacity-50">{saving ? '반영 중…' : '의견 저장·프로필 갱신'}</button></div><p className="mt-2 text-xs text-gray-500">검토 의견은 ‘리뷰 반영’ 근거로 남으며, 원래 자료와 추정 기록은 지우지 않습니다.</p></section>
    <section className="view-panel p-4"><h2 className="text-lg font-semibold">자료 위치와 구성</h2><p className="mt-1 text-sm text-gray-600">{who} · 자료 유형: {byKind.map(([kind, count]) => kind + ' ' + count + '건').join(' · ')}</p><div className="mt-3 max-h-80 space-y-2 overflow-y-auto">{materials.map(item => <article key={item.id} className="rounded-lg border border-gray-200 p-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><strong>{item.title}</strong><span className="text-xs text-gray-500">{item.kind} · 질문에서 {item.used_by_questions}회 사용</span></div><p className="mt-1 text-xs text-gray-500">저장됨 {item.available ? '✓' : '—'} · {Math.round((item.chars || 0) / 1000)}천자</p>{item.source && <a href={item.source} target="_blank" rel="noreferrer" className="mt-1 block break-all text-xs text-indigo-700 underline">원문</a>}</article>)}</div></section>
  </div></div>
}
