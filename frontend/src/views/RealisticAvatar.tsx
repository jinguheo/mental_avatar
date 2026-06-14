/**
 * RealisticAvatar — Ready Player Me 풀바디 아바타 + TalkingHead 립싱크 (무료, MIT/CC-BY-NC)
 * - TalkingHead(@met4citizen/talkinghead)가 자체 Three.js 씬/렌더러를 컨테이너에 생성
 * - 기존 /avatar/tts_only(XTTS)로 음성 생성 → 글자수 비례로 단어 타이밍 추정 → speakAudio로 립싱크
 */
import { useEffect, useRef, useState } from 'react'
import { TalkingHead } from '@met4citizen/talkinghead'

const API = 'http://127.0.0.1:8766'

// met4citizen 데모용 Ready Player Me 아바타 (ARKit + Oculus Visemes 모프타겟 포함)
const DEFAULT_AVATAR_URL =
  'https://models.readyplayer.me/64bfa15f0e72c63d7c3934a6.glb?morphTargets=ARKit,Oculus+Visemes,mouthOpen,mouthSmile,eyesClosed,eyesLookUp,eyesLookDown&textureSizeLimit=1024&textureFormat=png'

const AVATAR_URL_KEY = 'mental-avatar-rpm-url'

export default function RealisticAvatar() {
  const containerRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<InstanceType<typeof TalkingHead> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState(() => localStorage.getItem(AVATAR_URL_KEY) || DEFAULT_AVATAR_URL)

  useEffect(() => {
    if (!containerRef.current) return
    setLoading(true)
    setError('')

    const head = new TalkingHead(containerRef.current, {
      lipsyncModules: ['en'],
      cameraView: 'upper',
    })
    headRef.current = head

    head.showAvatar({
      url: avatarUrl,
      body: 'F',
      lipsyncLang: 'en',
    }).then(() => setLoading(false)).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      setLoading(false)
    })

    return () => {
      try { head.stop() } catch { /* ignore */ }
    }
  }, [avatarUrl])

  const speak = async () => {
    const t = text.trim()
    if (!t || !headRef.current || speaking) return
    setSpeaking(true)
    try {
      const form = new FormData()
      form.append('text', t)
      form.append('voice', 'mine')
      const res = await fetch(`${API}/avatar/tts_only`, { method: 'POST', body: form })
      if (!res.ok) throw new Error('TTS 실패')
      const arrayBuf = await res.arrayBuffer()
      const ctx = new AudioContext()
      const audioBuf = await ctx.decodeAudioData(arrayBuf)

      // 단어별 타이밍은 글자수 비례로 추정 (영문 lipsync 모듈로 viseme 근사)
      const words = t.split(/\s+/).filter(Boolean)
      const totalChars = words.reduce((s, w) => s + w.length, 0) || 1
      const totalMs = audioBuf.duration * 1000
      let cursor = 0
      const wtimes: number[] = []
      const wdurations: number[] = []
      for (const w of words) {
        const dur = totalMs * (w.length / totalChars)
        wtimes.push(cursor)
        wdurations.push(dur)
        cursor += dur
      }

      headRef.current.speakAudio({ audio: audioBuf, words, wtimes, wdurations })
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSpeaking(false)
    }
  }

  const applyAvatarUrl = (url: string) => {
    localStorage.setItem(AVATAR_URL_KEY, url)
    setAvatarUrl(url)
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 relative bg-gray-950">
        <div ref={containerRef} className="w-full h-full" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm">
            아바타 로딩 중...
          </div>
        )}
        {error && (
          <div className="absolute bottom-4 left-4 right-4 bg-red-900/80 text-red-200 text-xs p-2 rounded">
            {error}
          </div>
        )}
      </div>

      <div className="w-80 flex flex-col border-l border-gray-800 bg-gray-900/95 p-4 gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-200">실사 아바타 (실험)</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Ready Player Me + TalkingHead (무료, MIT/CC-BY-NC)
          </p>
        </div>

        <label className="text-xs text-gray-400">
          Ready Player Me 아바타 GLB URL
          <input
            defaultValue={avatarUrl}
            onBlur={e => applyAvatarUrl(e.target.value.trim() || DEFAULT_AVATAR_URL)}
            className="mt-1 w-full bg-gray-800 text-gray-200 text-xs rounded px-2 py-1 border border-gray-700"
            placeholder={DEFAULT_AVATAR_URL}
          />
        </label>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          readyplayer.me 에서 무료로 자신의 사진 기반 아바타를 만든 뒤, GLB 다운로드 URL을
          위에 입력하면 해당 아바타로 교체됩니다.
        </p>

        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          rows={4}
          placeholder="아바타가 말할 텍스트를 입력하세요"
          className="w-full bg-gray-800 text-gray-200 text-sm rounded px-2 py-2 border border-gray-700 resize-none"
        />
        <button
          onClick={speak}
          disabled={speaking || loading}
          className="text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded px-3 py-1.5"
        >
          {speaking ? '말하는 중...' : '말하기'}
        </button>
      </div>
    </div>
  )
}
