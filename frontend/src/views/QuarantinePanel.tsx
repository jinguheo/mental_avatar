import { useEffect, useState } from 'react'
import { API_BASE } from '@/config'

type Item = { id: string; view: string; content: string; created_at: string; reason: string; reason_label: string; quarantined_at: string | null }
type CleanupResult = { quarantined: number; by_reason: Record<string, number>; user_nodes_removed: number; assistant_nodes_removed: number; dry_run: boolean; backup_dir: string | null }

const LABEL: Record<string, string> = { test: '실험 잔재', hallucination: '음성 인식 환각', echo: '아바타 에코', ambient: '주변 소리', garble: '반복 소음', trivial: '내용 없음' }
const VIEW: Record<string, string> = { avatar3d: '3D 아바타', avatar3d_chat: '리셉션 대화', realistic_avatar: '실사 아바타', ai_chat: 'AI 대화', stability_test: '실험' }

async function call(path: string, options?: RequestInit) {
  const response = await fetch(API_BASE + path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}

export default function QuarantinePanel() {
  const [items, setItems] = useState<Item[]>([])
  const [filter, setFilter] = useState('all')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<CleanupResult | null>(null)

  const load = () => call('/memory/quarantine').then(data => setItems(data.items || [])).catch(cause => setError(String(cause.message || cause)))
  useEffect(() => { void load() }, [])

  async function run(name: string, action: () => Promise<void>, message: string) {
    setBusy(name); setError(''); setNotice('')
    try { await action(); setNotice(message); await load() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy('') }
  }
  const restore = (id: string) => run(id, () => call('/memory/quarantine/' + encodeURIComponent(id) + '/restore', { method: 'POST' }), '복원했습니다. 다시 KG에 저장됐습니다.')
  const remove = (id: string) => run(id, () => call('/memory/quarantine/' + encodeURIComponent(id), { method: 'DELETE' }), '영구 삭제했습니다.')
  const removeAll = () => {
    if (!window.confirm('격리함의 ' + items.length + '건을 모두 영구 삭제할까요? 되돌릴 수 없습니다.')) return
    void run('all', () => call('/memory/quarantine', { method: 'DELETE' }), '격리함을 비웠습니다.')
  }
  const previewCleanup = () => run('preview', async () => setPreview(await call('/memory/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dry_run: true }) })), '미리보기를 만들었습니다.')
  const runCleanup = () => run('cleanup', async () => {
    const result: CleanupResult = await call('/memory/cleanup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dry_run: false }) })
    setPreview(null)
    setNotice('정리했습니다: 격리 ' + result.quarantined + '건, 아바타 답변 노드 ' + result.assistant_nodes_removed + '개를 KG에서 뺐습니다. 백업: ' + result.backup_dir)
  }, '')

  const reasons = Object.keys(LABEL).filter(key => items.some(item => item.reason === key))
  const shown = filter === 'all' ? items : items.filter(item => item.reason === filter)

  return <section className="view-panel p-4 sm:p-5">
    <h2 className="text-lg font-semibold">3-1. 기억 오염 정리 (자동 저장 + 격리함)</h2>
    <p className="mt-1 text-sm text-gray-600">내 발언은 자동으로 KG에 저장되고, 소음·환각·에코로 보이는 것만 <strong>저장 전에 격리</strong>합니다. 격리는 영구 삭제가 아니라 보관이며 하나씩 복원하거나 삭제할 수 있고, 격리된 발언은 말투 학습·대화 이어보기·“내 과거 대화 사례”에서도 빠집니다. 아바타 자신의 답은 KG에 넣지 않습니다.</p>
    <p className="mt-1 text-xs text-gray-500">판별 기준: 음성 인식이 무음에서 지어내는 문구(“다음 영상에서 만나요!”), 직전 아바타 답과 4글자 조각이 절반 이상 겹치는 에코, 같은 말 반복, 내가 타이핑한 문장 최대 길이(19어절)를 넘는 음성 문장(TV·영상 소리), 내용 없는 인사. 확실한 것만 격리하고 애매하면 통과시킵니다.</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button onClick={previewCleanup} disabled={!!busy} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">기존 대화 다시 점검(미리보기)</button>
      {preview && <button onClick={runCleanup} disabled={!!busy} className="rounded-lg bg-gray-950 px-3 py-2 text-sm text-white disabled:opacity-50">정리 실행 (백업 후)</button>}
      <button onClick={removeAll} disabled={!!busy || items.length === 0} className="rounded-lg px-3 py-2 text-sm text-red-700 disabled:opacity-50">격리함 비우기</button>
    </div>
    {preview && <p className="mt-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">미리보기: 격리 {preview.quarantined}건({Object.entries(preview.by_reason).map(([key, count]) => (LABEL[key] || key) + ' ' + count).join(', ') || '없음'}), 아바타 답변 노드 {preview.assistant_nodes_removed}개를 KG에서 뺍니다. 실행하면 DB·벡터를 먼저 백업합니다.</p>}
    {error && <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    {notice && <div role="status" className="mt-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">{notice}</div>}
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-gray-500">격리함 {items.length}건</span>
      <button onClick={() => setFilter('all')} className={'rounded px-2 py-1 ' + (filter === 'all' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700')}>전체</button>
      {reasons.map(key => <button key={key} onClick={() => setFilter(key)} className={'rounded px-2 py-1 ' + (filter === key ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700')}>{LABEL[key]} {items.filter(item => item.reason === key).length}</button>)}
    </div>
    <ul className="mt-2 max-h-96 space-y-1.5 overflow-y-auto text-sm">
      {shown.slice(0, 200).map(item => <li key={item.id} className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-gray-800">{item.content}</p>
          <p className="mt-0.5 text-xs text-gray-500">{item.reason_label || LABEL[item.reason]} · {VIEW[item.view] || item.view} · {item.created_at.slice(0, 16)}</p>
        </div>
        <button onClick={() => restore(item.id)} disabled={!!busy} className="whitespace-nowrap rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">복원</button>
        <button onClick={() => remove(item.id)} disabled={!!busy} className="whitespace-nowrap rounded px-2 py-1 text-xs text-red-700 disabled:opacity-50">삭제</button>
      </li>)}
      {shown.length === 0 && <li className="text-sm text-gray-500">격리된 발언이 없습니다.</li>}
      {shown.length > 200 && <li className="text-xs text-gray-500">처음 200건만 표시합니다. 사유 버튼으로 좁혀 보세요.</li>}
    </ul>
  </section>
}
