import { lazy, Suspense, useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type ChatMsg, type Settings } from './types'
import { claudeWebAutoConnect } from './services/claudeWeb'

const AvatarStudio = lazy(() => import('./views/AvatarStudio'))
const Avatar3DChat = lazy(() => import('./views/Avatar3DChat'))
const RealisticAvatar = lazy(() => import('./views/RealisticAvatar'))
const KnowledgeGraph = lazy(() => import('./views/KnowledgeGraph'))
const SettingsView = lazy(() => import('./views/Settings'))
const PptPresenter = lazy(() => import('./views/PptPresenter'))

type Tab = 'home' | 'kg' | 'mode-a' | 'mode-c' | 'mode-r' | 'presenter' | 'settings'

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

function LoadingView() {
  return (
    <div className="flex h-full items-center justify-center bg-gray-50 text-sm text-gray-500">
      Loading module...
    </div>
  )
}

function HomeView({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const items: { id: Tab; title: string; description: string }[] = [
    { id: 'kg', title: 'Knowledge Graph', description: 'Memory, notes, graphify output, and wiki pages.' },
    { id: 'mode-c', title: 'AI Avatar', description: 'Lightweight 3D avatar chat.' },
    { id: 'mode-r', title: 'Realistic Avatar', description: 'Heavier GLB avatar scene, loaded only when opened.' },
    { id: 'mode-a', title: 'Video Avatar', description: 'Generate and manage avatar video assets.' },
    { id: 'presenter', title: 'PPT Presenter', description: 'Prepare narrated slides with an avatar presenter.' },
    { id: 'settings', title: 'Settings', description: 'Providers, sessions, and preferences.' },
  ]

  return (
    <div className="h-full overflow-y-auto bg-gray-50 p-6">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-gray-900">Mental Avatar</h1>
          <p className="mt-1 text-sm text-gray-500">
            Open a module when you need it. Heavy 3D, graph, and presenter code stays unloaded on this screen.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item.id)}
              className="rounded-lg border border-gray-200 bg-white p-4 text-left shadow-sm transition hover:border-gray-300 hover:shadow"
            >
              <div className="text-sm font-semibold text-gray-900">{item.title}</div>
              <div className="mt-2 text-xs leading-5 text-gray-500">{item.description}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState<Tab>('home')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [avatarMessages, setAvatarMessages] = useState<ChatMsg[]>(loadChat)
  const [realisticMessages, setRealisticMessages] = useState<ChatMsg[]>([])

  useEffect(() => {
    if (!settings.mcpEndpoint) return
    claudeWebAutoConnect(settings.mcpEndpoint).then(key => {
      if (key && key !== settings.claudeSessionKey) {
        setSettings(prev => ({ ...prev, claudeSessionKey: key }))
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }, [settings])

  useEffect(() => {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(avatarMessages))
  }, [avatarMessages])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'home', label: 'Home' },
    { id: 'kg', label: 'Knowledge Graph' },
    { id: 'mode-a', label: 'Video Avatar' },
    { id: 'mode-c', label: 'AI Avatar' },
    { id: 'mode-r', label: 'Realistic Avatar' },
    { id: 'presenter', label: 'PPT Presenter' },
    { id: 'settings', label: 'Settings' },
  ]

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white text-gray-900">
      <header className="flex shrink-0 items-center gap-6 border-b border-gray-200 bg-white px-5 py-3">
        <span className="text-sm font-semibold tracking-wide text-gray-900">Mental Avatar</span>
        <nav className="flex gap-1 rounded-xl bg-gray-100 p-1">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                tab === t.id
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="flex-1 overflow-hidden">
        <Suspense fallback={<LoadingView />}>
          {tab === 'home' && <HomeView onOpen={setTab} />}
          {tab === 'mode-a' && <AvatarStudio />}
          {tab === 'mode-c' && <Avatar3DChat settings={settings} messages={avatarMessages} setMessages={setAvatarMessages} />}
          {tab === 'mode-r' && <RealisticAvatar settings={settings} messages={realisticMessages} setMessages={setRealisticMessages} />}
          {tab === 'kg' && <KnowledgeGraph settings={settings} />}
          {tab === 'presenter' && <PptPresenter />}
          {tab === 'settings' && <SettingsView settings={settings} onChange={setSettings} />}
        </Suspense>
      </main>
    </div>
  )
}
