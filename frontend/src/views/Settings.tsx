import type { Settings } from '@/types'
import { claudeWebCaptureSession } from '@/services/claudeWeb'
import { useState, useEffect } from 'react'
import { API_BASE } from '@/config'

const API = API_BASE

interface Props {
  settings: Settings
  onChange: (s: Settings) => void
}

export default function SettingsView({ settings, onChange }: Props) {
  const [capturing, setCapturing] = useState(false)
  const [msg, setMsg] = useState('')
  const [profile, setProfile] = useState<Record<string, string>>({})
  const [options, setOptions] = useState<{
    speech_style?: string[]
    persona?: string[]
    language_tone?: string[]
    video?: Record<string, [string, string][]>
  }>({})
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const [profileMsg, setProfileMsg] = useState('')
  const [styleAnalyzing, setStyleAnalyzing] = useState(false)
  const [styleResult, setStyleResult] = useState<{
    ready: boolean
    count?: number
    message?: string
    suggestion?: { speech_style?: string; persona?: string; language_tone?: string }
    reason?: string
  } | null>(null)
  const [styleApplyMsg, setStyleApplyMsg] = useState('')

  // ── 기억 수명 주기 — 고정 / 활성 / 요약 / 보관을 사용자가 직접 관리 ──
  interface MemoryItem {
    id: string; content: string; summary?: string; is_pinned: boolean; memory_state: 'active' | 'summary' | 'archive'
    use_count: number; last_used_at?: string | null; last_reviewed_at?: string | null; review_after?: string | null; needs_review?: boolean
  }
  type MemoryDraft = Partial<MemoryItem> & { mark_reviewed?: boolean }
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([])
  const [memoryInput, setMemoryInput] = useState('')
  const [memoryPinned, setMemoryPinned] = useState(true)
  const [memoryDrafts, setMemoryDrafts] = useState<Record<string, MemoryDraft>>({})
  const [memoryBusy, setMemoryBusy] = useState(false)
  const fetchMemory = () => {
    fetch(`${API}/memory`).then(r => r.json()).then(d => setMemoryItems(d.items || [])).catch(() => {})
  }
  useEffect(() => { fetchMemory() }, [])
  const addMemory = async () => {
    const content = memoryInput.trim()
    if (!content || memoryBusy) return
    setMemoryBusy(true)
    try {
      await fetch(`${API}/memory`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, is_pinned: memoryPinned }),
      })
      setMemoryInput(''); setMemoryPinned(true); fetchMemory()
    } finally { setMemoryBusy(false) }
  }
  const deleteMemory = async (id: string) => {
    await fetch(`${API}/memory/${id}`, { method: 'DELETE' }).catch(() => {})
    fetchMemory()
  }
  const saveMemory = async (item: MemoryItem) => {
    const draft = memoryDrafts[item.id] || {}
    await fetch(`${API}/memory/${item.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
    }).catch(() => {})
    setMemoryDrafts(drafts => { const next = { ...drafts }; delete next[item.id]; return next })
    fetchMemory()
  }
  const refreshMemoryLifecycle = async () => {
    setMemoryBusy(true)
    try { await fetch(`${API}/memory/lifecycle/refresh`, { method: 'POST' }); fetchMemory() }
    finally { setMemoryBusy(false) }
  }

  useEffect(() => {
    fetch(`${API}/profile/me`).then(r => r.json()).then(d => {
      const flat: Record<string, string> = {}
      Object.entries(d.profile || {}).forEach(([k, v]: any) => { flat[k] = v.value || '' })
      setProfile(flat)
      setOptions(d.options || {})
      setDefaults(d.defaults || {})
    }).catch(() => {})
  }, [])

  const saveProfile = async () => {
    try {
      await fetch(`${API}/profile/me`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profile),
      })
      setProfileMsg('저장됐습니다')
      setTimeout(() => setProfileMsg(''), 2000)
    } catch { setProfileMsg('저장 실패') }
  }

  const setStyle = (key: string, val: string) =>
    setProfile(p => ({ ...p, [key]: p[key] === val ? '' : val }))

  // 기본값 옵션은 amber 링 + 점으로 표시 (선택된 옵션과 구분)
  const isDefault = (key: string, val: string) => defaults[key] === val
  const defaultRing = (key: string, val: string) =>
    isDefault(key, val) && profile[key] !== val ? 'ring-2 ring-offset-1 ring-amber-300' : ''
  const DefaultDot = ({ k, v }: { k: string; v: string }) =>
    isDefault(k, v) ? <span className="ml-1 text-amber-400" title="기본값">●</span> : null

  const analyzeStyle = async () => {
    setStyleAnalyzing(true)
    setStyleResult(null)
    setStyleApplyMsg('')
    try {
      const res = await fetch(`${API}/conversation/style_analysis`)
      setStyleResult(await res.json())
    } catch {
      setStyleResult({ ready: false, message: '분석 실패' })
    } finally {
      setStyleAnalyzing(false)
    }
  }

  const applyStyleSuggestion = async () => {
    if (!styleResult?.suggestion) return
    try {
      const res = await fetch(`${API}/conversation/style_apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(styleResult.suggestion),
      })
      const data = await res.json()
      const flat: Record<string, string> = {}
      Object.entries(data.profile || {}).forEach(([k, v]: any) => { flat[k] = v.value || '' })
      setProfile(flat)
      setStyleApplyMsg('적용됐습니다')
      setTimeout(() => setStyleApplyMsg(''), 2000)
    } catch {
      setStyleApplyMsg('적용 실패')
    }
  }

  const set = (k: keyof Settings, v: string) => onChange({ ...settings, [k]: v })

  const captureSession = async () => {
    setCapturing(true)
    setMsg('Claude.ai 탭에서 로그인 후 대기 중…')
    try {
      const key = await claudeWebCaptureSession(settings.mcpEndpoint)
      onChange({ ...settings, claudeSessionKey: key })
      setMsg('세션 캡처 완료!')
    } catch (e) {
      setMsg('실패: ' + (e instanceof Error ? e.message : String(e)))
    } finally {
      setCapturing(false)
    }
  }

  const inputCls = "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400 bg-white"
  const labelCls = "text-xs font-medium text-gray-600"

  return (
    <div className="p-8 max-w-lg space-y-6 h-full overflow-y-auto">
      <h2 className="text-base font-semibold text-gray-900">설정</h2>

      {/* 기억 수명 주기 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2"><label className={labelCls}>기억 관리</label><button onClick={refreshMemoryLifecycle} disabled={memoryBusy} className="text-xs text-gray-500 hover:text-gray-900 disabled:opacity-40">상태 정리</button></div>
        <p className="text-xs text-gray-400">고정 기억은 항상 입력합니다. 일반 기억은 사용·시간에 따라 활성 → 요약 → 보관으로 내려가며 원문은 삭제하지 않습니다.</p>
        <div className="flex gap-2">
          <input value={memoryInput} onChange={e => setMemoryInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addMemory()}
            placeholder="예: 나는 허진구 아바타입니다"
            className={inputCls} />
          <button onClick={addMemory} disabled={!memoryInput.trim() || memoryBusy}
            className="px-3 py-2 text-xs rounded-xl bg-gray-900 hover:bg-gray-700 text-white disabled:opacity-40 transition whitespace-nowrap">
            추가
          </button>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-gray-600"><input type="checkbox" checked={memoryPinned} onChange={e => setMemoryPinned(e.target.checked)} /> 항상 기억(고정)</label>
        {memoryItems.length > 0 && (
          <ul className="space-y-2">
            {memoryItems.map(m => (
              <li key={m.id} className="space-y-2 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2 text-sm text-gray-700">
                <div className="flex items-start gap-2"><span className="flex-1 leading-5">{m.content}</span><button onClick={() => deleteMemory(m.id)} className="text-gray-400 hover:text-red-500 text-xs shrink-0">삭제</button></div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <label className="flex items-center gap-1"><input type="checkbox" checked={memoryDrafts[m.id]?.is_pinned ?? m.is_pinned} onChange={e => setMemoryDrafts(d => ({ ...d, [m.id]: { ...d[m.id], is_pinned: e.target.checked } }))} /> 고정</label>
                  <select disabled={memoryDrafts[m.id]?.is_pinned ?? m.is_pinned} value={memoryDrafts[m.id]?.memory_state ?? m.memory_state} onChange={e => setMemoryDrafts(d => ({ ...d, [m.id]: { ...d[m.id], memory_state: e.target.value as MemoryItem['memory_state'] } }))} className="rounded border border-gray-200 bg-white px-1 py-0.5 disabled:opacity-40"><option value="active">활성</option><option value="summary">요약</option><option value="archive">보관</option></select>
                  <span className="text-gray-400">사용 {m.use_count || 0}회{m.last_used_at ? ` · 최근 ${m.last_used_at.slice(0, 10)}` : ''}</span>
                  {m.needs_review && <span className="text-amber-700">재확인 필요</span>}
                </div>
                <input value={memoryDrafts[m.id]?.summary ?? m.summary ?? ''} onChange={e => setMemoryDrafts(d => ({ ...d, [m.id]: { ...d[m.id], summary: e.target.value } }))} placeholder="요약 상태에서 LLM에 줄 짧은 요약" className="w-full rounded border border-gray-200 bg-white px-2 py-1 text-xs" />
                <div className="flex items-center gap-2 text-xs"><label className="text-gray-500">재확인일</label><input type="date" value={(memoryDrafts[m.id]?.review_after ?? m.review_after ?? '').slice(0, 10)} onChange={e => setMemoryDrafts(d => ({ ...d, [m.id]: { ...d[m.id], review_after: e.target.value } }))} className="rounded border border-gray-200 bg-white px-1 py-0.5" /><button onClick={() => setMemoryDrafts(d => ({ ...d, [m.id]: { ...d[m.id], mark_reviewed: true } }))} className="text-gray-500 hover:text-gray-900">오늘 확인</button><button onClick={() => saveMemory(m)} className="ml-auto rounded bg-gray-800 px-2 py-1 text-white hover:bg-gray-700">저장</button></div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-1.5">
        <label className={labelCls}>AI 제공자</label>
        <div className="flex gap-2">
          <button onClick={() => set('aiProvider', 'ollama')}
            className={`flex-1 py-2 text-sm rounded-xl border transition ${settings.aiProvider === 'ollama' ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-600 hover:border-gray-400'}`}>
            Ollama (로컬, 기본)
          </button>
          <button onClick={() => set('aiProvider', 'claude')}
            className={`flex-1 py-2 text-sm rounded-xl border transition ${settings.aiProvider === 'claude' ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-600 hover:border-gray-400'}`}>
            Claude.ai / API
          </button>
        </div>
      </div>

      {settings.aiProvider === 'ollama' && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className={labelCls}>Ollama 엔드포인트</label>
            <input value={settings.ollamaEndpoint} onChange={e => set('ollamaEndpoint', e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Ollama 모델</label>
            <input value={settings.ollamaModel} onChange={e => set('ollamaModel', e.target.value)} className={inputCls} />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <label className={labelCls}>MCP 엔드포인트 (my-dashboard MCP 서버)</label>
        <input
          value={settings.mcpEndpoint}
          onChange={e => set('mcpEndpoint', e.target.value)}
          className={inputCls}
        />
        <p className="text-xs text-gray-400">my-dashboard 없이 Claude API 직접 사용 시 비워두세요</p>
      </div>

      <div className="space-y-1.5">
        <label className={labelCls}>Claude.ai 세션 키</label>
        <div className="flex gap-2">
          <input
            value={settings.claudeSessionKey}
            onChange={e => set('claudeSessionKey', e.target.value)}
            placeholder="sk-ant-…"
            className="flex-1 border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400 bg-white placeholder-gray-300"
          />
          <button onClick={captureSession} disabled={capturing}
            className="px-3 py-2 text-xs rounded-xl bg-gray-900 hover:bg-gray-700 text-white disabled:opacity-40 transition whitespace-nowrap">
            {capturing ? '대기 중…' : '자동 캡처'}
          </button>
        </div>
        {msg && <p className={`text-xs ${msg.includes('완료') ? 'text-green-600' : 'text-red-500'}`}>{msg}</p>}
      </div>

      <div className="space-y-1.5">
        <label className={labelCls}>Anthropic API Key (선택 — MCP 미사용 시)</label>
        <input
          type="password"
          value={settings.anthropicApiKey}
          onChange={e => set('anthropicApiKey', e.target.value)}
          placeholder="sk-ant-api03-…"
          className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-900 outline-none focus:border-gray-400 bg-white placeholder-gray-300"
        />
      </div>

      {/* 아바타 말투 & 성격 */}
      <div className="space-y-4 pt-2 border-t border-gray-100">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-800">아바타 말투 & 성격</h3>
          <span className="text-xs text-gray-400 flex items-center gap-1">
            <span className="text-amber-400">●</span> 기본값
          </span>
        </div>

        {/* 말투 */}
        <div className="space-y-2">
          <label className={labelCls}>말투 스타일</label>
          <div className="flex flex-wrap gap-2">
            {(options.speech_style || []).map(opt => (
              <button key={opt} onClick={() => setStyle('speech_style', opt)}
                className={`px-3 py-1.5 text-xs rounded-full border transition ${defaultRing('speech_style', opt)} ${
                  profile.speech_style === opt
                    ? 'bg-gray-900 text-white border-gray-900'
                    : 'border-gray-200 text-gray-600 hover:border-gray-400'
                }`}>{opt}<DefaultDot k="speech_style" v={opt} /></button>
            ))}
          </div>
        </div>

        {/* 성격 */}
        <div className="space-y-2">
          <label className={labelCls}>성격 / 페르소나</label>
          <div className="flex flex-wrap gap-2">
            {(options.persona || []).map(opt => (
              <button key={opt} onClick={() => setStyle('persona', opt)}
                className={`px-3 py-1.5 text-xs rounded-full border transition ${defaultRing('persona', opt)} ${
                  profile.persona === opt
                    ? 'bg-indigo-600 text-white border-indigo-600'
                    : 'border-gray-200 text-gray-600 hover:border-gray-400'
                }`}>{opt}<DefaultDot k="persona" v={opt} /></button>
            ))}
          </div>
        </div>

        {/* 톤 */}
        <div className="space-y-2">
          <label className={labelCls}>언어 톤</label>
          <div className="flex flex-wrap gap-2">
            {(options.language_tone || []).map(opt => (
              <button key={opt} onClick={() => setStyle('language_tone', opt)}
                className={`px-3 py-1.5 text-xs rounded-full border transition ${defaultRing('language_tone', opt)} ${
                  profile.language_tone === opt
                    ? 'bg-emerald-600 text-white border-emerald-600'
                    : 'border-gray-200 text-gray-600 hover:border-gray-400'
                }`}>{opt}<DefaultDot k="language_tone" v={opt} /></button>
            ))}
          </div>
        </div>

        {/* 이름/전문분야 */}
        <div className="grid grid-cols-2 gap-3">
          {[['name','이름'],['expertise','전문 분야'],['role','역할/직책'],['goals','현재 목표']].map(([k, label]) => (
            <div key={k} className="space-y-1">
              <label className={labelCls}>{label}</label>
              <input value={profile[k] || ''} onChange={e => setProfile(p => ({...p, [k]: e.target.value}))}
                className={inputCls} placeholder={label} />
            </div>
          ))}
        </div>

        {/* 영상 스타일 */}
        <div className="space-y-3 pt-3 border-t border-gray-100">
          <h4 className="text-xs font-semibold text-gray-700">영상 생성 스타일</h4>
          {Object.entries(options.video || {}).map(([key, choices]) => (
            <div key={key} className="space-y-1.5">
              <label className={labelCls}>{{
                video_still: '움직임 모드',
                video_preprocess: '이미지 전처리',
                video_enhancer: '얼굴 화질 향상',
                video_size: '출력 해상도',
                video_expression_scale: '표정 강도',
              }[key] ?? key}</label>
              <div className="flex flex-wrap gap-2">
                {choices.map(([label, val]) => (
                  <button key={val} onClick={() => setStyle(key, val)}
                    className={`px-3 py-1.5 text-xs rounded-full border transition ${defaultRing(key, val)} ${
                      profile[key] === val
                        ? 'bg-orange-500 text-white border-orange-500'
                        : 'border-gray-200 text-gray-600 hover:border-gray-400'
                    }`}>{label}<DefaultDot k={key} v={val} /></button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <button onClick={saveProfile}
          className="w-full py-2 rounded-xl bg-gray-900 text-white text-sm hover:bg-gray-700 transition">
          프로파일 저장
        </button>
        {profileMsg && <p className={`text-xs text-center ${profileMsg.includes('저장됐') ? 'text-green-600' : 'text-red-500'}`}>{profileMsg}</p>}
      </div>

      {/* 말투 학습 */}
      <div className="space-y-3 pt-2 border-t border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800">말투 학습</h3>
        <p className="text-xs text-gray-400">최근 대화에서 내 말투/성격/톤을 분석해 프로파일에 반영할 수 있습니다.</p>
        <button onClick={analyzeStyle} disabled={styleAnalyzing}
          className="w-full py-2 rounded-xl bg-gray-900 text-white text-sm hover:bg-gray-700 disabled:opacity-40 transition">
          {styleAnalyzing ? '분석 중…' : '최근 대화 분석하기'}
        </button>

        {styleResult && !styleResult.ready && (
          <p className="text-xs text-gray-400">{styleResult.message}</p>
        )}

        {styleResult?.ready && styleResult.suggestion && (
          <div className="p-3 bg-gray-50 border border-gray-200 rounded-xl space-y-2 text-xs text-gray-600">
            <p className="text-gray-400">최근 대화 {styleResult.count}개 분석 결과</p>
            <ul className="space-y-1">
              {styleResult.suggestion.speech_style && <li>말투: <span className="font-medium text-gray-900">{styleResult.suggestion.speech_style}</span></li>}
              {styleResult.suggestion.persona && <li>성격: <span className="font-medium text-gray-900">{styleResult.suggestion.persona}</span></li>}
              {styleResult.suggestion.language_tone && <li>톤: <span className="font-medium text-gray-900">{styleResult.suggestion.language_tone}</span></li>}
            </ul>
            {styleResult.reason && <p className="text-gray-400">{styleResult.reason}</p>}
            <button onClick={applyStyleSuggestion}
              className="w-full py-1.5 rounded-xl bg-indigo-600 text-white text-xs hover:bg-indigo-500 transition">
              프로파일에 적용
            </button>
            {styleApplyMsg && <p className={`text-xs text-center ${styleApplyMsg.includes('적용됐') ? 'text-green-600' : 'text-red-500'}`}>{styleApplyMsg}</p>}
          </div>
        )}
      </div>

      {/* 백업 / 복원 */}
      <BackupRestoreSection />

      <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl text-xs text-gray-500 space-y-1">
        <p>API 서버: <span className="text-gray-700 font-medium">{API}</span></p>
        <p>설정은 브라우저 localStorage에 저장됩니다.</p>
      </div>
    </div>
  )
}

function BackupRestoreSection() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [msg, setMsg] = useState('')
  const [restoreStatus, setRestoreStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle')
  const [restoreMsg, setRestoreMsg] = useState('')

  const handleExport = async () => {
    setStatus('loading')
    setMsg('')
    try {
      const res = await fetch(`${API}/backup`, { signal: AbortSignal.timeout(60000) })
      if (!res.ok) throw new Error(`서버 오류 (${res.status})`)
      const payload = await res.json()

      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `mental-avatar-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)

      const fileCount = Array.isArray(payload.data_files) ? payload.data_files.length : 0
      setStatus('ok')
      setMsg(`백업 완료: DB${payload.db_base64 ? ' 포함' : ' 없음'}, 얼굴/음성 파일 ${fileCount}개`)
    } catch (e) {
      setStatus('error')
      setMsg(e instanceof Error ? e.message : '백업 실패')
    }
  }

  const handleRestore = async (file: File | undefined) => {
    if (!file) return
    if (!window.confirm('현재 DB를 백업 파일 내용으로 덮어씁니다. 계속할까요? (복원 직전 상태는 서버에 자동 백업됩니다)')) {
      return
    }
    setRestoreStatus('loading')
    setRestoreMsg('')
    try {
      const payload = JSON.parse(await file.text())
      const res = await fetch(`${API}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(60000),
      })
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error(data.error || `서버 오류 (${res.status})`)

      setRestoreStatus('ok')
      setRestoreMsg(`복원 완료: ${(data.restored || []).length}개 항목 적용. 복원 전 상태: ${data.backup_dir || '-'}`)
    } catch (e) {
      setRestoreStatus('error')
      setRestoreMsg(e instanceof Error ? `복원 실패: ${e.message}` : '복원 실패: 올바른 백업 JSON 파일인지 확인하세요.')
    }
  }

  return (
    <div className="space-y-4 pt-2 border-t border-gray-100">
      <h3 className="text-sm font-semibold text-gray-800">백업 / 복원</h3>
      <p className="text-xs text-gray-400">
        지식그래프 DB와 등록된 얼굴/음성 파일을 하나의 JSON 파일로 내보내거나, 그 파일로 복원합니다.
        (얼굴 트래킹·발표 산출물 같은 재생성 가능한 임시 파일은 제외됩니다. 매시간 자동 백업도 별도로 서버에 보관됩니다.)
      </p>

      <div className="flex items-center gap-3">
        <button onClick={handleExport} disabled={status === 'loading'}
          className="px-4 py-2 bg-gray-900 hover:bg-gray-700 text-white text-xs font-semibold rounded-xl disabled:opacity-40 transition">
          {status === 'loading' ? '내보내는 중…' : '백업하기 (JSON 다운로드)'}
        </button>
        {msg && <span className={`text-xs ${status === 'error' ? 'text-red-500' : 'text-green-600'}`}>{msg}</span>}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-gray-700">백업 파일에서 복원하기</p>
        <label className="block">
          <input type="file" accept="application/json,.json"
            onChange={e => handleRestore(e.target.files?.[0])}
            disabled={restoreStatus === 'loading'}
            className="block w-full text-sm text-gray-600 file:mr-4 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-xs file:font-medium file:text-gray-700 hover:file:bg-gray-200 disabled:opacity-40" />
        </label>
        {restoreMsg && (
          <p className={`text-xs ${restoreStatus === 'error' ? 'text-red-500' : 'text-green-600'}`}>{restoreMsg}</p>
        )}
        {restoreStatus === 'ok' && (
          <button onClick={() => window.location.reload()}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-lg transition">
            지금 새로고침
          </button>
        )}
      </div>
    </div>
  )
}
