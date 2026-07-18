/**
 * RealisticAvatar — Avaturn GLB 3D 뷰어 + Avatar3DChat과 동일한 채팅/TTS/STT 패널
 */
import { useEffect, useRef, useState, useCallback, type Dispatch, type SetStateAction } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { streamClaudeWeb, claudeWebAutoConnect } from '@/services/claudeWeb'
import { streamChatOllama } from '@/services/ollama'
import type { ChatMsg, Settings } from '@/types'
import { API_BASE } from '@/config'
import VoiceServiceBanner from '@/components/VoiceServiceBanner'
import FaceTrackingPanel from './FaceTrackingPanel'
import { type Emotion, type LipCue, MORPH_GROUPS, RHUBARB_SHAPE_TARGETS, EMOTION_WEIGHTS, classifyEmotion } from '@/avatarMorph'

const API = API_BASE
const CHAT_SINCE_KEY = 'mental-avatar-realistic-chat-since'
const AVATAR_FILE_KEY = 'mental-avatar-avaturn-filename'
const THREE_D_ALIGNED_FACE_KEY = 'mental-avatar-3d-aligned-face-display'
const THREE_D_ORIGINAL_FACE_KEY = 'mental-avatar-3d-face-image'
const THREE_D_ALIGNED_LANDMARKS_KEY = 'mental-avatar-3d-aligned-landmarks'
const UV_WARP_WEIGHT_KEY = 'mental-avatar-uv-warp-weight'
const FACE_TEXTURE_EXACTNESS_KEY = 'mental-avatar-face-texture-exactness'
const FACE_TEXTURE_BRIGHTNESS_KEY = 'mental-avatar-face-texture-brightness'
const MP_WASM = '/mediapipe/wasm'
const MP_MODEL = '/mediapipe/models/face_landmarker.task'

let textureLandmarkerPromise: Promise<any> | null = null

async function detectTextureLandmarks(texture: THREE.Texture): Promise<Point2[] | null> {
  try {
    const image = texture.image as CanvasImageSource & { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number }
    const width = image?.naturalWidth || image?.width || 0
    const height = image?.naturalHeight || image?.height || 0
    if (!image || !width || !height) return null
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(image, 0, 0, width, height)
    if (!textureLandmarkerPromise) {
      textureLandmarkerPromise = (async () => {
        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks(MP_WASM)
        return FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MP_MODEL, delegate: 'CPU' },
          runningMode: 'IMAGE', numFaces: 1,
          minFaceDetectionConfidence: 0.3,
          minFacePresenceConfidence: 0.3,
        })
      })()
    }
    const detector = await textureLandmarkerPromise
    const result = detector.detect(canvas)
    const landmarks = result.faceLandmarks?.[0]
    if (!landmarks?.length) return null
    return landmarks.map((point: { x: number; y: number }) => ({
      x: point.x * width,
      y: (texture.flipY ? 1 - point.y : point.y) * height,
    }))
  } catch {
    return null
  }
}

async function detectNormalizedLandmarks(image: CanvasImageSource): Promise<StoredLandmark[] | null> {
  try {
    if (!textureLandmarkerPromise) {
      textureLandmarkerPromise = (async () => {
        const { FaceLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision')
        const vision = await FilesetResolver.forVisionTasks(MP_WASM)
        return FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MP_MODEL, delegate: 'CPU' },
          runningMode: 'IMAGE', numFaces: 1,
          minFaceDetectionConfidence: 0.3,
          minFacePresenceConfidence: 0.3,
        })
      })()
    }
    const detector = await textureLandmarkerPromise
    const landmarks = detector.detect(image).faceLandmarks?.[0]
    return landmarks?.map((point: { x: number; y: number; z?: number }) => ({ x: point.x, y: point.y, z: point.z })) as StoredLandmark[] || null
  } catch {
    return null
  }
}

// SQLite의 created_at(datetime('now','localtime'))과 동일한 'YYYY-MM-DD HH:MM:SS' 형식(로컬시간)
function localTimestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// TTS로 읽을 텍스트를 만든다 — 답변이 길면(XTTS 한국어 95자 제한 근처) 첫 문장만 읽고
// 나머지는 채팅창의 전체 텍스트를 참고하도록 안내한다. 길게 읽으려다 느려지거나
// 실패하는 것보다, 짧게라도 확실히 들리는 쪽을 우선한다.
const SPOKEN_TEXT_LIMIT = 92
const SPOKEN_FALLBACK_PHRASES = [
  '핵심만요.',
  '짧게 읽을게요.',
  '요점만 말씀드릴게요.',
  '핵심만 말씀드릴게요.',
  '나머지는 화면에서 볼게요.',
  '중요한 부분만 읽을게요.',
  '길이를 줄여서 말할게요.',
  '이어지는 내용은 채팅에 남길게요.',
  '자세한 맥락은 화면에서 확인해 주세요.',
  '자세한 내용은 채팅을 봐 주세요.',
  '더 궁금하시면 이어서 말씀해 주세요.',
  '또 궁금한 점 있으세요?',
  '혹시 다른 질문도 있으세요?',
  '이어서 물어보셔도 좋아요.',
  '궁금한 점 있으면 바로 말씀해 주세요.',
  '다음 질문도 편하게 해 주세요.',
  '원하시면 더 이어서 답할게요.',
  '할 일이 있으면 바로 말씀해 주세요.',
]

function pickFallbackPhrase(seed: string, room: number): string {
  const candidates = SPOKEN_FALLBACK_PHRASES.filter(phrase => phrase.length <= room)
  if (!candidates.length) return ''
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return candidates[hash % candidates.length]
}

function stripParentheticalText(text: string): string {
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

  return result
    .replace(/^\s*[·•\-–—*]+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildSpokenText(text: string): string {
  const trimmed = stripParentheticalText(text)
  if (trimmed.length <= SPOKEN_TEXT_LIMIT) return trimmed
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/)
  let firstSentence = (match ? match[0] : trimmed).trim()
  if (!firstSentence) return trimmed.slice(0, SPOKEN_TEXT_LIMIT).trim()

  const room = SPOKEN_TEXT_LIMIT - firstSentence.length - 1
  const fallback = pickFallbackPhrase(trimmed, room)
  if (fallback) return `${firstSentence} ${fallback}`

  if (firstSentence.length > SPOKEN_TEXT_LIMIT) {
    firstSentence = firstSentence.slice(0, SPOKEN_TEXT_LIMIT).trim()
  }
  return firstSentence.endsWith('.') || firstSentence.endsWith('!') || firstSentence.endsWith('?')
    ? firstSentence
    : `${firstSentence}...`
}
const IDB_NAME = 'mental-avatar-glb'
const IDB_STORE = 'glb-files'

interface GlbEntry { name: string; size: number; data: ArrayBuffer; loadedAt: number }

function openIDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE, { keyPath: 'name' })
    req.onsuccess = () => res(req.result)
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
async function idbList(): Promise<GlbEntry[]> {
  const db = await openIDB()
  return new Promise((res, rej) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const req = tx.objectStore(IDB_STORE).getAll()
    req.onsuccess = () => res((req.result as GlbEntry[]).sort((a, b) => b.loadedAt - a.loadedAt))
    req.onerror = () => rej(req.error)
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

interface MorphRef { mesh: THREE.Mesh; index: number }
// 립싱크·표정 모프 상수/분류기는 @/avatarMorph 로 분리 (PptPresenter와 공용)

const GREETING = '안녕하세요! 반갑습니다. 무엇이든 도와드리겠습니다.'
const SYSTEM = `당신은 사용자를 맞이하는 AI 아바타입니다.
따뜻하고 전문적으로 한국어로 응대하세요.
답변은 2~3문장으로 간결하게 하고, 항상 친절한 어조를 유지하세요.`

// 브라우저 내장 Microsoft TTS 목소리는 사용하지 않아 목록에서 제외
interface VoiceOption { id: string; label: string; kind: 'clone' | 'template'; voiceURI?: string }
const MY_VOICE: VoiceOption = { id: 'mine', label: '내 목소리', kind: 'clone' }
const TEMPLATE_VOICES: VoiceOption[] = [
  { id: 'pretty', label: '예쁜 목소리', kind: 'template' },
  { id: 'child',  label: '어린이 목소리', kind: 'template' },
  { id: 'calm',   label: '차분한 목소리', kind: 'template' },
]
const VOICE_OPTION_KEY = 'mental-avatar-realistic-voice'
const VIEW_MODE_KEY = 'mental-avatar-camera-view'
type ViewMode = 'face' | 'upper' | 'full'
const VIEW_MODE_LABELS: Record<ViewMode, string> = { face: '얼굴만', upper: '상반신', full: '전체 보기' }
// face: 얼굴이 화면을 꽉 채우는 클로즈업 — 카메라를 바짝 당기는 대신 FOV를 좁혀 왜곡 없이 확대(망원렌즈 효과).
// upper: 기존 기본값(상반신). full: 전신이 다 보이는 화면.
const VIEW_PRESETS: Record<ViewMode, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
  face:  { pos: [0, 1.58, 0.6], target: [0, 1.58, 0], fov: 45 },
  upper: { pos: [0, 1.5, 1.3], target: [0, 1.45, 0], fov: 45 },
  full:  { pos: [0, 0.9, 3.0], target: [0, 0.8, 0], fov: 45 },
}
const FACE_TEXTURE_SIZE = 512
const FACE_MATERIAL_RE = /face|head|skin|body|wolf3d_head|wolf3d_skin|avatar_head|avatar_face/i
const FACE_MATERIAL_EXCLUDE_RE = /hair|eye|iris|lash|brow|teeth|tooth|mouth|tongue|gum|cloth|shirt|pant|shoe|sock|accessory|glass|lens/i

function readUvWarpWeight() {
  const value = Number(localStorage.getItem(UV_WARP_WEIGHT_KEY) ?? '1')
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

function readFaceTextureExactness() {
  const value = Number(localStorage.getItem(FACE_TEXTURE_EXACTNESS_KEY) ?? '1')
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
}

function readFaceTextureBrightness() {
  const value = Number(localStorage.getItem(FACE_TEXTURE_BRIGHTNESS_KEY) ?? '1')
  return Number.isFinite(value) ? Math.max(0.5, Math.min(1.25, value)) : 1
}

function read3dFaceInputSignature() {
  const original = localStorage.getItem(THREE_D_ORIGINAL_FACE_KEY) || sessionStorage.getItem(THREE_D_ORIGINAL_FACE_KEY) || ''
  const aligned = localStorage.getItem(THREE_D_ALIGNED_FACE_KEY) || ''
  const landmarks = localStorage.getItem(THREE_D_ALIGNED_LANDMARKS_KEY) || sessionStorage.getItem(THREE_D_ALIGNED_LANDMARKS_KEY) || ''
  return [original, aligned, landmarks].map(value => `${value.length}:${value.slice(-64)}`).join('|')
}

interface FaceTextureData {
  texture: THREE.CanvasTexture
  color: THREE.Color
  lipColor: THREE.Color
  fullSource: HTMLCanvasElement
  original: HTMLCanvasElement
  projection: HTMLCanvasElement
  landmarks: StoredLandmark[] | null
  sourceMode: IntermediateTextureStages['sourceMode']
}

interface IntermediateTextureStages {
  original: string
  projection: string
  uvAligned: string
  final: string
  sourceMode: 'selected-aligned' | 'selected-image' | 'selected-detected' | 'aligned-display-fallback' | 'jingu-front' | 'original-local' | 'original-session' | 'aligned-crop-fallback' | 'api-face'
  landmarkCount: number
  featureWarpCount: number
  textureLandmarkCount: number
  uvTriangleCount: number
}

interface FaceMeshDiagnostic {
  mesh: string
  material: string
  vertices: number
  uvCount: number
  uvRange: string
  matched: boolean
}

interface GlbFeatureSupport {
  leftEye: boolean
  rightEye: boolean
  brows: boolean
  nose: boolean
  mouth: boolean
}

interface FeatureBox {
  x: number
  y: number
  width: number
  height: number
}

interface AlignedFeatureGeometry {
  leftEye: FeatureBox
  rightEye: FeatureBox
  brows: FeatureBox
  nose: FeatureBox
  mouth: FeatureBox
  landmarkCount: number
}

type StoredLandmark = { x: number; y: number; z?: number }

function readAlignedLandmarks(): StoredLandmark[] | null {
  const raw = localStorage.getItem(THREE_D_ALIGNED_LANDMARKS_KEY)
    || sessionStorage.getItem(THREE_D_ALIGNED_LANDMARKS_KEY)
  if (!raw) return null
  try {
    const landmarks = JSON.parse(raw) as StoredLandmark[]
    return Array.isArray(landmarks) && landmarks.length >= 468 ? landmarks : null
  } catch {
    return null
  }
}

function featureBox(landmarks: StoredLandmark[], indices: number[]): FeatureBox {
  const points = indices.map(index => landmarks[index]).filter(Boolean)
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 }
  const minX = Math.min(...points.map(point => point.x))
  const maxX = Math.max(...points.map(point => point.x))
  const minY = Math.min(...points.map(point => point.y))
  const maxY = Math.max(...points.map(point => point.y))
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function featureGeometryFromLandmarks(landmarks: StoredLandmark[]): AlignedFeatureGeometry {
  return {
    leftEye: featureBox(landmarks, [362, 263, 386, 374, 385, 380]),
    rightEye: featureBox(landmarks, [33, 133, 159, 145, 160, 144]),
    brows: featureBox(landmarks, [70, 63, 105, 66, 107, 336, 296, 334, 293, 300]),
    nose: featureBox(landmarks, [1, 2, 98, 327, 168, 195]),
    mouth: featureBox(landmarks, [61, 291, 13, 14, 78, 308, 82, 312]),
    landmarkCount: landmarks.length,
  }
}

function readAlignedFeatureGeometry(): AlignedFeatureGeometry | null {
  const landmarks = readAlignedLandmarks()
  if (!landmarks) return null
  return featureGeometryFromLandmarks(landmarks)
}

function inspectGlbFeatureSupport(root: THREE.Object3D): GlbFeatureSupport {
  const names = new Set<string>()
  let nose = false
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    Object.keys(mesh.morphTargetDictionary ?? {}).forEach(name => names.add(name.toLowerCase()))
    if (/head|face|wolf3d_head|avatar_head|avatar_face/i.test(mesh.name || '')) {
      const geometry = mesh.geometry as THREE.BufferGeometry
      nose ||= Boolean(geometry.getAttribute('position')?.count && geometry.getAttribute('uv')?.count)
    }
  })
  const has = (pattern: RegExp) => Array.from(names).some(name => pattern.test(name))
  return {
    leftEye: has(/eye.*(left|l$)|blink.*(left|l$)|squint.*(left|l$)/i),
    rightEye: has(/eye.*(right|r$)|blink.*(right|r$)|squint.*(right|r$)/i),
    brows: has(/brow/i),
    nose,
    mouth: has(/mouth|jaw|viseme|phoneme/i),
  }
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('face image load failed')) }
    img.src = url
  })
}

