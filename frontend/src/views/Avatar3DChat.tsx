/**
 * Avatar3DChat — 리셉션 3D 아바타
 * 사용자를 맞이하고 LLM 출력을 TTS로 전달하는 역할
 */
import { useEffect, useRef, useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import * as THREE from 'three'
import { streamClaudeWeb, claudeWebAutoConnect } from '@/services/claudeWeb'
import FaceTrackingPanel from './FaceTrackingPanel'
import type { Settings } from '@/types'

const API = 'http://127.0.0.1:8766'

const GREETING = '안녕하세요! 반갑습니다. 무엇이든 도와드리겠습니다.'
const SYSTEM   = `당신은 사용자를 맞이하는 AI 리셉션 아바타입니다.
따뜻하고 전문적으로 한국어로 응대하세요.
답변은 2~3문장으로 간결하게 하고, 항상 친절한 어조를 유지하세요.`

const RECEPTION_NOTE = `## 지금 상황
나는 지금 방문객을 맞이하는 리셉션 모드입니다. 따뜻하고 전문적으로 응대하고,
답변은 2~3문장으로 간결하게 하세요.`

export interface ChatMsg { role: 'user' | 'assistant'; content: string }
interface Props {
  settings: Settings
  messages: ChatMsg[]
  setMessages: Dispatch<SetStateAction<ChatMsg[]>>
}

// ── 3D 아바타 외형 스타일 후보군 ──
interface AvatarStyle {
  id: string
  label: string
  skin: number
  hair: number
  shirt: number
  hairStyle: 'long' | 'short' | 'bald'
  glasses: boolean
}
const AVATAR_STYLES: AvatarStyle[] = [
  { id: 'classic',  label: '클래식 단발',   skin: 0xf2c4a0, hair: 0x1a1008, shirt: 0x1e3a5f, hairStyle: 'long',  glasses: false },
  { id: 'short',    label: '짧은머리',      skin: 0xead2b4, hair: 0x3b2a1a, shirt: 0x44474f, hairStyle: 'short', glasses: false },
  { id: 'glasses',  label: '안경 쓴 스타일', skin: 0xf2c4a0, hair: 0x6b4423, shirt: 0x2f6f6a, hairStyle: 'long',  glasses: true  },
  { id: 'blonde',   label: '밝은 톤',       skin: 0xf5d2b0, hair: 0xcaa86a, shirt: 0x6b2737, hairStyle: 'bald',  glasses: false },
]
const AVATAR_STYLE_KEY = 'mental-avatar-3d-style'

// ── 목소리 후보군: '내 목소리'(XTTS 클로닝) + 서버 제공 템플릿(예쁜/어린이 등) + 브라우저 내장 TTS 목소리들 ──
interface VoiceOption { id: string; label: string; kind: 'clone' | 'template' | 'system'; voiceURI?: string }
const MY_VOICE: VoiceOption = { id: 'mine', label: '내 목소리', kind: 'clone' }
// 백엔드 VOICE_TEMPLATES와 id를 맞춰야 함 (api/server.py)
const TEMPLATE_VOICES: VoiceOption[] = [
  { id: 'pretty', label: '예쁜 목소리', kind: 'template' },
  { id: 'child',  label: '어린이 목소리', kind: 'template' },
  { id: 'calm',   label: '차분한 목소리', kind: 'template' },
  { id: 'bright', label: '발랄한 목소리', kind: 'template' },
]
const VOICE_OPTION_KEY = 'mental-avatar-3d-voice'

export default function Avatar3DChat({ settings, messages, setMessages }: Props) {
  const [avatarStyleId, setAvatarStyleId] = useState<string>(() => {
    try { return localStorage.getItem(AVATAR_STYLE_KEY) || AVATAR_STYLES[0].id } catch { return AVATAR_STYLES[0].id }
  })
  const avatarStyle = AVATAR_STYLES.find(s => s.id === avatarStyleId) || AVATAR_STYLES[0]
  const selectAvatarStyle = (id: string) => {
    setAvatarStyleId(id)
    try { localStorage.setItem(AVATAR_STYLE_KEY, id) } catch { /* ignore */ }
  }

  // 목소리 선택 — '내 목소리'(XTTS 클로닝) 또는 브라우저 내장 TTS의 다른 목소리들 중 선택
  const [systemVoices, setSystemVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    const load = () => {
      const voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('ko') || v.lang.startsWith('en'))
      if (voices.length) setSystemVoices(voices.slice(0, 6))
    }
    load()
    speechSynthesis.onvoiceschanged = load
    return () => { speechSynthesis.onvoiceschanged = null }
  }, [])
  const voiceOptions: VoiceOption[] = [
    MY_VOICE,
    ...TEMPLATE_VOICES,
    ...systemVoices.map(v => ({ id: `sys:${v.voiceURI}`, label: v.name, kind: 'system' as const, voiceURI: v.voiceURI })),
  ]
  const [voiceOptionId, setVoiceOptionId] = useState<string>(() => {
    try { return localStorage.getItem(VOICE_OPTION_KEY) || MY_VOICE.id } catch { return MY_VOICE.id }
  })
  const selectedVoice = voiceOptions.find(v => v.id === voiceOptionId) || MY_VOICE
  const selectVoiceOption = (id: string) => {
    setVoiceOptionId(id)
    try { localStorage.setItem(VOICE_OPTION_KEY, id) } catch { /* ignore */ }
  }

  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const clockRef   = useRef(new THREE.Clock())
  const rafRef     = useRef(0)

  // 아바타 파트
  const groupRef   = useRef<THREE.Group | null>(null)
  const jawRef     = useRef<THREE.Mesh | null>(null)
  const lipUpRef   = useRef<THREE.Mesh | null>(null)
  const lipDnRef   = useRef<THREE.Mesh | null>(null)
  const browLRef   = useRef<THREE.Mesh | null>(null)
  const browRRef   = useRef<THREE.Mesh | null>(null)
  const lidLRef    = useRef<THREE.Mesh | null>(null)
  const lidRRef    = useRef<THREE.Mesh | null>(null)
  const eyeGpLRef  = useRef<THREE.Group | null>(null)
  const eyeGpRRef  = useRef<THREE.Group | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef   = useRef<THREE.PerspectiveCamera | null>(null)

  // 오디오
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)

  // 웹캠 얼굴 추적 — FaceTrackingPanel이 매 프레임 전달하는 표정(블렌드셰이프) 점수.
  // 값이 들어오면(웹캠 ON) 3D 아바타 표정을 사용자 얼굴에 맞춰 구동한다.
  const faceBlendRef = useRef<Record<string, number> | null>(null)
  const handleFaceBlendshapes = useCallback((scores: Record<string, number> | null) => {
    faceBlendRef.current = scores
  }, [])
  const headPoseRef = useRef<{ pitch: number; yaw: number; roll: number } | null>(null)
  const handleHeadPose = useCallback((pose: { pitch: number; yaw: number; roll: number } | null) => {
    headPoseRef.current = pose
  }, [])

  // 브라우저 자동재생 정책 — AudioContext는 사용자 제스처 없이는 'suspended' 상태로 시작해 소리가 안 남.
  // 페이지 첫 클릭/키입력/터치에서 미리 생성·resume 해 둔다 (자동 인사 같은 무제스처 재생도 들리도록).
  useEffect(() => {
    const unlock = () => {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') ctx.resume().catch(() => {})
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [])

  // 채팅
  const [input, setInput]             = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [speaking, setSpeaking]       = useState(false)
  const speakingRef = useRef(false)   // 아바타가 말하는 중 (피드백 루프 방지용)
  const sttBusyRef  = useRef(false)   // STT 처리 중 (요청 중복 방지용)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const sendMessageRef = useRef<(overrideText?: string) => void>(() => {})

  // 음성 인식(STT) — VAD(음성 감지) 기반 자동 녹음: 한 번 누르면 말하기 시작/끝을 자동으로 감지
  const [recording, setRecording] = useState(false)   // 듣기 모드 on/off (마이크 켜짐)
  const [vadActive, setVadActive] = useState(false)   // 현재 음성이 감지되어 녹음 중인지
  const [sttBusy, setSttBusy]     = useState(false)
  const [sttResult, setSttResult] = useState<{ text: string; language?: string } | null>(null)
  const [sttError, setSttError]   = useState('')
  const sttStreamRef = useRef<MediaStream | null>(null)
  const sttCtxRef    = useRef<AudioContext | null>(null)
  const sttRecRef    = useRef<MediaRecorder | null>(null)
  const sttChunksRef = useRef<Blob[]>([])
  const sttSilenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sttListeningRef = useRef(false)

  // ── TTS ────────────────────────────────────────────────
  const playTTS = useCallback(async (text: string) => {
    setSpeaking(true); speakingRef.current = true
    const voice = selectedVoice
    // done은 한 번만 실행 + failsafe 타이머 해제. TTS가 어떤 경로로 실패하든 speaking 플래그가
    // 영구히 박혀 마이크가 막히는 일을 막는다.
    let finished = false
    const failsafe = setTimeout(() => done(), 2000 + text.length * 200)
    const done = () => {
      if (finished) return
      finished = true
      clearTimeout(failsafe)
      setSpeaking(false); speakingRef.current = false
    }

    // 시스템 목소리 선택 시 — 브라우저 내장 TTS로 직접 재생 (XTTS 호출 생략)
    if (voice.kind === 'system') {
      const u = new SpeechSynthesisUtterance(text)
      const matched = systemVoices.find(v => v.voiceURI === voice.voiceURI)
      if (matched) u.voice = matched
      u.lang = matched?.lang || 'ko-KR'
      u.rate = 0.95
      u.onend = done
      u.onerror = done
      try { speechSynthesis.cancel() } catch { /* ignore */ }
      speechSynthesis.speak(u)
      return
    }

    try {
      const form = new FormData(); form.append('text', text)
      form.append('voice', voice.kind === 'template' ? voice.id : 'mine')
      const res = await fetch(`${API}/avatar/tts_only`, { method: 'POST', body: form })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const audio = new Audio(url)
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /* ignore */ } }
      const analyser = ctx.createAnalyser(); analyser.fftSize = 64
      analyserRef.current = analyser
      const src = ctx.createMediaElementSource(audio)
      src.connect(analyser); analyser.connect(ctx.destination)
      const cleanup = () => { done(); analyserRef.current = null; URL.revokeObjectURL(url) }
      audio.onended = cleanup
      audio.onerror = cleanup
      // play()가 자동재생 정책에 막혀 reject되면 onended가 안 불려 speaking 상태가 영구히 박힘 → 반드시 풀어준다
      audio.play().catch(() => cleanup())
    } catch {
      // fallback: 브라우저 내장 TTS
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ko-KR'; u.rate = 0.95
      u.onend = done
      u.onerror = done
      try { speechSynthesis.cancel() } catch { /* ignore */ }
      speechSynthesis.speak(u)
    }
  }, [selectedVoice, systemVoices])

  const respond = useCallback((text: string) => { playTTS(text) }, [playTTS])

  // ── 음성 인식(STT) — VAD로 말하기 시작/끝을 자동 감지해 녹음·전송 ──
  const THRESHOLD   = 20   // 음성 감지 임계값 (0-255)
  const SILENCE_MS  = 1200 // 이 시간만큼 조용하면 "말하기 끝"으로 판단

  const transcribeChunk = useCallback(async (chunks: Blob[]) => {
    if (!chunks.length) return
    const blob = new Blob(chunks, { type: 'audio/webm' })
    if (!blob.size) return
    setSttBusy(true); sttBusyRef.current = true
    try {
      const form = new FormData()
      form.append('audio', blob, 'stt.webm')
      // 타임아웃(20초) — 서버가 느리거나 멈춰도 "처리 중"에 영구히 갇히지 않게
      const res = await fetch(`${API}/stt/transcribe`, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) })
      const data = await res.json()
      if (data.error) {
        setSttError(data.error)
      } else {
        const text = (data.text || '').trim()
        setSttResult({ text, language: data.language })
        if (text) sendMessageRef.current(text)   // 인식 끝나면 자동으로 대화 전송
      }
    } catch {
      setSttError('인식 요청 실패 — API 서버 연결을 확인해주세요')
    } finally {
      setSttBusy(false); sttBusyRef.current = false
    }
  }, [])

  const stopStt = useCallback(() => {
    sttListeningRef.current = false
    if (sttSilenceTimer.current) { clearTimeout(sttSilenceTimer.current); sttSilenceTimer.current = null }
    sttRecRef.current?.stop()
    sttRecRef.current = null
    sttCtxRef.current?.close()
    sttCtxRef.current = null
    sttStreamRef.current?.getTracks().forEach(t => t.stop())
    sttStreamRef.current = null
    setRecording(false); setVadActive(false)
  }, [])

  const startStt = useCallback(async () => {
    if (recording) { stopStt(); return }
    setSttError(''); setSttResult(null)
    sttBusyRef.current = false   // 혹시 박혀있을 수 있는 처리중 플래그 초기화 (안전장치)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      setSttError('마이크 접근 실패: ' + (e instanceof Error ? e.message : String(e)))
      return
    }
    sttStreamRef.current = stream
    sttListeningRef.current = true
    setRecording(true)

    const ctx = new AudioContext()
    sttCtxRef.current = ctx
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512
    src.connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)

    let isRecording = false
    const tick = () => {
      if (!sttListeningRef.current) return
      // 아바타가 말하는 중이거나 직전 인식이 아직 처리 중이면 새 녹음을 시작하지 않는다
      // (아바타 목소리를 다시 녹음→인식→전송하는 피드백 루프 + 요청 폭주 방지)
      if (speakingRef.current || sttBusyRef.current) {
        if (!isRecording) { requestAnimationFrame(tick); return }
      }
      analyser.getByteFrequencyData(buf)
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length

      if (avg > THRESHOLD) {
        setVadActive(true)
        if (sttSilenceTimer.current) { clearTimeout(sttSilenceTimer.current); sttSilenceTimer.current = null }
        if (!isRecording) {
          isRecording = true
          sttChunksRef.current = []
          const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
          rec.ondataavailable = e => { if (e.data.size > 0) sttChunksRef.current.push(e.data) }
          rec.onstop = () => {
            isRecording = false; setVadActive(false)
            transcribeChunk([...sttChunksRef.current])
          }
          rec.start(); sttRecRef.current = rec
        }
        sttSilenceTimer.current = setTimeout(() => {
          sttRecRef.current?.stop(); sttRecRef.current = null
          setVadActive(false)
        }, SILENCE_MS)
      }
      requestAnimationFrame(tick)
    }
    tick()
  }, [recording, stopStt, transcribeChunk])

  // 페이지 진입 시 자동으로 듣기 모드 시작 — 클릭 없이 바로 대화 가능
  useEffect(() => {
    startStt()
    return () => stopStt()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 씬 초기화 ───────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.clientWidth  || 640
    const h = canvas.clientHeight || 640

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    renderer.setSize(w, h, false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    rendererRef.current = renderer

    const scene = new THREE.Scene()

    // 그라디언트 배경
    const bgCanvas = document.createElement('canvas')
    bgCanvas.width = 4; bgCanvas.height = 256
    const bctx = bgCanvas.getContext('2d')!
    const grad = bctx.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, '#0d1b2a')
    grad.addColorStop(1, '#1a0a2e')
    bctx.fillStyle = grad; bctx.fillRect(0, 0, 4, 256)
    scene.background = new THREE.CanvasTexture(bgCanvas)

    const camera = new THREE.PerspectiveCamera(40, w / h, 0.01, 100)
    camera.position.set(0, 0.1, 3.2)
    cameraRef.current = camera

    // ── 조명 ──
    scene.add(new THREE.AmbientLight(0x445566, 0.8))
    const key = new THREE.DirectionalLight(0xfff8f0, 3)
    key.position.set(1.2, 2.5, 2.5); key.castShadow = true
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x8899cc, 1.2)
    fill.position.set(-2, 0, 1); scene.add(fill)
    const rim = new THREE.DirectionalLight(0x6644ff, 0.8)
    rim.position.set(0, -1, -3); scene.add(rim)
    const top = new THREE.PointLight(0xffffff, 0.6, 8)
    top.position.set(0, 4, 0); scene.add(top)

    // ── 재질 ──
    const skin   = new THREE.MeshStandardMaterial({ color: avatarStyle.skin, roughness: 0.7, metalness: 0 })
    const white  = new THREE.MeshStandardMaterial({ color: 0xf5f2ef, roughness: 0.2 })
    const iris   = new THREE.MeshStandardMaterial({ color: 0x3b2a18, roughness: 0.15 })
    const pupil  = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.05 })
    const lip    = new THREE.MeshStandardMaterial({ color: 0xc06858, roughness: 0.55 })
    const hair   = new THREE.MeshStandardMaterial({ color: avatarStyle.hair, roughness: 0.85 })
    const shirt  = new THREE.MeshStandardMaterial({ color: avatarStyle.shirt, roughness: 0.8 })
    const collar = new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 })

    const group = new THREE.Group()
    groupRef.current = group
    scene.add(group)

    // ── 머리 ──
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 64, 64), skin)
    head.scale.set(1, 1.18, 0.92); head.castShadow = true
    group.add(head)

    // ── 턱 (립싱크용) ──
    const jaw = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 48, 24, 0, Math.PI*2, Math.PI*0.52, Math.PI*0.48),
      skin
    )
    jaw.position.y = -0.2; jaw.castShadow = true
    jawRef.current = jaw; group.add(jaw)

    // ── 귀 ──
    const makeEar = (x: number) => {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 16), skin)
      e.scale.set(0.45, 0.75, 0.35); e.position.set(x, 0.04, 0)
      return e
    }
    group.add(makeEar(-0.51)); group.add(makeEar(0.51))

    // ── 머리카락 (스타일에 따라 길이/유무 변경) ──
    if (avatarStyle.hairStyle !== 'bald') {
      const topH = avatarStyle.hairStyle === 'short' ? 0.46 : 0.55
      const hairTop = new THREE.Mesh(new THREE.SphereGeometry(0.52, 32, 32, 0, Math.PI*2, 0, Math.PI*topH), hair)
      hairTop.position.y = 0.06; hairTop.scale.set(1.03, 1.22, 0.98); group.add(hairTop)

      if (avatarStyle.hairStyle === 'long') {
        // 옆머리 (긴 머리만)
        const hairSideL = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 16), hair)
        hairSideL.scale.set(0.6, 1.2, 0.5); hairSideL.position.set(-0.44, -0.1, -0.05); group.add(hairSideL)
        const hairSideR = hairSideL.clone(); hairSideR.position.x = 0.44; group.add(hairSideR)
      }
    }

    // ── 눈 함수 ──
    const makeEye = (xOff: number) => {
      const g = new THREE.Group()
      g.position.set(xOff, 0.1, 0.39)

      const eyeball = new THREE.Mesh(new THREE.SphereGeometry(0.09, 32, 32), white)
      g.add(eyeball)
      // 홍채·동공·하이라이트 평면 원판은 구체 앞면(z=0.09)보다 살짝 앞에 둬야
      // 구체 볼록부가 원판 가운데를 뚫고 나오는 흰 얼룩이 안 생긴다.
      const irisM  = new THREE.Mesh(new THREE.CircleGeometry(0.05, 32), iris)
      irisM.position.z = 0.091; g.add(irisM)
      const pupilM = new THREE.Mesh(new THREE.CircleGeometry(0.025, 32), pupil)
      pupilM.position.z = 0.0915; g.add(pupilM)
      const hiMat  = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 })
      const hi     = new THREE.Mesh(new THREE.CircleGeometry(0.008, 8), hiMat)
      hi.position.set(0.016, 0.016, 0.092); g.add(hi)
      return g
    }
    const eyeL = makeEye(-0.175); const eyeR = makeEye(0.175)
    eyeGpLRef.current = eyeL; eyeGpRRef.current = eyeR
    group.add(eyeL); group.add(eyeR)

    // ── 눈꺼풀 ──
    const makeLid = (xOff: number) => {
      const lid = new THREE.Mesh(
        new THREE.SphereGeometry(0.096, 32, 16, 0, Math.PI*2, 0, Math.PI*0.52),
        new THREE.MeshStandardMaterial({ color: 0xe8a878, roughness: 0.85 })
      )
      lid.position.set(xOff, 0.1, 0.39)
      lid.rotation.x = Math.PI; lid.scale.y = 0.08
      lid.visible = false   // 깜빡임은 눈알 스쿼시로 처리 — 중심에서 부풀던 버그 눈꺼풀은 숨김
      return lid
    }
    lidLRef.current = makeLid(-0.175); lidRRef.current = makeLid(0.175)
    group.add(lidLRef.current!); group.add(lidRRef.current!)

    // ── 눈썹 ──
    const makeBrow = (xOff: number) => {
      const geo = new THREE.CapsuleGeometry(0.005, 0.12, 4, 8)
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x1a1008, roughness: 0.9 }))
      m.position.set(xOff, 0.24, 0.41)
      m.rotation.z = xOff > 0 ? 0.12 : -0.12
      return m
    }
    const browL = makeBrow(-0.17); browLRef.current = browL; group.add(browL)
    const browR = makeBrow(0.17);  browRRef.current = browR; group.add(browR)

    // ── 코 ──
    const noseGroup = new THREE.Group()
    noseGroup.position.set(0, 0.02, 0.46)
    const noseBridge = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.1, 4, 16), skin)
    noseBridge.rotation.x = Math.PI/2; noseBridge.position.y = 0.04
    noseGroup.add(noseBridge)
    const noseTip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 16), skin)
    noseTip.position.y = -0.01; noseGroup.add(noseTip)
    group.add(noseGroup)

    // ── 입 (입 안 + 윗/아랫입술) ──
    // 입 안: 입이 벌어졌을 때 보이는 어두운 안쪽 (없으면 벌어진 틈으로 배경이 비쳐 링처럼 보임)
    const mouthInner = new THREE.Mesh(
      new THREE.SphereGeometry(0.072, 24, 16),
      new THREE.MeshStandardMaterial({ color: 0x3a1418, roughness: 0.95 })
    )
    mouthInner.position.set(0, -0.21, 0.42)
    mouthInner.scale.set(1, 0.55, 0.35)
    group.add(mouthInner)

    // 윗/아랫입술: 가로로 누운 둥근 막대(캡슐) — 속이 찬 입술, 평상시엔 맞닿아 다물어진 입
    const makeLip = (y: number, len: number, r: number) => {
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 16), lip)
      m.rotation.z = Math.PI / 2
      m.position.set(0, y, 0.45)
      group.add(m)
      return m
    }
    const lipUp = makeLip(-0.19, 0.13, 0.02);  lipUpRef.current = lipUp
    const lipDn = makeLip(-0.23, 0.12, 0.022); lipDnRef.current = lipDn

    // ── 안경 (스타일에 따라 추가) ──
    if (avatarStyle.glasses) {
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.4, metalness: 0.3 })
      const lensMat  = new THREE.MeshStandardMaterial({ color: 0x88aacc, roughness: 0.1, transparent: true, opacity: 0.25 })
      const makeGlassEye = (xOff: number) => {
        const g = new THREE.Group(); g.position.set(xOff, 0.1, 0.52)
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.012, 8, 32), frameMat)
        g.add(ring)
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.095, 32), lensMat)
        lens.position.z = 0.005; g.add(lens)
        return g
      }
      group.add(makeGlassEye(-0.175)); group.add(makeGlassEye(0.175))
      const bridge = new THREE.Mesh(new THREE.CapsuleGeometry(0.006, 0.13, 4, 8), frameMat)
      bridge.rotation.z = Math.PI/2; bridge.position.set(0, 0.1, 0.525); group.add(bridge)
    }

    // ── 목 ──
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.38, 32), skin)
    neck.position.y = -0.72; group.add(neck)

    // ── 상의 (정장) ──
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.7, 8, 16), shirt)
    body.position.y = -1.3; group.add(body)
    // 칼라
    const collarL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, 0.04), collar)
    collarL.position.set(-0.07, -0.82, 0.35); collarL.rotation.z = 0.3; group.add(collarL)
    const collarR = collarL.clone(); collarR.position.x = 0.07; collarR.rotation.z = -0.3; group.add(collarR)

    // ── 이름표 (평면) ──
    const badgeGeo = new THREE.PlaneGeometry(0.28, 0.1)
    const badgeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 })
    const badge = new THREE.Mesh(badgeGeo, badgeMat)
    badge.position.set(0.18, -1.05, 0.42); group.add(badge)

    // ── 바닥 ──
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4, 64),
      new THREE.MeshStandardMaterial({ color: 0x0d1520, roughness: 0.9 })
    )
    floor.rotation.x = -Math.PI/2; floor.position.y = -2.0; floor.receiveShadow = true
    scene.add(floor)

    // ── 배경 빛 원형 글로우 ──
    const glowGeo = new THREE.CircleGeometry(1.2, 64)
    const glowMat = new THREE.MeshBasicMaterial({ color: 0x2233aa, transparent: true, opacity: 0.12 })
    const glow = new THREE.Mesh(glowGeo, glowMat)
    glow.position.set(0, 0, -1.5); scene.add(glow)

    // ── 애니메이션 ──
    let blinkNext = 3 + Math.random() * 3
    let blinking  = false
    let blinkT    = 0

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate)
      const t = clockRef.current.getElapsedTime()

      // 아이들 호흡 (미세 상하)
      group.position.y = Math.sin(t * 0.6) * 0.012

      // 웹캠 얼굴 추적 중이면 사용자 표정(블렌드셰이프)을 따라감 — 단, 아바타가 답변(TTS) 중일 때는
      // 오디오 기반 립싱크가 입 모양을 맡도록 얼굴 추적은 잠시 양보한다 (둘이 충돌하면 입이 어색해짐)
      const face = !analyserRef.current ? faceBlendRef.current : null
      const pose = !analyserRef.current ? headPoseRef.current : null
      const fb = (name: string) => face?.[name] ?? 0

      // 고개 방향 — 추적 중이면 사용자 머리 회전(pitch/yaw/roll)을 그대로 따라가고,
      // 추적 안 할 때는 기존 미세한 아이들 흔들림을 사용
      if (pose) {
        // MediaPipe 좌표계는 카메라 기준이라 좌우(yaw)·상하(pitch)가 아바타와 반대로 느껴져 부호 반전
        group.rotation.y += (-pose.yaw   * 0.8 - group.rotation.y) * 0.25
        group.rotation.x += (-pose.pitch * 0.8 - group.rotation.x) * 0.25
        group.rotation.z += ( pose.roll  * 0.6 - group.rotation.z) * 0.25
      } else {
        group.rotation.y = Math.sin(t * 0.25) * 0.05
        group.rotation.x = Math.sin(t * 0.18) * 0.015
        group.rotation.z += (0 - group.rotation.z) * 0.1
      }

      // 눈은 정면(카메라) 고정 — lookAt을 쓰면 일반 Object3D 특성상 +Z가 타깃 반대로 향해
      // 눈이 옆/뒤로 돌아가며 사팔·희번득처럼 보였음. 머리 회전(group)을 따라 자연스럽게 움직임.

      if (face) {
        // MediaPipe 블렌드셰이프는 닫힌 입/뜬 눈에서도 0이 아니라 잡음(0.05~0.15)이 끼고,
        // 최대로 벌려도 1.0까지 잘 안 가므로 — 데드존(lo 이하는 0)으로 잡음을 자르고
        // 게인으로 실사용 범위를 0~1 풀스윙으로 정규화한다.
        const norm = (v: number, lo: number, gain: number) => Math.min(1, Math.max(0, v - lo) * gain)

        // 눈 깜빡임 — 좌우를 평균 내 동시에. 눈알 그룹을 세로로 찌그러뜨려(스쿼시) 감음.
        // scale.y=1 뜬 상태, ~0.1 감은 상태. 중심 기준이라 눈 위치가 안 어긋남.
        const blink = norm((fb('eyeBlinkLeft') + fb('eyeBlinkRight')) / 2, 0.15, 2.2)
        const eyeSq = 1 - blink * 0.9
        if (eyeGpLRef.current) eyeGpLRef.current.scale.y += (eyeSq - eyeGpLRef.current.scale.y) * 0.5
        if (eyeGpRRef.current) eyeGpRRef.current.scale.y += (eyeSq - eyeGpRRef.current.scale.y) * 0.5

        // 입 — jawOpen을 정규화 후 TTS 립싱크와 동일한 매핑으로 턱·입술을 벌림
        const open = norm(fb('jawOpen'), 0.10, 2.5) * 0.18
        if (jawRef.current) {
          jawRef.current.position.y += (-0.2 - open - jawRef.current.position.y) * 0.4
          jawRef.current.rotation.x += (-open * 1.2 - jawRef.current.rotation.x) * 0.4
        }
        if (lipUpRef.current) lipUpRef.current.position.y += (-0.19 - open * 0.35 - lipUpRef.current.position.y) * 0.4
        if (lipDnRef.current) {
          lipDnRef.current.position.y += (-0.23 - open - lipDnRef.current.position.y) * 0.4
          const s = 1 + open * 1.6
          lipDnRef.current.scale.x += (s - lipDnRef.current.scale.x) * 0.4
        }

        // 눈썹은 추적 시 그대로 두되 평상시 위치로 복귀 (좌우 비대칭 매핑이 어색해 보여 제거)
        if (browLRef.current) browLRef.current.position.y += (0.24 - browLRef.current.position.y) * 0.15
        if (browRRef.current) browRRef.current.position.y += (0.24 - browRRef.current.position.y) * 0.15
      } else {
        // ── 웹캠 미사용 시 — 기존 자동 블링크 + TTS 오디오 기반 립싱크 ──
        blinkNext -= 0.016
        if (!blinking && blinkNext <= 0) { blinking = true; blinkT = 0; blinkNext = 3 + Math.random() * 4 }
        if (blinking) {
          blinkT += 0.06
          const s = blinkT < Math.PI ? Math.sin(blinkT) : 0   // 0→1→0
          const sc = 1 - s * 0.9                               // 1(뜸)→0.1(감음)→1
          if (eyeGpLRef.current) eyeGpLRef.current.scale.y = sc
          if (eyeGpRRef.current) eyeGpRRef.current.scale.y = sc
          if (blinkT >= Math.PI) {
            blinking = false
            if (eyeGpLRef.current) eyeGpLRef.current.scale.y = 1
            if (eyeGpRRef.current) eyeGpRRef.current.scale.y = 1
          }
        }

        if (analyserRef.current && jawRef.current) {
          const buf = new Uint8Array(analyserRef.current.frequencyBinCount)
          analyserRef.current.getByteFrequencyData(buf)
          const avg = buf.slice(0, 8).reduce((a, b) => a + b, 0) / 8
          // 조용한 구간(노이즈 바닥)은 입을 다물고, 말할 때만 살짝 벌어지게 — 폭을 절반 이하로 축소
          const open = Math.max(0, avg / 255 - 0.18) * 0.1
          jawRef.current.position.y += (-0.2 - open - jawRef.current.position.y) * 0.35
          jawRef.current.rotation.x = -open * 1.2

          // 입술이 턱을 따라 벌어지는 입모양
          if (lipUpRef.current) lipUpRef.current.position.y += (-0.19 - open * 0.35 - lipUpRef.current.position.y) * 0.4
          if (lipDnRef.current) {
            lipDnRef.current.position.y += (-0.23 - open - lipDnRef.current.position.y) * 0.4
            const s = 1 + open * 1.6
            lipDnRef.current.scale.set(s, 1, 1)
          }

          // 말하는 동안 살짝 끄덕이는 머리 움직임 + 눈썹 들썩임
          if (groupRef.current) {
            groupRef.current.rotation.x += Math.sin(t * 5) * open * 0.5
          }
          const browLift = Math.sin(t * 3.3) * open * 0.4
          if (browLRef.current) browLRef.current.position.y += (0.24 + browLift - browLRef.current.position.y) * 0.3
          if (browRRef.current) browRRef.current.position.y += (0.24 + browLift - browRRef.current.position.y) * 0.3
        } else {
          if (jawRef.current) {
            jawRef.current.position.y += (-0.2 - jawRef.current.position.y) * 0.12
            jawRef.current.rotation.x += (0 - jawRef.current.rotation.x) * 0.12
          }
          if (lipUpRef.current) lipUpRef.current.position.y += (-0.19 - lipUpRef.current.position.y) * 0.2
          if (lipDnRef.current) {
            lipDnRef.current.position.y += (-0.23 - lipDnRef.current.position.y) * 0.2
            lipDnRef.current.scale.x += (1 - lipDnRef.current.scale.x) * 0.2
          }
          if (browLRef.current) browLRef.current.position.y += (0.24 - browLRef.current.position.y) * 0.15
          if (browRRef.current) browRRef.current.position.y += (0.24 - browRRef.current.position.y) * 0.15
        }
      }

      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      const w2 = canvas.clientWidth, h2 = canvas.clientHeight
      camera.aspect = w2/h2; camera.updateProjectionMatrix()
      renderer.setSize(w2, h2, false)
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', onResize)
      renderer.dispose()
    }
  }, [avatarStyleId])

  // ── 자동 인사 / 이전 대화 불러오기 (최초 진입 시에만 — 이후엔 탭 전환·새로고침해도 유지됨) ──
  useEffect(() => {
    if (messages.length > 0) return
    let cancelled = false
    const timer = setTimeout(async () => {
      // 서버에 기록된 이전 대화가 있으면 이어서 보여주고, 없으면 인사로 시작
      try {
        const res = await fetch(`${API}/conversation/history?view=avatar3d_chat&limit=50`)
        const data = await res.json()
        if (!cancelled && Array.isArray(data?.messages) && data.messages.length > 0) {
          setMessages(data.messages)
          return
        }
      } catch { /* 조회 실패 시 인사로 폴백 */ }
      if (cancelled) return
      setMessages([{ role: 'assistant', content: GREETING }])
      respond(GREETING)
    }, 1200)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 시스템 프롬프트: 백엔드 /avatar/context(프로파일+관심사+RAG)에 리셉션 모드 안내를 덧붙임
  const buildSystemPrompt = useCallback(async (userText: string): Promise<string> => {
    try {
      const res = await fetch(`${API}/avatar/context?q=${encodeURIComponent(userText)}`)
      const data = await res.json()
      if (data?.system) return `${data.system}\n\n${RECEPTION_NOTE}`
    } catch { /* 컨텍스트 로드 실패 시 기본 프롬프트로 폴백 */ }
    return SYSTEM
  }, [])

  // 대화 turn 로깅 — 말투/성격 학습 루프의 원재료 (실패해도 채팅 흐름에 영향 없음)
  const logTurn = useCallback((role: 'user' | 'assistant', content: string) => {
    if (!content.trim()) return
    fetch(`${API}/conversation/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: 'avatar3d_chat', role, content }),
    }).catch(() => {})
  }, [])

  // ── Claude 호출 ──
  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()
    if (!text || chatLoading) return
    const userMsg: ChatMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg]); setInput(''); setChatLoading(true)
    logTurn('user', text)

    let key = settings.claudeSessionKey
    if (!key && settings.mcpEndpoint) key = await claudeWebAutoConnect(settings.mcpEndpoint) || ''

    try {
      const history = [...messages, userMsg].slice(-8)
      const system = await buildSystemPrompt(text)
      let reply = ''
      await streamClaudeWeb(key, settings.mcpEndpoint, history, system,
        d => { reply += d }, settings.anthropicApiKey)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
      if (reply) { logTurn('assistant', reply); respond(reply) }   // ← LLM 출력 → 영상(또는 TTS) 응답
    } catch (e) {
      const errMsg = `죄송합니다. 일시적인 오류가 발생했습니다.`
      setMessages(prev => [...prev, { role: 'assistant', content: errMsg }])
      respond(errMsg)
    } finally { setChatLoading(false) }
  }, [input, chatLoading, messages, settings, respond, buildSystemPrompt, logTurn])

  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const isConnected = !!(settings.claudeSessionKey || settings.anthropicApiKey)

  return (
    <div className="flex h-full overflow-hidden bg-gray-950">
      {/* 3D 뷰 */}
      <div className="flex-1 relative">
        <canvas ref={canvasRef} className="w-full h-full" />

        {/* 얼굴 트래킹 패널 — 웹캠 + MediaPipe 추적 + 3D 메시 텍스처 매핑 + 윤곽선/녹화 (좌상단) */}
        <FaceTrackingPanel
          className="absolute top-4 left-4 z-20 w-[26rem] max-w-[42vw] rounded-xl border border-gray-700 shadow-2xl bg-black overflow-hidden"
          onBlendshapes={handleFaceBlendshapes}
          onHeadPose={handleHeadPose} />

        {/* 3D 아바타 외형 스타일 선택 (우상단) */}
        <div className="absolute top-4 right-4 z-20 flex flex-col items-end gap-1.5 bg-black/40 backdrop-blur rounded-xl p-2">
          <span className="text-[10px] text-gray-400 px-1">아바타 스타일</span>
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[12rem]">
            {AVATAR_STYLES.map(s => (
              <button
                key={s.id}
                onClick={() => selectAvatarStyle(s.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  avatarStyleId === s.id
                    ? 'bg-purple-600 border-purple-400 text-white'
                    : 'bg-gray-800/70 border-gray-600 text-gray-300 hover:bg-gray-700/70'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="absolute top-32 right-4 z-20 flex flex-col items-end gap-1.5 bg-black/40 backdrop-blur rounded-xl p-2">
          <span className="text-[10px] text-gray-400 px-1">목소리</span>
          <div className="flex flex-wrap justify-end gap-1.5 max-w-[12rem]">
            {voiceOptions.map(v => (
              <button
                key={v.id}
                onClick={() => selectVoiceOption(v.id)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  voiceOptionId === v.id
                    ? 'bg-purple-600 border-purple-400 text-white'
                    : 'bg-gray-800/70 border-gray-600 text-gray-300 hover:bg-gray-700/70'
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>


        {/* 상태 오버레이 */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
          {speaking && (
            <div className="flex items-center gap-2 bg-black/50 backdrop-blur px-4 py-2 rounded-full">
              <div className="flex gap-1 items-end">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="w-1 bg-blue-400 rounded-full animate-bounce"
                    style={{ height: `${8 + Math.sin(i * 1.2) * 7}px`, animationDelay: `${i * 0.1}s` }} />
                ))}
              </div>
              <span className="text-xs text-blue-300">말하는 중</span>
            </div>
          )}
        </div>
      </div>

      {/* 채팅 패널 */}
      <div className="w-80 flex flex-col border-l border-gray-800 bg-gray-900/95">
        <div className="px-4 py-3 border-b border-gray-800 bg-gray-900">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`} />
            <h2 className="text-sm font-semibold text-gray-200">AI 리셉션 아바타</h2>
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {isConnected ? '응답 시 자동으로 음성 재생' : '설정에서 API Key를 입력해주세요'}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <div className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs mr-2 shrink-0 mt-0.5">🤖</div>
              )}
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed
                ${m.role === 'user'
                  ? 'bg-blue-700 text-white rounded-tr-sm'
                  : 'bg-gray-800 text-gray-200 rounded-tl-sm'}`}>
                {m.content}
              </div>
            </div>
          ))}
          {chatLoading && (
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs shrink-0">🤖</div>
              <div className="bg-gray-800 rounded-2xl rounded-tl-sm px-3 py-2 flex gap-1">
                {[0,1,2].map(i => (
                  <div key={i} className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="p-3 border-t border-gray-800 space-y-2">
          {/* 음성 인식 결과 표시 창 */}
          {(recording || sttBusy || sttResult || sttError) && (
            <div className="bg-gray-800/80 border border-gray-700 rounded-xl px-3 py-2 text-xs space-y-1">
              {recording && !sttBusy && (
                <p className={vadActive ? 'text-green-400' : 'text-gray-400'}>
                  {vadActive ? '🎙 듣는 중… (말씀하시면 자동으로 녹음·인식됩니다)' : '👂 대기 중… 말씀해보세요'}
                </p>
              )}
              {sttBusy && <p className="text-gray-400">⏳ 인식 처리 중…</p>}
              {sttResult && !sttBusy && (
                <p className="text-gray-300">
                  <span className="text-gray-500">인식 결과{sttResult.language ? ` (${sttResult.language})` : ''}: </span>
                  <span className="text-gray-100 font-medium">{sttResult.text || '(인식된 텍스트 없음 — 다시 시도해보세요)'}</span>
                </p>
              )}
              {sttError && <p className="text-red-400">{sttError}</p>}
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={startStt}
              title={recording ? '눌러서 듣기 모드 끄기' : '눌러서 듣기 모드 켜기 — 말하면 자동으로 인식됩니다'}
              className={`px-3 py-2 text-sm rounded-xl transition disabled:opacity-40 ${
                recording
                  ? (vadActive ? 'bg-green-600 hover:bg-green-500 text-white animate-pulse' : 'bg-red-600 hover:bg-red-500 text-white')
                  : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700'
              }`}>
              {recording ? (vadActive ? '🎙' : '👂') : '🎤'}
            </button>
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="무엇이든 물어보세요… (또는 🎤 눌러서 말하기)"
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
