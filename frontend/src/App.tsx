import { lazy, Suspense, useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type ChatMsg, type Settings } from './types'
import { claudeWebAutoConnect } from './services/claudeWeb'

const AvatarStudio = lazy(() => import('./views/AvatarStudio'))
const Avatar3DChat = lazy(() => import('./views/Avatar3DChat'))
const RealisticAvatar = lazy(() => import('./views/RealisticAvatar'))
const KnowledgeGraph = lazy(() => import('./views/KnowledgeGraph'))
const SettingsView = lazy(() => import('./views/Settings'))
const PptPresenter = lazy(() => import('./views/PptPresenter'))
const InterviewPanel = lazy(() => import('./views/InterviewPanel'))

type Tab = 'home' | 'kg' | 'mode-a' | 'mode-c' | 'mode-r' | 'presenter' | 'interview' | 'settings'
type NavItem = { id: Tab; label: string; navLabel: string; icon: Tab; description: string }

const STORAGE_KEY = 'mental-avatar-settings'
const CHAT_STORAGE_KEY = 'mental-avatar-chat'

const NAV_ITEMS: NavItem[] = [
  { id: 'home', label: '홈', navLabel: '홈', icon: 'home', description: '시작 화면' },
  { id: 'kg', label: '기억 검색', navLabel: '기억', icon: 'kg', description: '지식 그래프와 기록 검색' },
  { id: 'mode-c', label: 'AI 대화', navLabel: '대화', icon: 'mode-c', description: '가벼운 3D 아바타 채팅' },
  { id: 'mode-r', label: '실사 아바타', navLabel: '3D', icon: 'mode-r', description: '전체 아바타 장면' },
  { id: 'mode-a', label: '영상 도구', navLabel: '영상', icon: 'mode-a', description: '아바타 영상 생성' },
  { id: 'presenter', label: '발표', navLabel: '발표', icon: 'presenter', description: '슬라이드와 내레이션' },
  { id: 'interview', label: '자문자답', navLabel: '자문', icon: 'interview', description: '내 판단·기준을 아바타에게 채우기' },
  { id: 'settings', label: '설정', navLabel: '설정', icon: 'settings', description: '연결과 프로필' },
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
  if (icon === 'interview') {
    return (
      <svg {...common}>
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4L3 21l1.1-4A8.4 8.4 0 1 1 21 11.5Z" />
        <path d="M9.2 9.3a2.8 2.8 0 0 1 5.4.9c0 1.9-2.8 2.8-2.8 2.8" />
        <path d="M12 16.5h.01" />
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
    { id: 'mode-c' as Tab, label: '대화 시작', meta: 'AI 대화' },
    { id: 'kg' as Tab, label: '기억 검색', meta: '지식 그래프' },
    { id: 'settings' as Tab, label: '설정', meta: '연결 상태' },
  ]

  return (
    <div className="view-canvas h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-5 sm:px-6 lg:px-8">
        <header className="view-header -mx-4 -mt-5 border-x-0 px-4 py-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="dashboard-kicker">개인 작업실</p>
              <h1 className="mt-1 text-xl font-semibold text-gray-950">멘탈 아바타</h1>
            </div>
            <span className="inline-flex w-fit items-center gap-2 rounded-lg border border-surface-border bg-white px-3 py-1.5 text-xs font-medium text-gray-600">
              <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
              로컬 연결
            </span>
          </div>
        </header>

        <section className="view-panel p-4 sm:p-5">
          <div className="grid gap-2 sm:grid-cols-3">
            {featured.map(action => (
              <button
                key={action.id}
                type="button"
                onClick={() => onOpen(action.id)}
                className="flex min-h-16 items-center justify-between rounded-lg border border-surface-border bg-gray-50 px-4 py-3 text-left transition hover:border-gray-300 hover:bg-white"
              >
                <span>
                  <span className="block text-sm font-semibold text-gray-950">{action.label}</span>
                  <span className="mt-1 block text-xs text-gray-500">{action.meta}</span>
                </span>
                <span className="text-gray-400" aria-hidden="true">{'>'}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="view-panel overflow-hidden">
          <div className="border-b border-surface-border px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold text-gray-950">도구</h2>
          </div>
          <div className="divide-y divide-surface-border">
            {items.map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => onOpen(item.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-gray-50 sm:px-5"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-700">
                  <NavIcon icon={item.icon} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-gray-950">{item.label}</span>
                  <span className="mt-0.5 block truncate text-xs text-gray-500">{item.description}</span>
                </span>
                <span className="text-gray-300" aria-hidden="true">{'>'}</span>
              </button>
            ))}
          </div>
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

      <nav className="grid h-full grid-cols-8 items-center gap-1 px-1 md:flex md:h-auto md:flex-1 md:flex-col md:items-stretch md:gap-1.5 md:overflow-y-auto md:p-2 md:pt-4">
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
          {tab === 'interview' && <InterviewPanel />}
          {tab === 'settings' && <SettingsView settings={settings} onChange={setSettings} />}
        </Suspense>
      </main>
    </div>
  )
}

