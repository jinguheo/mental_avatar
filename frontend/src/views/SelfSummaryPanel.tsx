import { useEffect, useState } from 'react'
import { API_BASE } from '@/config'

type SectionKey = 'work' | 'style' | 'traits' | 'values'
type Section = { section: SectionKey; title: string; draft: string; approved: string; evidence: Record<string, unknown>; updated_at: string | null; approved_at: string | null }
type Sample = { id: string; text: string; source: string; created_at: string }
type State = { sections: Record<SectionKey, Section>; samples: Sample[] }

const ORDER: SectionKey[] = ['work', 'style', 'traits', 'values']
const HOW: Record<SectionKey, string> = {
  work: '프로젝트 요약·KG 주제·읽은 자료를 근거로 로컬 LLM이 정리한 초안입니다. 근거에 없는 숫자가 있으면 아래에 표시합니다.',
  style: '내가 직접 타이핑한 문장 표본에서 통계로 뽑았습니다(LLM 없음). 음성 인식 기록은 소음·환각·에코가 많아 쓰지 않습니다.',
  traits: '내가 직접 입력한 값만 모았습니다. 작업 문서로 추정한 자동 성격은 타당도가 낮아 뺐습니다.',
  values: '내가 정한 기준과 자문자답 답만 모읍니다. 근거가 없으면 비워 두고 지어내지 않습니다.',
}

async function call(path: string, options?: RequestInit) {
  const response = await fetch(API_BASE + path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}

export default function SelfSummaryPanel() {
  const [state, setState] = useState<State | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  function apply(next: State) {
    setState(next)
    setDrafts(Object.fromEntries(ORDER.map(key => [key, next.sections[key].draft])))
  }
  useEffect(() => { call('/self_summary').then(apply).catch(cause => setError(String(cause.message || cause))) }, [])

  async function run(name: string, action: () => Promise<void>, message: string) {
    setBusy(name); setError(''); setNotice('')
    try { await action(); setNotice(message) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy('') }
  }
  const generate = () => run('generate', async () => apply(await call('/self_summary/generate', { method: 'POST' })), '초안을 새로 만들었습니다. 승인한 내용은 그대로입니다.')
  const approve = (key: SectionKey) => run(key, async () => {
    await call('/self_summary/' + key, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: drafts[key] || '' }) })
    apply(await call('/self_summary'))
  }, '승인했습니다. 다음 답변부터 모델 입력에 들어갑니다.')
  const revoke = (key: SectionKey) => run(key, async () => {
    await call('/self_summary/' + key + '/approval', { method: 'DELETE' })
    apply(await call('/self_summary'))
  }, '승인을 취소했습니다. 이 구역은 모델 입력에서 빠집니다.')
  const removeSample = (id: string) => run(id, async () => {
    await call('/self_summary/samples/' + encodeURIComponent(id), { method: 'DELETE' })
    apply(await call('/self_summary'))
  }, '표본을 지웠습니다. 초안을 다시 만들면 반영됩니다.')

  return <section className="view-panel p-4 sm:p-5">
    <h2 className="text-lg font-semibold">1-1. 통합 요약 (모델 입력으로 들어가는 정리본)</h2>
    <p className="mt-1 text-sm text-gray-600">질문마다 비슷한 조각을 검색해 나열하는 대신, 나에 대한 근거를 미리 정리한 요약을 매 답변의 입력 앞쪽에 항상 넣습니다. 초안은 근거에서 자동으로 만들고, <strong>내가 승인한 구역만</strong> 들어갑니다.</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <button onClick={generate} disabled={!!busy} className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy === 'generate' ? '초안 만드는 중… (약 1분)' : '초안 새로 만들기'}</button>
      <span className="text-xs text-gray-500">승인된 구역 {state ? ORDER.filter(key => state.sections[key].approved).length : 0} / {ORDER.length}</span>
    </div>
    {error && <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {notice && <div role="status" className="mt-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
    <div className="mt-4 space-y-3">
      {state && ORDER.map(key => {
        const item = state.sections[key]
        const approved = !!item.approved
        const changed = (drafts[key] || '') !== item.approved
        const unsupported = (item.evidence.unsupported_numbers as string[] | undefined) || []
        return <article key={key} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{item.title}</h3>
            <span className={'rounded px-2 py-0.5 text-xs font-medium ' + (approved ? (changed ? 'bg-amber-100 text-amber-800' : 'bg-green-100 text-green-800') : 'bg-gray-200 text-gray-700')}>{approved ? (changed ? '승인됨 · 수정 중' : '승인됨 · 입력에 반영') : (item.draft ? '초안 · 미반영' : '근거 없음')}</span>
          </div>
          <p className="mt-1 text-xs text-gray-500">{HOW[key]}</p>
          <textarea rows={key === 'work' ? 6 : 8} value={drafts[key] || ''} onChange={event => setDrafts(previous => ({ ...previous, [key]: event.target.value }))} placeholder={key === 'values' ? '아직 근거가 없습니다. 2번 기준이나 자문자답을 채우면 초안이 생깁니다. 직접 적어도 됩니다.' : '초안 새로 만들기를 누르세요.'} className="mt-2 w-full rounded-lg border border-gray-300 bg-white p-2 font-normal" />
          {unsupported.length > 0 && <p className="mt-1 text-xs text-red-700">근거에 없는 숫자: {unsupported.join(', ')} — 확인 후 고치세요.</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button onClick={() => approve(key)} disabled={!!busy || !(drafts[key] || '').trim()} className="rounded-lg bg-gray-950 px-3 py-1.5 text-white disabled:opacity-50">승인하고 입력에 반영</button>
            {approved && <button onClick={() => revoke(key)} disabled={!!busy} className="rounded-lg border border-gray-300 px-3 py-1.5 disabled:opacity-50">승인 취소</button>}
            <span className="text-xs text-gray-500">{item.approved_at ? '마지막 승인 ' + item.approved_at : item.updated_at ? '초안 ' + item.updated_at : ''}</span>
          </div>
          {key === 'work' && Array.isArray(item.evidence.projects) && <details className="mt-2 text-xs text-gray-600"><summary className="cursor-pointer">근거: 프로젝트 {(item.evidence.projects as unknown[]).length}개 · 모델 {String(item.evidence.model || '-')}</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">{(item.evidence.projects as { name: string; overview: string }[]).map(project => <li key={project.name}><strong>{project.name}</strong>: {project.overview}</li>)}</ul>
          </details>}
          {key === 'style' && <details className="mt-2 text-xs text-gray-600"><summary className="cursor-pointer">표본 {state.samples.length}개 (지우면 다음 초안에서 빠짐)</summary>
            <ul className="mt-1 space-y-0.5">{state.samples.map(sample => <li key={sample.id} className="flex items-start gap-2"><button onClick={() => removeSample(sample.id)} disabled={!!busy} aria-label="표본 삭제" className="text-red-600 disabled:opacity-50">✕</button><span>{sample.text}</span></li>)}</ul>
          </details>}
        </article>
      })}
    </div>
  </section>
}
