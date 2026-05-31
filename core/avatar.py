"""아바타 프로파일 관리 + 채팅 컨텍스트 빌더"""
import json
from db.init_db import get_conn
from . import graph, embeddings, pattern


# ── 프로파일 ───────────────────────────────────────────

PROFILE_KEYS = [
    "name", "role", "company", "main_projects",
    "expertise", "work_style", "goals", "values", "other"
]

PROFILE_LABELS = {
    "name":          "이름",
    "role":          "역할/직책",
    "company":       "회사/조직",
    "main_projects": "주요 프로젝트",
    "expertise":     "전문 분야",
    "work_style":    "업무 방식",
    "goals":         "현재 목표",
    "values":        "중요하게 여기는 것",
    "other":         "기타",
}


def get_profile() -> dict:
    conn = get_conn()
    rows = conn.execute("SELECT key, value, updated_at FROM user_profile").fetchall()
    conn.close()
    profile = {r["key"]: {"value": r["value"], "updated_at": r["updated_at"]} for r in rows}
    return profile


def update_profile(updates: dict) -> dict:
    conn = get_conn()
    for key, value in updates.items():
        if key not in PROFILE_KEYS:
            continue
        conn.execute(
            "INSERT INTO user_profile (key, value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now','localtime')",
            (key, str(value))
        )
    conn.commit()
    conn.close()
    return get_profile()


# ── Daily Sync ────────────────────────────────────────

def sync_item(source: str, source_id: str, title: str, content: str) -> bool:
    """my-dashboard 항목(노트, 할일 등)을 KG에 반영"""
    conn = get_conn()
    existing = conn.execute(
        "SELECT id FROM daily_sync WHERE source=? AND source_id=?",
        (source, source_id)
    ).fetchone()

    if existing:
        conn.execute(
            "UPDATE daily_sync SET title=?, content=?, synced_at=datetime('now','localtime') WHERE source=? AND source_id=?",
            (title, content, source, source_id)
        )
        conn.commit()
        conn.close()
        return False  # 업데이트

    import uuid, hashlib
    sid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO daily_sync (id, source, source_id, title, content) VALUES (?,?,?,?,?)",
        (sid, source, source_id, title, content)
    )
    conn.commit()
    conn.close()

    # KG에도 ingest
    from . import embeddings as emb
    fhash = hashlib.md5(content.encode()).hexdigest()[:12]
    node_id = graph.add_node(
        type="chunk", title=title, content=content,
        source_type=source, file_path=f"sync://{source}/{source_id}",
        file_hash=fhash, chunk_index=0
    )
    emb.add_document(node_id, title, content, {"source_type": source, "sync_id": source_id})
    return True  # 신규


def list_synced(source: str = "", limit: int = 50) -> list:
    conn = get_conn()
    if source:
        rows = conn.execute(
            "SELECT * FROM daily_sync WHERE source=? ORDER BY synced_at DESC LIMIT ?",
            (source, limit)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM daily_sync ORDER BY synced_at DESC LIMIT ?", (limit,)
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── 아바타 채팅 컨텍스트 빌더 ──────────────────────────

AVATAR_SYSTEM = """당신은 {name}의 디지털 아바타입니다.
{name}을 완전히 대신하여 1인칭으로 답하세요.

## 나는 누구인가
{profile_section}

## 내가 최근에 집중하는 것 (지식 그래프 기반)
{interests_section}

## 내가 최근 작업한 내용
{recent_section}

규칙:
- 항상 1인칭("나는", "내가", "제 생각에는")으로 답하세요
- 모르는 것은 "내 지식 범위 밖이에요" 라고 솔직하게 말하세요
- 내 전문 분야({expertise})에 대해서는 깊이 있게 답하세요
- 짧고 명확하게, 내 스타일({work_style})로 답하세요"""


def build_avatar_context(query: str = "") -> dict:
    """아바타 채팅용 시스템 프롬프트 + 검색 결과 조합"""
    profile = get_profile()
    interests = pattern.core_interests(6)
    trends = pattern.topic_trends(30)

    # 쿼리 관련 KG 검색
    relevant = []
    if query:
        results = embeddings.search(query, n_results=5)
        for r in results:
            node = graph.get_node(r["id"])
            if node and node.get("content"):
                relevant.append(f"- [{node['title']}] {node['content'][:200]}")

    # 최근 sync 항목
    recent = list_synced(limit=10)

    def pval(key):
        return profile.get(key, {}).get("value", "") if profile else ""

    name = pval("name") or "사용자"
    expertise = pval("expertise") or "다양한 분야"
    work_style = pval("work_style") or "효율적으로"

    profile_section = "\n".join([
        f"- {PROFILE_LABELS.get(k, k)}: {profile[k]['value']}"
        for k in PROFILE_KEYS if k in profile and profile[k]['value']
    ]) or "(프로파일 미설정)"

    interests_section = "\n".join([
        f"- {i['topic']} (중요도 {i['importance']:.1f}, 문서 {i['doc_count']}개)"
        for i in interests
    ]) or "(데이터 없음)"

    recent_section = "\n".join([
        f"- [{r['source']}] {r['title']}" for r in recent[:6]
    ]) or "(동기화된 항목 없음)"

    system = AVATAR_SYSTEM.format(
        name=name,
        profile_section=profile_section,
        interests_section=interests_section,
        recent_section=recent_section,
        expertise=expertise,
        work_style=work_style,
    )

    # 관련 컨텍스트가 있으면 추가
    if relevant:
        system += "\n\n## 질문과 관련된 내 지식\n" + "\n".join(relevant)

    return {
        "system": system,
        "name": name,
        "profile": profile,
        "interests": interests,
        "trends": trends[:5],
    }
