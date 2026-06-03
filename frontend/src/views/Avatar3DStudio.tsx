import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { streamClaudeWeb, claudeWebAutoConnect, claudeWebCaptureSession } from '@/services/claudeWeb'
import type { Settings } from '@/types'

const API      = 'http://127.0.0.1:8766'
const MP_WASM  = '/mediapipe/wasm'
const MP_MODEL = '/mediapipe/models/face_landmarker.task'

interface ChatMsg { role: 'user' | 'assistant'; content: string }
interface Props { settings: Settings }
type LM = { x: number; y: number; z: number }

function buildTriangles(connections: { start: number; end: number }[]): number[] {
  const nbr = new Map<number, Set<number>>()
  for (const { start, end } of connections) {
    if (!nbr.has(start)) nbr.set(start, new Set())
    if (!nbr.has(end))   nbr.set(end, new Set())
    nbr.get(start)!.add(end)
    nbr.get(end)!.add(start)
  }
  const tris: number[] = []
  const seen = new Set<string>()
  for (const { start: u, end: v } of connections) {
    for (const w of nbr.get(u)!) {
      if (nbr.get(v)!.has(w)) {
        const key = [u, v, w].sort((a, b) => a - b).join('_')
        if (!seen.has(key)) { seen.add(key); tris.push(u, v, w) }
      }
    }
  }
  return tris
}

