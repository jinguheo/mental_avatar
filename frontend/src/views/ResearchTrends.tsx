// "나를 닮은 아바타"의 구현·연구 동향 요약 (2026-10-18 기준).
// checked = 내가 arXiv 초록·논문 본문 등 원문으로 확인, agent = 조사 에이전트가 원문 확인했다고 보고(내가 재확인 전), summary = 검색 결과·다른 창 조사 글의 요약만 확인(인용 전 원문 확인 필요).
type Check = 'checked' | 'agent' | 'summary'
type Ref = { cite: string; note: string; href?: string; check: Check }

const CHECK: Record<Check, { text: string; cls: string }> = {
  checked: { text: '1차 출처 확인', cls: 'bg-green-100 text-green-800' },
  agent: { text: '조사 에이전트 확인', cls: 'bg-sky-100 text-sky-800' },
  summary: { text: '요약만 확인', cls: 'bg-amber-100 text-amber-800' },
}

const LAYERS = [
  { layer: '① 말·성격', what: '말투, 의견, 가치관', tech: 'LLM 파인튜닝, 인터뷰·메시지 기반 프롬프트', ours: '11명 데모는 자료 검색(RAG) + 수정 가능한 12축 가설. 개인 일치도는 아직 측정하지 않음' },
  { layer: '② 기억', what: '겪은 일, 지식, 판단 사례', tech: 'RAG, 계층 기억(원본 → 구조화된 요약 → 모델)', ours: '인물별 원문·추정·검토 의견을 분리 저장. 시간순 생애 기억과 충돌 해결은 미완료' },
  { layer: '③ 목소리', what: '음색, 억양', tech: '제로샷 음성 복제 TTS', ours: '11명 데모는 브라우저 일반 TTS. 인물별 음성 복제는 연결하지 않음' },
  { layer: '④ 얼굴·몸', what: '외모, 표정', tech: '3D Gaussian 헤드 아바타, 립싱크', ours: '11명 데모는 2D 5시점 시각화. 실제 3D 리그·표정·립싱크는 미완료' },
]

const RESEARCH_CORRECTIONS = [
  '연구 목표를 “사람의 복제”가 아니라 “남아 있는 기록과 검토된 기억 안에서 그 사람다운 답변 가능성을 제시하는 수정 가능한 페르소나”로 한정한다.',
  '78개 항목이 채워졌다는 사실을 재현 성공으로 해석하지 않는다. 원문·전언·추정·사용자 검토를 분리해 보고한다.',
  'MBTI는 진단이나 정답이 아니라 낮은 우선순위의 편집 가능한 가설로만 둔다. 가치·판단 기준·예외·확신도·시간 변화가 핵심 변수다.',
  '“1차 출처 확인”은 링크와 초록 또는 본문을 확인했다는 뜻일 뿐, 결과가 재현되었거나 이 프로젝트에 그대로 적용된다는 뜻이 아니다.',
  '“선행연구를 찾지 못했다”는 표현은 체계적 문헌고찰 전까지 신규성 증명이 아니라 제한된 검색에서의 미발견으로만 기술한다.',
  '평가는 말투의 그럴듯함과 사실 회수, 가치·판단 일치, 보류 정확도, 장기 일관성, 지인 블라인드를 분리하고 기본 LLM과 비교한다.',
]

const MIND: Ref[] = [
  { cite: 'Park et al., LLM Agents Grounded in Self-Reports Enable General-Purpose Simulation of Individuals (arXiv:2411.10109, 2024-11, v3 2026-06)', href: 'https://arxiv.org/abs/2411.10109', check: 'checked',
    note: '1,052명. 보류한 GSS 문항에서 본인이 2주 뒤 다시 답한 일치율 대비 인터뷰만 83%, 설문만 82%, 결합 86%, 인구통계만 74%. 인종·이념 집단 간 격차도 줄었다. 점수는 정답률이 아니라 “본인 재현도 대비”다.' },
  { cite: 'Shi et al., IMPersona: Evaluating Individual Level LM Impersonation (arXiv:2504.04332, 2025-04)', href: 'https://arxiv.org/abs/2504.04332', check: 'checked',
    note: '파인튜닝 + 계층 기억 검색 모델이 블라인드 대화에서 44.44% 사람으로 판정, 프롬프트만 쓴 최고 방식은 25%. 8B급 소형 모델로도 가능해 사기 등 오용 위험을 함께 지적(사기 역할극 응답은 요약만 확인).' },
  { cite: 'Guo et al., Individual Turing Test (arXiv:2603.01289, 2026-03)', href: 'https://arxiv.org/abs/2603.01289', check: 'checked',
    note: '한 명의 10년 치 메시지로 파인튜닝·RAG·기억·하이브리드를 비교. 지인이 판정하면 현재 방법은 통과하지 못하고 낯선 사람이 판정하면 훨씬 낫다. 파인튜닝은 일상 말투에, 검색·기억은 의견·선호 질문에 유리. (약 8년 치 이후 정체했다는 결과는 요약만 확인, 자동 언어 지표 기준)' },
  { cite: 'Toubia et al., Twin-2K-500 (arXiv:2505.17479, 2025-05)', href: 'https://arxiv.org/abs/2505.17479', check: 'checked',
    note: '2,058명·500문항 데이터. 마지막 웨이브에서 과제를 반복해 재검사 정확도 기준선을 만든 설계.' },
  { cite: 'Wang, Hunt, Tang, Joseph, When Can LLM Digital Twins Reduce Human Measurement? (arXiv:2609.07987, 2026-09)', href: 'https://arxiv.org/abs/2609.07987', check: 'checked',
    note: '트윈은 평균 효과는 재현해도 누가 평균에서 벗어나는지는 거의 못 맞힌다. 행동 충실도는 대체 가능성의 필요·충분 조건이 아니라는 결론.' },
]

