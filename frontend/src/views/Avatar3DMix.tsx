/**
 * 3D Mix — 사진(1~3장)으로 Real3D(MICA)가 추정한 얼굴 형태를 "실사 아바타" 탭이 쓰는
 * Streamoji 리그(모프타겟/스켈레톤 있음)에 이식하는 작업대. 진행 단계를 보여주고,
 * 결과를 현재 "실사 아바타" 탭에 로드된 GLB와 나란히 비교할 수 있게 한다.
 *
 * Real3D(8769)는 mental-avatar와 별개 독립 서버 — 이 탭에서만 직접 호출한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildRegisteredFaceTexture, applyRegisteredFaceTexture, type FaceTextureData } from './RealisticAvatar'

const REAL3D_BASE = 'http://127.0.0.1:8769'

// RealisticAvatar.tsx가 이미 쓰는 텍스처 강도 설정과 같은 localStorage 키 —
// applyRegisteredFaceTexture 내부의 withFaceTexture가 매 호출마다 이 키들을 직접
// 읽으므로, 여기서 값만 써주면 "실사 아바타" 탭의 슬라이더와 동일하게 작동한다.
const UV_WARP_WEIGHT_KEY = 'mental-avatar-uv-warp-weight'
const FACE_TEXTURE_EXACTNESS_KEY = 'mental-avatar-face-texture-exactness'
const FACE_TEXTURE_BRIGHTNESS_KEY = 'mental-avatar-face-texture-brightness'
// MICA(사진 투영) 텍스처 가중치 — RealisticAvatar 쪽 슬라이더와는 별개 신규 키(공유 안 함,
// 이 값은 "3D Mix" 결과 패널 전용 기능).
const MICA_COLOR_WEIGHT_KEY = 'mental-avatar-mica-color-weight'
// MICA 텍스처 자체의 "사진 반영 강도"(대비) — 평균색 기준으로 편차를 얼마나 증폭할지.
const MICA_INTENSITY_KEY = 'mental-avatar-mica-intensity'
// 3D 형태(shape) 가중치 — 워프된(MICA쪽) 위치 vs 워프 전 원본 Streamoji 위치 사이 lerp 비율.
const SHAPE_WEIGHT_KEY = 'mental-avatar-shape-weight'

// Real3D가 사진에서 뽑은 색은 사진 픽셀값 그대로(sRGB, 감마 인코딩)인데, Three.js의 PBR
// 셰이더에 정점색/커스텀 attribute로 그냥 넣으면 "이미 리니어"라고 가정해버린다 — sRGB 곡선은
// 어두운/중간톤을 끌어올리는데(특히 낮은 채널일수록 더 많이 끌어올림) 그걸 리니어로 오인하면
// 채널간 상대적 차이가 줄어들어(R/G/B가 서로 가까워짐) 실제보다 훨씬 탁하고 회색스럽게 보인다
// ("사진보다 너무 회색스럽게 나와" 지적의 원인) — 반드시 여기서 sRGB→리니어 변환 후 넘겨야 한다.
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

// MICA 색의 "사진 반영 강도"를 사용자가 조절할 수 있게 평균색 기준으로 편차를 증폭/축소한다.
// intensity=1이면 원본 그대로, 낮추면 평균색(무채색에 가까움)에 가까워지고 높이면 명암·디테일이
// 더 강하게 나온다 — MICA 자체 텍스처가 사진 대비 흐릿하게 나온다는 지적에 대한 조절 기능.
function contrastBoost(src: Float32Array, intensity: number): Float32Array {
  const n = src.length / 3
  let mr = 0, mg = 0, mb = 0
  for (let i = 0; i < n; i += 1) { mr += src[i * 3]; mg += src[i * 3 + 1]; mb += src[i * 3 + 2] }
  mr /= n; mg /= n; mb /= n
  const out = new Float32Array(src.length)
  for (let i = 0; i < n; i += 1) {
    out[i * 3] = Math.min(1, Math.max(0, mr + (src[i * 3] - mr) * intensity))
    out[i * 3 + 1] = Math.min(1, Math.max(0, mg + (src[i * 3 + 1] - mg) * intensity))
    out[i * 3 + 2] = Math.min(1, Math.max(0, mb + (src[i * 3 + 2] - mb) * intensity))
  }
  return out
}

// RealisticAvatar.tsx와 같은 IndexedDB(같은 DB/스토어 이름)를 읽어 "지금 실사 아바타
// 탭에 로드된 GLB"를 그대로 가져온다 — 저장 포맷을 공유하는 게 목적이라 의도적으로
// 그대로 복제(안정화된 RealisticAvatar.tsx 쪽 코드는 건드리지 않음, 세션17부터의
// 이 프로젝트 관례).
const IDB_NAME = 'mental-avatar-glb'
const IDB_STORE = 'glb-files'
const AVATAR_FILE_KEY = 'mental-avatar-avaturn-filename'

interface GlbEntry { name: string; size: number; data: ArrayBuffer; loadedAt: number }

function openIDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE, { keyPath: 'name' }) }
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

// 정면/좌/우 입력 사진을 매번 다시 선택하지 않도록 별도 IndexedDB에 슬롯별로 저장해둔다
// (localStorage는 사진 3장 base64로는 용량이 부담스러워, GLB와 같은 IndexedDB 패턴 재사용).
type PhotoSlot = 'front' | 'left' | 'right'
// 공개 인물 사진을 수집·조합하는 용도로 쓰지 않는다. 이 작업대는 동의 받은 개인 또는
// 실존 인물을 닮지 않은 가상 캐릭터의 입력만 다룬다.
type PersonaId = 'private-consented' | 'fictional-ai'
const PHOTO_IDB_NAME = 'mental-avatar-mix-photos'
const PHOTO_IDB_STORE = 'persona-photos'
interface PhotoEntry { id: string; person: PersonaId; slot: PhotoSlot; name: string; type: string; data: ArrayBuffer; savedAt: number }
const PERSONAS: { id: PersonaId; name: string; face: string; voice: string; confirmation: string }[] = [
  { id: 'private-consented', name: '개인 아바타 (동의 확인)', face: '본인 또는 당사자가 직접 제공하고 사용에 동의한 사진만', voice: '당사자가 명시적으로 허락한 음성만', confirmation: '이 사진·음성의 당사자이며, 아바타 생성과 저장에 필요한 명시적 동의를 받았습니다.' },
  { id: 'fictional-ai', name: '가상 AI 캐릭터', face: '실존 인물을 식별하거나 닮게 만들지 않은 창작 이미지', voice: '특정 실존 인물을 모방하지 않는 가상 음성', confirmation: '이 입력은 특정 실존 인물의 사진·음성·초상을 사용하거나 모방하지 않습니다.' },
]

function openPhotoIDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(PHOTO_IDB_NAME, 2)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(PHOTO_IDB_STORE)) req.result.createObjectStore(PHOTO_IDB_STORE, { keyPath: 'id' }) }
    req.onsuccess = () => res(req.result)
    req.onerror = () => rej(req.error)
  })
}
async function photoList(person: PersonaId): Promise<PhotoEntry[]> {
  const db = await openPhotoIDB()
  return new Promise((res, rej) => {
    const tx = db.transaction(PHOTO_IDB_STORE, 'readonly')
    const req = tx.objectStore(PHOTO_IDB_STORE).getAll()
    req.onsuccess = () => res((req.result as PhotoEntry[]).filter(item => item.person === person))
    req.onerror = () => rej(req.error)
  })
}
async function photoSave(entry: PhotoEntry) {
  const db = await openPhotoIDB()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(PHOTO_IDB_STORE, 'readwrite')
    tx.objectStore(PHOTO_IDB_STORE).put(entry)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}
async function photoDelete(person: PersonaId, slot: PhotoSlot) {
  const db = await openPhotoIDB()
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(PHOTO_IDB_STORE, 'readwrite')
    tx.objectStore(PHOTO_IDB_STORE).delete(`${person}:${slot}`)
    tx.oncomplete = () => res()
    tx.onerror = () => rej(tx.error)
  })
}

type StageKey = 'upload' | 'mica' | 'align' | 'warp' | 'save' | 'done'
const STAGES: { key: StageKey; label: string }[] = [
  { key: 'upload', label: '① 사진 업로드' },
  { key: 'mica', label: '② MICA 형태 추론' },
  { key: 'align', label: '③ 기준점 정렬' },
  { key: 'warp', label: '④ 형태 이식(워프)' },
  { key: 'save', label: '⑤ GLB 저장' },
]

interface RetargetStatus {
  stage: StageKey | string
  progress: number
  status: 'running' | 'done' | 'error'
  message: string
  mesh_url?: string | null
  warnings?: string[]
  landmark_error_mm?: { mean: number; max: number }
  mica_colors?: boolean
  mica_texture?: boolean
  shape_original?: boolean
}

// ── 작은 GLB 미리보기 뷰어 — 자체 Three.js 씬을 갖고, data가 바뀔 때마다 다시 로드.
// shapeOnly가 켜지면 모든 메시 재질을 무광 회색으로 바꿔 텍스처 없이 형태만 비교한다.
function GlbPreview({ data, label, shapeOnly, applyPhotoTexture, textureVersion, micaColors, micaTextureData, micaColorWeight, micaIntensity, shapeOriginal, shapeWeight }: {
  data: ArrayBuffer | null; label: string; shapeOnly: boolean
  applyPhotoTexture?: boolean; textureVersion?: number
  micaColors?: Float32Array | null; micaTextureData?: ArrayBuffer | null; micaColorWeight?: number; micaIntensity?: number
  shapeOriginal?: Float32Array | null; shapeWeight?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const rootRef = useRef<THREE.Object3D | null>(null)
  const originalMatsRef = useRef<Map<THREE.Mesh, THREE.Material | THREE.Material[]>>(new Map())
  const flatMatRef = useRef(new THREE.MeshStandardMaterial({ color: 0xcfd3d8, roughness: 0.95, metalness: 0 }))
  const generatedTexturesRef = useRef<THREE.Texture[]>([])
  type MicaShaderState = {
    material: THREE.Material
    mode: 'texture' | 'vertex'
    uniform: {
      weight: { value: number }
      map?: { value: THREE.Texture | null }
      avg?: { value: THREE.Vector3 }
      intensity?: { value: number }
    }
  }
  const micaShaderRef = useRef<MicaShaderState | null>(null)
  const micaAttrSourceRef = useRef<{ colors: Float32Array | null; intensity: number } | null>(null)
  // UV 텍셀 단위로 서버가 구운 MICA 텍스처(정점색보다 훨씬 촘촘함) — 있으면 이쪽을 우선 쓴다.
  const micaTextureRef = useRef<THREE.Texture | null>(null)
  const micaTextureAvgRef = useRef<[number, number, number]>([0.6, 0.5, 0.45])
  const [micaTexTick, setMicaTexTick] = useState(0)
  const warpedPosRef = useRef<Float32Array | null>(null)
  const warpedPosLoadTickRef = useRef<number>(-1)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const [status, setStatus] = useState('')
  const [loadTick, setLoadTick] = useState(0)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const w = container.clientWidth || 320
    const h = container.clientHeight || 320
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(w, h)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    sceneRef.current = scene
    scene.add(new THREE.AmbientLight(0xffffff, 0.9))
    const dir = new THREE.DirectionalLight(0xffffff, 0.9)
    dir.position.set(0.5, 1, 1)
    scene.add(dir)

    const camera = new THREE.PerspectiveCamera(35, w / h, 0.01, 100)
    camera.position.set(0, 0, 1)
    cameraRef.current = camera
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controlsRef.current = controls

    let raf = 0
    const animate = () => {
      raf = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()
    // 디버깅용 — 이 프리뷰 창은 비활성 탭 취급돼 rAF가 아예 안 돎(기존 gotcha와 동일 부류),
    // 콘솔/자동화에서 강제로 renderer.render()를 호출해 readPixels로 검증할 때 씀.
    ;(container as unknown as { __three?: unknown }).__three = { renderer, scene, camera }

    return () => {
      cancelAnimationFrame(raf)
      renderer.dispose()
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement)
    }
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    if (rootRef.current) {
      scene.remove(rootRef.current)
      rootRef.current = null
      originalMatsRef.current.clear()
    }
    if (!data) { setStatus('없음'); return }
    setStatus('로딩 중...')
    const loader = new GLTFLoader()
    loader.parse(data.slice(0), '', (gltf) => {
      const root = gltf.scene
      root.traverse(obj => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        // MICA(/reconstruct) 같은 vertex-color 전용 메시는 trimesh export가 material을
        // 아예 안 만들어서, Three.js 기본 material이 metalness:1/roughness:1(완전 금속)로
        // 잡혀 정점색이 탁하게 죽어 보인다 — Real3D 자체 웹뷰어에서 이미 겪고 고친 것과
        // 같은 버그([[photo_to_3d_avatar_plan]] 세션28 기록). 여기도 동일하게 무광 처리.
        const mat = mesh.material as THREE.MeshStandardMaterial
        if (!Array.isArray(mat) && mat?.vertexColors) {
          mat.metalness = 0
          mat.roughness = 1
          mat.needsUpdate = true
          // glTF COLOR_0는 스펙상 리니어여야 하는데 Real3D 서버가 사진 픽셀값(sRGB)을 그대로
          // 구워 넣는다 — 로드 시 한 번만 변환(재실행 없음, loader.parse 콜백 안이라 이 로드당 1회).
          // ⚠️ trimesh가 굽는 COLOR_0는 normalized Uint8Array(0~255)다 — Float32(0~1)로 잘못
          // 가정하고 그대로 sRGB→리니어 공식에 넣으면 정수값(예:205)이 거대한 지수값으로
          // 계산돼 Uint8Array에 대입될 때 랩어라운드로 완전히 다른 색이 돼버린다(실측으로
          // 발견 — "회색스럽다" 신고를 고치려다 색 자체가 깨지는 걸 봄). 실제 배열 타입/
          // normalized 플래그를 확인해 0~1 스케일로 정규화한 뒤 변환하고 되돌려야 한다.
          const colorAttr = mesh.geometry.getAttribute('color') as THREE.BufferAttribute | undefined
          if (colorAttr) {
            const arr = colorAttr.array as Uint8Array | Float32Array
            const isNormalizedInt = colorAttr.normalized && !(arr instanceof Float32Array)
            const scale = isNormalizedInt ? 255 : 1
            for (let i = 0; i < arr.length; i += 1) {
              const linear = srgbToLinear(arr[i] / scale)
              arr[i] = isNormalizedInt ? Math.round(linear * scale) : linear
            }
            colorAttr.needsUpdate = true
          }
        }
        originalMatsRef.current.set(mesh, mesh.material)
      })
      scene.add(root)
      rootRef.current = root

      // 얼굴만 보이도록 정면 클로즈업 프레이밍 — 바운딩박스 상단 40% 영역(머리) 기준.
      const box = new THREE.Box3().setFromObject(root)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const headCenter = new THREE.Vector3(center.x, box.max.y - size.y * 0.12, center.z + size.z * 0.15)
      const camera = cameraRef.current!
      const dist = Math.max(size.x, size.y) * 0.9 + 0.05
      camera.position.set(headCenter.x, headCenter.y, headCenter.z + dist)
      camera.near = dist / 100
      camera.far = dist * 50
      camera.updateProjectionMatrix()
      controlsRef.current!.target.copy(headCenter)
      controlsRef.current!.update()
      setStatus('')
      setLoadTick(t => t + 1)
    }, (err) => setStatus(`로드 실패: ${String(err)}`))
  }, [data])

  useEffect(() => {
    if (applyPhotoTexture) return // 아래 실사 텍스처 effect가 재질을 관리한다
    originalMatsRef.current.forEach((mat, mesh) => {
      mesh.material = shapeOnly ? flatMatRef.current : mat
    })
    // loadTick 의존성 필수 — GLTFLoader.parse가 비동기라 이 effect가 originalMatsRef 채워지기
    // 전에 먼저 돌아 아무 것도 못 바꾸는 경우가 있음(로드 완료 시 loadTick이 올라와야 재적용).
  }, [shapeOnly, data, applyPhotoTexture, loadTick])

  // 실사 텍스처 적용 — RealisticAvatar.tsx의 얼굴 텍스처 등록 기능을 그대로 재사용
  // (등록된/정렬확인된 얼굴 사진을 씀 — 이 탭에 방금 올린 사진과 다를 수 있음, 사용자 확인 필요).
  // uvWarpWeight 등 강도 슬라이더는 localStorage로 공유되므로 textureVersion을 올려 재적용을 트리거한다.
  useEffect(() => {
    if (!applyPhotoTexture) return
    const root = rootRef.current
    if (!root) return
    let cancelled = false
    generatedTexturesRef.current.forEach(t => t.dispose())
    generatedTexturesRef.current = []
    originalMatsRef.current.forEach((mat, mesh) => { mesh.material = mat })
    setStatus('실사 텍스처 적용 중...')
    buildRegisteredFaceTexture().then(async (face: FaceTextureData | null) => {
      if (cancelled) return
      if (!face) { setStatus('등록된 얼굴 사진 없음 — 실사 아바타 탭에서 정렬 확인을 먼저 해주세요'); return }
      const result = await applyRegisteredFaceTexture(root, face)
      if (cancelled) { result.generated.forEach(t => t.dispose()); return }
      generatedTexturesRef.current = result.generated
      setStatus(result.applied > 0 ? '' : '얼굴 재질을 찾지 못함')
    }).catch(() => { if (!cancelled) setStatus('텍스처 적용 실패') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyPhotoTexture, data, textureVersion, loadTick])

  // MICA UV 텍스처 디코딩 — 정점색(2162개, 삼각형 사이 선형보간이라 뭉개짐)보다 서버가 UV
  // 텍셀 단위(1024x1024)로 구운 텍스처가 있으면 이쪽이 훨씬 촘촘하다("100%로 올려도 왜
  // 더 거칠어지냐"는 지적의 원인 수정). 로드 시 1회만 디코딩 + 대비 조절용 평균색 계산.
  useEffect(() => {
    if (!micaTextureData) {
      micaTextureRef.current?.dispose()
      micaTextureRef.current = null
      setMicaTexTick(t => t + 1)
      return
    }
    let cancelled = false
    createImageBitmap(new Blob([micaTextureData], { type: 'image/png' })).then(bitmap => {
      if (cancelled) return
      const canvas = document.createElement('canvas')
      canvas.width = 32; canvas.height = 32
      const ctx = canvas.getContext('2d')
      let avg: [number, number, number] = [0.6, 0.5, 0.45]
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, 32, 32)
        const px = ctx.getImageData(0, 0, 32, 32).data
        let r = 0, g = 0, b = 0
        const n = px.length / 4
        for (let i = 0; i < px.length; i += 4) {
          r += srgbToLinear(px[i] / 255); g += srgbToLinear(px[i + 1] / 255); b += srgbToLinear(px[i + 2] / 255)
        }
        avg = [r / n, g / n, b / n]
      }
      micaTextureAvgRef.current = avg
      const tex = new THREE.Texture(bitmap)
      tex.flipY = false // glTF UV는 V=0이 이미지 위쪽 — 구울 때도 뒤집지 않았으니 그대로 맞음
      tex.needsUpdate = true
      micaTextureRef.current?.dispose()
      micaTextureRef.current = tex
      setMicaTexTick(t => t + 1)
    }).catch(() => {
      micaTextureRef.current?.dispose()
      micaTextureRef.current = null
      setMicaTexTick(t => t + 1)
    })
    return () => { cancelled = true }
  }, [micaTextureData])

  // MICA(사진 투영) 가중치 — 텍스처(micaTextureRef, 있으면 우선)나 정점색(micaColors, 폴백)을
  // 커스텀 셰이더로 diffuse 색과 직접 mix한다.
  // ⚠️ 처음엔 THREE의 기본 vertexColors(재질에 곱연산)로 구현했으나 흰색↔MICA색 사이를 곱해봤자
  // 원본 텍스처가 이미 어둡거나 색이 있으면 결과가 거의 안 변해 "조절해도 적용이 안 된다"는
  // 지적을 받았다 — mix()는 원본과 MICA색을 직접 보간해 weight=1에서 정말로 MICA색 그대로
  // 나오게 하는 게 목적이라, 곱연산이 아니라 onBeforeCompile로 diffuseColor 자체를 덮어써야 한다.
  // uMicaWeight를 uniform으로 둬서, 슬라이더를 움직일 때마다 셰이더 재컴파일 없이 값만 갱신한다
  // (재컴파일은 실사 텍스처 토글/텍스처↔정점색 모드 전환처럼 material 자체가 바뀔 때만 필요).
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let headMesh: THREE.Mesh | null = null
    root.traverse(obj => { if ((obj as THREE.Mesh).isMesh && obj.name === 'Streamoji_Head') headMesh = obj as THREE.Mesh })
    if (!headMesh) return
    const mesh = headMesh as THREE.Mesh
    const geometry = mesh.geometry as THREE.BufferGeometry
    const mat = mesh.material as THREE.MeshStandardMaterial
    if (Array.isArray(mat)) return
    const vertexCount = geometry.attributes.position?.count ?? 0
    const effectiveWeight = shapeOnly ? 0 : Math.max(0, Math.min(1, micaColorWeight ?? 0))
    const intensity = micaIntensity ?? 1

    const useTexture = !!micaTextureRef.current
    const useVertex = !useTexture && !!micaColors && micaColors.length === vertexCount * 3
    if (!useTexture && !useVertex) {
      if (micaShaderRef.current?.material === mat) micaShaderRef.current.uniform.weight.value = 0
      return
    }

    if (useVertex) {
      // 서버가 준 값은 사진 픽셀(sRGB) 그대로라 리니어로 먼저 바꾼 다음, "MICA 강도" 슬라이더로
      // 평균색 기준 편차를 증폭/축소한다 — weight(uMicaWeight)와는 별개 축.
      const prev = micaAttrSourceRef.current
      if (!geometry.getAttribute('aMicaColor') || prev?.colors !== micaColors || prev?.intensity !== intensity) {
        const linear = new Float32Array(micaColors!.length)
        for (let i = 0; i < micaColors!.length; i += 1) linear[i] = srgbToLinear(micaColors![i])
        const boosted = contrastBoost(linear, intensity)
        geometry.setAttribute('aMicaColor', new THREE.BufferAttribute(boosted, 3))
        micaAttrSourceRef.current = { colors: micaColors!, intensity }
      }
    }

    const mode: 'texture' | 'vertex' = useTexture ? 'texture' : 'vertex'
    if (micaShaderRef.current?.material === mat && micaShaderRef.current.mode === mode) {
      micaShaderRef.current.uniform.weight.value = effectiveWeight
      if (mode === 'texture') {
        micaShaderRef.current.uniform.map!.value = micaTextureRef.current
        micaShaderRef.current.uniform.avg!.value.set(...micaTextureAvgRef.current)
        micaShaderRef.current.uniform.intensity!.value = intensity
      }
    } else if (mode === 'texture') {
      // ⚠️ 이 메시(Streamoji_Head)는 material.map이 없어(headMesh.material.map === null,
      // 실측 확인) three가 vUv/vMapUv 둘 다 아예 선언을 안 한다(USE_UV/USE_MAP이 꺼짐) —
      // "undeclared identifier"로 컴파일 자체가 깨져 메시가 안 보인다. Three 내부 varying에
      // 기대지 말고 aMicaColor(정점색 경로)와 똑같이 geometry.attributes.uv를 별도 이름으로
      // 복제해 직접 attribute/varying을 선언해야 material 종류와 무관하게 항상 동작한다.
      if (!geometry.getAttribute('aMicaUv') && geometry.getAttribute('uv')) {
        geometry.setAttribute('aMicaUv', geometry.getAttribute('uv'))
      }
      const weight = { value: effectiveWeight }
      const map = { value: micaTextureRef.current }
      const avg = { value: new THREE.Vector3(...micaTextureAvgRef.current) }
      const intensityUniform = { value: intensity }
      mat.onBeforeCompile = shader => {
        shader.uniforms.uMicaWeight = weight
        shader.uniforms.uMicaMap = map
        shader.uniforms.uMicaAvg = avg
        shader.uniforms.uMicaIntensity = intensityUniform
        shader.vertexShader = `attribute vec2 aMicaUv;\nvarying vec2 vMicaUv;\n${shader.vertexShader}`
          .replace('void main() {', 'void main() {\n  vMicaUv = aMicaUv;')
        shader.fragmentShader = `uniform float uMicaWeight;\nuniform sampler2D uMicaMap;\nuniform vec3 uMicaAvg;\nuniform float uMicaIntensity;\nvarying vec2 vMicaUv;\n${shader.fragmentShader}`
          .replace('#include <map_fragment>', `#include <map_fragment>
  {
    vec3 c = texture2D(uMicaMap, vMicaUv).rgb;
    vec3 lo = c / 12.92;
    vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
    vec3 micaColor = mix(lo, hi, step(vec3(0.04045), c));
    micaColor = uMicaAvg + (micaColor - uMicaAvg) * uMicaIntensity;
    diffuseColor.rgb = mix(diffuseColor.rgb, clamp(micaColor, 0.0, 1.0), uMicaWeight);
  }`)
      }
      mat.needsUpdate = true
      micaShaderRef.current = { material: mat, mode, uniform: { weight, map, avg, intensity: intensityUniform } }
    } else {
      const weight = { value: effectiveWeight }
      mat.onBeforeCompile = shader => {
        shader.uniforms.uMicaWeight = weight
        shader.vertexShader = `attribute vec3 aMicaColor;\nvarying vec3 vMicaColor;\n${shader.vertexShader}`
          .replace('void main() {', 'void main() {\n  vMicaColor = aMicaColor;')
        shader.fragmentShader = `varying vec3 vMicaColor;\nuniform float uMicaWeight;\n${shader.fragmentShader}`
          .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vMicaColor, uMicaWeight);')
      }
      mat.needsUpdate = true
      micaShaderRef.current = { material: mat, mode, uniform: { weight } }
    }
  }, [data, loadTick, shapeOnly, applyPhotoTexture, textureVersion, micaColors, micaColorWeight, micaIntensity, micaTexTick])

  // 형태(shape) 가중치 — 서버가 워프 전 원본 Streamoji_Head 위치(shapeOriginal)를 주면, 로드
  // 시점의 워프된 위치(warpedPosRef, loadTick당 최초 1회만 스냅샷)와 원본 사이를 직접 lerp한다.
  // pose_jaw_open.bin 패턴(정점 순서 1:1 대응 raw binary)을 위치 자체에 적용한 것 — "MICA
  // 형태를 최대한 반영해달라"는 요청에 그대로 반영(weight=1)할지, 원본 Streamoji 쪽으로 낮출지
  // 직접 조절 가능하게 한다. weight<1로 섞으면 노멀도 다시 계산해야 라이팅이 안 어색하다.
  // ⚠️ 이 리그는 POSITION/NORMAL/UV/JOINTS/WEIGHTS가 한 버퍼에 인터리브돼 있다(glb_patch.py에
  // 이미 기록된 이 프로젝트의 기존 gotcha) — Three.js에서는 InterleavedBufferAttribute가 되고,
  // `.array`를 직접 읽고 쓰면 위치뿐 아니라 노멀·UV·스키닝까지 뒤섞인 raw 버퍼 전체를 건드리게
  // 된다(길이도 정점수*3이 아니라 훨씬 큼). 처음 `.array`를 직접 슬라이스/대입했다가 슬라이더를
  // 움직여도 실제로는 아무것도 안 바뀌는 버그를 실측으로 발견 — 인터리브 여부와 무관하게 항상
  // 올바르게 동작하는 getX/getY/getZ/setXYZ로 바꿔야 한다.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let headMesh: THREE.Mesh | null = null
    root.traverse(obj => { if ((obj as THREE.Mesh).isMesh && obj.name === 'Streamoji_Head') headMesh = obj as THREE.Mesh })
    if (!headMesh) return
    const geometry = (headMesh as THREE.Mesh).geometry as THREE.BufferGeometry
    const posAttr = geometry.attributes.position as THREE.BufferAttribute | undefined
    if (!posAttr) return
    const vertexCount = posAttr.count
    if (warpedPosLoadTickRef.current !== loadTick) {
      const snap = new Float32Array(vertexCount * 3)
      for (let i = 0; i < vertexCount; i += 1) {
        snap[i * 3] = posAttr.getX(i)
        snap[i * 3 + 1] = posAttr.getY(i)
        snap[i * 3 + 2] = posAttr.getZ(i)
      }
      warpedPosRef.current = snap
      warpedPosLoadTickRef.current = loadTick
    }
    const warped = warpedPosRef.current
    if (!warped) return
    const weight = Math.max(0, Math.min(1, shapeWeight ?? 1))
    const useOriginal = !!shapeOriginal && shapeOriginal.length === warped.length && weight < 1
    for (let i = 0; i < vertexCount; i += 1) {
      let x = warped[i * 3]
      let y = warped[i * 3 + 1]
      let z = warped[i * 3 + 2]
      if (useOriginal) {
        x = shapeOriginal![i * 3] + (x - shapeOriginal![i * 3]) * weight
        y = shapeOriginal![i * 3 + 1] + (y - shapeOriginal![i * 3 + 1]) * weight
        z = shapeOriginal![i * 3 + 2] + (z - shapeOriginal![i * 3 + 2]) * weight
      }
      posAttr.setXYZ(i, x, y, z)
    }
    posAttr.needsUpdate = true
    geometry.computeVertexNormals()
  }, [data, loadTick, shapeOriginal, shapeWeight])

  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-medium text-gray-600">{label}</div>
      <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-surface-border bg-gray-50">
        {/* containerRef 안에는 Three.js가 appendChild한 canvas만 있어야 한다 — React가
            여기에 JSX 자식을 하나라도 렌더링하면, 이후 리렌더 때 React가 자신이 모르는
            canvas를 자기 자식 목록 관리 과정에서 지워버린다(실측으로 확인한 버그).
            그래서 상태 오버레이는 반드시 형제 엘리먼트로 뺀다. */}
        <div ref={containerRef} className="absolute inset-0" />
        {status && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-400">{status}</div>}
      </div>
    </div>
  )
}

