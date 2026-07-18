/**
 * FaceTrackingPanel — 웹캠 얼굴 트래킹 + 3D 메시 오버레이 (텍스처 매핑 포함)
 * MediaPipe FaceLandmarker로 얼굴을 추적해 3D 메시에 비디오 텍스처를 매핑하고,
 * 윤곽선 오버레이 표시와 립싱크 영상 녹화/생성을 제공한다.
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { API_BASE } from '@/config'

import {
  FACE_SNAPSHOT_KEY,
  TRACKING_VIDEO_SOURCE_EVENT,
  getFaceImageUrl,
  getRegisteredFaceImageUrl,
  landmarkToSavedSnapshotPoint,
  landmarkToSavedSnapshotUv,
  readTrackingVideoSource,
  readFaceLandmarks,
  saveFaceAlignmentSnapshot,
  type FaceLandmark,
} from '@/faceAlignment'

const API      = API_BASE
const MP_WASM  = '/mediapipe/wasm'
const MP_MODEL = '/mediapipe/models/face_landmarker.task'

type LM = FaceLandmark

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
  /** 브라우저에 남은 이전 snapshot 대신 서버에 현재 등록된 얼굴 이미지를 우선 표시한다. */
  preferRegisteredFace?: boolean
  /** AI 대화처럼 다른 화면의 등록 영상을 공유하지 않고 이 패널에서만 선택 */
  isolatedVideo?: boolean
  /** 독립 이미지 선택 상태의 탭별 저장 범위 */
  storageScope?: string
  /** 이미지 선택·정렬 확인만 제공하고 추적/부가 컨트롤은 숨김 */
  imageOnly?: boolean
}