const NEWER: Ref[] = [
  { cite: 'Peng, Gui et al., Digital Twins as Funhouse Mirrors: Five Key Distortions (arXiv:2509.19088, 2025-09, v5 2026-04)', href: 'https://arxiv.org/abs/2509.19088', check: 'checked',
    note: '사전등록 연구 19개·결과 164개. 질문 500개 이상으로 만든 트윈도 사람 응답과의 상관이 평균 r=0.20이고 기본 LLM보다 “조금” 나은 정도. 왜곡 다섯 가지: 개별화 부족, 고정관념화, 표상 편향, 이념 편향, 과잉 합리성.' },
  { cite: 'Wang et al., Mitigating Identity Essentialism in LLM Agents with Longitudinal Life Trajectories — LifeMem (arXiv:2608.19621, 2026-08, v3 2026-09)', href: 'https://arxiv.org/abs/2608.19621', check: 'checked',
    note: '고정 프로필 에이전트는 인구통계 라벨을 개인 특성처럼 다루는 “정체성 본질주의”를 보인다. 생애 사건 검색과 개인별 파라메트릭 메모리를 결합하면 응답 분포·집단 내 다양성·생애 단계별 개인 내 변화 재현이 좋아진다.' },
  { cite: 'He et al., PERSONAJUDGE: Simulating Individual Human Preference Judgments (arXiv:2607.05742, 2026-07)', href: 'https://arxiv.org/abs/2607.05742', check: 'checked',
    note: '훈련된 평가자 32명·판단 4,200건으로 개인 평가자를 시뮬레이션. “왜 그렇게 판단했는지”의 회고적 추론 기록이 가장 큰 이득(기본 판정기 대비 최대 +9.9%p)을 줬고, 인터페이스 텔레메트리는 오히려 해가 되는 경우가 많았다.' },
  { cite: 'Dahiya, Anacreon: mixture of minds (arXiv:2608.06115, 2026-08)', href: 'https://arxiv.org/abs/2608.06115', check: 'agent',
    note: 'Gemma 4 12B 위에 클러스터별 어댑터를 두고 선택지 순서를 섞어 프롬프트 취약성을 줄였다. 개인 수준 순서 정렬 점수 0.775를 보고.' },
  { cite: 'Du, 에이전트 메모리 서베이 (arXiv:2603.07670, 2026-03)', href: 'https://arxiv.org/abs/2603.07670', check: 'checked',
    note: '메모리를 write–manage–read 루프로 정리한 서베이(Memory for Autonomous LLM Agents). 신뢰할 수 있는 성찰과 학습된 망각을 남은 과제로 꼽고, 기록 단계 필터링·모순 처리는 “엔지니어링 현실”로 다룬다(초록 확인, 2026-10-11 정정).' },
  { cite: 'policy capturing을 LLM과 결합해 한 개인의 판단을 복제한 논문 / 특정 개인의 가치·윤리 판단을 홀드아웃으로 예측하는 벤치마크', check: 'agent',
    note: '조사 에이전트가 찾지 못했다. 이 프로젝트의 “판단 정책 포착”은 선행 연구가 거의 없는 영역일 수 있다(내 해석). 방법론 자체는 심리학의 policy capturing으로 정리돼 있다.' },
]

const APPEARANCE_VOICE_NEW: Ref[] = [
  { cite: 'FastGHA (arXiv:2601.13837, ICLR 2026) · ELITE (arXiv:2601.10200, 2026-01)', href: 'https://arxiv.org/abs/2601.13837', check: 'agent',
    note: '사진 몇 장(FastGHA) 또는 휴대폰 단안 영상(ELITE)으로 3D Gaussian 머리 아바타를 만든다. ELITE는 기준 방법보다 약 60배 빠르다고 보고. 코드 공개와 Windows 실행 가능 여부는 확인하지 못했다.' },
  { cite: 'LAM (SIGGRAPH 2025, arXiv:2502.17796) · GUAVA (ICCV 2025)', href: 'https://arxiv.org/abs/2502.17796', check: 'summary',
    note: 'LAM은 사진 1장에서 FLAME 기반 Gaussian 머리를 한 번의 추론으로 만들고 WebGL 렌더러를 공개. GUAVA는 사진 1장으로 상반신을 약 0.1초에 재구성. FLAME을 쓰는 점이 현재 MICA 파이프라인과 잘 맞는다(내 해석).' },
  { cite: 'Qwen3-TTS (Apache-2.0, 2026-01) · Chatterbox Multilingual (MIT)', href: 'https://github.com/QwenLM/Qwen3-TTS', check: 'agent',
    note: 'Qwen3-TTS는 3초 참조 음성으로 복제하고 한국어를 포함한 10개 언어를 지원. Chatterbox는 23개 언어(한국어 포함)와 모든 출력에 워터마크를 넣는다. 현재 쓰는 XTTS의 대체 후보. Fish Speech S1-mini가 비상업 라이선스라는 보고는 요약만 확인.' },
]

