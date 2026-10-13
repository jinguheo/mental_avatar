// 홍보용 홈페이지(랜딩) — "진행 > 아바타논문 > 사업 모델"과 "확장: 아바타 카드" 내용을 일반인 눈높이로 옮긴 것.
// 원칙: 아직 검증하지 않은 것을 사실처럼 쓰지 않는다. 시장 규모·치유 효과·가격·일치도 수치는 넣지 않았고,
// 구현 상태(구현됨/준비 중)를 그대로 표시한다. 사업 구상이 바뀌면 이 파일의 문구를 함께 고친다.
import { lazy, Suspense, useRef } from 'react'

const PromoPersonaDemo = lazy(() => import('./PromoPersonaDemo'))

// 문의를 받을 메일 주소. 비워 두면 신청 버튼이 페이지 맨 아래 안내로 이동만 한다(주소를 공개할지는 직접 정한다).
const CONTACT_EMAIL = ''
const BRAND = '그대로'

type Chip = '구현됨' | '준비 중' | '설계 단계'
const CHIP_CLS: Record<Chip, string> = {
  '구현됨': 'bg-emerald-100 text-emerald-800',
  '준비 중': 'bg-amber-100 text-amber-800',
  '설계 단계': 'bg-slate-200 text-slate-700',
}

const STEPS = [
  { n: '01', title: '자료를 올립니다', body: '대화 내역, 글, 사진, 영상, 가족이 기억하는 말투와 습관까지. 가진 만큼만 올려도 시작할 수 있습니다.' },
  { n: '02', title: '출처와 함께 정리합니다', body: '올린 자료는 사람의 말과 기억 단위로 정리되고, 모든 내용에 “어디서 나왔는지”가 붙습니다.' },
  { n: '03', title: '이야기를 나눕니다', body: '그 사람의 말투로 대답하되, 근거가 없는 것은 지어내지 않고 “기록에 없습니다”라고 말합니다.' },
]

const TIERS = [
  { name: '과거 기록', items: '대화 내역 · 글 · 영상 · 사진', does: '기억과 말투, 반응의 흐름을 재현하고 출처를 근거로 답합니다.' },
  { name: '전해 들은 이야기', items: '가족이 전하는 습관 · 성격', does: '호칭, 버릇, 가치관을 반영하되 “전언”으로 표시합니다.' },
  { name: '정밀 자료', items: '목소리 · 최근 사진', does: '자료가 들어오는 만큼 목소리와 모습을 더 가깝게 갱신합니다.' },
]

const DIFFS: { title: string; body: string; chip: Chip }[] = [
  { title: '모든 답에 출처 등급', body: '“기록”, “전언”, “추정” 중 무엇에 근거한 답인지 항상 보여 줍니다. 그럴듯하지만 근거 없는 말과 실제 기록을 구분할 수 있습니다.', chip: '구현됨' },
  { title: '모르면 모른다고 합니다', body: '자료에 없는 질문에는 꾸며 내지 않고 “기록에 없는 이야기”라고 답하도록 만들고, 이를 따로 시험합니다.', chip: '구현됨' },
  { title: '동의가 기본 설계', body: '누구의 동의로 만들어졌는지, 항상 AI라는 표시, 언제든 중지·삭제할 수 있는 창구를 처음부터 넣습니다.', chip: '준비 중' },
  { title: '얼마나 닮았는지 숫자로', body: '자료의 양과 질에 따라 얼마나 비슷한지를 측정해 알려 드립니다. “똑같다”고 말하지 않고, 잰 만큼만 말합니다.', chip: '설계 단계' },
]

