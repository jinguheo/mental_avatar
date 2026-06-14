"""아바타 프로파일 관리 + 채팅 컨텍스트 빌더"""
import json
from db.init_db import get_conn
from . import graph, embeddings, pattern


# ── 프로파일 ───────────────────────────────────────────

PROFILE_KEYS = [
    "name", "role", "company", "main_projects",
    "expertise", "work_style", "goals", "values", "other",
    "speech_style", "persona", "language_tone",
    "video_still", "video_preprocess", "video_enhancer", "video_size", "video_expression_scale",
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
    "speech_style":  "말투 스타일",
    "persona":       "성격/페르소나",
    "language_tone": "언어 톤",
    "video_still":            "정지 모드 (움직임 최소화)",
    "video_preprocess":       "이미지 전처리",
    "video_enhancer":         "얼굴 화질 향상",
    "video_size":             "출력 해상도",
    "video_expression_scale": "표정 강도",
}

# 말투/성격 선택지
SPEECH_STYLE_OPTIONS = ["존댓말", "반말", "친근한 존댓말", "격식체", "캐주얼"]
PERSONA_OPTIONS      = ["전문적", "친근함", "유머러스", "직설적", "공감적", "호기심 많음"]
LANGUAGE_TONE_OPTIONS= ["따뜻함", "차분함", "활발함", "진지함", "위트있음"]

# 말투/성격 기본값 — 프로파일 미설정 시 권장되는 기본 페르소나
STYLE_DEFAULTS = {
    "speech_style":  "친근한 존댓말",
    "persona":       "친근함",
    "language_tone": "따뜻함",
}

VIDEO_STYLE_OPTIONS = {
    "video_still":            [("켜기", "true"), ("끄기", "false")],
    "video_preprocess":       [("full (전신)", "full"), ("crop (얼굴만)", "crop"), ("resize", "resize")],
    "video_enhancer":         [("GFPGAN (고화질)", "gfpgan"), ("없음", "none")],
    "video_size":             [("512px (고화질)", "512"), ("256px (빠름)", "256")],
    "video_expression_scale": [("보통 (1.0)", "1.0"), ("강하게 (1.5)", "1.5"), ("약하게 (0.5)", "0.5")],
}

VIDEO_STYLE_DEFAULTS = {
    "video_still": "true",
    "video_preprocess": "full",
    "video_enhancer": "gfpgan",
    "video_size": "512",
    "video_expression_scale": "1.0",
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


# ── 대화 로깅 + 말투 학습 ──────────────────────────────

def log_conversation(view: str, role: str, content: str) -> None:
    """채팅 turn 저장 (행동/말투 학습의 원재료)"""
    if not content or not content.strip():
        return
    import uuid
    conn = get_conn()
    conn.execute(
        "INSERT INTO conversations (id, view, role, content) VALUES (?,?,?,?)",
        (str(uuid.uuid4()), view, role, content.strip())
    )
    conn.commit()
    conn.close()


def recent_conversations(limit: int = 50, role: str = "", view: str = "") -> list:
    conn = get_conn()
    where, params = [], []
    if role:
        where.append("role=?"); params.append(role)
    if view:
        where.append("view=?"); params.append(view)
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    rows = conn.execute(
        f"SELECT * FROM conversations {clause} ORDER BY created_at DESC LIMIT ?",
        (*params, limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


STYLE_PROMPT = """당신은 대화 스타일을 분석하는 전문가입니다.
아래는 한 사용자가 자신의 디지털 아바타와 나눈 최근 대화에서, 사용자가 직접 작성한 메시지들입니다.

{messages}

이 메시지들의 말투/문체/성격을 분석해서, 아래 보기 중에서 가장 가까운 것을 하나씩 고르고
그렇게 판단한 근거를 간단히 설명하세요.

- 말투 스타일 보기: {speech_options}
- 성격/페르소나 보기: {persona_options}
- 언어 톤 보기: {tone_options}

반드시 아래 JSON 형식으로만 답하세요 (다른 설명 없이):
{{"speech_style": "<보기 중 하나>", "persona": "<보기 중 하나>", "language_tone": "<보기 중 하나>", "reason": "<한국어 2~3문장 근거>"}}"""


def analyze_speech_style(limit: int = 40) -> dict:
    """최근 사용자 발화를 분석해 말투/성격/톤을 추정 — 프로파일 자동 학습의 기초"""
    convos = recent_conversations(limit=limit, role="user")
    if len(convos) < 5:
        return {"ready": False, "count": len(convos), "message": "분석하기엔 대화가 너무 적습니다 (5턴 이상 필요)"}

    messages = "\n".join(f"- {c['content'][:300]}" for c in reversed(convos))
    prompt = STYLE_PROMPT.format(
        messages=messages,
        speech_options=", ".join(SPEECH_STYLE_OPTIONS),
        persona_options=", ".join(PERSONA_OPTIONS),
        tone_options=", ".join(LANGUAGE_TONE_OPTIONS),
    )

    from . import pattern
    raw = pattern._llm_call(prompt)

    import re
    suggestion = {}
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if m:
        try:
            suggestion = json.loads(m.group(0))
        except Exception:
            suggestion = {}

    return {
        "ready": True,
        "count": len(convos),
        "suggestion": {
            "speech_style":  suggestion.get("speech_style", ""),
            "persona":       suggestion.get("persona", ""),
            "language_tone": suggestion.get("language_tone", ""),
        },
        "reason": suggestion.get("reason", raw if not suggestion else ""),
    }


def apply_style_suggestion(suggestion: dict) -> dict:
    """학습된 말투 제안을 프로파일에 반영"""
    updates = {k: v for k, v in suggestion.items()
               if k in ("speech_style", "persona", "language_tone") and v}
    return update_profile(updates)


# ── 아바타 채팅 컨텍스트 빌더 ──────────────────────────

AVATAR_SYSTEM = """당신은 {name}의 디지털 아바타입니다.
{name}을 완전히 대신하여 1인칭으로 답하세요.

## 나는 누구인가
{profile_section}

## 내가 최근에 집중하는 것 (지식 그래프 기반)
{interests_section}

## 내가 최근 작업한 내용
{recent_section}

## 말투 & 성격
{style_section}

규칙:
- 항상 1인칭("나는", "내가", "제 생각에는")으로 답하세요
- 모르는 것은 "내 지식 범위 밖이에요" 라고 솔직하게 말하세요
- 내 전문 분야({expertise})에 대해서는 깊이 있게 답하세요
- 짧고 명확하게, 내 스타일({work_style})로 답하세요
- 위에 설정된 말투와 성격을 일관되게 유지하세요"""


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

    style_parts = []
    if pval("speech_style"):
        style_parts.append(f"- 말투: {pval('speech_style')}")
    if pval("persona"):
        style_parts.append(f"- 성격: {pval('persona')}")
    if pval("language_tone"):
        style_parts.append(f"- 톤: {pval('language_tone')}")
    style_section = "\n".join(style_parts) or "- (말투/성격 미설정 — 기본 스타일 사용)"

    STYLE_KEYS = {"speech_style", "persona", "language_tone"}
    profile_section = "\n".join([
        f"- {PROFILE_LABELS.get(k, k)}: {profile[k]['value']}"
        for k in PROFILE_KEYS if k in profile and profile[k]['value'] and k not in STYLE_KEYS
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
        style_section=style_section,
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