const PRODUCTS: Ref[] = [
  { cite: 'HeyGen · Synthesia (개인 아바타)', href: 'https://help.heygen.com/en/articles/12092609-recording-your-consent-video', check: 'summary',
    note: '두 서비스 모두 본인의 동의 영상을 실시간 녹화해야 하고, HeyGen은 동의 영상과 촬영본 속 얼굴이 같은 사람인지 대조한다. 동의 검증이 제품의 핵심 장치.' },
  { cite: 'Delphi (Digital Mind)', href: 'https://www.fastcompany.com/91356476/delphi-ai-digital-mind', check: 'summary',
    note: '본인의 책·팟캐스트·영상을 넣어 “Digital Mind”를 만들고 답변에 출처를 인용, 음성 복제와 신분증 검증을 한다고 보도. 공식 사이트에서는 구축 방식을 확인하지 못했다. 사용자의 판단 정책을 따로 모델링한다는 증거는 못 찾았다(내 해석).' },
  { cite: 'Soul Machines', href: 'https://www.nzherald.co.nz/business/ai-casualty-once-high-flying-soul-machines-in-receivership/YCN66TQ7BJDFLAMSWGKQCIJNN4/', check: 'summary',
    note: '2026-02 법정관리(KPMG 수탁인 지정) 후 AppDirect가 인수했다고 보도.' },
]

// 2026-10-19 추가: 빅테크의 "개인 에이전트·아바타" 서비스. 에이전트(일을 하는 몸)와 아바타(보이는 얼굴·정체성)를 구분해서 본다.
const AGENT_PRODUCTS: Ref[] = [
  { cite: 'OpenAI Dots (2026-09-29 DevDay, GPT-6 Astra)', href: 'https://techcrunch.com/2026/09/29/openai-launches-dots-its-bubbly-agentic-avatar/', check: 'checked',
    note: '항상 켜져 있는 개인 에이전트. 목표를 받아 배경에서 스스로 일하고 Slack·Teams로 메시지를 주고받는다. 아바타는 둥둥 떠다니는 점 모양의 귀여운 캐릭터로, 사용자를 닮은 모습이 아니라 AI를 친근하게 보이게 하는 얼굴이다. 이 기사 기준으로 ChatGPT Pro·Business Premium에서 제공되고, 역할·자격증명·도구를 가진 “전문 Dot”과 Dot 팀 협업이 예고됐다. 안전 기본값(읽기 전용 등)은 이 기사에서 확인하지 못했다.' },
  { cite: 'Meta Muse · 마스코트 Jolly (2026-09)', href: 'https://axios.com/2026/09/25/ai-doom-meta-muse-mascot', check: 'summary',
    note: '개인 AI 에이전트 Muse의 기본 아바타가 마스코트 Jolly. 이름·외형·말투를 사용자가 고르고, 실시간 아바타 영상 대화(Muse Realtime Avatar)와 아바타를 보여 주는 소형 기기(Muse Charm)가 예고됐다는 보도. 원문은 접속이 막혀 검색 결과 요약만 확인했다. 출시 여부는 확인하지 못했다.' },
  { cite: 'Microsoft Research, Digital Me (2016-04 시작)', href: 'https://www.microsoft.com/en-us/research/project/digital-me/', check: 'checked',
    note: '각 사람의 지식을 디지털화해 개인 “Avatar”를 만들고, 그 사람의 DM 에이전트가 본인을 대신해 디지털 업무·생활에 참여한다는 연구 프로젝트. 사람이 자기 에이전트를 직접 키우는 기여자이고, 문서에 없는 지식도 사람과 환경에서 배우며, 하나의 정답이 아니라 사람마다 다른 의견을 준다는 점을 차별점으로 든다. 페이지는 Avatar(개인의 디지털 표상)와 에이전트(행동하는 소프트웨어)를 구분해 쓴다.' },
  { cite: 'Microsoft Digital, DigitalMe (사내 IT 에이전트)', href: 'https://windowsnews.ai/article/microsoft-digitalme-twin-agent-cuts-meeting-time-and-email-overload.425455', check: 'summary',
    note: '직원이 바쁠 때 일을 이어 가는 개인 가상 대리인. Copilot Studio와 Microsoft 365 데이터(Graph)로 Teams 회의·Outlook에서 질문에 답하고 일을 처리한다는 보도. “90% 정확도” 수치는 보도 하나의 주장이고 확인하지 못했다. 위 연구 프로젝트(2016)와 이름만 같고 별개 사내 사례다.' },
  { cite: 'Coll et al., Towards the “Digital Me” (arXiv:2506.23826)', href: 'https://arxiv.org/abs/2506.23826', check: 'summary',
    note: '위 Microsoft 프로젝트와 이름만 같은 별개 논문(개인 데이터 기반 디지털 트윈 구조 제안). 기억 계층 목록에 이미 있다.' },
]

// "그냥 에이전트"와 "아바타"를 가르는 기능 기준. 위 서비스를 이 표에 놓고 본다.
const AVATAR_FEATURES = [
  { f: '보이는 얼굴·캐릭터', agentOnly: '있어도 장식(Dots·Muse의 만화 마스코트)', avatar: '대상 인물을 알아볼 수 있는 외형' },
  { f: '정체성', agentOnly: '“누구를 닮았는가”가 없음. 이름·성격은 사용자가 고르는 설정', avatar: '특정인(본인·고인·역사 인물)의 지식·말투·가치관·판단을 닮는 것' },
  { f: '지식의 출처', agentOnly: '일반 모델 + 연결된 앱·메일·문서', avatar: '그 사람의 기록·기억·판단 사례' },
  { f: '하는 일', agentOnly: '업무 대행(예약, 메일, 코드 수정, 모니터링)', avatar: '그 사람처럼 답하고 판단하기. 일 대행은 선택 기능' },
  { f: '평가 기준', agentOnly: '과업 성공률, 자동화한 시간', avatar: '본인 재현도, 지인 블라인드 구별, 가치·판단 일치' },
  { f: '동의·안전', agentOnly: '권한 범위, 자격증명 관리', avatar: '본인·유족 동의, AI 표시, 즉시 중지, 초상·음성 권리' },
]

