/**
 * PptPresenter — PPTX/PDF 업로드 → 슬라이드별 발표 대본(LLM) 생성 → 3D 아바타가 순차 발표(TTS+립싱크)
 *
 * 립싱크/표정은 RealisticAvatar.tsx와 동일한 모프타겟 파이프라인(주파수 대역 기반 viseme 근사 + 감정별 가중치).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { API_BASE } from '@/config'
import VoiceServiceBanner from '@/components/VoiceServiceBanner'
import { type Emotion, type LipCue, type EmotionCue, MORPH_GROUPS, RHUBARB_SHAPE_TARGETS, EMOTION_WEIGHTS, buildEmotionCues, classifyEmotion } from '@/avatarMorph'

const API = API_BASE
const IDB_NAME = 'mental-avatar-glb'
const IDB_STORE = 'glb-files'
// RealisticAvatar.tsx와 동일한 키 — 거기서 선택/등록한 GLB를 그대로 공유해서 보여준다
const AVATAR_FILE_KEY = 'mental-avatar-avaturn-filename'
const VIEW_MODE_KEY = 'mental-avatar-camera-view'
type ViewMode = 'face' | 'upper' | 'full'
type VideoResolution = '720p' | '1080p'
const VIDEO_RESOLUTIONS: Record<VideoResolution, { width: number; height: number; label: string }> = {
  '720p': { width: 1280, height: 720, label: '1280 x 720 (HD)' },
  '1080p': { width: 1920, height: 1080, label: '1920 x 1080 (Full HD)' },
}
const VIEW_MODE_LABELS: Record<ViewMode, string> = { face: '얼굴만', upper: '상반신', full: '전체 보기' }
// face: 얼굴이 화면을 꽉 채우는 클로즈업 — 카메라를 바짝 당기는 대신 FOV를 좁혀 왜곡 없이 확대(망원렌즈 효과).
// upper: 기존 기본값(상반신). full: 전신이 다 보이는 화면.
const VIEW_PRESETS: Record<ViewMode, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
  face:  { pos: [0, 1.58, 0.6], target: [0, 1.58, 0], fov: 45 },
  upper: { pos: [0, 1.5, 1.3], target: [0, 1.45, 0], fov: 45 },
  full:  { pos: [0, 0.9, 3.0], target: [0, 0.8, 0], fov: 45 },
}

interface GlbEntry { name: string; size: number; data: ArrayBuffer; loadedAt: number }

function openIDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE, { keyPath: 'name' })
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
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
async function idbSave(entry: GlbEntry) {
  const db = await openIDB()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(entry)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
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

interface Slide { index: number; title: string; image: string | null; script: string }

interface VoiceOption { id: string; label: string }
const VOICE_OPTIONS: VoiceOption[] = [
  { id: 'mine',   label: '내 목소리' },
  { id: 'pretty', label: '예쁜 목소리' },
  { id: 'child',  label: '어린이 목소리' },
  { id: 'calm',   label: '차분한 목소리' },
]

interface MorphRef { mesh: THREE.Mesh; index: number }
// 립싱크·표정 모프 상수/분류기는 @/avatarMorph 로 분리 (RealisticAvatar와 공용)

// 발표 대본을 문장 단위로 잘라 각 조각이 대략 MAX_CHUNK_LEN 자를 넘지 않게 묶는다.
// XTTS 한국어는 긴 텍스트를 한 번에 합성하면 수십 초가 걸려 "소리가 안 난다"처럼 느껴진다.
// 짧게 나눠 순차 합성·재생하면 첫 문장이 ~3초 안에 나오고 내용도 잘리지 않는다.
const MAX_CHUNK_LEN = 90
function splitScriptForTTS(text: string): string[] {
  const trimmed = (text || '').trim()
  if (!trimmed) return []
  const sentences = trimmed
    .split(/(?<=[.!?…。])\s+|\n+/)
    .map(s => s.trim())
    .filter(Boolean)
  const chunks: string[] = []
  let buf = ''
  for (const s of sentences) {
    // 한 문장이 너무 길면 쉼표 등으로 더 쪼갠다
    const parts = s.length > MAX_CHUNK_LEN ? s.split(/(?<=[,、·])\s*/) : [s]
    for (const p0 of parts) {
      let p = p0.trim()
      if (!p) continue
      // 구두점으로도 안 잘리는 초장문은 길이로 강제 절단
      while (p.length > MAX_CHUNK_LEN) {
        if (buf) { chunks.push(buf); buf = '' }
        chunks.push(p.slice(0, MAX_CHUNK_LEN))
        p = p.slice(MAX_CHUNK_LEN)
      }
      if (!p) continue
      if ((buf ? buf.length + 1 : 0) + p.length <= MAX_CHUNK_LEN) {
        buf = buf ? `${buf} ${p}` : p
      } else {
        if (buf) chunks.push(buf)
        buf = p
      }
    }
  }
  if (buf) chunks.push(buf)
  return chunks
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.max(0, Math.round(seconds % 60))
  return minutes > 0 ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`
}

export default function PptPresenter() {
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
  const emotionCuesRef = useRef<EmotionCue[]>([])
  const emotionRef = useRef<Emotion>('neutral')
  const blinkKeysRef = useRef<string[]>([])
  const blinkStateRef = useRef<{ phase: 'idle' | 'closing' | 'opening'; elapsed: number; next: number }>({ phase: 'idle', elapsed: 0, next: 2000 + Math.random() * 3000 })
  const [avatarLoaded, setAvatarLoaded] = useState(false)
  const [avatarError, setAvatarError] = useState('')
  const [fileName, setFileName] = useState(() => localStorage.getItem(AVATAR_FILE_KEY) || '')
  const [glbList, setGlbList] = useState<GlbEntry[]>([])
  const [showList, setShowList] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploadDragging, setUploadDragging] = useState(false)
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

  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 })
  const [sessionId, setSessionId] = useState('')
  const [slides, setSlides] = useState<Slide[]>([])

  // ── 저장된 발표(슬라이드+대본) 목록 — api/server.py가 세션 디렉터리에 slides.json으로 영속 저장 ──
  interface SavedSession { session_id: string; source_name: string; created_at: string; slide_count: number; thumbnail: string | null }
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([])
  const [showSaved, setShowSaved] = useState(true)
  const refreshSavedSessions = useCallback(() => {
    fetch(`${API}/presenter/sessions`).then(r => r.json()).then(d => setSavedSessions(d.sessions || [])).catch(() => {})
  }, [])
  useEffect(() => { refreshSavedSessions() }, [refreshSavedSessions])

  const loadSavedSession = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${API}/presenter/session/${id}`)
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setSessionId(id); setSlides(data.slides); setCurrentIndex(0); setShowSaved(false)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : '불러오기 실패')
    }
  }, [])

  const deleteSavedSession = useCallback(async (id: string) => {
    await fetch(`${API}/presenter/session/${id}`, { method: 'DELETE' }).catch(() => {})
    refreshSavedSessions()
  }, [refreshSavedSessions])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [speaking, setSpeaking] = useState(false)
  const [autoPlay, setAutoPlay] = useState(false)
  const [voiceId, setVoiceId] = useState('mine')
  // 자동재생이 브라우저 정책에 막히면, 사용자가 직접 눌러서 재생할 수 있는 버튼을 띄운다.
  const [blockedAudio, setBlockedAudio] = useState<HTMLAudioElement | null>(null)

  const slidesRef = useRef<Slide[]>([])
  const voiceIdRef = useRef('mine')
  const autoPlayRef = useRef(false)
  const ttsSeqRef = useRef(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)
  const recordingRef = useRef(false)
  const stopRecordingRef = useRef<(() => void) | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordingProgress, setRecordingProgress] = useState({ current: 0, total: 0 })
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const [showVideoPreview, setShowVideoPreview] = useState(false)
  const [videoResolution, setVideoResolution] = useState<VideoResolution>('720p')

  useEffect(() => { slidesRef.current = slides }, [slides])
  useEffect(() => { voiceIdRef.current = voiceId }, [voiceId])

  // ── 아바타 GLB 뷰어 (idle 애니메이션만 — 립싱크는 다음 단계) ──
  const loadGLB = useCallback((url: string) => {
    const container = containerRef.current
    if (!container) return
    setAvatarError(''); setAvatarLoaded(false)
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    if (rendererRef.current) { rendererRef.current.dispose(); container.innerHTML = '' }

    const w = container.clientWidth || 400, h = container.clientHeight || 600
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(w, h); renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    container.appendChild(renderer.domElement); rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d1b2a)

    // Avaturn GLB는 glTF PBR 재질이라 환경 반사가 없으면 피부·눈·머리카락이 플라스틱처럼 밋밋해 보임 —
    // RealisticAvatar.tsx와 동일하게 절차적 환경(RoomEnvironment)으로 IBL 반사를 채움
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

    const preset = VIEW_PRESETS[viewModeRef.current]
    const camera = new THREE.PerspectiveCamera(preset.fov, w / h, 0.1, 100)
    camera.position.set(...preset.pos)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(...preset.target); controls.enableDamping = true; controls.update()
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

      // 입싱크(viseme 근사) + 표정용 모프타겟 전체 수집 (RealisticAvatar.tsx와 동일)
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
      blinkKeysRef.current = groups.blink ?? []
      delete groups.blink
      morphGroupsRef.current = groups
      morphValuesRef.current = {}

      setAvatarLoaded(true)
      const animate = () => {
        animFrameRef.current = requestAnimationFrame(animate)
        const dt = clockRef.current.getDelta()
        mixerRef.current?.update(dt)

        // 자동 눈 깜빡임
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
        const groups2 = morphGroupsRef.current
        if (Object.keys(groups2).length > 0) {
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
          const cues = lipCuesRef.current
          const audioEl = activeAudioRef.current
          const emotionCue = cues.length > 0 && audioEl
            ? emotionCuesRef.current.find(cue => audioEl.currentTime >= cue.start && audioEl.currentTime < cue.end)
            : null
          const ew = EMOTION_WEIGHTS[emotionCue?.emotion ?? emotionRef.current] || {}

          // Rhubarb 발음 타이밍 큐가 도착했으면 그걸로 정확한 입모양을, 아직이면 주파수 대역 근사로 폴백
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
          Object.entries(groups2).forEach(([group, keys]) => {
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
    }, undefined, (err) => setAvatarError(String(err)))
  }, [])

  // 마운트 시 실사 아바타 탭과 동일한 키(AVATAR_FILE_KEY)로 "마지막 선택한 GLB"를 그대로 불러옴
  useEffect(() => {
    refreshList()
    const lastName = localStorage.getItem(AVATAR_FILE_KEY)
    idbList().then(list => {
      const entry = (lastName && list.find(e => e.name === lastName)) || list[0]
      if (entry) {
        const blob = new Blob([entry.data], { type: 'model/gltf-binary' })
        const url = URL.createObjectURL(blob)
        objectUrlRef.current = url
        setFileName(entry.name)
        loadGLB(url)
      }
    }).catch(() => {})
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      rendererRef.current?.dispose()
      envTextureRef.current?.dispose()
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.glb')) { setAvatarError('GLB 파일만 지원합니다'); return }
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

  // ── AudioContext unlock (Edge 등은 사용자 제스처 안에서 생성해야 동작) ──
  useEffect(() => {
    const unlock = () => {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume().catch(() => {})
      window.removeEventListener('pointerdown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    return () => window.removeEventListener('pointerdown', unlock)
  }, [])

  // ── 업로드 처리 공통 로직 — 단일 즉시 업로드/큐 처리 양쪽에서 재사용 ──
  // 업로드 → job_id 폴링 → 완료 시 {session_id, slides} 반환 (실패하면 throw)
  const processFile = useCallback(async (
    file: File,
    onProgress?: (current: number, total: number) => void
  ): Promise<{ session_id: string; slides: Slide[] }> => {
    const name = file.name.toLowerCase()
    if (!name.endsWith('.pptx') && !name.endsWith('.ppt') && !name.endsWith('.pdf')) {
      throw new Error('.pptx 또는 .pdf 파일만 지원합니다')
    }
    const form = new FormData(); form.append('file', file)
    const res = await fetch(`${API}/presenter/upload`, { method: 'POST', body: form })
    const data = await res.json()
    if (data.error) throw new Error(data.error)
    const jobId = data.job_id

    // 슬라이드당 LLM 순차 호출이라 시간이 걸림 — job_id를 폴링해 진행률을 보여준다
    for (;;) {
      await new Promise(r => setTimeout(r, 1200))
      const jres = await fetch(`${API}/presenter/job/${jobId}`)
      const job = await jres.json()
      if (job.error && job.stage !== 'error') throw new Error(job.error)
      onProgress?.(job.current || 0, job.total || 0)
      if (job.stage === 'done') return { session_id: job.session_id, slides: job.slides }
      if (job.stage === 'error') throw new Error(job.error || '처리 실패')
    }
  }, [])

  // ── 단일 업로드(즉시 열기) ──
  const handleUpload = useCallback(async (file: File) => {
    setUploading(true); setUploadError(''); setSlides([]); setSessionId(''); setCurrentIndex(0)
    setUploadProgress({ current: 0, total: 0 })
    try {
      const { session_id, slides } = await processFile(file, (current, total) => setUploadProgress({ current, total }))
      setSessionId(session_id); setSlides(slides)
      refreshSavedSessions()
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : '업로드 실패')
    } finally {
      setUploading(false)
    }
  }, [processFile, refreshSavedSessions])

  // ── 여러 파일 일괄 업로드(큐) — 백그라운드에서 순차 처리, 결과는 "저장된 발표" 목록에서 확인 ──
  interface QueueItem { id: string; name: string; status: 'queued' | 'processing' | 'done' | 'error'; current: number; total: number; error?: string }
  const [uploadQueue, setUploadQueue] = useState<QueueItem[]>([])
  const uploadQueueRef = useRef<QueueItem[]>([])
  useEffect(() => { uploadQueueRef.current = uploadQueue }, [uploadQueue])
  const fileMapRef = useRef<Map<string, File>>(new Map())
  const queueRunningRef = useRef(false)

  const runQueue = useCallback(async () => {
    if (queueRunningRef.current) return
    queueRunningRef.current = true
    for (;;) {
      const next = uploadQueueRef.current.find(q => q.status === 'queued')
      if (!next) break
      setUploadQueue(prev => prev.map(q => q.id === next.id ? { ...q, status: 'processing' } : q))
      const file = fileMapRef.current.get(next.id)
      try {
        if (!file) throw new Error('파일을 찾을 수 없습니다')
        await processFile(file, (current, total) => {
          setUploadQueue(prev => prev.map(q => q.id === next.id ? { ...q, current, total } : q))
        })
        setUploadQueue(prev => prev.map(q => q.id === next.id ? { ...q, status: 'done' } : q))
        refreshSavedSessions()
      } catch (e) {
        setUploadQueue(prev => prev.map(q => q.id === next.id ? { ...q, status: 'error', error: e instanceof Error ? e.message : '처리 실패' } : q))
      }
      fileMapRef.current.delete(next.id)
    }
    queueRunningRef.current = false
  }, [processFile, refreshSavedSessions])

  const enqueueFiles = useCallback((files: File[]) => {
    const items: QueueItem[] = files.map(f => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      fileMapRef.current.set(id, f)
      return { id, name: f.name, status: 'queued' as const, current: 0, total: 0 }
    })
    setUploadQueue(prev => [...prev, ...items])
    runQueue()
  }, [runQueue])

  const dismissQueueItem = useCallback((id: string) => {
    setUploadQueue(prev => prev.filter(q => q.id !== id))
    fileMapRef.current.delete(id)
  }, [])

  // 파일 선택/드롭 — 1개면 즉시 열기(기존 동작), 2개 이상이면 백그라운드 큐로 처리
  const handleFiles = useCallback((files: File[]) => {
    if (files.length === 0) return
    if (files.length === 1) { handleUpload(files[0]); return }
    enqueueFiles(files)
  }, [handleUpload, enqueueFiles])

  // ── 발표(TTS 순차 재생) ──
  const stopSpeaking = useCallback(() => {
    stopRecordingRef.current?.()
    stopRecordingRef.current = null
    autoPlayRef.current = false; setAutoPlay(false)
    ttsSeqRef.current += 1
    if (currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null }
    lipsyncAnalyserRef.current = null; activeAudioRef.current = null; lipCuesRef.current = []; emotionCuesRef.current = []
    emotionRef.current = 'neutral'
    setBlockedAudio(null)
    setSpeaking(false)
  }, [])

  const stripParentheticalText = (text: string): string => {
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
    return result.replace(/^\s*[·•\-–—*]+\s*/g, ' ').replace(/\s+/g, ' ').trim()
  }

  const speakSlide = useCallback(async (idx: number) => {
    const slide = slidesRef.current[idx]
    if (!slide) return
    ttsSeqRef.current += 1
    const seq = ttsSeqRef.current
    const stale = () => seq !== ttsSeqRef.current
    if (currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null }
    setCurrentIndex(idx); setSpeaking(true)
    emotionRef.current = classifyEmotion(slide.script)

    // 대본 전체를 한 번에 XTTS로 보내면 합성이 30초+ 걸려 "소리가 안 난다"처럼 느껴진다.
    // 문장 단위로 잘라 순차 합성·재생하면 첫 문장이 ~3초 안에 나오고 내용도 잘리지 않는다.
    const chunks = splitScriptForTTS(stripParentheticalText(slide.script))

    const goNextSlide = () => {
      emotionRef.current = 'neutral'
      if (stale()) return
      setSpeaking(false)
      const next = idx + 1
      if (autoPlayRef.current && next < slidesRef.current.length) speakSlide(next)
      else { autoPlayRef.current = false; setAutoPlay(false) }
    }

    if (chunks.length === 0) { goNextSlide(); return }

    const playChunk = async (ci: number) => {
      if (stale()) return
      try {
        const form = new FormData()
        form.append('text', chunks[ci]); form.append('voice', voiceIdRef.current)
        const res = await fetch(`${API}/avatar/tts_only`, { method: 'POST', body: form })
        if (!res.ok) throw new Error('tts failed')
        const blob = await res.blob()
        if (stale()) return
        const url = URL.createObjectURL(blob)
        const audio = new Audio(url)
        currentAudioRef.current = audio
        if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
        const ctx = audioCtxRef.current
        if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /**/ } }
        if (stale()) { URL.revokeObjectURL(url); return }
        activeAudioRef.current = audio
        lipCuesRef.current = []
        emotionCuesRef.current = []
        audio.onloadedmetadata = () => {
          if (!stale() || activeAudioRef.current !== audio) return
          emotionCuesRef.current = buildEmotionCues(chunks[ci], audio.duration)
        }
        // AudioContext가 running일 때만 립싱크 분석 그래프에 태운다. suspended 상태에서
        // createMediaElementSource로 연결하면 오디오가 그 그래프로만 나가는데, 컨텍스트가
        // 안 깨어 있으면 소리가 전혀 안 들리는 채로 재생된다 — 그럴 땐 립싱크 없이 원본
        // 경로로 재생(소리가 나는 것을 항상 우선). 실사 아바타와 동일한 처리.
        if (ctx.state === 'running') {
          const src = ctx.createMediaElementSource(audio)
          const analyser = ctx.createAnalyser(); analyser.fftSize = 64
          src.connect(analyser); analyser.connect(ctx.destination)
          lipsyncAnalyserRef.current = analyser
        } else {
          lipsyncAnalyserRef.current = null
        }
        const cuesForm = new FormData(); cuesForm.append('audio', blob, 'tts.wav'); cuesForm.append('text', chunks[ci])
        fetch(`${API}/avatar/lipsync_cues`, { method: 'POST', body: cuesForm })
          .then(r => r.json())
          .then(data => { if (!stale() && activeAudioRef.current === audio && Array.isArray(data?.cues)) lipCuesRef.current = data.cues })
          .catch(() => {})
        const advance = () => {
          URL.revokeObjectURL(url)
          lipsyncAnalyserRef.current = null
          activeAudioRef.current = null; lipCuesRef.current = []; emotionCuesRef.current = []
          if (stale()) return
          const nextChunk = ci + 1
          if (nextChunk < chunks.length) playChunk(nextChunk)  // 같은 슬라이드의 다음 문장
          else goNextSlide()                                   // 슬라이드 전체 문장 완료 → 다음 슬라이드
        }
        audio.onended = advance; audio.onerror = advance
        setBlockedAudio(null)
        audio.play().catch(() => {
          // 자동재생 차단 — 넘기지 않고, 사용자가 눌러서 재생할 수 있게 남겨둔다.
          // (사용자의 실제 클릭 안에서 호출하는 play()는 브라우저가 절대 막지 않는다)
          if (stale()) { advance(); return }
          setBlockedAudio(audio)
        })
      } catch {
        if (stale()) return
        // 이 문장 합성 실패 → 전체 중단보다 다음 문장으로 넘어가 본다
        const nextChunk = ci + 1
        if (nextChunk < chunks.length) playChunk(nextChunk)
        else goNextSlide()
      }
    }
    playChunk(0)
  }, [])

  const recordPresentation = useCallback(async () => {
    const avatarCanvas = rendererRef.current?.domElement
    const presentationSlides = slidesRef.current
    if (!avatarCanvas || presentationSlides.length === 0) {
      setUploadError('Load an avatar and presentation before recording.')
      return
    }
    if (!('MediaRecorder' in window)) {
      setUploadError('This browser does not support video recording.')
      return
    }

    // The capture canvas keeps the slide and avatar in one video track.
    const captureCanvas = document.createElement('canvas')
    const resolution = VIDEO_RESOLUTIONS[videoResolution]
    captureCanvas.width = resolution.width
    captureCanvas.height = resolution.height
    const captureCtx = captureCanvas.getContext('2d')
    if (!captureCtx) return

    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
    const audioCtx = audioCtxRef.current
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    const recordingDestination = audioCtx.createMediaStreamDestination()
    const stream = captureCanvas.captureStream(30)
    recordingDestination.stream.getAudioTracks().forEach(track => stream.addTrack(track))
    const mimeType = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find(type => MediaRecorder.isTypeSupported(type))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    const videoChunks: Blob[] = []
    const imageUrls: string[] = []
    let animationFrame = 0
    let activeSlideImage: HTMLImageElement | null = null
    let activeSlideNumber = 1
    let finished = false
    let shouldDownload = true
    let resolveStopped: () => void = () => {}
    const stopped = new Promise<void>(resolve => { resolveStopped = resolve })

    const stopRecording = (download: boolean) => {
      if (finished) return
      finished = true
      shouldDownload = download
      recordingRef.current = false
      cancelAnimationFrame(animationFrame)
      if (currentAudioRef.current) currentAudioRef.current.pause()
      if (recorder.state !== 'inactive') recorder.stop()
    }

    recorder.ondataavailable = event => {
      if (event.data.size > 0) videoChunks.push(event.data)
    }
    recorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop())
      imageUrls.forEach(url => URL.revokeObjectURL(url))
      stopRecordingRef.current = null
      setRecording(false)
      setRecordingProgress({ current: 0, total: 0 })
      lipsyncAnalyserRef.current = null
      activeAudioRef.current = null
      lipCuesRef.current = []
      emotionCuesRef.current = []
      emotionRef.current = 'neutral'
      if (shouldDownload && videoChunks.length > 0) {
        const video = new Blob(videoChunks, { type: mimeType || 'video/webm' })
        const url = URL.createObjectURL(video)
        const link = document.createElement('a')
        link.href = url
        link.download = `presentation-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      resolveStopped()
    }

    const loadSlideImage = async (slide: Slide) => {
      if (!slide.image || !sessionId) return null
      try {
        const response = await fetch(`${API}/presenter/slide_image/${sessionId}/${slide.image}`)
        if (!response.ok) return null
        const url = URL.createObjectURL(await response.blob())
        imageUrls.push(url)
        return await new Promise<HTMLImageElement | null>(resolve => {
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => resolve(null)
          image.src = url
        })
      } catch {
        return null
      }
    }

    const drawFrame = () => {
      captureCtx.setTransform(captureCanvas.width / 1280, 0, 0, captureCanvas.height / 720, 0, 0)
      const width = 1280
      const height = 720
      captureCtx.fillStyle = '#020617'
      captureCtx.fillRect(0, 0, width, height)
      captureCtx.fillStyle = '#111827'
      captureCtx.fillRect(24, 24, 1232, 672)
      if (activeSlideImage) {
        const scale = Math.min(1200 / activeSlideImage.width, 630 / activeSlideImage.height)
        const imageWidth = activeSlideImage.width * scale
        const imageHeight = activeSlideImage.height * scale
        captureCtx.drawImage(activeSlideImage, 40 + (1200 - imageWidth) / 2, 45 + (630 - imageHeight) / 2, imageWidth, imageHeight)
      }
      captureCtx.fillStyle = 'rgba(15, 23, 42, 0.85)'
      captureCtx.fillRect(1044, 390, 196, 290)
      captureCtx.drawImage(avatarCanvas, 1052, 398, 180, 274)
      captureCtx.fillStyle = 'rgba(15, 23, 42, 0.85)'
      captureCtx.fillRect(24, 24, 250, 36)
      captureCtx.fillStyle = '#e5e7eb'
      captureCtx.font = '16px sans-serif'
      captureCtx.fillText(`Slide ${activeSlideNumber} / ${presentationSlides.length}`, 40, 48)
      animationFrame = requestAnimationFrame(drawFrame)
    }

    const playRecordedChunk = async (text: string) => {
      const form = new FormData()
      form.append('text', text)
      form.append('voice', voiceIdRef.current)
      const response = await fetch(`${API}/avatar/tts_only`, { method: 'POST', body: form })
      if (!response.ok) throw new Error('TTS generation failed')
      const blob = await response.blob()
      if (!recordingRef.current) return
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      currentAudioRef.current = audio
      activeAudioRef.current = audio
      lipCuesRef.current = []
      emotionCuesRef.current = []
      audio.onloadedmetadata = () => {
        if (recordingRef.current && activeAudioRef.current === audio) {
          emotionCuesRef.current = buildEmotionCues(text, audio.duration)
        }
      }
      const source = audioCtx.createMediaElementSource(audio)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 64
      source.connect(analyser)
      analyser.connect(audioCtx.destination)
      source.connect(recordingDestination)
      lipsyncAnalyserRef.current = analyser
      const cuesForm = new FormData()
      cuesForm.append('audio', blob, 'tts.wav')
      cuesForm.append('text', text)
      fetch(`${API}/avatar/lipsync_cues`, { method: 'POST', body: cuesForm })
        .then(response => response.json())
        .then(data => { if (recordingRef.current && activeAudioRef.current === audio && Array.isArray(data?.cues)) lipCuesRef.current = data.cues })
        .catch(() => {})
      await new Promise<void>(resolve => {
        const finish = () => {
          URL.revokeObjectURL(url)
          source.disconnect()
          lipsyncAnalyserRef.current = null
          if (activeAudioRef.current === audio) activeAudioRef.current = null
          lipCuesRef.current = []; emotionCuesRef.current = []
          resolve()
        }
        audio.onended = finish
        audio.onerror = finish
        audio.play().catch(finish)
      })
    }

    try {
      setUploadError('')
      setRecording(true)
      setRecordingProgress({ current: 0, total: presentationSlides.length })
      recordingRef.current = true
      stopRecordingRef.current = () => stopRecording(false)
      recorder.start(1000)
      drawFrame()

      for (let index = 0; index < presentationSlides.length && recordingRef.current; index += 1) {
        const slide = presentationSlides[index]
        setCurrentIndex(index)
        activeSlideNumber = index + 1
        setRecordingProgress({ current: index + 1, total: presentationSlides.length })
        activeSlideImage = await loadSlideImage(slide)
        emotionRef.current = classifyEmotion(slide.script)
        const chunks = splitScriptForTTS(stripParentheticalText(slide.script))
        for (const chunk of chunks) {
          if (!recordingRef.current) break
          try {
            await playRecordedChunk(chunk)
          } catch {
            // Continue with the remaining script when a single TTS request fails.
          }
        }
        await new Promise(resolve => window.setTimeout(resolve, 350))
      }
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Video recording failed.')
    } finally {
      stopRecording(true)
      await stopped
    }
  }, [sessionId, videoResolution])

  const handlePlay = useCallback(() => {
    autoPlayRef.current = true; setAutoPlay(true)
    speakSlide(currentIndex)
  }, [currentIndex, speakSlide])

  const goTo = useCallback((idx: number) => {
    if (idx < 0 || idx >= slidesRef.current.length) return
    const wasPlaying = autoPlayRef.current
    ttsSeqRef.current += 1
    if (currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null }
    lipsyncAnalyserRef.current = null; emotionRef.current = 'neutral'
    setBlockedAudio(null)
    setSpeaking(false); setCurrentIndex(idx)
    if (wasPlaying) speakSlide(idx)
  }, [speakSlide])

  const editScript = useCallback((idx: number, text: string) => {
    setSlides(prev => {
      const next = prev.map(s => s.index === idx + 1 ? { ...s, script: text } : s)
      slidesRef.current = next
      return next
    })
  }, [])

  // 직접 수정한 대본을 저장 파일(slides.json)에 반영 — 텍스트박스 포커스 아웃 시 호출
  const saveScriptsToServer = useCallback(() => {
    if (!sessionId) return
    fetch(`${API}/presenter/session/${sessionId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slides: slidesRef.current }),
    }).catch(() => {})
  }, [sessionId])

  const [regenerating, setRegenerating] = useState(false)
  const regenerateScript = useCallback(async (idx: number) => {
    const slide = slidesRef.current[idx]
    if (!slide || !sessionId) return
    setRegenerating(true)
    try {
      const prevScript = idx > 0 ? slidesRef.current[idx - 1].script : ''
      const form = new FormData(); form.append('prev_script', prevScript)
      const res = await fetch(`${API}/presenter/regenerate/${sessionId}/${slide.index}`, { method: 'POST', body: form })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      editScript(idx, data.script)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : '대본 재생성 실패')
    } finally {
      setRegenerating(false)
    }
  }, [sessionId, editScript])

  const current = slides[currentIndex]
  const previewSlide = slides[0]
  const scriptCharacters = slides.reduce((total, slide) => total + slide.script.trim().length, 0)
  const ttsChunkCount = slides.reduce((total, slide) => total + splitScriptForTTS(stripParentheticalText(slide.script)).length, 0)
  const estimatedPresentationSeconds = Math.max(1, Math.ceil(scriptCharacters / 5 + slides.length * 0.35))
  const estimatedTtsSeconds = Math.max(1, ttsChunkCount * 4)
  const selectedVideoResolution = VIDEO_RESOLUTIONS[videoResolution]

  useEffect(() => {
    const canvas = previewCanvasRef.current
    const avatarCanvas = rendererRef.current?.domElement
    if (!showVideoPreview || !canvas || !avatarCanvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let frame = 0
    let imageUrl = ''
    let slideImage: HTMLImageElement | null = null
    const draw = () => {
      ctx.setTransform(canvas.width / 1280, 0, 0, canvas.height / 720, 0, 0)
      ctx.fillStyle = '#020617'
      ctx.fillRect(0, 0, 1280, 720)
      ctx.fillStyle = '#111827'
      ctx.fillRect(24, 24, 1232, 672)
      if (slideImage) {
        const scale = Math.min(1200 / slideImage.width, 630 / slideImage.height)
        const width = slideImage.width * scale
        const height = slideImage.height * scale
        ctx.drawImage(slideImage, 40 + (1200 - width) / 2, 45 + (630 - height) / 2, width, height)
      }
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)'
      ctx.fillRect(1044, 390, 196, 290)
      ctx.drawImage(avatarCanvas, 1052, 398, 180, 274)
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)'
      ctx.fillRect(24, 24, 250, 36)
      ctx.fillStyle = '#e5e7eb'
      ctx.font = '16px sans-serif'
      ctx.fillText(`Slide 1 / ${slides.length}`, 40, 48)
      frame = requestAnimationFrame(draw)
    }
    if (previewSlide?.image && sessionId) {
      fetch(`${API}/presenter/slide_image/${sessionId}/${previewSlide.image}`)
        .then(response => response.blob())
        .then(blob => {
          imageUrl = URL.createObjectURL(blob)
          const image = new Image()
          image.onload = () => { slideImage = image }
          image.src = imageUrl
        })
        .catch(() => {})
    }
    draw()
    return () => {
      cancelAnimationFrame(frame)
      if (imageUrl) URL.revokeObjectURL(imageUrl)
    }
  }, [previewSlide?.image, sessionId, showVideoPreview, slides.length, videoResolution])

  return (
    <div className="flex h-full overflow-hidden bg-gray-950 relative">
      {/* 음성 서버(TTS·STT) 준비/오류 안내 — 정상일 땐 보이지 않음 */}
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] max-w-[92vw] pointer-events-none [&>*]:pointer-events-auto">
        <VoiceServiceBanner />
      </div>
      {/* 일괄 업로드 큐 — 어느 화면(업로드/발표 보기)에 있든 백그라운드 처리 상태를 계속 볼 수 있게 항상 표시.
          완료되면 "저장된 발표" 목록에도 자동으로 나타남 */}
      {uploadQueue.length > 0 && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-30 bg-black/85 backdrop-blur border border-gray-700 rounded-xl overflow-hidden min-w-[260px] max-h-72 overflow-y-auto">
          <div className="text-[10px] text-gray-400 px-3 py-1.5 border-b border-gray-800">📋 일괄 처리 큐</div>
          {uploadQueue.map(q => (
            <div key={q.id} className="flex items-center gap-2 px-3 py-2 border-b border-gray-800/60 last:border-0">
              <span className="text-sm shrink-0">
                {q.status === 'queued' && '⏳'}
                {q.status === 'processing' && '⚙️'}
                {q.status === 'done' && '✅'}
                {q.status === 'error' && '⚠️'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-200 truncate">{q.name}</div>
                <div className="text-[10px] text-gray-500">
                  {q.status === 'queued' && '대기 중'}
                  {q.status === 'processing' && (q.total ? `슬라이드 ${q.current}/${q.total} 생성 중` : '분석 중…')}
                  {q.status === 'done' && '완료 — 저장된 발표 목록에서 확인'}
                  {q.status === 'error' && (q.error || '처리 실패')}
                </div>
              </div>
              {(q.status === 'done' || q.status === 'error') && (
                <button onClick={() => dismissQueueItem(q.id)} className="text-[10px] text-gray-600 hover:text-gray-300 px-1">✕</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 저장된 발표(이미 처리 완료된 자료) 목록 — 업로드/발표 보기 어느 화면이든 항상 표시, 재처리 없이 즉시 불러오기 */}
      {savedSessions.length > 0 && (
        <div className="absolute top-4 left-4 z-30">
          <button
            onClick={() => setShowSaved(v => !v)}
            className="text-xs px-2.5 py-1 rounded-lg bg-gray-800/80 hover:bg-gray-700 border border-gray-700 text-gray-300"
          >
            📁 완성된 자료 {showSaved ? '▲' : '▼'} {savedSessions.length}개
          </button>
          {showSaved && (
            <div className="mt-1 bg-black/85 backdrop-blur border border-gray-700 rounded-xl overflow-hidden min-w-[260px] max-h-72 overflow-y-auto">
              {savedSessions.map(s => (
                <div key={s.session_id}
                  className={`flex items-center gap-2 px-3 py-2 hover:bg-gray-800/80 group border-b border-gray-800/60 last:border-0 ${s.session_id === sessionId ? 'bg-blue-900/30' : ''}`}>
                  <button onClick={() => loadSavedSession(s.session_id)} className="flex-1 text-left">
                    <div className="text-xs text-gray-200 truncate">
                      {s.session_id === sessionId && '▶ '}{s.source_name || s.session_id}
                    </div>
                    <div className="text-[10px] text-gray-500">{s.slide_count}슬라이드 · {s.created_at.replace('T', ' ').slice(0, 16)}</div>
                  </button>
                  <button
                    onClick={() => deleteSavedSession(s.session_id)}
                    className="text-[10px] text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity px-1"
                  >✕</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!sessionId ? (
        <div
          className={`flex-1 relative flex items-center justify-center ${uploadDragging ? 'bg-blue-900/20' : ''}`}
          onDragOver={e => { e.preventDefault(); setUploadDragging(true) }}
          onDragLeave={() => setUploadDragging(false)}
          onDrop={e => {
            e.preventDefault(); setUploadDragging(false)
            handleFiles(Array.from(e.dataTransfer.files))
          }}
        >
          <label className={`flex flex-col items-center gap-3 border-2 border-dashed rounded-2xl px-10 py-12 cursor-pointer text-gray-400 hover:text-gray-200 transition-colors ${uploadDragging ? 'border-blue-500' : 'border-gray-700 hover:border-blue-600'}`}>
            <span className="text-3xl">{uploading ? '⏳' : '📊'}</span>
            <span className="text-sm">
              {uploading
                ? (uploadProgress.total
                    ? `슬라이드 ${uploadProgress.current}/${uploadProgress.total} 대본 생성 중…`
                    : '슬라이드 분석 중…')
                : uploadDragging ? '파일을 놓으세요' : 'PPTX 또는 PDF 파일을 선택하거나 드래그하세요 (여러 개 선택 시 백그라운드 일괄 처리)'}
            </span>
            {uploading && uploadProgress.total > 0 && (
              <div className="w-48 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div className="h-full bg-blue-600 transition-all" style={{ width: `${(uploadProgress.current / uploadProgress.total) * 100}%` }} />
              </div>
            )}
            {uploading && <span className="text-[11px] text-gray-600">슬라이드 수에 비례해 시간이 걸려요 (로컬 AI 순차 생성)</span>}
            <input type="file" accept=".pptx,.ppt,.pdf" multiple className="hidden" disabled={uploading}
              onChange={e => { handleFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
          </label>
          {uploadError && <p className="absolute bottom-8 text-sm text-red-400">{uploadError}</p>}
        </div>
      ) : (
        /* 슬라이드 영역 */
        <div className="flex-1 flex flex-col p-4 gap-3 overflow-hidden">
          <div className="flex-1 flex items-center justify-center bg-black rounded-xl overflow-hidden">
            {current?.image ? (
              <img
                src={`${API}/presenter/slide_image/${sessionId}/${current.image}`}
                alt={`슬라이드 ${current.index}`}
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              <span className="text-gray-600 text-sm">이미지 없음</span>
            )}
          </div>
          <div className="relative">
            <textarea
              value={current?.script || ''}
              onChange={e => editScript(currentIndex, e.target.value)}
              onBlur={saveScriptsToServer}
              rows={3}
              className="w-full bg-gray-900 text-gray-200 text-sm rounded-xl p-3 pr-20 outline-none border border-gray-800 focus:border-blue-700 resize-none"
              placeholder="발표 대본 (수정 가능)"
            />
            <button
              onClick={() => regenerateScript(currentIndex)}
              disabled={regenerating || !current}
              className="absolute top-2 right-2 text-xs px-2 py-1 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-300"
              title="이 슬라이드 대본을 다시 생성"
            >
              {regenerating ? '⏳ 생성 중…' : '🔄 다시 생성'}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <button onClick={() => goTo(currentIndex - 1)} disabled={currentIndex === 0}
              className="px-3 py-1.5 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200">
              ← 이전
            </button>
            <span className="text-xs text-gray-500">{slides.length ? `${currentIndex + 1} / ${slides.length}` : ''}</span>
            <div className="flex gap-2">
              {!autoPlay ? (
                <button onClick={handlePlay} disabled={recording} className="px-4 py-1.5 text-sm rounded-lg bg-blue-700 hover:bg-blue-600 disabled:opacity-30 text-white">
                  ▶ 발표 시작
                </button>
              ) : (
                <button onClick={stopSpeaking} className="px-4 py-1.5 text-sm rounded-lg bg-red-700 hover:bg-red-600 text-white">
                  ⏸ 정지
                </button>
              )}
              {recording ? (
                <button onClick={stopSpeaking} className="px-3 py-1.5 text-sm rounded-lg bg-red-700 hover:bg-red-600 text-white">
                  {'\uc601\uc0c1 \ucde8\uc18c'} {recordingProgress.current}/{recordingProgress.total}
                </button>
              ) : (
                <button onClick={() => setShowVideoPreview(true)} disabled={!avatarLoaded || !current || autoPlay}
                  className="px-3 py-1.5 text-sm rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-30 text-white">
                  {'\uc601\uc0c1 \uc0dd\uc131'}
                </button>
              )}
              <button onClick={() => goTo(currentIndex + 1)} disabled={currentIndex >= slides.length - 1 || recording}
                className="px-3 py-1.5 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200">
                다음 →
              </button>
            </div>
          </div>
          {blockedAudio && (
            <button
              onClick={() => { blockedAudio.play().then(() => setBlockedAudio(null)).catch(() => {}) }}
              className="w-full py-2 text-sm rounded-lg bg-yellow-900/80 border border-yellow-500 text-yellow-200 hover:bg-yellow-800 transition animate-pulse">
              🔇 자동재생이 차단됐어요 — 눌러서 소리 재생
            </button>
          )}
          <button onClick={() => { stopSpeaking(); setSessionId(''); setSlides([]) }}
            className="text-xs text-gray-500 hover:text-gray-300 self-start">
            ↺ 새 파일 업로드
          </button>
        </div>
      )}

      {/* 아바타 영역 — 업로드 전에도 항상 표시(실사 아바타 탭과 동일 GLB를 그대로 보여줌) */}
      <div className="w-80 flex flex-col border-l border-gray-800 bg-gray-900/95">
        <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">발표 아바타</h2>
          {speaking && <span className="text-xs text-blue-400 animate-pulse">말하는 중</span>}
        </div>
        <div
          className={`flex-1 relative ${dragging ? 'ring-2 ring-blue-500 ring-inset' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
        >
          <div ref={containerRef} className="w-full h-full" />

          {/* 파일 선택 + 저장된 목록 (실사 아바타 탭과 동일) */}
          <div className="absolute top-2 left-2 right-[11.5rem] z-20 flex w-[calc(100%-11.5rem)] max-w-48 flex-col gap-1">
            <div className="flex gap-1">
              <label className="flex items-center gap-1 bg-black/50 backdrop-blur text-[11px] text-gray-300 hover:text-white rounded-lg px-2 py-1 cursor-pointer border border-gray-700 hover:border-gray-500 transition-colors max-w-[10rem] truncate">
                📁 {fileName || 'GLB 선택'}
                <input type="file" accept=".glb" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
              </label>
              {glbList.length > 0 && (
                <button
                  onClick={() => setShowList(v => !v)}
                  className="bg-black/50 backdrop-blur text-[11px] text-gray-300 hover:text-white rounded-lg px-1.5 py-1 border border-gray-700 hover:border-gray-500 transition-colors"
                  title="저장된 아바타 목록"
                >
                  {showList ? '▲' : '▼'} {glbList.length}
                </button>
              )}
            </div>
            {showList && (
              <div className="bg-black/80 backdrop-blur border border-gray-700 rounded-xl overflow-hidden w-full max-w-full min-w-0 max-h-56 overflow-y-auto">
                {glbList.map(entry => (
                  <div key={entry.name} className="flex items-center gap-1 px-2 py-1.5 hover:bg-gray-800/80 group">
                    <button
                      onClick={() => loadFromIDB(entry)}
                      className="flex-1 text-left text-[11px] text-gray-300 hover:text-white truncate"
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

          {/* 보기 토글 (우상단) */}
          <div className="absolute top-2 right-2 z-20 grid w-40 grid-cols-2 gap-1 bg-black/50 backdrop-blur rounded-lg p-1">
            <span className="text-[10px] text-gray-400 px-1">보기</span>
            <div className="contents">
              {(['face', 'upper', 'full'] as ViewMode[]).map(m => (
                <button key={m} onClick={() => setView(m)}
                  className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${viewMode === m ? 'bg-purple-600 border-purple-400 text-white' : 'bg-gray-800/70 border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
                  {VIEW_MODE_LABELS[m]}
                </button>
              ))}
            </div>
          </div>

          {!avatarLoaded && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-600 text-xs px-4 text-center pointer-events-none">
              GLB 파일을 드래그하거나 좌상단에서 선택하세요
            </div>
          )}
          {dragging && <div className="absolute inset-0 flex items-center justify-center bg-blue-900/30 text-blue-300 text-sm font-semibold pointer-events-none">GLB 파일을 놓으세요</div>}
          {avatarError && <div className="absolute bottom-2 left-2 right-2 text-xs text-red-400 bg-red-900/60 rounded p-1">{avatarError}</div>}
        </div>
        <div className="p-3 border-t border-gray-800">
          <span className="text-[10px] text-gray-400 px-1">목소리</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {VOICE_OPTIONS.map(v => (
              <button key={v.id} onClick={() => setVoiceId(v.id)}
                className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${voiceId === v.id ? 'bg-purple-600 border-purple-400 text-white' : 'bg-gray-800/70 border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {showVideoPreview && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 p-6">
          <div className="w-full max-w-5xl rounded-2xl border border-gray-700 bg-gray-900 p-5 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-white">{'\uc800\uc7a5 \ubbf8\ub9ac\ubcf4\uae30'}</h3>
                <p className="mt-1 text-xs text-gray-400">{'\uc2dc\uc791 \uc2dc \uc544\ub798 \uad6c\ub3c4\ub85c \uc2ac\ub77c\uc774\ub4dc\uc640 \uc544\ubc14\ud0c0\uac00 \ud568\uaed8 \uc800\uc7a5\ub429\ub2c8\ub2e4.'}</p>
              </div>
              <button onClick={() => setShowVideoPreview(false)} className="rounded-lg px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800">{'\ub2eb\uae30'}</button>
            </div>
            <canvas ref={previewCanvasRef} width={selectedVideoResolution.width} height={selectedVideoResolution.height} className="w-full rounded-xl bg-slate-950" />
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-5 text-sm">
                <span className="text-gray-300">{'TTS \uc900\ube44 \uc608\uc0c1: '}<strong className="text-white">~ {formatDuration(estimatedTtsSeconds)}</strong></span>
                <span className="text-gray-300">{'\ubc1c\ud45c \uc601\uc0c1 \uae38\uc774: '}<strong className="text-white">~ {formatDuration(estimatedPresentationSeconds)}</strong></span>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                {'\ud574\uc0c1\ub3c4'}
                <select value={videoResolution} onChange={event => setVideoResolution(event.target.value as VideoResolution)} className="rounded-md border border-gray-700 bg-gray-800 px-2 py-1 text-white outline-none">
                  {Object.entries(VIDEO_RESOLUTIONS).map(([id, option]) => <option key={id} value={id}>{option.label}</option>)}
                </select>
              </label>
              <button
                onClick={() => { setShowVideoPreview(false); recordPresentation() }}
                className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600"
              >
                {'\uc601\uc0c1 \uc0dd\uc131 \uc2dc\uc791'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
