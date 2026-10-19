type Status = 'done' | 'partial' | 'todo'
type Method = { field: '철학' | '심리학' | '측정'; name: string; source: string; idea: string; measure: string; where: string; status: Status }
type Ref = { cite: string; note: string; href?: string }

const STATUS_LABEL: Record<Status, { text: string; cls: string }> = {
  done: { text: '반영됨', cls: 'bg-green-100 text-green-800' },
  partial: { text: '일부 반영', cls: 'bg-amber-100 text-amber-800' },
  todo: { text: '아직 없음', cls: 'bg-gray-200 text-gray-700' },
}

const METHODS: Method[] = [
  {
    field: '철학', name: '심리적 연속성 (동일성이 아니라 정도)', source: 'Parfit, Reasons and Persons (1984)',
    idea: '“같은 존재인가”는 증명할 수 없다. 중요한 것은 기억·신념·가치·성격이 얼마나 이어지고 연결되는지, 즉 정도의 문제다.',
    measure: '“동일하다/아니다”가 아니라 영역별 일치 정도로 보고한다.',
    where: '결과를 해석하는 기준. 현재 기초 지식 지도는 준비도라 일치 정도는 아직 재지 않는다.', status: 'partial',
  },
  {
    field: '철학', name: '확장된 마음', source: 'Clark & Chalmers, The Extended Mind, Analysis 58(1) (1998)',
    idea: '믿음을 저장하고 항상 참조하며 신뢰하는 외부 기억은 그 사람 마음의 일부로 볼 수 있다.',
    measure: '항상 접근 가능한가, 답변에 자동으로 쓰이는가, 본인이 신뢰하는가.',
    where: '4. 꼭 기억할 사실(매 답변에 주입), KG, 자문자답.', status: 'done',
  },
  {
    field: '철학', name: '서사적 정체성', source: 'McAdams, The psychology of life stories, Review of General Psychology 5(2) (2001)',
    idea: '자기 삶을 어떻게 이야기하는가가 정체성의 핵심이다. 사실 목록이 아니라 경험과 의미의 이야기가 필요하다.',
    measure: '이야기에 담긴 주요 사건·전환점·가치가 아바타 답에 일관되게 나타나는지.',
    where: '1. 나는 누구인가의 “내 이야기와 주요 경험”, “중요한 관계와 호칭”.', status: 'partial',
  },
  {
    field: '철학', name: '튜링식 구별 검사', source: 'Turing, Mind 59 (1950) · Guo et al., Individual Turing Test (2026)',
    idea: '내면은 확인할 수 없으니 행동으로 판정한다. 내 답과 아바타 답을 섞어 구별하게 한다.',
    measure: '본인·지인이 맞히는 정확도. 50%에 가까울수록 구별 불가. 낯선 사람보다 지인이 더 엄격한 심판이다.',
    where: '5. 나와 비교해서 검증은 수동 비교만 있고, 섞어서 맞히는 블라인드 검사는 없다.', status: 'todo',
  },
  {
    field: '심리학', name: '상황-행동 서명 (if-then)', source: 'Mischel & Shoda, Psychological Review 102(2) (1995)',
    idea: '성격은 고정 특성이 아니라 “이런 상황이면 이렇게 한다”는 안정된 패턴이다.',
    measure: '상황 속성(대상·위험·시간)을 바꿔도 같은 if-then 패턴이 유지되는지.',
    where: '2. 기준 입력 안내(적용 조건을 함께 적기), 답변 규칙(사례를 영구 성향으로 일반화하지 않기).', status: 'partial',
  },
  {
    field: '심리학', name: '상태의 분포로서의 성격', source: 'Fleeson, JPSP 80(6) (2001)',
    idea: '사람은 같은 질문에도 매번 조금씩 다르게 답한다. 정답 하나가 아니라 분포가 나다.',
    measure: '같은 질문에 내가 여러 번 답해 분포를 만들고, 아바타 답이 그 분포 안에 드는지 본다.',
    where: '없음. 지금은 기대 답 한 개와 비교한다.', status: 'todo',
  },
  {
    field: '측정', name: '재검사 신뢰도 상한', source: 'Park et al., arXiv:2411.10109 (v3, 2026) · Toubia et al., Twin-2K-500 (2025)',
    idea: '나도 2주 뒤에 같은 질문에 다르게 답한다. 아바타는 내 자기 일관성보다 정확해질 수 없다.',
    measure: '(아바타 vs 나) ÷ (내 1차 vs 내 2차)로 정규화. 연구에서는 이 값이 83~86% 수준으로 보고됐다.',
    where: '없음.', status: 'todo',
  },
  {
    field: '측정', name: '보류(held-out) 예측과 베이스라인', source: 'Cronbach & Meehl, Psychological Bulletin 52 (1955) · Park et al. (2026)',
    idea: '학습에 쓴 내용을 되묻는 건 검증이 아니다. 쓰지 않은 질문으로 예측력을 보고, 내 정보가 없는 일반 아바타보다 얼마나 나은지 본다.',
    measure: '자문자답을 학습용·시험용으로 나누고, 인구통계만 준 아바타(연구에서는 74%)와 비교한 증분을 본다.',
    where: '없음. 현재 비교 질문은 직접 만든 문항이라 오염될 수 있다.', status: 'todo',
  },
  {
    field: '측정', name: '현실적 정확도 모델', source: 'Funder, On the accuracy of personality judgment, Psychological Review 102(4) (1995)',
    idea: '정확한 판단은 관련 단서가 있고, 접근 가능하며, 올바르게 쓰일 때 나온다. 기준은 여러 관찰자의 합의다.',
    measure: '본인 평가만이 아니라 지인 평가를 함께 기준으로 쓴다.',
    where: '없음.', status: 'todo',
  },
  {
    field: '측정', name: '개인 수준 검증', source: 'Wang et al., arXiv:2609.07987 (2026)',
    idea: '평균을 재현하는 것과 개인을 맞히는 것은 다르다. 행동이 비슷해 보이는 것(충실도)이 곧 대체 가능하다는 뜻도 아니다.',
    measure: '평균 답에서 내가 벗어나는 지점을 아바타가 맞히는지 따로 본다.',
    where: '없음.', status: 'todo',
  },
]

