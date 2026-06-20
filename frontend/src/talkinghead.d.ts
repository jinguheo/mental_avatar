declare module '@met4citizen/talkinghead' {
  export class TalkingHead {
    constructor(node: HTMLElement, opt?: Record<string, unknown>)
    showAvatar(avatar: Record<string, unknown>, onprogress?: (ev: ProgressEvent) => void): Promise<void>
    speakAudio(r: {
      audio: AudioBuffer
      words?: string[]
      wtimes?: number[]
      wdurations?: number[]
      visemes?: string[]
      vtimes?: number[]
      vdurations?: number[]
    }, opt?: Record<string, unknown>, onsubtitles?: (text: string) => void): void
    speakText(s: string, opt?: Record<string, unknown>, onsubtitles?: (text: string) => void): void
    stopSpeaking(): void
    setMood(s: string): void
    start(): void
    stop(): void
  }
}