const AGENT_VS_US = [
  { who: '같은 점', text: '개인 데이터를 계속 모으고(기억), 사용자를 대신해 말하고 일하게 하며(대리), 얼굴이라는 표현 계층을 붙인다. Digital Me가 가장 가까워서 “지식 디지털화 → 개인 Avatar → 대리 행동”이라는 목표 구조가 이 프로젝트와 같다.' },
  { who: '다른 점', text: 'Dots·Muse는 에이전트의 얼굴이고 정체성은 사용자가 고르는 설정이다. 이 프로젝트는 “누구와 얼마나 같은가”가 핵심 지표이고, 그래서 외형·지식·행동 세 축의 일치를 따로 잰다. 다른 아바타 연구(Park 외, Second Me 등)와 비교하면 이 프로젝트는 본인뿐 아니라 고인·역사 인물까지 같은 구조로 다루고 근거(원문·전언·추정·리뷰)를 분리해 보인다.' },
  { who: '다른 점', text: '상용 에이전트는 권한과 보안(Agent 365 연동 등)을 안전의 중심에 두고, 이 프로젝트는 초상·음성·유족 동의와 “AI 표시”를 중심에 둔다. 실존 인물을 모사하므로 4모드(텍스트 전용·역사·가상 AI·본인 동의)로 허용 범위를 나눈다.' },
  { who: '지향할 점', text: '에이전트 기능(일 대행)보다 “닮음의 측정 가능성”을 먼저 확보한다. 기본 LLM 대조군과 지인 블라인드로 일치를 재고, 근거가 없는 질문은 추정·기록 없음으로 표시한다. 상용 서비스가 주지 않는 이 투명성이 차별점이다.' },
  { who: '지향할 점', text: '표현 계층은 Digital Me처럼 “아바타(표상)와 에이전트(행동)를 분리”해 설계한다. 대리 행동은 읽기 전용에서 시작해 권한을 단계적으로 열고, 고인·유명인은 대리 행동 없이 대화만 한다.' },
  { who: '지향할 점', text: 'Muse Realtime Avatar 같은 실시간 영상 아바타가 정착해도 얼굴만 닮은 아바타가 되지 않도록, 지식·판단 일치 평가를 얼굴 품질과 따로 보고한다. 실시간·립싱크는 후순위로 두고 근거 기반 답변의 신뢰도를 먼저 올린다.' },
]

const REGS: Ref[] = [
  { cite: 'EU AI Act 제50조 · 표시·라벨링 행동강령 (2026-06-10)', href: 'https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content', check: 'agent',
    note: '딥페이크 고지 등 투명성 의무가 2026-08-02부터 적용 중. 일부 표시 유예 날짜는 출처마다 다르다.' },
  { cite: '미국: NO FAKES Act(S.4591) · 주법(테네시 ELVIS, 캘리포니아 AB 2602, 뉴욕 GOL §5-302)', href: 'https://www.congress.gov/bill/119th-congress/senate-bill/4591', check: 'summary',
    note: 'NO FAKES Act는 2026-05 재발의되고 6월 상원 법사위를 통과했지만 아직 본회의 전. 주법은 2024~2025년에 시행.' },
  { cite: '한국: AI 기본법(2026-01-22 시행) 제31조 등', href: 'https://iapp.org/news/a/south-korea-s-ai-basic-act-puts-another-ai-governance-regulation-on-the-map', check: 'summary',
    note: '생성형 AI 사전 고지, 결과물 표시, 실제와 구분하기 어려운 딥페이크의 명확한 표시를 요구하고 과태료는 최대 3천만 원(계도기간 최소 1년 보도). 원문(국가법령정보센터)은 미확인. 본인이 본인 복제본을 만드는 것 자체는 주 대상이 아니지만 외부에 공유하면 표시 의무가 걸릴 수 있다(내 해석).' },
]