// 사례를 많이 넣는다고 곧바로 "학습"시키지 않는다. 본인 확인·분류·평가를 거쳐
// 승인된 내용만 아바타의 판단 기준으로 반영하는 흐름이다.
const GROWTH_LOOP: { step: string; title: string; body: string; chip: Chip }[] = [
  { step: '01', title: '실제 사례를 남깁니다', body: '업무 선택, 갈등, 가치 판단처럼 “무엇을 왜 골랐는지”가 드러나는 본인 사례를 모읍니다. 단순 잡담·음성 인식 오류는 분리합니다.', chip: '구현됨' },
  { step: '02', title: '본인이 확인합니다', body: '사례에서 기준·우선순위·예외를 초안으로 뽑고, 본인이 고치거나 승인합니다. 승인 전에는 아바타의 장기 판단 기준이 되지 않습니다.', chip: '구현됨' },
  { step: '03', title: '근거 있는 답으로 연결합니다', body: '승인된 사례와 원문을 찾아 답변의 근거로 붙입니다. 관련 기록이 없거나 권한 밖이면 답하지 않고 본인에게 넘깁니다.', chip: '준비 중' },
  { step: '04', title: '처음 보는 사례로 시험합니다', body: '처음부터 따로 보관한 사례로 아바타의 선택을 본인의 재판단과 비교합니다. 시험 사례는 답을 만들 때 쓰지 않습니다.', chip: '준비 중' },
]

const COMPETITION_NOW = [
  { area: '현장 서비스·유통', ours: '시범 운영 준비 단계', soul: '장례시설·상조회사 제휴 및 키오스크 확장 공개', lead: 'SoulLink 우세' },
  { area: '외형·음성·대화', ours: '사진 기반 3D 아바타·TTS·립싱크·근거 검색형 대화 구현', soul: '사진·음성·대화 기록 기반 디지털 트윈과 채팅·통화·영상편지 제공', lead: '기능 범주 겹침' },
  { area: '답변의 근거', ours: '기록·전언·추정을 구분하고, 기록이 없으면 답하지 않는 구조', soul: '공개 자료에서 답변별 근거 표시·품질 측정 방식은 확인하지 못함', lead: '우리의 검증 방향' },
  { area: '본인과의 일치', ours: '판단 사례·보류 시험·블라인드 Sync 평가를 구현 중', soul: '공개된 정량 일치 평가 정보는 확인하지 못함', lead: '아직 실측 전' },
]

const AUDIENCES = [
  { who: '나를 남기고 싶은 분', body: '살아 계실 때 직접 자료를 남기고, 어디까지 쓰일지 스스로 정합니다. 본인 동의라 가장 분명한 방식입니다.', note: '본인 동의' },
  { who: '고인을 기억하는 가족', body: '고인의 기록으로 이야기를 이어 갑니다. 고인이 생전에 남긴 뜻을 우선하고, 같은 순위 유족 모두의 동의를 받는 절차를 기본으로 합니다.', note: '유족 전원 동의 절차' },
  { who: '조상을 알고 싶은 후손', body: '만나 보지 못한 조상의 기록에서 가족사와 말씨를 읽습니다. 기록에 없는 말은 만들지 않습니다.', note: '출처 인용형' },
  { who: '기관·교육 현장', body: '역사 인물을 사료에 근거해 체험하는 교육 콘텐츠. 인용한 사료를 함께 보여 주고, 지어낸 말은 표시합니다.', note: '사료 인용' },
]

const PROMISES = [
  { yes: true, text: '동의한 사람의 자료로만 만듭니다.' },
  { yes: true, text: '항상 “AI가 만든 대화”임을 표시합니다.' },
  { yes: true, text: '언제든 중지하고 삭제를 요청할 수 있습니다.' },
  { yes: false, text: '동의 없이 고인이나 타인을 복제하지 않습니다.' },
  { yes: false, text: '실존 인물을 사칭하는 얼굴·목소리를 만들지 않습니다.' },
  { yes: false, text: '애도 치료나 치유 효과를 약속하지 않습니다.' },
]

