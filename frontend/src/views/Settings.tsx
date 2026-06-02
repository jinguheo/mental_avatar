import type { Settings } from '@/types'
import { claudeWebCaptureSession } from '@/services/claudeWeb'
import { useState } from 'react'

interface Props {
  settings: Settings
  onChange: (s: Settings) => void
}

export default function SettingsView({ settings, onChange }: Props) {
  const [capturing, setCapturing] = useState(false)
  const [msg, setMsg] = useState('')

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

      <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl text-xs text-gray-500 space-y-1">
        <p>API 서버: <span className="text-gray-700 font-medium">http://127.0.0.1:8766</span></p>
        <p>설정은 브라우저 localStorage에 저장됩니다.</p>
      </div>
    </div>
  )
}