const SECOND_ME_FACTS = [
  { h: '정체', t: 'Mindverse의 오픈소스 “개인 AI”. 논문(arXiv:2503.08102, v2 2025-03-12)은 “심사 중” 프리프린트이고 프로젝트 리드가 회사 소속이다. 저장소는 Apache-2.0, 별 약 1.5만 개이며 릴리스는 비어 있고 로드맵이 2025년 5월에서 멈춰 있다(최근 활동은 확인 못 함).' },
  { h: '목표', t: '사용자를 대신해 판단하는 게 아니라 “컨텍스트 제공자”다. 사용자 정보를 미리 채워 주고, 외부 전문가 모델에게 보낼 요청을 보강(Context Enhance)하고, 외부 답을 사용자 관점에서 비평(Context Critic)한다.' },
  { h: '3층 구조', t: 'L0 원본 데이터(RAG) / L1 자연어 기억(짧은 자기소개, 중요한 문장, 선호 태그) / L2 모델 파라미터에 학습된 기억. LPM 1.0에서는 층이 따로 놀았고 Second Me는 L0·L1이 L2를 돕는 안쪽 루프와, L2가 외부 LLM·인터넷을 지휘하는 바깥쪽 루프를 둔다.' },
  { h: '학습 파이프라인', t: '노트·할 일 → GraphRAG로 엔티티·관계·커뮤니티 추출 → 전기와 상태 설명 생성 → QA 쌍 합성 → 5단계 필터 → Qwen2.5-7B-Instruct에 PEFT/SFT → 선호쌍(전체 SFT의 약 20%)으로 DPO. 답변 방식은 약/다단계/강(DeepSeek-R1이 만든 구조화된 사고 과정) 세 가지를 비교.' },
  { h: '평가 설정', t: '사내 직원 1명(노트 132개·할 일 62개, 지시문 약 7천 쌍)만 공개. 시험은 1인칭 기억 QA 60개, 3인칭 기억 QA 60개, 컨텍스트 보강 60개, 컨텍스트 비평 60개. 판정은 LLM이 0/0.5/1(비평은 5단계)로 채점한다.' },
  { h: '결과(만점 대비)', t: '강 사고 과정 + DPO: 기억(자신) 0.96 · 기억(제3자) 0.76 · 보강 0.85 · 비평 0.86. DPO 없이 0.91/0.71/0.75/0.85, 약 사고 과정 + DPO 0.90/0.60/0.83/0.70, 다단계 0.64/0.43/0.85/0.77. 사람 평가는 강 사고 과정 DPO 없음 평균 0.95, DPO 있음 “1에 가까움”(평가자 수는 없음).' },
]

const SECOND_ME_CAVEATS = [
  '평가 대상이 직원 1명이고 채점이 LLM이다. 저자도 평가 모델이 긴 답을 선호하는 편향을 인정하고, “LLM 평가가 품질을 과소평가한다”고 쓰지만 근거는 소수 사례뿐이다.',
  'RAG·긴 문맥과의 비교 표는 이 논문에 없다. “RAG보다 낫다”는 이전 연구(LPM 1.0)를 요약한 문장이다.',
  '본문이 모순된다. 파이프라인에는 5단계 필터가 있다고 하면서 토론에서는 “필터링 없이 강 사고 과정으로 정규화한 데이터가 최고”라고 쓴다.',
  '컨텍스트 보강 점수는 저자도 부정확하다고 인정하고, 평가 코드를 고쳐 저장소를 갱신하겠다고 적었다.',
  '제3자가 물었을 때(0.76)가 본인이 물었을 때(0.96)보다 훨씬 낮다. 남에게 나를 대신해 답하는 용도에는 가장 약한 지점이다.',
  '강 사고 과정 예시는 “양자 광채의 위상 지도”처럼 화려한 문장이다. 사실에 충실한지보다 그럴듯한 문체가 점수를 받았을 수 있다(내 해석).',
  '응용 절의 NFT 기반 인지 자산, 메트칼프 법칙 “3~5 자릿수” 효율 향상 등은 근거 없는 주장이다.',
  '하드웨어는 논문에 없고 README의 예시는 8GB 0.8B, 16GB 1.5B, 32GB 2.8B 수준으로 논문의 7B보다 훨씬 작다. 0.5B 미만은 복잡한 작업에 약하다고 적혀 있다.',
]

const SECOND_ME_FIT = [
  { who: '구조만 유사', text: 'KG + RAG는 L0, 승인한 통합 요약은 L1과 구조적으로 비슷하다. 그러나 11명 공개 인물 데모의 의견은 아직 실제 당사자 승인 데이터가 아니므로 동등한 개인 모델이라고 볼 수 없다.' },
  { who: '가져올 만함', text: '컨텍스트 비평(Context Critic) 패턴: 외부 전문가 LLM이 답을 내면 “내 노트·기준”을 아는 개인 모델이 그 답을 비평한다. 우리 판단 워크플로우의 ③ 내 기준 적용 단계를 이런 비평 단계로 만들 수 있다(내 해석).' },
  { who: '가져올 만함', text: '평가 항목을 1인칭과 제3자로 나눠 재는 것. 우리는 방문자에게도 답하므로 “남이 물었을 때”를 따로 재야 한다.' },
  { who: '지금은 이름', text: 'L2(개인 모델 학습)는 데이터가 모자란다. 그들의 시험 사용자도 노트 132개·할 일 62개였고, 우리는 노트 31개에 의미 있는 발언이 거의 없다. 학습 재료도 노트(지식)라서 가치·판단 기준이 아니라 “노트에 있는 내용”을 익힌다.' },
  { who: '다른 목표', text: 'Second Me는 컨텍스트 제공자이고 이 프로젝트는 판단 보조까지 지향한다. 보류 사례·재검사 상한·지인 블라인드를 결합한 평가는 아직 설계이며, 더 엄격하다고 주장하려면 실제 실험이 필요하다.' },
]

