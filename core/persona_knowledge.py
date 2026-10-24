"""공개 인물 페르소나의 답변용 지식 저장소.

코퍼스 파일은 수집·검수용 원본이고, 이 모듈의 ``persona_knowledge`` 테이블은
대화 시 인물별로 빠르게 불러오는 읽기 모델이다. 원문 근거와 추정은 함께 보관하되
각 근거 단계는 그대로 유지해 답변에서 사실과 추정을 섞어 말하지 않게 한다.
"""
import json
import time

from db.init_db import get_conn


def _init(conn) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS persona_knowledge (
            person TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            material_count INTEGER NOT NULL,
            verified_count INTEGER NOT NULL,
            estimated_count INTEGER NOT NULL,
            profile_json TEXT NOT NULL,
            context TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    conn.commit()


def sync(person: str, profile: dict | None = None) -> dict:
    """질문은행의 현재 답변을 대화용 지식 레코드 하나로 동기화한다."""
    from . import persona_eval, persona_qbank

    if person not in persona_qbank.NAMES:
        raise ValueError("알 수 없는 인물")
    rows = persona_qbank.load(person)
    materials = persona_qbank.materials(person)
    profile = profile or persona_qbank.profile(person)
    facts, estimates = [], []
    def priority(evidence: dict) -> int:
        # 대화 중 받은 피드백·리뷰(reviewed)가 가장 앞, 그다음 수집 원문에서 확인된 근거, 마지막이 추정
        return 0 if evidence.get("tier") == "reviewed" else 1 if evidence.get("tier") in persona_qbank.REAL_TIERS else 2

    for row in rows:
        ranked = sorted(row.get("evidence", []), key=priority)
        for evidence in ranked[:1]:   # 질문 하나당 대표 근거 하나만 대화 컨텍스트에 보관
            item = {
                "qid": row["qid"], "domain": row["domain"], "question": row["question"],
                "question_spec": row.get("question_spec", {}),
                "text": evidence.get("text", "")[:700], "tier": evidence.get("tier", "estimate"),
                "title": evidence.get("title", ""), "source": evidence.get("source_url"),
            }
            (facts if priority(evidence) < 2 else estimates).append(item)
    context = json.dumps({"person": person, "facts": facts, "estimates": estimates,
                          "profile": profile, "materials": [{"id": m["id"], "title": m["title"], "kind": m["kind"]} for m in materials]},
                         ensure_ascii=False)
    name = persona_eval.PEOPLE.get(person, persona_qbank.NAMES[person])
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    conn = get_conn()
    try:
        _init(conn)
        conn.execute("""INSERT INTO persona_knowledge
            (person,name,material_count,verified_count,estimated_count,profile_json,context,updated_at)
            VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(person) DO UPDATE SET name=excluded.name, material_count=excluded.material_count,
            verified_count=excluded.verified_count, estimated_count=excluded.estimated_count,
            profile_json=excluded.profile_json, context=excluded.context, updated_at=excluded.updated_at""",
            (person, name, len(materials), len(facts), len(estimates), json.dumps(profile, ensure_ascii=False), context, now))
        conn.commit()
    finally:
        conn.close()
    return {"person": person, "materials": len(materials), "verified": len(facts), "estimated": len(estimates), "updated_at": now}


def context(person: str, max_chars: int = 6000) -> dict:
    """대화 프롬프트에 넣을 인물별 지식. 없으면 즉시 현재 파일에서 만든다."""
    conn = get_conn()
    try:
        _init(conn)
        row = conn.execute("SELECT context, profile_json FROM persona_knowledge WHERE person=?", (person,)).fetchone()
    finally:
        conn.close()
    if not row:
        sync(person)
        return context(person, max_chars)
    data = json.loads(row["context"])
    return {"profile": json.loads(row["profile_json"]), "facts": data.get("facts", []),
            "estimates": data.get("estimates", []), "text": row["context"][:max_chars]}


def status() -> list[dict]:
    conn = get_conn()
    try:
        _init(conn)
        return [dict(row) for row in conn.execute("SELECT person,name,material_count,verified_count,estimated_count,updated_at FROM persona_knowledge ORDER BY person")]
    finally:
        conn.close()
