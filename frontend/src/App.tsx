import { useState, useEffect } from 'react'
import { DEFAULT_SETTINGS, type Settings } from './types'
import { claudeWebAutoConnect, claudeWebCaptureSession } from './services/claudeWeb'
import AvatarStudio from './views/AvatarStudio'
import Avatar3DChat, { type ChatMsg } from './views/Avatar3DChat'
import RealisticAvatar from './views/RealisticAvatar'
import KnowledgeGraph from './views/KnowledgeGraph'
import SettingsView from './views/Settings'

type Tab = 'mode-a' | 'mode-c' | 'mode-r' | 'kg' | 'settings'

const STORAGE_KEY = 'mental-avatar-settings'
const CHAT_STORAGE_KEY = 'mental-avatar-chat'

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS }
}

function loadChat(): ChatMsg[] {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* ignore */ }
  return []
}

export default function App() {
  const [tab, setTab] = useState<Tab>('kg')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [avatarMessages, setAvatarMessages] = useState<ChatMsg[]>(loadChat)

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

  useEffect(() => {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(avatarMessages))
  }, [avatarMessages])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'kg',       label: '🧠 지식 그래프' },
    { id: 'mode-a',   label: '🎬 영상 아바타' },
    { id: 'mode-c',   label: '🤖 AI 아바타' },
    { id: 'mode-r',   label: '✨ 실사 아바타' },
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
        {tab === 'mode-c'   && <Avatar3DChat settings={settings} messages={avatarMessages} setMessages={setAvatarMessages} />}
        {tab === 'mode-r'   && <RealisticAvatar />}
        {tab === 'kg'       && <KnowledgeGraph settings={settings} />}
        {tab === 'settings' && <SettingsView settings={settings} onChange={setSettings} />}
      </main>
    </div>
  )
}