const MEMORY: Ref[] = [
  { cite: 'Coll et al., Towards the “Digital Me” (arXiv:2506.23826)', href: 'https://arxiv.org/abs/2506.23826', check: 'summary',
    note: '개인 데이터를 계속 갱신하고 문맥을 고려한 기억 검색과 통합을 쓰는 인간 디지털 트윈 구조 제안. 구현·평가보다 비전 논문에 가깝다.' },
  { cite: 'Wei et al. (Mindverse), AI-native Memory 2.0: Second Me (arXiv:2503.08102, 2025-03, v2)', href: 'https://arxiv.org/abs/2503.08102', check: 'checked',
    note: 'L0 원본 / L1 자연어 요약 / L2 개인 모델(Qwen2.5-7B + PEFT/SFT/DPO) 3층 구조의 오픈소스 프로토타입. 아래 “Second Me 상세 분석” 참고. 심사 전 프리프린트이고 평가는 직원 1명 기준이다.' },
  { cite: 'AI YOU Town: Make Friends and Money with Your Digital Twin (arXiv:2607.10539)', href: 'https://arxiv.org/abs/2607.10539', check: 'summary',
    note: '페르소나마다 파인튜닝하지 않고 구조화된 장기 기억으로 일관성을 유지하자는 입장. 시스템 프롬프트 페르소나는 긴 대화에서 앞말과 모순되는 드리프트가 생긴다고 지적.' },
]

const VOICE_FACE: Ref[] = [
  { cite: 'Lightweight zero-shot TTS (arXiv:2501.08566)', href: 'https://arxiv.org/abs/2501.08566', check: 'summary',
    note: '수 초~10초 참조 음성에서 화자 임베딩을 뽑아 조건으로 합성하고 보코더로 파형을 만드는 일반 구조. 화자 유사도·지연을 비교한 벤치마크는 검색에서 못 찾았다.' },
  { cite: 'ai-avatar-system (GitHub 오픈소스)', check: 'summary',
    note: '마이크 → Whisper → LLM(스트리밍) → Chatterbox TTS → MuseTalk 립싱크로 이어 붙이고 문장 단위 병렬 처리, 끼어들기와 완전 로컬 모드 지원. 지연 수치는 프로젝트 자체 보고.' },
  { cite: '3D Gaussian Blendshapes for Head Avatar Animation (SIGGRAPH 2024)', check: 'summary', note: '중립 얼굴과 표정 블렌드셰이프를 학습, 약 370 fps 보고. 단안 영상 기반 3DGS 헤드 아바타 흐름의 대표.' },
  { cite: 'HRAvatar (CVPR 2025)', check: 'summary', note: '조명을 바꿔도 자연스러운 재조명(relightable) 헤드 아바타를 목표.' },
  { cite: 'GAF: Gaussian Avatar Reconstruction from Monocular Videos (2025)', check: 'summary', note: '영상에 안 보이는 부분을 멀티뷰 확산 모델로 채운다. 얼굴 쪽 전문 서베이는 검색에서 찾지 못했다.' },
]

const EVAL: Ref[] = [
  { cite: 'TwinVoice: A Multi-dimensional Benchmark Towards Digital Twins via LLM Persona Simulation (arXiv:2510.25536, 2025-10)', href: 'https://arxiv.org/abs/2510.25536', check: 'summary',
    note: '사고방식 일관성과 언어 표현을 나눠 객관식·생성형(LLM 판정)으로 평가. 어휘 충실도·의견 일관성은 높고 생성형 점수는 더 낮다.' },
  { cite: 'How Far are LLMs from Being Our Digital Twins? (arXiv:2502.14642)', href: 'https://arxiv.org/abs/2502.14642', check: 'summary',
    note: 'BehaviorChain: 소설·전기에서 뽑은 페르소나별 행동 연쇄 1,001개로 행동 예측(객관식)과 생성을 평가. (ACL 2025 Findings라는 정보는 다른 창 글에서만 확인)' },
]

const ETHICS: Ref[] = [
  { cite: 'Digital Doppelgangers: Ethical and Societal Implications of Pre-Mortem AI Clones (arXiv:2502.21248)', href: 'https://arxiv.org/abs/2502.21248', check: 'summary',
    note: '동의 확보의 어려움, 삭제 후에도 파생 모델이 남는 문제, 무단 복제를 지적.' },
  { cite: 'AI 음성 복제와 동의 분석 (SCC Online)', check: 'summary', note: '모델 파라미터에 녹아든 데이터는 분리·삭제가 어려워 삭제권과 잘 안 맞는다는 분석. 특정 국가(인도) 법 분석이라 일반화는 조심.' },
  { cite: 'Cambridge “Griefbot” 연구 기사', check: 'summary', note: '고인 복제의 동의, 종료 방법(off switch), 상호작용하는 유족의 권리를 다룬다.' },
]

