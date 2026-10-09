// 2026-10-09 논의에서 정한 목표·원칙·발견·할 일을 한곳에 정리한 기록(정적 내용 — 진행되면 갱신).
type Status = 'done' | 'doing' | 'todo'
const STATUS: Record<Status, { text: string; cls: string }> = {
  done: { text: '완료', cls: 'bg-green-100 text-green-800' },
  doing: { text: '진행', cls: 'bg-indigo-100 text-indigo-800' },
  todo: { text: '대기', cls: 'bg-gray-200 text-gray-700' },
}

const WORKFLOW = [
  { step: '① 사례 입력', text: '업무·일반·윤리 상황이 들어온다.' },
  { step: '② 단서 추출', text: '내 판단에 쓰이는 단서(비용·위험·정확성·일정·사람 등)를 뽑는다.' },
  { step: '③ 내 기준 적용', text: '내가 정한 기준·가중치·예외 조건과, 비슷했던 내 과거 결정을 적용한다.' },
  { step: '④ 결정과 확신도', text: '결정·이유를 내 말투로 만들고 확신도를 붙인다.' },
  { step: '⑤ 넘길지 판단', text: '확신이 낮거나 처음 보는 유형이거나 권한 밖이면 나에게 넘긴다.' },
  { step: '⑥ 전달', text: '결론을 내 얼굴과 목소리로 말한다(기존 TTS·립싱크).' },
]

const FINDINGS = [
  '일치(sync)는 아직 측정 불가: 내가 직접 내린 판단 사례가 0건이다.',
  '연결 검사(gemma4:e2b): 기준을 바꾸면 선택이 따라 바뀜 6/8(p=0.004), 표현 불변 7/8, 모름 정직 8/8(약한 검사). 단 정확↔일정 상황은 반대 기준을 따르지 않았다.',
  'KG 감사: 가치·신념 근거가 거의 없다. 내 발언 560건 다수가 음성 인식 소음·환각("다음 영상에서 만나요!")·아바타 에코다. 자동 성격 추정(ISTJ)은 작업 문서 기반이고 직접 입력(INTJ)과 다르다.',
  '하는 일·지식: 머신비전 기반 품질 검증(3D CAD와 2D 측정 연결, 치수 자동 판정)과 개인 지식 시스템이 중심이다(프로젝트 13개).',
  '말투 A/B(같은 질문 6개): 통합 요약을 넣으면 반말 68%→100%, 평균 204→78자. 다만 퉁명스러운 답 1건이 나와, 반말은 채팅·친한 사람에게만 쓰고 그 외엔 존댓말로 정했다(내가 밝힌 기준).',
]

const TODO: { text: string; status: Status }[] = [
  { text: '용어 정리(기초 지식·연결·일치) — sync는 추정하지 않는다', status: 'done' },
  { text: '연결 검사 3종(갱신 전파·모름의 정직성·표현 불변성)', status: 'done' },
  { text: '심리학·철학 근거와 측정 방법 정리(7번)', status: 'done' },
  { text: '통합 요약 층(하는 일 자동 초안·내 말투·성격) + 승인한 것만 입력에 반영', status: 'done' },
  { text: '말투 교정: 상담원 말투·연기 지문 금지 + 반말은 채팅·친한 사람에게만, 그 외엔 존댓말(내가 밝힌 기준)', status: 'done' },
  { text: '판단 정책 포착: 결정 유형별 사례를 내가 판단 → 기준·가중치·예외를 명시 모델로', status: 'todo' },
  { text: '가치·신념·윤리 질문(우선순위 강제 선택, 이유 사슬, 딜레마) — 정책 포착의 일부로', status: 'todo' },
  { text: '판단 워크플로우 ①~⑥ 실행 + 나에게 넘기는 조건', status: 'todo' },
  { text: '일치 측정: 보류 사례 예측 정확도 / 내 재판단 일치율(천장) / 블라인드 구별', status: 'todo' },
  { text: '데이터 정리: 음성 인식 소음·환각·에코 발언 선택 삭제', status: 'todo' },
  { text: '답변 근거 기록(어떤 지식이 쓰였나) + 입력 미리보기·구역별 기여도', status: 'todo' },
  { text: '결론을 얼굴·목소리로 전달하는 연결(기존 TTS·립싱크 재사용)', status: 'todo' },
  { text: '이번 변경분 커밋', status: 'todo' },
]

const REFS = 'Goldberg, Man versus model of man, Psychological Bulletin 73(6) (1970) · Dawes, The robust beauty of improper linear models, American Psychologist 34(7) (1979) · Brunswik의 렌즈 모델과 Hammond의 사회적 판단 이론 (서지는 기억 기준이라 재확인 필요)'

export default function ProgressLog() {
  return <section className="view-panel p-4 sm:p-5">
    <h2 className="text-lg font-semibold">목표와 진행 현황</h2>
    <blockquote className="mt-2 border-l-4 border-indigo-300 bg-indigo-50 p-3 text-sm text-indigo-950">
      내가 없어도 나와 같은 생각·판단·가치관·윤리 문제·결정을 일반적인 경우와 업무에서 내릴 수 있으면 좋겠다. LLM이 판단할 수도 있지만, 중간중간 내 기준으로 판단하고 결정하는 전체 워크플로우를 만들고 싶다. 내가 직접 개입하지 않아도 내가 한 것과 비슷한 결과만 나오면 된다. 외형과 목소리는 결론을 내 얼굴과 목소리로 말할 수 있으면 된다.
    </blockquote>
    <h3 className="mt-4 font-semibold">설계: 내 기준으로 움직이는 판단 워크플로우</h3>
    <p className="mt-1 text-sm text-gray-600">LLM이 알아서 판단하는 게 아니라, 내 판단을 사례로 모아 기준·가중치·예외를 명시적인 모델로 만들고(판단 정책 포착) 그 모델로 결정합니다. 사람의 판단을 이렇게 모델로 만들면 일관성 덕분에 본인보다 안정적인 경우도 있다고 보고됐습니다.</p>
    <ol className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {WORKFLOW.map(item => <li key={item.step} className="rounded-lg border border-gray-200 bg-gray-50 p-3"><strong>{item.step}</strong><p className="mt-1 text-gray-700">{item.text}</p></li>)}
    </ol>
    <p className="mt-2 text-xs text-gray-500">근거: {REFS}. 성공 기준은 “보류해 둔 내 판단 사례와 같은 결정을 내리는 비율”이며, 내가 같은 사례를 다시 판단했을 때의 일치율이 상한입니다.</p>
    <h3 className="mt-4 font-semibold">지금까지 확인한 것 (2026-10-09)</h3>
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">{FINDINGS.map(text => <li key={text}>{text}</li>)}</ul>
    <h3 className="mt-4 font-semibold">할 일</h3>
    <ul className="mt-2 space-y-1.5 text-sm">{TODO.map(item => <li key={item.text} className="flex items-start gap-2"><span className={'mt-0.5 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ' + STATUS[item.status].cls}>{STATUS[item.status].text}</span><span className="text-gray-800">{item.text}</span></li>)}</ul>
  </section>
}
