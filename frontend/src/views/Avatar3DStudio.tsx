import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { streamClaudeWeb } from '@/services/claudeWeb'
import type { Settings } from '@/types'

const API = 'http://127.0.0.1:8766'
const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.15/wasm'
const MP_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

const toThree = (x: number, y: number, z: number) =>
  new THREE.Vector3((x - 0.5) * 2, -(y - 0.5) * 2, -z * 3)

const UPPER_LIP = 13
const LOWER_LIP = 14
const NOSE_TIP  = 4
const CHIN      = 152
const LEFT_EAR  = 234
const RIGHT_EAR = 454

interface ChatMsg { role: 'user' | 'assistant'; content: string }
interface Props { settings: Settings }

export default function Avatar3DStudio({ settings }: Props) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const videoRef   = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)

  const rendererRef   = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef      = useRef<THREE.Scene | null>(null)
  const cameraRef     = useRef<THREE.PerspectiveCamera | null>(null)
  const groupRef      = useRef<THREE.Group | null>(null)
  const pointsRef     = useRef<THREE.Points | null>(null)
  const linesRef      = useRef<THREE.LineSegments | null>(null)
  const photoPlaneRef = useRef<THREE.Mesh | null>(null)
  const rafRef        = useRef<number>(0)

  const landmarkerRef  = useRef<unknown>(null)
  const lastVideoTime  = useRef(-1)
  const audioCtxRef    = useRef<AudioContext | null>(null)
  const analyserRef    = useRef<AnalyserNode | null>(null)

  const [status, setStatus]           = useState<'idle' | 'loading' | 'tracking' | 'error'>('idle')
  const [statusMsg, setStatusMsg]     = useState('')
  const [facePhoto, setFacePhoto]     = useState<string | null>(null)
  const [messages, setMessages]       = useState<ChatMsg[]>([])
  const [input, setInput]             = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [speaking, setSpeaking]       = useState(false)
  const chatEndRef    = useRef<HTMLDivElement>(null)
  const photoInputRef = useRef<HTMLInputElement>(null)

  // Three.js 씬 초기화
  useEffect(() => {
    if (!canvasRef.current) return
    const canvas = canvasRef.current
    const w = canvas.clientWidth || 600
    const h = canvas.clientHeight || 480

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setSize(w, h, false)
    renderer.setPixelRatio(window.devicePixelRatio)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    sceneRef.current = scene

    const camera = new THREE.PerspectiveCamera(60, w / h, 0.01, 100)
    camera.position.set(0, 0, 2)
    cameraRef.current = camera

    scene.add(new THREE.AmbientLight(0x334455, 2))
    const pl = new THREE.PointLight(0x88ccff, 3, 10)
    pl.position.set(0, 1, 2)
    scene.add(pl)

    const bgGeo = new THREE.PlaneGeometry(10, 10)
    const bgMat = new THREE.MeshBasicMaterial({ color: 0x050a12, side: THREE.FrontSide })
    const bg = new THREE.Mesh(bgGeo, bgMat)
    bg.position.z = -5
    scene.add(bg)

    const group = new THREE.Group()
    groupRef.current = group
    scene.add(group)

    const ptGeo = new THREE.BufferGeometry()
    const positions = new Float32Array(478 * 3)
    ptGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const ptMat = new THREE.PointsMaterial({ color: 0x44ddff, size: 0.008, transparent: true, opacity: 0.85, sizeAttenuation: true })
    const points = new THREE.Points(ptGeo, ptMat)
    pointsRef.current = points
    group.add(points)

    const lineGeo = new THREE.BufferGeometry()
    const linePositions = new Float32Array(478 * 3 * 2)
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3))
    const lineMat = new THREE.LineBasicMaterial({ color: 0x1a5577, transparent: true, opacity: 0.35 })
    const lines = new THREE.LineSegments(lineGeo, lineMat)
    linesRef.current = lines
    group.add(lines)

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate)
      if (analyserRef.current) {
        const buf = new Uint8Array(analyserRef.current.frequencyBinCount)
        analyserRef.current.getByteFrequencyData(buf)
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length
        ;(ptMat as THREE.PointsMaterial).size = 0.008 + (avg / 255) * 0.012
      }
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      const w2 = canvas.clientWidth, h2 = canvas.clientHeight
      camera.aspect = w2 / h2
      camera.updateProjectionMatrix()
      renderer.setSize(w2, h2, false)
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', onResize)
      renderer.dispose()
    }
  }, [])

  // 얼굴 사진 → ghost texture
  useEffect(() => {
    if (!facePhoto || !groupRef.current) return
    const loader = new THREE.TextureLoader()
    loader.load(facePhoto, (tex) => {
      if (photoPlaneRef.current) groupRef.current!.remove(photoPlaneRef.current)
      const aspect = tex.image.width / tex.image.height
      const geo = new THREE.PlaneGeometry(1.2 * aspect, 1.2)
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.18, depthWrite: false })
      const plane = new THREE.Mesh(geo, mat)
      plane.position.z = -0.05
      groupRef.current!.add(plane)
      photoPlaneRef.current = plane
    })
  }, [facePhoto])

  const initLandmarker = useCallback(async () => {
    setStatus('loading')
    setStatusMsg('MediaPipe 모델 로딩 중…')
    try {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(MP_WASM)
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MP_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
      })
      landmarkerRef.current = landmarker
      setStatusMsg('모델 로드 완료')
      return landmarker
    } catch (e) {
      setStatus('error')
      setStatusMsg('MediaPipe 로드 실패: ' + String(e))
      return null
    }
  }, [])

  const updateLineGeometry = useCallback((landmarks: { x: number; y: number; z: number }[]) => {
    const OVAL       = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]
    const LIPS_OUTER = [61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146,61]
    const LIPS_INNER = [78,191,80,81,82,13,312,311,310,415,308,324,318,402,317,14,87,178,88,95,78]
    const L_EYE      = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246,33]
    const R_EYE      = [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398,362]
    const L_BROW     = [70,63,105,66,107,55,65,52,53,46]
    const R_BROW     = [336,296,334,293,300,285,295,282,283,276]
    const NOSE_BRIDGE = [168,6,197,195,5,4]
    const groups = [OVAL, LIPS_OUTER, LIPS_INNER, L_EYE, R_EYE, L_BROW, R_BROW, NOSE_BRIDGE]
    const verts: number[] = []
    for (const g of groups) {
      for (let i = 0; i < g.length - 1; i++) {
        const a = landmarks[g[i]], b = landmarks[g[i+1]]
        if (!a || !b) continue
        const va = toThree(a.x, a.y, a.z), vb = toThree(b.x, b.y, b.z)
        verts.push(va.x, va.y, va.z, vb.x, vb.y, vb.z)
      }
    }
    const geo = linesRef.current!.geometry
    const arr = geo.attributes.position.array as Float32Array
    const len = Math.min(verts.length, arr.length)
    for (let i = 0; i < len; i++) arr[i] = verts[i]
    geo.attributes.position.needsUpdate = true
    geo.setDrawRange(0, len / 3)
    const ul = landmarks[UPPER_LIP], ll = landmarks[LOWER_LIP]
    if (ul && ll) {
      const mouthOpen = Math.abs(ul.y - ll.y) * 5
      const color = new THREE.Color().setHSL(0.55 + mouthOpen * 0.1, 1, 0.5 + mouthOpen * 0.2)
      ;(linesRef.current!.material as THREE.LineBasicMaterial).color = color
    }
  }, [])

  const updateFaceMesh = useCallback((landmarks: { x: number; y: number; z: number }[]) => {
    if (!pointsRef.current || !groupRef.current) return
    const posArr = pointsRef.current.geometry.attributes.position.array as Float32Array
    for (let i = 0; i < landmarks.length; i++) {
      const v = toThree(landmarks[i].x, landmarks[i].y, landmarks[i].z)
      posArr[i * 3] = v.x; posArr[i * 3 + 1] = v.y; posArr[i * 3 + 2] = v.z
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true
    if (linesRef.current && landmarks.length >= 468) updateLineGeometry(landmarks)
    if (landmarks.length > RIGHT_EAR) {
      const nose  = toThree(landmarks[NOSE_TIP].x, landmarks[NOSE_TIP].y, landmarks[NOSE_TIP].z)
      const chin  = toThree(landmarks[CHIN].x, landmarks[CHIN].y, landmarks[CHIN].z)
      const lEar  = toThree(landmarks[LEFT_EAR].x, landmarks[LEFT_EAR].y, landmarks[LEFT_EAR].z)
      const rEar  = toThree(landmarks[RIGHT_EAR].x, landmarks[RIGHT_EAR].y, landmarks[RIGHT_EAR].z)
      const faceCenter = new THREE.Vector3().addVectors(lEar, rEar).multiplyScalar(0.5)
      const yaw   = (nose.x - faceCenter.x) * 1.5
      const pitch = (nose.y - faceCenter.y) * -0.8
      const roll  = (lEar.y - rEar.y) * 0.8
      groupRef.current.rotation.y = THREE.MathUtils.lerp(groupRef.current.rotation.y, yaw,   0.15)
      groupRef.current.rotation.x = THREE.MathUtils.lerp(groupRef.current.rotation.x, pitch, 0.15)
      groupRef.current.rotation.z = THREE.MathUtils.lerp(groupRef.current.rotation.z, roll,  0.15)
      const faceMid = new THREE.Vector3().addVectors(nose, chin).multiplyScalar(0.5)
      groupRef.current.position.lerp(new THREE.Vector3(faceMid.x * -0.3, faceMid.y * -0.3, 0), 0.1)
    }
  }, [updateLineGeometry])

  const trackLoop = useCallback((landmarker: unknown) => {
    const video = videoRef.current
    if (!video || video.paused || video.ended) return
    const now = performance.now()
    if (video.currentTime !== lastVideoTime.current) {
      lastVideoTime.current = video.currentTime
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = (landmarker as any).detectForVideo(video, now)
      if (result.faceLandmarks?.length > 0) updateFaceMesh(result.faceLandmarks[0])
    }
    requestAnimationFrame(() => trackLoop(landmarker))
  }, [updateFaceMesh])

  const startTracking = useCallback(async () => {
    if (status === 'tracking') return
    let lm = landmarkerRef.current
    if (!lm) lm = await initLandmarker()
    if (!lm) return
    setStatusMsg('웹캠 시작 중…')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } })
    } catch {
      setStatus('error'); setStatusMsg('웹캠 접근 실패'); return
    }
    const video = videoRef.current!
    video.srcObject = stream
    video.onloadeddata = () => {
      video.play()
      setStatus('tracking')
      setStatusMsg('트래킹 중')
      trackLoop(lm!)
    }
  }, [status, initLandmarker, trackLoop])

  const playTTS = useCallback(async (text: string) => {
    setSpeaking(true)
    try {
      const form = new FormData()
      form.append('text', text)
      const res = await fetch(`${API}/avatar/tts_only`, { method: 'POST', body: form })
      if (!res.ok) throw new Error('TTS 실패')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const ctx = audioCtxRef.current
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyserRef.current = analyser
      const source = ctx.createMediaElementSource(audio)
      source.connect(analyser)
      analyser.connect(ctx.destination)
      audio.onended = () => { setSpeaking(false); analyserRef.current = null; URL.revokeObjectURL(url) }
      audio.play()
    } catch {
      setSpeaking(false)
    }
  }, [])

  const sendMessage = useCallback(async () => {
    if (!input.trim() || chatLoading) return
    const userMsg: ChatMsg = { role: 'user', content: input.trim() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setChatLoading(true)
    try {
      if (!settings.claudeSessionKey) throw new Error('설정에서 Claude.ai 세션을 연결해주세요.')
      const history = [...messages, userMsg].slice(-10)
      const system = '당신은 사용자의 디지털 아바타입니다. 1인칭으로 짧고 자연스럽게 한국어로 답하세요.'
      let reply = ''
      await streamClaudeWeb(settings.claudeSessionKey, settings.mcpEndpoint, history, system, (d) => { reply += d })
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
      if (reply) await playTTS(reply)
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `오류: ${e instanceof Error ? e.message : String(e)}` }])
    } finally {
      setChatLoading(false)
    }
  }, [input, chatLoading, messages, settings, playTTS])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  return (
    <div className="flex h-full overflow-hidden bg-gray-950 text-white">
      {/* 3D 뷰 */}
      <div className="flex-1 relative flex flex-col">
        <canvas ref={canvasRef} className="flex-1 w-full" style={{ display: 'block' }} />
        <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none opacity-0" />
        <video ref={videoRef} className="absolute bottom-4 right-4 w-28 h-20 rounded-xl object-cover opacity-60 border border-gray-700" autoPlay playsInline muted />

        {/* 컨트롤 */}
        <div className="absolute top-4 left-4 flex items-center gap-2">
          <button onClick={() => photoInputRef.current?.click()} className="px-3 py-1.5 text-xs rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-600 transition">
            {facePhoto ? '📷 사진 변경' : '📷 얼굴 사진'}
          </button>
          <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) setFacePhoto(URL.createObjectURL(f)) }} />
          <button onClick={startTracking} disabled={status === 'loading'}
            className={`px-3 py-1.5 text-xs rounded-lg border transition ${status === 'tracking' ? 'bg-cyan-900 border-cyan-500 text-cyan-300' : 'bg-gray-800 hover:bg-gray-700 border-gray-600'}`}>
            {status === 'loading' ? '⟳ 로딩…' : status === 'tracking' ? '◉ 트래킹 중' : '▶ 웹캠 시작'}
          </button>
          {statusMsg && <span className="text-xs text-gray-400">{statusMsg}</span>}
        </div>

        {speaking && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="w-1 bg-cyan-400 rounded-full animate-bounce"
                style={{ height: `${8 + Math.sin(i * 0.8) * 8}px`, animationDelay: `${i * 0.1}s` }} />
            ))}
          </div>
        )}
      </div>

      {/* 채팅 패널 */}
      <div className="w-80 flex flex-col border-l border-gray-800 bg-gray-900">
        <div className="px-4 py-3 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">아바타 대화</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {settings.claudeSessionKey ? '🟢 Claude.ai 연결됨 · XTTS 음성' : '🔴 Claude.ai 미연결'}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && <p className="text-xs text-gray-600 text-center mt-8">아바타에게 말을 걸어보세요</p>}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${m.role === 'user' ? 'bg-cyan-700 text-white' : 'bg-gray-800 text-gray-200'}`}>
                {m.content}
              </div>
            </div>
          ))}
          {chatLoading && <div className="flex justify-start"><div className="bg-gray-800 rounded-2xl px-3 py-2"><span className="text-gray-400 text-xs">생각 중…</span></div></div>}
          <div ref={chatEndRef} />
        </div>
        <div className="p-3 border-t border-gray-800">
          {!settings.claudeSessionKey && <p className="text-xs text-amber-500 mb-2">⚠ 설정 탭에서 Claude.ai 세션키를 입력해주세요</p>}
          <div className="flex gap-2">
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="메시지 입력…"
              className="flex-1 bg-gray-800 text-sm text-gray-200 rounded-xl px-3 py-2 outline-none border border-gray-700 focus:border-cyan-600 placeholder-gray-600" />
            <button onClick={sendMessage} disabled={!input.trim() || chatLoading || !settings.claudeSessionKey}
              className="px-3 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-800 disabled:text-gray-600 text-sm rounded-xl transition">↑</button>
          </div>
        </div>
      </div>
    </div>
  )
}
