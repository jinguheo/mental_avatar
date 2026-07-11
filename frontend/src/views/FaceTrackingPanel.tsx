/**
 * FaceTrackingPanel — 웹캠 얼굴 트래킹 + 3D 메시 오버레이 (텍스처 매핑 포함)
 * MediaPipe FaceLandmarker로 얼굴을 추적해 3D 메시에 비디오 텍스처를 매핑하고,
 * 윤곽선 오버레이 표시와 립싱크 영상 녹화/생성을 제공한다.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { API_BASE } from '@/config'

const API      = API_BASE
const MP_WASM  = '/mediapipe/wasm'
const MP_MODEL = '/mediapipe/models/face_landmarker.task'

const LS_SNAPSHOT  = 'mental-avatar-face-snapshot'
const LS_LANDMARKS = 'mental-avatar-face-landmarks'

type LM = { x: number; y: number; z: number }

/**
 * 캡처한 프레임이 사실상 검은 화면인지 판단한다.
 * 웹캠이 아직 준비되지 않았거나 렌즈가 가려진 상태에서 캡처하면 검은 프레임이 나오는데,
 * 이를 그대로 등록하면 기존의 정상 얼굴 이미지를 검은색으로 덮어써버린다.
 * 다운샘플링해 평균 밝기를 계산하고, 너무 어두우면 true 를 반환한다.
 */
function isFrameTooDark(canvas: HTMLCanvasElement): boolean {
  try {
    const sw = 32, sh = 32
    const tmp = document.createElement('canvas')
    tmp.width = sw; tmp.height = sh
    const tctx = tmp.getContext('2d')
    if (!tctx) return false
    tctx.drawImage(canvas, 0, 0, sw, sh)
    const { data } = tctx.getImageData(0, 0, sw, sh)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      // Rec.601 휘도
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    }
    const avg = sum / (sw * sh)
    return avg < 12 // 0~255 중 약 5% 미만이면 검은 프레임으로 간주
  } catch {
    return false // 판단 실패 시 저장을 막지 않는다
  }
}

/**
 * 얼굴 사진을 좌우 반전해서 캔버스에 그린다.
 * 라이브 웹캠 미리보기는 거울처럼 보이도록 CSS로 좌우 반전해서 보여주는데,
 * 저장되는 사진(카메라 원본, 비반전)은 그렇지 않으면 사용자가 본 모습과 반대로 저장되어
 * "영상이 반전된 것 같다"는 위화감을 준다. 저장 시점에 거울모드로 맞춰 저장한다.
 */
function drawMirrored(ctx: CanvasRenderingContext2D, source: CanvasImageSource, w: number, h: number) {
  ctx.save()
  ctx.translate(w, 0)
  ctx.scale(-1, 1)
  ctx.drawImage(source, 0, 0, w, h)
  ctx.restore()
}

// 얼굴 주요 윤곽(눈/입/눈썹/얼굴선) — 3D 와이어프레임과 2D 정렬 확인 미리보기가 공유한다.
const FACE_CONTOUR_GROUPS: number[][] = [
  [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109,10], // OVAL
  [61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146,61], // LIPS
  [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246,33], // L_EYE
  [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398,362], // R_EYE
  [70,63,105,66,107,55,65,52,53,46], // L_BROW
  [336,296,334,293,300,285,295,282,283,276], // R_BROW
]

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
  /** 매 프레임 추적된 얼굴 표정(블렌드셰이프) 점수를 전달(추적 중단 시 null) — 다른 3D 아바타의 표정 구동에 사용 */
  onBlendshapes?: (scores: Record<string, number> | null) => void
  /** 매 프레임 추적된 머리 회전(라디안, 추적 중단 시 null) — 다른 3D 아바타의 고개 방향 구동에 사용 */
  onHeadPose?: (pose: { pitch: number; yaw: number; roll: number } | null) => void
}

