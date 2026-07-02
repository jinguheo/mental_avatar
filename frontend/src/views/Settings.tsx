import type { Settings } from '@/types'
import { claudeWebCaptureSession } from '@/services/claudeWeb'
import { useState, useEffect } from 'react'

const API = 'http://127.0.0.1:8766'

const TRAIT_DEFS = [
  { key: 'openness',          label: '개방성' },
  { key: 'conscientiousness', label: '성실성' },
  { key: 'extraversion',      label: '외향성' },
  { key: 'agreeableness',     label: '친화성' },
  { key: 'stability',         label: '정서안정성' },
]

interface RadarData {
  axes: string[]
  keys: string[]
  manual: number[]
  auto: number[]
  manual_set: boolean[]
  auto_set: boolean[]
  diff: (number | null)[]
  auto_at: string
}

function RadarChart({ data }: { data: RadarData }) {
  const size = 240, center = size / 2, maxR = size / 2 - 30
  const n = data.axes.length
  const angle = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n
  const pt = (i: number, val: number): [number, number] => {
    const r = (Math.max(0, Math.min(100, val)) / 100) * maxR
    return [center + r * Math.cos(angle(i)), center + r * Math.sin(angle(i))]
  }
  const poly = (vals: number[]) => vals.map((v, i) => pt(i, v).join(',')).join(' ')

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[260px] mx-auto">
      {[25, 50, 75, 100].map(r => (
        <polygon key={r}
          points={Array.from({ length: n }, (_, i) => pt(i, r).join(',')).join(' ')}
          fill="none" stroke="#e5e7eb" strokeWidth={1} />
      ))}
      {Array.from({ length: n }, (_, i) => {
        if (i === 0) return null  // 정중앙 위로 뻗는 세로축 선은 생략
        const [x, y] = pt(i, 100)
        return <line key={i} x1={center} y1={center} x2={x} y2={y} stroke="#e5e7eb" strokeWidth={1} />
      })}
      {data.manual_set.some(Boolean) && (
        <polygon points={poly(data.manual)} fill="rgba(79,70,229,0.22)" stroke="#4f46e5" strokeWidth={2} />
      )}
      {data.auto_set.some(Boolean) && (
        <polygon points={poly(data.auto)} fill="rgba(249,115,22,0.18)" stroke="#f97316" strokeWidth={2} strokeDasharray="4,3" />
      )}
      {data.axes.map((label, i) => {
        const [x, y] = pt(i, 118)
        return (
          <text key={label} x={x} y={y} fontSize={10} fill="#6b7280" textAnchor="middle" dominantBaseline="middle">
            {label}
          </text>
        )
      })}
    </svg>
  )
}

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
  const [prefAnalyzing, setPrefAnalyzing] = useState(false)
  const [prefResult, setPrefResult] = useState<{
    ready: boolean
    count?: number
    message?: string
    suggestion?: { mbti_auto?: string; personality_auto?: string; preference_auto?: string; [traitKey: string]: string | number | undefined }
    reason?: string
  } | null>(null)
  const [prefApplyMsg, setPrefApplyMsg] = useState('')
  const [radar, setRadar] = useState<RadarData | null>(null)

  const fetchRadar = () => {
    fetch(`${API}/preference/radar`).then(r => r.json()).then(setRadar).catch(() => {})
  }
  useEffect(() => { fetchRadar() }, [])

  // ── 핵심 기억(memory) — 매 아바타 프롬프트에 항상 주입되는 자유형식 사실 목록 ──
  interface MemoryItem { id: string; content: string; created_at: string }
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([])
  const [memoryInput, setMemoryInput] = useState('')
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
        body: JSON.stringify({ content }),
      })
      setMemoryInput(''); fetchMemory()
    } finally { setMemoryBusy(false) }
  }
  const deleteMemory = async (id: string) => {
    await fetch(`${API}/memory/${id}`, { method: 'DELETE' }).catch(() => {})
    fetchMemory()
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
      fetchRadar()
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

  const analyzePreference = async () => {
    setPrefAnalyzing(true)
    setPrefResult(null)
    setPrefApplyMsg('')
    try {
      const res = await fetch(`${API}/preference/analyze`)
      setPrefResult(await res.json())
    } catch {
      setPrefResult({ ready: false, message: '분석 실패' })
    } finally {
      setPrefAnalyzing(false)
    }
  }

  const applyPreferenceSuggestion = async () => {
    if (!prefResult?.suggestion) return
    try {
      const res = await fetch(`${API}/preference/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefResult.suggestion),
      })
      const data = await res.json()
      const flat: Record<string, string> = {}
      Object.entries(data.profile || {}).forEach(([k, v]: any) => { flat[k] = v.value || '' })
      setProfile(p => ({ ...p, ...flat }))
      fetchRadar()
      setPrefApplyMsg('적용됐습니다')
      setTimeout(() => setPrefApplyMsg(''), 2000)
    } catch {
      setPrefApplyMsg('적용 실패')
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

      {/* 핵심 기억 — 매 아바타 대화마다 항상 최우선으로 주입되는 사실 목록 */}
      <div className="space-y-2">
        <label className={labelCls}>꼭 기억할 것 (memory)</label>
        <p className="text-xs text-gray-400">아바타가 답할 때마다 항상 참고하는 핵심 사실. 예: "나는 허진구 아바타입니다"</p>
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
        {memoryItems.length > 0 && (
          <ul className="space-y-1">
            {memoryItems.map(m => (
              <li key={m.id} className="flex items-start gap-2 bg-gray-50 border border-gray-100 rounded-lg px-3 py-1.5 text-sm text-gray-700">
                <span className="flex-1">{m.content}</span>
                <button onClick={() => deleteMemory(m.id)}
                  className="text-gray-400 hover:text-red-500 text-xs shrink-0">✕</button>
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

      {/* Preference (MBTI/성격/선호도) — 직접입력 + 자동측정 + 병합 */}
      <div className="space-y-3 pt-2 border-t border-gray-100">
        <h3 className="text-sm font-semibold text-gray-800">Preference (MBTI/성격/선호도)</h3>
        <p className="text-xs text-gray-400">
          직접 입력한 값은 항상 우선 반영됩니다. 비워두면 아래 자동측정 결과가 대신 쓰입니다.
        </p>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className={labelCls}>MBTI (직접 입력)</label>
            <input value={profile.mbti_manual || ''} onChange={e => setProfile(p => ({ ...p, mbti_manual: e.target.value }))}
              className={inputCls} placeholder="예: INTJ" />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>성격 (직접 입력)</label>
            <textarea value={profile.personality_manual || ''} onChange={e => setProfile(p => ({ ...p, personality_manual: e.target.value }))}
              className={inputCls} rows={2} placeholder="예: 분석적이고 끝까지 파고드는 편" />
          </div>
          <div className="space-y-1">
            <label className={labelCls}>선호도/가치관 (직접 입력)</label>
            <textarea value={profile.preference_manual || ''} onChange={e => setProfile(p => ({ ...p, preference_manual: e.target.value }))}
              className={inputCls} rows={2} placeholder="예: 효율과 정확성을 우선시함" />
          </div>
          <div className="space-y-2">
            <label className={labelCls}>Big Five 성향 (직접 입력, 0~100)</label>
            {TRAIT_DEFS.map(({ key, label }) => {
              const fieldKey = `trait_${key}_manual`
              const val = profile[fieldKey] !== undefined && profile[fieldKey] !== '' ? Number(profile[fieldKey]) : 50
              return (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-xs text-gray-600 w-16 shrink-0">{label}</span>
                  <input type="range" min={0} max={100} value={val}
                    onChange={e => setProfile(p => ({ ...p, [fieldKey]: e.target.value }))}
                    className="flex-1" />
                  <span className="text-xs text-gray-500 w-8 text-right">{val}</span>
                </div>
              )
            })}
          </div>
          <div className="space-y-1">
            <label className={labelCls}>자동측정 주기</label>
            <div className="flex flex-wrap gap-2">
              {['1', '3', '7', '14', '30'].map(d => (
                <button key={d} onClick={() => setProfile(p => ({ ...p, preference_interval_days: d }))}
                  className={`px-3 py-1.5 text-xs rounded-full border transition ${
                    (profile.preference_interval_days || '7') === d
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'border-gray-200 text-gray-600 hover:border-gray-400'
                  }`}>{d}일</button>
              ))}
            </div>
          </div>
        </div>

        <button onClick={saveProfile}
          className="w-full py-2 rounded-xl bg-gray-900 text-white text-sm hover:bg-gray-700 transition">
          Preference 저장
        </button>

        <button onClick={analyzePreference} disabled={prefAnalyzing}
          className="w-full py-2 rounded-xl bg-gray-900 text-white text-sm hover:bg-gray-700 disabled:opacity-40 transition">
          {prefAnalyzing ? '분석 중…' : '지금 자동측정 실행'}
        </button>

        {prefResult && !prefResult.ready && (
          <p className="text-xs text-gray-400">{prefResult.message}</p>
        )}

        {prefResult?.ready && prefResult.suggestion && (
          <div className="p-3 bg-gray-50 border border-gray-200 rounded-xl space-y-2 text-xs text-gray-600">
            <p className="text-gray-400">최근 대화 {prefResult.count}개 + 지식그래프 토픽 분석 결과</p>
            <ul className="space-y-1">
              {prefResult.suggestion.mbti_auto && <li>MBTI: <span className="font-medium text-gray-900">{prefResult.suggestion.mbti_auto}</span></li>}
              {prefResult.suggestion.personality_auto && <li>성격: <span className="font-medium text-gray-900">{prefResult.suggestion.personality_auto}</span></li>}
              {prefResult.suggestion.preference_auto && <li>선호도: <span className="font-medium text-gray-900">{prefResult.suggestion.preference_auto}</span></li>}
              {TRAIT_DEFS.map(({ key, label }) => {
                const v = prefResult.suggestion?.[`trait_${key}_auto`]
                return v !== undefined ? (
                  <li key={key}>{label}: <span className="font-medium text-gray-900">{v}점</span></li>
                ) : null
              })}
            </ul>
            {prefResult.reason && <p className="text-gray-400">{prefResult.reason}</p>}
            <button onClick={applyPreferenceSuggestion}
              className="w-full py-1.5 rounded-xl bg-indigo-600 text-white text-xs hover:bg-indigo-500 transition">
              프로파일에 적용
            </button>
            {prefApplyMsg && <p className={`text-xs text-center ${prefApplyMsg.includes('적용됐') ? 'text-green-600' : 'text-red-500'}`}>{prefApplyMsg}</p>}
          </div>
        )}

        {profile.preference_auto_at && (
          <p className="text-xs text-gray-400">마지막 자동측정: {profile.preference_auto_at}</p>
        )}

        {/* 레이더 차트 — 직접입력(파란 실선) vs 자동측정(주황 점선) 비교 */}
        {radar && (
          <div className="p-3 bg-gray-50 border border-gray-200 rounded-xl space-y-2">
            <p className="text-xs text-gray-500">성향 비교 (직접입력 vs 자동측정)</p>
            <RadarChart data={radar} />
            <div className="flex justify-center gap-4 text-xs">
              <span className="flex items-center gap-1 text-indigo-600"><span className="w-2.5 h-2.5 rounded-full bg-indigo-600 inline-block" />직접입력</span>
              <span className="flex items-center gap-1 text-orange-500"><span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block" />자동측정</span>
            </div>
            <ul className="text-xs text-gray-600 space-y-0.5 pt-1 border-t border-gray-200">
              {radar.axes.map((label, i) => {
                const m = radar.manual_set[i] ? radar.manual[i] : null
                const a = radar.auto_set[i] ? radar.auto[i] : null
                const d = radar.diff[i]
                return (
                  <li key={label} className="flex items-center justify-between">
                    <span>{label}</span>
                    <span>
                      {m !== null ? `직접 ${m}` : '직접 미입력'} / {a !== null ? `AI ${a}` : 'AI 미측정'}
                      {d !== null && (
                        <span className={`ml-1 font-medium ${d >= 25 ? 'text-red-500' : d >= 10 ? 'text-amber-500' : 'text-gray-400'}`}>
                          (차이 {d})
                        </span>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl text-xs text-gray-500 space-y-1">
        <p>API 서버: <span className="text-gray-700 font-medium">http://127.0.0.1:8766</span></p>
        <p>설정은 브라우저 localStorage에 저장됩니다.</p>
      </div>
    </div>
  )
}
