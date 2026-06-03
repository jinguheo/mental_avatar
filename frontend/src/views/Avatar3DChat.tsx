/**
 * Avatar3DChat — 리셉션 3D 아바타
 * 사용자를 맞이하고 LLM 출력을 TTS로 전달하는 역할
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { streamClaudeWeb, claudeWebAutoConnect } from '@/services/claudeWeb'
import type { Settings } from '@/types'

const API = 'http://127.0.0.1:8766'

const GREETING = '안녕하세요! 반갑습니다. 무엇이든 도와드리겠습니다.'
const SYSTEM   = `당신은 사용자를 맞이하는 AI 리셉션 아바타입니다.
따뜻하고 전문적으로 한국어로 응대하세요.
답변은 2~3문장으로 간결하게 하고, 항상 친절한 어조를 유지하세요.`

interface ChatMsg { role: 'user' | 'assistant'; content: string }
interface Props { settings: Settings }

export default function Avatar3DChat({ settings }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const clockRef   = useRef(new THREE.Clock())
  const rafRef     = useRef(0)

  // 아바타 파트
  const groupRef   = useRef<THREE.Group | null>(null)
  const jawRef     = useRef<THREE.Mesh | null>(null)
  const lidLRef    = useRef<THREE.Mesh | null>(null)
  const lidRRef    = useRef<THREE.Mesh | null>(null)
  const eyeGpLRef  = useRef<THREE.Group | null>(null)
  const eyeGpRRef  = useRef<THREE.Group | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef   = useRef<THREE.PerspectiveCamera | null>(null)

  // 오디오
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)

  // 채팅
  const [messages, setMessages]       = useState<ChatMsg[]>([])
  const [input, setInput]             = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [speaking, setSpeaking]       = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // ── TTS ────────────────────────────────────────────────
  const playTTS = useCallback(async (text: string) => {
    setSpeaking(true)
    try {
      const form = new FormData(); form.append('text', text)
      const res = await fetch(`${API}/avatar/tts_only`, { method: 'POST', body: form })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const audio = new Audio(url)
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const ctx = audioCtxRef.current
      const analyser = ctx.createAnalyser(); analyser.fftSize = 64
      analyserRef.current = analyser
      const src = ctx.createMediaElementSource(audio)
      src.connect(analyser); analyser.connect(ctx.destination)
      audio.onended = () => { setSpeaking(false); analyserRef.current = null; URL.revokeObjectURL(url) }
      audio.play()
    } catch {
      // fallback: 브라우저 내장 TTS
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'ko-KR'; u.rate = 0.95
      u.onend = () => setSpeaking(false)
      speechSynthesis.speak(u)
    }
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
    const skin   = new THREE.MeshStandardMaterial({ color: 0xf2c4a0, roughness: 0.7, metalness: 0 })
    const white  = new THREE.MeshStandardMaterial({ color: 0xf5f2ef, roughness: 0.2 })
    const iris   = new THREE.MeshStandardMaterial({ color: 0x3b2a18, roughness: 0.15 })
    const pupil  = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 0.05 })
    const lip    = new THREE.MeshStandardMaterial({ color: 0xc06858, roughness: 0.55 })
    const hair   = new THREE.MeshStandardMaterial({ color: 0x1a1008, roughness: 0.85 })
    const shirt  = new THREE.MeshStandardMaterial({ color: 0x1e3a5f, roughness: 0.8 })
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

    // ── 눈 함수 ──
    const makeEye = (xOff: number) => {
      const g = new THREE.Group()
      g.position.set(xOff, 0.1, 0.39)

      const eyeball = new THREE.Mesh(new THREE.SphereGeometry(0.09, 32, 32), white)
      g.add(eyeball)
      const irisM  = new THREE.Mesh(new THREE.CircleGeometry(0.056, 32), iris)
      irisM.position.z = 0.087; g.add(irisM)
      const pupilM = new THREE.Mesh(new THREE.CircleGeometry(0.028, 32), pupil)
      pupilM.position.z = 0.088; g.add(pupilM)
      const hiMat  = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8 })
      const hi     = new THREE.Mesh(new THREE.CircleGeometry(0.009, 8), hiMat)
      hi.position.set(0.018, 0.018, 0.089); g.add(hi)
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
    group.add(makeBrow(-0.17)); group.add(makeBrow(0.17))

    // ── 코 ──
    const noseGroup = new THREE.Group()
    noseGroup.position.set(0, 0.02, 0.46)
    const noseBridge = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.1, 4, 16), skin)
    noseBridge.rotation.x = Math.PI/2; noseBridge.position.y = 0.04
    noseGroup.add(noseBridge)
    const noseTip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 16), skin)
    noseTip.position.y = -0.01; noseGroup.add(noseTip)
    group.add(noseGroup)

    // ── 입술 ──
    const lipUp = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.02, 8, 32, Math.PI), lip)
    lipUp.position.set(0, -0.19, 0.44); lipUp.rotation.z = Math.PI; group.add(lipUp)
    const lipDn = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.018, 8, 32, Math.PI), lip)
    lipDn.position.set(0, -0.23, 0.44); group.add(lipDn)

    // ── 귀 ──
    const makeEar = (x: number) => {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 16), skin)
      e.scale.set(0.45, 0.75, 0.35); e.position.set(x, 0.04, 0)
      return e
    }
    group.add(makeEar(-0.51)); group.add(makeEar(0.51))

    // ── 머리카락 ──
    const hairTop = new THREE.Mesh(new THREE.SphereGeometry(0.52, 32, 32, 0, Math.PI*2, 0, Math.PI*0.55), hair)
    hairTop.position.y = 0.06; hairTop.scale.set(1.03, 1.22, 0.98); group.add(hairTop)
    // 옆머리
    const hairSideL = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 16), hair)
    hairSideL.scale.set(0.6, 1.2, 0.5); hairSideL.position.set(-0.44, -0.1, -0.05); group.add(hairSideL)
    const hairSideR = hairSideL.clone(); hairSideR.position.x = 0.44; group.add(hairSideR)

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

      // 미세 좌우 고개 움직임
      group.rotation.y = Math.sin(t * 0.25) * 0.05
      group.rotation.x = Math.sin(t * 0.18) * 0.015

      // 눈 카메라 주시 (살짝 앞을 봄)
      const lookTarget = new THREE.Vector3(0, 0.1, 10)
      eyeGpLRef.current?.lookAt(lookTarget)
      eyeGpRRef.current?.lookAt(lookTarget)

      // 블링크
      blinkNext -= 0.016
      if (!blinking && blinkNext <= 0) { blinking = true; blinkT = 0; blinkNext = 3 + Math.random() * 4 }
      if (blinking) {
        blinkT += 0.06
        const s = blinkT < Math.PI ? Math.sin(blinkT) : 0
        if (lidLRef.current) { lidLRef.current.scale.y = 0.08 + s * 0.92; lidRRef.current!.scale.y = lidLRef.current.scale.y }
        if (blinkT >= Math.PI) { blinking = false; lidLRef.current!.scale.y = 0.08; lidRRef.current!.scale.y = 0.08 }
      }

      // 립싱크
      if (analyserRef.current && jawRef.current) {
        const buf = new Uint8Array(analyserRef.current.frequencyBinCount)
        analyserRef.current.getByteFrequencyData(buf)
        const avg = buf.slice(0, 8).reduce((a, b) => a + b, 0) / 8
        const open = (avg / 255) * 0.18
        jawRef.current.position.y += (-0.2 - open - jawRef.current.position.y) * 0.35
        jawRef.current.rotation.x = -open * 1.2
      } else if (jawRef.current) {
        jawRef.current.position.y += (-0.2 - jawRef.current.position.y) * 0.12
        jawRef.current.rotation.x += (0 - jawRef.current.rotation.x) * 0.12
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
  }, [])

  // ── 자동 인사 (페이지 로드 시) ──
  useEffect(() => {
    const timer = setTimeout(() => {
      setMessages([{ role: 'assistant', content: GREETING }])
      playTTS(GREETING)
    }, 1200)
    return () => clearTimeout(timer)
  }, [playTTS])

  // ── Claude 호출 ──
  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || chatLoading) return
    const userMsg: ChatMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg]); setInput(''); setChatLoading(true)

    let key = settings.claudeSessionKey
    if (!key && settings.mcpEndpoint) key = await claudeWebAutoConnect(settings.mcpEndpoint) || ''

    try {
      const history = [...messages, userMsg].slice(-8)
      let reply = ''
      await streamClaudeWeb(key, settings.mcpEndpoint, history, SYSTEM,
        d => { reply += d }, settings.anthropicApiKey)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
      if (reply) playTTS(reply)   // ← LLM 출력 → 자동 TTS
    } catch (e) {
      const errMsg = `죄송합니다. 일시적인 오류가 발생했습니다.`
      setMessages(prev => [...prev, { role: 'assistant', content: errMsg }])
      playTTS(errMsg)
    } finally { setChatLoading(false) }
  }, [input, chatLoading, messages, settings, playTTS])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const isConnected = !!(settings.claudeSessionKey || settings.anthropicApiKey)

  return (
    <div className="flex h-full overflow-hidden bg-gray-950">
      {/* 3D 뷰 */}
      <div className="flex-1 relative">
        <canvas ref={canvasRef} className="w-full h-full" />
        {/* 상태 오버레이 */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2">
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

        <div className="p-3 border-t border-gray-800">
          <div className="flex gap-2">
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="무엇이든 물어보세요…"
              disabled={!isConnected}
              className="flex-1 bg-gray-800 text-sm text-gray-200 rounded-xl px-3 py-2 outline-none border border-gray-700 focus:border-blue-600 placeholder-gray-600 disabled:opacity-40" />
            <button onClick={sendMessage}
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
