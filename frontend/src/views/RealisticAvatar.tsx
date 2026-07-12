/**
 * RealisticAvatar — Avaturn GLB 3D 뷰어 + Avatar3DChat과 동일한 채팅/TTS/STT 패널
 */
import { useEffect, useRef, useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { streamClaudeWeb, claudeWebAutoConnect } from '@/services/claudeWeb'
import { streamChatOllama } from '@/services/ollama'
import type { ChatMsg, Settings } from '@/types'
import { API_BASE } from '@/config'
import VoiceServiceBanner from '@/components/VoiceServiceBanner'
import { type Emotion, type LipCue, MORPH_GROUPS, RHUBARB_SHAPE_TARGETS, EMOTION_WEIGHTS, classifyEmotion } from '@/avatarMorph'

const API = API_BASE
const CHAT_SINCE_KEY = 'mental-avatar-realistic-chat-since'
const AVATAR_FILE_KEY = 'mental-avatar-avaturn-filename'

// SQLite의 created_at(datetime('now','localtime'))과 동일한 'YYYY-MM-DD HH:MM:SS' 형식(로컬시간)
function localTimestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// TTS로 읽을 텍스트를 만든다 — 답변이 길면(XTTS 한국어 95자 제한 근처) 첫 문장만 읽고
// 나머지는 채팅창의 전체 텍스트를 참고하도록 안내한다. 길게 읽으려다 느려지거나
// 실패하는 것보다, 짧게라도 확실히 들리는 쪽을 우선한다.
const SPOKEN_TEXT_LIMIT = 92
const SPOKEN_FALLBACK_PHRASES = [
  '핵심만요.',
  '짧게 읽을게요.',
  '요점만 말씀드릴게요.',
  '핵심만 말씀드릴게요.',
  '나머지는 화면에서 볼게요.',
  '중요한 부분만 읽을게요.',
  '길이를 줄여서 말할게요.',
  '이어지는 내용은 채팅에 남길게요.',
  '자세한 맥락은 화면에서 확인해 주세요.',
  '자세한 내용은 채팅을 봐 주세요.',
  '더 궁금하시면 이어서 말씀해 주세요.',
  '또 궁금한 점 있으세요?',
  '혹시 다른 질문도 있으세요?',
  '이어서 물어보셔도 좋아요.',
  '궁금한 점 있으면 바로 말씀해 주세요.',
  '다음 질문도 편하게 해 주세요.',
  '원하시면 더 이어서 답할게요.',
  '할 일이 있으면 바로 말씀해 주세요.',
]

function pickFallbackPhrase(seed: string, room: number): string {
  const candidates = SPOKEN_FALLBACK_PHRASES.filter(phrase => phrase.length <= room)
  if (!candidates.length) return ''
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return candidates[hash % candidates.length]
}

function stripParentheticalText(text: string): string {
  let result = text
  const patterns = [
    /\([^()]*\)/g,
    /（[^（）]*）/g,
    /\[[^\[\]]*\]/g,
    /【[^【】]*】/g,
    /\{[^{}]*\}/g,
    /<[^<>]*>/g,
  ]

  let changed = true
  while (changed) {
    changed = false
    for (const pattern of patterns) {
      const next = result.replace(pattern, ' ')
      if (next !== result) changed = true
      result = next
    }
  }

  return result
    .replace(/^\s*[·•\-–—*]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildSpokenText(text: string): string {
  const trimmed = stripParentheticalText(text)
  if (trimmed.length <= SPOKEN_TEXT_LIMIT) return trimmed
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/)
  let firstSentence = (match ? match[0] : trimmed).trim()
  if (!firstSentence) return trimmed.slice(0, SPOKEN_TEXT_LIMIT).trim()

  const room = SPOKEN_TEXT_LIMIT - firstSentence.length - 1
  const fallback = pickFallbackPhrase(trimmed, room)
  if (fallback) return `${firstSentence} ${fallback}`

  if (firstSentence.length > SPOKEN_TEXT_LIMIT) {
    firstSentence = firstSentence.slice(0, SPOKEN_TEXT_LIMIT).trim()
  }
  return firstSentence.endsWith('.') || firstSentence.endsWith('!') || firstSentence.endsWith('?')
    ? firstSentence
    : `${firstSentence}...`
}
const IDB_NAME = 'mental-avatar-glb'
const IDB_STORE = 'glb-files'

interface GlbEntry { name: string; size: number; data: ArrayBuffer; loadedAt: number }

function openIDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE, { keyPath: 'name' })
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}
async function idbSave(entry: GlbEntry) {
  const db = await openIDB()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(entry)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}
async function idbList(): Promise<GlbEntry[]> {
  const db = await openIDB()
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).getAll()
    req.onsuccess = () => res((req.result as GlbEntry[]).sort((a, b) => b.loadedAt - a.loadedAt))
    req.onerror = () => rej(req.error)
  })
}
async function idbDelete(name: string) {
  const db = await openIDB()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).delete(name)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

interface MorphRef { mesh: THREE.Mesh; index: number }
// 립싱크·표정 모프 상수/분류기는 @/avatarMorph 로 분리 (PptPresenter와 공용)

const GREETING = '안녕하세요! 반갑습니다. 무엇이든 도와드리겠습니다.'
const SYSTEM = `당신은 사용자를 맞이하는 AI 아바타입니다.
따뜻하고 전문적으로 한국어로 응대하세요.
답변은 2~3문장으로 간결하게 하고, 항상 친절한 어조를 유지하세요.`

