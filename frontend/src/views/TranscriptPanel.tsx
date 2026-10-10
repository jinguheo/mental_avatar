import { useEffect, useState } from 'react'
import { API_BASE } from '@/config'

type Status = {
  running: boolean; phase: string; last_run: string | null; last_error: string | null
  sessions: number; backup_mb: number; backup_dir: string
  messages_total: number; kg_saved: number; pending: number
  by_label: Record<string, number>; by_project: { project: string; n: number; saved: number | null }[]
  decision_pairs: number; decision_pairs_with_context: number
  codex_sessions: number; by_source: Record<string, number>
}
type Excluded = { key: string; view: string; created_at: string | null; text: string; label: string; source: string; project: string; session: string; source_file: string | null; backup_file: string | null }
const SOURCE: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' }

const KEEP = ['기준', '사실', '목표', '결정']
const SKIP = ['지시', '반응', '질문', '잡담']

async function call(path: string, options?: RequestInit) {
  const response = await fetch(API_BASE + path, options)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '요청 실패')
  return data
}

export default function TranscriptPanel() {
  const [status, setStatus] = useState<Status | null>(null)
  const [items, setItems] = useState<Excluded[]>([])
  const [label, setLabel] = useState('')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = () => Promise.all([
    call('/transcripts/status').then(setStatus),
    call('/transcripts/excluded?limit=60' + (saved ? '&saved=1' : '') + (label && !saved ? '&label=' + encodeURIComponent(label) : '')).then(data => setItems(data.items || [])),
  ]).catch(cause => setError(String(cause.message || cause)))
  useEffect(() => { void load() }, [label, saved])
  useEffect(() => {
    const timer = window.setInterval(() => { call('/transcripts/status').then(setStatus).catch(() => undefined) }, 10000)
    return () => window.clearInterval(timer)
  }, [])

  async function promote(key: string) {
    setBusy(key); setError('')
    try { await call('/transcripts/promote/' + encodeURIComponent(key), { method: 'POST' }); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy('') }
  }

  const label_count = (name: string) => status?.by_label[name] ?? 0
  return <section className="view-panel p-4 sm:p-5">
    <h2 className="text-lg font-semibold">3-2. 대화 자동 기록 (모든 Claude Code·Codex 창)</h2>
    <p className="mt-1 text-sm text-gray-600">Claude Code와 Codex 모든 창의 대화 원본을 백업하고, 내가 쓴 메시지 중 <strong>오래 남길 것(기준·사실·목표·결정)만</strong> KG에 저장합니다. 한 번 시키는 작업 지시, 상태 보고, 질문, 맞장구는 KG에 넣지 않고 원본과 판단 사례에만 남깁니다. 제외한 것은 아래에서 보고 직접 KG에 넣을 수 있습니다.</p>
    <ol className="mt-2 list-decimal space-y-0.5 pl-5 text-xs text-gray-600">
      <li>원본 백업: Claude Code·Codex의 모든 대화 파일을 그대로 복사합니다(원본이 지워져도 남음). Codex는 승인 심사용 보조 세션과 지침 문서를 뺍니다.</li>
      <li>내가 쓴 글만 추출: 도구 출력·시스템 알림·붙여넣은 긴 글은 뺍니다.</li>
      <li>오염 필터: 내용 없음·반복·붙여넣기·로그는 규칙으로 제외합니다.</li>
      <li>종류 판정: 로컬 모델이 기준·사실·목표·결정·지시·반응·질문·잡담으로 나누고, 선호를 나타내는 표현이 뚜렷하면 모델이 놓쳐도 남깁니다.</li>
      <li>직전 Claude 발화와 내 답을 짝으로 저장합니다(내 입력 예측·일치 측정용 판단 사례).</li>
    </ol>
    {status && <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3"><p className="text-xs text-gray-500">백업</p><p className="font-semibold">Claude {status.sessions}개 · Codex {status.codex_sessions}개 세션 · {status.backup_mb} MB</p></div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3"><p className="text-xs text-gray-500">내가 쓴 메시지</p><p className="font-semibold">{status.messages_total}건 (분류 대기 {status.pending})</p></div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3"><p className="text-xs text-gray-500">KG에 저장</p><p className="font-semibold">{status.kg_saved}건 <span className="text-xs font-normal text-gray-500">({KEEP.map(name => name + ' ' + label_count(name)).join(' · ')})</span></p></div>
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3"><p className="text-xs text-gray-500">판단 사례(맥락→내 답)</p><p className="font-semibold">{status.decision_pairs}건 <span className="text-xs font-normal text-gray-500">맥락 있음 {status.decision_pairs_with_context}</span></p></div>
    </div>}
    {status && <p className="mt-2 text-xs text-gray-500">
      {status.running ? '실행 중: ' + status.phase : '대기 중'}{status.last_run && ' · 마지막 실행 ' + status.last_run} · 백업 위치 {status.backup_dir}
      {status.last_error && <span className="text-red-700"> · 오류 {status.last_error}</span>}
    </p>}
    {error && <div role="alert" className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
      <button onClick={() => setSaved(false)} className={'rounded px-2 py-1 ' + (!saved ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700')}>KG에서 제외한 것</button>
      <button onClick={() => setSaved(true)} className={'rounded px-2 py-1 ' + (saved ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700')}>KG에 저장한 것</button>
      {status && <span className="text-gray-500">출처별 {Object.entries(status.by_source || {}).map(([key, count]) => (SOURCE[key] || key) + ' ' + count).join(' · ')}</span>}
      {!saved && <button onClick={() => setLabel('')} className={'rounded px-2 py-1 ' + (label === '' ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700')}>전체</button>}
      {!saved && SKIP.map(name => <button key={name} onClick={() => setLabel(name)} className={'rounded px-2 py-1 ' + (label === name ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700')}>{name} {label_count(name)}</button>)}
    </div>
    <ul className="mt-2 max-h-96 space-y-1.5 overflow-y-auto text-sm">
      {items.map(item => <li key={item.key} className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-gray-800">{item.text.length > 220 ? item.text.slice(0, 220) + '…' : item.text}</p>
          <p className="mt-0.5 text-xs text-gray-500">{item.label} · {SOURCE[item.source] || item.source} · {item.view.replace(/^(cc|cx)_/, '')} · {(item.created_at || '').slice(0, 16)}</p>
          <details className="text-xs text-gray-500"><summary className="cursor-pointer">출처 자세히</summary>
            <p className="break-all">세션 ID {item.session}</p>
            <p className="break-all">원본 {item.source_file}</p>
            <p className="break-all">백업 {item.backup_file}</p>
          </details>
        </div>
        {!saved && <button onClick={() => promote(item.key)} disabled={!!busy} className="whitespace-nowrap rounded border border-gray-300 px-2 py-1 text-xs disabled:opacity-50">KG에 넣기</button>}
      </li>)}
      {items.length === 0 && <li className="text-sm text-gray-500">{saved ? '아직 저장된 메시지가 없습니다.' : '제외된 메시지가 없습니다.'}</li>}
    </ul>
  </section>
}
