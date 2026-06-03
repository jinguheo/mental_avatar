import { useState, useEffect } from 'react'
import { DEFAULT_SETTINGS, type Settings } from './types'
import { claudeWebAutoConnect, claudeWebCaptureSession } from './services/claudeWeb'
import AvatarStudio from './views/AvatarStudio'
import Avatar3DStudio from './views/Avatar3DStudio'
import KnowledgeGraph from './views/KnowledgeGraph'
import SettingsView from './views/Settings'

type Tab = 'mode-a' | 'mode-b' | 'kg' | 'settings'

const STORAGE_KEY = 'mental-avatar-settings'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

export default function App() {
  const [tab, setTab] = useState<Tab>('kg')
  const [settings, setSettings] = useState<Settings>(loadSettings)

  // MCP 서버에서 캐시된 세션키 자동 조회 (앱 시작 시, quick_only)
  useEffect(() => {
    if (!settings.mcpEndpoint) return
    claudeWebAutoConnect(settings.mcpEndpoint).then(key => {
      if (key && key !== settings.claudeSessionKey) {
        setSettings(prev => ({ ...prev, claudeSessionKey: key }))
      }
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'kg',       label: '🧠 지식 그래프' },
    { id: 'mode-a',   label: '🎬 영상 아바타' },
    { id: 'mode-b',   label: '◈ 3D 아바타' },
    { id: 'settings', label: '⚙ 설정' },
  ]

  return (
    <div className="flex flex-col h-screen bg-white text-gray-900 overflow-hidden">
      {/* 헤더 */}
      <header className="flex items-center gap-6 px-5 py-3 border-b border-gray-200 shrink-0 bg-white">
        <span className="text-sm font-semibold text-gray-900 tracking-wide">Mental Avatar</span>
        <nav className="flex gap-1 bg-gray-100 rounded-xl p-1">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-all
                ${tab === t.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* 콘텐츠 */}
      <main className="flex-1 overflow-hidden">
        {tab === 'mode-a'   && <AvatarStudio />}
        {tab === 'mode-b'   && <Avatar3DStudio settings={settings} />}
        {tab === 'kg'       && <KnowledgeGraph settings={settings} />}
        {tab === 'settings' && <SettingsView settings={settings} onChange={setSettings} />}
      </main>
    </div>
  )
}