// 브라우저 내장 Microsoft TTS 목소리는 사용하지 않아 목록에서 제외
interface VoiceOption { id: string; label: string; kind: 'clone' | 'template'; voiceURI?: string }
const MY_VOICE: VoiceOption = { id: 'mine', label: '내 목소리', kind: 'clone' }
const TEMPLATE_VOICES: VoiceOption[] = [
  { id: 'pretty', label: '예쁜 목소리', kind: 'template' },
  { id: 'child',  label: '어린이 목소리', kind: 'template' },
  { id: 'calm',   label: '차분한 목소리', kind: 'template' },
]
const VOICE_OPTION_KEY = 'mental-avatar-realistic-voice'
const VIEW_MODE_KEY = 'mental-avatar-camera-view'
type ViewMode = 'face' | 'upper' | 'full'
const VIEW_MODE_LABELS: Record<ViewMode, string> = { face: '얼굴만', upper: '상반신', full: '전체 보기' }
// face: 얼굴이 화면을 꽉 채우는 클로즈업 — 카메라를 바짝 당기는 대신 FOV를 좁혀 왜곡 없이 확대(망원렌즈 효과).
// upper: 기존 기본값(상반신). full: 전신이 다 보이는 화면.
const VIEW_PRESETS: Record<ViewMode, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
  face:  { pos: [0, 1.58, 0.6], target: [0, 1.58, 0], fov: 45 },
  upper: { pos: [0, 1.5, 1.3], target: [0, 1.45, 0], fov: 45 },
  full:  { pos: [0, 0.9, 3.0], target: [0, 0.8, 0], fov: 45 },
}

interface Props {
  settings: Settings
  messages: ChatMsg[]
  setMessages: Dispatch<SetStateAction<ChatMsg[]>>
}

