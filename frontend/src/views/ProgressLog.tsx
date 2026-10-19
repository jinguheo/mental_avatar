// 2026-10-09 논의에서 정한 목표·원칙·발견·할 일을 한곳에 정리한 기록(정적 내용 — 진행되면 갱신). 마지막 갱신 2026-10-19.
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
  '일치(sync)는 아직 측정 불가: 내가 직접 입력한 판단 사례가 0건이다(2026-10-19 확인). 판단 사례 입력 화면과 구성용/시험용 분리 코드는 만들어 두었으나 쓸 사례가 없다.',
  '연결 검사(gemma4:e2b): 기준을 바꾸면 선택이 따라 바뀜 6/8(p=0.004), 표현 불변 7/8, 모름 정직 8/8(약한 검사). 단 정확↔일정 상황은 반대 기준을 따르지 않았다.',
  'KG 감사(2026-10-09): 가치·신념 근거가 거의 없다. 당시 내 발언 560건 다수가 음성 인식 소음·환각("다음 영상에서 만나요!")·아바타 에코다. 자동 성격 추정(ISTJ)은 작업 문서 기반이고 직접 입력(INTJ)과 다르다.',
  '하는 일·지식: 머신비전 기반 품질 검증(3D CAD와 2D 측정 연결, 치수 자동 판정)과 개인 지식 시스템이 중심이다(프로젝트 13개). 2026-10-19 현재 KG는 노드 2,991·관계 6,462, 저장된 사용자 발언 1,465건이다.',
  'Claude Code 대화 기록(2026-10-10): 58개 세션에 내가 직접 쓴 메시지가 약 2,900건(중복 제거 후 약 2,300건)이다. 길이가 긴 붙여넣기·로그·한 번 시키는 지시가 많아, 전부 KG에 넣으면 불필요한 것이 많이 섞인다. 규칙만으로 오래 남길 만한 것을 고르면 약 24%였다.',
  'KG 구축에는 자동 백업과 필터링이 필요하다: 대화 파일은 보관 기간이 지나면 지워질 수 있어 원본을 먼저 복사하고, 내가 쓴 글만 뽑아 오염을 거른 뒤, 로컬 모델이 종류(기준·사실·목표·결정만 KG)를 판정한다. gemma4:e2b는 약 70% 정확해서 선호 표현이 뚜렷하면 모델이 놓쳐도 남기는 규칙을 합쳤고, e4b는 GPU 메모리가 부족하면 비정상 종료해 쓰지 않는다.',
  '“직전 Claude 발화 → 내 답” 짝은 그 자체로 판단 사례다. 내가 무엇을 요구하고 어떤 기준으로 고르는지의 기록이므로 입력 예측 모델의 학습 데이터이고, 일부를 보류해 두면 일치(sync)를 재는 시험 데이터가 된다.',
  '말투 A/B(같은 질문 6개): 통합 요약을 넣으면 반말 68%→100%, 평균 204→78자. 다만 퉁명스러운 답 1건이 나와, 반말은 채팅·친한 사람에게만 쓰고 그 외엔 존댓말로 정했다(내가 밝힌 기준).',
  '공개 인물 11명 질문은행(2026-10-19): 78문항 중 수집 원문에서 확인된 답은 이소룡 39·마르쿠스 33·파인만 31·아인슈타인 31·버핏 30·잡스 23·레오나르도 13·송해 10·마리 퀴리 9·세종 7·이순신 0이다. 마르쿠스는 판정 문구가 자기 자신에게 쓴 글을 인정하지 않아 0건이었다가 33건이 됐다. 이 수는 커버리지일 뿐 정확도가 아니며 사람 검수 전이다.',
  '인물 채팅이 쉬운 일반 질문(예: 버핏에게 좋은 기업은 어떻게 알아보나요?)에 “찾지 못했다”고 답했다. 검색은 됐지만 관련성 판정이 “직접 답함”만 통과시켜 후보가 전부 탈락한 탓이었다. 분야 전문가 초안과 인물 자료를 합성하는 방식으로 바꿨다(2026-10-19). 개인 사실 질문은 아직 보류로 가지 못한다.',
]