const TAKEAWAYS = [
  { who: '이미 맞는 방향', text: '말투·의견은 파인튜닝이 아니라 검색·기억 + 정리된 요약으로 분담하는 하이브리드가 유력하다(Individual Turing Test). 지금 구조(통합 요약 + 말투 블록 + RAG)가 이 분담과 같다.' },
  { who: '이미 맞는 방향', text: '평가를 본인 재현도 대비로 하고(Park, Twin-2K-500), 지인 블라인드로 구별하게 하는 것(IMPersona, Individual Turing Test)이 표준이다. 7번에 적은 측정 계획과 같다.' },
  { who: '이미 맞는 방향', text: '고정 프로필만 두면 정체성 본질주의나 과잉 합리성 같은 왜곡이 생긴다(Funhouse Mirrors, LifeMem). 요약 하나에 의존하지 않고 시간순 사건과 판단 사례를 선택적으로 함께 넣는 쪽을 검토한다(내 해석).' },
  { who: '추가할 점검', text: '판단 사례를 모을 때 결론만이 아니라 이유·고려했다가 버린 선택지·확신도를 같이 받는다. 회고적 추론 기록이 가장 효과적이었다(PERSONAJUDGE).' },
  { who: '추가할 점검', text: '일치 측정에는 사람 판정자와 함께 “프로필 없는 기본 LLM”을 대조군으로 넣는다. 트윈이 기본 LLM보다 얼마나 나은지가 핵심 지표다(Funhouse Mirrors).' },
  { who: '추가할 점검', text: '외부에 영상·음성을 공유한다면 “AI 생성” 표시를 기본값으로 넣는다(EU 제50조, 한국 AI 기본법 흐름). 음성은 Qwen3-TTS를 XTTS 대체 후보로 먼저 검증한다(내 해석).' },
  { who: '검토 후보', text: '말투 파인튜닝(소형 모델 + LoRA)은 의미 있는 내 발언이 충분히 쌓인 뒤의 후보다. 지금은 표본이 거의 없어 성급하다(내 해석).' },
  { who: '추가할 점검', text: '긴 대화에서 앞말과 모순되는 드리프트(AI YOU Town)와 최근 일에 대한 시의성 질문(IMPersona에서 가장 잘 통한 탐지법)을 연결 검사나 일치 측정에 넣을 만하다(내 해석).' },
  { who: '주의', text: '평균을 재현하는 것과 개인을 맞히는 것은 다르다(Wang 외). 한 명짜리 사례 연구와 소규모 표본이 대부분이라 결과를 일반화하지 않는다.' },
  { who: '주의', text: '얼굴·목소리는 오용 위험이 크다. 내 것을 내가 쓰는 건 동의 문제가 단순하지만, AI임을 밝히고 내가 즉시 중지할 수 있어야 한다(신원·안전장치 기준에 이미 있음).' },
]

function RefList({ items }: { items: Ref[] }) {
  return <ul className="mt-2 space-y-2 text-sm">
    {items.map(item => <li key={item.cite} className="rounded-lg border border-gray-200 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        {item.href ? <a href={item.href} target="_blank" rel="noreferrer" className="font-medium text-indigo-700 underline">{item.cite}</a> : <span className="font-medium">{item.cite}</span>}
        <span className={'whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ' + CHECK[item.check].cls}>{CHECK[item.check].text}</span>
      </div>
      <p className="mt-1 text-gray-600">{item.note}</p>
    </li>)}
  </ul>
}