export default function Avatar3DStudio({ settings }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef  = useRef<HTMLVideoElement>(null)

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef    = useRef<THREE.Scene | null>(null)
  const cameraRef   = useRef<THREE.OrthographicCamera | null>(null)
  const faceMeshRef = useRef<THREE.Mesh | null>(null)
  const headBackRef = useRef<THREE.Mesh | null>(null)   // 뒷머리 타원체
  const wireRef     = useRef<THREE.LineSegments | null>(null)
  const videoTexRef = useRef<THREE.VideoTexture | null>(null)
  const rafRef      = useRef<number>(0)

  const landmarkerRef = useRef<unknown>(null)
  const streamRef     = useRef<MediaStream | null>(null)
  const lastTsRef     = useRef(0)
  const audioCtxRef   = useRef<AudioContext | null>(null)
  const analyserRef   = useRef<AnalyserNode | null>(null)

  const [status, setStatus]         = useState<'idle' | 'loading' | 'tracking' | 'error'>('idle')
  const [statusMsg, setStatusMsg]   = useState('')
  const [showWire, setShowWire]     = useState(true)
  const [showMesh, setShowMesh]     = useState(true)
  const [messages, setMessages]     = useState<ChatMsg[]>([])
  const [input, setInput]           = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [speaking, setSpeaking]     = useState(false)
  const [videoAspect, setVideoAspect] = useState('4/3')
  const [recording, setRecording]   = useState(false)
  const [recStatus, setRecStatus]   = useState('')
  const [resultUrl, setResultUrl]   = useState<string | null>(null)
  const [listening, setListening]   = useState(false)   // STT 대기 모드
  const [vadActive, setVadActive]   = useState(false)   // VAD 음성 감지 중
  const recorderRef   = useRef<MediaRecorder | null>(null)
  const recChunksRef  = useRef<Blob[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const speechRecRef  = useRef<any>(null)
  const vadCtxRef     = useRef<AudioContext | null>(null)
  const vadStreamRef  = useRef<MediaStream | null>(null)
  const silenceTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const vadRecRef     = useRef<MediaRecorder | null>(null)
  const vadChunksRef  = useRef<Blob[]>([])
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Three.js 씬 초기화 (OrthographicCamera: 랜드마크 좌표 → 직접 매핑)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.clientWidth  || 640
    const h = canvas.clientHeight || 480

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setSize(w, h, false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)   // 투명 배경
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    sceneRef.current = scene

    // OrthographicCamera: [-1,1] x [-1,1] → 캔버스 전체에 매핑
    const aspect = w / h
    const cam = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, -1, 1)
    cameraRef.current = cam

    // 조명
    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(0, 1, 1)
    scene.add(dir)

    // Face mesh (VideoTexture — 트래킹 시작 후 적용)
    const faceGeo = new THREE.BufferGeometry()
    faceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(478 * 3), 3))
    faceGeo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(478 * 2), 2))
    const faceMat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide, transparent: true, opacity: 0,
    })
    const faceMesh = new THREE.Mesh(faceGeo, faceMat)
    faceMeshRef.current = faceMesh
    scene.add(faceMesh)

    // 뒷머리 타원체 (SphereGeometry → scale로 타원 표현)
    const headGeo = new THREE.SphereGeometry(1, 32, 32)
    const headMat = new THREE.MeshLambertMaterial({ color: 0xf0c090, side: THREE.FrontSide })
    const headBack = new THREE.Mesh(headGeo, headMat)
    headBack.visible = false   // 트래킹 시작 후 표시
    headBackRef.current = headBack
    scene.add(headBack)

    // Wireframe
    const wireGeo = new THREE.BufferGeometry()
    wireGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2000 * 3), 3))
    const wireMat = new THREE.LineBasicMaterial({ color: 0x00eeff, transparent: true, opacity: 0.5 })
    const wire = new THREE.LineSegments(wireGeo, wireMat)
    wireRef.current = wire
    scene.add(wire)

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate)
      if (videoTexRef.current) videoTexRef.current.needsUpdate = true
      renderer.render(scene, cam)
    }
    animate()

    const onResize = () => {
      const w2 = canvas.clientWidth, h2 = canvas.clientHeight
      const a = w2 / h2
      cam.left = -a; cam.right = a; cam.updateProjectionMatrix()
      renderer.setSize(w2, h2, false)
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('resize', onResize)
      renderer.dispose()
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  useEffect(() => { if (wireRef.current) wireRef.current.visible = showWire }, [showWire])
  useEffect(() => { if (faceMeshRef.current) faceMeshRef.current.visible = showMesh }, [showMesh])

  const initLandmarker = useCallback(async () => {
    setStatus('loading'); setStatusMsg('MediaPipe 로딩 중…')
    try {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(MP_WASM)
      const lm = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MP_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: false,
        minFaceDetectionConfidence: 0.3,
        minFacePresenceConfidence: 0.3,
        minTrackingConfidence: 0.3,
      })
      landmarkerRef.current = lm
      const filtered = FaceLandmarker.FACE_LANDMARKS_TESSELATION.filter(c => c.start < 468 && c.end < 468)
      faceMeshRef.current?.geometry.setIndex(buildTriangles(filtered))
      setStatusMsg('완료'); return lm
    } catch (e) {
      setStatus('error'); setStatusMsg('로드 실패: ' + String(e)); return null
    }
  }, [])

  const updateFaceMesh = useCallback((lms: LM[]) => {
    const cam = cameraRef.current
    const aspect = cam ? cam.right : 1  // cam.right = aspect ratio

    // 랜드마크 → world 좌표 (scaleX(-1) 미러 보정, 0.88 스케일로 크기 보정)
    const S = 0.96
    const toWorld = (lm: LM) => ({
      x: -(lm.x - 0.5) * 2 * aspect * S,
      y: -(lm.y - 0.5) * 2 * S,
      z: lm.z * 0.3,
    })

    // Face mesh 버텍스 + UV 업데이트
    const mesh = faceMeshRef.current
    if (mesh) {
      const pos     = mesh.geometry.attributes.position.array as Float32Array
      const uvAttr  = mesh.geometry.attributes['uv'] as THREE.BufferAttribute | undefined
      const uvArr   = uvAttr?.array as Float32Array | undefined
      for (let i = 0; i < Math.min(lms.length, 478); i++) {
        const { x, y, z } = toWorld(lms[i])
        pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z
        if (uvArr) {
          uvArr[i*2]   = lms[i].x        // 원본 텍스처 좌표 (CSS scaleX는 텍스처에 영향 없음)
          uvArr[i*2+1] = 1 - lms[i].y   // WebGL UV Y 보정
        }
      }
      mesh.geometry.attributes.position.needsUpdate = true
      if (uvAttr) uvAttr.needsUpdate = true
    }

    // Wireframe (주요 윤곽)
    const wire = wireRef.current
    if (wire && showWire) {
      const OVAL  = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109,10]
      const LIPS  = [61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146,61]
      const L_EYE = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246,33]
      const R_EYE = [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398,362]
      const L_BROW= [70,63,105,66,107,55,65,52,53,46]
      const R_BROW= [336,296,334,293,300,285,295,282,283,276]
      const segs: number[] = []
      for (const grp of [OVAL, LIPS, L_EYE, R_EYE, L_BROW, R_BROW]) {
        for (let i = 0; i < grp.length - 1; i++) {
          const a = lms[grp[i]], b = lms[grp[i+1]]
          if (!a || !b) continue
          const wa = toWorld(a), wb = toWorld(b)
          segs.push(wa.x, wa.y, wa.z + 0.01, wb.x, wb.y, wb.z + 0.01)
        }
      }
      const wArr = wire.geometry.attributes.position.array as Float32Array
      segs.forEach((v, i) => { wArr[i] = v })
      wire.geometry.attributes.position.needsUpdate = true
      wire.geometry.setDrawRange(0, segs.length / 3)

      // 입 벌림 → wireframe 색상
      const ul = lms[13], ll = lms[14]
      if (ul && ll) {
        const open = Math.abs(ul.y - ll.y) * 8
        ;(wire.material as THREE.LineBasicMaterial).color.setHSL(0.55 + open * 0.1, 1, 0.5 + open * 0.2)
      }
    }

    // 뒷머리 타원체 업데이트 (귀-귀 width, 이마-턱 height 기반)
    const head = headBackRef.current
    if (head && lms.length > 454) {
      const cam = cameraRef.current
      const aspect = cam ? cam.right : 1
      const S = 0.96

      const toW = (lm: LM) => ({
        x: -(lm.x - 0.5) * 2 * aspect * S,
        y: -(lm.y - 0.5) * 2 * S,
      })

      const lEar  = toW(lms[234])   // 왼쪽 귀
      const rEar  = toW(lms[454])   // 오른쪽 귀
      const top   = toW(lms[10])    // 이마 상단
      const chin  = toW(lms[152])   // 턱
      const nose  = toW(lms[4])     // 코끝 (중심)

      const hw = Math.abs(lEar.x - rEar.x) * 0.5          // 반너비
      const hh = Math.abs(top.y  - chin.y)  * 0.55         // 반높이
      const hd = hw * 0.85                                  // 깊이 (너비의 85%)

      const cx = (lEar.x + rEar.x) * 0.5   // 중심 X
      const cy = (top.y  + chin.y)  * 0.5   // 중심 Y

      head.position.set(cx, cy, -0.52 - hd * 0.3)  // 얼굴 뒤쪽
      head.scale.set(hw, hh, hd)
      head.visible = true

      // 피부색을 비디오 코끝 픽셀에서 근사 (VideoTexture가 있으면 약간 적용)
      ;(head.material as THREE.MeshLambertMaterial).color.setHex(0xf0c090)
    }
  }, [showWire])

  const trackLoop = useCallback((lm: unknown) => {
    const video = videoRef.current
    if (!video || video.paused || video.ended) return
    if (video.readyState >= 2) {
      const now = performance.now()
      if (now > lastTsRef.current) {
        lastTsRef.current = now
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = (lm as any).detectForVideo(video, now)
          if (r.faceLandmarks?.length > 0) updateFaceMesh(r.faceLandmarks[0])
        } catch { /* 일시적 오류 무시 */ }
      }
    }
    requestAnimationFrame(() => trackLoop(lm))
  }, [updateFaceMesh])

  const startTracking = useCallback(async () => {
    if (status === 'tracking' || status === 'loading') return

    // 웹캠 요청
    setStatusMsg('웹캠 권한 요청 중…')
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true })
    } catch (err) {
      setStatus('error')
      setStatusMsg('웹캠 오류: ' + (err instanceof Error ? err.message : String(err)))
      return
    }

    const video = videoRef.current
    if (!video) return
    video.srcObject = stream
    streamRef.current = stream

    // play
    try {
      await video.play()
    } catch (err) {
      setStatus('error')
      setStatusMsg('재생 오류: ' + (err instanceof Error ? err.message : String(err)))
      return
    }

    setStatusMsg('웹캠 OK — MediaPipe 로딩 중…')

    // MediaPipe 로드
    let lm = landmarkerRef.current
    if (!lm) lm = await initLandmarker()
    if (!lm) return

    // 실제 비디오 해상도로 컨테이너 + 카메라 aspect 동기화
    const vw = video.videoWidth  || 640
    const vh = video.videoHeight || 480
    setVideoAspect(`${vw}/${vh}`)   // CSS aspectRatio 동적 업데이트
    const a  = vw / vh
    const cam = cameraRef.current
    if (cam) {
      cam.left = -a; cam.right = a; cam.updateProjectionMatrix()
    }
    const canvas = canvasRef.current
    if (canvas && rendererRef.current) {
      rendererRef.current.setSize(canvas.clientWidth, canvas.clientHeight, false)
    }

    // VideoTexture → face mesh에 적용
    const tex = new THREE.VideoTexture(video)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    videoTexRef.current = tex
    if (faceMeshRef.current) {
      const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
      mat.map = tex
      mat.opacity = 1
      mat.needsUpdate = true
    }

    setStatus('tracking'); setStatusMsg('트래킹 중')
    trackLoop(lm)
  }, [status, initLandmarker, trackLoop])

  const stopTracking = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current.pause() }
    if (faceMeshRef.current) {
      const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
      mat.map = null; mat.opacity = 0; mat.needsUpdate = true
    }
    if (headBackRef.current) headBackRef.current.visible = false
    videoTexRef.current?.dispose()
    videoTexRef.current = null
    setStatus('idle'); setStatusMsg('')
  }, [])

  // 세션 만료 시 자동 재연결
  const reconnectClaude = useCallback(async (): Promise<string | null> => {
    if (!settings.mcpEndpoint) return null
    const tryCapture = async (quickOnly: boolean) => {
      const result = await fetch(settings.mcpEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
          params: { name: 'claude.capture_session', arguments: { timeout: quickOnly ? 10 : 60, quick_only: quickOnly } },
        }),
      }).then(r => r.json())
      const content = result.result?.content
      if (Array.isArray(content)) {
        const text = content.find((c: { type: string }) => c.type === 'text')?.text
        return text ? JSON.parse(text).sessionKey || null : null
      }
      return null
    }
    try {
      // 1차: CDP/캐시 빠른 시도 (10초)
      const key = await tryCapture(true)
      if (key) return key
    } catch { /* ignore */ }
    try {
      // 2차: Playwright로 Chrome 프로필 열기 (60초, claude.ai 열림)
      return await tryCapture(false)
    } catch { /* ignore */ }
    return null
  }, [settings.mcpEndpoint])

  // Claude 호출 (세션 만료 시 Chrome에서 자동 갱신 후 재시도)
  const callClaude = useCallback(async (
    history: ChatMsg[],
    system: string,
    onDelta: (d: string) => void,
    sessionKey: string,
  ): Promise<string> => {
    const doCall = (key: string) =>
      streamClaudeWeb(key, settings.mcpEndpoint, history, system, onDelta, settings.anthropicApiKey)
    try {
      return await doCall(sessionKey)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('403') || msg.includes('세션') || msg.includes('session')) {
        // Chrome에서 세션 자동 갱신 시도
        const newKey = await reconnectClaude()
        if (newKey) return await doCall(newKey)
        // 갱신 실패 → 사용자 안내
        throw new Error('세션 만료 — Chrome에서 claude.ai를 열고 로그인해주세요. MCP 서버가 자동으로 세션을 읽어옵니다.')
      }
      throw e
    }
  }, [settings, reconnectClaude])

  const startRecording = useCallback(async () => {
    const video = videoRef.current
    if (!video?.srcObject) { setRecStatus('웹캠을 먼저 켜주세요'); return }

    let audioStream: MediaStream
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setRecStatus('마이크 접근 실패'); return
    }

    recChunksRef.current = []
    const recorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' })
    recorder.ondataavailable = e => { if (e.data.size > 0) recChunksRef.current.push(e.data) }
    recorder.onstop = async () => {
      audioStream.getTracks().forEach(t => t.stop())

      // 얼굴 프레임 캡처
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth || 640
      canvas.height = video.videoHeight || 480
      const ctx = canvas.getContext('2d')!
      ctx.translate(canvas.width, 0); ctx.scale(-1, 1)
      ctx.drawImage(video, 0, 0)
      const faceBlob: Blob = await new Promise(r => canvas.toBlob(b => r(b!), 'image/jpeg', 0.95))

      const audioBlob = new Blob(recChunksRef.current, { type: 'audio/webm' })

      // API 전송
      setRecStatus('생성 중… (1/2 오디오 변환)')
      const form = new FormData()
      form.append('face', faceBlob, 'face.jpg')
      form.append('audio', audioBlob, 'audio.webm')
      const res = await fetch(`${API}/avatar/record_generate`, { method: 'POST', body: form })
      const { job_id } = await res.json()

      // 폴링
      const poll = setInterval(async () => {
        const r  = await fetch(`${API}/avatar/job/${job_id}`)
        const d  = await r.json()
        const labels: Record<string, string> = {
          queued: '대기 중', audio_convert: '1/2 오디오 변환 중',
          sadtalker: '2/2 립싱크 영상 생성 중', done: '완료', error: '오류',
        }
        setRecStatus(labels[d.stage] || d.stage)
        if (d.stage === 'done') {
          clearInterval(poll)
          setResultUrl(`${API}/avatar/job/${job_id}/video`)
          setRecording(false)
        } else if (d.stage === 'error') {
          clearInterval(poll); setRecStatus('오류: ' + d.error); setRecording(false)
        }
      }, 3000)
    }

    recorder.start()
    recorderRef.current = recorder
    setRecording(true)
    setRecStatus('녹화 중… (말하세요)')
    setResultUrl(null)
  }, [])

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop()
    recorderRef.current = null
  }, [])

  const playTTS = useCallback(async (text: string) => {
    setSpeaking(true)
    try {
      const form = new FormData(); form.append('text', text)
      const res = await fetch(`${API}/avatar/tts_only`, { method: 'POST', body: form })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const ctx = audioCtxRef.current
      const analyser = ctx.createAnalyser(); analyser.fftSize = 256
      analyserRef.current = analyser
      const src = ctx.createMediaElementSource(audio)
      src.connect(analyser); analyser.connect(ctx.destination)
      audio.onended = () => { setSpeaking(false); analyserRef.current = null; URL.revokeObjectURL(url) }
      audio.play()
    } catch { setSpeaking(false) }
  }, [])

  // VAD 기반 자동 음성 명령 모드
  const stopVad = useCallback(() => {
    if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null }
    vadRecRef.current?.stop()
    vadCtxRef.current?.close()
    vadStreamRef.current?.getTracks().forEach(t => t.stop())
    vadCtxRef.current = null; vadStreamRef.current = null; vadRecRef.current = null
    setListening(false); setVadActive(false)
  }, [])

  const transcribeAndSend = useCallback(async (chunks: Blob[]) => {
    if (!chunks.length) return
    const blob = new Blob(chunks, { type: 'audio/webm' })
    const form = new FormData(); form.append('audio', blob, 'voice.webm')
    let text = ''
    try {
      const res  = await fetch(`${API}/stt/transcribe`, { method: 'POST', body: form })
      const data = await res.json(); text = data.text?.trim() || ''
    } catch { return }
    if (!text) return
    setInput(text)
    if (!settings.claudeSessionKey && !settings.anthropicApiKey) return
    const userMsg: ChatMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg]); setInput(''); setChatLoading(true)
    try {
      let reply = ''
      await callClaude([userMsg], '당신은 사용자의 디지털 아바타입니다. 1인칭으로 짧고 자연스럽게 한국어로 답하세요.',
        d => { reply += d }, settings.claudeSessionKey)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
      if (reply) await playTTS(reply)
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `오류: ${e instanceof Error ? e.message : String(e)}` }])
    } finally { setChatLoading(false) }
  }, [settings, callClaude, playTTS])

  const startVadMode = useCallback(async () => {
    if (listening) { stopVad(); return }
    let micStream: MediaStream
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch { setMessages(prev => [...prev, { role: 'assistant', content: '마이크 접근 실패' }]); return }

    vadStreamRef.current = micStream
    const ctx = new AudioContext()
    vadCtxRef.current = ctx
    const src = ctx.createMediaStreamSource(micStream)
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512
    src.connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)

    const THRESHOLD = 20   // 음성 감지 임계값 (0-255)
    const SILENCE_MS = 1500 // 침묵 판정 시간

    let isRecording = false

    const tick = () => {
      if (!vadCtxRef.current) return
      analyser.getByteFrequencyData(buf)
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length

      if (avg > THRESHOLD) {
        // 음성 감지됨
        setVadActive(true)
        if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null }
        if (!isRecording) {
          isRecording = true
          vadChunksRef.current = []
          const rec = new MediaRecorder(micStream, { mimeType: 'audio/webm' })
          rec.ondataavailable = e => { if (e.data.size > 0) vadChunksRef.current.push(e.data) }
          rec.onstop = () => {
            isRecording = false; setVadActive(false)
            transcribeAndSend([...vadChunksRef.current])
          }
          rec.start(); vadRecRef.current = rec
        }
        // 침묵 타이머 리셋
        silenceTimer.current = setTimeout(() => {
          vadRecRef.current?.stop(); vadRecRef.current = null
          setVadActive(false)
        }, SILENCE_MS)
      }
      requestAnimationFrame(tick)
    }
    tick()
    setListening(true)
    setMessages(prev => [...prev, { role: 'assistant', content: '🎤 음성 명령 대기 중… 말씀하세요.' }])
  }, [listening, stopVad, transcribeAndSend])

  const startVoiceChat = useCallback(async () => {
    if (listening) {
      // 녹음 중지 → 서버 Whisper STT로 전송
      speechRecRef.current?.stop()
      return
    }
    let micStream: MediaStream
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: '마이크 접근 실패' }])
      return
    }
    const chunks: Blob[] = []
    const recorder = new MediaRecorder(micStream, { mimeType: 'audio/webm' })
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
    recorder.onstop = async () => {
      micStream.getTracks().forEach(t => t.stop())
      setListening(false)
      if (!chunks.length) return
      // 서버 Whisper STT
      const blob = new Blob(chunks, { type: 'audio/webm' })
      const form = new FormData(); form.append('audio', blob, 'voice.webm')
      let text = ''
      try {
        const res  = await fetch(`${API}/stt/transcribe`, { method: 'POST', body: form })
        const data = await res.json()
        text = data.text?.trim() || ''
      } catch {
        setMessages(prev => [...prev, { role: 'assistant', content: 'STT 서버 오류' }]); return
      }
      if (!text) return
      setInput(text)
      if (!settings.claudeSessionKey && !settings.anthropicApiKey) return
      const userMsg: ChatMsg = { role: 'user', content: text }
      setMessages(prev => [...prev, userMsg]); setInput(''); setChatLoading(true)
      try {
        let reply = ''
        await callClaude([userMsg], '당신은 사용자의 디지털 아바타입니다. 1인칭으로 짧고 자연스럽게 한국어로 답하세요.',
          d => { reply += d }, settings.claudeSessionKey)
        setMessages(prev => [...prev, { role: 'assistant', content: reply }])
        if (reply) await playTTS(reply)
      } catch (e) {
        setMessages(prev => [...prev, { role: 'assistant', content: `오류: ${e instanceof Error ? e.message : String(e)}` }])
      } finally { setChatLoading(false) }
    }
    recorder.start()
    speechRecRef.current = recorder
    setListening(true)
  }, [listening, settings, callClaude, playTTS])

  const sendMessage = useCallback(async () => {
    if (!input.trim() || chatLoading) return
    const userMsg: ChatMsg = { role: 'user', content: input.trim() }
    setMessages(prev => [...prev, userMsg]); setInput(''); setChatLoading(true)
    try {
      if (!settings.claudeSessionKey && !settings.anthropicApiKey) throw new Error('설정에서 Claude 연결 필요')
      const history = [...messages, userMsg].slice(-10)
      let reply = ''
      await callClaude(history, '당신은 사용자의 디지털 아바타입니다. 1인칭으로 짧고 자연스럽게 한국어로 답하세요.',
        d => { reply += d }, settings.claudeSessionKey)
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
      if (reply) await playTTS(reply)
    } catch (e) {
      setMessages(prev => [...prev, { role: 'assistant', content: `오류: ${e instanceof Error ? e.message : String(e)}` }])
    } finally { setChatLoading(false) }
  }, [input, chatLoading, messages, settings, playTTS])

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  return (
    <div className="flex h-full overflow-hidden bg-gray-950 text-white">
      {/* 3D 뷰 */}
      <div className="flex-1 flex items-center justify-center overflow-hidden bg-black">
        {/* 4:3 고정 박스 — 비디오·캔버스 동일 좌표계 */}
        <div className="relative" style={{ width: '100%', height: 'min(calc(100vw * 9/16), 65vh)', overflow: 'hidden' }}>
          <video ref={videoRef}
            className="absolute inset-0 w-full h-full"
            style={{ transform: 'scaleX(-1)', objectFit: 'cover' }}
            playsInline muted />
          <canvas ref={canvasRef}
            className="absolute inset-0 w-full h-full"
            style={{ background: 'transparent' }} />

          {/* 컨트롤 */}
          <div className="absolute top-3 left-3 flex items-center gap-2 flex-wrap z-10">
            {status === 'tracking' ? (
              <button onClick={stopTracking}
                className="px-3 py-1.5 text-xs rounded-lg border border-red-600 bg-red-900/80 text-red-300 hover:bg-red-800 transition backdrop-blur">
                ■ 웹캠 중지
              </button>
            ) : (
              <button onClick={startTracking} disabled={status === 'loading'}
                className={`px-3 py-1.5 text-xs rounded-lg border transition backdrop-blur
                  ${status === 'loading' ? 'bg-gray-700/80 border-gray-600 text-gray-400'
                                         : 'bg-gray-800/80 hover:bg-gray-700 border-gray-600'}`}>
                {status === 'loading' ? '⟳ 로딩…' : '▶ 웹캠 시작'}
              </button>
            )}
            <button onClick={() => setShowWire(v => !v)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition backdrop-blur
                ${showWire ? 'bg-cyan-900/80 border-cyan-600 text-cyan-300' : 'bg-gray-800/80 border-gray-600 hover:bg-gray-700'}`}>
              윤곽 {showWire ? 'ON' : 'OFF'}
            </button>
            <button onClick={() => setShowMesh(v => !v)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition backdrop-blur
                ${showMesh ? 'bg-indigo-900/80 border-indigo-600 text-indigo-300' : 'bg-gray-800/80 border-gray-600 hover:bg-gray-700'}`}>
              메시 {showMesh ? 'ON' : 'OFF'}
            </button>
            {statusMsg && <span className="text-xs text-gray-300 backdrop-blur bg-black/30 px-2 py-1 rounded">{statusMsg}</span>}

            {/* 녹화 버튼 */}
            {status === 'tracking' && (
              recording ? (
                <button onClick={stopRecording}
                  className="px-3 py-1.5 text-xs rounded-lg border border-red-500 bg-red-600/80 text-white hover:bg-red-500 transition backdrop-blur animate-pulse">
                  ⏹ 녹화 완료
                </button>
              ) : (
                <button onClick={startRecording}
                  className="px-3 py-1.5 text-xs rounded-lg border border-pink-500 bg-pink-900/80 text-pink-300 hover:bg-pink-800 transition backdrop-blur">
                  🎙 녹화 시작
                </button>
              )
            )}
            {recStatus && <span className="text-xs text-pink-300 backdrop-blur bg-black/30 px-2 py-1 rounded">{recStatus}</span>}
          </div>

          {/* 녹화 결과 영상 */}
          {resultUrl && (
            <div className="absolute bottom-4 left-4 z-10 bg-black/70 backdrop-blur rounded-xl p-2">
              <p className="text-xs text-green-400 mb-1">🎬 생성 완료</p>
              <video src={resultUrl} controls autoPlay loop
                className="w-48 rounded-lg" />
            </div>
          )}

          {/* 립싱크 */}
          {speaking && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1 z-10">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="w-1 bg-cyan-400 rounded-full animate-bounce"
                  style={{ height: `${8 + Math.sin(i * 0.8) * 8}px`, animationDelay: `${i * 0.1}s` }} />
              ))}
            </div>
          )}

          {/* 대기 안내 */}
          {status === 'idle' && (
            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
              <div className="text-center text-gray-400 bg-black/40 backdrop-blur rounded-2xl p-8">
                <div className="text-5xl mb-3">◈</div>
                <p className="text-sm font-medium">▶ 웹캠 시작</p>
                <p className="text-xs mt-1 text-gray-500">얼굴 트래킹 + 3D 메시 오버레이</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 채팅 패널 */}
      <div className="w-80 flex flex-col border-l border-gray-800 bg-gray-900">
        <div className="px-4 py-3 border-b border-gray-800">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-200">아바타 대화</h2>
            {settings.mcpEndpoint && (
              <button onClick={async () => {
                try {
                  await claudeWebCaptureSession(settings.mcpEndpoint)
                  setMessages(prev => [...prev, { role: 'assistant', content: '✓ Claude.ai 재연결 완료' }])
                } catch {
                  setMessages(prev => [...prev, { role: 'assistant', content: '재연결 실패. claude.ai에 로그인 후 다시 시도해주세요.' }])
                }
              }} className="text-xs px-2 py-1 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 transition">
                🔄 재연결
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {(settings.claudeSessionKey || settings.anthropicApiKey)
            ? `🟢 Claude ${settings.anthropicApiKey ? 'API' : 'Web'} 연결됨`
            : '🔴 Claude 미연결'}
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && <p className="text-xs text-gray-600 text-center mt-8">아바타에게 말을 걸어보세요</p>}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed
                ${m.role === 'user' ? 'bg-cyan-700 text-white' : 'bg-gray-800 text-gray-200'}`}>
                {m.content}
              </div>
            </div>
          ))}
          {chatLoading && <div className="flex justify-start"><div className="bg-gray-800 rounded-2xl px-3 py-2 text-xs text-gray-400">생각 중…</div></div>}
          <div ref={chatEndRef} />
        </div>
        <div className="p-3 border-t border-gray-800">
          {!settings.claudeSessionKey && !settings.anthropicApiKey && (
            <p className="text-xs text-amber-500 mb-2">⚠ 설정 탭에서 Anthropic API Key 또는 Claude 세션키를 입력해주세요</p>
          )}
          <div className="flex gap-2">
            {/* VAD 자동 감지 버튼 */}
            <button onClick={startVadMode}
              disabled={chatLoading || (!settings.claudeSessionKey && !settings.anthropicApiKey)}
              title={listening ? '음성 명령 중지' : '음성 명령 시작 (자동 감지)'}
              className={`px-3 py-2 rounded-xl text-sm transition shrink-0 relative
                ${listening
                  ? vadActive
                    ? 'bg-green-600 text-white animate-pulse'   // 말하는 중
                    : 'bg-red-600 text-white'                   // 대기 중
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-40'}`}>
              {listening ? (vadActive ? '🔴' : '🎙') : '🎤'}
            </button>
            {/* 단발 녹음 버튼 */}
            <button onClick={startVoiceChat}
              disabled={chatLoading || listening || (!settings.claudeSessionKey && !settings.anthropicApiKey)}
              title="한 번 말하기"
              className="px-2 py-2 rounded-xl text-sm transition shrink-0 bg-gray-700 hover:bg-gray-600 text-gray-400 disabled:opacity-40">
              ⏺
            </button>
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder={listening ? '듣는 중…' : '메시지 입력…'}
              className="flex-1 bg-gray-800 text-sm text-gray-200 rounded-xl px-3 py-2 outline-none border border-gray-700 focus:border-cyan-600 placeholder-gray-600" />
            <button onClick={sendMessage} disabled={!input.trim() || chatLoading || (!settings.claudeSessionKey && !settings.anthropicApiKey)}
              className="px-3 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-800 disabled:text-gray-600 text-sm rounded-xl transition">↑</button>
          </div>
        </div>
      </div>
    </div>
  )
}
