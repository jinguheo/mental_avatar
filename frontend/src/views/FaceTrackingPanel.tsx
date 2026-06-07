/**
 * FaceTrackingPanel — 웹캠 얼굴 트래킹 + 3D 메시 오버레이 (텍스처 매핑 포함)
 * MediaPipe FaceLandmarker로 얼굴을 추적해 3D 메시에 비디오 텍스처를 매핑하고,
 * 윤곽선 오버레이 표시와 립싱크 영상 녹화/생성을 제공한다.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'

const API      = 'http://127.0.0.1:8766'
const MP_WASM  = '/mediapipe/wasm'
const MP_MODEL = '/mediapipe/models/face_landmarker.task'

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

interface Props {
  className?: string
  /** 컨트롤 바 / 윤곽·메시 토글 등 부가 UI를 보여줄지 (작은 미리보기에서는 숨길 수 있음) */
  compact?: boolean
}

export default function FaceTrackingPanel({ className = '', compact = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef  = useRef<HTMLVideoElement>(null)

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef    = useRef<THREE.Scene | null>(null)
  const cameraRef   = useRef<THREE.OrthographicCamera | null>(null)
  const faceMeshRef = useRef<THREE.Mesh | null>(null)
  const wireRef     = useRef<THREE.LineSegments | null>(null)
  const videoTexRef = useRef<THREE.VideoTexture | null>(null)
  const rafRef      = useRef<number>(0)

  const landmarkerRef = useRef<unknown>(null)
  const streamRef     = useRef<MediaStream | null>(null)
  const lastTsRef     = useRef(0)

  const [status, setStatus]           = useState<'idle' | 'loading' | 'tracking' | 'error'>('idle')
  const [statusMsg, setStatusMsg]     = useState('')
  const [showWire, setShowWire]       = useState(true)
  const [showMesh, setShowMesh]       = useState(true)
  const [videoAspect, setVideoAspect] = useState('4/3')
  const [recording, setRecording]     = useState(false)
  const [recStatus, setRecStatus]     = useState('')
  const [resultUrl, setResultUrl]     = useState<string | null>(null)
  const recorderRef  = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])

  // ── Three.js 씬 초기화 (OrthographicCamera: 랜드마크 좌표 → 직접 매핑) ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const w = canvas.clientWidth  || 640
    const h = canvas.clientHeight || 480

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    renderer.setSize(w, h, false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setClearColor(0x000000, 0)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    sceneRef.current = scene

    const aspect = w / h
    const cam = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, -1, 1)
    cameraRef.current = cam

    scene.add(new THREE.AmbientLight(0xffffff, 0.6))
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(0, 1, 1)
    scene.add(dir)

    // Face mesh (VideoTexture — 트래킹 시작 후 텍스처 매핑됨)
    const faceGeo = new THREE.BufferGeometry()
    faceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(478 * 3), 3))
    faceGeo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(478 * 2), 2))
    const faceMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true, opacity: 0 })
    const faceMesh = new THREE.Mesh(faceGeo, faceMat)
    faceMeshRef.current = faceMesh
    scene.add(faceMesh)

    // Wireframe (윤곽선)
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
    const aspect = cam ? cam.right : 1

    const S = 0.96
    const toWorld = (lm: LM) => ({
      x: -(lm.x - 0.5) * 2 * aspect * S,
      y: -(lm.y - 0.5) * 2 * S,
      z: lm.z * 0.3,
    })

    // Face mesh 버텍스 + UV 업데이트 (텍스처 매핑)
    const mesh = faceMeshRef.current
    if (mesh) {
      const pos    = mesh.geometry.attributes.position.array as Float32Array
      const uvAttr = mesh.geometry.attributes['uv'] as THREE.BufferAttribute | undefined
      const uvArr  = uvAttr?.array as Float32Array | undefined
      for (let i = 0; i < Math.min(lms.length, 478); i++) {
        const { x, y, z } = toWorld(lms[i])
        pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z
        if (uvArr) {
          uvArr[i*2]   = lms[i].x
          uvArr[i*2+1] = 1 - lms[i].y
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

      const ul = lms[13], ll = lms[14]
      if (ul && ll) {
        const open = Math.abs(ul.y - ll.y) * 8
        ;(wire.material as THREE.LineBasicMaterial).color.setHSL(0.55 + open * 0.1, 1, 0.5 + open * 0.2)
      }
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

    try {
      await video.play()
    } catch (err) {
      setStatus('error')
      setStatusMsg('재생 오류: ' + (err instanceof Error ? err.message : String(err)))
      return
    }

    setStatusMsg('웹캠 OK — MediaPipe 로딩 중…')

    let lm = landmarkerRef.current
    if (!lm) lm = await initLandmarker()
    if (!lm) return

    const vw = video.videoWidth  || 640
    const vh = video.videoHeight || 480
    setVideoAspect(`${vw}/${vh}`)
    const a = vw / vh
    const cam = cameraRef.current
    if (cam) { cam.left = -a; cam.right = a; cam.updateProjectionMatrix() }
    const canvas = canvasRef.current
    if (canvas && rendererRef.current) {
      rendererRef.current.setSize(canvas.clientWidth, canvas.clientHeight, false)
    }

    // VideoTexture → face mesh에 텍스처 매핑
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
    videoTexRef.current?.dispose()
    videoTexRef.current = null
    setStatus('idle'); setStatusMsg('')
  }, [])

  // ── 녹화 → 립싱크 영상 생성 ──
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

      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth || 640
      canvas.height = video.videoHeight || 480
      const ctx = canvas.getContext('2d')!
      ctx.translate(canvas.width, 0); ctx.scale(-1, 1)
      ctx.drawImage(video, 0, 0)
      const faceBlob: Blob = await new Promise(r => canvas.toBlob(b => r(b!), 'image/jpeg', 0.95))

      const audioBlob = new Blob(recChunksRef.current, { type: 'audio/webm' })

      setRecStatus('생성 중… (1/2 오디오 변환)')
      const form = new FormData()
      form.append('face', faceBlob, 'face.jpg')
      form.append('audio', audioBlob, 'audio.webm')
      const res = await fetch(`${API}/avatar/record_generate`, { method: 'POST', body: form })
      const { job_id } = await res.json()

      const poll = setInterval(async () => {
        const r = await fetch(`${API}/avatar/job/${job_id}`)
        const d = await r.json()
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

  return (
    <div className={`${/\b(absolute|fixed|relative|sticky)\b/.test(className) ? '' : 'relative '}${className}`}
      style={{ aspectRatio: videoAspect, overflow: 'hidden' }}>
      <video ref={videoRef}
        className="absolute inset-0 w-full h-full"
        style={{ transform: 'scaleX(-1)', objectFit: 'contain' }}
        playsInline muted />
      <canvas ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ background: 'transparent' }} />

      {/* 컨트롤 */}
      <div className="absolute top-2 left-2 flex items-center gap-1.5 flex-wrap z-10">
        {status === 'tracking' ? (
          <button onClick={stopTracking}
            className="px-2.5 py-1 text-xs rounded-lg border border-red-600 bg-red-900/80 text-red-300 hover:bg-red-800 transition backdrop-blur">
            ■ 웹캠 중지
          </button>
        ) : (
          <button onClick={startTracking} disabled={status === 'loading'}
            className={`px-2.5 py-1 text-xs rounded-lg border transition backdrop-blur
              ${status === 'loading' ? 'bg-gray-700/80 border-gray-600 text-gray-400'
                                     : 'bg-gray-800/80 hover:bg-gray-700 border-gray-600'}`}>
            {status === 'loading' ? '⟳ 로딩…' : '▶ 웹캠 시작'}
          </button>
        )}
        {!compact && (
          <>
            <button onClick={() => setShowWire(v => !v)}
              className={`px-2.5 py-1 text-xs rounded-lg border transition backdrop-blur
                ${showWire ? 'bg-cyan-900/80 border-cyan-600 text-cyan-300' : 'bg-gray-800/80 border-gray-600 hover:bg-gray-700'}`}>
              윤곽 {showWire ? 'ON' : 'OFF'}
            </button>
            <button onClick={() => setShowMesh(v => !v)}
              className={`px-2.5 py-1 text-xs rounded-lg border transition backdrop-blur
                ${showMesh ? 'bg-indigo-900/80 border-indigo-600 text-indigo-300' : 'bg-gray-800/80 border-gray-600 hover:bg-gray-700'}`}>
              메시 {showMesh ? 'ON' : 'OFF'}
            </button>
            {status === 'tracking' && (
              recording ? (
                <button onClick={stopRecording}
                  className="px-2.5 py-1 text-xs rounded-lg border border-red-500 bg-red-600/80 text-white hover:bg-red-500 transition backdrop-blur animate-pulse">
                  ⏹ 녹화 완료
                </button>
              ) : (
                <button onClick={startRecording}
                  className="px-2.5 py-1 text-xs rounded-lg border border-pink-500 bg-pink-900/80 text-pink-300 hover:bg-pink-800 transition backdrop-blur">
                  🎙 녹화 시작
                </button>
              )
            )}
          </>
        )}
        {statusMsg && <span className="text-xs text-gray-300 backdrop-blur bg-black/30 px-2 py-1 rounded">{statusMsg}</span>}
        {recStatus && <span className="text-xs text-pink-300 backdrop-blur bg-black/30 px-2 py-1 rounded">{recStatus}</span>}
      </div>

      {/* 녹화 결과 영상 */}
      {resultUrl && !compact && (
        <div className="absolute bottom-2 left-2 z-10 bg-black/70 backdrop-blur rounded-xl p-2">
          <video src={resultUrl} controls autoPlay loop className="max-w-[220px] rounded-lg" />
        </div>
      )}

      {status === 'idle' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500 pointer-events-none gap-1">
          <span className="text-3xl">◈</span>
          <p className="text-xs">▶ 웹캠 시작</p>
          <p className="text-[11px] text-gray-600">얼굴 트래킹 + 3D 메시 오버레이</p>
        </div>
      )}
    </div>
  )
}