type Construct = { name: string; source: string; what: string; ask: string; status: Status }

// 질문·KG로 알아내야 하는 것은 지식이 아니라 가치·신념·선호다 — 심리학에서 이를 재는 표준 구성개념과 도구.
const CONSTRUCTS: Construct[] = [
  {
    name: '기본 가치', source: 'Schwartz et al., Refining the theory of basic individual values, JPSP 103(4) (2012) · Portrait Values Questionnaire',
    what: '자기주도·자극·쾌락·성취·권력·안전·순응·전통·박애·보편주의 등. 값들의 우선순위와 충돌할 때 무엇이 이기는지가 판단의 뼈대다.',
    ask: '“이런 사람은 나와 얼마나 비슷한가” 문항, 두 가치가 충돌하는 상황에서 하나를 고르게 하기.', status: 'todo',
  },
  {
    name: '도덕 직관', source: 'Graham et al., Mapping the moral domain, JPSP 101(2) (2011) · Moral Foundations Questionnaire',
    what: '배려·공정·충성·권위·고귀함·자유 중 무엇에 민감한지. 옳고 그름 판단의 기본 결.',
    ask: '짧은 딜레마와 시나리오에서 허용·불허와 그 강도를 고르게 하기.', status: 'todo',
  },
  {
    name: '신념과 판단 기준(개인 구성개념)', source: 'Kelly, The Psychology of Personal Constructs (1955) · repertory grid',
    what: '세상을 어떤 양극 기준(정확한↔빠른, 안전한↔도전적)으로 나눠 보는지. 무엇을 근거로 믿는지의 틀.',
    ask: '세 사례 중 둘이 같고 하나가 다른 이유를 말하게 하기. 그 기준을 양극 쌍으로 기록.', status: 'todo',
  },
  {
    name: '선호의 강도와 교환비율', source: 'Louviere et al., Best-Worst Scaling (2015) · Holt & Laury, AER 92(5) (2002) · Frederick et al., JEL 40(2) (2002)',
    what: '무엇을 더 좋아하는지가 아니라 얼마나, 무엇과 맞바꿀 수 있는지. 위험·시간·비용 선호가 포함된다.',
    ask: '강제 선택(가장 중요한 것·덜 중요한 것 고르기), 확실한 작은 보상 대 불확실한 큰 보상, 지금 대 나중 교환 질문.', status: 'todo',
  },
  {
    name: '가치의 이유 사슬', source: 'Reynolds & Gutman, Laddering theory, Journal of Advertising Research 28(1) (1988)',
    what: '선택의 속성 → 결과 → 근본 가치로 이어지는 이유. 같은 선택도 이유가 다르면 다른 상황에서 다르게 행동한다.',
    ask: '“왜 그게 중요해?”를 3~4단계 반복해 속성·결과·가치 사슬로 기록.', status: 'partial',
  },
  {
    name: '말과 행동의 차이', source: 'Nisbett & Wilson, Psychological Review 84(3) (1977) · Haidt, Psychological Review 108(4) (2001) · Samuelson, Economica 5 (1938)',
    what: '사람은 자기 판단의 이유를 정확히 모르고 사후에 그럴듯하게 설명하기도 한다. 말한 가치와 실제로 한 선택이 다를 수 있다.',
    ask: '자기보고를 그대로 믿지 말고 실제 선택·대화 기록과 대조해 불일치를 표시하기(드러난 선호).', status: 'partial',
  },
]