export default function FaceTrackingPanel({ className = '', compact = false, onBlendshapes, onHeadPose, preferRegisteredFace = false, isolatedVideo = false, storageScope = 'ai-chat', imageOnly = false }: Props) {
  const localImageSessionKey = `mental-avatar-${storageScope}-face-image`
  const localImageNameSessionKey = `mental-avatar-${storageScope}-face-image-name`
  const alignedFaceDisplaySessionKey = `mental-avatar-${storageScope}-aligned-face-display`
  const alignedLandmarksSessionKey = `mental-avatar-${storageScope}-aligned-landmarks`
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef  = useRef<HTMLVideoElement>(null)
  const localImageInputRef = useRef<HTMLInputElement>(null)
  const localImageUrlRef = useRef<string | null>(null)

  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef    = useRef<THREE.Scene | null>(null)
  const cameraRef   = useRef<THREE.OrthographicCamera | null>(null)
  const faceMeshRef = useRef<THREE.Mesh | null>(null)
  const wireRef     = useRef<THREE.LineSegments | null>(null)
  const videoTexRef = useRef<THREE.Texture | null>(null)
  const videoTexCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const videoTexCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const frameDetectCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const frameDetectCtxRef = useRef<CanvasRenderingContext2D | null>(null)
  const rafRef      = useRef<number>(0)

  const landmarkerRef = useRef<unknown>(null)
  const streamRef     = useRef<MediaStream | null>(null)
  const lastTsRef     = useRef(0)
  const lastLandmarksRef = useRef<LM[] | null>(null)
  const trackingNeutralLandmarksRef = useRef<LM[] | null>(null)
  const trackingBaseLandmarksRef = useRef<LM[] | null>(null)
  const trackingLoopTokenRef = useRef(0)
  const textureLandmarksRef = useRef<LM[] | null>(null)
  const textureMirroredRef = useRef(true)
  // 등록 얼굴에서 랜드마크를 못 찾은 채 추적에 들어갔는지. 이 경우 UV가 영상 인물의 좌표로
  // 폴백해 텍스처가 어긋난 채 따라다니는데, 안내가 뒤 단계 메시지에 덮여 보이지 않았다.
  const faceTextureMissingRef = useRef(false)
  const trackingFrameReadyRef = useRef(false)
  const autoSavedFaceRef = useRef(false)
  const staticTexRef  = useRef<THREE.Texture | null>(null)
  const faceIndexReadyRef = useRef(false)
  const mirroredInputRef = useRef(true)
  const motionSourceOnlyRef = useRef(false)
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
  const [mirroredInput, setMirroredInput] = useState(true)
  const [recording, setRecording]     = useState(false)
  const [recStatus, setRecStatus]     = useState('')
  const [resultUrl, setResultUrl]     = useState<string | null>(null)
  const [hasSavedFace, setHasSavedFace] = useState(false)
  const [localImageUrl, setLocalImageUrl] = useState<string | null>(() => {
    try { return sessionStorage.getItem(localImageSessionKey) }
    catch { return null }
  })
  const [localImageName, setLocalImageName] = useState(() => {
    try { return sessionStorage.getItem(localImageNameSessionKey) || '' }
    catch { return '' }
  })
  const [alignedFaceDisplayUrl, setAlignedFaceDisplayUrl] = useState<string | null>(() => {
    try { return localStorage.getItem(alignedFaceDisplaySessionKey) || sessionStorage.getItem(alignedFaceDisplaySessionKey) }
    catch { return null }
  })
  const [trackingVideoSource, setTrackingVideoSource] = useState(() => isolatedVideo ? null : readTrackingVideoSource())
  const recorderRef  = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])

  // 저장된 얼굴 사진 + landmark 정렬 미리보기 (카메라 없이도 확인 가능)
  const alignCanvasRef = useRef<HTMLCanvasElement>(null)
  const alignedLandmarksRef = useRef<LM[] | null>(null)
  const alignedVideoSourceRef = useRef<string | null>(null)
  const [showAlignCheck, setShowAlignCheck] = useState(false)
  const [alignCheckMsg, setAlignCheckMsg] = useState('')

  const resetVideoTrackingState = useCallback((closeLandmarker = false) => {
    trackingLoopTokenRef.current += 1
    lastTsRef.current = 0
    lastLandmarksRef.current = null
    trackingNeutralLandmarksRef.current = null
    trackingBaseLandmarksRef.current = null
    trackingFrameReadyRef.current = false
    faceTextureMissingRef.current = false
    frameDetectCanvasRef.current = null
    frameDetectCtxRef.current = null
    wireRef.current?.geometry.setDrawRange(0, 0)
    if (faceMeshRef.current) {
      const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = 0
      mat.needsUpdate = true
    }
    if (closeLandmarker && landmarkerRef.current) {
      try {
        ;(landmarkerRef.current as { close?: () => void }).close?.()
      } catch { /* ignore MediaPipe cleanup errors */ }
      landmarkerRef.current = null
    }
  }, [])

  const hideTrackedFace = useCallback(() => {
    lastLandmarksRef.current = null
    wireRef.current?.geometry.setDrawRange(0, 0)
    if (faceMeshRef.current) {
      const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
      mat.opacity = 0
      mat.needsUpdate = true
    }
  }, [])

  const applyTrackingVideoSource = useCallback((source = isolatedVideo ? null : readTrackingVideoSource()) => {
    setTrackingVideoSource(source)
    const video = videoRef.current
    resetVideoTrackingState(true)
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    motionSourceOnlyRef.current = false
    onBlendshapesRef.current?.(null)
    onHeadPoseRef.current?.(null)

    if (!source || !video) {
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
      setHasLiveVideo(false)
      setStatus('idle')
      setStatusMsg('')
      setMirroredInput(true)
      mirroredInputRef.current = true
      return
    }

    video.srcObject = null
    video.src = source.url
    video.loop = true
    video.muted = true
    video.load()
    mirroredInputRef.current = false
    setMirroredInput(false)
    setHasLiveVideo(true)
    setStatusMsg(`Registered video ready: ${source.name}`)
    const syncAspect = () => {
      const vw = video.videoWidth || 640
      const vh = video.videoHeight || 480
      setVideoAspect(`${vw}/${vh}`)
    }
    video.onloadedmetadata = syncAspect
    video.play().catch(() => {})
    setStatus('idle')
  }, [isolatedVideo, resetVideoTrackingState])

  const selectLocalImage = useCallback((file: File | null) => {
    if (!file) return
    if (localImageUrlRef.current) URL.revokeObjectURL(localImageUrlRef.current)
    const url = URL.createObjectURL(file)
    localImageUrlRef.current = url
    alignedLandmarksRef.current = null
    alignedVideoSourceRef.current = null
    setAlignedFaceDisplayUrl(null)
    try {
      localStorage.removeItem(localImageSessionKey)
      localStorage.removeItem(alignedFaceDisplaySessionKey)
      localStorage.removeItem(alignedLandmarksSessionKey)
      sessionStorage.removeItem(alignedFaceDisplaySessionKey)
      sessionStorage.removeItem(alignedLandmarksSessionKey)
    } catch { /* storage quota */ }
    setLocalImageUrl(url)
    setLocalImageName(file.name)
    try { sessionStorage.removeItem(localImageSessionKey); sessionStorage.setItem(localImageNameSessionKey, file.name) } catch { /* storage quota */ }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        try { localStorage.setItem(localImageSessionKey, reader.result) } catch {
          try { sessionStorage.setItem(localImageSessionKey, reader.result) } catch { /* storage quota */ }
        }
      }
    }
    reader.readAsDataURL(file)
    setShowAlignCheck(true)
  }, [alignedFaceDisplaySessionKey, alignedLandmarksSessionKey, localImageNameSessionKey, localImageSessionKey])

  useEffect(() => {
    applyTrackingVideoSource()
    if (isolatedVideo) return () => {
      if (localImageUrlRef.current) URL.revokeObjectURL(localImageUrlRef.current)
    }
    const onTrackingVideoChange = (event: Event) => {
      const detail = (event as CustomEvent).detail
      applyTrackingVideoSource(detail ?? readTrackingVideoSource())
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'mental-avatar-tracking-video-source') applyTrackingVideoSource()
    }
    window.addEventListener(TRACKING_VIDEO_SOURCE_EVENT, onTrackingVideoChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(TRACKING_VIDEO_SOURCE_EVENT, onTrackingVideoChange)
      window.removeEventListener('storage', onStorage)
      if (videoRef.current) videoRef.current.onloadedmetadata = null
    }
  }, [applyTrackingVideoSource, isolatedVideo])

  const getTextureFaceUrl = useCallback(() => (
    preferRegisteredFace ? getRegisteredFaceImageUrl() : getFaceImageUrl()
  ), [preferRegisteredFace])

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

  const detectImageLandmarks = useCallback(async (imageUrl: string): Promise<LM[] | null> => {
    try {
      const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(MP_WASM)
      const detector = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MP_MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 1,
        minFaceDetectionConfidence: 0.3,
        minFacePresenceConfidence: 0.3,
      })
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = imageUrl
      await img.decode()
      const result = detector.detect(img)
      detector.close()
      return result.faceLandmarks?.[0] as LM[] || null
    } catch {
      return null
    }
  }, [])

  const updateFaceMesh = useCallback((lms: LM[]) => {
    const cam = cameraRef.current
    const aspect = cam ? cam.right : 1

    const S = 0.96
    const toWorld = (lm: LM) => ({
      x: (mirroredInputRef.current ? -1 : 1) * (lm.x - 0.5) * 2 * aspect * S,
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
      const usingStaticPhoto = textureLandmarksRef.current !== null
      for (let i = 0; i < Math.min(lms.length, 478); i++) {
        const { x, y, z } = toWorld(lms[i])
        pos[i*3] = x; pos[i*3+1] = y; pos[i*3+2] = z
        const uv = uvSource[i]
        if (uvArr && uv) {
          const mappedUv = usingStaticPhoto
            ? (textureMirroredRef.current ? landmarkToSavedSnapshotUv(uv) : { u: uv.x, v: 1 - uv.y })
            : { u: uv.x, v: 1 - uv.y }
          uvArr[i*2]   = mappedUv.u
          uvArr[i*2+1] = mappedUv.v
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

  // 독립 이미지가 선택되면 저장 얼굴의 이전 메시를 그대로 두지 않고,
  // 선택 이미지 자체의 landmark/텍스처를 즉시 메시 기준으로 적용한다.
  const applyTrackingMotion = useCallback((landmarks: LM[]) => {
    const base = trackingBaseLandmarksRef.current
    if (!base?.length) return landmarks

    let neutral = trackingNeutralLandmarksRef.current
    if (!neutral?.length) {
      neutral = landmarks.map(point => ({ ...point }))
      trackingNeutralLandmarksRef.current = neutral
      return base
    }

    const baseLeft = base[234]
    const baseRight = base[454]
    const neutralLeft = neutral[234]
    const neutralRight = neutral[454]
    const baseWidth = baseLeft && baseRight ? Math.abs(baseRight.x - baseLeft.x) : 1
    const neutralWidth = neutralLeft && neutralRight ? Math.abs(neutralRight.x - neutralLeft.x) : 1
    const motionScale = neutralWidth > 0.0001 ? baseWidth / neutralWidth : 1

    return base.map((basePoint, index) => {
      const currentPoint = landmarks[index]
      const neutralPoint = neutral![index]
      if (!currentPoint || !neutralPoint) return basePoint
      return {
        x: basePoint.x + (currentPoint.x - neutralPoint.x) * motionScale,
        y: basePoint.y + (currentPoint.y - neutralPoint.y) * motionScale,
        z: basePoint.z + (currentPoint.z - neutralPoint.z) * motionScale,
      }
    })
  }, [])

  const trackLoop = useCallback((lm: unknown, token = trackingLoopTokenRef.current) => {
    if (token !== trackingLoopTokenRef.current) return
    const video = videoRef.current
    if (!video) return
    if (video.paused || video.ended) return
    if (video.readyState >= 2) {
      const now = performance.now()
      if (now > lastTsRef.current) {
        lastTsRef.current = now
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let detectSource: HTMLVideoElement | HTMLCanvasElement = video
          if (motionSourceOnlyRef.current) {
            const width = video.videoWidth
            const height = video.videoHeight
            if (!width || !height) {
              requestAnimationFrame(() => trackLoop(lm, token))
              return
            }
            let frameCanvas = frameDetectCanvasRef.current
            if (!frameCanvas || frameCanvas.width !== width || frameCanvas.height !== height) {
              frameCanvas = document.createElement('canvas')
              frameCanvas.width = width
              frameCanvas.height = height
              frameDetectCanvasRef.current = frameCanvas
              frameDetectCtxRef.current = frameCanvas.getContext('2d', { willReadFrequently: true })
            }
            const frameCtx = frameDetectCtxRef.current
            if (!frameCtx) {
              hideTrackedFace()
              requestAnimationFrame(() => trackLoop(lm, token))
              return
            }
            frameCtx.drawImage(video, 0, 0, width, height)
            detectSource = frameCanvas
          }
          const r = (lm as any).detectForVideo(detectSource, now)
          if (r.faceLandmarks?.length > 0) {
            const landmarks = r.faceLandmarks[0] as LM[]
            // 첫 사용자(등록된 얼굴이 아직 없는 경우)는 최초 한 번 얼굴을 자동 저장해둔다.
            // 라이브 텍스처는 계속 그대로 사용한다 — 여기서 정지사진으로 바꾸면
            // 이후 라이브 트래킹 내내 그 순간의 포즈로 텍스처가 고정되어 어긋나 보인다.
            if (!preferRegisteredFace && mirroredInputRef.current && !autoSavedFaceRef.current && !localStorage.getItem(FACE_SNAPSHOT_KEY)) {
              const snapCanvas = document.createElement('canvas')
              snapCanvas.width = video.videoWidth || 640
              snapCanvas.height = video.videoHeight || 480
              const snapCtx = snapCanvas.getContext('2d')
              if (snapCtx) {
                drawMirrored(snapCtx, video, snapCanvas.width, snapCanvas.height)
                if (!isFrameTooDark(snapCanvas)) {
                  const dataUrl = snapCanvas.toDataURL('image/jpeg', 0.85)
                  try {
                    saveFaceAlignmentSnapshot(dataUrl, landmarks, snapCanvas.width, snapCanvas.height)
                  } catch { /* ignore storage quota errors */ }
                  autoSavedFaceRef.current = true
                  setHasSavedFace(true)
                }
              }
            }
            const drivenLandmarks = motionSourceOnlyRef.current
              ? applyTrackingMotion(landmarks)
              : landmarks
            updateFaceMesh(drivenLandmarks)
            lastLandmarksRef.current = landmarks
            if (motionSourceOnlyRef.current && !trackingFrameReadyRef.current) {
              trackingFrameReadyRef.current = true
              if (faceMeshRef.current) {
                const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
                mat.opacity = 0.92
                mat.needsUpdate = true
              }
              // 등록 얼굴 랜드마크가 없으면 경고를 유지한다 — 여기서 덮으면 어긋난 매핑이
              // 정상 추적처럼 보인다(이 화면의 원래 문제).
              if (!faceTextureMissingRef.current) setStatusMsg('Tracking current frame landmarks')
            }
          } else if (motionSourceOnlyRef.current) {
            hideTrackedFace()
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
        } catch {
          if (motionSourceOnlyRef.current) {
            hideTrackedFace()
          }
        }
      }
    }
    requestAnimationFrame(() => trackLoop(lm, token))
  }, [applyTrackingMotion, hideTrackedFace, preferRegisteredFace, updateFaceMesh])

  const startTracking = useCallback(async () => {
    const registeredSource = isolatedVideo ? null : (trackingVideoSource ?? readTrackingVideoSource())
    if (preferRegisteredFace && !registeredSource && !isolatedVideo) {
      setStatus('error')
      setStatusMsg('등록된 추적 영상이 없습니다')
      return
    }
    if (registeredSource && status !== 'tracking' && status !== 'loading') {
      const video = videoRef.current
      if (!video) return

      setTrackingVideoSource(registeredSource)
      setStatus('loading')
      setStatusMsg(`Loading registered video: ${registeredSource.name}`)
      resetVideoTrackingState(true)
      streamRef.current?.getTracks().forEach(t => t.stop())
      streamRef.current = null
      video.srcObject = null
      if (video.src !== registeredSource.url) video.src = registeredSource.url
      video.loop = true
      video.muted = true
      try { video.currentTime = 0 } catch { /* ignore seek errors before metadata */ }
      mirroredInputRef.current = false
      motionSourceOnlyRef.current = true
      setMirroredInput(false)

      try {
        await video.play()
        setHasLiveVideo(true)
        setStatus('tracking')
      } catch (err) {
        setHasLiveVideo(false)
        setStatus('error')
        setStatusMsg('Registered video playback error: ' + (err instanceof Error ? err.message : String(err)))
        return
      }

      const lm = await initLandmarker()
      if (!lm) return

      const vw = video.videoWidth || 640
      const vh = video.videoHeight || 480
      setVideoAspect(`${vw}/${vh}`)
      const a = vw / vh
      const cam = cameraRef.current
      if (cam) { cam.left = -a; cam.right = a; cam.updateProjectionMatrix() }
      const canvas = canvasRef.current
      if (canvas && rendererRef.current) {
        rendererRef.current.setSize(canvas.clientWidth, canvas.clientHeight, false)
      }

      staticTexRef.current?.dispose()
      staticTexRef.current = null
      videoTexRef.current?.dispose()
      videoTexRef.current = null
      videoTexCanvasRef.current = null
      videoTexCtxRef.current = null

      const textureUrl = getTextureFaceUrl()
      const detectedTextureLandmarks = preferRegisteredFace ? await detectImageLandmarks(textureUrl) : null
      const savedLandmarks = preferRegisteredFace ? detectedTextureLandmarks : readFaceLandmarks()
      textureLandmarksRef.current = savedLandmarks?.length ? savedLandmarks : null
      trackingBaseLandmarksRef.current = savedLandmarks?.length ? savedLandmarks : null
      trackingNeutralLandmarksRef.current = null
      textureMirroredRef.current = !detectedTextureLandmarks
      faceTextureMissingRef.current = preferRegisteredFace && !textureLandmarksRef.current
      const tex = new THREE.TextureLoader().load(textureUrl)
      tex.minFilter = THREE.LinearFilter
      tex.magFilter = THREE.LinearFilter
      tex.generateMipmaps = false
      tex.colorSpace = THREE.SRGBColorSpace
      staticTexRef.current = tex
      if (faceMeshRef.current) {
        const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
        mat.map = tex
        mat.opacity = 0
        mat.needsUpdate = true
      }

      setStatusMsg(faceTextureMissingRef.current
        ? '⚠ 등록된 얼굴에서 랜드마크를 찾지 못했습니다 — 텍스처가 어긋난 채로 추적됩니다'
        : `Waiting for current frame landmarks: ${registeredSource.name}`)
      trackLoop(lm, trackingLoopTokenRef.current)
      return
    }
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
    resetVideoTrackingState(true)
    mirroredInputRef.current = true
    motionSourceOnlyRef.current = false
    setMirroredInput(true)
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

    const textureUrl = getTextureFaceUrl()
    const detectedTextureLandmarks = preferRegisteredFace ? await detectImageLandmarks(textureUrl) : null
    const savedLandmarks = detectedTextureLandmarks?.length ? detectedTextureLandmarks : readFaceLandmarks()

    if (savedLandmarks?.length) {
      textureLandmarksRef.current = savedLandmarks
      textureMirroredRef.current = !detectedTextureLandmarks
      const tex = new THREE.TextureLoader().load(textureUrl)
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
      textureMirroredRef.current = false
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
    trackLoop(lm, trackingLoopTokenRef.current)
  }, [status, trackingVideoSource, initLandmarker, trackLoop, detectImageLandmarks, getTextureFaceUrl, isolatedVideo, localImageUrl, preferRegisteredFace, resetVideoTrackingState])

  // 저장된 얼굴 사진 위에 저장된 landmark를 그려서, 카메라를 켜지 않고도
  // "사진과 landmark가 실제로 맞물리는지"를 눈으로 바로 확인할 수 있게 한다.
  const drawAlignCheck = useCallback(() => {
    const canvas = alignCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    setAlignCheckMsg('불러오는 중…')
    const img = new Image()
    img.onload = async () => {
      const maxW = 420
      const scale = Math.min(1, maxW / img.naturalWidth)
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)
      canvas.width = w
      canvas.height = h
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)

      // AI 대화 탭에서는 선택 이미지 위에 서버에 저장된 얼굴을 반투명하게 겹쳐
      // 두 얼굴의 위치와 크기를 한 화면에서 비교할 수 있게 한다.
      if (isolatedVideo && localImageUrl) {
        const saved = new Image()
        saved.onload = () => {
          ctx.save()
          ctx.globalAlpha = 0.35
          ctx.drawImage(saved, 0, 0, w, h)
          ctx.restore()
        }
        saved.src = getTextureFaceUrl()
      }

      const detectedLandmarks = await detectImageLandmarks(img.src)
      const landmarks = isolatedVideo ? detectedLandmarks : (preferRegisteredFace ? detectedLandmarks : readFaceLandmarks())
      const pointFor = (p: LM) => (isolatedVideo || detectedLandmarks)
        ? { x: p.x * w, y: p.y * h }
        : landmarkToSavedSnapshotPoint(p, w, h)
      if (!landmarks?.length) {
        setAlignCheckMsg(isolatedVideo ? '선택한 영상에서 얼굴을 찾지 못했습니다.' : '저장된 landmark 없음 — 이 브라우저에서 아직 얼굴을 등록한 적이 없습니다.')
        return
      }

      // 정렬 확인 결과는 tracking용 landmark/video와 분리된 결과 공간에만 저장한다.
      alignedLandmarksRef.current = landmarks.map(point => ({ ...point }))
      alignedVideoSourceRef.current = img.src
      try {
        localStorage.setItem(alignedLandmarksSessionKey, JSON.stringify(alignedLandmarksRef.current))
        sessionStorage.removeItem(alignedLandmarksSessionKey)
      } catch {
        try { sessionStorage.setItem(alignedLandmarksSessionKey, JSON.stringify(alignedLandmarksRef.current)) } catch { /* storage quota */ }
      }

      const facePoints = landmarks.map(pointFor)
      const faceMinX = Math.min(...facePoints.map(point => point.x))
      const faceMaxX = Math.max(...facePoints.map(point => point.x))
      const faceMinY = Math.min(...facePoints.map(point => point.y))
      const faceMaxY = Math.max(...facePoints.map(point => point.y))
      const faceCx = (faceMinX + faceMaxX) / 2
      const faceCy = (faceMinY + faceMaxY) / 2
      const faceRx = Math.max(1, (faceMaxX - faceMinX) * 0.64)
      const faceRy = Math.max(1, (faceMaxY - faceMinY) * 0.72)
      const faceCanvas = document.createElement('canvas')
      faceCanvas.width = w
      faceCanvas.height = h
      const faceCtx = faceCanvas.getContext('2d')
      if (!faceCtx) return
      faceCtx.fillStyle = '#000'
      faceCtx.fillRect(0, 0, w, h)
      faceCtx.save()
      faceCtx.beginPath()
      faceCtx.ellipse(faceCx, faceCy, faceRx, faceRy, 0, 0, Math.PI * 2)
      faceCtx.clip()
      faceCtx.drawImage(img, 0, 0, w, h)
      faceCtx.restore()

      const alignedFaceDataUrl = faceCanvas.toDataURL('image/png')
      setAlignedFaceDisplayUrl(alignedFaceDataUrl)
      try {
        localStorage.setItem(alignedFaceDisplaySessionKey, alignedFaceDataUrl)
        sessionStorage.removeItem(alignedFaceDisplaySessionKey)
      } catch {
        try { sessionStorage.setItem(alignedFaceDisplaySessionKey, alignedFaceDataUrl) } catch { /* storage quota */ }
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
          const { x: px, y: py } = pointFor(p)
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py)
        })
        ctx.stroke()
      }
      // 점(빨강) — 전체 landmark
      ctx.fillStyle = '#ff3355'
      for (const p of landmarks) {
        ctx.beginPath()
        const point = pointFor(p)
        ctx.arc(point.x, point.y, 1.3, 0, Math.PI * 2)
        ctx.fill()
      }
      setAlignCheckMsg(`landmark ${landmarks.length}개 · 초록 윤곽선이 눈/입/얼굴선에 겹치면 정상입니다`)
    }
    img.onerror = () => setAlignCheckMsg(isolatedVideo ? '선택한 영상을 불러올 수 없습니다.' : '등록된 얼굴 이미지를 불러올 수 없습니다.')
    if (isolatedVideo && localImageUrl) {
      img.src = localImageUrl
    } else if (isolatedVideo) {
      const video = videoRef.current
      if (!video || video.readyState < 2 || !video.videoWidth) {
        setAlignCheckMsg('먼저 영상을 선택하고 미리보기가 표시될 때까지 기다려 주세요.')
        return
      }
      const source = document.createElement('canvas')
      source.width = video.videoWidth
      source.height = video.videoHeight
      source.getContext('2d')?.drawImage(video, 0, 0, source.width, source.height)
      img.src = source.toDataURL('image/jpeg', 0.9)
    } else {
      img.src = getTextureFaceUrl()
    }
  }, [alignedFaceDisplaySessionKey, alignedLandmarksSessionKey, getTextureFaceUrl, detectImageLandmarks, isolatedVideo, localImageUrl, preferRegisteredFace])

  useEffect(() => {
    if (showAlignCheck) drawAlignCheck()
  }, [showAlignCheck, drawAlignCheck])

  const stopTracking = useCallback(() => {
    resetVideoTrackingState(false)
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current.pause() }
    setHasLiveVideo(false)
    motionSourceOnlyRef.current = false
    wireRef.current?.geometry.setDrawRange(0, 0)
    videoTexRef.current?.dispose()
    videoTexRef.current = null
    videoTexCanvasRef.current = null
    videoTexCtxRef.current = null
    setStatus('idle'); setStatusMsg('')
    onBlendshapesRef.current?.(null)
    onHeadPoseRef.current?.(null)
  }, [resetVideoTrackingState])

  // 마운트 시 기본 얼굴 텍스처는 영상 탭에서 저장한 서버 등록 얼굴을 사용한다.
  useEffect(() => {
    let cancelled = false
    const initializationToken = trackingLoopTokenRef.current
    ;(async () => {
      const textureUrl = getTextureFaceUrl()
      const detectedLandmarks = preferRegisteredFace ? await detectImageLandmarks(textureUrl) : null
      const landmarks = preferRegisteredFace ? detectedLandmarks : readFaceLandmarks()
      if (landmarks?.length) await ensureFaceIndex()
      if (cancelled || initializationToken !== trackingLoopTokenRef.current) return
      textureMirroredRef.current = !detectedLandmarks
      if (landmarks?.length) {
            lastLandmarksRef.current = landmarks.map(point => ({ ...point }))
        textureLandmarksRef.current = landmarks
        if (!motionSourceOnlyRef.current) updateFaceMesh(landmarks)
      } else {
        textureLandmarksRef.current = null
      }
      if (faceMeshRef.current) {
        const mat = faceMeshRef.current.material as THREE.MeshBasicMaterial
        const tex = new THREE.TextureLoader().load(textureUrl)
        tex.minFilter = THREE.LinearFilter
        tex.magFilter = THREE.LinearFilter
        tex.generateMipmaps = false
        tex.colorSpace = THREE.SRGBColorSpace
        staticTexRef.current = tex
        mat.map = tex
        mat.opacity = showMesh && status === 'tracking' ? 0.92 : 0
        mat.needsUpdate = true
      }
      setHasSavedFace(true)
    })()
    return () => { cancelled = true }
  }, [ensureFaceIndex, updateFaceMesh, getTextureFaceUrl, detectImageLandmarks, preferRegisteredFace, showMesh, status])

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
        className={`${imageOnly ? 'hidden ' : ''}absolute inset-0 z-10 h-full w-full bg-black transition-opacity ${hasLiveVideo && status === 'tracking' ? 'opacity-100' : 'opacity-0'}`}
        style={{ transform: mirroredInput ? 'scaleX(-1)' : 'none', objectFit: 'contain' }}
        playsInline muted />
      {(alignedFaceDisplayUrl || localImageUrl) && status !== 'tracking' && (
        <img
          src={alignedFaceDisplayUrl || localImageUrl || ''}
          alt="정렬된 얼굴 영역"
          className="pointer-events-none absolute inset-0 z-10 h-full w-full bg-black object-contain"
        />
      )}
      <canvas ref={canvasRef}
        className={`${imageOnly ? 'hidden ' : ''}pointer-events-none absolute inset-0 z-20 w-full h-full`}
        style={{ background: 'transparent' }} />

      {/* 컨트롤 */}
      <div className="absolute top-2 left-2 flex items-center gap-1.5 flex-wrap z-30">
        {isolatedVideo && (
          <>
            <input ref={localImageInputRef} type="file" accept="image/*" className="hidden"
              onChange={event => { selectLocalImage(event.target.files?.[0] ?? null); event.currentTarget.value = '' }} />
            <button type="button" onClick={() => localImageInputRef.current?.click()}
              className="px-2.5 py-1 text-xs rounded-lg border border-blue-500 bg-blue-900/80 text-blue-200 hover:bg-blue-800 transition backdrop-blur">
              이미지 선택
            </button>
            {localImageName && <span className="max-w-[10rem] truncate text-[10px] text-blue-200 backdrop-blur bg-black/40 px-2 py-1 rounded">{localImageName}</span>}
          </>
        )}
        {!imageOnly && (status === 'tracking' ? (
          <button onClick={stopTracking}
            className="px-2.5 py-1 text-xs rounded-lg border border-red-600 bg-red-900/80 text-red-300 hover:bg-red-800 transition backdrop-blur">
            {isolatedVideo ? '■ 웹캠 추적 중지' : preferRegisteredFace ? '■ 영상 추적 중지' : '■ 웹캠 중지'}
          </button>
        ) : (
          <button onClick={startTracking} disabled={status === 'loading'}
            className={`px-2.5 py-1 text-xs rounded-lg border transition backdrop-blur
              ${status === 'loading' ? 'bg-gray-700/80 border-gray-600 text-gray-400'
                                     : 'bg-gray-800/80 text-gray-100 hover:bg-gray-700 border-gray-500'}`}>
            {status === 'loading' ? '⟳ 로딩…' : isolatedVideo ? '▶ 웹캠 추적 시작' : preferRegisteredFace ? '▶ 영상 추적 시작' : '▶ 웹캠 시작'}
          </button>
        ))}
        {!compact && (
          <>
            {!imageOnly && (
              <>
                <button onClick={() => setShowWire(v => !v)}
                  className={`px-2.5 py-1 text-xs rounded-lg border transition backdrop-blur
                    ${showWire ? 'bg-cyan-900/80 border-cyan-600 text-cyan-300' : 'bg-gray-800/80 border-gray-600 hover:bg-gray-700'}`}>
                  윤곽 {showWire ? 'ON' : 'OFF'}
                </button>
                <button onClick={() => setShowMesh(v => !v)}
                  className={`px-2.5 py-1 text-xs rounded-lg border transition backdrop-blur
                    ${showMesh ? 'bg-indigo-900/80 border-indigo-600 text-indigo-300' : 'bg-gray-800/70 border-gray-600 hover:bg-gray-700'}`}>
                  메시 {showMesh ? 'ON' : 'OFF'}
                </button>
              </>
            )}
            <button onClick={() => setShowAlignCheck(v => !v)}
              title="저장된 얼굴 사진과 landmark가 서로 맞는지 카메라 없이 미리 확인"
              className={`px-2.5 py-1 text-xs rounded-lg border transition backdrop-blur
                ${showAlignCheck ? 'bg-emerald-900/80 border-emerald-600 text-emerald-300' : 'bg-gray-800/80 border-gray-600 hover:bg-gray-700'}`}>
              정렬 확인
            </button>
            {!imageOnly && status === 'tracking' && (
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

      {!hasLiveVideo && !hasSavedFace && !alignedFaceDisplayUrl && !localImageUrl && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center text-gray-500 pointer-events-none gap-1 bg-black">
          <span className="text-3xl">◈</span>
          <p className="text-xs">{imageOnly ? '이미지를 선택해 주세요' : isolatedVideo ? '웹캠 추적 시작을 눌러주세요' : preferRegisteredFace ? '영상 추적 시작을 눌러주세요' : '웹캠 시작을 눌러주세요'}</p>
          <p className="text-[11px] text-gray-600">
            {imageOnly ? '이미지 선택 후 정렬 확인만 사용할 수 있습니다' : isolatedVideo ? '선택한 이미지는 정렬용, 움직임은 웹캠으로 추적합니다' : preferRegisteredFace ? '등록된 영상의 얼굴 움직임을 추적합니다' : '시작 전에는 카메라와 마이크를 사용하지 않습니다'}
          </p>
        </div>
      )}

      {/* 정렬 확인 — 카메라 없이 저장된 사진 위에 landmark를 겹쳐 그려 매칭 여부를 미리 본다 */}
      {showAlignCheck && (
        <div className="pointer-events-none absolute inset-0 z-40 flex flex-col gap-1.5 overflow-hidden bg-black/90 p-3">
          <div className="pointer-events-auto flex w-full max-w-[420px] items-center justify-between">
            <span className="text-xs text-gray-300">저장 얼굴 · landmark 정렬 미리보기</span>
            <button onClick={() => setShowAlignCheck(false)} className="text-xs text-gray-400 hover:text-white">✕ 닫기</button>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <canvas ref={alignCanvasRef} className="pointer-events-auto max-h-full max-w-full rounded-lg border border-gray-700 bg-black object-contain" />
          </div>
          <div className="pointer-events-auto flex shrink-0 flex-col items-center gap-1">
            {alignCheckMsg && <p className="max-w-full truncate text-[11px] text-gray-400">{alignCheckMsg}</p>}
            <div className="flex items-center gap-3">
            <button onClick={drawAlignCheck} className="text-xs text-gray-400 underline hover:text-white">↻ 새로고침</button>
            <button onClick={() => setShowAlignCheck(false)} className="rounded-lg border border-gray-500 bg-gray-800 px-3 py-1.5 text-xs text-gray-100 hover:bg-gray-700">닫기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