const STATUS: { group: string; chip: Chip; items: string[] }[] = [
  { group: '지금 동작하는 것', chip: '구현됨', items: ['사진 몇 장으로 얼굴 형태·색 복원 후 움직이는 3D 아바타에 입히기', '목소리 합성과 입 모양 맞추기', '출처가 붙은 지식 검색, 자료에 없으면 모른다고 답하기', '기록 속 잡음·오류 문장 걸러 내기', '대화 원본 백업·선별, 승인된 기억과 판단 사례 관리', '공개 자료로 만든 글 전용 유명인 아바타 체험(얼굴·목소리 없음, 근거 표시, 없으면 “기록에 없음”)'] },
  { group: '시범 운영 전에 마무리할 것', chip: '준비 중', items: ['본인의 판단 사례를 기준·우선순위·예외로 검토·승인하는 흐름', '보류 사례로 본인과 아바타의 선택을 비교하는 Sync 평가', '유족 동의 확인·철회 절차와 법률 전문가 검토(초상·음성·개인정보)', '동의한 소수와 함께하는 시범 운영'] },
  { group: '아직 하지 않은 것', chip: '설계 단계', items: ['이용 요금 책정 — 시범 운영 뒤에 정합니다', '동의한 참여자와 함께하는 정량 일치도 공개', '유명인 대상 서비스 — 초상·음성 이용 권한을 확보한 뒤에만(위 체험은 공개 자료만 쓰는 글 전용 연구 시험)'] },
]

const COMPETITORS = [
  {
    name: 'SoulLink',
    market: '국내 · AI 추모/장례',
    does: '사진·음성·대화 기록을 바탕으로 고인 디지털 트윈을 만들고, 채팅·통화·영상 편지·조문 키오스크를 제공합니다.',
    stage: '상용 운영·현장 확장',
    note: '가입자·활성 사용자 수는 공개하지 않았습니다. 장례지도사 유통망 및 상조회사 제휴를 발표했고, 키오스크는 현장 실증 단계로 알려졌습니다.',
    href: 'https://www.jlstandard.com/post/%EC%A0%9C%EC%9D%B4%EC%97%98%EC%8A%A4%ED%83%A0%EB%8B%A4%EB%93%9C-ai-%EA%B8%B0%EB%B0%98-%EC%B6%94%EB%AA%A8-%EC%84%9C%EB%B9%84%EC%8A%A4-%EC%86%8C%EC%9A%B8%EB%A7%81%ED%81%AC-%EC%B6%9C%EC%8B%9C%EB%A1%9C-%ED%98%81%EC%8B%A0%EC%A0%81%EC%9D%B8-%EC%B6%94%EB%AA%A8-%EB%AC%B8%ED%99%94-%EC%84%A0%EB%8F%84',
  },
  {
    name: 'StoryFile',
    market: '해외 · 인터뷰 기반 기록',
    does: '사전 촬영한 인터뷰를 구조화해, 질문에 맞는 실제 영상 답변을 보여 주는 기록·교육용 서비스입니다.',
    stage: '기관·박물관 중심 운영',
    note: '생성형 인격을 만들어 답하기보다, 실제로 기록한 답변을 찾아 보여 주는 방식에 가깝습니다.',
    href: 'https://www.storyfile.com/',
  },
  {
    name: 'HereAfter Legacy',
    market: '해외 · 개인 기억/성격 클론',
    does: '개인의 삶 이야기·목소리·성격을 바탕으로 가족과 대화하는 성격 클론을 표방합니다.',
    stage: '소비자 서비스 운영',
    note: '기억 보존과 대화라는 목적은 가깝지만, 판단 근거의 출처 표시와 검증 방법은 공개 자료에서 확인하지 못했습니다.',
    href: 'https://www.hereafterlegacy.ai/',
  },
  {
    name: 'Delphi',
    market: '해외 · 전문가 지식 아바타',
    does: '책·영상·팟캐스트 등 콘텐츠를 학습시켜 개인의 지식·관점·목소리를 대화형 Digital Mind로 제공합니다.',
    stage: '크리에이터·전문가용 운영',
    note: '전문 지식의 재사용·멘토링에 강점이 있으며, 가족 기억이나 사후 추모보다 생전 활동에 초점이 있습니다.',
    href: 'https://help.delphi.ai/articles/16045443-find-delphi',
  },
  {
    name: 'HeyGen · AI Studios',
    market: '글로벌 · 영상/외형 아바타',
    does: '본인 또는 맞춤형 아바타가 대본을 말하는 영상과 디지털 트윈 제작 도구를 제공합니다.',
    stage: '성숙한 제작 도구 시장',
    note: '외형·음성·영상 제작에는 강하지만, 개인의 기억과 판단 기준을 심층적으로 축적·검증하는 서비스와는 결이 다릅니다.',
    href: 'https://www.heygen.com/avatars',
  },
]

