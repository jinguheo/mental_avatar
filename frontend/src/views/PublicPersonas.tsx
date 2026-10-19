import { useState } from 'react'
import PersonaAvatars from './PersonaAvatars'
import PersonaLibrary from './PersonaLibrary'
import PersonaStage from './PersonaStage'
import PersonaBlind from './PersonaBlind'

// 공개 인물 페르소나를 한 탭에서 순서대로 다룬다: 자료·근거 → 인물 지식 → 대화 → 블라인드 평가.
// 고른 인물은 단계를 옮겨도 유지한다(블라인드 평가는 인물을 가리는 화면이라 공유하지 않는다).
type Step = 'evidence' | 'library' | 'stage' | 'blind'
const STEPS: { id: Step; label: string; hint: string }[] = [
  { id: 'evidence', label: '① 자료·근거', hint: '자료를 모으고 질문은행 근거를 판정·검수 (만드는 쪽)' },
  { id: 'library', label: '② 인물 지식', hint: '성향·페르소나 요약과 원문 자료 열람 (결과 보기)' },
  { id: 'stage', label: '③ 대화', hint: '근거를 붙여 답하는 인물 대화' },
  { id: 'blind', label: '④ 블라인드 평가', hint: '이름을 가리고 누구의 답 같은지 고르기' },
]

export default function PublicPersonas() {
  const [step, setStep] = useState<Step>('evidence')
  const [person, setPerson] = useState('buffett')
  const current = STEPS.find(item => item.id === step)
  return <div className="flex h-full flex-col">
    <div className="shrink-0 border-b border-gray-200 bg-gray-50 px-4 py-2 sm:px-6">
      <div role="tablist" aria-label="공개 인물 단계" className="flex flex-wrap gap-1.5">
        {STEPS.map(item => <button key={item.id} role="tab" aria-selected={step === item.id} onClick={() => setStep(item.id)}
          className={'rounded-full border px-3 py-1 text-sm ' + (step === item.id ? 'border-gray-900 bg-gray-900 text-white' : 'border-gray-300 bg-white text-gray-700 hover:border-gray-500')}>{item.label}</button>)}
      </div>
      <p className="mt-1 text-xs text-gray-500">{current?.hint}</p>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {step === 'evidence' ? <PersonaAvatars selected={person} onPerson={setPerson} onGoto={setStep} />
        : step === 'library' ? <PersonaLibrary selected={person} onPerson={setPerson} />
        : step === 'stage' ? <PersonaStage selected={person} onPerson={setPerson} />
        : <PersonaBlind />}
    </div>
  </div>
}
