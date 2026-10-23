"""공개 인물 질문 자료가 충분한지 판단한다(논문 12절의 평가 대상 선정 기준).

"78문항 중 몇 개 채웠나"만 보면 두 가지를 놓친다.
  1) 자료 구조상 처음부터 답할 수 없는 영역(예: 관찬 기록뿐인 인물의 "가장 부끄러운 일")까지 부족으로 세게 된다.
  2) 개수는 충분해도 인용문 모음이나 책 한 권에만 기대고 있는 인물이 충분해 보인다.
그래서 (a) 인물별로 답할 수 있는 영역(적용 범위)을 선언하고, (b) 개수·영역 폭·출처 편중을 따로 보고한다.
적용 범위는 연구자가 정하는 입력이며 기본값은 전체 영역이다. 못 채운 영역을 "해당 없음"으로 돌려 충족률을 부풀리지 않도록,
범위를 줄이려면 자료 구조상의 이유를 적어야 한다.
"""
from . import persona_qbank

# 임계값은 연구 설계상 제안값이다(2026-10-23). 근거: 프로필 12축을 세우려면 확인된 답이 78문항의 약 40% 이상이어야
# 축마다 최소 한두 개의 근거가 걸린다고 보았고, 블라인드 평가는 인물당 20문항 이상이 있어야 비교할 수 있다고 보았다.
BLIND_MIN_CONFIRMED = 20
PROFILE_MIN_COVERAGE = 0.38     # 적용 범위 안 문항 중 확인된 답의 비율
PROFILE_MIN_DOMAINS = 0.60      # 적용 범위 안 영역 중 확인된 답이 하나라도 있는 영역의 비율
QUOTE_RELIANCE = 0.60           # 대표 근거가 인용문 모음(quotes)인 답의 비율이 이를 넘으면 "인용문 의존"
SINGLE_SOURCE = 0.50            # 대표 근거가 한 문서(또는 같은 연도 묶음이 아닌 단일 문서)에 몰린 비율이 이를 넘으면 "단일 자료 의존"

# 적용 범위를 줄인 인물과 그 이유. 목록에 없으면 전체 영역이 적용된다.
PERSON_SCOPE = {
    "sejong": {
        "domains": ["가치관·신념·윤리", "일과 결정", "전문지식·사고법", "표현·문체", "인생 이력"],
        "reason": "자료가 훈민정음 서문(본인 저술)과 세종실록의 공적 결정 기록뿐이다. 감정·관계·약점·취향처럼 사적 서술이 필요한 영역은 자료 구조상 답할 수 없다.",
    },
}


def _in_scope_domains(person: str) -> list:
    all_domains = []
    for _, domain, *_ in persona_qbank.QUESTIONS:
        if domain not in all_domains:
            all_domains.append(domain)
    scope = PERSON_SCOPE.get(person)
    return [d for d in all_domains if scope is None or d in scope["domains"]]


def adequacy(person: str) -> dict:
    if person not in persona_qbank.NAMES:
        raise ValueError("알 수 없는 인물")
    domains = _in_scope_domains(person)
    applicable = [q for q in persona_qbank.QUESTIONS if q[1] in domains]
    rows = {r["qid"]: r for r in persona_qbank.load(person)}
    confirmed, rep_kinds, rep_docs, multi = [], [], [], 0
    for qid, domain, *_ in applicable:
        row = rows.get(qid)
        evidence = [e for e in (row or {}).get("evidence", []) if persona_qbank._is_checked(e)]
        if not evidence:
            continue
        confirmed.append((qid, domain))
        rep_kinds.append(evidence[0].get("kind"))
        rep_docs.append(evidence[0].get("doc"))
        if len({e.get("doc") for e in evidence}) >= 2:
            multi += 1
    n = len(confirmed)
    covered = {d for _, d in confirmed}
    top_doc_share = max((rep_docs.count(d) for d in set(rep_docs)), default=0) / n if n else 0
    quote_share = rep_kinds.count("quotes") / n if n else 0
    coverage = n / len(applicable) if applicable else 0
    domain_ratio = len(covered) / len(domains) if domains else 0
    blind_ready = n >= BLIND_MIN_CONFIRMED
    profile_ready = coverage >= PROFILE_MIN_COVERAGE and domain_ratio >= PROFILE_MIN_DOMAINS
    flags = []
    if quote_share > QUOTE_RELIANCE:
        flags.append({"id": "quotes_reliance", "label": "인용문 의존", "detail": "확인된 답의 %d%%가 인용문 모음이 대표 근거다. 인용문은 출처가 불확실한 것이 섞여 있어 원문 대조가 필요하다." % round(quote_share * 100)})
    if top_doc_share > SINGLE_SOURCE:
        flags.append({"id": "single_source", "label": "단일 자료 의존", "detail": "확인된 답의 %d%%가 한 문서에서 나왔다. 다른 자료로 교차 확인이 안 된다." % round(top_doc_share * 100)})
    if not blind_ready:
        verdict, label = "insufficient", "부족"
    elif profile_ready and not flags:
        verdict, label = "sufficient", "충분"
    else:
        verdict, label = "conditional", "조건부"
    return {
        "person": person, "verdict": verdict, "label": label,
        "confirmed": n, "applicable": len(applicable), "total_questions": len(persona_qbank.QUESTIONS),
        "coverage": round(coverage, 3), "domains_covered": len(covered), "domains_in_scope": len(domains),
        "quote_share": round(quote_share, 3), "top_doc_share": round(top_doc_share, 3),
        "multi_doc_share": round(multi / n, 3) if n else 0,
        "blind_ready": blind_ready, "profile_ready": profile_ready, "flags": flags,
        "scope": PERSON_SCOPE.get(person) or {"domains": None, "reason": "기본값: 전체 영역. 못 채운 영역은 자료 보강 대상이다."},
        "uncovered_domains": [d for d in domains if d not in covered],
        "thresholds": {"blind_min_confirmed": BLIND_MIN_CONFIRMED, "profile_min_coverage": PROFILE_MIN_COVERAGE,
                       "profile_min_domains": PROFILE_MIN_DOMAINS, "quote_reliance": QUOTE_RELIANCE, "single_source": SINGLE_SOURCE,
                       "note": "임계값은 연구 설계상 제안값이며 근거 자료가 아니라 판단이다."},
    }


def adequacy_all() -> dict:
    people = [adequacy(p) for p in persona_qbank.NAMES]
    # 어떤 인물도 자료로 답하지 못한 질문 = 공개 자료에서는 원래 나오지 않는 질문일 가능성이 큰 후보(질문 틀 조정 검토 대상)
    answered = set()
    for p in persona_qbank.NAMES:
        for row in persona_qbank.load(p):
            if any(persona_qbank._is_checked(e) for e in row.get("evidence", [])):
                answered.add(row["qid"])
    unanswered = [{"qid": qid, "domain": domain, "question": ko}
                  for qid, domain, ko, *_ in persona_qbank.QUESTIONS if qid not in answered]
    return {"people": people, "never_answered": unanswered,
            "note": "never_answered는 11명 누구도 수집 자료로 답하지 못한 질문이다. 삭제 후보가 아니라, 공개 자료로는 답이 나오기 어렵다는 신호로 읽는다."}