const FAQ = [
  { q: '고인과 대화하면 위로가 되나요?', a: '사람마다 다르고, 효과가 검증된 서비스라고 말씀드릴 수 없습니다. 의존이나 애도가 길어질 가능성을 지적하는 연구도 있어, 사용 시간 안내와 전문 상담 연계를 설계에 넣고 있습니다. 이 서비스는 치료가 아니라 기록을 이어 가는 도구입니다.' },
  { q: '가족 중 한 명이 반대하면요?', a: '만들지 않습니다. 같은 순위 유족 중 한 명이라도 반대하거나 누가 동의 권한을 가지는지 분명하지 않으면 생성을 보류하는 것을 원칙으로 합니다.' },
  { q: '올린 자료와 학습은 어떻게 되나요?', a: '삭제가 어려운 모델 학습 대신, 출처 기록을 검색해서 답하는 방식을 우선합니다. 삭제를 요청하면 자료와 그에 연결된 내용을 지우는 것이 목표입니다.' },
  { q: '얼마나 실제와 비슷한가요?', a: '자료가 많고 정확할수록 가까워지지만, 똑같다고 약속하지 않습니다. 비슷한 정도는 측정해서 근거와 함께 알려 드리는 것이 목표입니다.' },
  { q: '비용은 얼마인가요?', a: '시범 운영 뒤 정합니다. 개인 보관, 기관 이용, 제휴 같은 방식을 검토 중이며 확정된 가격은 아직 없습니다.' },
]

function GlowAvatar() {
  return (
    <svg viewBox="0 0 120 120" className="h-24 w-24 shrink-0" aria-hidden="true">
      <defs>
        <radialGradient id="promo-glow" cx="50%" cy="38%" r="60%"><stop offset="0%" stopColor="#fde6b0" /><stop offset="100%" stopColor="#f59e0b" stopOpacity="0.15" /></radialGradient>
      </defs>
      <circle cx="60" cy="60" r="56" fill="url(#promo-glow)" />
      <circle cx="60" cy="46" r="17" fill="#fff7e0" opacity="0.92" />
      <path d="M26 100c3-20 17-30 34-30s31 10 34 30" fill="#fff7e0" opacity="0.92" />
    </svg>
  )
}