export default function FaceTrackingPanel({ className = '', compact = false, onBlendshapes, onHeadPose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef  = useRef<HTMLVideoElement>(null)

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef    = useRef<THREE.Scene | null>(null)
  const cameraRef   = useRef<THREE.OrthographicCamera | null>(null)
  const faceMeshRef = useRef<THREE.Mesh | null>(null)
  const wireRef     = useRef<THREE.LineSegments | null>(null)
  const videoTexRef = useRef<THREE.Texture | null>(null)
  const videoTexCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoTexCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const rafRef      = useRef<number>(0)

  const landmarkerRef = useRef<unknown>(null)
  const streamRef     = useRef<MediaStream | null>(null)
  const lastTsRef     = useRef(0)
  const lastLandmarksRef = useRef<LM[] | null>(null)
  const textureLandmarksRef = useRef<LM[] | null>(null)
  const autoSavedFaceRef = useRef(false)
  const staticTexRef  = useRef<THREE.Texture | null>(null)
  const faceIndexReadyRef = useRef(false)
  const onBlendshapesRef = useRef(onBlendshapes)
  useEffect(() => { onBlendshapesRef.current = onBlendshapes }, [onBlendshapes])
  const onHeadPoseRef = useRef(onHeadPose)
  useEffect(() => { onHeadPoseRef.current = onHeadPose }, [onHeadPose])

  const [status, setStatus]           = useState<'idle' | 'loading' | 'tracking' | 'error'>('idle')
  const [statusMsg, setStatusMsg]     = useState('')
  const [showWire, setShowWire]       = useState(true)
  const [showMesh, setShowMesh]       = useState(true)
  const [videoAspect, setVideoAspect] = useState('4/3')
  const [hasLiveVideo, setHasLiveVideo] = useState(false)
  const [recording, setRecording]     = useState(false)
  const [recStatus, setRecStatus]     = useState('')
  const [resultUrl, setResultUrl]     = useState<string | null>(null)
  const [hasSavedFace, setHasSavedFace] = useState(false)
  const recorderRef  = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])

  // 저장된 얼굴 사진 + landmark 정렬 미리보기 (카메라 없이도 확인 가능)
  const alignCanvasRef = useRef<HTMLCanvasElement>(null)
  const [showAlignCheck, setShowAlignCheck] = useState(false)
  const [alignCheckMsg, setAlignCheckMsg] = useState('')

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
    renderer.outputColorSpace = THREE.SRGBColorSpace
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
    const faceMat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
    })
    const faceMesh = new THREE.Mesh(faceGeo, faceMat)
    faceMesh.renderOrder = 1
    faceMeshRef.current = faceMesh
    scene.add(faceMesh)

    // Wireframe (윤곽선)
    const wireGeo = new THREE.BufferGeometry()
    wireGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2000 * 3), 3))
    const wireMat = new THREE.LineBasicMaterial({
      color: 0x00eeff,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false,
    })
    const wire = new THREE.LineSegments(wireGeo, wireMat)
    wire.renderOrder = 2
    wireRef.current = wire
    scene.add(wire)

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate)
      const videoTex = videoTexRef.current
      const texCanvas = videoTexCanvasRef.current
      const texCtx = videoTexCtxRef.current
      const video = videoRef.current
      if (videoTex && texCanvas && texCtx && video && video.readyState >= 2) {
        const vw = video.videoWidth || 640
        const vh = video.videoHeight || 480
        if (texCanvas.width !== vw || texCanvas.height !== vh) {
          texCanvas.width = vw
          texCanvas.height = vh
        }
        texCtx.drawImage(video, 0, 0, vw, vh)
        videoTex.needsUpdate = true
      }
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

  useEffect(() => { if (wireRef.current) wireRef.current.visible = showWire && hasLiveVideo }, [showWire, hasLiveVideo])
  useEffect(() => { if (faceMeshRef.current) faceMeshRef.current.visible = showMesh }, [showMesh])

  // 얼굴 메시 삼각분할 인덱스만 필요한 경우(웹캠 없이 저장된 얼굴 복원 시) — 모델 로딩 없이 정적 상수만 사용
  const ensureFaceIndex = useCallback(async () => {
    if (faceIndexReadyRef.current) return
    const { FaceLandmarker } = await import('@mediapipe/tasks-vision')
    const filtered = FaceLandmarker.FACE_LANDMARKS_TESSELATION.filter(c => c.start < 468 && c.end < 468)
    faceMeshRef.current?.geometry.setIndex(buildTriangles(filtered))
    faceIndexReadyRef.current = true
  }, [])

  const initLandmarker = useCallback(async () => {
    setStatusMsg('MediaPipe 로딩 중…')
    try {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(MP_WASM)
      const lm = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MP_MODEL, delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.3,
        minFacePresenceConfidence: 0.3,
        minTrackingConfidence: 0.3,
      })
      landmarkerRef.current = lm
      await ensureFaceIndex()
      setStatusMsg('완료'); return lm
    } catch (e) {
      setStatusMsg('얼굴 추적 로드 실패 — 원본 웹캠만 표시 중')
      return null
    }
  }, [ensureFaceIndex])

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
      const uvSource = textureLandmarksRef.current ?? lms
      // textureLandmarksRef가 설정된 경우 = 등록된 정지사진(거울모드로 저장됨)을 텍스처로 쓰는 중.
      // 라이브 트래킹 중(uvSource === lms, 원본/비거울 캔버스 텍스처)에는 뒤집지 않는다.
      const usingMirroredStaticPhoto = textureLandmarksRef.current !== null
      for (let i = 0; i < Math.min(lms.length, 478); i++) {
        const { x, y, z } = toWorld(lms[i])
        pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z
        const uv = uvSource[i]
        if (uvArr && uv) {
          uvArr[i*2]   = usingMirroredStaticPhoto ? 1 - uv.x : uv.x
          uvArr[i*2+1] = 1 - uv.y
        }
      }
      mesh.geometry.attributes.position.needsUpdate = true
      if (uvAttr) uvAttr.needsUpdate = true
    }

    // Wireframe (주요 윤곽)
    const wire = wireRef.current
    if (wire) {
      const segs: number[] = []
      for (const grp of FACE_CONTOUR_GROUPS) {
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
  }, [])

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
          if (r.faceLandmarks?.length > 0) {
            const landmarks = r.faceLandmarks[0] as LM[]
            // 첫 사용자(등록된 얼굴이 아직 없는 경우)는 최초 한 번 얼굴을 자동 저장해둔다.
            // 라이브 텍스처는 계속 그대로 사용한다 — 여기서 정지사진으로 바꾸면
            // 이후 라이브 트래킹 내내 그 순간의 포즈로 텍스처가 고정되어 어긋나 보인다.
            if (!autoSavedFaceRef.current && !localStorage.getItem(LS_SNAPSHOT)) {
              const snapCanvas = document.createElement('canvas')
              snapCanvas.width = video.videoWidth || 640
              snapCanvas.height = video.videoHeight || 480
              const snapCtx = snapCanvas.getContext('2d')
              if (snapCtx) {
                drawMirrored(snapCtx, video, snapCanvas.width, snapCanvas.height)
                if (!isFrameTooDark(snapCanvas)) {
                  const dataUrl = snapCanvas.toDataURL('image/jpeg', 0.85)
                  try {
                    localStorage.setItem(LS_SNAPSHOT, dataUrl)
                    localStorage.setItem(LS_LANDMARKS, JSON.stringify(landmarks))
                  } catch { /* ignore storage quota errors */ }
                  autoSavedFaceRef.current = true
                  setHasSavedFace(true)
                }
              }
            }
            updateFaceMesh(landmarks)
            lastLandmarksRef.current = landmarks
          }
          if (onBlendshapesRef.current && r.faceBlendshapes?.length > 0) {
            const scores: Record<string, number> = {}
            for (const c of r.faceBlendshapes[0].categories) scores[c.categoryName] = c.score
            onBlendshapesRef.current(scores)
          }
          if (onHeadPoseRef.current && r.facialTransformationMatrixes?.length > 0) {
            const m = new THREE.Matrix4().fromArray(r.facialTransformationMatrixes[0].data)
            const euler = new THREE.Euler().setFromRotationMatrix(m, 'YXZ')
            onHeadPoseRef.current({ pitch: euler.x, yaw: euler.y, roll: euler.z })
          }
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
      setHasLiveVideo(false)
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
      setHasLiveVideo(true)
      setStatus('tracking')
    } catch (err) {
      stream.getTracks().forEach(t => t.stop())
      streamRef.current = null
      setHasLiveVideo(false)
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

    // 등록된 얼굴 사진 + 그 사진과 짝지어 저장된 landmark(UV 기준)가 있으면, 라이브 트래킹
    // 중에도 그 사진을 텍스처로 쓰고 지금 이 순간의 라이브 랜드마크로 메시만 움직인다.
    // (landmark는 사진과 항상 함께 저장되고, 사진은 거울모드로 저장되므로 UV.x 반전도 일관되게 맞는다.)
    // 아직 등록된 사진이 없는 첫 사용자만, 첫 캡처 전까지 라이브 웹캠 프레임을 임시로 보여준다.
    staticTexRef.current?.dispose()
    staticTexRef.current = null
    videoTexRef.current?.dispose()
    videoTexRef.current = null
    videoTexCanvasRef.current = null
    videoTexCtxRef.current = null

    const savedLandmarksRaw = localStorage.getItem(LS_LANDMARKS)
    let savedLandmarks: LM[] | null = null
    try { savedLandmarks = savedLandmarksRaw ? JSON.parse(savedLandmarksRaw) : null } catch { savedLandmarks = null }

    if (savedLandmarks?.length) {
      textureLandmarksRef.current = savedLandmarks
      const tex = new THREE.TextureLoader().load(`${API}/avatar/face?t=${Date.now()}`)
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = false
      tex.colorSpace = THREE.SRGBColorSpace
      staticTexRef.current = tex
      if (faceMeshRef.current) {
        const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
        mat.map = tex
        mat.opacity = 0.92
        mat.needsUpdate = true
      }
    } else {
      textureLandmarksRef.current = null
      const texCanvas = document.createElement('canvas')
      texCanvas.width = vw
      texCanvas.height = vh
      videoTexCanvasRef.current = texCanvas
      videoTexCtxRef.current = texCanvas.getContext('2d')

      const tex = new THREE.Texture(texCanvas)
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = false
      tex.colorSpace = THREE.SRGBColorSpace
      videoTexRef.current = tex
      if (faceMeshRef.current) {
        const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
        mat.map = tex
        mat.opacity = 1
        mat.needsUpdate = true
      }
    }

    setStatusMsg('트래킹 중')
    trackLoop(lm)
  }, [status, initLandmarker, trackLoop])

  // 마지막 프레임을 정지 이미지로 캡처해 저장 + 메시에 계속 표시(웹캠 꺼도 외형 유지)
  const captureAndPersistSnapshot = useCallback(() => {
    const video = videoRef.current
    const landmarks = lastLandmarksRef.current
    if (!video || !landmarks || video.videoWidth === 0) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    drawMirrored(ctx, video, canvas.width, canvas.height)

    // 검은 프레임이면 등록/저장하지 않는다. 그대로 두면 기존 정상 얼굴을 검게 덮어쓴다.
    if (isFrameTooDark(canvas)) return

    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)

    try {
      localStorage.setItem(LS_SNAPSHOT, dataUrl)
      localStorage.setItem(LS_LANDMARKS, JSON.stringify(landmarks))
    } catch { /* 용량 초과 등은 무시 */ }
    textureLandmarksRef.current = landmarks
    // 사진이 거울모드로 저장됐으므로, 이미 그려져 있던 uv(비거울 기준)를 다시 계산해야 한다.
    updateFaceMesh(landmarks)

    if (faceMeshRef.current) {
      const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
      staticTexRef.current?.dispose()
      const tex = new THREE.TextureLoader().load(dataUrl)
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = false
      tex.colorSpace = THREE.SRGBColorSpace
      staticTexRef.current = tex
      mat.map = tex
      mat.opacity = 0.92
      mat.needsUpdate = true
    }
    setHasSavedFace(true)

    // 서버에도 등록(다른 화면/재시작 후에도 얼굴 이미지 재사용 가능하도록)
    canvas.toBlob(blob => {
      if (!blob) return
      const form = new FormData()
      form.append('face', blob, 'captured_face.jpg')
      fetch(`${API}/avatar/register_face`, { method: 'POST', body: form }).catch(() => {})
    }, 'image/jpeg', 0.85)
  }, [updateFaceMesh])

  // 저장된 얼굴 사진 위에 저장된 landmark를 그려서, 카메라를 켜지 않고도
  // "사진과 landmark가 실제로 맞물리는지"를 눈으로 바로 확인할 수 있게 한다.
  const drawAlignCheck = useCallback(() => {
    const canvas = alignCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    setAlignCheckMsg('불러오는 중…')
    const img = new Image()
    img.onload = () => {
      const maxW = 420
      const scale = Math.min(1, maxW / img.naturalWidth)
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      canvas.width = w
      canvas.height = h
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)

      const landmarksRaw = localStorage.getItem(LS_LANDMARKS)
      let landmarks: LM[] | null = null
      if (landmarksRaw) {
        try { landmarks = JSON.parse(landmarksRaw) } catch { landmarks = null }
      }
      if (!landmarks?.length) {
        setAlignCheckMsg('저장된 landmark 없음 — 이 브라우저에서 아직 얼굴을 등록한 적이 없습니다.')
        return
      }

      // landmark는 원본(비거울) 좌표, 사진은 거울모드로 저장되므로 x를 뒤집어서 겹쳐야 한다.
      // 윤곽선(초록) — 사진 속 이목구비 위치에 landmark가 실제로 겹치는지 확인
      ctx.strokeStyle = '#22ff88'
      ctx.lineWidth = 1.5
      for (const grp of FACE_CONTOUR_GROUPS) {
        ctx.beginPath()
        grp.forEach((idx, i) => {
          const p = landmarks![idx]
          if (!p) return
          const px = (1 - p.x) * w, py = p.y * h
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
        })
        ctx.stroke()
      }
      // 점(빨강) — 전체 landmark
      ctx.fillStyle = '#ff3355'
      for (const p of landmarks) {
        ctx.beginPath()
        ctx.arc((1 - p.x) * w, p.y * h, 1.3, 0, Math.PI * 2)
        ctx.fill()
      }
      setAlignCheckMsg(`landmark ${landmarks.length}개 · 초록 윤곽선이 눈/입/얼굴선에 겹치면 정상입니다`)
    }
    img.onerror = () => setAlignCheckMsg('등록된 얼굴 이미지를 불러올 수 없습니다.')
    img.src = `${API}/avatar/face?t=${Date.now()}`
  }, [])

  useEffect(() => {
    if (showAlignCheck) drawAlignCheck()
  }, [showAlignCheck, drawAlignCheck])

  const stopTracking = useCallback(() => {
    captureAndPersistSnapshot()
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current.pause() }
    setHasLiveVideo(false)
    wireRef.current?.geometry.setDrawRange(0, 0)
    videoTexRef.current?.dispose()
    videoTexRef.current = null
    videoTexCanvasRef.current = null
    videoTexCtxRef.current = null
    setStatus('idle'); setStatusMsg('')
    onBlendshapesRef.current?.(null)
    onHeadPoseRef.current?.(null)
  }, [captureAndPersistSnapshot])

  // 마운트 시 기본 얼굴 텍스처는 영상 탭에서 저장한 서버 등록 얼굴을 사용한다.
  useEffect(() => {
    const landmarksRaw = localStorage.getItem(LS_LANDMARKS)
    let landmarks: LM[] | null = null
    if (landmarksRaw) {
      try { landmarks = JSON.parse(landmarksRaw) } catch { landmarks = null }
    }

    let cancelled = false
    ;(async () => {
      if (landmarks?.length) await ensureFaceIndex()
      if (cancelled) return
      if (landmarks?.length) {
        lastLandmarksRef.current = landmarks
        textureLandmarksRef.current = landmarks
        updateFaceMesh(landmarks)
      } else {
        textureLandmarksRef.current = null
      }
      if (faceMeshRef.current) {
        const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
        const tex = new THREE.TextureLoader().load(`${API}/avatar/face?t=${Date.now()}`)
        tex.minFilter = THREE.LinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.generateMipmaps = false
        tex.colorSpace = THREE.SRGBColorSpace
        staticTexRef.current = tex
        mat.map = tex
        mat.opacity = 0.92
        mat.needsUpdate = true
      }
      setHasSavedFace(true)
    })()
    return () => { cancelled = true }
  }, [ensureFaceIndex, updateFaceMesh])

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
        className={`absolute inset-0 z-10 h-full w-full bg-black transition-opacity ${hasLiveVideo ? 'opacity-100' : 'opacity-0'}`}
        style={{ transform: 'scaleX(-1)', objectFit: 'contain' }}
        playsInline muted />
      <canvas ref={canvasRef}
        className="pointer-events-none absolute inset-0 z-20 w-full h-full"
        style={{ background: 'transparent' }} />

      {/* 컨트롤 */}
      <div className="absolute top-2 left-2 flex items-center gap-1.5 flex-wrap z-30">
        {status === 'tracking' ? (
          <button onClick={stopTracking}
            className="px-2.5 py-1 text-xs rounded-lg border border-red-600 bg-red-900/80 text-red-300 hover:bg-red-800 transition backdrop-blur">
            ■ 웹캠 중지
          </button>
        ) : (
          <button onClick={startTracking} disabled={status === 'loading'}
            className={`px-2.5 py-1 text-xs rounded-lg border transition backdrop-blur
              ${status === 'loading' ? 'bg-gray-700/80 border-gray-600 text-gray-400'
                                     : 'bg-gray-800/80 text-gray-100 hover:bg-gray-700 border-gray-500'}`}>
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
            <button onClick={() => setShowAlignCheck(v => !v)}
              title="저장된 얼굴 사진과 landmark가 서로 맞는지 카메라 없이 미리 확인"
              className={`px-2.5 py-1 text-xs rounded-lg border transition backdrop-blur
                ${showAlignCheck ? 'bg-emerald-900/80 border-emerald-600 text-emerald-300' : 'bg-gray-800/80 border-gray-600 hover:bg-gray-700'}`}>
              정렬 확인
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

      {!hasLiveVideo && !hasSavedFace && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center text-gray-500 pointer-events-none gap-1 bg-black">
          <span className="text-3xl">◈</span>
          <p className="text-xs">웹캠 시작을 눌러주세요</p>
          <p className="text-[11px] text-gray-600">시작 전에는 카메라와 마이크를 사용하지 않습니다</p>
        </div>
      )}

      {/* 정렬 확인 — 카메라 없이 저장된 사진 위에 landmark를 겹쳐 그려 매칭 여부를 미리 본다 */}
      {showAlignCheck && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-2 bg-black/90 p-4">
          <div className="flex w-full max-w-[420px] items-center justify-between">
            <span className="text-xs text-gray-300">저장 얼굴 · landmark 정렬 미리보기</span>
            <button onClick={() => setShowAlignCheck(false)} className="text-xs text-gray-400 hover:text-white">✕ 닫기</button>
          </div>
          <canvas ref={alignCanvasRef} className="max-w-full rounded-lg border border-gray-700 bg-black" />
          {alignCheckMsg && <p className="text-[11px] text-gray-400">{alignCheckMsg}</p>}
          <button onClick={drawAlignCheck} className="text-xs text-gray-400 underline hover:text-white">↻ 새로고침</button>
        </div>
      )}
    </div>
  )
}