const RECENT: Ref[] = [
  { cite: 'Park, Zou, et al. (2026, v3). LLM Agents Grounded in Self-Reports Enable General-Purpose Simulation of Individuals. arXiv:2411.10109', note: '1,052명. 인터뷰·설문·결합 아바타가 본인 2주 재응답 일치율의 83·82·86%, 인구통계만은 74%.', href: 'https://arxiv.org/abs/2411.10109' },
  { cite: 'Guo, Ye, Xu, Zhu, Hua, Metaxas (2026). Individual Turing Test: A Case Study of LLM-based Simulation Using Longitudinal Personal Data. arXiv:2603.01289', note: '10년 치 메시지. 지인이 심판이면 현재 방법은 통과 못 함. 말투는 파인튜닝, 의견·선호는 검색·기억 방식이 유리.', href: 'https://arxiv.org/abs/2603.01289' },
  { cite: 'Shi, Jimenez, et al. (2025). IMPersona: Evaluating Individual Level LM Impersonation. arXiv:2504.04332', note: '파인튜닝+기억 검색 모델이 블라인드 대화에서 44.4% 사람으로 판정됨. 프롬프트만은 25%.', href: 'https://arxiv.org/abs/2504.04332' },
  { cite: 'Toubia, Gui, et al. (2025). Twin-2K-500. arXiv:2505.17479', note: '2,058명·500문항 데이터. 마지막 웨이브에서 과제를 반복해 재검사 기준선을 만든 설계.', href: 'https://arxiv.org/abs/2505.17479' },
  { cite: 'Wang, Hunt, Tang, Joseph (2026). When Can LLM Digital Twins Reduce Human Measurement? arXiv:2609.07987', note: '평균 효과는 재현해도 개인 차이는 거의 못 맞힘. 행동 충실도는 대체 가능성의 필요·충분 조건이 아님.', href: 'https://arxiv.org/abs/2609.07987' },
  { cite: 'TwinVoice: A Multi-dimensional Benchmark Towards Digital Twins via LLM Persona Simulation. arXiv:2510.25536', note: '사고방식 일관성과 언어 표현을 나눠 객관식·생성형으로 평가. 생성형 점수가 더 낮음.', href: 'https://arxiv.org/abs/2510.25536' },
  { cite: '“Persons and their Digital Replicas” (2025). DOI 10.1007/s13347-025-00854-z', note: '파핏의 심리적 연결성을 출발점으로, 동일성이 아니어도 복제본이 인격의 연장일 수 있는 조건을 논의.', href: 'https://doi.org/10.1007/s13347-025-00854-z' },
  { cite: '“Digital selves” (2026). DOI 10.1007/s11229-026-05705-8', note: 'AI 복제본을 단순 표상이 아니라 자기의 일부·확장으로 보는 심리적 정체성 관점.', href: 'https://doi.org/10.1007/s11229-026-05705-8' },
  { cite: '“Identity from the Outside: A Conceptual Framework and Research Program for AI Personality Clones” (2026, 프리프린트). arXiv:2608.11225', note: '의식 문제는 접고 충실도·일반 인간다움·개성을 분리. 장기 기준은 “내 가능한 반응의 조건부 분포” 일치.', href: 'https://arxiv.org/abs/2608.11225' },
]

