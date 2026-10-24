"""원문으로 실제 답할 수 있는 인물별 질문의 자료 충분성을 판단한다.

공통 78문항은 탐색 틀일 뿐 완성률의 분모가 아니다. 원문 근거가 확인된 질문만
활성 질문이며, 공통 비교 질문과 인물 고유 질문을 함께 사용한다.
"""
from . import persona_qbank

# 임계값은 연구 설계상 제안값이다(2026-10-23). 근거: 프로필 12축을 세우려면 확인된 답이 78문항의 약 40% 이상이어야
# 축마다 최소 한두 개의 근거가 걸린다고 보았고, 블라인드 평가는 인물당 20문항 이상이 있어야 비교할 수 있다고 보았다.
BLIND_MIN_CONFIRMED = 20
PROFILE_MIN_CONFIRMED = 12      # 선택된 원문 근거 질문 수
PROFILE_MIN_DOMAINS = 4         # 근거가 분산된 영역 수
QUOTE_RELIANCE = 0.60           # 대표 근거가 인용문 모음(quotes)인 답의 비율이 이를 넘으면 "인용문 의존"
SINGLE_SOURCE = 0.50            # 대표 근거가 한 문서(또는 같은 연도 묶음이 아닌 단일 문서)에 몰린 비율이 이를 넘으면 "단일 자료 의존"

def adequacy(person: str) -> dict:
    if person not in persona_qbank.NAMES:
        raise ValueError("알 수 없는 인물")
    focus = persona_qbank.question_focus(person)
    applicable_ids = {item["qid"] for item in focus["common"] + focus["specific"]}
    rows = {r["qid"]: r for r in persona_qbank.load(person)}
    confirmed, rep_kinds, rep_docs, multi = [], [], [], 0
    for qid, domain, *_ in persona_qbank.QUESTIONS:
        if qid not in applicable_ids:
            continue
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
    coverage = 1.0 if n else 0.0  # 활성 집합은 원문으로 확인된 질문만으로 구성된다.
    blind_ready = n >= BLIND_MIN_CONFIRMED
    profile_ready = n >= PROFILE_MIN_CONFIRMED and len(covered) >= PROFILE_MIN_DOMAINS
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
        "confirmed": n, "applicable": len(applicable_ids), "total_questions": len(persona_qbank.QUESTIONS),
        "coverage": coverage, "domains_covered": len(covered), "domains_in_scope": len(covered),
        "quote_share": round(quote_share, 3), "top_doc_share": round(top_doc_share, 3),
        "multi_doc_share": round(multi / n, 3) if n else 0,
        "blind_ready": blind_ready, "profile_ready": profile_ready, "flags": flags,
        "scope": {"domains": None, "reason": focus["rule"]},
        "uncovered_domains": [],
        "thresholds": {"blind_min_confirmed": BLIND_MIN_CONFIRMED, "profile_min_coverage": PROFILE_MIN_CONFIRMED,
                       "profile_min_domains": PROFILE_MIN_DOMAINS, "quote_reliance": QUOTE_RELIANCE, "single_source": SINGLE_SOURCE,
                       "note": "78개 공통 질문을 분모로 쓰지 않는다. 원문 근거가 확인된 활성 질문 수와 영역·출처 편중으로 판단하는 제안 임계값이다."},
    }


def adequacy_all() -> dict:
    people = [adequacy(p) for p in persona_qbank.NAMES]
    # 어떤 인물도 자료로 답하지 못한 질문은 활성 질문에서 제외된 탐색 틀이다.
    answered = set()
    for p in persona_qbank.NAMES:
        for row in persona_qbank.load(p):
            if any(persona_qbank._is_checked(e) for e in row.get("evidence", [])):
                answered.add(row["qid"])
    unanswered = [{"qid": qid, "domain": domain, "question": ko}
                  for qid, domain, ko, *_ in persona_qbank.QUESTIONS if qid not in answered]
    return {"people": people, "never_answered": unanswered,
            "note": "never_answered는 활성 질문에 넣지 않는다. 새 원문 근거가 생긴 뒤 재판정에서만 포함될 수 있다."}