export default function ResearchTrends() {
  return <div className="view-canvas h-full overflow-y-auto">
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 pb-24 sm:px-6">
      <header>
        <p className="dashboard-kicker">2026-10-19 기준</p>
        <h1 className="mt-1 text-2xl font-semibold text-gray-950">아바타 연구 동향</h1>
        <p className="mt-2 text-sm leading-6 text-gray-600">“나를 닮은 아바타”는 보통 말·성격, 기억, 목소리, 얼굴·몸 네 층을 따로 만들어 이어 붙입니다. 층마다 연구 흐름이 다르고, 아래에 이 프로젝트의 현재 상태를 나란히 적었습니다.</p>
        <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs leading-5 text-amber-900">출처 표시: <strong>1차 출처 확인</strong>은 arXiv 초록 또는 논문 본문에서 해당 서지와 주장을 확인한 것입니다. 초록만 확인한 연구와 본문까지 검토한 연구는 본문 메모에서 구분해야 하며, 이 표시는 재현 검증을 뜻하지 않습니다. <strong>조사 에이전트 확인</strong>과 <strong>요약만 확인</strong>은 정식 인용 전에 반드시 원문을 다시 확인해야 합니다.</p>
      </header>

      <section className="view-panel border-indigo-200 bg-indigo-50/50 p-4 sm:p-5">
        <h2 className="text-lg font-semibold">이번 감사에서 바로잡은 연구 기준</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">{RESEARCH_CORRECTIONS.map(item => <li key={item}>{item}</li>)}</ul>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">한눈에 보기: 네 층과 이 프로젝트</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead><tr className="border-b border-gray-300 text-gray-600"><th className="p-2 font-medium">층</th><th className="p-2 font-medium">닮게 하는 것</th><th className="p-2 font-medium">대표 기술</th><th className="p-2 font-medium">이 프로젝트</th></tr></thead>
            <tbody>{LAYERS.map(row => <tr key={row.layer} className="border-b border-gray-200 align-top">
              <td className="p-2 font-medium text-gray-900">{row.layer}</td><td className="p-2 text-gray-700">{row.what}</td><td className="p-2 text-gray-700">{row.tech}</td><td className="p-2 text-gray-700">{row.ours}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">① 말·성격: 인터뷰로 생각을, 메시지로 말투를</h2>
        <p className="mt-1 text-sm text-gray-600">인터뷰·설문으로 “내 생각”을 모사하는 쪽과, 메시지 기록으로 “내 말투”를 모사하는 쪽으로 나뉩니다. 둘의 상충 관계가 핵심이라, 말투는 파인튜닝이 유리하고 의견·선호는 검색·기억이 유리하다는 하이브리드가 대세입니다.</p>
        <RefList items={MIND} />
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">2025~2026에 새로 나온 흐름</h2>
        <p className="mt-1 text-sm text-gray-600">개인 단위 정확도는 아직 낮다는 반증이 쌓이고, 판단을 재현할 때는 결론보다 “왜 그렇게 판단했는지” 기록이 가장 효과적이라는 결과가 나왔습니다. 평가도 “사람처럼 보이는가”에서 개인 수준 예측과 통계적 대체 가능성으로 옮겨가고 있습니다.</p>
        <RefList items={NEWER} />
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">② 기억: 내 데이터를 어떻게 쌓나</h2>
        <RefList items={MEMORY} />
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">Second Me 상세 분석 (논문 본문·부록 + 저장소 README)</h2>
        <p className="mt-1 text-sm text-gray-600">arXiv:2503.08102 본문과 부록을 직접 읽고 정리했습니다. 저장소 내용은 README 페이지 기준입니다.</p>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">{SECOND_ME_FACTS.map(item => <div key={item.h} className="rounded-lg border border-gray-200 bg-gray-50 p-3"><dt className="font-semibold text-gray-900">{item.h}</dt><dd className="mt-1 text-gray-700">{item.t}</dd></div>)}</dl>
        <h3 className="mt-4 font-semibold">믿을 만한 정도: 주의할 점</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">{SECOND_ME_CAVEATS.map(text => <li key={text}>{text}</li>)}</ul>
        <h3 className="mt-4 font-semibold">이 프로젝트와 비교</h3>
        <ul className="mt-2 space-y-2 text-sm">{SECOND_ME_FIT.map(item => <li key={item.text} className="flex items-start gap-2"><span className={'mt-0.5 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ' + (item.who === '이미 같은 구조' ? 'bg-green-100 text-green-800' : item.who === '가져올 만함' ? 'bg-indigo-100 text-indigo-800' : 'bg-gray-200 text-gray-700')}>{item.who}</span><span className="text-gray-800">{item.text}</span></li>)}</ul>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">③ 목소리와 ④ 얼굴</h2>
        <p className="mt-1 text-sm text-gray-600">검색 결과는 벤더 문서와 README 위주였고, 화자 유사도나 지연을 비교한 벤치마크는 찾지 못했습니다.</p>
        <RefList items={VOICE_FACE} />
        <h3 className="mt-4 font-semibold">새로 찾은 것 (2026)</h3>
        <RefList items={APPEARANCE_VOICE_NEW} />
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">상용 제품은 무엇을 하나</h2>
        <p className="mt-1 text-sm text-gray-600">상용 제품은 콘텐츠 검색, 출처 인용, 동의 검증에 무게를 둡니다.</p>
        <RefList items={PRODUCTS} />
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">빅테크의 개인 에이전트·아바타: 아바타인가, 그냥 에이전트인가</h2>
        <p className="mt-1 text-sm text-gray-600">OpenAI Dots, Meta Muse, Microsoft Digital Me는 모두 “나를 대신하는 AI”를 내세웁니다. 그러나 아바타(누군가를 닮은 표상)보다 에이전트(일을 하는 소프트웨어)에 가깝고, 얼굴은 대부분 장식입니다. 아래 표는 그 구분 기준입니다.</p>
        <RefList items={AGENT_PRODUCTS} />
        <h3 className="mt-4 font-semibold">아바타의 주요 기능 vs 그냥 에이전트</h3>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-xs">
            <thead><tr className="border-b border-gray-300 text-gray-600"><th className="p-2 font-medium">기능</th><th className="p-2 font-medium">에이전트(Dots·Muse 등)</th><th className="p-2 font-medium">아바타(이 프로젝트가 지향)</th></tr></thead>
            <tbody>{AVATAR_FEATURES.map(row => <tr key={row.f} className="border-b border-gray-200 align-top">
              <td className="p-2 font-medium text-gray-900">{row.f}</td><td className="p-2 text-gray-700">{row.agentOnly}</td><td className="p-2 text-gray-700">{row.avatar}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <h3 className="mt-4 font-semibold">다른 아바타 연구와의 차이, 그리고 지향할 점 (내 해석)</h3>
        <ul className="mt-2 space-y-2 text-sm">{AGENT_VS_US.map(item => <li key={item.text} className="flex items-start gap-2"><span className={'mt-0.5 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ' + (item.who === '지향할 점' ? 'bg-indigo-100 text-indigo-800' : item.who === '같은 점' ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700')}>{item.who}</span><span className="text-gray-800">{item.text}</span></li>)}</ul>
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">평가는 어떻게 하나</h2>
        <p className="mt-1 text-sm text-gray-600">지인 블라인드 구별(IMPersona, Individual Turing Test), 본인 재현도 대비(Park, Twin-2K-500), 벤치마크(TwinVoice, BehaviorChain)가 쓰입니다. 공통 한계는 소규모 표본, 짧은 대화, 자동 지표이며 장기 대화의 드리프트는 아직 잘 못 잽니다.</p>
        <RefList items={EVAL} />
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">윤리·위험</h2>
        <RefList items={ETHICS} />
        <h3 className="mt-4 font-semibold">규제 (2026-10 기준)</h3>
        <RefList items={REGS} />
      </section>

      <section className="view-panel p-4 sm:p-5">
        <h2 className="text-lg font-semibold">이 프로젝트에 주는 시사점</h2>
        <ul className="mt-2 space-y-2 text-sm">{TAKEAWAYS.map(item => <li key={item.text} className="flex items-start gap-2"><span className={'mt-0.5 whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ' + (item.who === '주의' ? 'bg-red-100 text-red-800' : item.who === '이미 맞는 방향' ? 'bg-green-100 text-green-800' : 'bg-indigo-100 text-indigo-800')}>{item.who}</span><span className="text-gray-800">{item.text}</span></li>)}</ul>
      </section>
    </div>
  </div>
}
