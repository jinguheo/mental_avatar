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
type NavItem = { id: Tab; label: string; navLabel: string; icon: Tab; description: string }

const STORAGE_KEY = 'mental-avatar-settings'
const CHAT_STORAGE_KEY = 'mental-avatar-chat'

const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: 'Home', navLabel: 'Home', icon: 'home', description: 'Module overview' },
  { id: 'kg', label: 'Knowledge', navLabel: 'Graph', icon: 'kg', description: 'Memory and graph search' },
  { id: 'mode-c', label: 'AI Avatar', navLabel: 'Avatar', icon: 'mode-c', description: 'Lightweight 3D chat' },
  { id: 'mode-r', label: 'Realistic', navLabel: '3D', icon: 'mode-r', description: 'Full avatar scene' },
  { id: 'mode-a', label: 'Video', navLabel: 'Video', icon: 'mode-a', description: 'Video avatar tools' },
  { id: 'presenter', label: 'Presenter', navLabel: 'PPT', icon: 'presenter', description: 'Narrated slide flow' },
  { id: 'settings', label: 'Settings', navLabel: 'Setup', icon: 'settings', description: 'Providers and profile' },
]

function NavIcon({ icon, className = '' }: { icon: Tab; className?: string }) {
  const common = {
    className: `h-5 w-5 ${className}`,
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 2,
    viewBox: '0 0 24 24',
    'aria-hidden': true,
  }

  if (icon === 'home') {
    return (
      <svg {...common}>
        <path d="M3 10.8 12 3l9 7.8" />
        <path d="M5 10v10h14V10" />
        <path d="M9.5 20v-6h5v6" />
      </svg>
    )
  }
  if (icon === 'kg') {
    return (
      <svg {...common}>
        <circle cx="6" cy="7" r="2.5" />
        <circle cx="17" cy="6" r="2.5" />
        <circle cx="12" cy="18" r="2.5" />
        <path d="m8.2 8.3 2.6 7.4" />
        <path d="m15.7 8.2-2.5 7.5" />
        <path d="M8.3 7h6.2" />
      </svg>
    )
  }
  if (icon === 'mode-c') {
    return (
      <svg {...common}>
        <rect x="5" y="7" width="14" height="11" rx="4" />
        <path d="M9 7V5" />
        <path d="M15 7V5" />
        <path d="M9.5 12h.01" />
        <path d="M14.5 12h.01" />
        <path d="M10 15h4" />
      </svg>
    )
  }
  if (icon === 'mode-r') {
    return (
      <svg {...common}>
        <path d="m12 3 7 4v10l-7 4-7-4V7l7-4Z" />
        <path d="M12 12 5.4 8.2" />
        <path d="M12 12v8.2" />
        <path d="m12 12 6.6-3.8" />
      </svg>
    )
  }
  if (icon === 'mode-a') {
    return (
      <svg {...common}>
        <rect x="4" y="6" width="12" height="12" rx="3" />
        <path d="m16 10 4-2.5v9L16 14" />
        <path d="M8 10h4" />
        <path d="M8 14h2" />
      </svg>
    )
  }
  if (icon === 'presenter') {
    return (
      <svg {...common}>
        <rect x="4" y="4" width="16" height="11" rx="2" />
        <path d="M12 15v5" />
        <path d="M8 20h8" />
        <path d="M8 9h8" />
        <path d="M8 12h5" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="m4.2 7.5 2.6 1.5" />
      <path d="m17.2 15 2.6 1.5" />
      <path d="m19.8 7.5-2.6 1.5" />
      <path d="m6.8 15-2.6 1.5" />
    </svg>
  )
}

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
    <div className="view-canvas flex flex-1 items-center justify-center" role="status" aria-live="polite">
      <div className="flex items-center gap-3 text-sm text-gray-500">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-300 border-t-gray-900" aria-hidden="true" />
        Loading module...
      </div>
    </div>
  )
}

