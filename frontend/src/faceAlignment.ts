import { API_BASE } from '@/config'

export const FACE_SNAPSHOT_KEY = 'mental-avatar-face-snapshot'
export const FACE_LANDMARKS_KEY = 'mental-avatar-face-landmarks'
export const FACE_ALIGNMENT_META_KEY = 'mental-avatar-face-alignment-meta'
export const FACE_ALIGNED_PATCH_KEY = 'mental-avatar-face-aligned-patch'
export const TRACKING_VIDEO_SOURCE_KEY = 'mental-avatar-tracking-video-source'
export const TRACKING_VIDEO_SOURCE_EVENT = 'mental-avatar-tracking-video-source-change'

export type FaceLandmark = { x: number; y: number; z: number }

export interface FaceAlignmentMeta {
  snapshotMirrored: boolean
  landmarkSource: 'camera-original'
  savedAt: string
  imageWidth?: number
  imageHeight?: number
}

export interface TrackingVideoSource {
  url: string
  name: string
  savedAt: string
  manual: true
}

export function getFaceImageUrl(): string {
  return localStorage.getItem(FACE_SNAPSHOT_KEY) || `${API_BASE}/avatar/face?t=${Date.now()}`
}

export function getRegisteredFaceImageUrl(): string {
  return `${API_BASE}/avatar/face?t=${Date.now()}`
}

export function clearFaceImageCaches() {
  localStorage.removeItem(FACE_SNAPSHOT_KEY)
  localStorage.removeItem(FACE_LANDMARKS_KEY)
  localStorage.removeItem(FACE_ALIGNMENT_META_KEY)
  localStorage.removeItem(FACE_ALIGNED_PATCH_KEY)
}

export function saveTrackingVideoSource(url: string, name = 'registered-video') {
  const source: TrackingVideoSource = {
    url,
    name,
    savedAt: new Date().toISOString(),
    manual: true,
  }
  localStorage.setItem(TRACKING_VIDEO_SOURCE_KEY, JSON.stringify(source))
  window.dispatchEvent(new CustomEvent(TRACKING_VIDEO_SOURCE_EVENT, { detail: source }))
}

export function readTrackingVideoSource(): TrackingVideoSource | null {
  const raw = localStorage.getItem(TRACKING_VIDEO_SOURCE_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<TrackingVideoSource>
    if (typeof parsed.url !== 'string' || !parsed.url) return null
    if (parsed.manual !== true) return null
    return {
      url: parsed.url,
      name: typeof parsed.name === 'string' && parsed.name ? parsed.name : 'registered-video',
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
      manual: true,
    }
  } catch {
    return null
  }
}

export function clearTrackingVideoSource() {
  localStorage.removeItem(TRACKING_VIDEO_SOURCE_KEY)
  window.dispatchEvent(new CustomEvent(TRACKING_VIDEO_SOURCE_EVENT, { detail: null }))
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('face image load failed'))
    img.src = src
  })
}

export function readFaceLandmarks(): FaceLandmark[] | null {
  const raw = localStorage.getItem(FACE_LANDMARKS_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as FaceLandmark[] : null
  } catch {
    return null
  }
}

export function saveFaceAlignmentSnapshot(
  dataUrl: string,
  landmarks: FaceLandmark[],
  imageWidth?: number,
  imageHeight?: number,
) {
  localStorage.setItem(FACE_SNAPSHOT_KEY, dataUrl)
  localStorage.removeItem(FACE_ALIGNED_PATCH_KEY)
  localStorage.setItem(FACE_LANDMARKS_KEY, JSON.stringify(landmarks))
  const meta: FaceAlignmentMeta = {
    snapshotMirrored: true,
    landmarkSource: 'camera-original',
    savedAt: new Date().toISOString(),
    imageWidth,
    imageHeight,
  }
  localStorage.setItem(FACE_ALIGNMENT_META_KEY, JSON.stringify(meta))
}

export function landmarkToSavedSnapshotUv(landmark: FaceLandmark) {
  return {
    u: 1 - landmark.x,
    v: 1 - landmark.y,
  }
}

export function landmarkToSavedSnapshotPoint(landmark: FaceLandmark, width: number, height: number) {
  return {
    x: (1 - landmark.x) * width,
    y: landmark.y * height,
  }
}

export async function getAlignedFacePatchUrl(): Promise<string> {
  const cached = localStorage.getItem(FACE_ALIGNED_PATCH_KEY)
  if (cached) return cached

  const sourceUrl = getFaceImageUrl()
  const landmarks = readFaceLandmarks()
  if (!landmarks?.length) return sourceUrl

  const img = await loadImage(sourceUrl)
  const sourceWidth = img.naturalWidth || img.width
  const sourceHeight = img.naturalHeight || img.height
  if (!sourceWidth || !sourceHeight) return sourceUrl

  const points = landmarks
    .slice(0, 468)
    .map(point => landmarkToSavedSnapshotPoint(point, sourceWidth, sourceHeight))
  if (!points.length) return sourceUrl

  const minX = Math.min(...points.map(point => point.x))
  const maxX = Math.max(...points.map(point => point.x))
  const minY = Math.min(...points.map(point => point.y))
  const maxY = Math.max(...points.map(point => point.y))
  const faceWidth = Math.max(1, maxX - minX)
  const faceHeight = Math.max(1, maxY - minY)
  const centerX = (minX + maxX) / 2
  const centerY = minY + faceHeight * 0.48

  const outputWidth = 512
  const outputHeight = 660
  const targetAspect = outputWidth / outputHeight
  let cropHeight = faceHeight * 1.38
  let cropWidth = Math.max(faceWidth * 1.42, cropHeight * targetAspect)
  cropHeight = Math.max(cropHeight, cropWidth / targetAspect)

  let sx = centerX - cropWidth / 2
  let sy = centerY - cropHeight * 0.46
  sx = Math.max(0, Math.min(sourceWidth - cropWidth, sx))
  sy = Math.max(0, Math.min(sourceHeight - cropHeight, sy))
  cropWidth = Math.min(cropWidth, sourceWidth)
  cropHeight = Math.min(cropHeight, sourceHeight)

  const canvas = document.createElement('canvas')
  canvas.width = outputWidth
  canvas.height = outputHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return sourceUrl
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, outputWidth, outputHeight)
  ctx.drawImage(img, sx, sy, cropWidth, cropHeight, 0, 0, outputWidth, outputHeight)

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
  try { localStorage.setItem(FACE_ALIGNED_PATCH_KEY, dataUrl) } catch { /* storage quota */ }
  return dataUrl
}
