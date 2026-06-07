import type { Settings } from '@/types'
import { claudeWebCaptureSession } from '@/services/claudeWeb'
import { useState, useEffect } from 'react'

const API = 'http://127.0.0.1:8766'

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
    <div className="p-8 max-w-lg space-y-6">
      <h2 className="text-base font-semibold text-gray-900">설정</h2>

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

      <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl text-xs text-gray-500 space-y-1">
        <p>API 서버: <span className="text-gray-700 font-medium">http://127.0.0.1:8766</span></p>
        <p>설정은 브라우저 localStorage에 저장됩니다.</p>
      </div>
    </div>
  )
}
