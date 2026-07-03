// 3D 아바타 립싱크(viseme 근사)·표정 모프타겟 공용 상수/분류기.
// RealisticAvatar.tsx와 PptPresenter.tsx가 동일하게 쓰던 것을 한 곳으로 모음.
// (컴포넌트별 애니메이션 루프·MorphRef는 THREE 씬에 얽혀 있어 각 파일에 그대로 둔다.)

export type Emotion = 'neutral' | 'happy' | 'sorry' | 'surprised'

// Rhubarb Lip Sync 발음 구간 큐 (start~end 초, value=발음 셰이프 문자)
export interface LipCue { start: number; end: number; value: string }

// 입싱크(viseme 근사) + 표정용 모프타겟 그룹 — Avaturn/ARKit/Oculus 명명 모두 대응
export const MORPH_GROUPS: Record<string, RegExp[]> = {
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

// Rhubarb Lip Sync 발음 구간(A~X, Preston Blair 계열)을 우리 모프타겟 그룹 가중치로 매핑.
// A/X(무음·닫힘)는 값을 안 줘서 자연스럽게 0으로 수렴하도록 둔다.
export const RHUBARB_SHAPE_TARGETS: Record<string, Partial<Record<string, number>>> = {
  B: { consonant: 0.35, aa: 0.15 },
  C: { aa: 0.55 },
  D: { aa: 0.9 },
  E: { oo: 0.5 },
  F: { oo: 0.9 },
  G: { consonant: 0.5 },
  H: { ee: 0.4, consonant: 0.2 },
}

// 말하는 동안 기본으로 살짝 웃는 표정(neutral baseline) + 감정별 가중치(명확히 보이도록 값을 키움)
export const EMOTION_WEIGHTS: Record<Emotion, Partial<Record<string, number>>> = {
  neutral: { smile: 0.25 },
  happy: { smile: 1, browUp: 0.4 },
  sorry: { frown: 0.7, browDown: 0.5, smile: 0 },
  surprised: { browUp: 1, smile: 0.1 },
}

export function classifyEmotion(text: string): Emotion {
  if (/죄송|미안|사과|아쉽|어렵|힘들/.test(text)) return 'sorry'
  if (/축하|좋아요|좋습니다|감사|기쁘|행복|반갑|웃|즐거|최고|!{1,}/.test(text)) return 'happy'
  if (/\?|궁금|놀라|정말요|진짜요|신기/.test(text)) return 'surprised'
  return 'neutral'
}
