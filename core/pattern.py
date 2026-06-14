"""패턴 분석 — 아바타의 추론 핵심
관심사 추적, 토픽 트렌드, 지식 갭 탐지, 1인칭 자기 요약
"""
import json
from datetime import datetime, timedelta
from db.init_db import get_conn
from . import env


# ── 관심사 추적 ────────────────────────────────────────

def topic_trends(days: int = 30) -> list[dict]:
    """최근 N일 토픽별 문서 수 + 증가율"""
    conn = get_conn()
    since = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    prev = (datetime.now() - timedelta(days=days*2)).strftime("%Y-%m-%d %H:%M:%S")

    rows = conn.execute("""
        SELECT t.name,
               SUM(CASE WHEN n.created_at >= ? THEN 1 ELSE 0 END) AS recent,
               SUM(CASE WHEN n.created_at >= ? AND n.created_at < ? THEN 1 ELSE 0 END) AS prior,
               COUNT(*) AS total
        FROM topics t
        JOIN node_topics nt ON t.id = nt.topic_id
        JOIN nodes n ON nt.node_id = n.id
        GROUP BY t.id
        ORDER BY recent DESC, total DESC
    """, (since, prev, since)).fetchall()
    conn.close()

    trends = []
    for r in rows:
        recent, prior = r["recent"], r["prior"]
        if prior == 0:
            growth = "신규" if recent > 0 else "휴면"
        elif recent > prior:
            growth = "상승"
        elif recent < prior:
            growth = "하락"
        else:
            growth = "유지"
        trends.append({
            "topic": r["name"],
            "recent": recent,
            "total": r["total"],
            "growth": growth
        })
    return trends


# ── 무게(중요도) 분석 ──────────────────────────────────

def core_interests(limit: int = 10) -> list[dict]:
    """자주 돌아오고 중요도 높은 주제 = 핵심 관심사"""
    conn = get_conn()
    rows = conn.execute("""
        SELECT t.name, COUNT(nt.node_id) AS doc_count,
               AVG(n.importance) AS avg_importance,
               COUNT(al.id) AS access_count
        FROM topics t
        JOIN node_topics nt ON t.id = nt.topic_id
        JOIN nodes n ON nt.node_id = n.id
        LEFT JOIN activity_log al ON al.node_id = n.id
        GROUP BY t.id
        ORDER BY (COUNT(nt.node_id) * AVG(n.importance)) DESC
        LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return [{
        "topic": r["name"],
        "doc_count": r["doc_count"],
        "importance": round(r["avg_importance"] or 0, 2),
        "access_count": r["access_count"]
    } for r in rows]


# ── 지식 갭 탐지 ───────────────────────────────────────

def knowledge_gaps() -> list[dict]:
    """문서 적은 토픽 + 답 없는 질문 = 보강 필요 영역"""
    conn = get_conn()
    # 문서 1~2개뿐인 토픽 (얕게 다룬 주제)
    thin = conn.execute("""
        SELECT t.name, COUNT(nt.node_id) AS cnt
        FROM topics t
        JOIN node_topics nt ON t.id = nt.topic_id
        GROUP BY t.id
        HAVING cnt <= 2
        ORDER BY cnt ASC
        LIMIT 10
    """).fetchall()
    conn.close()
    return [{"topic": r["name"], "doc_count": r["cnt"], "type": "얕은 주제"} for r in thin]


# ── 망각 모델 ──────────────────────────────────────────

def apply_decay(days_threshold: int = 60, decay: float = 0.05):
    """오래 접근 안 한 노드 중요도 감소 (인간 기억처럼)"""
    conn = get_conn()
    cutoff = (datetime.now() - timedelta(days=days_threshold)).strftime("%Y-%m-%d %H:%M:%S")
    conn.execute("""
        UPDATE nodes
        SET importance = MAX(0.1, importance - ?)
        WHERE id NOT IN (
            SELECT DISTINCT node_id FROM activity_log
            WHERE timestamp >= ? AND node_id IS NOT NULL
        )
    """, (decay, cutoff))
    affected = conn.total_changes
    conn.commit()
    conn.close()
    return affected


# ── 아바타 자기 요약 (1인칭) ───────────────────────────

AVATAR_PROMPT = """당신은 한 사람의 '정신적 아바타'입니다. 아래는 그 사람이 최근 모아온 지식의 패턴입니다.

핵심 관심사 (중요도순):
{interests}

토픽 트렌드 (최근 30일):
{trends}

보강이 필요한 영역:
{gaps}

이 데이터를 바탕으로, 그 사람의 1인칭 시점에서 자기 자신을 요약하세요.
"나는 요즘 ~를 깊이 파고들고 있고, ~쪽으로 관심이 옮겨가고 있다. ~는 아직 부족하다" 같은 식으로.
3~5문장. 한국어. 통찰력 있게."""


def avatar_summary() -> dict:
    """패턴 데이터를 종합해 1인칭 자기 요약 생성"""
    interests = core_interests(8)
    trends = topic_trends(30)
    gaps = knowledge_gaps()

    if not interests:
        summary_text = "아직 충분한 데이터가 없습니다. 문서를 더 추가해주세요."
    else:
        prompt = AVATAR_PROMPT.format(
            interests=json.dumps(interests, ensure_ascii=False),
            trends=json.dumps(trends[:8], ensure_ascii=False),
            gaps=json.dumps(gaps[:5], ensure_ascii=False)
        )
        summary_text = _llm_call(prompt)

    return {
        "summary": summary_text,
        "core_interests": interests,
        "trends": trends[:10],
        "gaps": gaps[:5]
    }


OLLAMA_URL   = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "gemma4:e2b"


def _llm_call(prompt: str) -> str:
    """로컬 Ollama 우선 → dashboard MCP → ANTHROPIC_API_KEY → 플레이스홀더.

    extractor와 동일하게 로컬 Ollama를 1순위로 둬, 외부 자격증명 없이도
    1인칭 자기 요약·말투 학습 분석이 실제로 동작하게 한다."""
    # 1순위: Ollama (로컬, 항상 시도)
    try:
        import urllib.request
        payload = json.dumps({
            "model": OLLAMA_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "options": {"temperature": 0.2},
        }).encode()
        req = urllib.request.Request(
            OLLAMA_URL, data=payload,
            headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = json.loads(resp.read())
        text = body["message"]["content"].strip()
        if text:
            return text
    except Exception as e:
        print(f"[pattern] Ollama 실패, MCP 재시도: {e}")

    # 2순위: dashboard MCP
    try:
        from . import claude_mcp
        if claude_mcp.is_available():
            return claude_mcp.chat([{"role": "user", "content": prompt}])
    except Exception as e:
        print(f"[pattern] MCP 실패: {e}")

    # 3순위: ANTHROPIC_API_KEY
    if env.get("ANTHROPIC_API_KEY"):
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=env.get("ANTHROPIC_API_KEY"))
            msg = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}]
            )
            return msg.content[0].text.strip()
        except Exception as e:
            return f"(요약 생성 실패: {e})"

    return "(로컬 Ollama·dashboard MCP·ANTHROPIC_API_KEY 중 하나가 있어야 1인칭 자기 요약이 생성됩니다)"