const TODO: { text: string; status: Status }[] = [
  { text: '용어 정리(기초 지식·연결·일치) — sync는 추정하지 않는다', status: 'done' },
  { text: '연결 검사 3종(갱신 전파·모름의 정직성·표현 불변성)', status: 'done' },
  { text: '심리학·철학 근거와 측정 방법 정리(7번)', status: 'done' },
  { text: '통합 요약 층(하는 일 자동 초안·내 말투·성격) + 승인한 것만 입력에 반영', status: 'done' },
  { text: '말투 교정: 상담원 말투·연기 지문 금지 + 반말은 채팅·친한 사람에게만, 그 외엔 존댓말(내가 밝힌 기준)', status: 'done' },
  { text: '판단 정책 포착: 결정 유형별 사례를 내가 판단 → 기준·가중치·예외를 명시 모델로. 사례 입력 화면(출처·기록 시점·승인 상태·확신도·충돌 확인·정책 버전)은 구현, 직접 입력 사례가 0건이라 모델은 아직 못 만듦', status: 'doing' },
  { text: '판단 사례를 구성용/시험용으로 분리하는 코드(판단 시험 세트) — 실제 측정은 사례가 쌓인 뒤', status: 'done' },
  { text: '가치·신념·윤리 질문(우선순위 강제 선택, 이유 사슬, 딜레마) — 정책 포착의 일부로', status: 'todo' },
  { text: '판단 워크플로우 ①~⑥ 실행 + 나에게 넘기는 조건', status: 'todo' },
  { text: '일치 측정: 보류 사례 예측 정확도 / 내 재판단 일치율(천장) / 블라인드 구별', status: 'todo' },
  { text: '기억 오염 정리 + 자동 저장 필터: 소음·환각·에코·주변 소리 324건 격리, 아바타 답변 427개 KG에서 제외, 앞으로는 정상 발언만 자동 저장(3-1)', status: 'done' },
  { text: '기억 이력 열(출처·확신도·재확인 주기)과 세션 요약 후보 추출, 판단 사례 에피소드', status: 'todo' },
  { text: '답변 근거 기록(어떤 지식이 쓰였나) + 입력 미리보기·구역별 기여도', status: 'todo' },
  { text: '결론을 얼굴·목소리로 전달하는 연결(기존 TTS·립싱크 재사용)', status: 'todo' },
  { text: 'Claude Code·Codex 모든 창 대화 자동 백업 + 내가 쓴 글 추출 + 종류 판정 후 오래 남길 것만 KG 저장, 제외분 검토·복원(3-2)', status: 'done' },
  { text: '판단 사례 저장(직전 Claude 발화 → 내 답) — 입력 예측·일치 측정의 데이터', status: 'done' },
  { text: '내 다음 입력 예측: 보류한 사례로 “내가 뭐라고 할지” 맞히는 정도를 측정(기본 모델과 비교)', status: 'todo' },
  { text: '미리 알려주기: 여러 창에서 일어난 일을 요약하고, 내가 결정할 지점에는 내 기준의 예상 답을 먼저 제시(의도 확인 후)', status: 'todo' },
  { text: '공개 인물 11명 페르소나: 질문은행·4모드 이용 범위·인물 지식·대화·블라인드 평가를 “공개 인물” 탭 하나로 묶음(2026-10-19). 세부 진행은 그 탭의 ① 자료·근거', status: 'doing' },
  { text: '아바타 논문 원고(12절)와 연구 동향 탭(빅테크 개인 에이전트 비교 포함) 갱신', status: 'doing' },
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
    <h3 className="mt-4 font-semibold">지금까지 확인한 것 (2026-10-09 ~ 10-19)</h3>
    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">{FINDINGS.map(text => <li key={text}>{text}</li>)}</ul>
    <h3 className="mt-4 font-semibold">할 일</h3>
    <ul className="mt-2 space-y-1.5 text-sm">{TODO.map(item => <li key={item.text} className="flex items-start gap-2"><span className={'mt-0.5 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ' + STATUS[item.status].cls}>{STATUS[item.status].text}</span><span className="text-gray-800">{item.text}</span></li>)}</ul>
  </section>
}