export default function PromoSite() {
  const root = useRef<HTMLDivElement>(null)
  const go = (id: string) => root.current?.querySelector('#' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const applyHref = CONTACT_EMAIL ? 'mailto:' + CONTACT_EMAIL + '?subject=' + encodeURIComponent(BRAND + ' 시범 참여 문의') : undefined
  const apply = (cls: string, label: string) => applyHref
    ? <a href={applyHref} className={cls}>{label}</a>
    : <button type="button" onClick={() => go('contact')} className={cls}>{label}</button>

  return <div ref={root} className="h-full overflow-y-auto break-keep bg-[#fbf8f3] text-slate-800">
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0f1226]/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <span className="text-sm font-semibold tracking-wide text-amber-100">{BRAND}</span>
        <nav aria-label="페이지 이동" className="hidden items-center gap-5 text-sm text-slate-300 md:flex">
          {[['demo', '체험'], ['how', '작동 방식'], ['growth', '닮아지는 과정'], ['diff', '다른 점'], ['competition', '경쟁 업체'], ['who', '누구를 위해'], ['promise', '약속'], ['status', '현재 상태'], ['faq', '질문']].map(([id, label]) =>
            <button key={id} type="button" onClick={() => go(id)} className="hover:text-white">{label}</button>)}
        </nav>
        {apply('rounded-full bg-amber-300 px-4 py-1.5 text-sm font-semibold text-slate-900 hover:bg-amber-200', '시범 참여 신청')}
      </div>
    </header>

    <section className="relative overflow-hidden bg-gradient-to-b from-[#0f1226] via-[#1b1a40] to-[#2b2250] text-white">
      <div className="pointer-events-none absolute -right-24 top-10 h-80 w-80 rounded-full bg-amber-300/10 blur-3xl" aria-hidden="true" />
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 sm:px-6 md:grid-cols-[1.1fr_0.9fr] md:py-24">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-amber-200/30 bg-amber-200/10 px-3 py-1 text-xs text-amber-100"><span className="h-1.5 w-1.5 rounded-full bg-amber-300" aria-hidden="true" />시범 운영 준비 중 · 참여자를 모십니다</span>
          <h1 className="mt-5 text-3xl font-semibold leading-snug tracking-tight sm:text-[2.6rem]">기억해야 할 사람들을<br />그때 그대로의 모습과 목소리,<br /><span className="text-amber-200">그 사람의 기억으로</span> 만들어 드립니다</h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-slate-200">올려 주신 사진·목소리·대화·글이 담고 있는 만큼 그 사람의 모습과 말투, 기억을 담은 아바타가 대답합니다. 근거가 없는 말은 지어내지 않고, 누구의 동의로 만들어졌는지 숨기지 않습니다.</p>
          <div className="mt-8 flex flex-wrap gap-3">
            {apply('rounded-full bg-amber-300 px-6 py-3 text-sm font-semibold text-slate-900 shadow-lg shadow-amber-500/20 hover:bg-amber-200', '시범 참여 신청하기')}
            <button type="button" onClick={() => go('demo')} className="rounded-full border border-white/25 px-6 py-3 text-sm text-white hover:bg-white/10">유명인 아바타와 이야기해 보기</button>
          </div>
        </div>

        <figure aria-label="대화 예시" className="rounded-2xl border border-white/10 bg-white/[0.06] p-5 shadow-2xl backdrop-blur">
          <div className="flex items-center gap-4"><GlowAvatar /><div><p className="text-sm font-semibold text-amber-100">예시: 김장을 하시던 할머니</p><p className="text-xs text-slate-300">가상의 인물 · 예시 화면입니다</p></div></div>
          <div className="mt-4 space-y-3 text-sm">
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-white/15 px-4 py-2">김장할 때 제일 중요한 게 뭐였어요?</p>
            <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-amber-100 px-4 py-3 text-slate-800">
              <p>간을 먼저 보고, 배추 절이는 시간은 서두르지 않는 거였단다.</p>
              <p className="mt-2 flex flex-wrap gap-1.5 text-[11px]"><span className="rounded bg-emerald-200 px-1.5 py-0.5 text-emerald-900">기록 · 2019년 통화 메모</span><span className="rounded bg-sky-200 px-1.5 py-0.5 text-sky-900">전언 · 어머니가 전함</span></p>
            </div>
            <p className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-white/15 px-4 py-2">젊었을 때 꿈은 뭐였어요?</p>
            <div className="max-w-[92%] rounded-2xl rounded-bl-sm bg-amber-100 px-4 py-3 text-slate-800">
              <p>그 이야기는 올려 주신 자료에 없습니다. 추측해서 말씀드리지 않을게요.</p>
              <p className="mt-2 text-[11px]"><span className="rounded bg-slate-300 px-1.5 py-0.5 text-slate-800">기록에 없음</span></p>
            </div>
          </div>
        </figure>
      </div>
    </section>

    <Suspense fallback={<div id="demo" className="bg-[#f3eee4] py-16 text-center text-sm text-slate-500">체험 화면을 불러오는 중…</div>}><PromoPersonaDemo /></Suspense>

    <section id="how" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">작동 방식</p>
      <h2 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">자료가 늘수록 더 정교해집니다</h2>
      <ol className="mt-8 grid gap-4 md:grid-cols-3">
        {STEPS.map(step => <li key={step.n} className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm"><span className="text-sm font-semibold text-amber-600">{step.n}</span><h3 className="mt-2 text-lg font-semibold">{step.title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{step.body}</p></li>)}
      </ol>
      <div className="mt-8 overflow-x-auto rounded-2xl border border-stone-200 bg-white">
        <table className="w-full min-w-[640px] text-left text-sm">
          <caption className="sr-only">올리는 자료의 종류와 아바타가 하는 일</caption>
          <thead className="bg-stone-50 text-xs text-slate-500"><tr><th scope="col" className="px-5 py-3">자료 단계</th><th scope="col" className="px-5 py-3">올리는 것</th><th scope="col" className="px-5 py-3">아바타가 하는 일</th></tr></thead>
          <tbody>{TIERS.map(tier => <tr key={tier.name} className="border-t border-stone-100 align-top"><th scope="row" className="px-5 py-3 font-semibold text-slate-900">{tier.name}</th><td className="px-5 py-3 text-slate-600">{tier.items}</td><td className="px-5 py-3 text-slate-700">{tier.does}</td></tr>)}</tbody>
        </table>
      </div>
    </section>

    <section id="growth" className="bg-[#f3eee4] py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">사례가 쌓일수록</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">많이 말해서가 아니라, 내 판단을 확인해 갈수록 닮아집니다</h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">아바타는 새 사례를 무조건 자동 학습하지 않습니다. 본인이 확인한 기준과 예외만 반영하고, 처음 보는 사례에서 본인과 같은 선택을 하는지 계속 측정합니다. 그래서 기억이 늘어나는 과정과 “본인다움”의 근거를 분리해 볼 수 있습니다.</p>
        <ol className="mt-8 grid gap-4 md:grid-cols-4">
          {GROWTH_LOOP.map(item => <li key={item.step} className="relative rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <span className="text-sm font-semibold text-amber-700">{item.step}</span>
            <span className={'float-right rounded-full px-2.5 py-0.5 text-xs font-medium ' + CHIP_CLS[item.chip]}>{item.chip}</span>
            <h3 className="mt-4 text-lg font-semibold text-slate-900">{item.title}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">{item.body}</p>
          </li>)}
        </ol>
        <div className="mt-6 rounded-2xl border border-indigo-100 bg-indigo-50 p-5 text-sm leading-6 text-indigo-950">
          <strong>측정의 원칙:</strong> 학습에 쓰지 않은 사례를 따로 보관하고, 아바타의 선택을 본인이 다시 판단한 결과와 비교합니다. 결과가 낮으면 “닮았다”고 말하지 않고, 어떤 기준이 부족했는지부터 보완합니다.
        </div>
      </div>
    </section>

    <section id="diff" className="bg-white py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">다른 점</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">그럴듯함보다, 믿을 수 있음</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {DIFFS.map(item => <article key={item.title} className="rounded-2xl border border-stone-200 bg-[#fbf8f3] p-6">
            <div className="flex items-start justify-between gap-3"><h3 className="text-lg font-semibold">{item.title}</h3><span className={'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ' + CHIP_CLS[item.chip]}>{item.chip}</span></div>
            <p className="mt-2 text-sm leading-6 text-slate-600">{item.body}</p>
          </article>)}
        </div>
      </div>
    </section>

    <section id="competition" className="bg-[#f3eee4] py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">경쟁 업체</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">비슷한 서비스와, 우리가 집중할 지점</h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">AI 아바타 시장에는 추모, 인터뷰 기록, 전문가 지식, 영상 제작처럼 서로 다른 출발점이 있습니다. 아래는 각 서비스의 공개 자료를 바탕으로 정리한 비교이며, 가입자 수처럼 공개되지 않은 수치는 추정하지 않았습니다.</p>
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          {COMPETITORS.map(item => <article key={item.name} className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="text-lg font-semibold text-slate-900">{item.name}</h3><p className="mt-1 text-xs font-medium text-amber-700">{item.market}</p></div>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">{item.stage}</span>
            </div>
            <p className="mt-4 text-sm leading-6 text-slate-700">{item.does}</p>
            <p className="mt-3 rounded-lg bg-stone-50 p-3 text-xs leading-5 text-slate-600">{item.note}</p>
            <a href={item.href} target="_blank" rel="noreferrer" className="mt-4 inline-block text-sm font-medium text-indigo-700 underline underline-offset-2">공개 자료 보기</a>
          </article>)}
        </div>
        <div className="mt-6 grid gap-4 rounded-2xl bg-[#14152e] p-6 text-white md:grid-cols-[0.9fr_1.1fr]">
          <div><p className="text-xs font-semibold tracking-widest text-amber-200">그대로의 위치</p><h3 className="mt-2 text-xl font-semibold">생전부터, 판단의 이유까지 남기는 아바타</h3></div>
          <ul className="space-y-2 text-sm leading-6 text-slate-200"><li>• 심층 인터뷰로 경험·가치관·판단 기준과 그 예외를 함께 기록합니다.</li><li>• 답변마다 기록·전언·추정을 구분해 근거 없는 말을 줄입니다.</li><li>• 실제 본인과 아바타를 구별하는 블라인드 Sync 평가를 설계해 “닮음”을 검증합니다.</li></ul>
        </div>
        <div className="mt-8 overflow-x-auto rounded-2xl border border-stone-200 bg-white">
          <table className="w-full min-w-[720px] text-left text-sm">
            <caption className="sr-only">그대로와 SoulLink의 현재 공개 정보 비교</caption>
            <thead className="bg-stone-50 text-xs text-slate-500"><tr><th scope="col" className="px-5 py-3">비교 항목</th><th scope="col" className="px-5 py-3">그대로 현재</th><th scope="col" className="px-5 py-3">SoulLink 공개 정보</th><th scope="col" className="px-5 py-3">판단</th></tr></thead>
            <tbody>{COMPETITION_NOW.map(item => <tr key={item.area} className="border-t border-stone-100 align-top"><th scope="row" className="px-5 py-4 font-semibold text-slate-900">{item.area}</th><td className="px-5 py-4 leading-6 text-slate-700">{item.ours}</td><td className="px-5 py-4 leading-6 text-slate-600">{item.soul}</td><td className="px-5 py-4"><span className="whitespace-nowrap rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900">{item.lead}</span></td></tr>)}</tbody>
          </table>
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">자료 기준: 2026-10-11. SoulLink의 기능·유통망 정보는 회사 발표 및 제휴사 공개자료 기준이며, 제휴 회원 수는 실제 이용자 수가 아닙니다. 답변 품질·일치도는 양쪽 모두 공개 수치만으로 비교할 수 없습니다.</p>
      </div>
    </section>

    <section id="who" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">누구를 위해</p>
      <h2 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">누가 만드는지에 따라 절차가 달라집니다</h2>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {AUDIENCES.map(item => <article key={item.who} className="flex flex-col rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <h3 className="font-semibold text-slate-900">{item.who}</h3>
          <p className="mt-2 flex-1 text-sm leading-6 text-slate-600">{item.body}</p>
          <span className="mt-4 w-fit rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-800">{item.note}</span>
        </article>)}
      </div>
    </section>

    <section id="promise" className="bg-[#14152e] py-16 text-white">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-200">약속</p>
        <h2 className="mt-2 text-2xl font-semibold sm:text-3xl">하는 일만큼, 하지 않는 일을 분명히 합니다</h2>
        <ul className="mt-8 grid gap-3 sm:grid-cols-2">
          {PROMISES.map(item => <li key={item.text} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.05] p-4 text-sm">
            <span className={'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ' + (item.yes ? 'bg-emerald-300 text-emerald-950' : 'bg-rose-300 text-rose-950')} aria-label={item.yes ? '합니다' : '하지 않습니다'}>{item.yes ? '✓' : '✕'}</span>
            <span className="text-slate-100">{item.text}</span>
          </li>)}
        </ul>
      </div>
    </section>

    <section id="status" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">현재 상태</p>
      <h2 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">어디까지 왔는지 그대로 말씀드립니다</h2>
      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {STATUS.map(group => <article key={group.group} className="rounded-2xl border border-stone-200 bg-white p-5">
          <span className={'rounded-full px-2.5 py-0.5 text-xs font-medium ' + CHIP_CLS[group.chip]}>{group.chip}</span>
          <h3 className="mt-3 font-semibold text-slate-900">{group.group}</h3>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600">{group.items.map(text => <li key={text}>{text}</li>)}</ul>
        </article>)}
      </div>
    </section>

    <section id="faq" className="bg-white py-16">
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-widest text-amber-700">자주 묻는 질문</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900 sm:text-3xl">조심스러운 질문일수록 솔직하게</h2>
        <div className="mt-6 divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-[#fbf8f3]">
          {FAQ.map(item => <details key={item.q} className="group p-5"><summary className="cursor-pointer list-none font-medium text-slate-900 marker:hidden"><span className="mr-2 text-amber-600 group-open:hidden">+</span><span className="mr-2 hidden text-amber-600 group-open:inline">−</span>{item.q}</summary><p className="mt-3 text-sm leading-6 text-slate-600">{item.a}</p></details>)}
        </div>
      </div>
    </section>

    <section id="contact" className="bg-gradient-to-b from-[#2b2250] to-[#0f1226] py-16 text-center text-white">
      <div className="mx-auto max-w-2xl px-4 sm:px-6">
        <h2 className="text-2xl font-semibold sm:text-3xl">시범 운영에 함께해 주세요</h2>
        <p className="mt-3 text-sm leading-6 text-slate-200">처음에는 본인이 직접 자료를 남기시는 분, 가족과 함께 기록을 이어 가고 싶은 분, 기관·교육 현장에서 써 보고 싶은 분과 천천히 시작합니다. 의견을 주시면 동의 절차와 화면을 함께 다듬겠습니다.</p>
        <div className="mt-6">{apply('inline-block rounded-full bg-amber-300 px-7 py-3 text-sm font-semibold text-slate-900 hover:bg-amber-200', CONTACT_EMAIL ? '메일로 신청하기' : '참여 안내 받기')}</div>
        {!CONTACT_EMAIL && <p className="mx-auto mt-4 max-w-md rounded-lg border border-amber-200/40 bg-amber-200/10 p-3 text-xs text-amber-100">공개 전 확인: 문의 받을 메일 주소가 아직 비어 있습니다. PromoSite.tsx의 CONTACT_EMAIL에 넣으면 이 버튼이 메일 신청으로 연결됩니다.</p>}
      </div>
    </section>

    <footer className="bg-[#0f1226] px-4 py-8 text-center text-xs leading-6 text-slate-400">
      <p>{BRAND}는 시범 운영 준비 단계이며, 위 내용은 현재의 계획과 구현 상태를 정리한 것입니다. 법률 검토와 동의 절차가 마무리되기 전에는 타인을 대상으로 한 서비스를 제공하지 않습니다.</p>
      <p>이 서비스는 의료·상담·치료 서비스가 아니며, 생성된 대화는 AI가 만든 것으로 실제 인물의 발언이 아닙니다.</p>
    </footer>
  </div>
}
