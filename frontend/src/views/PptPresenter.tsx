/**
 * PptPresenter — PPTX/PDF 업로드 → 슬라이드별 발표 대본(LLM) 생성 → 3D 아바타가 순차 발표(TTS+립싱크)
 *
 * 립싱크/표정은 RealisticAvatar.tsx와 동일한 모프타겟 파이프라인(주파수 대역 기반 viseme 근사 + 감정별 가중치).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const API = 'http://127.0.0.1:8766'
const IDB_NAME = 'mental-avatar-glb'
const IDB_STORE = 'glb-files'
// RealisticAvatar.tsx와 동일한 키 — 거기서 선택/등록한 GLB를 그대로 공유해서 보여준다
const AVATAR_FILE_KEY = 'mental-avatar-avaturn-filename'

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
type Emotion = 'neutral' | 'happy' | 'sorry' | 'surprised'

// 입싱크(viseme 근사) + 표정용 모프타겟 그룹 — Avaturn/ARKit/Oculus 명명 모두 대응 (RealisticAvatar.tsx와 동일)
const MORPH_GROUPS: Record<string, RegExp[]> = {
  aa: [/viseme_aa/i, /^mouthopen$/i, /jawopen/i],
  oo: [/viseme_u/i, /viseme_o/i, /mouthpucker/i, /mouthfunnel/i],
  ee: [/viseme_e/i, /viseme_i/i, /mouthstretch/i],
  consonant: [/viseme_pp/i, /viseme_ff/i, /viseme_ss/i, /viseme_dd/i, /viseme_kk/i, /viseme_ch/i, /viseme_th/i, /viseme_rr/i, /viseme_nn/i],
  smile: [/mouthsmile/i],
  frown: [/mouthfrown/i],
  browUp: [/browinnerup/i, /browouterup/i],
  browDown: [/browdown/i],
  squint: [/eyesquint/i],
  blink: [/eyeblink/i],
}

const EMOTION_WEIGHTS: Record<Emotion, Partial<Record<string, number>>> = {
  neutral: { smile: 0.25 },
  happy: { smile: 1, browUp: 0.4 },
  sorry: { frown: 0.7, browDown: 0.5, smile: 0 },
  surprised: { browUp: 1, smile: 0.1 },
}

function classifyEmotion(text: string): Emotion {
  if (/죄송|미안|사과|아쉽|어렵|힘들/.test(text)) return 'sorry'
  if (/축하|좋아요|좋습니다|감사|기쁘|행복|반갑|웃|즐거|최고|!{1,}/.test(text)) return 'happy'
  if (/\?|궁금|놀라|정말요|진짜요|신기/.test(text)) return 'surprised'
  return 'neutral'
}

export default function PptPresenter() {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const mixerRef = useRef<THREE.AnimationMixer | null>(null)
  const clockRef = useRef(new THREE.Clock())
  const animFrameRef = useRef<number>(0)
  const objectUrlRef = useRef<string | null>(null)
  const morphMapRef = useRef<Record<string, MorphRef[]>>({})
  const morphGroupsRef = useRef<Record<string, string[]>>({})
  const morphValuesRef = useRef<Record<string, number>>({})
  const lipsyncAnalyserRef = useRef<AnalyserNode | null>(null)
  const emotionRef = useRef<Emotion>('neutral')
  const blinkKeysRef = useRef<string[]>([])
  const blinkStateRef = useRef<{ phase: 'idle' | 'closing' | 'opening'; elapsed: number; next: number }>({ phase: 'idle', elapsed: 0, next: 2000 + Math.random() * 3000 })
  const [avatarLoaded, setAvatarLoaded] = useState(false)
  const [avatarError, setAvatarError] = useState('')
  const [fileName, setFileName] = useState(() => localStorage.getItem(AVATAR_FILE_KEY) || '')
  const [glbList, setGlbList] = useState<GlbEntry[]>([])
  const [showList, setShowList] = useState(false)
  const [dragging, setDragging] = useState(false)

  const refreshList = useCallback(() => {
    idbList().then(setGlbList).catch(() => {})
  }, [])

  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [slides, setSlides] = useState<Slide[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [speaking, setSpeaking] = useState(false)
  const [autoPlay, setAutoPlay] = useState(false)
  const [voiceId, setVoiceId] = useState('mine')

  const slidesRef = useRef<Slide[]>([])
  const voiceIdRef = useRef('mine')
  const autoPlayRef = useRef(false)
  const ttsSeqRef = useRef(0)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const currentAudioRef = useRef<HTMLAudioElement | null>(null)

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
    container.appendChild(renderer.domElement); rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d1b2a)
    scene.add(new THREE.AmbientLight(0xffffff, 1.2))
    const dir = new THREE.DirectionalLight(0xffffff, 2); dir.position.set(1, 3, 2); scene.add(dir)

    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100)
    camera.position.set(0, 1.5, 1.3)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 1.45, 0); controls.enableDamping = true; controls.update()

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
          const ew = EMOTION_WEIGHTS[emotionRef.current] || {}
          const targets: Record<string, number> = {
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

  // ── 업로드 ──
  const handleUpload = useCallback(async (file: File) => {
    const name = file.name.toLowerCase()
    if (!name.endsWith('.pptx') && !name.endsWith('.ppt') && !name.endsWith('.pdf')) {
      setUploadError('.pptx 또는 .pdf 파일만 지원합니다'); return
    }
    setUploading(true); setUploadError(''); setSlides([]); setSessionId(''); setCurrentIndex(0)
    try {
      const form = new FormData(); form.append('file', file)
      const res = await fetch(`${API}/presenter/upload`, { method: 'POST', body: form })
      const data = await res.json()
      if (data.error) throw new Error(data.error)
      setSessionId(data.session_id)
      setSlides(data.slides)
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : '업로드 실패')
    } finally {
      setUploading(false)
    }
  }, [])

  // ── 발표(TTS 순차 재생) ──
  const stopSpeaking = useCallback(() => {
    autoPlayRef.current = false; setAutoPlay(false)
    ttsSeqRef.current += 1
    if (currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null }
    lipsyncAnalyserRef.current = null; emotionRef.current = 'neutral'
    setSpeaking(false)
  }, [])

  const speakSlide = useCallback(async (idx: number) => {
    const slide = slidesRef.current[idx]
    if (!slide) return
    ttsSeqRef.current += 1
    const seq = ttsSeqRef.current
    const stale = () => seq !== ttsSeqRef.current
    if (currentAudioRef.current) { currentAudioRef.current.pause(); currentAudioRef.current = null }
    setCurrentIndex(idx); setSpeaking(true)
    emotionRef.current = classifyEmotion(slide.script)
    try {
      const form = new FormData()
      form.append('text', slide.script); form.append('voice', voiceIdRef.current)
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
      const src = ctx.createMediaElementSource(audio)
      const analyser = ctx.createAnalyser(); analyser.fftSize = 64
      src.connect(analyser); analyser.connect(ctx.destination)
      lipsyncAnalyserRef.current = analyser
      const cleanup = () => {
        URL.revokeObjectURL(url)
        lipsyncAnalyserRef.current = null
        emotionRef.current = 'neutral'
        if (stale()) return
        setSpeaking(false)
        const next = idx + 1
        if (autoPlayRef.current && next < slidesRef.current.length) {
          speakSlide(next)
        } else {
          autoPlayRef.current = false; setAutoPlay(false)
        }
      }
      audio.onended = cleanup; audio.onerror = cleanup
      audio.play().catch(cleanup)
    } catch {
      lipsyncAnalyserRef.current = null; emotionRef.current = 'neutral'
      if (!stale()) { setSpeaking(false); autoPlayRef.current = false; setAutoPlay(false) }
    }
  }, [])

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
    setSpeaking(false); setCurrentIndex(idx)
    if (wasPlaying) speakSlide(idx)
  }, [speakSlide])

  const editScript = useCallback((idx: number, text: string) => {
    setSlides(prev => prev.map(s => s.index === idx + 1 ? { ...s, script: text } : s))
  }, [])

  const current = slides[currentIndex]

  return (
    <div className="flex h-full overflow-hidden bg-gray-950">
      {!sessionId ? (
        <div className="flex-1 relative flex items-center justify-center">
          <label className="flex flex-col items-center gap-3 border-2 border-dashed border-gray-700 hover:border-blue-600 rounded-2xl px-10 py-12 cursor-pointer text-gray-400 hover:text-gray-200 transition-colors">
            <span className="text-3xl">📊</span>
            <span className="text-sm">{uploading ? '슬라이드 분석 + 대본 생성 중…' : 'PPTX 또는 PDF 파일을 선택하세요'}</span>
            <input type="file" accept=".pptx,.ppt,.pdf" className="hidden" disabled={uploading}
              onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f) }} />
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
          <textarea
            value={current?.script || ''}
            onChange={e => editScript(currentIndex, e.target.value)}
            rows={3}
            className="bg-gray-900 text-gray-200 text-sm rounded-xl p-3 outline-none border border-gray-800 focus:border-blue-700 resize-none"
            placeholder="발표 대본 (수정 가능)"
          />
          <div className="flex items-center justify-between">
            <button onClick={() => goTo(currentIndex - 1)} disabled={currentIndex === 0}
              className="px-3 py-1.5 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200">
              ← 이전
            </button>
            <span className="text-xs text-gray-500">{slides.length ? `${currentIndex + 1} / ${slides.length}` : ''}</span>
            <div className="flex gap-2">
              {!autoPlay ? (
                <button onClick={handlePlay} className="px-4 py-1.5 text-sm rounded-lg bg-blue-700 hover:bg-blue-600 text-white">
                  ▶ 발표 시작
                </button>
              ) : (
                <button onClick={stopSpeaking} className="px-4 py-1.5 text-sm rounded-lg bg-red-700 hover:bg-red-600 text-white">
                  ⏸ 정지
                </button>
              )}
              <button onClick={() => goTo(currentIndex + 1)} disabled={currentIndex >= slides.length - 1}
                className="px-3 py-1.5 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-30 text-gray-200">
                다음 →
              </button>
            </div>
          </div>
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
          <div className="absolute top-2 left-2 z-20 flex flex-col gap-1">
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
              <div className="bg-black/80 backdrop-blur border border-gray-700 rounded-xl overflow-hidden min-w-[200px] max-h-56 overflow-y-auto">
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
    </div>
  )
}