function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('face image load failed'))
    img.src = url
  })
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, size: number) {
  const scale = Math.max(size / img.width, size / img.height)
  const sw = size / scale
  const sh = size / scale
  const sx = Math.max(0, (img.width - sw) / 2)
  const sy = Math.max(0, (img.height - sh) * 0.38)
  ctx.drawImage(img, sx, sy, Math.min(sw, img.width), Math.min(sh, img.height), 0, 0, size, size)
}

function sampleFaceColor(ctx: CanvasRenderingContext2D, size: number): THREE.Color {
  const image = ctx.getImageData(0, 0, size, size).data
  let r = 0, g = 0, b = 0, total = 0
  const cx = size * 0.5
  const cy = size * 0.43
  const rx = size * 0.24
  const ry = size * 0.32
  for (let y = Math.floor(size * 0.18); y < Math.floor(size * 0.72); y += 4) {
    for (let x = Math.floor(size * 0.28); x < Math.floor(size * 0.72); x += 4) {
      const nx = (x - cx) / rx
      const ny = (y - cy) / ry
      if (nx * nx + ny * ny > 1) continue
      const i = (y * size + x) * 4
      const pr = image[i], pg = image[i + 1], pb = image[i + 2]
      if (image[i + 3] < 20) continue
      if (pr < 35 || pg < 25 || pb < 20 || pr > 245 || pg > 245 || pb > 245) continue
      r += pr; g += pg; b += pb; total += 1
    }
  }
  if (!total) return new THREE.Color(0xd8a98e)
  return new THREE.Color(r / total / 255, g / total / 255, b / total / 255)
}

function sampleLipColor(ctx: CanvasRenderingContext2D, size: number, skin: THREE.Color): THREE.Color {
  const image = ctx.getImageData(0, 0, size, size).data
  let r = 0, g = 0, b = 0, total = 0
  for (let y = Math.floor(size * 0.48); y < Math.floor(size * 0.72); y += 2) {
    for (let x = Math.floor(size * 0.34); x < Math.floor(size * 0.66); x += 2) {
      const i = (y * size + x) * 4
      const pr = image[i], pg = image[i + 1], pb = image[i + 2]
      if (image[i + 3] < 20) continue
      if (pr < 35 || pg < 20 || pb < 20) continue
      if (pr < pg * 1.12 || pr < pb * 1.08) continue
      r += pr; g += pg; b += pb; total += 1
    }
  }
  if (!total) return skin.clone().lerp(new THREE.Color(0x9d4f55), 0.38)
  return new THREE.Color(r / total / 255, g / total / 255, b / total / 255)
}

function makeFaceProjection(source: HTMLCanvasElement, alignmentMask?: HTMLCanvasElement | null): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(source, 0, 0)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const maskPixels = alignmentMask
    ? alignmentMask.getContext('2d')?.getImageData(0, 0, alignmentMask.width, alignmentMask.height).data
    : null
  for (let i = 0; i < pixels.data.length; i += 4) {
    const r = maskPixels?.[i] ?? pixels.data[i]
    const g = maskPixels?.[i + 1] ?? pixels.data[i + 1]
    const b = maskPixels?.[i + 2] ?? pixels.data[i + 2]
    const brightness = Math.max(r, g, b)
    if (brightness <= 28) {
      pixels.data[i + 3] = 0
    } else if (brightness < 58) {
      pixels.data[i + 3] = Math.round(((brightness - 28) / 30) * pixels.data[i + 3])
    }
  }
  ctx.putImageData(pixels, 0, 0)
  return canvas
}

function makeOriginalLandmarkSource(source: HTMLCanvasElement, landmarks: StoredLandmark[] | null): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(source, 0, 0)
  if (!landmarks?.length) return canvas
  const xs = landmarks.map(point => point.x), ys = landmarks.map(point => point.y)
  const minX = Math.min(...xs) * canvas.width, maxX = Math.max(...xs) * canvas.width
  const minY = Math.min(...ys) * canvas.height, maxY = Math.max(...ys) * canvas.height
  ctx.globalCompositeOperation = 'destination-in'
  ctx.fillStyle = '#fff'
  ctx.beginPath()
  ctx.ellipse(
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    Math.max(1, (maxX - minX) * 0.72),
    Math.max(1, (maxY - minY) * 0.82),
    0,
    0,
    Math.PI * 2,
  )
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'
  return canvas
}