function HomeView({ onOpen }: { onOpen: (tab: Tab) => void }) {
  const items = NAV_ITEMS.filter(item => item.id !== 'home')
  const featured = [
    { id: 'mode-c' as Tab, label: 'Start AI chat', meta: 'Light 3D avatar' },
    { id: 'kg' as Tab, label: 'Search memory', meta: 'Knowledge graph' },
    { id: 'presenter' as Tab, label: 'Open presenter', meta: 'Slides and narration' },
  ]

  return (
    <div className="view-canvas h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <header className="view-header -mx-4 -mt-5 border-x-0 px-4 py-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="flex flex-col gap-1">
            <p className="dashboard-kicker">Mental workspace</p>
            <h1 className="text-xl font-semibold text-gray-950">Mental Avatar</h1>
            <p className="max-w-2xl text-sm leading-6 text-gray-500">
              A focused control room for avatar chat, personal memory, video tools, and narrated presentations.
            </p>
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
          <section className="dashboard-card overflow-hidden">
            <div className="grid gap-0 md:grid-cols-[1fr_240px]">
              <div className="flex min-h-[250px] flex-col justify-between p-5 sm:p-6">
                <div>
                  <p className="dashboard-kicker">Ready now</p>
                  <h2 className="mt-2 max-w-xl text-2xl font-semibold tracking-tight text-gray-950 sm:text-3xl">
                    Choose a module and keep the heavy tools quiet until you need them.
                  </h2>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-500">
                    The home screen now follows the same calm dashboard layout as my-dashboard: clear navigation, compact status, and fast entry points.
                  </p>
                </div>

                <div className="mt-5 grid gap-2 sm:grid-cols-3">
                  {featured.map(action => (
                    <button
                      key={action.id}
                      type="button"
                      onClick={() => onOpen(action.id)}
                      className="rounded-xl border border-surface-border bg-gray-50 px-3 py-3 text-left transition hover:border-gray-300 hover:bg-white hover:shadow-sm"
                    >
                      <span className="block text-sm font-semibold text-gray-950">{action.label}</span>
                      <span className="mt-1 block text-[11px] text-gray-500">{action.meta}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="relative flex min-h-[220px] items-center justify-center border-t border-surface-border bg-[#eef1f5] p-6 md:border-l md:border-t-0">
                <div className="absolute left-5 top-5 rounded-full border border-white/80 bg-white/75 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500 shadow-sm">
                  Avatar Core
                </div>
                <div className="relative h-36 w-36">
                  <div className="absolute inset-0 rounded-full bg-gray-950 shadow-card" />
                  <div className="absolute bottom-2 left-1/2 z-10 h-20 w-28 -translate-x-1/2 rounded-t-[42px] bg-white" />
                  <div className="absolute bottom-6 left-1/2 z-20 h-10 w-16 -translate-x-1/2 rounded-t-3xl bg-gray-800" />
                  <div className="absolute left-1/2 top-5 z-30 h-20 w-20 -translate-x-1/2 rounded-full bg-[#f1c8a8]" />
                  <div className="absolute left-1/2 top-2 z-40 h-14 w-24 -translate-x-1/2 rounded-t-full bg-[#2c211b]" />
                  <div className="absolute left-[50px] top-[54px] z-50 h-2 w-2 rounded-full bg-gray-950" />
                  <div className="absolute right-[50px] top-[54px] z-50 h-2 w-2 rounded-full bg-gray-950" />
                  <div className="absolute left-1/2 top-[78px] z-50 h-1.5 w-8 -translate-x-1/2 rounded-full bg-[#b7655c]" />
                </div>
              </div>
            </div>
          </section>

          <aside className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
            {[
              ['6', 'Active modules', 'Lazy-loaded tools'],
              ['Local', 'Memory base', 'MCP and profile data'],
              ['Light', 'Startup mode', 'Fast first render'],
            ].map(([value, label, sub]) => (
              <div key={label} className="dashboard-card px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-gray-950">{value}</div>
                    <div className="dashboard-kicker mt-1">{label}</div>
                  </div>
                  <span className="mt-1 h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" />
                </div>
                <p className="mt-2 text-xs leading-5 text-gray-500">{sub}</p>
              </div>
            ))}
          </aside>
        </div>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => onOpen(item.id)}
              className="dashboard-card-interactive group flex min-h-[126px] flex-col justify-between p-4 text-left"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gray-950 text-[11px] font-bold text-white shadow-sm transition group-hover:scale-[1.03]">
                <NavIcon icon={item.icon} className="h-4 w-4" />
              </span>
              <span>
                <span className="block text-sm font-semibold text-gray-950">{item.label}</span>
                <span className="mt-1 block text-xs leading-5 text-gray-500">{item.description}</span>
              </span>
            </button>
          ))}
        </section>
      </div>
    </div>
  )
}

function Sidebar({ current, onNavigate }: { current: Tab; onNavigate: (tab: Tab) => void }) {
  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 h-16 border-t border-surface-border bg-white/95 backdrop-blur-xl md:static md:z-auto md:flex md:h-auto md:w-20 md:shrink-0 md:flex-col md:border-r md:border-t-0 md:bg-white/80">
      <div className="hidden h-20 items-center justify-center border-b border-surface-border md:flex">
        <span className="flex h-10 w-10 select-none items-center justify-center rounded-2xl bg-gray-950 text-sm font-black tracking-tight text-white shadow-sm">MA</span>
      </div>

      <nav className="grid h-full grid-cols-7 items-center gap-1 px-1 md:flex md:h-auto md:flex-1 md:flex-col md:items-stretch md:gap-1.5 md:overflow-y-auto md:p-2 md:pt-4">
        {NAV_ITEMS.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            title={item.label}
            aria-label={item.label}
            className={`relative flex min-w-0 flex-col items-center gap-1 rounded-xl px-1 py-2 text-xs font-medium transition-all duration-150 md:w-full md:px-2 md:py-2.5 ${
              current === item.id
                ? 'bg-gray-950 text-white shadow-md shadow-gray-950/10'
                : 'text-gray-500 hover:bg-gray-100 hover:text-gray-950'
            }`}
          >
            <span className="flex h-5 min-w-5 items-center justify-center leading-none">
              <NavIcon icon={item.icon} className="h-[18px] w-[18px]" />
            </span>
            <span className="max-w-full truncate text-[9px] leading-none">{item.navLabel}</span>
          </button>
        ))}
      </nav>
    </aside>
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

  return (
    <div className="flex h-screen overflow-hidden bg-[#f4f6f8] text-gray-900">
      <Sidebar current={tab} onNavigate={setTab} />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden pb-16 md:pb-0">
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