function Badge({ status }: { status: Status }) {
  const info = STATUS_LABEL[status]
  return <span className={'rounded px-2 py-0.5 text-xs font-medium ' + info.cls}>{info.text}</span>
}

type Props = { interviewCount: number; evaluated: number; passed: number; userStatements: number }
type Measure = { name: string; def: string; need: string; have: string; feature: boolean; dataOk: boolean }

export default function ScienceBasis({ interviewCount, evaluated, passed, userStatements }: Props) {
  const count = (status: Status) => METHODS.filter(method => method.status === status).length
  // 지표별로 "기능이 있는가 → 데이터가 충분한가"를 나눠 판정한다. 일치도는 시험용 데이터가 있어야만 계산된다.
  const MEASURES: Measure[] = [
    { name: '보류 예측 정확도', def: '시험용으로 숨긴 내 답을 아바타가 같은 판단으로 맞히는 비율(내 정보 없는 일반 아바타 대비 증분 포함)', need: '내 답 30건 이상', have: '자문자답 ' + interviewCount + '건', feature: false, dataOk: interviewCount >= 30 },
    { name: '재검사 천장 대비 점수', def: '(아바타 vs 나) ÷ (내 1차 vs 내 2차 답)', need: '같은 질문 2회 응답 20쌍 이상', have: '0쌍(수집 기능 없음)', feature: false, dataOk: false },
    { name: '블라인드 구별 정확도', def: '섞어 놓은 내 답과 아바타 답을 본인·지인이 맞히는 비율(50%에 가까울수록 좋음)', need: '답 쌍 30개 이상과 판정자', have: '0쌍(기능 없음)', feature: false, dataOk: false },
    { name: '가치·신념 근거 커버리지', def: '기본 가치·도덕 직관 항목 중 근거 진술이 3건 이상 있는 항목의 비율', need: '진술을 가치·신념·선호로 분류하는 기능', have: '발언 ' + userStatements + '건 · 자문자답 ' + interviewCount + '건(분류 안 됨)', feature: false, dataOk: false },
    { name: '근거 다양성·최신성', def: '가치 주장 하나당 독립 근거의 출처 종류 수, 마지막 확인 후 경과일', need: '분류 기능과 출처·시점 기록', have: '출처·시점은 KG에 있으나 가치 단위로 묶이지 않음', feature: false, dataOk: false },
    { name: '내적 일관성', def: '서로 모순되는 진술 쌍의 비율, 시간이 지나도 유지되는 정도', need: '진술 쌍 모순 판정(NLI) 기능', have: '기능 없음', feature: false, dataOk: false },
    { name: '말-행동 불일치율', def: '자기보고(말한 가치)와 관찰된 선택·대화가 어긋나는 비율', need: '자기보고와 관찰 기록을 같은 가치로 연결하는 기능', have: '기능 없음', feature: false, dataOk: false },
    { name: '수동 비교 일치율', def: '내가 쓴 기대 답과 아바타 답을 내가 직접 판정한 통과 비율', need: '30건 이상(주관 판정·문항 오염 한계)', have: evaluated ? passed + '/' + evaluated + '건 통과' : '0건', feature: true, dataOk: evaluated >= 30 },
  ]
  const verdict = (m: Measure) => !m.feature ? { text: '기능 없음', cls: 'bg-gray-200 text-gray-700' } : m.dataOk ? { text: '계산 가능', cls: 'bg-green-100 text-green-800' } : { text: '데이터 부족', cls: 'bg-amber-100 text-amber-800' }
  return <section className="view-panel p-4 sm:p-5">
    <h2 className="text-lg font-semibold">7. 일치(sync)의 과학적 근거와 측정 방법</h2>
    <p className="mt-1 text-sm text-gray-600">용어를 나눕니다. <strong>기초 지식</strong>은 내가 입력한 사실·기준·가치·기억, <strong>연결</strong>은 그것이 아바타의 답을 실제로 바꾸는지(6번), <strong>일치(sync)</strong>는 그 답이 내 답과 같은지입니다. “나와 똑같다”는 철학적으로 증명할 수 없으므로 목표는 <strong>시험한 영역에서 내 답과 구별되지 않는 정도</strong>를 재는 것입니다. 아래는 심리학·철학에서 쓰는 방법과 현재 반영 상태입니다.</p>
    <p className="mt-2 text-xs text-gray-500">반영됨 {count('done')} · 일부 반영 {count('partial')} · 아직 없음 {count('todo')} / 총 {METHODS.length}개. 위 기초 지식 지도의 퍼센트는 준비도이며 이 방법들로 잰 일치도(sync)가 아닙니다.</p>
    <div className="mt-4 grid gap-3 lg:grid-cols-2">
      {METHODS.map(method => <article key={method.name} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-gray-900"><span className="mr-2 rounded bg-indigo-100 px-1.5 py-0.5 text-xs font-medium text-indigo-800">{method.field}</span>{method.name}</h3>
          <Badge status={method.status} />
        </div>
        <p className="mt-1 text-xs text-gray-500">{method.source}</p>
        <p className="mt-2 text-gray-700">{method.idea}</p>
        <p className="mt-2 text-gray-700"><span className="font-medium">재는 법:</span> {method.measure}</p>
        <p className="mt-1 text-gray-700"><span className="font-medium">이 앱에서:</span> {method.where}</p>
      </article>)}
    </div>
    <h3 className="mt-6 font-semibold">지금 정보로 일치(sync)를 판단할 수 있나</h3>
    <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-medium">결론: 지금은 판단할 수 없습니다. 지도의 퍼센트는 일치도가 아니라 입력 준비도입니다.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>입력량이 같아도 아바타가 나와 다르게 답할 수 있습니다. 일치도는 정의상 “아바타의 답 vs 내 답”을 비교해야 나옵니다.</li>
        <li>비교하려면 학습에 쓰지 않은 내 답이 따로 있어야 합니다. 지금은 자문자답 {interviewCount}건, 내 발언 {userStatements}건이고 대부분 짧은 인사 수준입니다.</li>
        <li>표본이 작으면 오차가 큽니다. 정확도를 50% 근처로 가정하면 30건일 때 95% 신뢰구간이 약 ±18%p, 100건일 때 약 ±10%p입니다.</li>
        <li>지금 정보로 가능한 것은 준비도와 일부 내부 점검(근거 커버리지, 모순, 최신성)이며, 이것도 진술을 가치로 분류하는 기능이 먼저 필요합니다.</li>
      </ul>
    </div>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left text-xs">
        <thead><tr className="border-b border-gray-300 text-gray-600"><th className="p-2 font-medium">지표</th><th className="p-2 font-medium">정의</th><th className="p-2 font-medium">필요한 것</th><th className="p-2 font-medium">현재</th><th className="p-2 font-medium">판정</th></tr></thead>
        <tbody>
          {MEASURES.map(measure => {
            const result = verdict(measure)
            return <tr key={measure.name} className="border-b border-gray-200 align-top">
              <td className="p-2 font-medium text-gray-900">{measure.name}</td>
              <td className="p-2 text-gray-700">{measure.def}</td>
              <td className="p-2 text-gray-700">{measure.need}</td>
              <td className="p-2 text-gray-700">{measure.have}</td>
              <td className="p-2"><span className={'whitespace-nowrap rounded px-2 py-0.5 font-medium ' + result.cls}>{result.text}</span></td>
            </tr>
          })}
        </tbody>
      </table>
    </div>
    <p className="mt-2 text-xs text-gray-500">위 지표 중 처음 세 개가 실제 일치도를 직접 재고, 나머지는 일치도를 대신하지 않고 근거의 질과 일관성을 점검합니다.</p>
    <h3 className="mt-6 font-semibold">무엇을 알아내야 하나: 지식이 아니라 가치·신념·선호</h3>
    <p className="mt-1 text-sm text-gray-600">아바타가 나답게 판단하려면 “내가 아는 것”보다 “내가 무엇을 중시하고 어떻게 고르는가”가 필요합니다. 아래는 이를 재는 심리학의 표준 구성개념과 질문 방식입니다. Park et al.(2026)도 인터뷰와 설문을 함께 쓸 때 가장 정확했습니다(86%, 각각 83·82%).</p>
    <div className="mt-3 grid gap-3 lg:grid-cols-2">
      {CONSTRUCTS.map(item => <article key={item.name} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold text-gray-900">{item.name}</h4><Badge status={item.status} /></div>
        <p className="mt-1 text-xs text-gray-500">{item.source}</p>
        <p className="mt-2 text-gray-700">{item.what}</p>
        <p className="mt-2 text-gray-700"><span className="font-medium">묻는 법:</span> {item.ask}</p>
      </article>)}
    </div>
    <div className="mt-3 rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm text-indigo-950">
      <p className="font-medium">KG에 기록하는 틀 (일부 구현: 판단 사례의 출처·시점·확신도·승인·충돌 확인·정책 버전, 2026-10-13)</p>
      <p className="mt-1">가치·신념·선호는 지식 노드와 구분해 저장하고, 각 항목에 <strong>내용 · 강도(순위) · 적용 조건(if-then) · 근거 유형(자기보고 / 관찰된 선택 / 추정) · 확인 시점 · 충돌하는 항목</strong>을 남깁니다. 답변할 때는 사실과 따로 “내가 중시하는 것”으로 넣고, 오래됐거나 자기보고와 행동이 다른 항목은 다시 확인합니다.</p>
      <p className="mt-2 text-xs text-indigo-900">현재 심층 인터뷰는 KG 주제에서 질문을 만들어 관점(판단 기준·예외·트레이드오프 등)을 바꿔 묻고, 구조화된 판단 사례(상황·선택지·선택·이유·버린 선택지·예외)를 출처·기록 시점·승인 상태·확신도·충돌 확인 상태·정책 버전과 함께 따로 저장합니다. 아직 없는 것: 강도(순위)와 적용 조건(if-then)을 가진 가치·신념 노드, 자기보고와 실제 선택의 자동 대조(충돌 확인 상태는 ‘미확인’으로 남음), 직접 입력 사례 자체(현재 0건).</p>
    </div>
    <h3 className="mt-6 font-semibold">최근 연구 (2025~2026)</h3>
    <ul className="mt-2 space-y-2 text-sm">
      {RECENT.map(item => <li key={item.cite} className="rounded-lg border border-gray-200 p-3">
        {item.href ? <a href={item.href} target="_blank" rel="noreferrer" className="font-medium text-indigo-700 underline">{item.cite}</a> : <span className="font-medium">{item.cite}</span>}
        <p className="mt-1 text-gray-600">{item.note}</p>
      </li>)}
    </ul>
    <p className="mt-3 text-xs leading-5 text-gray-500">※ 최근 연구 중 일부는 초록·요약 기준으로 확인했고, 철학 논문 두 편은 저자·학술지를 확인하지 못해 제목과 DOI만 적었습니다. 인용하기 전에 원문을 확인하세요. 1995~2001년 고전 문헌의 서지는 기억에 근거하므로 쪽수 등은 재확인이 필요합니다.</p>
  </section>
}