export default function RealisticAvatar({ settings, messages, setMessages }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const viewModeRef = useRef<ViewMode>((localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'face')
  const mixerRef = useRef<THREE.AnimationMixer | null>(null)
  const clockRef = useRef(new THREE.Clock())
  const animFrameRef = useRef<number>(0)
  const objectUrlRef = useRef<string | null>(null)
  const envTextureRef = useRef<THREE.Texture | null>(null)
  const morphMapRef = useRef<Record<string, MorphRef[]>>({})
  const morphGroupsRef = useRef<Record<string, string[]>>({})
  const morphValuesRef = useRef<Record<string, number>>({})
  const lipsyncAnalyserRef = useRef<AnalyserNode | null>(null)
  const activeAudioRef = useRef<HTMLAudioElement | null>(null)
  const lipCuesRef = useRef<LipCue[]>([])
  // 응답이 연달아 오면 이전 TTS 재생을 즉시 중단하고 최신 응답의 음성만 재생한다.
  const ttsGenRef = useRef(0)
  const emotionRef = useRef<Emotion>('neutral')
  const blinkKeysRef = useRef<string[]>([])
  const blinkStateRef = useRef<{ phase: 'idle' | 'closing' | 'opening'; elapsed: number; next: number }>({ phase: 'idle', elapsed: 0, next: 2000 + Math.random() * 3000 })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [avatarLoaded, setAvatarLoaded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState(() => localStorage.getItem(AVATAR_FILE_KEY) || '')
  const [serverOnline, setServerOnline] = useState(true)
  const [glbList, setGlbList] = useState<GlbEntry[]>([])
  const [showList, setShowList] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() => viewModeRef.current)

  const setView = useCallback((mode: ViewMode) => {
    setViewMode(mode); viewModeRef.current = mode
    localStorage.setItem(VIEW_MODE_KEY, mode)
    const preset = VIEW_PRESETS[mode]
    if (cameraRef.current && controlsRef.current) {
      cameraRef.current.position.set(...preset.pos)
      cameraRef.current.fov = preset.fov
      cameraRef.current.updateProjectionMatrix()
      controlsRef.current.target.set(...preset.target)
      controlsRef.current.update()
    }
  }, [])

  const refreshList = useCallback(() => {
    idbList().then(setGlbList).catch(() => {})
  }, [])

  useEffect(() => { refreshList() }, [refreshList])

  const checkServer = useCallback(async () => {
    try {
      const res = await fetch(`${API}/stats`, { signal: AbortSignal.timeout(2000) })
      setServerOnline(res.ok)
      return res.ok
    } catch {
      setServerOnline(false)
      return false
    }
  }, [])

  useEffect(() => { checkServer() }, [])

  // 음성 옵션 — '내 목소리'(XTTS 클로닝) + 서버 제공 템플릿 목소리만 사용
  const voiceOptions: VoiceOption[] = [MY_VOICE, ...TEMPLATE_VOICES]
  const [voiceOptionId, setVoiceOptionId] = useState(() => {
    try { localStorage.setItem(VOICE_OPTION_KEY, MY_VOICE.id) } catch { /**/ }
    return MY_VOICE.id
  })
  const selectedVoice = voiceOptions.find(v => v.id === voiceOptionId) || MY_VOICE

  // 채팅
  const [input, setInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const speakingRef = useRef(false)
  // 자동재생이 브라우저 정책에 막히면, 사용자가 직접 눌러서 재생할 수 있는 버튼을 띄운다.
  const [blockedAudio, setBlockedAudio] = useState<HTMLAudioElement | null>(null)
  const sttBusyRef = useRef(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const sendMessageRef = useRef<(t?: string) => void>(() => {})

  // STT
  const [recording, setRecording] = useState(false)
  const [vadActive, setVadActive] = useState(false)
  const [sttBusy, setSttBusy] = useState(false)
  const [sttResult, setSttResult] = useState<{ text: string; language?: string } | null>(null)
  const [sttError, setSttError] = useState('')
  const sttStreamRef = useRef<MediaStream | null>(null)
  const sttCtxRef = useRef<AudioContext | null>(null)
  const sttRecRef = useRef<MediaRecorder | null>(null)
  const sttChunksRef = useRef<Blob[]>([])
  const sttSilenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sttListeningRef = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)

  // AudioContext unlock
  useEffect(() => {
    const unlock = () => {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      audioCtxRef.current.state === 'suspended' && audioCtxRef.current.resume().catch(() => {})
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  }, [])

  // ── TTS ──
  const playTTS = useCallback(async (text: string) => {
    // 응답이 연달아 오면(스트리밍 지연 등으로) 이전 호출의 오디오가 뒤늦게 재생되어
    // 화면에 보이는 최신 답변과 다른 내용을 읽는 문제를 막는다 — 이전 재생을 즉시 끊고,
    // 이 호출 이후에 더 새로운 호출이 시작되면 이 호출은 재생하지 않고 조용히 종료한다.
    const myGen = ++ttsGenRef.current
    if (activeAudioRef.current) { activeAudioRef.current.pause(); activeAudioRef.current = null }
    try { speechSynthesis.cancel() } catch { /**/ }
    setBlockedAudio(null)

    setSpeaking(true); speakingRef.current = true
    emotionRef.current = classifyEmotion(text)
    // 답변이 길면 첫 문장만 읽고 나머지는 채팅창을 보라고 안내 — TTS로 실제 재생되는
    // 텍스트는 이 짧은 버전이다 (긴 텍스트는 XTTS가 느려지거나 실패하기 쉽다).
    const spoken = buildSpokenText(text)
    let finished = false
    const failsafe = setTimeout(() => done(), 2000 + spoken.length * 200)
    const done = () => {
      if (finished) return; finished = true
      clearTimeout(failsafe)
      if (myGen !== ttsGenRef.current) return // 이미 더 새로운 응답으로 대체됨
      setSpeaking(false); speakingRef.current = false
      emotionRef.current = 'neutral'
    }
    try {
      const form = new FormData(); form.append('text', spoken)
      form.append('voice', selectedVoice.kind === 'template' ? selectedVoice.id : 'mine')
      const res = await fetch(`${API}/avatar/tts_only`, { method: 'POST', body: form })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      if (myGen !== ttsGenRef.current) return // 대기하는 동안 더 새로운 응답이 시작됨
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      activeAudioRef.current = audio
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /**/ } }
      if (myGen !== ttsGenRef.current) { URL.revokeObjectURL(url); return }
      // AudioContext가 running이 아니면 립싱크 분석용 그래프에 태우지 않는다 — 그 상태로
      // createMediaElementSource에 연결하면 오디오가 먼 채널로 재생될 수 있다.
      // 립싱크 없이 원본 경로로 재생하더라도 "소리가 나는 것"이 항상 우선이다.
      if (ctx.state === 'running') {
        const src = ctx.createMediaElementSource(audio)
        const analyser = ctx.createAnalyser(); analyser.fftSize = 64
        src.connect(analyser); analyser.connect(ctx.destination)
        lipsyncAnalyserRef.current = analyser
      } else {
        console.warn('[TTS] AudioContext가 running이 아니어서(', ctx.state, ') 립싱크 없이 원본 경로로 재생합니다')
      }
      lipCuesRef.current = []  // 발음 타이밍 큐 도착 전까지는 주파수 대역 근사로 폴백
      const cleanup = () => {
        done()
        if (activeAudioRef.current === audio) activeAudioRef.current = null
        if (myGen === ttsGenRef.current) { lipsyncAnalyserRef.current = null; lipCuesRef.current = [] }
        URL.revokeObjectURL(url)
      }
      audio.onended = cleanup; audio.onerror = cleanup
      audio.play().catch(e => {
        console.error('[TTS] audio.play() 거부됨 — 자동재생 정책일 가능성 높음', e?.name, e?.message)
        // 자동재생 차단 시 지금 바로 정리하지 않고, 사용자가 직접 눌러서 재생할 수 있게 남겨둔다.
        if (myGen === ttsGenRef.current) setBlockedAudio(audio)
        else cleanup()
      })
      // 재생과 별개로 정확한 발음 타이밍 분석 요청 — 도착하면 주파수 근사 대신 이 큐를 사용
      const cuesForm = new FormData(); cuesForm.append('audio', blob, 'tts.wav')
      fetch(`${API}/avatar/lipsync_cues`, { method: 'POST', body: cuesForm })
        .then(r => r.json())
        .then(data => { if (activeAudioRef.current === audio && Array.isArray(data?.cues)) lipCuesRef.current = data.cues })
        .catch(() => {})
    } catch {
      if (myGen !== ttsGenRef.current) return
      const u = new SpeechSynthesisUtterance(spoken)
      u.lang = 'ko-KR'; u.rate = 0.95; u.onend = done; u.onerror = done
      speechSynthesis.speak(u)
    }
  }, [selectedVoice])

  // ── STT ──
  const THRESHOLD = 20
  const SILENCE_MS = 1200

  const transcribeChunk = useCallback(async (chunks: Blob[]) => {
    if (!chunks.length) return
    const blob = new Blob(chunks, { type: 'audio/webm' })
    if (!blob.size) return
    setSttBusy(true); sttBusyRef.current = true
    try {
      const form = new FormData(); form.append('audio', blob, 'stt.webm')
      const res = await fetch(`${API}/stt/transcribe`, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) })
      const data = await res.json()
      if (data.error) { setSttError(data.error) }
      else {
        const text = (data.text || '').trim()
        setSttResult({ text, language: data.language })
        if (text) sendMessageRef.current(text)
      }
    } catch (e) {
      setSttError(e instanceof DOMException && e.name === 'TimeoutError'
        ? '음성 인식이 아직 준비 중이거나 처리가 느립니다 — 잠시 후 다시 시도하세요'
        : '인식 요청 실패 — API 서버 연결을 확인해주세요')
    }
    finally { setSttBusy(false); sttBusyRef.current = false }
  }, [])

  const stopStt = useCallback(() => {
    sttListeningRef.current = false
    if (sttSilenceTimer.current) { clearTimeout(sttSilenceTimer.current); sttSilenceTimer.current = null }
    sttRecRef.current?.stop(); sttRecRef.current = null
    sttCtxRef.current?.close(); sttCtxRef.current = null
    sttStreamRef.current?.getTracks().forEach(t => t.stop()); sttStreamRef.current = null
    setRecording(false); setVadActive(false)
  }, [])

  // 지금 재생 중인(또는 대기 중인) 음성을 즉시 멈춘다. 듣기 모드가 켜져 있으면 함께 끈다 —
  // 아바타 목소리를 마이크가 다시 알아듣고 응답→재생을 반복하는 피드백 루프를 끊기 위함이기도 하다.
  const stopSpeaking = useCallback(() => {
    ttsGenRef.current++ // 아직 도착하지 않은 이전 TTS 응답은 이제 재생되지 않는다
    if (activeAudioRef.current) { activeAudioRef.current.pause(); activeAudioRef.current = null }
    try { speechSynthesis.cancel() } catch { /* ignore */ }
    lipsyncAnalyserRef.current = null
    lipCuesRef.current = []
    setBlockedAudio(null)
    setSpeaking(false); speakingRef.current = false
    emotionRef.current = 'neutral'
    if (recording) stopStt()
  }, [recording, stopStt])

  const startStt = useCallback(async () => {
    if (recording) { stopStt(); return }
    setSttError(''); setSttResult(null); sttBusyRef.current = false
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch (e) { setSttError('마이크 접근 실패: ' + (e instanceof Error ? e.message : String(e))); return }
    sttStreamRef.current = stream; sttListeningRef.current = true; setRecording(true)
    const ctx = new AudioContext(); sttCtxRef.current = ctx
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512; src.connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)
    let isRecording = false
    const tick = () => {
      if (!sttListeningRef.current) return
      if (speakingRef.current || sttBusyRef.current) { if (!isRecording) { requestAnimationFrame(tick); return } }
      analyser.getByteFrequencyData(buf)
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length
      if (avg > THRESHOLD) {
        setVadActive(true)
        if (sttSilenceTimer.current) { clearTimeout(sttSilenceTimer.current); sttSilenceTimer.current = null }
        if (!isRecording) {
          isRecording = true; sttChunksRef.current = []
          const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
          rec.ondataavailable = e => { if (e.data.size > 0) sttChunksRef.current.push(e.data) }
          rec.onstop = () => { isRecording = false; setVadActive(false); transcribeChunk([...sttChunksRef.current]) }
          rec.start(); sttRecRef.current = rec
        }
        sttSilenceTimer.current = setTimeout(() => {
          sttRecRef.current?.stop(); sttRecRef.current = null; setVadActive(false)
        }, SILENCE_MS)
      }
      requestAnimationFrame(tick)
    }
    tick()
  }, [recording, stopStt, transcribeChunk])

  // 마이크 접근은 사용자가 마이크 버튼을 눌렀을 때만 시작한다.
  useEffect(() => {
    return () => stopStt()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── GLB 로더 ──
  const loadGLB = useCallback((url: string) => {
    const container = containerRef.current
    if (!container) return
    setLoading(true); setError(''); setAvatarLoaded(false)
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    if (rendererRef.current) { rendererRef.current.dispose(); container.innerHTML = '' }

    const rect = container.getBoundingClientRect()
    const w = rect.width || container.offsetWidth || 800
    const h = rect.height || container.offsetHeight || 600
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(w, h); renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.shadowMap.enabled = true
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    container.appendChild(renderer.domElement); rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d1b2a)

    // Avaturn GLB는 glTF PBR(금속/거칠기) 재질이라 환경 반사가 없으면 피부·눈·머리카락이
    // 밋밋한 플라스틱처럼 보인다 — 별도 HDRI 파일 없이 절차적 환경(RoomEnvironment)으로 IBL을 채움
    if (envTextureRef.current) envTextureRef.current.dispose()
    const pmrem = new THREE.PMREMGenerator(renderer)
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    scene.environment = envTexture
    envTextureRef.current = envTexture

    scene.add(new THREE.AmbientLight(0xffffff, 0.35))
    const dir = new THREE.DirectionalLight(0xfff4e8, 1.8); dir.position.set(1, 3, 2); scene.add(dir)
    const fillLight = new THREE.DirectionalLight(0x8fa8d9, 0.5)
    fillLight.position.set(-2, 1, -1)
    scene.add(fillLight)
    const rimLight = new THREE.DirectionalLight(0xffffff, 0.7)
    rimLight.position.set(-1, 2, -3)
    scene.add(rimLight)

    // 얼굴만/상반신/전체 보기 토글에 맞춰 초기 카메라 프레이밍 결정
    const preset = VIEW_PRESETS[viewModeRef.current]
    const camera = new THREE.PerspectiveCamera(preset.fov, w / h, 0.1, 100)
    camera.position.set(...preset.pos)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(...preset.target); controls.enableDamping = true; controls.dampingFactor = 0.05
    controls.minDistance = 0.4; controls.maxDistance = 6; controls.update()
    cameraRef.current = camera; controlsRef.current = controls

    new GLTFLoader().load(url, (gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const scale = 1.8 / size.y
      gltf.scene.scale.setScalar(scale)
      gltf.scene.position.sub(center.multiplyScalar(scale))
      gltf.scene.position.y += size.y * scale * 0.5 - 0.1
      scene.add(gltf.scene)
      if (gltf.animations.length > 0) {
        const mixer = new THREE.AnimationMixer(gltf.scene); mixerRef.current = mixer
        const idle = gltf.animations.find(a => /idle|stand|wait/i.test(a.name)) ?? gltf.animations[0]
        mixer.clipAction(idle).play()
      }

      // 입싱크(viseme 근사) + 표정용 모프타겟 전체 수집
      // 동일한 타겟 이름(jawOpen 등)이 여러 메시(얼굴/눈/치아)에 중복 존재하므로 전부 보관
      const morphMap: Record<string, MorphRef[]> = {}
      gltf.scene.traverse(obj => {
        const mesh = obj as THREE.Mesh
        const dict = mesh.morphTargetDictionary
        if (!dict) return
        Object.entries(dict).forEach(([name, idx]) => {
          (morphMap[name] ??= []).push({ mesh, index: idx })
        })
      })
      morphMapRef.current = morphMap
      const groups: Record<string, string[]> = {}
      Object.entries(MORPH_GROUPS).forEach(([group, patterns]) => {
        groups[group] = Object.keys(morphMap).filter(k => patterns.some(p => p.test(k)))
      })
      // 깜빡임은 느린 lerp를 거치면 흐릿해지므로 별도 처리(빠른 닫힘/열림 곡선을 직접 대입)
      blinkKeysRef.current = groups.blink ?? []
      delete groups.blink
      morphGroupsRef.current = groups
      morphValuesRef.current = {}
      if (!Object.values(groups).some(arr => arr.length > 0)) {
        console.warn('[RealisticAvatar] 입싱크/표정용 모프타겟을 GLB에서 찾지 못함 — 비활성')
      }

      setLoading(false); setAvatarLoaded(true)
      const animate = () => {
        animFrameRef.current = requestAnimationFrame(animate)
        const dt = clockRef.current.getDelta()
        mixerRef.current?.update(dt)

        // 자동 눈 깜빡임 — 빠른 닫힘/열림 곡선을 직접 대입(lerp 없이)
        if (blinkKeysRef.current.length > 0) {
          const blink = blinkStateRef.current
          blink.elapsed += dt * 1000
          let blinkValue = 0
          const CLOSE_MS = 90, OPEN_MS = 130
          if (blink.phase === 'closing') {
            blinkValue = Math.min(1, blink.elapsed / CLOSE_MS)
            if (blink.elapsed >= CLOSE_MS) { blink.phase = 'opening'; blink.elapsed = 0 }
          } else if (blink.phase === 'opening') {
            blinkValue = Math.max(0, 1 - blink.elapsed / OPEN_MS)
            if (blink.elapsed >= OPEN_MS) { blink.phase = 'idle'; blink.elapsed = 0; blink.next = 2000 + Math.random() * 4000 }
          } else if (blink.elapsed >= blink.next) {
            blink.phase = 'closing'; blink.elapsed = 0
          }
          blinkKeysRef.current.forEach(key => {
            morphMapRef.current[key]?.forEach(ref => {
              const influences = ref.mesh.morphTargetInfluences
              if (influences) influences[ref.index] = blinkValue
            })
          })
        }

        // 주파수 대역 기반 입싱크(viseme 근사) + 감정 기반 표정
        const groups = morphGroupsRef.current
        if (Object.keys(groups).length > 0) {
          const analyser = lipsyncAnalyserRef.current
          let low = 0, mid = 0, high = 0
          if (analyser) {
            const buf = new Uint8Array(analyser.frequencyBinCount)
            analyser.getByteFrequencyData(buf)
            const n = buf.length
            const bandAvg = (s: number, e: number) => {
              let sum = 0; for (let i = s; i < e; i++) sum += buf[i]
              return sum / Math.max(1, e - s)
            }
            low = bandAvg(0, Math.floor(n * 0.33))
            mid = bandAvg(Math.floor(n * 0.33), Math.floor(n * 0.66))
            high = bandAvg(Math.floor(n * 0.66), n)
          }
          const norm = (v: number) => Math.min(1, Math.max(0, (v - 8) / 50))
          const ew = EMOTION_WEIGHTS[emotionRef.current] || {}

          // Rhubarb 발음 타이밍 큐가 도착했으면 그걸로 정확한 입모양을, 아직이면 주파수 대역 근사로 폴백
          const cues = lipCuesRef.current
          const audioEl = activeAudioRef.current
          let mouthShape: Partial<Record<string, number>> | null = null
          if (cues.length > 0 && audioEl && !audioEl.paused) {
            const t = audioEl.currentTime
            const cue = cues.find(c => t >= c.start && t < c.end) ?? null
            mouthShape = cue ? (RHUBARB_SHAPE_TARGETS[cue.value] ?? {}) : {}
          }

          const targets: Record<string, number> = mouthShape ? {
            aa: mouthShape.aa ?? 0,
            oo: mouthShape.oo ?? 0,
            ee: mouthShape.ee ?? 0,
            consonant: mouthShape.consonant ?? 0,
            smile: ew.smile ?? 0,
            frown: ew.frown ?? 0,
            browUp: ew.browUp ?? 0,
            browDown: ew.browDown ?? 0,
            squint: ew.squint ?? 0,
          } : {
            aa: norm(low) * 0.9,
            oo: norm(mid) * 0.5,
            ee: norm(high) * 0.5,
            consonant: norm(high) * 0.3,
            smile: ew.smile ?? 0,
            frown: ew.frown ?? 0,
            browUp: ew.browUp ?? 0,
            browDown: ew.browDown ?? 0,
            squint: ew.squint ?? 0,
          }
          Object.entries(groups).forEach(([group, keys]) => {
            const target = targets[group] ?? 0
            keys.forEach(key => {
              const refs = morphMapRef.current[key]
              if (!refs?.length) return
              const cur = morphValuesRef.current[key] ?? 0
              const next = cur + (target - cur) * 0.35
              morphValuesRef.current[key] = next
              refs.forEach(ref => {
                const influences = ref.mesh.morphTargetInfluences
                if (influences) influences[ref.index] = next
              })
            })
          })
        }

        controls.update(); renderer.render(scene, camera)
      }
      animate()
      const onResize = () => {
        const w2 = container.clientWidth, h2 = container.clientHeight
        camera.aspect = w2 / h2; camera.updateProjectionMatrix(); renderer.setSize(w2, h2)
      }
      window.addEventListener('resize', onResize)
    }, undefined, (err) => { setError(String(err)); setLoading(false) })
  }, [])

  // 마운트 시 마지막 GLB 자동 로드
  useEffect(() => {
    const lastName = localStorage.getItem(AVATAR_FILE_KEY)
    if (!lastName) return
    idbList().then(list => {
      const entry = list.find(e => e.name === lastName) || list[0]
      if (entry) {
        const blob = new Blob([entry.data], { type: 'model/gltf-binary' })
        const url = URL.createObjectURL(blob)
        objectUrlRef.current = url
        setFileName(entry.name)
        loadGLB(url)
      }
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.glb')) { setError('GLB 파일만 지원합니다'); return }
    file.arrayBuffer().then(data => {
      idbSave({ name: file.name, size: file.size, data, loadedAt: Date.now() })
        .then(refreshList).catch(() => {})
    })
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const url = URL.createObjectURL(file); objectUrlRef.current = url
    localStorage.setItem(AVATAR_FILE_KEY, file.name); setFileName(file.name)
    setShowList(false)
    loadGLB(url)
  }, [loadGLB, refreshList])

  const loadFromIDB = useCallback((entry: GlbEntry) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    const blob = new Blob([entry.data], { type: 'model/gltf-binary' })
    const url = URL.createObjectURL(blob); objectUrlRef.current = url
    localStorage.setItem(AVATAR_FILE_KEY, entry.name); setFileName(entry.name)
    setShowList(false)
    idbSave({ ...entry, loadedAt: Date.now() }).then(refreshList).catch(() => {})
    loadGLB(url)
  }, [loadGLB, refreshList])

  useEffect(() => () => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    rendererRef.current?.dispose()
    envTextureRef.current?.dispose()
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  // ── 채팅 ──
  const buildSystemPrompt = useCallback(async (userText: string): Promise<string> => {
    try {
      const res = await fetch(`${API}/avatar/context?q=${encodeURIComponent(userText)}`)
      const data = await res.json()
      if (data?.system) return data.system
    } catch { /**/ }
    return SYSTEM
  }, [])

  const logTurn = useCallback((role: 'user' | 'assistant', content: string) => {
    if (!content.trim()) return
    fetch(`${API}/conversation/log`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: 'realistic_avatar', role, content }),
    }).catch(() => {})
  }, [])

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()
    if (!text || chatLoading) return
    const userMsg: ChatMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg]); setInput(''); setChatLoading(true)
    logTurn('user', text)
    try {
      const history = [...messages, userMsg].slice(-8)
      const system = await buildSystemPrompt(text)
      let reply = ''
      if (settings.aiProvider === 'ollama') {
        await streamChatOllama(settings.ollamaEndpoint, settings.ollamaModel, history, system,
          d => { reply += d })
      } else {
        let key = settings.claudeSessionKey
        if (!key && settings.mcpEndpoint) key = await claudeWebAutoConnect(settings.mcpEndpoint) || ''
        await streamClaudeWeb(key, settings.mcpEndpoint, history, system,
          d => { reply += d }, settings.anthropicApiKey)
      }
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
      if (reply) { logTurn('assistant', reply); playTTS(reply) }
    } catch {
      const errMsg = '죄송합니다. 일시적인 오류가 발생했습니다.'
      setMessages(prev => [...prev, { role: 'assistant', content: errMsg }])
      playTTS(errMsg)
    } finally { setChatLoading(false) }
  }, [input, chatLoading, messages, settings, buildSystemPrompt, logTurn, playTTS, setMessages])

  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // 첫 진입 시 이전 대화 불러오기(있으면 이어서 표시) — 없으면 인사로 시작
  useEffect(() => {
    if (messages.length > 0) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const since = localStorage.getItem(CHAT_SINCE_KEY) || ''
        const res = await fetch(`${API}/conversation/history?view=realistic_avatar&limit=50&since=${encodeURIComponent(since)}`)
        const data = await res.json()
        if (!cancelled && Array.isArray(data?.messages) && data.messages.length > 0) {
          setMessages(data.messages)
          return
        }
      } catch { /* 조회 실패 시 인사로 폴백 */ }
      if (cancelled) return
      setMessages([{ role: 'assistant', content: GREETING }])
      playTTS(GREETING)
    }, 800)
    return () => { cancelled = true; clearTimeout(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 새로 시작: 이전 대화를 더 이상 불러오지 않도록 기준 시각 기록 후 인사로 초기화
  const resetChat = useCallback(() => {
    localStorage.setItem(CHAT_SINCE_KEY, localTimestamp())
    setMessages([{ role: 'assistant', content: GREETING }])
    playTTS(GREETING)
    // XTTS 워커가 죽어있으면(예: 재부팅 후) 여기서도 확인해서 다시 띄운다. 이미 떠 있으면 서버가 아무 것도 안 함.
    fetch(`${API}/avatar/xtts/ensure`, { method: 'POST' }).catch(() => {})
  }, [setMessages, playTTS])

  const isConnected = settings.aiProvider === 'ollama' || !!(settings.claudeSessionKey || settings.anthropicApiKey)

  return (
    <div className="flex h-full overflow-hidden bg-gray-950">
      {/* 음성 서버(TTS·STT) 준비/오류 안내 — 정상일 땐 보이지 않음 */}
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] max-w-[92vw] pointer-events-none [&>*]:pointer-events-auto">
        <VoiceServiceBanner />
      </div>
      {/* 3D 뷰어 */}
      <div
        className={`flex-1 relative ${dragging ? 'ring-2 ring-blue-500 ring-inset' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
      >
        <div ref={containerRef} className="w-full h-full" />

        {/* 파일 선택 + 목록 (좌상단) */}
        <div className="absolute top-3 left-3 z-20 flex flex-col gap-1">
          <div className="flex gap-1">
            <label className="flex items-center gap-2 bg-black/50 backdrop-blur text-xs text-gray-300 hover:text-white rounded-lg px-3 py-1.5 cursor-pointer border border-gray-700 hover:border-gray-500 transition-colors">
              📁 GLB 파일 선택
              <input type="file" accept=".glb" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
            </label>
            {glbList.length > 0 && (
              <button
                onClick={() => setShowList(v => !v)}
                className="bg-black/50 backdrop-blur text-xs text-gray-300 hover:text-white rounded-lg px-2 py-1.5 border border-gray-700 hover:border-gray-500 transition-colors"
                title="저장된 아바타 목록"
              >
                {showList ? '▲' : '▼'} {glbList.length}
              </button>
            )}
          </div>
          {avatarLoaded && fileName && (
            <p className="text-[10px] text-gray-400 px-1 truncate max-w-[220px]">현재: {fileName}</p>
          )}
          <button
            onClick={() => setShowGuide(v => !v)}
            className="self-start text-[10px] text-gray-400 hover:text-white px-1 text-left"
          >
            {showGuide ? '▲' : '❓'} GLB 만드는 법
          </button>
          {showGuide && (
            <div className="bg-black/80 backdrop-blur border border-gray-700 rounded-xl p-3 max-w-[260px] text-[11px] text-gray-300 space-y-1.5 leading-relaxed">
              <p>1. 본인 정면 얼굴 사진 준비</p>
              <p>
                2. <a href="https://avaturn.me" target="_blank" rel="noreferrer" className="text-purple-300 underline">avaturn.me</a>에서
                사진 업로드 → 아바타 커스터마이즈
              </p>
              <p className="text-amber-300">
                ⚠️ 얼굴 타입은 꼭 <b>T2</b> 선택 (T1은 얼굴 고정이라 입이 안 움직임)
              </p>
              <p>3. Download → glTF Binary(.glb)로 저장</p>
              <p>4. 위 "GLB 파일 선택"으로 불러오기</p>
            </div>
          )}
          {showList && (
            <div className="bg-black/80 backdrop-blur border border-gray-700 rounded-xl overflow-hidden min-w-[220px] max-h-64 overflow-y-auto">
              {glbList.map(entry => (
                <div key={entry.name} className="flex items-center gap-1 px-2 py-1.5 hover:bg-gray-800/80 group">
                  <button
                    onClick={() => loadFromIDB(entry)}
                    className="flex-1 text-left text-xs text-gray-300 hover:text-white truncate"
                  >
                    {entry.name === fileName ? '▶ ' : ''}{entry.name}
                    <span className="ml-1 text-[10px] text-gray-500">{(entry.size / 1024 / 1024).toFixed(1)}MB</span>
                  </button>
                  <button
                    onClick={() => idbDelete(entry.name).then(refreshList)}
                    className="text-[10px] text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-1"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 목소리 선택 (우상단) */}
        <div className="absolute top-3 right-3 z-20 flex flex-col items-end gap-2 bg-black/40 backdrop-blur rounded-xl p-2">
          <div>
            <span className="text-[10px] text-gray-400 px-1">보기</span>
            <div className="flex flex-wrap justify-end gap-1 max-w-[12rem]">
              {(['face', 'upper', 'full'] as ViewMode[]).map(m => (
                <button key={m} onClick={() => setView(m)}
                  className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${viewMode === m ? 'bg-purple-600 border-purple-400 text-white' : 'bg-gray-800/70 border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
                  {VIEW_MODE_LABELS[m]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="text-[10px] text-gray-400 px-1">목소리</span>
            <div className="flex flex-wrap justify-end gap-1 max-w-[12rem]">
              {voiceOptions.map(v => (
                <button key={v.id} onClick={() => { setVoiceOptionId(v.id); localStorage.setItem(VOICE_OPTION_KEY, v.id) }}
                  className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${voiceOptionId === v.id ? 'bg-purple-600 border-purple-400 text-white' : 'bg-gray-800/70 border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 안내 / 로딩 / 에러 */}
        {!avatarLoaded && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 gap-2 pointer-events-none">
            <p className="text-sm">GLB 파일을 드래그하거나 좌상단에서 선택하세요</p>
          </div>
        )}
        {loading && <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm pointer-events-none">아바타 로딩 중...</div>}
        {dragging && <div className="absolute inset-0 flex items-center justify-center bg-blue-900/30 text-blue-300 text-lg font-semibold pointer-events-none">GLB 파일을 놓으세요</div>}

        {speaking && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-black/50 backdrop-blur px-4 py-2 rounded-full">
            <div className="flex gap-1 items-end">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="w-1 bg-blue-400 rounded-full animate-bounce" style={{ height: `${8 + Math.sin(i * 1.2) * 7}px`, animationDelay: `${i * 0.1}s` }} />
              ))}
            </div>
            <span className="text-xs text-blue-300">말하는 중</span>
            <button onClick={stopSpeaking}
              className="ml-1 text-xs px-2 py-0.5 rounded-full border border-red-500 bg-red-900/70 text-red-300 hover:bg-red-800 transition">
              ■ 중단
            </button>
          </div>
        )}
        {blockedAudio && (
          <button
            onClick={() => { blockedAudio.play().then(() => setBlockedAudio(null)).catch(() => {}) }}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-yellow-900/80 border border-yellow-500 backdrop-blur px-4 py-2 rounded-full text-xs text-yellow-200 hover:bg-yellow-800 transition animate-pulse">
            🔇 자동재생이 차단됨 — 눌러서 재생
          </button>
        )}
        {error && <div className="absolute bottom-4 left-4 right-4 bg-red-900/80 text-red-200 text-xs p-2 rounded">{error}</div>}
      </div>

      {/* 채팅 패널 — Avatar3DChat과 동일 구조 */}
      <div className="w-80 flex flex-col border-l border-gray-800 bg-gray-900/95">
        <div className="px-4 py-3 border-b border-gray-800 bg-gray-900">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`} />
              <h2 className="text-sm font-semibold text-gray-200">실사 아바타</h2>
            </div>
            <button onClick={resetChat}
              className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 rounded px-2 py-0.5 hover:bg-gray-800">
              새로 시작
            </button>
          </div>
          <div className="flex items-center justify-between mt-0.5">
            <p className="text-xs text-gray-500">
              {isConnected ? '응답 시 자동으로 음성 재생' : '설정에서 API Key를 입력해주세요'}
            </p>
            <div className="flex items-center gap-1">
              <div className={`w-1.5 h-1.5 rounded-full ${serverOnline ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-[10px] text-gray-500">{serverOnline ? 'API' : 'API 꺼짐'}</span>
              {!serverOnline && (
                <button onClick={checkServer}
                  className="text-[10px] text-blue-400 hover:text-blue-300 underline ml-1">
                  재연결
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <div className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs mr-2 shrink-0 mt-0.5">🤖</div>
              )}
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${m.role === 'user' ? 'bg-blue-700 text-white rounded-tr-sm' : 'bg-gray-800 text-gray-200 rounded-tl-sm'}`}>
                {m.content}
              </div>
            </div>
          ))}
          {chatLoading && (
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs shrink-0">🤖</div>
              <div className="bg-gray-800 rounded-2xl rounded-tl-sm px-3 py-2 flex gap-1">
                {[0,1,2].map(i => <div key={i} className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />)}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="p-3 border-t border-gray-800 space-y-2">
          {(recording || sttBusy || sttResult || sttError) && (
            <div className="bg-gray-800/80 border border-gray-700 rounded-xl px-3 py-2 text-xs space-y-1">
              {recording && !sttBusy && (
                <p className={vadActive ? 'text-green-400' : 'text-gray-400'}>
                  {vadActive ? '🎙 듣는 중…' : '👂 대기 중… 말씀해보세요'}
                </p>
              )}
              {sttBusy && <p className="text-gray-400">⏳ 인식 처리 중…</p>}
              {sttResult && !sttBusy && (
                <p className="text-gray-300">
                  <span className="text-gray-500">인식: </span>
                  <span className="text-gray-100 font-medium">{sttResult.text || '(인식된 텍스트 없음)'}</span>
                </p>
              )}
              {sttError && <p className="text-red-400">{sttError}</p>}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={startStt}
              title={recording ? '듣기 모드 끄기' : '듣기 모드 켜기'}
              className={`px-3 py-2 text-sm rounded-xl transition ${recording ? (vadActive ? 'bg-green-600 hover:bg-green-500 text-white animate-pulse' : 'bg-red-600 hover:bg-red-500 text-white') : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700'}`}>
              {recording ? (vadActive ? '🎙' : '👂') : '🎤'}
            </button>
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="무엇이든 물어보세요…"
              disabled={!isConnected}
              className="flex-1 bg-gray-800 text-sm text-gray-200 rounded-xl px-3 py-2 outline-none border border-gray-700 focus:border-blue-600 placeholder-gray-600 disabled:opacity-40" />
            <button onClick={() => sendMessage()}
              disabled={!input.trim() || chatLoading || !isConnected}
              className="px-3 py-2 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-800 disabled:text-gray-600 text-sm rounded-xl transition">
              ↑
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