export default function Avatar3DMix() {
  const [persona, setPersona] = useState<PersonaId>(() => {
    const stored = localStorage.getItem('mental-avatar-mix-persona')
    return stored === 'fictional-ai' ? 'fictional-ai' : 'private-consented'
  })
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [frontFile, setFrontFile] = useState<File | null>(null)
  const [leftFile, setLeftFile] = useState<File | null>(null)
  const [rightFile, setRightFile] = useState<File | null>(null)

  const photoSetters: Record<PhotoSlot, (f: File | null) => void> = {
    front: setFrontFile, left: setLeftFile, right: setRightFile,
  }
  // 인물별 정면/좌/우 참고사진을 독립 보관한다. 인물을 바꾸면 해당 인물의 사진만 복원한다.
  useEffect(() => {
    setFrontFile(null); setLeftFile(null); setRightFile(null)
    setRightsConfirmed(false)
    photoList(persona).then(entries => {
      entries.forEach(e => {
        photoSetters[e.slot](new File([e.data], e.name, { type: e.type }))
      })
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona])
  // 새 파일을 고르면 상태 갱신과 동시에 IndexedDB에 저장(다음 방문 때 기본값으로 뜨도록).
  const pickPhoto = useCallback((slot: PhotoSlot, file: File | null) => {
    photoSetters[slot](file)
    if (file) {
      file.arrayBuffer().then(data => {
        photoSave({ id: `${persona}:${slot}`, person: persona, slot, name: file.name, type: file.type, data, savedAt: Date.now() }).catch(() => {})
      })
    } else {
      photoDelete(persona, slot).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona])

  const [jobId, setJobId] = useState<string | null>(null)
  const [jobStatus, setJobStatus] = useState<RetargetStatus | null>(null)
  const [resultData, setResultData] = useState<ArrayBuffer | null>(null)
  const [micaData, setMicaData] = useState<ArrayBuffer | null>(null)
  const [error, setError] = useState('')
  // 패널마다 독립적으로 "형태만 보기"를 켤 수 있게 분리 — 예: MICA는 이미 사진 정점색이
  // 입혀져 있어서(서버가 /reconstruct 단계에서 굽는다) 텍스처로 보고, 다른 둘은 형태만
  // 비교하는 식의 조합이 가능해야 한다.
  const [shapeOnlyMap, setShapeOnlyMap] = useState({ current: true, mica: true, result: true })
  const toggleShapeOnly = useCallback((key: keyof typeof shapeOnlyMap) => {
    setShapeOnlyMap(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])
  const [saveMsg, setSaveMsg] = useState('')

  const [currentTabGlb, setCurrentTabGlb] = useState<ArrayBuffer | null>(null)
  const [currentTabName, setCurrentTabName] = useState('')

  // 결과 패널에 실사진 텍스처(UV 투영) 적용 — "실사 아바타" 탭과 같은 강도 설정을 공유.
  const [applyPhotoTexture, setApplyPhotoTexture] = useState(false)
  const [uvWarpWeight, setUvWarpWeight] = useState(() => Number(localStorage.getItem(UV_WARP_WEIGHT_KEY) ?? '1'))
  const [textureExactness, setTextureExactness] = useState(() => Number(localStorage.getItem(FACE_TEXTURE_EXACTNESS_KEY) ?? '1'))
  const [textureBrightness, setTextureBrightness] = useState(() => Number(localStorage.getItem(FACE_TEXTURE_BRIGHTNESS_KEY) ?? '1'))
  const [textureVersion, setTextureVersion] = useState(0)
  const setWeight = useCallback((key: string, value: number, setter: (v: number) => void) => {
    localStorage.setItem(key, String(value))
    setter(value)
    setTextureVersion(v => v + 1)
  }, [])

  // MICA(사진 투영) 텍스처 가중치 — 서버가 계산해준 Streamoji_Head 정점색(mica_colors.bin)을
  // 얼마나 강하게 반영할지. 실사진 텍스처(UV) 슬라이더들과는 독립적으로 켤 수 있다.
  const [micaColorWeight, setMicaColorWeight] = useState(() => Number(localStorage.getItem(MICA_COLOR_WEIGHT_KEY) ?? '0'))
  const [micaColors, setMicaColors] = useState<Float32Array | null>(null)
  // UV 텍셀 단위로 구운 MICA 텍스처(mica_texture.png) — 정점색보다 훨씬 촘촘함, 있으면 우선 사용.
  const [micaTexture, setMicaTexture] = useState<ArrayBuffer | null>(null)
  const setMicaWeight = useCallback((value: number) => {
    localStorage.setItem(MICA_COLOR_WEIGHT_KEY, String(value))
    setMicaColorWeight(value)
  }, [])
  // MICA 텍스처 자체의 사진 반영 강도(대비) — "MICA 자체가 사진 대비 흐릿하게 나온다"는
  // 지적에 대한 조절 기능. 1=원본, 낮추면 평균색에 가까워지고(흐릿) 높이면 명암이 강해진다.
  const [micaIntensity, setMicaIntensityState] = useState(() => Number(localStorage.getItem(MICA_INTENSITY_KEY) ?? '1.4'))
  const setMicaIntensity = useCallback((value: number) => {
    localStorage.setItem(MICA_INTENSITY_KEY, String(value))
    setMicaIntensityState(value)
  }, [])
  // 3D 형태(shape) 가중치 — 1=워프된(MICA 반영) 형태 그대로, 낮추면 워프 전 원본 Streamoji
  // 형태 쪽으로 섞인다. 기본값 1(기존 동작 그대로) — "MICA 형태를 최대한 반영해달라"는
  // 요청이 이미 기본값이라, 이 슬라이더는 반대로 줄여보고 싶을 때를 위한 조절 기능.
  const [shapeWeight, setShapeWeightState] = useState(() => Number(localStorage.getItem(SHAPE_WEIGHT_KEY) ?? '1'))
  const [shapeOriginal, setShapeOriginal] = useState<Float32Array | null>(null)
  const setShapeWeight = useCallback((value: number) => {
    localStorage.setItem(SHAPE_WEIGHT_KEY, String(value))
    setShapeWeightState(value)
  }, [])

  const refreshCurrentTabGlb = useCallback(() => {
    idbList().then(list => {
      if (list.length === 0) { setCurrentTabGlb(null); setCurrentTabName(''); return }
      const selectedName = localStorage.getItem(AVATAR_FILE_KEY)
      const entry = list.find(e => e.name === selectedName) ?? list[0]
      setCurrentTabGlb(entry.data)
      setCurrentTabName(entry.name)
    }).catch(() => {})
  }, [])
  useEffect(() => { refreshCurrentTabGlb() }, [refreshCurrentTabGlb])

  const pollRef = useRef<number | null>(null)
  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])

  const startGenerate = useCallback(async () => {
    if (!frontFile) return
    if (!rightsConfirmed) { setError('사진을 처리하기 전에 사용 권한·동의 확인을 선택해 주세요.'); return }
    setError('')
    setResultData(null)
    setMicaData(null)
    setMicaColors(null)
    setMicaTexture(null)
    setShapeOriginal(null)
    setJobStatus(null)
    setSaveMsg('')

    const form = new FormData()
    form.append('photo', frontFile)
    if (leftFile) form.append('photo_left', leftFile)
    if (rightFile) form.append('photo_right', rightFile)

    // 순수 MICA 형태(리그 없음, Streamoji 이식 전)도 같은 사진으로 따로 요청해서
    // "형태만" 비교할 때 세 번째 기준점으로 보여준다 — /retarget과 별개 엔드포인트라
    // 서로 영향 없음, 실패해도 /retarget 결과 표시는 그대로 진행된다.
    const reconstructForm = new FormData()
    reconstructForm.append('photo', frontFile)
    if (leftFile) reconstructForm.append('photo_left', leftFile)
    if (rightFile) reconstructForm.append('photo_right', rightFile)
    fetch(`${REAL3D_BASE}/reconstruct`, { method: 'POST', body: reconstructForm })
      .then(async r => {
        if (!r.ok) return
        const { mesh_url } = await r.json() as { mesh_url: string }
        const mres = await fetch(`${REAL3D_BASE}${mesh_url}`)
        setMicaData(await mres.arrayBuffer())
      })
      .catch(() => {})

    try {
      const res = await fetch(`${REAL3D_BASE}/retarget`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`요청 실패 (${res.status})`)
      const { job_id } = await res.json() as { job_id: string }
      setJobId(job_id)

      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(async () => {
        try {
          const sres = await fetch(`${REAL3D_BASE}/retarget/status/${job_id}`)
          if (!sres.ok) return
          const s = await sres.json() as RetargetStatus
          setJobStatus(s)
          if (s.status === 'done' && s.mesh_url) {
            window.clearInterval(pollRef.current!)
            pollRef.current = null
            const mres = await fetch(`${REAL3D_BASE}${s.mesh_url}`)
            const buf = await mres.arrayBuffer()
            setResultData(buf)
            if (s.mica_colors) {
              fetch(`${REAL3D_BASE}/retarget_colors/${job_id}`)
                .then(r => (r.ok ? r.arrayBuffer() : null))
                .then(b => setMicaColors(b ? new Float32Array(b) : null))
                .catch(() => setMicaColors(null))
            }
            if (s.mica_texture) {
              fetch(`${REAL3D_BASE}/retarget_texture/${job_id}`)
                .then(r => (r.ok ? r.arrayBuffer() : null))
                .then(b => setMicaTexture(b))
                .catch(() => setMicaTexture(null))
            }
            if (s.shape_original) {
              fetch(`${REAL3D_BASE}/retarget_shape_original/${job_id}`)
                .then(r => (r.ok ? r.arrayBuffer() : null))
                .then(b => setShapeOriginal(b ? new Float32Array(b) : null))
                .catch(() => setShapeOriginal(null))
            }
          } else if (s.status === 'error') {
            window.clearInterval(pollRef.current!)
            pollRef.current = null
            setError(s.message || '알 수 없는 오류')
          }
        } catch { /* 다음 폴링에서 재시도 */ }
      }, 1000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [frontFile, leftFile, rightFile, rightsConfirmed])

  const useAsAvatar = useCallback(async () => {
    if (!resultData || !jobId) return
    const name = `retarget_${jobId.slice(0, 8)}.glb`
    await idbSave({ name, size: resultData.byteLength, data: resultData, loadedAt: Date.now() })
    localStorage.setItem(AVATAR_FILE_KEY, name)
    setSaveMsg(`저장됨 — "실사 아바타" 탭에서 "${name}" 선택됨`)
    refreshCurrentTabGlb()
  }, [resultData, jobId, refreshCurrentTabGlb])

  const stageIndex = jobStatus ? STAGES.findIndex(s => s.key === jobStatus.stage) : -1

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">3D Mix — 동의된 개인·가상 캐릭터 작업대</h1>
        <p className="text-sm text-gray-500">사진으로 MICA 형태를 추정해 "실사 아바타" 리그(모프타겟·스켈레톤)에 이식합니다. 공개 인물의 사진·음성 수집과 재현에는 사용하지 않습니다.</p>
      </div>

      <div className="rounded-xl border border-surface-border bg-white p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div><div className="text-sm font-medium text-gray-700">3D 입력 종류</div><p className="mt-0.5 text-xs text-gray-500">정면·좌·우(또는 3/4) 사진은 같은 당사자 또는 같은 가상 캐릭터 안에서만 섞어 사용합니다.</p></div>
          <select value={persona} onChange={event => { const next = event.target.value as PersonaId; localStorage.setItem('mental-avatar-mix-persona', next); setPersona(next) }} className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm">
            {PERSONAS.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        {(() => { const item = PERSONAS.find(entry => entry.id === persona)!; return <div className="mb-3 rounded-lg border border-indigo-100 bg-indigo-50 p-2 text-xs text-indigo-950"><p><strong>외형:</strong> {item.face}</p><p className="mt-1"><strong>음성:</strong> {item.voice}</p><label className="mt-2 flex cursor-pointer items-start gap-2 rounded border border-indigo-200 bg-white/70 p-2 text-gray-800"><input type="checkbox" checked={rightsConfirmed} onChange={event => setRightsConfirmed(event.target.checked)} className="mt-0.5" /><span>{item.confirmation}</span></label></div> })()}
        <div className="mb-2 text-sm font-medium text-gray-700">사진 선택 (정면 필수, 좌/우는 선택) — 입력 종류별로 자동 저장됩니다</div>
        <div className="grid grid-cols-3 gap-2">
          {([
            ['front', '정면 (필수)', frontFile],
            ['left', '좌측 (선택)', leftFile],
            ['right', '우측 (선택)', rightFile],
          ] as const).map(([slot, label, file]) => (
            <div key={slot} className="flex flex-col items-center gap-1 rounded-lg border border-dashed border-surface-border p-3 text-center">
              <label className="flex w-full cursor-pointer flex-col items-center gap-1 text-xs text-gray-500 hover:bg-gray-50">
                <input type="file" accept="image/*" className="hidden" onChange={e => pickPhoto(slot, e.target.files?.[0] ?? null)} />
                <span>{label}</span>
                <span className="max-w-full truncate text-[11px] text-gray-400">{file ? file.name : '선택 안 됨'}</span>
              </label>
              {file && (
                <button
                  type="button"
                  onClick={() => pickPhoto(slot, null)}
                  className="text-[11px] text-red-500 hover:underline"
                >
                  지우기
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          disabled={!frontFile || !rightsConfirmed || (jobStatus?.status === 'running')}
          onClick={startGenerate}
          className="mt-3 rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {jobStatus?.status === 'running' ? '처리 중...' : '3D 형태 이식 시작'}
        </button>
        {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
      </div>

      {jobStatus && (
        <div className="rounded-xl border border-surface-border bg-white p-3">
          <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
            <span>{jobStatus.message}</span>
            <span>{jobStatus.progress}%</span>
          </div>
          <div className="mb-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div className="h-full bg-gray-950 transition-all" style={{ width: `${jobStatus.progress}%` }} />
          </div>
          <div className="flex flex-wrap gap-2 text-[11px]">
            {STAGES.map((s, i) => (
              <span key={s.key} className={`rounded-full px-2 py-1 ${i <= stageIndex || jobStatus.status === 'done' ? 'bg-gray-950 text-white' : 'bg-gray-100 text-gray-400'}`}>
                {s.label}
              </span>
            ))}
          </div>
          {jobStatus.status === 'done' && jobStatus.landmark_error_mm && (
            <div className="mt-2 text-[11px] text-gray-400">기준점 정렬 오차 평균 {jobStatus.landmark_error_mm.mean.toFixed(4)}mm (RBF 워프는 기준점에서 항상 오차 0에 가깝게 수렴 — 정상)</div>
          )}
          {jobStatus.warnings && jobStatus.warnings.length > 0 && (
            <div className="mt-1 text-[11px] text-amber-600">{jobStatus.warnings.join(', ')}</div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">패널마다 "형태만 보기"를 따로 켜고 끌 수 있습니다 (아래 각 패널 체크박스). MICA는 이미 사진 정점색이 입혀져 있어 꺼두면 실사진 색이 보입니다.</span>
        <button type="button" onClick={refreshCurrentTabGlb} className="ml-auto shrink-0 text-xs text-gray-400 hover:text-gray-700">↻ 현재 3D 탭 아바타 새로고침</button>
      </div>

      <div className="rounded-xl border border-surface-border bg-white p-3">
        <label className="flex flex-col gap-1 text-[11px] text-gray-500">
          <span className="text-xs font-medium text-gray-700">
            3D 형태(shape) 가중치 {shapeWeight.toFixed(2)}
            {!shapeOriginal && <span className="ml-1 font-normal text-gray-400">(이 결과에는 원본 형태 데이터가 없음)</span>}
          </span>
          <span className="text-[10px] text-gray-400">1=MICA로 워프된 형태 그대로(기본값), 낮추면 워프 전 원본 Streamoji 형태 쪽으로 섞입니다.</span>
          <input type="range" min={0} max={1} step={0.05} value={shapeWeight} disabled={!shapeOriginal}
            onChange={e => setShapeWeight(Number(e.target.value))} />
        </label>
      </div>

      <div className="rounded-xl border border-surface-border bg-white p-3">
        <label className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
          <input type="checkbox" checked={applyPhotoTexture} onChange={e => setApplyPhotoTexture(e.target.checked)} />
          형태 이식 결과에 실사진 텍스처 입히기(등록된/정렬확인된 얼굴 사진 사용 — "실사 아바타" 탭에서 미리 정렬 확인 필요)
        </label>
        {applyPhotoTexture && (
          <div className="mt-2 grid grid-cols-3 gap-3 text-[11px] text-gray-500">
            <label className="flex flex-col gap-1">
              사진 반영 강도(UV weight) {uvWarpWeight.toFixed(2)}
              <input type="range" min={0} max={1} step={0.05} value={uvWarpWeight}
                onChange={e => setWeight(UV_WARP_WEIGHT_KEY, Number(e.target.value), setUvWarpWeight)} />
            </label>
            <label className="flex flex-col gap-1">
              정확도(exactness) {textureExactness.toFixed(2)}
              <input type="range" min={0} max={1} step={0.05} value={textureExactness}
                onChange={e => setWeight(FACE_TEXTURE_EXACTNESS_KEY, Number(e.target.value), setTextureExactness)} />
            </label>
            <label className="flex flex-col gap-1">
              밝기 {textureBrightness.toFixed(2)}
              <input type="range" min={0.5} max={1.25} step={0.05} value={textureBrightness}
                onChange={e => setWeight(FACE_TEXTURE_BRIGHTNESS_KEY, Number(e.target.value), setTextureBrightness)} />
            </label>
          </div>
        )}
        <div className="mt-3 border-t border-surface-border pt-2">
          <label className="flex flex-col gap-1 text-[11px] text-gray-500">
            <span className="text-xs font-medium text-gray-700">
              MICA 사진 투영 텍스처 가중치 {micaColorWeight.toFixed(2)}
              {!micaColors && <span className="ml-1 font-normal text-gray-400">(이 결과에는 계산된 MICA 텍스처가 없음)</span>}
            </span>
            <span className="text-[10px] text-gray-400">Streamoji 기본 재질/실사진 UV 텍스처 위에, 사진에서 직접 투영한 MICA 정점색을 이 비율로 덧입힙니다. 0=원래 재질 그대로, 1=MICA 색 그대로.</span>
            <input type="range" min={0} max={1} step={0.05} value={micaColorWeight} disabled={!micaColors}
              onChange={e => setMicaWeight(Number(e.target.value))} />
          </label>
          <label className="mt-2 flex flex-col gap-1 text-[11px] text-gray-500">
            <span className="text-xs font-medium text-gray-700">MICA 자체 사진 반영 강도(대비) {micaIntensity.toFixed(2)}</span>
            <span className="text-[10px] text-gray-400">MICA 색이 사진보다 흐릿/회색스럽게 나올 때 올리세요. 1=원본, 낮추면 평균색에 가까워지고 높이면 명암·채도가 강해집니다. (위 가중치 블렌드에 적용 — MICA 원본 형태 패널 자체 렌더링은 별개입니다.)</span>
            <input type="range" min={0.5} max={3} step={0.1} value={micaIntensity} disabled={!micaColors}
              onChange={e => setMicaIntensity(Number(e.target.value))} />
          </label>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="flex flex-col gap-1">
          <GlbPreview data={currentTabGlb} label={`현재 "실사 아바타"${currentTabName ? ` — ${currentTabName}` : ''}`} shapeOnly={shapeOnlyMap.current} />
          <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <input type="checkbox" checked={shapeOnlyMap.current} onChange={() => toggleShapeOnly('current')} />
            형태만 보기
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <GlbPreview data={micaData} label="MICA 원본 형태(리그 없음, 사진 정점색 포함)" shapeOnly={shapeOnlyMap.mica} />
          <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <input type="checkbox" checked={shapeOnlyMap.mica} onChange={() => toggleShapeOnly('mica')} />
            형태만 보기(끄면 실사진 텍스처 표시)
          </label>
        </div>
        <div className="flex flex-col gap-1">
          <GlbPreview data={resultData} label="형태 이식 결과(리그+MICA형태)" shapeOnly={shapeOnlyMap.result && !applyPhotoTexture}
            applyPhotoTexture={applyPhotoTexture} textureVersion={textureVersion}
            micaColors={micaColors} micaTextureData={micaTexture} micaColorWeight={micaColorWeight} micaIntensity={micaIntensity}
            shapeOriginal={shapeOriginal} shapeWeight={shapeWeight} />
          <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
            <input type="checkbox" checked={shapeOnlyMap.result} disabled={applyPhotoTexture} onChange={() => toggleShapeOnly('result')} />
            형태만 보기
          </label>
        </div>
      </div>

      {resultData && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={useAsAvatar} className="rounded-lg bg-gray-950 px-4 py-2 text-sm font-medium text-white">
            이 결과를 "실사 아바타" 탭에 사용
          </button>
          {saveMsg && <span className="text-xs text-emerald-600">{saveMsg}</span>}
        </div>
      )}
    </div>
  )
}