function makeSoftSkinTexture(base: THREE.Color): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = FACE_TEXTURE_SIZE
  canvas.height = FACE_TEXTURE_SIZE
  const ctx = canvas.getContext('2d')!
  const baseStyle = `rgb(${Math.round(base.r * 255)}, ${Math.round(base.g * 255)}, ${Math.round(base.b * 255)})`
  ctx.fillStyle = baseStyle
  ctx.fillRect(0, 0, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE)

  const light = base.clone().lerp(new THREE.Color(0xffffff), 0.22)
  const shade = base.clone().lerp(new THREE.Color(0x5a3226), 0.16)
  const grad = ctx.createRadialGradient(
    FACE_TEXTURE_SIZE * 0.48, FACE_TEXTURE_SIZE * 0.34, FACE_TEXTURE_SIZE * 0.08,
    FACE_TEXTURE_SIZE * 0.5, FACE_TEXTURE_SIZE * 0.52, FACE_TEXTURE_SIZE * 0.72,
  )
  grad.addColorStop(0, `rgba(${Math.round(light.r * 255)}, ${Math.round(light.g * 255)}, ${Math.round(light.b * 255)}, 0.55)`)
  grad.addColorStop(0.58, 'rgba(255,255,255,0)')
  grad.addColorStop(1, `rgba(${Math.round(shade.r * 255)}, ${Math.round(shade.g * 255)}, ${Math.round(shade.b * 255)}, 0.2)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE)

  const noise = ctx.getImageData(0, 0, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE)
  for (let i = 0; i < noise.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 5
    noise.data[i] = Math.max(0, Math.min(255, noise.data[i] + n))
    noise.data[i + 1] = Math.max(0, Math.min(255, noise.data[i + 1] + n))
    noise.data[i + 2] = Math.max(0, Math.min(255, noise.data[i + 2] + n))
  }
  ctx.putImageData(noise, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.needsUpdate = true
  return tex
}

async function buildRegisteredFaceTexture(): Promise<FaceTextureData | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 2500)
  try {
    // Prefer the untouched selected source. The aligned display is a recovery
    // source only for older sessions where the original data URL was evicted
    // but its paired landmark payload is still available.
    const selectedImage = localStorage.getItem(THREE_D_ORIGINAL_FACE_KEY)
      || sessionStorage.getItem(THREE_D_ORIGINAL_FACE_KEY)
    const alignedDisplay = localStorage.getItem(THREE_D_ALIGNED_FACE_KEY)
      || sessionStorage.getItem(THREE_D_ALIGNED_FACE_KEY)
    const imageUrl = selectedImage || alignedDisplay
    if (!imageUrl) return null
    const img = await loadImageFromUrl(imageUrl)
    // The selected source image is authoritative. If the alignment panel has
    // not persisted its landmark payload yet (or an older payload is invalid),
    // recover it directly from that same image instead of abandoning UV apply.
    let alignedLandmarks = readAlignedLandmarks()
    let sourceMode: IntermediateTextureStages['sourceMode'] = selectedImage
      ? (alignedLandmarks ? 'selected-aligned' : 'selected-detected')
      : 'aligned-display-fallback'
    if (!alignedLandmarks && selectedImage) {
      alignedLandmarks = await detectNormalizedLandmarks(img)
      if (alignedLandmarks?.length) {
        const serialized = JSON.stringify(alignedLandmarks)
        try {
          localStorage.setItem(THREE_D_ALIGNED_LANDMARKS_KEY, serialized)
          sessionStorage.removeItem(THREE_D_ALIGNED_LANDMARKS_KEY)
        } catch {
          try { sessionStorage.setItem(THREE_D_ALIGNED_LANDMARKS_KEY, serialized) } catch { /* storage quota */ }
        }
      }
    }
    if (!alignedLandmarks?.length) return null
    const sampleCanvas = document.createElement('canvas')
    sampleCanvas.width = FACE_TEXTURE_SIZE
    sampleCanvas.height = FACE_TEXTURE_SIZE
    const ctx = sampleCanvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, FACE_TEXTURE_SIZE, FACE_TEXTURE_SIZE)
    const projection = makeFaceProjection(sampleCanvas, null)
    const projectionCtx = projection.getContext('2d')
    if (!projectionCtx) return null
    const color = sampleFaceColor(projectionCtx, FACE_TEXTURE_SIZE)
    const lipColor = sampleLipColor(projectionCtx, FACE_TEXTURE_SIZE, color)
    return {
      texture: makeSoftSkinTexture(color),
      color,
      lipColor,
      fullSource: sampleCanvas,
      original: makeOriginalLandmarkSource(sampleCanvas, alignedLandmarks),
      projection,
      landmarks: alignedLandmarks,
      sourceMode,
    }
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

function isSkinPixel(r: number, g: number, b: number, a: number) {
  if (a < 24 || r < 35 || g < 22 || b < 16) return false
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return r >= g * 0.92 && r > b * 1.04 && max - min > 8 && Math.abs(r - g) < 105
}

function harmonizeRemainingSkinTone(ctx: CanvasRenderingContext2D, target: THREE.Color, strength = 0.72) {
  const image = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height)
  const targetR = target.r * 255
  const targetG = target.g * 255
  const targetB = target.b * 255
  const targetLuma = Math.max(1, targetR * 0.299 + targetG * 0.587 + targetB * 0.114)
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i], g = image.data[i + 1], b = image.data[i + 2], a = image.data[i + 3]
    if (!isSkinPixel(r, g, b, a)) continue
    // Match hue/chroma to the selected person's skin while preserving the
    // original GLB pixel luminance so shadows and facial depth remain intact.
    const luma = r * 0.299 + g * 0.587 + b * 0.114
    const scale = luma / targetLuma
    const mappedR = Math.min(255, targetR * scale)
    const mappedG = Math.min(255, targetG * scale)
    const mappedB = Math.min(255, targetB * scale)
    image.data[i] = r + (mappedR - r) * strength
    image.data[i + 1] = g + (mappedG - g) * strength
    image.data[i + 2] = b + (mappedB - b) * strength
  }
  ctx.putImageData(image, 0, 0)
}

type Point2 = { x: number; y: number }

function drawMappedTriangle(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  sourcePoints: [Point2, Point2, Point2],
  targetPoints: [Point2, Point2, Point2],
) {
  const [s0, s1, s2] = sourcePoints
  const [d0, d1, d2] = targetPoints
  const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y)
  if (Math.abs(det) < 0.0001) return
  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / det
  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / det
  const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / det
  const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / det
  const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / det
  const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / det

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(d0.x, d0.y)
  ctx.lineTo(d1.x, d1.y)
  ctx.lineTo(d2.x, d2.y)
  ctx.closePath()
  ctx.clip()
  ctx.transform(a, b, c, d, e, f)
  ctx.drawImage(image, 0, 0)
  ctx.restore()
}

function projectFaceToGlbUv(
  ctx: CanvasRenderingContext2D,
  projection: HTMLCanvasElement,
  mesh: THREE.Mesh,
  texture: THREE.Texture,
  width: number,
  height: number,
) {
  if (!/head|face|wolf3d_head|avatar_head|avatar_face/i.test(mesh.name || '')) return false
  const geometry = mesh.geometry as THREE.BufferGeometry
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!position?.count || !uv?.count || position.count !== uv.count) return false
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined

  let minX = Number.POSITIVE_INFINITY, maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY
  for (let i = 0; i < position.count; i += 1) {
    if (normal && normal.getZ(i) < 0.05) continue
    const x = position.getX(i), y = position.getY(i)
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  if (!Number.isFinite(minX) || maxX - minX < 0.0001 || maxY - minY < 0.0001) return false

  const sourcePixels = projection.getContext('2d')!.getImageData(0, 0, projection.width, projection.height).data
  let faceMinX = projection.width, faceMaxX = 0, faceMinY = projection.height, faceMaxY = 0
  for (let y = 0; y < projection.height; y += 3) {
    for (let x = 0; x < projection.width; x += 3) {
      if (sourcePixels[(y * projection.width + x) * 4 + 3] < 20) continue
      faceMinX = Math.min(faceMinX, x); faceMaxX = Math.max(faceMaxX, x)
      faceMinY = Math.min(faceMinY, y); faceMaxY = Math.max(faceMaxY, y)
    }
  }
  if (faceMaxX <= faceMinX || faceMaxY <= faceMinY) return false

  const index = geometry.index
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3)
  const textureY = (v: number) => (texture.flipY ? 1 - v : v) * height
  const sourcePoint = (vertex: number): Point2 => ({
    x: faceMinX + ((position.getX(vertex) - minX) / (maxX - minX)) * (faceMaxX - faceMinX),
    y: faceMinY + ((maxY - position.getY(vertex)) / (maxY - minY)) * (faceMaxY - faceMinY),
  })
  const targetPoint = (vertex: number): Point2 => ({
    x: uv.getX(vertex) * width,
    y: textureY(uv.getY(vertex)),
  })

  let projected = 0
  ctx.save()
  ctx.globalAlpha = 0.82
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const i0 = index ? index.getX(triangle * 3) : triangle * 3
    const i1 = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
    const i2 = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2
    const front = normal
      ? (normal.getZ(i0) + normal.getZ(i1) + normal.getZ(i2)) / 3
      : 1
    if (front < 0.12) continue
    drawMappedTriangle(
      ctx,
      projection,
      [sourcePoint(i0), sourcePoint(i1), sourcePoint(i2)],
      [targetPoint(i0), targetPoint(i1), targetPoint(i2)],
    )
    projected += 1
  }
  ctx.restore()
  return projected > 0
}

interface PixelBox { x: number; y: number; width: number; height: number }

function uvPixelBox(
  mesh: THREE.Mesh,
  texture: THREE.Texture,
  width: number,
  height: number,
  indices: number[],
): PixelBox | null {
  const uv = (mesh.geometry as THREE.BufferGeometry).getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv?.count || !indices.length) return null
  const points = indices.filter(index => index < uv.count).map(index => ({
    x: uv.getX(index) * width,
    y: (texture.flipY ? 1 - uv.getY(index) : uv.getY(index)) * height,
  }))
  if (!points.length) return null
  const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x))
  const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y))
  if (maxX - minX < 2 || maxY - minY < 2 || maxX - minX > width * 0.58 || maxY - minY > height * 0.58) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function uvPixelPoints(mesh: THREE.Mesh, texture: THREE.Texture, width: number, height: number, indices: number[]): Point2[] {
  const uv = (mesh.geometry as THREE.BufferGeometry).getAttribute('uv') as THREE.BufferAttribute | undefined
  if (!uv?.count) return []
  return indices.filter(index => index < uv.count).map(index => ({
    x: uv.getX(index) * width,
    y: (texture.flipY ? 1 - uv.getY(index) : uv.getY(index)) * height,
  }))
}

function convexHull(points: Point2[]): Point2[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (sorted.length < 3) return sorted
  const cross = (o: Point2, a: Point2, b: Point2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point2[] = []
  for (const point of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop(); lower.push(point) }
  const upper: Point2[] = []
  for (const point of [...sorted].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop(); upper.push(point) }
  return lower.slice(0, -1).concat(upper.slice(0, -1))
}

function morphFeatureUvBox(
  mesh: THREE.Mesh,
  texture: THREE.Texture,
  width: number,
  height: number,
  pattern: RegExp,
): PixelBox | null {
  const geometry = mesh.geometry as THREE.BufferGeometry
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const morphs = geometry.morphAttributes.position as THREE.BufferAttribute[] | undefined
  const dictionary = mesh.morphTargetDictionary ?? {}
  if (!position?.count || !morphs?.length) return null
  const matchedMorphs = Object.entries(dictionary)
    .filter(([name]) => pattern.test(name))
    .map(([, index]) => morphs[index])
    .filter(Boolean)
  if (!matchedMorphs.length) return null

  const strengths = new Float32Array(position.count)
  let maxStrength = 0
  for (const morph of matchedMorphs) {
    for (let i = 0; i < Math.min(position.count, morph.count); i += 1) {
      const dx = geometry.morphTargetsRelative ? morph.getX(i) : morph.getX(i) - position.getX(i)
      const dy = geometry.morphTargetsRelative ? morph.getY(i) : morph.getY(i) - position.getY(i)
      const dz = geometry.morphTargetsRelative ? morph.getZ(i) : morph.getZ(i) - position.getZ(i)
      const strength = Math.hypot(dx, dy, dz)
      strengths[i] = Math.max(strengths[i], strength)
      maxStrength = Math.max(maxStrength, strength)
    }
  }
  if (maxStrength <= 0) return null
  const indices: number[] = []
  const threshold = maxStrength * 0.1
  for (let i = 0; i < strengths.length; i += 1) if (strengths[i] >= threshold) indices.push(i)
  return uvPixelBox(mesh, texture, width, height, indices)
}

function morphFeatureUvPoints(mesh: THREE.Mesh, texture: THREE.Texture, width: number, height: number, pattern: RegExp): Point2[] {
  const geometry = mesh.geometry as THREE.BufferGeometry
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const morphs = geometry.morphAttributes.position as THREE.BufferAttribute[] | undefined
  const dictionary = mesh.morphTargetDictionary ?? {}
  if (!position?.count || !morphs?.length) return []
  const matchedMorphs = Object.entries(dictionary).filter(([name]) => pattern.test(name)).map(([, index]) => morphs[index]).filter(Boolean)
  if (!matchedMorphs.length) return []
  const strengths = new Float32Array(position.count)
  let maxStrength = 0
  for (const morph of matchedMorphs) for (let i = 0; i < Math.min(position.count, morph.count); i += 1) {
    const dx = geometry.morphTargetsRelative ? morph.getX(i) : morph.getX(i) - position.getX(i)
    const dy = geometry.morphTargetsRelative ? morph.getY(i) : morph.getY(i) - position.getY(i)
    const dz = geometry.morphTargetsRelative ? morph.getZ(i) : morph.getZ(i) - position.getZ(i)
    strengths[i] = Math.max(strengths[i], Math.hypot(dx, dy, dz)); maxStrength = Math.max(maxStrength, strengths[i])
  }
  if (maxStrength <= 0) return []
  const indices: number[] = []
  for (let i = 0; i < strengths.length; i += 1) if (strengths[i] >= maxStrength * 0.1) indices.push(i)
  return uvPixelPoints(mesh, texture, width, height, indices)
}

function noseFeatureUvBox(mesh: THREE.Mesh, texture: THREE.Texture, width: number, height: number): PixelBox | null {
  const geometry = mesh.geometry as THREE.BufferGeometry
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!position?.count) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < position.count; i += 1) {
    if (normal && normal.getZ(i) < 0.08) continue
    minX = Math.min(minX, position.getX(i)); maxX = Math.max(maxX, position.getX(i))
    minY = Math.min(minY, position.getY(i)); maxY = Math.max(maxY, position.getY(i))
    minZ = Math.min(minZ, position.getZ(i)); maxZ = Math.max(maxZ, position.getZ(i))
  }
  const indices: number[] = []
  for (let i = 0; i < position.count; i += 1) {
    if (normal && normal.getZ(i) < 0.08) continue
    const nx = (position.getX(i) - minX) / Math.max(0.0001, maxX - minX)
    const ny = (maxY - position.getY(i)) / Math.max(0.0001, maxY - minY)
    const nz = (position.getZ(i) - minZ) / Math.max(0.0001, maxZ - minZ)
    if (nx > 0.35 && nx < 0.65 && ny > 0.30 && ny < 0.70 && nz > 0.48) indices.push(i)
  }
  return uvPixelBox(mesh, texture, width, height, indices)
}

function noseFeatureUvPoints(mesh: THREE.Mesh, texture: THREE.Texture, width: number, height: number): Point2[] {
  const geometry = mesh.geometry as THREE.BufferGeometry
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!position?.count) return []
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity
  for (let i = 0; i < position.count; i += 1) { if (normal && normal.getZ(i) < 0.08) continue; minX = Math.min(minX, position.getX(i)); maxX = Math.max(maxX, position.getX(i)); minY = Math.min(minY, position.getY(i)); maxY = Math.max(maxY, position.getY(i)); minZ = Math.min(minZ, position.getZ(i)); maxZ = Math.max(maxZ, position.getZ(i)) }
  const indices: number[] = []
  for (let i = 0; i < position.count; i += 1) {
    if (normal && normal.getZ(i) < 0.08) continue
    const nx = (position.getX(i) - minX) / Math.max(0.0001, maxX - minX), ny = (maxY - position.getY(i)) / Math.max(0.0001, maxY - minY), nz = (position.getZ(i) - minZ) / Math.max(0.0001, maxZ - minZ)
    if (nx > 0.35 && nx < 0.65 && ny > 0.30 && ny < 0.70 && nz > 0.48) indices.push(i)
  }
  return uvPixelPoints(mesh, texture, width, height, indices)
}

function drawFeaturePatch(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  sourceBox: FeatureBox,
  targetBox: PixelBox | null,
  round = true,
) {
  // One independent source-feature -> target-UV warp. This is intentionally
  // not derived from a global face transform: each feature gets its own scale,
  // padding, clip shape, and UV destination.
  if (!targetBox || sourceBox.width <= 0 || sourceBox.height <= 0) return false
  const sourcePadX = sourceBox.width * 0.48
  const sourcePadY = sourceBox.height * 0.65
  const sx = Math.max(0, (sourceBox.x - sourceBox.width / 2 - sourcePadX) * source.width)
  const sy = Math.max(0, (sourceBox.y - sourceBox.height / 2 - sourcePadY) * source.height)
  const sw = Math.min(source.width - sx, (sourceBox.width + sourcePadX * 2) * source.width)
  const sh = Math.min(source.height - sy, (sourceBox.height + sourcePadY * 2) * source.height)
  const padX = targetBox.width * 0.28
  const padY = targetBox.height * 0.4
  const dx = targetBox.x - padX, dy = targetBox.y - padY
  const dw = targetBox.width + padX * 2, dh = targetBox.height + padY * 2
  ctx.save()
  ctx.globalAlpha = 0.94
  ctx.beginPath()
  if (round) ctx.ellipse(dx + dw / 2, dy + dh / 2, dw / 2, dh / 2, 0, 0, Math.PI * 2)
  else ctx.rect(dx, dy, dw, dh)
  ctx.clip()
  ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh)
  ctx.restore()
  return true
}

function drawPiecewiseFeatureWarp(ctx: CanvasRenderingContext2D, source: HTMLCanvasElement, sourceBox: FeatureBox, targetPoints: Point2[]) {
  const hull = convexHull(targetPoints)
  if (hull.length < 3 || sourceBox.width <= 0 || sourceBox.height <= 0) return false
  const minX = Math.min(...hull.map(point => point.x)), maxX = Math.max(...hull.map(point => point.x))
  const minY = Math.min(...hull.map(point => point.y)), maxY = Math.max(...hull.map(point => point.y))
  const targetCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  const sourcePadX = sourceBox.width * 0.48, sourcePadY = sourceBox.height * 0.65
  const sx = sourceBox.x - sourceBox.width / 2 - sourcePadX
  const sy = sourceBox.y - sourceBox.height / 2 - sourcePadY
  const sw = sourceBox.width + sourcePadX * 2, sh = sourceBox.height + sourcePadY * 2
  const sourcePoint = (target: Point2): Point2 => ({
    x: (sx + ((target.x - minX) / Math.max(1, maxX - minX)) * sw) * source.width,
    y: (sy + ((target.y - minY) / Math.max(1, maxY - minY)) * sh) * source.height,
  })
  const sourceCenter = sourcePoint(targetCenter)
  ctx.save(); ctx.globalAlpha = readUvWarpWeight()
  for (let i = 0; i < hull.length; i += 1) {
    const next = hull[(i + 1) % hull.length]
    drawMappedTriangle(ctx, source, [sourceCenter, sourcePoint(hull[i]), sourcePoint(next)], [targetCenter, hull[i], next])
  }
  ctx.restore()
  return true
}

function detectedFeaturePoints(landmarks: Point2[] | null, indices: number[]) {
  if (!landmarks?.length) return []
  return indices.map(index => landmarks[index]).filter((point): point is Point2 => Boolean(point))
}

function drawCorrespondedFeatureWarp(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  sourceLandmarks: StoredLandmark[],
  targetLandmarks: Point2[],
  indices: number[],
) {
  const pairs = indices.map(index => {
    const sourcePoint = sourceLandmarks[index]
    const targetPoint = targetLandmarks[index]
    if (!sourcePoint || !targetPoint) return null
    return {
      source: { x: sourcePoint.x * source.width, y: sourcePoint.y * source.height },
      target: targetPoint,
    }
  }).filter((pair): pair is { source: Point2; target: Point2 } => Boolean(pair))
  if (pairs.length < 3) return false
  const sourceCenter = pairs.reduce((sum, pair) => ({ x: sum.x + pair.source.x, y: sum.y + pair.source.y }), { x: 0, y: 0 })
  sourceCenter.x /= pairs.length; sourceCenter.y /= pairs.length
  const targetCenter = pairs.reduce((sum, pair) => ({ x: sum.x + pair.target.x, y: sum.y + pair.target.y }), { x: 0, y: 0 })
  targetCenter.x /= pairs.length; targetCenter.y /= pairs.length
  const ordered = [...pairs].sort((a, b) => Math.atan2(a.source.y - sourceCenter.y, a.source.x - sourceCenter.x) - Math.atan2(b.source.y - sourceCenter.y, b.source.x - sourceCenter.x))
  ctx.save(); ctx.globalAlpha = readUvWarpWeight()
  for (let i = 0; i < ordered.length; i += 1) {
    const next = ordered[(i + 1) % ordered.length]
    drawMappedTriangle(ctx, source, [sourceCenter, ordered[i].source, next.source], [targetCenter, ordered[i].target, next.target])
  }
  ctx.restore()
  return true
}

type WarpTriangle = [number, number, number]

function delaunayTriangles(points: Point2[]): WarpTriangle[] {
  if (points.length < 3) return []
  const bounds = points.reduce((box, point) => ({
    minX: Math.min(box.minX, point.x), maxX: Math.max(box.maxX, point.x),
    minY: Math.min(box.minY, point.y), maxY: Math.max(box.maxY, point.y),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1)
  const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  const work = [...points,
    { x: center.x - span * 20, y: center.y - span * 3 },
    { x: center.x, y: center.y + span * 20 },
    { x: center.x + span * 20, y: center.y - span * 3 },
  ]
  let triangles: WarpTriangle[] = [[points.length, points.length + 1, points.length + 2]]
  const circumcircleContains = (triangle: WarpTriangle, point: Point2) => {
    const a = work[triangle[0]], b = work[triangle[1]], c = work[triangle[2]]
    const ax = a.x - point.x, ay = a.y - point.y
    const bx = b.x - point.x, by = b.y - point.y
    const cx = c.x - point.x, cy = c.y - point.y
    const determinant = (ax * ax + ay * ay) * (bx * cy - cx * by)
      - (bx * bx + by * by) * (ax * cy - cx * ay)
      + (cx * cx + cy * cy) * (ax * by - bx * ay)
    const orientation = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    return orientation > 0 ? determinant > 0 : determinant < 0
  }
  for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
    const bad = triangles.filter(triangle => circumcircleContains(triangle, work[pointIndex]))
    const edges: Array<[number, number]> = []
    bad.forEach(triangle => {
      for (let i = 0; i < 3; i += 1) {
        const edge: [number, number] = [triangle[i], triangle[(i + 1) % 3]]
        const reverse = edges.findIndex(existing => existing[0] === edge[1] && existing[1] === edge[0])
        if (reverse >= 0) edges.splice(reverse, 1)
        else edges.push(edge)
      }
    })
    triangles = triangles.filter(triangle => !bad.includes(triangle))
    edges.forEach(([a, b]) => triangles.push([a, b, pointIndex]))
  }
  return triangles.filter(triangle => triangle.every(index => index < points.length))
}

function drawDenseCorrespondedWarp(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  sourceLandmarks: StoredLandmark[],
  targetLandmarks: Point2[],
) {
  const pairs = sourceLandmarks.map((point, index) => {
    const target = targetLandmarks[index]
    return target ? {
      source: { x: point.x * source.width, y: point.y * source.height },
      target,
    } : null
  }).filter((pair): pair is { source: Point2; target: Point2 } => Boolean(pair))
  if (pairs.length < 50) return 0
  const triangles = delaunayTriangles(pairs.map(pair => pair.source))
  ctx.save(); ctx.globalAlpha = readUvWarpWeight()
  triangles.forEach(([a, b, c]) => drawMappedTriangle(
    ctx,
    source,
    [pairs[a].source, pairs[b].source, pairs[c].source],
    [pairs[a].target, pairs[b].target, pairs[c].target],
  ))
  ctx.restore()
  return triangles.length
}

function alignFaceFeaturesInUv(
  ctx: CanvasRenderingContext2D,
  face: FaceTextureData,
  mesh: THREE.Mesh,
  texture: THREE.Texture,
  width: number,
  height: number,
  textureLandmarks: Point2[] | null = null,
) {
  // This function is called only for a material already identified as a face
  // material. Do not reject unnamed GLB head meshes here; that made the pure
  // UV preview silently become fully transparent.
  if (!face.landmarks?.length) return 0
  const leftEye = featureBox(face.landmarks, [362, 263, 386, 374, 385, 380])
  const rightEye = featureBox(face.landmarks, [33, 133, 159, 145, 160, 144])
  const brows = featureBox(face.landmarks, [70, 63, 105, 66, 107, 336, 296, 334, 293, 300])
  const nose = featureBox(face.landmarks, [1, 2, 98, 327, 168, 195])
  const mouth = featureBox(face.landmarks, [61, 291, 13, 14, 78, 308, 82, 312])
  let aligned = 0
  // When both images have landmarks, use the same landmark IDs and triangulate
  // each feature independently. Geometry UV regions are only a fallback for
  // an existing texture where a face detector cannot find a frontal face.
  const warp = (indices: number[], sourceBox: FeatureBox, fallback: Point2[]) => {
    if (textureLandmarks && drawCorrespondedFeatureWarp(ctx, face.original, face.landmarks!, textureLandmarks, indices)) return true
    return drawPiecewiseFeatureWarp(ctx, face.original, sourceBox, fallback)
  }
  if (warp([362, 263, 386, 374, 385, 380], leftEye, morphFeatureUvPoints(mesh, texture, width, height, /eye.*(left|_l|\.l)|blink.*(left|_l|\.l)|squint.*(left|_l|\.l)/i))) aligned += 1
  if (warp([33, 133, 159, 145, 160, 144], rightEye, morphFeatureUvPoints(mesh, texture, width, height, /eye.*(right|_r|\.r)|blink.*(right|_r|\.r)|squint.*(right|_r|\.r)/i))) aligned += 1
  if (warp([70, 63, 105, 66, 107, 336, 296, 334, 293, 300], brows, morphFeatureUvPoints(mesh, texture, width, height, /brow/i))) aligned += 1
  if (warp([1, 2, 98, 327, 168, 195], nose, noseFeatureUvPoints(mesh, texture, width, height))) aligned += 1
  if (warp([61, 291, 13, 14, 78, 308, 82, 312], mouth, morphFeatureUvPoints(mesh, texture, width, height, /mouth|jaw|viseme|phoneme/i))) aligned += 1
  return aligned
}

function solveAffineLeastSquares(source: Point2[], target: Point2[]) {
  if (source.length !== target.length || source.length < 3) return null
  // Solve [x y 1] * [a c e; b d f] = [u v] using normal equations.
  const ata = Array.from({ length: 3 }, () => [0, 0, 0])
  const atx = [0, 0, 0]
  const aty = [0, 0, 0]
  source.forEach((point, index) => {
    const row = [point.x, point.y, 1]
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) ata[r][c] += row[r] * row[c]
      atx[r] += row[r] * target[index].x
      aty[r] += row[r] * target[index].y
    }
  })
  const solve = (matrix: number[][], rhs: number[]) => {
    const m = matrix.map((row, i) => [...row, rhs[i]])
    for (let col = 0; col < 3; col += 1) {
      let pivot = col
      for (let row = col + 1; row < 3; row += 1) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row
      if (Math.abs(m[pivot][col]) < 0.000001) return null
      ;[m[col], m[pivot]] = [m[pivot], m[col]]
      const divisor = m[col][col]
      for (let c = col; c < 4; c += 1) m[col][c] /= divisor
      for (let row = 0; row < 3; row += 1) {
        if (row === col) continue
        const factor = m[row][col]
        for (let c = col; c < 4; c += 1) m[row][c] -= factor * m[col][c]
      }
    }
    return [m[0][3], m[1][3], m[2][3]]
  }
  const x = solve(ata, atx), y = solve(ata, aty)
  if (!x || !y) return null
  return { a: x[0], c: x[1], e: x[2], b: y[0], d: y[1], f: y[2] }
}

function center(box: FeatureBox | PixelBox): Point2 {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

function drawLandmarkAlignedFaceToUv(
  ctx: CanvasRenderingContext2D,
  face: FaceTextureData,
  mesh: THREE.Mesh,
  texture: THREE.Texture,
  width: number,
  height: number,
) {
  if (!face.landmarks || !/head|face|wolf3d_head|avatar_head|avatar_face/i.test(mesh.name || '')) return false
  // Keep the landmark set paired with this exact original image. Reading storage
  // again here can mix a previous crop/alignment session into the UV transform.
  const sourceFeatures = featureGeometryFromLandmarks(face.landmarks)
  if (!sourceFeatures) return false
  const leftTarget = morphFeatureUvBox(mesh, texture, width, height, /eye.*(left|_l|\.l)|blink.*(left|_l|\.l)|squint.*(left|_l|\.l)/i)
  const rightTarget = morphFeatureUvBox(mesh, texture, width, height, /eye.*(right|_r|\.r)|blink.*(right|_r|\.r)|squint.*(right|_r|\.r)/i)
  const mouthTarget = morphFeatureUvBox(mesh, texture, width, height, /mouth|jaw|viseme|phoneme/i)
  const noseTarget = noseFeatureUvBox(mesh, texture, width, height)
  const browsTarget = morphFeatureUvBox(mesh, texture, width, height, /brow/i)
  const targets = [leftTarget, rightTarget, browsTarget, noseTarget, mouthTarget]
  const sourceBoxes = [sourceFeatures.leftEye, sourceFeatures.rightEye, sourceFeatures.brows, sourceFeatures.nose, sourceFeatures.mouth]
  const sourcePoints: Point2[] = []
  const targetPoints: Point2[] = []
  targets.forEach((target, index) => {
    if (!target) return
    sourcePoints.push({ x: sourceBoxes[index].x * face.projection.width, y: sourceBoxes[index].y * face.projection.height })
    targetPoints.push(center(target))
  })
  const transform = solveAffineLeastSquares(sourcePoints, targetPoints)
  if (!transform) return false

  const geometry = mesh.geometry as THREE.BufferGeometry
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined
  const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
  if (!position?.count || !uv?.count) return false
  const index = geometry.index
  const triangleCount = index ? Math.floor(index.count / 3) : Math.floor(position.count / 3)
  const textureY = (v: number) => (texture.flipY ? 1 - v : v) * height
  ctx.save()
  ctx.globalAlpha = 0.72
  ctx.beginPath()
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const i0 = index ? index.getX(triangle * 3) : triangle * 3
    const i1 = index ? index.getX(triangle * 3 + 1) : triangle * 3 + 1
    const i2 = index ? index.getX(triangle * 3 + 2) : triangle * 3 + 2
    if (normal && (normal.getZ(i0) + normal.getZ(i1) + normal.getZ(i2)) / 3 < 0.12) continue
    ctx.moveTo(uv.getX(i0) * width, textureY(uv.getY(i0)))
    ctx.lineTo(uv.getX(i1) * width, textureY(uv.getY(i1)))
    ctx.lineTo(uv.getX(i2) * width, textureY(uv.getY(i2)))
    ctx.closePath()
  }
  ctx.clip()
  ctx.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f)
  ctx.drawImage(face.projection, 0, 0)
  ctx.restore()
  return true
}

async function transferFaceAppearance(
  source: THREE.Texture,
  face: FaceTextureData,
  mesh: THREE.Mesh,
  onStages?: (stages: IntermediateTextureStages) => void,
): Promise<THREE.CanvasTexture | null> {
  const image = source.image as CanvasImageSource & {
    width?: number
    height?: number
    naturalWidth?: number
    naturalHeight?: number
    videoWidth?: number
    videoHeight?: number
  }
  const width = image?.naturalWidth || image?.videoWidth || image?.width || 0
  const height = image?.naturalHeight || image?.videoHeight || image?.height || 0
  if (!width || !height) return null

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  try { ctx.drawImage(image, 0, 0, width, height) } catch { return null }
  const originalDataUrl = canvas.toDataURL('image/png')

  // Keep stage 1 as the untouched GLB map. For the final composite, bring
  // only the remaining skin-like base pixels toward the selected skin tone;
  // dark details and facial features retain their original luminance.
  const projectionDataUrl = face.projection.toDataURL('image/png')
  const textureLandmarks = await detectTextureLandmarks(source)
  harmonizeRemainingSkinTone(ctx, face.color)
  // Stage 2 is a pure UV image made from the registered source image only.
  // Keep it separate from the final GLB texture so the diagnostic preview
  // cannot hide the actual feature-level mapping under the base texture.
  const uvCanvas = document.createElement('canvas')
  uvCanvas.width = width
  uvCanvas.height = height
  const uvCtx = uvCanvas.getContext('2d')
  if (!uvCtx) return null
  const uvTriangleCount = textureLandmarks?.length && face.landmarks?.length
    ? drawDenseCorrespondedWarp(uvCtx, face.original, face.landmarks, textureLandmarks)
    : 0
  const featureWarpCount = uvTriangleCount > 0 ? 5 : alignFaceFeaturesInUv(uvCtx, face, mesh, source, width, height, textureLandmarks)
  // The same piecewise mapping is then composited onto the existing GLB map.
  if (uvTriangleCount > 0) drawDenseCorrespondedWarp(ctx, face.original, face.landmarks!, textureLandmarks!)
  else alignFaceFeaturesInUv(ctx, face, mesh, source, width, height, textureLandmarks)
  const featureUvDataUrl = uvCanvas.toDataURL('image/png')
  const finalDataUrl = canvas.toDataURL('image/png')
  onStages?.({ original: originalDataUrl, projection: projectionDataUrl, uvAligned: featureUvDataUrl, final: finalDataUrl, sourceMode: face.sourceMode, landmarkCount: face.landmarks?.length ?? 0, featureWarpCount, textureLandmarkCount: textureLandmarks?.length ?? 0, uvTriangleCount })

  const texture = new THREE.CanvasTexture(canvas)
  texture.name = `${source.name || 'glb-face'}-personalized`
  // Stage 4 is an sRGB canvas export. Keep the same color interpretation in
  // the 3D material instead of inheriting a GLB color-space flag that can
  // brighten or wash out the selected texture.
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = source.flipY
  texture.wrapS = source.wrapS
  texture.wrapT = source.wrapT
  texture.magFilter = source.magFilter
  texture.minFilter = source.minFilter
  texture.generateMipmaps = source.generateMipmaps
  texture.repeat.copy(source.repeat)
  texture.offset.copy(source.offset)
  texture.center.copy(source.center)
  texture.rotation = source.rotation
  texture.needsUpdate = true
  return texture
}

function materialLabel(mesh: THREE.Mesh, material: THREE.Material) {
  return `${mesh.name || ''} ${material.name || ''}`
}

function isFaceMaterial(mesh: THREE.Mesh, material: THREE.Material) {
  const label = materialLabel(mesh, material)
  return FACE_MATERIAL_RE.test(label) && !FACE_MATERIAL_EXCLUDE_RE.test(label)
}

async function withFaceTexture(
  mesh: THREE.Mesh,
  material: THREE.Material,
  face: FaceTextureData,
  cache: Map<string, THREE.CanvasTexture>,
  generated: THREE.Texture[],
  onStages?: (stages: IntermediateTextureStages) => void,
): Promise<THREE.Material> {
  // The stage-4 preview is the final pixel result. A PBR material would apply
  // scene lights, environment reflections and the original GLB tint again,
  // making the avatar visibly brighter/different from that preview. Use an
  // unlit material for face maps so the pixels shown in stage 4 are the pixels
  // rendered on the avatar.
  const exactness = readFaceTextureExactness()
  const brightness = readFaceTextureBrightness()
  const exactTextureMode = exactness >= 0.999
  const next = exactTextureMode
    ? new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: material.transparent,
      opacity: material.opacity,
      alphaTest: material.alphaTest,
      side: material.side,
      vertexColors: material.vertexColors,
    })
    : material.clone() as THREE.MeshStandardMaterial
  next.name = material.name
  // MeshBasicMaterial is still tone-mapped by default. Disable that second
  // color transform so 100% exactness matches the stage-4 sRGB canvas pixels.
  if (exactTextureMode) next.toneMapped = false
  if (exactTextureMode) next.color.setScalar(brightness)
  const originalMap = (material as THREE.MeshStandardMaterial).map
  if (originalMap) {
    const cacheKey = `${(material as THREE.MeshStandardMaterial).map?.uuid ?? 'map'}:${mesh.uuid}`
    let transferred = cache.get(cacheKey)
    if (!transferred) {
      transferred = await transferFaceAppearance((material as THREE.MeshStandardMaterial).map!, face, mesh, onStages) ?? undefined
      if (transferred) {
        cache.set(cacheKey, transferred)
        generated.push(transferred)
      }
    }
    if (transferred) next.map = transferred
    if (next instanceof THREE.MeshStandardMaterial) {
      next.roughness = Math.max(0.62, next.roughness ?? 0.7)
      next.metalness = Math.min(0.03, next.metalness ?? 0)
    }
  } else {
    next.map = face.texture
  }
  next.needsUpdate = true
  return next
}

async function applyRegisteredFaceTexture(root: THREE.Object3D, face: FaceTextureData, onStages?: (stages: IntermediateTextureStages) => void) {
  let applied = 0
  const generated: THREE.Texture[] = [face.texture]
  const cache = new Map<string, THREE.CanvasTexture>()
  const meshes: THREE.Mesh[] = []
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh
    if (mesh.isMesh && mesh.material) meshes.push(mesh)
  })
  for (const mesh of meshes) {
    if (Array.isArray(mesh.material)) {
      let changed = false
      const materials: THREE.Material[] = []
      for (const mat of mesh.material) {
        if (!isFaceMaterial(mesh, mat)) { materials.push(mat); continue }
        changed = true
        applied += 1
        materials.push(await withFaceTexture(mesh, mat, face, cache, generated, onStages))
      }
      if (changed) mesh.material = materials
      continue
    }
    if (isFaceMaterial(mesh, mesh.material)) {
      mesh.material = await withFaceTexture(mesh, mesh.material, face, cache, generated, onStages)
      applied += 1
    }
  }
  return { applied, generated }
}

function inspectFaceMeshes(root: THREE.Object3D): FaceMeshDiagnostic[] {
  const diagnostics: FaceMeshDiagnostic[] = []
  root.traverse(obj => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const geometry = mesh.geometry as THREE.BufferGeometry
    const position = geometry.getAttribute('position')
    const uv = geometry.getAttribute('uv')
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material].filter(Boolean)
    const materialNames = materials.map(mat => mat?.name || '(unnamed)').join(', ')
    const label = `${mesh.name || '(unnamed mesh)'} ${materialNames}`
    const matched = FACE_MATERIAL_RE.test(label) && !FACE_MATERIAL_EXCLUDE_RE.test(label)
    if (!matched && !/head|face|skin|wolf3d/i.test(label)) return

    let uvRange = 'none'
    if (uv?.count) {
      let minU = Number.POSITIVE_INFINITY
      let maxU = Number.NEGATIVE_INFINITY
      let minV = Number.POSITIVE_INFINITY
      let maxV = Number.NEGATIVE_INFINITY
      for (let i = 0; i < uv.count; i += 1) {
        const u = uv.getX(i)
        const v = uv.getY(i)
        minU = Math.min(minU, u)
        maxU = Math.max(maxU, u)
        minV = Math.min(minV, v)
        maxV = Math.max(maxV, v)
      }
      uvRange = `u ${minU.toFixed(2)}-${maxU.toFixed(2)}, v ${minV.toFixed(2)}-${maxV.toFixed(2)}`
    }

    diagnostics.push({
      mesh: mesh.name || '(unnamed mesh)',
      material: materialNames || '(no material)',
      vertices: position?.count ?? 0,
      uvCount: uv?.count ?? 0,
      uvRange,
      matched,
    })
  })
  return diagnostics.sort((a, b) => Number(b.matched) - Number(a.matched) || b.vertices - a.vertices)
}

interface Props {
  settings: Settings
  messages: ChatMsg[]
  setMessages: Dispatch<SetStateAction<ChatMsg[]>>
}

export default function RealisticAvatar({ settings, messages, setMessages }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const viewModeRef = useRef<ViewMode>((localStorage.getItem(VIEW_MODE_KEY) as ViewMode) || 'face')
  const mixerRef = useRef<THREE.AnimationMixer | null>(null)
  const clockRef = useRef(new THREE.Clock())
  const animFrameRef = useRef<number>(0)
  const objectUrlRef = useRef<string | null>(null)
  const loadGenerationRef = useRef(0)
  const envTextureRef = useRef<THREE.Texture | null>(null)
  const faceTextureRefsRef = useRef<THREE.Texture[]>([])
  const alignedFaceTextureRef = useRef(read3dFaceInputSignature())
  const morphMapRef = useRef<Record<string, MorphRef[]>>({})
  const morphGroupsRef = useRef<Record<string, string[]>>({})
  const morphValuesRef = useRef<Record<string, number>>({})
  const lipsyncAnalyserRef = useRef<AnalyserNode | null>(null)
  const activeAudioRef = useRef<HTMLAudioElement | null>(null)
  const lipCuesRef = useRef<LipCue[]>([])
  // 응답이 연달아 오면 이전 TTS 재생을 즉시 중단하고 최신 응답의 음성만 재생한다.
  const ttsGenRef = useRef(0)
  const emotionRef = useRef<Emotion>('neutral')
  const blinkKeysRef = useRef<string[]>([])
  const blinkStateRef = useRef<{ phase: 'idle' | 'closing' | 'opening'; elapsed: number; next: number }>({ phase: 'idle', elapsed: 0, next: 2000 + Math.random() * 3000 })

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [avatarLoaded, setAvatarLoaded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [fileName, setFileName] = useState(() => localStorage.getItem(AVATAR_FILE_KEY) || '')
  const [serverOnline, setServerOnline] = useState(true)
  const [glbList, setGlbList] = useState<GlbEntry[]>([])
  const [showList, setShowList] = useState(false)
  const [showGuide, setShowGuide] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>(() => viewModeRef.current)
  const [faceTextureStatus, setFaceTextureStatus] = useState('')
  const [intermediateTextureStages, setIntermediateTextureStages] = useState<IntermediateTextureStages | null>(null)
  const [uvWarpWeight, setUvWarpWeight] = useState(readUvWarpWeight)
  const [faceTextureExactness, setFaceTextureExactness] = useState(readFaceTextureExactness)
  const [faceTextureBrightness, setFaceTextureBrightness] = useState(readFaceTextureBrightness)
  const [showDebugDetails, setShowDebugDetails] = useState(false)
  const [alignedFeatureGeometry, setAlignedFeatureGeometry] = useState<AlignedFeatureGeometry | null>(readAlignedFeatureGeometry)
  const [faceMeshDiagnostics, setFaceMeshDiagnostics] = useState<FaceMeshDiagnostic[]>([])
  const [glbFeatureSupport, setGlbFeatureSupport] = useState<GlbFeatureSupport | null>(null)

  const setView = useCallback((mode: ViewMode) => {    setViewMode(mode); viewModeRef.current = mode
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

  useEffect(() => { refreshList() }, [refreshList])

  const checkServer = useCallback(async () => {
    try {
      const res = await fetch(`${API}/stats`, { signal: AbortSignal.timeout(2000) })
      setServerOnline(res.ok)
      return res.ok
    } catch {
      setServerOnline(false)
      return false
    }
  }, [])

  useEffect(() => { checkServer() }, [])

  // 음성 옵션 — '내 목소리'(XTTS 클로닝) + 서버 제공 템플릿 목소리만 사용
  const voiceOptions: VoiceOption[] = [MY_VOICE, ...TEMPLATE_VOICES]
  const [voiceOptionId, setVoiceOptionId] = useState(() => {
    try { localStorage.setItem(VOICE_OPTION_KEY, MY_VOICE.id) } catch { /**/ }
    return MY_VOICE.id
  })
  const selectedVoice = voiceOptions.find(v => v.id === voiceOptionId) || MY_VOICE

  // 채팅
  const [input, setInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const speakingRef = useRef(false)
  // 자동재생이 브라우저 정책에 막히면, 사용자가 직접 눌러서 재생할 수 있는 버튼을 띄운다.
  const [blockedAudio, setBlockedAudio] = useState<HTMLAudioElement | null>(null)
  const sttBusyRef = useRef(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const sendMessageRef = useRef<(t?: string) => void>(() => {})

  // STT
  const [recording, setRecording] = useState(false)
  const [vadActive, setVadActive] = useState(false)
  const [sttBusy, setSttBusy] = useState(false)
  const [sttResult, setSttResult] = useState<{ text: string; language?: string } | null>(null)
  const [sttError, setSttError] = useState('')
  const sttStreamRef = useRef<MediaStream | null>(null)
  const sttCtxRef = useRef<AudioContext | null>(null)
  const sttRecRef = useRef<MediaRecorder | null>(null)
  const sttChunksRef = useRef<Blob[]>([])
  const sttSilenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sttListeningRef = useRef(false)
  const audioCtxRef = useRef<AudioContext | null>(null)

  // AudioContext unlock
  useEffect(() => {
    const unlock = () => {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      audioCtxRef.current.state === 'suspended' && audioCtxRef.current.resume().catch(() => {})
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  }, [])

  // ── TTS ──
  const playTTS = useCallback(async (text: string) => {
    // 응답이 연달아 오면(스트리밍 지연 등으로) 이전 호출의 오디오가 뒤늦게 재생되어
    // 화면에 보이는 최신 답변과 다른 내용을 읽는 문제를 막는다 — 이전 재생을 즉시 끊고,
    // 이 호출 이후에 더 새로운 호출이 시작되면 이 호출은 재생하지 않고 조용히 종료한다.
    const myGen = ++ttsGenRef.current
    if (activeAudioRef.current) { activeAudioRef.current.pause(); activeAudioRef.current = null }
    try { speechSynthesis.cancel() } catch { /**/ }
    setBlockedAudio(null)

    setSpeaking(true); speakingRef.current = true
    emotionRef.current = classifyEmotion(text)
    // 답변이 길면 첫 문장만 읽고 나머지는 채팅창을 보라고 안내 — TTS로 실제 재생되는
    // 텍스트는 이 짧은 버전이다 (긴 텍스트는 XTTS가 느려지거나 실패하기 쉽다).
    const spoken = buildSpokenText(text)
    let finished = false
    const failsafe = setTimeout(() => done(), 2000 + spoken.length * 200)
    const done = () => {
      if (finished) return; finished = true
      clearTimeout(failsafe)
      if (myGen !== ttsGenRef.current) return // 이미 더 새로운 응답으로 대체됨
      setSpeaking(false); speakingRef.current = false
      emotionRef.current = 'neutral'
    }
    try {
      const form = new FormData(); form.append('text', spoken)
      form.append('voice', selectedVoice.kind === 'template' ? selectedVoice.id : 'mine')
      const res = await fetch(`${API}/avatar/tts_only`, { method: 'POST', body: form })
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      if (myGen !== ttsGenRef.current) return // 대기하는 동안 더 새로운 응답이 시작됨
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      activeAudioRef.current = audio
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
      const ctx = audioCtxRef.current
      if (ctx.state === 'suspended') { try { await ctx.resume() } catch { /**/ } }
      if (myGen !== ttsGenRef.current) { URL.revokeObjectURL(url); return }
      // AudioContext가 running이 아니면 립싱크 분석용 그래프에 태우지 않는다 — 그 상태로
      // createMediaElementSource에 연결하면 오디오가 먼 채널로 재생될 수 있다.
      // 립싱크 없이 원본 경로로 재생하더라도 "소리가 나는 것"이 항상 우선이다.
      if (ctx.state === 'running') {
        const src = ctx.createMediaElementSource(audio)
        const analyser = ctx.createAnalyser(); analyser.fftSize = 64
        src.connect(analyser); analyser.connect(ctx.destination)
        lipsyncAnalyserRef.current = analyser
      } else {
        console.warn('[TTS] AudioContext가 running이 아니어서(', ctx.state, ') 립싱크 없이 원본 경로로 재생합니다')
      }
      lipCuesRef.current = []  // 발음 타이밍 큐 도착 전까지는 주파수 대역 근사로 폴백
      const cleanup = () => {
        done()
        if (activeAudioRef.current === audio) activeAudioRef.current = null
        if (myGen === ttsGenRef.current) { lipsyncAnalyserRef.current = null; lipCuesRef.current = [] }
        URL.revokeObjectURL(url)
      }
      audio.onended = cleanup; audio.onerror = cleanup
      audio.play().catch(e => {
        console.error('[TTS] audio.play() 거부됨 — 자동재생 정책일 가능성 높음', e?.name, e?.message)
        // 자동재생 차단 시 지금 바로 정리하지 않고, 사용자가 직접 눌러서 재생할 수 있게 남겨둔다.
        if (myGen === ttsGenRef.current) setBlockedAudio(audio)
        else cleanup()
      })
      // 재생과 별개로 정확한 발음 타이밍 분석 요청 — 도착하면 주파수 근사 대신 이 큐를 사용
      const cuesForm = new FormData(); cuesForm.append('audio', blob, 'tts.wav')
      fetch(`${API}/avatar/lipsync_cues`, { method: 'POST', body: cuesForm })
        .then(r => r.json())
        .then(data => { if (activeAudioRef.current === audio && Array.isArray(data?.cues)) lipCuesRef.current = data.cues })
        .catch(() => {})
    } catch {
      if (myGen !== ttsGenRef.current) return
      const u = new SpeechSynthesisUtterance(spoken)
      u.lang = 'ko-KR'; u.rate = 0.95; u.onend = done; u.onerror = done
      speechSynthesis.speak(u)
    }
  }, [selectedVoice])

  // ── STT ──
  const THRESHOLD = 20
  const SILENCE_MS = 1200

  const transcribeChunk = useCallback(async (chunks: Blob[]) => {
    if (!chunks.length) return
    const blob = new Blob(chunks, { type: 'audio/webm' })
    if (!blob.size) return
    setSttBusy(true); sttBusyRef.current = true
    try {
      const form = new FormData(); form.append('audio', blob, 'stt.webm')
      const res = await fetch(`${API}/stt/transcribe`, { method: 'POST', body: form, signal: AbortSignal.timeout(20000) })
      const data = await res.json()
      if (data.error) { setSttError(data.error) }
      else {
        const text = (data.text || '').trim()
        setSttResult({ text, language: data.language })
        if (text) sendMessageRef.current(text)
      }
    } catch (e) {
      setSttError(e instanceof DOMException && e.name === 'TimeoutError'
        ? '음성 인식이 아직 준비 중이거나 처리가 느립니다 — 잠시 후 다시 시도하세요'
        : '인식 요청 실패 — API 서버 연결을 확인해주세요')
    }
    finally { setSttBusy(false); sttBusyRef.current = false }
  }, [])

  const stopStt = useCallback(() => {
    sttListeningRef.current = false
    if (sttSilenceTimer.current) { clearTimeout(sttSilenceTimer.current); sttSilenceTimer.current = null }
    sttRecRef.current?.stop(); sttRecRef.current = null
    sttCtxRef.current?.close(); sttCtxRef.current = null
    sttStreamRef.current?.getTracks().forEach(t => t.stop()); sttStreamRef.current = null
    setRecording(false); setVadActive(false)
  }, [])

  // 지금 재생 중인(또는 대기 중인) 음성을 즉시 멈춘다. 듣기 모드가 켜져 있으면 함께 끈다 —
  // 아바타 목소리를 마이크가 다시 알아듣고 응답→재생을 반복하는 피드백 루프를 끊기 위함이기도 하다.
  const stopSpeaking = useCallback(() => {
    ttsGenRef.current++ // 아직 도착하지 않은 이전 TTS 응답은 이제 재생되지 않는다
    if (activeAudioRef.current) { activeAudioRef.current.pause(); activeAudioRef.current = null }
    try { speechSynthesis.cancel() } catch { /* ignore */ }
    lipsyncAnalyserRef.current = null
    lipCuesRef.current = []
    setBlockedAudio(null)
    setSpeaking(false); speakingRef.current = false
    emotionRef.current = 'neutral'
    if (recording) stopStt()
  }, [recording, stopStt])

  const startStt = useCallback(async () => {
    if (recording) { stopStt(); return }
    setSttError(''); setSttResult(null); sttBusyRef.current = false
    let stream: MediaStream
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }) }
    catch (e) { setSttError('마이크 접근 실패: ' + (e instanceof Error ? e.message : String(e))); return }
    sttStreamRef.current = stream; sttListeningRef.current = true; setRecording(true)
    const ctx = new AudioContext(); sttCtxRef.current = ctx
    const src = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser(); analyser.fftSize = 512; src.connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)
    let isRecording = false
    const tick = () => {
      if (!sttListeningRef.current) return
      if (speakingRef.current || sttBusyRef.current) { if (!isRecording) { requestAnimationFrame(tick); return } }
      analyser.getByteFrequencyData(buf)
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length
      if (avg > THRESHOLD) {
        setVadActive(true)
        if (sttSilenceTimer.current) { clearTimeout(sttSilenceTimer.current); sttSilenceTimer.current = null }
        if (!isRecording) {
          isRecording = true; sttChunksRef.current = []
          const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
          rec.ondataavailable = e => { if (e.data.size > 0) sttChunksRef.current.push(e.data) }
          rec.onstop = () => { isRecording = false; setVadActive(false); transcribeChunk([...sttChunksRef.current]) }
          rec.start(); sttRecRef.current = rec
        }
        sttSilenceTimer.current = setTimeout(() => {
          sttRecRef.current?.stop(); sttRecRef.current = null; setVadActive(false)
        }, SILENCE_MS)
      }
      requestAnimationFrame(tick)
    }
    tick()
  }, [recording, stopStt, transcribeChunk])

  // 마이크 접근은 사용자가 마이크 버튼을 눌렀을 때만 시작한다.
  useEffect(() => {
    return () => stopStt()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── GLB 로더 ──
  const loadGLB = useCallback((url: string) => {
    const container = containerRef.current
    if (!container) return
    const generation = loadGenerationRef.current + 1
    loadGenerationRef.current = generation
    setLoading(true); setError(''); setAvatarLoaded(false); setFaceTextureStatus(''); setIntermediateTextureStages(null)
    setFaceMeshDiagnostics([])
    setGlbFeatureSupport(null)
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    if (rendererRef.current) { rendererRef.current.dispose(); container.innerHTML = '' }
    faceTextureRefsRef.current.forEach(texture => texture.dispose())
    faceTextureRefsRef.current = []

    const rect = container.getBoundingClientRect()
    const w = rect.width || container.offsetWidth || 800
    const h = rect.height || container.offsetHeight || 600
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setSize(w, h); renderer.setPixelRatio(window.devicePixelRatio)
    renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.shadowMap.enabled = true
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.1
    container.appendChild(renderer.domElement); rendererRef.current = renderer

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x0d1b2a)

    // Avaturn GLB는 glTF PBR(금속/거칠기) 재질이라 환경 반사가 없으면 피부·눈·머리카락이
    // 밋밋한 플라스틱처럼 보인다 — 별도 HDRI 파일 없이 절차적 환경(RoomEnvironment)으로 IBL을 채움
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

    // 얼굴만/상반신/전체 보기 토글에 맞춰 초기 카메라 프레이밍 결정
    const preset = VIEW_PRESETS[viewModeRef.current]
    const camera = new THREE.PerspectiveCamera(preset.fov, w / h, 0.1, 100)
    camera.position.set(...preset.pos)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(...preset.target); controls.enableDamping = true; controls.dampingFactor = 0.05
    controls.minDistance = 0.4; controls.maxDistance = 6; controls.update()
    cameraRef.current = camera; controlsRef.current = controls

    new GLTFLoader().load(url, (gltf) => {
      if (generation !== loadGenerationRef.current) return
      const box = new THREE.Box3().setFromObject(gltf.scene)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const scale = 1.8 / size.y
      gltf.scene.scale.setScalar(scale)
      gltf.scene.position.sub(center.multiplyScalar(scale))
      gltf.scene.position.y += size.y * scale * 0.5 - 0.1
      scene.add(gltf.scene)
      setFaceMeshDiagnostics(inspectFaceMeshes(gltf.scene))
      setGlbFeatureSupport(inspectGlbFeatureSupport(gltf.scene))
      buildRegisteredFaceTexture().then(async face => {
        if (generation !== loadGenerationRef.current) return
        if (!face) { setFaceTextureStatus('선택된 원본 이미지의 landmark/UV source unavailable'); return }
        faceTextureRefsRef.current.forEach(texture => texture.dispose())
        const result = await applyRegisteredFaceTexture(gltf.scene, face, stages => setIntermediateTextureStages(stages))
        if (generation !== loadGenerationRef.current) {
          result.generated.forEach(texture => texture.dispose())
          return
        }
        faceTextureRefsRef.current = result.generated
        setFaceTextureStatus(result.applied > 0 ? `Face texture transferred (${result.applied})` : 'Face material not found')
        if (result.applied === 0) {
          result.generated.forEach(texture => texture.dispose())
          faceTextureRefsRef.current = []
        }
      }).catch(() => setFaceTextureStatus('Face tone failed'))
      if (gltf.animations.length > 0) {
        const mixer = new THREE.AnimationMixer(gltf.scene); mixerRef.current = mixer
        const idle = gltf.animations.find(a => /idle|stand|wait/i.test(a.name)) ?? gltf.animations[0]
        mixer.clipAction(idle).play()
      }

      // 입싱크(viseme 근사) + 표정용 모프타겟 전체 수집
      // 동일한 타겟 이름(jawOpen 등)이 여러 메시(얼굴/눈/치아)에 중복 존재하므로 전부 보관
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
      // 깜빡임은 느린 lerp를 거치면 흐릿해지므로 별도 처리(빠른 닫힘/열림 곡선을 직접 대입)
      blinkKeysRef.current = groups.blink ?? []
      delete groups.blink
      morphGroupsRef.current = groups
      morphValuesRef.current = {}
      if (!Object.values(groups).some(arr => arr.length > 0)) {
        console.warn('[RealisticAvatar] 입싱크/표정용 모프타겟을 GLB에서 찾지 못함 — 비활성')
      }

      setLoading(false); setAvatarLoaded(true)
      const animate = () => {
        animFrameRef.current = requestAnimationFrame(animate)
        const dt = clockRef.current.getDelta()
        mixerRef.current?.update(dt)

        // 자동 눈 깜빡임 — 빠른 닫힘/열림 곡선을 직접 대입(lerp 없이)
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
        const groups = morphGroupsRef.current
        if (Object.keys(groups).length > 0) {
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

          // Rhubarb 발음 타이밍 큐가 도착했으면 그걸로 정확한 입모양을, 아직이면 주파수 대역 근사로 폴백
          const cues = lipCuesRef.current
          const audioEl = activeAudioRef.current
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
          Object.entries(groups).forEach(([group, keys]) => {
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
    }, undefined, (err) => { setError(String(err)); setLoading(false) })
  }, [])

  // 3D 탭에서 새 이미지의 정렬 확인이 끝나면 저장된 얼굴 텍스처가 바뀐다.
  // 공유 tracking 코드는 건드리지 않고 현재 GLB만 다시 로드해 새 texture 정보를 자동 반영한다.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = read3dFaceInputSignature()
      if (current === alignedFaceTextureRef.current) return
      alignedFaceTextureRef.current = current
      setAlignedFeatureGeometry(readAlignedFeatureGeometry())
      if (current && objectUrlRef.current) {
        loadGLB(objectUrlRef.current)
      } else if (current) {
        buildRegisteredFaceTexture().then(face => {
          if (!face) return
          face.texture.dispose()
        }).catch(() => {})
      }
    }, 500)
    return () => window.clearInterval(timer)
  }, [loadGLB])

  // 마운트 시 마지막 GLB 자동 로드
  useEffect(() => {
    const lastName = localStorage.getItem(AVATAR_FILE_KEY)
    if (!lastName) return
    idbList().then(list => {
      const entry = list.find(e => e.name === lastName) || list[0]
      if (entry) {
        const blob = new Blob([entry.data], { type: 'model/gltf-binary' })
        const url = URL.createObjectURL(blob)
        objectUrlRef.current = url
        setFileName(entry.name)
        loadGLB(url)
      }
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleFile = useCallback((file: File) => {
    if (!file.name.endsWith('.glb')) { setError('GLB 파일만 지원합니다'); return }
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

  useEffect(() => () => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    rendererRef.current?.dispose()
    envTextureRef.current?.dispose()
    faceTextureRefsRef.current.forEach(texture => texture.dispose())
    faceTextureRefsRef.current = []
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
  }, [])

  // ── 채팅 ──
  const buildSystemPrompt = useCallback(async (userText: string): Promise<string> => {
    try {
      const res = await fetch(`${API}/avatar/context?q=${encodeURIComponent(userText)}`)
      const data = await res.json()
      if (data?.system) return data.system
    } catch { /**/ }
    return SYSTEM
  }, [])

  const logTurn = useCallback((role: 'user' | 'assistant', content: string) => {
    if (!content.trim()) return
    fetch(`${API}/conversation/log`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ view: 'realistic_avatar', role, content }),
    }).catch(() => {})
  }, [])

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim()
    if (!text || chatLoading) return
    const userMsg: ChatMsg = { role: 'user', content: text }
    setMessages(prev => [...prev, userMsg]); setInput(''); setChatLoading(true)
    logTurn('user', text)
    try {
      const history = [...messages, userMsg].slice(-8)
      const system = await buildSystemPrompt(text)
      let reply = ''
      if (settings.aiProvider === 'ollama') {
        await streamChatOllama(settings.ollamaEndpoint, settings.ollamaModel, history, system,
          d => { reply += d })
      } else {
        let key = settings.claudeSessionKey
        if (!key && settings.mcpEndpoint) key = await claudeWebAutoConnect(settings.mcpEndpoint) || ''
        await streamClaudeWeb(key, settings.mcpEndpoint, history, system,
          d => { reply += d }, settings.anthropicApiKey)
      }
      setMessages(prev => [...prev, { role: 'assistant', content: reply }])
      if (reply) { logTurn('assistant', reply); playTTS(reply) }
    } catch {
      const errMsg = '죄송합니다. 일시적인 오류가 발생했습니다.'
      setMessages(prev => [...prev, { role: 'assistant', content: errMsg }])
      playTTS(errMsg)
    } finally { setChatLoading(false) }
  }, [input, chatLoading, messages, settings, buildSystemPrompt, logTurn, playTTS, setMessages])

  useEffect(() => { sendMessageRef.current = sendMessage }, [sendMessage])
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  // 첫 진입 시 이전 대화 불러오기(있으면 이어서 표시) — 없으면 인사로 시작
  useEffect(() => {
    if (messages.length > 0) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const since = localStorage.getItem(CHAT_SINCE_KEY) || ''
        const res = await fetch(`${API}/conversation/history?view=realistic_avatar&limit=50&since=${encodeURIComponent(since)}`)
        const data = await res.json()
        if (!cancelled && Array.isArray(data?.messages) && data.messages.length > 0) {
          setMessages(data.messages)
          return
        }
      } catch { /* 조회 실패 시 인사로 폴백 */ }
      if (cancelled) return
      setMessages([{ role: 'assistant', content: GREETING }])
      playTTS(GREETING)
    }, 800)
    return () => { cancelled = true; clearTimeout(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 새로 시작: 이전 대화를 더 이상 불러오지 않도록 기준 시각 기록 후 인사로 초기화
  const resetChat = useCallback(() => {
    localStorage.setItem(CHAT_SINCE_KEY, localTimestamp())
    setMessages([{ role: 'assistant', content: GREETING }])
    playTTS(GREETING)
    // XTTS 워커가 죽어있으면(예: 재부팅 후) 여기서도 확인해서 다시 띄운다. 이미 떠 있으면 서버가 아무 것도 안 함.
    fetch(`${API}/avatar/xtts/ensure`, { method: 'POST' }).catch(() => {})
  }, [setMessages, playTTS])

  const isConnected = settings.aiProvider === 'ollama' || !!(settings.claudeSessionKey || settings.anthropicApiKey)

  return (
    <div className="flex h-full overflow-hidden bg-gray-950">
      {/* 음성 서버(TTS·STT) 준비/오류 안내 — 정상일 땐 보이지 않음 */}
      <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] max-w-[92vw] pointer-events-none [&>*]:pointer-events-auto">
        <VoiceServiceBanner />
      </div>
      {/* 3D 뷰어 */}
      <div
        className={`flex-1 relative ${dragging ? 'ring-2 ring-blue-500 ring-inset' : ''}`}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
      >
        <div ref={containerRef} className="w-full h-full" />
        {/* 3D 탭 전용 얼굴 이미지 선택·정렬·웹캠 추적 패널 */}
        <FaceTrackingPanel
          className="absolute bottom-2 left-3 z-30 w-[20rem] max-w-[calc(100%-1rem)] rounded-xl border border-gray-700 bg-black shadow-2xl overflow-hidden"
          preferRegisteredFace
          isolatedVideo
          storageScope="3d"
          imageOnly />

        {showDebugDetails && alignedFeatureGeometry && (
          <div className="absolute bottom-3 right-3 z-30 w-64 rounded-xl border border-cyan-600/70 bg-black/85 p-2 shadow-2xl backdrop-blur">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-cyan-100">Feature align 진단</span>
              <span className="text-[9px] text-gray-500">landmark {alignedFeatureGeometry.landmarkCount}</span>
            </div>
            <div className="space-y-1 text-[9px] text-gray-300">
              {([
                ['왼쪽 눈', alignedFeatureGeometry.leftEye, glbFeatureSupport?.leftEye],
                ['오른쪽 눈', alignedFeatureGeometry.rightEye, glbFeatureSupport?.rightEye],
                ['눈썹', alignedFeatureGeometry.brows, glbFeatureSupport?.brows],
                ['코', alignedFeatureGeometry.nose, glbFeatureSupport?.nose],
                ['입', alignedFeatureGeometry.mouth, glbFeatureSupport?.mouth],
              ] as Array<[string, FeatureBox, boolean | undefined]>).map(([label, box, supported]) => (
                <div key={label} className="grid grid-cols-[3.2rem_1fr_auto] items-center gap-1.5 rounded bg-gray-900/70 px-1.5 py-1">
                  <span>{label}</span>
                  <span className="truncate text-gray-500">x {box.x.toFixed(3)} · y {box.y.toFixed(3)} · {box.width.toFixed(3)}×{box.height.toFixed(3)}</span>
                  <span className={supported ? 'text-emerald-300' : 'text-amber-300'}>{supported ? 'UV 가능' : '확인 필요'}</span>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[9px] leading-tight text-gray-400">영상 landmark와 GLB feature UV를 각각 대응시켜 정렬합니다.</p>
          </div>
        )}

        {/* 파일 선택 + 목록 (좌상단) */}
        <div className="absolute top-3 left-3 z-20 flex flex-col gap-1">
          <div className="flex gap-1">
            <label className="flex items-center gap-2 bg-black/50 backdrop-blur text-xs text-gray-300 hover:text-white rounded-lg px-3 py-1.5 cursor-pointer border border-gray-700 hover:border-gray-500 transition-colors">
              📁 GLB 파일 선택
              <input type="file" accept=".glb" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
            </label>
            {glbList.length > 0 && (
              <button
                onClick={() => setShowList(v => !v)}
                className="bg-black/50 backdrop-blur text-xs text-gray-300 hover:text-white rounded-lg px-2 py-1.5 border border-gray-700 hover:border-gray-500 transition-colors"
                title="저장된 아바타 목록"
              >
                {showList ? '▲' : '▼'} {glbList.length}
              </button>
            )}
          </div>
          {avatarLoaded && fileName && (
            <p className="text-[10px] text-gray-400 px-1 truncate max-w-[220px]">현재: {fileName}</p>
          )}
          {faceTextureStatus && (
            <div className="flex items-center gap-1 px-1">
              <p className="min-w-0 flex-1 truncate text-[10px] text-purple-200/90">{faceTextureStatus}</p>
              {avatarLoaded && objectUrlRef.current && (
                <button
                  onClick={() => loadGLB(objectUrlRef.current || '')}
                  className="shrink-0 rounded border border-purple-400/60 px-1.5 py-0.5 text-[9px] text-purple-200 hover:bg-purple-500/20"
                >
                  원본 UV 다시 적용
                </button>
              )}
            </div>
          )}
          {intermediateTextureStages && (
            <div className="mt-1 w-[300px] rounded-xl border border-purple-500/40 bg-black/75 p-2 text-[10px] text-gray-300 backdrop-blur">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium text-purple-100">Texture stages</span>
                <button onClick={() => setShowDebugDetails(v => !v)} className="text-gray-400 hover:text-white">{showDebugDetails ? '간단히' : '상세'}</button>
              </div>
              <div className="mb-1.5 rounded bg-gray-950/90 px-1.5 py-1 text-[9px] leading-relaxed">
                <div>source: <span className={intermediateTextureStages.sourceMode === 'selected-aligned' || intermediateTextureStages.sourceMode === 'selected-image' || intermediateTextureStages.sourceMode === 'selected-detected' || intermediateTextureStages.sourceMode === 'aligned-display-fallback' || intermediateTextureStages.sourceMode === 'jingu-front' || intermediateTextureStages.sourceMode.startsWith('original') ? 'text-emerald-300' : 'text-amber-300'}>{intermediateTextureStages.sourceMode}</span></div>
                <div>landmarks: <span className="text-cyan-200">{intermediateTextureStages.landmarkCount}</span></div>
                <div>existing texture landmarks: <span className={intermediateTextureStages.textureLandmarkCount > 0 ? 'text-emerald-300' : 'text-amber-300'}>{intermediateTextureStages.textureLandmarkCount || 'geometry UV fallback'}</span></div>
                <div>whole-face UV triangles: <span className={intermediateTextureStages.uvTriangleCount > 0 ? 'text-emerald-300' : 'text-amber-300'}>{intermediateTextureStages.uvTriangleCount || 'feature fallback'}</span></div>
                <div>feature UV warps: <span className={intermediateTextureStages.featureWarpCount > 0 ? 'text-emerald-300' : 'text-red-300'}>{intermediateTextureStages.featureWarpCount} / 5</span></div>
                <div className="mt-1 border-t border-gray-800 pt-1">
                  <div className="flex items-center justify-between"><span>warped UV weight</span><span className="text-cyan-200">{Math.round(uvWarpWeight * 100)}%</span></div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={uvWarpWeight}
                    onChange={event => {
                      const value = Number(event.target.value)
                      setUvWarpWeight(value)
                      localStorage.setItem(UV_WARP_WEIGHT_KEY, String(value))
                      if (objectUrlRef.current) loadGLB(objectUrlRef.current)
                    }}
                    className="mt-1 w-full accent-cyan-400"
                    aria-label="warped UV texture weight"
                  />
                  <div className="flex justify-between text-[8px] text-gray-500"><span>기존 texture</span><span>warped UV</span></div>
                </div>
                <div className="mt-1 border-t border-gray-800 pt-1">
                  <div className="flex items-center justify-between">
                    <span>3D texture exactness</span>
                    <span className="text-cyan-200">{Math.round(faceTextureExactness * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={faceTextureExactness}
                    onChange={event => {
                      const value = Number(event.target.value)
                      setFaceTextureExactness(value)
                      localStorage.setItem(FACE_TEXTURE_EXACTNESS_KEY, String(value))
                      if (objectUrlRef.current) loadGLB(objectUrlRef.current)
                    }}
                    className="mt-1 w-full accent-purple-400"
                    aria-label="3D texture exactness"
                  />
                  <div className="flex justify-between text-[8px] text-gray-500"><span>3D 조명</span><span>4 최종 texture 그대로</span></div>
                </div>
                <div className="mt-1 border-t border-gray-800 pt-1">
                  <div className="flex items-center justify-between">
                    <span>3D texture brightness</span>
                    <span className="text-cyan-200">{Math.round(faceTextureBrightness * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.5"
                    max="1.25"
                    step="0.01"
                    value={faceTextureBrightness}
                    onChange={event => {
                      const value = Number(event.target.value)
                      setFaceTextureBrightness(value)
                      localStorage.setItem(FACE_TEXTURE_BRIGHTNESS_KEY, String(value))
                      if (objectUrlRef.current) loadGLB(objectUrlRef.current)
                    }}
                    className="mt-1 w-full accent-amber-400"
                    aria-label="3D texture brightness"
                  />
                  <div className="flex justify-between text-[8px] text-gray-500"><span>어둡게</span><span>밝게</span></div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  ['original', '기존 texture - 저장'],
                  ['uvAligned', '2 정렬 영상 · warped UV only'],
                  ['projection', '3 정렬 source'],
                  ['final', '4 최종 texture'],
                ] as const).map(([key, label]) => (
                  <a key={key} href={intermediateTextureStages[key]} download={`avatar-${key}.png`} className="group rounded-lg border border-gray-700 bg-gray-950/80 p-1 hover:border-purple-400">
                    <img src={intermediateTextureStages[key]} alt={label} className="h-20 w-full rounded object-contain bg-black" />
                    <span className="mt-1 block truncate text-center text-[9px] text-gray-400 group-hover:text-purple-200">{key === 'original' ? label : `${label} · 저장`}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          {showDebugDetails && avatarLoaded && faceMeshDiagnostics.length > 0 && (
            <div className="mt-1 w-[260px] rounded-xl border border-gray-700 bg-black/60 p-2 text-[10px] text-gray-300 backdrop-blur">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium text-gray-200">GLB face UV</span>
                <span className="text-gray-500">{faceMeshDiagnostics.length}</span>
              </div>
              <div className="max-h-28 space-y-1 overflow-y-auto pr-1">
                {faceMeshDiagnostics.slice(0, 6).map((item, index) => (
                  <div key={`${item.mesh}-${index}`} className={item.matched ? 'text-purple-100' : 'text-gray-400'}>
                    <div className="truncate">
                      {item.matched ? 'target ' : 'candidate '}
                      {item.mesh}
                    </div>
                    <div className="truncate text-gray-500">
                      {item.material} · vtx {item.vertices} · uv {item.uvCount} · {item.uvRange}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <button
            onClick={() => setShowGuide(v => !v)}
            className="self-start text-[10px] text-gray-400 hover:text-white px-1 text-left"
          >
            {showGuide ? '▲' : '❓'} GLB 만드는 법
          </button>
          {showGuide && (
            <div className="bg-black/80 backdrop-blur border border-gray-700 rounded-xl p-3 max-w-[260px] text-[11px] text-gray-300 space-y-1.5 leading-relaxed">
              <p>1. 본인 정면 얼굴 사진 준비</p>
              <p>
                2. <a href="https://avaturn.me" target="_blank" rel="noreferrer" className="text-purple-300 underline">avaturn.me</a>에서
                사진 업로드 → 아바타 커스터마이즈
              </p>
              <p className="text-amber-300">
                ⚠️ 얼굴 타입은 꼭 <b>T2</b> 선택 (T1은 얼굴 고정이라 입이 안 움직임)
              </p>
              <p>3. Download → glTF Binary(.glb)로 저장</p>
              <p>4. 위 "GLB 파일 선택"으로 불러오기</p>
            </div>
          )}
          {showList && (
            <div className="bg-black/80 backdrop-blur border border-gray-700 rounded-xl overflow-hidden min-w-[220px] max-h-64 overflow-y-auto">
              {glbList.map(entry => (
                <div key={entry.name} className="flex items-center gap-1 px-2 py-1.5 hover:bg-gray-800/80 group">
                  <button
                    onClick={() => loadFromIDB(entry)}
                    className="flex-1 text-left text-xs text-gray-300 hover:text-white truncate"
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

        {/* 목소리 선택 (우상단) */}
        <div className="absolute top-3 right-3 z-20 flex flex-col items-end gap-2 bg-black/40 backdrop-blur rounded-xl p-2">
          <div>
            <span className="text-[10px] text-gray-400 px-1">보기</span>
            <div className="flex flex-wrap justify-end gap-1 max-w-[12rem]">
              {(['face', 'upper', 'full'] as ViewMode[]).map(m => (
                <button key={m} onClick={() => setView(m)}
                  className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${viewMode === m ? 'bg-purple-600 border-purple-400 text-white' : 'bg-gray-800/70 border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
                  {VIEW_MODE_LABELS[m]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="text-[10px] text-gray-400 px-1">목소리</span>
            <div className="flex flex-wrap justify-end gap-1 max-w-[12rem]">
              {voiceOptions.map(v => (
                <button key={v.id} onClick={() => { setVoiceOptionId(v.id); localStorage.setItem(VOICE_OPTION_KEY, v.id) }}
                  className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${voiceOptionId === v.id ? 'bg-purple-600 border-purple-400 text-white' : 'bg-gray-800/70 border-gray-600 text-gray-300 hover:bg-gray-700'}`}>
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* 안내 / 로딩 / 에러 */}
        {!avatarLoaded && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-600 gap-2 pointer-events-none">
            <p className="text-sm">GLB 파일을 드래그하거나 좌상단에서 선택하세요</p>
          </div>
        )}
        {loading && <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm pointer-events-none">아바타 로딩 중...</div>}
        {dragging && <div className="absolute inset-0 flex items-center justify-center bg-blue-900/30 text-blue-300 text-lg font-semibold pointer-events-none">GLB 파일을 놓으세요</div>}

        {speaking && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-black/50 backdrop-blur px-4 py-2 rounded-full">
            <div className="flex gap-1 items-end">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="w-1 bg-blue-400 rounded-full animate-bounce" style={{ height: `${8 + Math.sin(i * 1.2) * 7}px`, animationDelay: `${i * 0.1}s` }} />
              ))}
            </div>
            <span className="text-xs text-blue-300">말하는 중</span>
            <button onClick={stopSpeaking}
              className="ml-1 text-xs px-2 py-0.5 rounded-full border border-red-500 bg-red-900/70 text-red-300 hover:bg-red-800 transition">
              ■ 중단
            </button>
          </div>
        )}
        {blockedAudio && (
          <button
            onClick={() => { blockedAudio.play().then(() => setBlockedAudio(null)).catch(() => {}) }}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-yellow-900/80 border border-yellow-500 backdrop-blur px-4 py-2 rounded-full text-xs text-yellow-200 hover:bg-yellow-800 transition animate-pulse">
            🔇 자동재생이 차단됨 — 눌러서 재생
          </button>
        )}
        {error && <div className="absolute bottom-4 left-4 right-4 bg-red-900/80 text-red-200 text-xs p-2 rounded">{error}</div>}
      </div>

      {/* 채팅 패널 — Avatar3DChat과 동일 구조 */}
      <div className="w-80 flex flex-col border-l border-gray-800 bg-gray-900/95">
        <div className="px-4 py-3 border-b border-gray-800 bg-gray-900">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400' : 'bg-red-400'}`} />
              <h2 className="text-sm font-semibold text-gray-200">실사 아바타</h2>
            </div>
            <button onClick={resetChat}
              className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 rounded px-2 py-0.5 hover:bg-gray-800">
              새로 시작
            </button>
          </div>
          <div className="flex items-center justify-between mt-0.5">
            <p className="text-xs text-gray-500">
              {isConnected ? '응답 시 자동으로 음성 재생' : '설정에서 API Key를 입력해주세요'}
            </p>
            <div className="flex items-center gap-1">
              <div className={`w-1.5 h-1.5 rounded-full ${serverOnline ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-[10px] text-gray-500">{serverOnline ? 'API' : 'API 꺼짐'}</span>
              {!serverOnline && (
                <button onClick={checkServer}
                  className="text-[10px] text-blue-400 hover:text-blue-300 underline ml-1">
                  재연결
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <div className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs mr-2 shrink-0 mt-0.5">🤖</div>
              )}
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${m.role === 'user' ? 'bg-blue-700 text-white rounded-tr-sm' : 'bg-gray-800 text-gray-200 rounded-tl-sm'}`}>
                {m.content}
              </div>
            </div>
          ))}
          {chatLoading && (
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-xs shrink-0">🤖</div>
              <div className="bg-gray-800 rounded-2xl rounded-tl-sm px-3 py-2 flex gap-1">
                {[0,1,2].map(i => <div key={i} className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />)}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="p-3 border-t border-gray-800 space-y-2">
          {(recording || sttBusy || sttResult || sttError) && (
            <div className="bg-gray-800/80 border border-gray-700 rounded-xl px-3 py-2 text-xs space-y-1">
              {recording && !sttBusy && (
                <p className={vadActive ? 'text-green-400' : 'text-gray-400'}>
                  {vadActive ? '🎙 듣는 중…' : '👂 대기 중… 말씀해보세요'}
                </p>
              )}
              {sttBusy && <p className="text-gray-400">⏳ 인식 처리 중…</p>}
              {sttResult && !sttBusy && (
                <p className="text-gray-300">
                  <span className="text-gray-500">인식: </span>
                  <span className="text-gray-100 font-medium">{sttResult.text || '(인식된 텍스트 없음)'}</span>
                </p>
              )}
              {sttError && <p className="text-red-400">{sttError}</p>}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={startStt}
              title={recording ? '듣기 모드 끄기' : '듣기 모드 켜기'}
              className={`px-3 py-2 text-sm rounded-xl transition ${recording ? (vadActive ? 'bg-green-600 hover:bg-green-500 text-white animate-pulse' : 'bg-red-600 hover:bg-red-500 text-white') : 'bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700'}`}>
              {recording ? (vadActive ? '🎙' : '👂') : '🎤'}
            </button>
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="무엇이든 물어보세요…"
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
