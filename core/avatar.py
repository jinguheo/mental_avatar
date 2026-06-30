"""아바타 프로파일 관리 + 채팅 컨텍스트 빌더"""
import json
import re
import urllib.request
import urllib.error
from db.init_db import get_conn
from . import graph, embeddings, pattern

MCP_URL = "http://127.0.0.1:8765/mcp"
_mcp_req_id = 0

def _mcp_call(tool: str, args: dict) -> dict | None:
    global _mcp_req_id
    _mcp_req_id += 1
    payload = json.dumps({
        "jsonrpc": "2.0", "id": _mcp_req_id,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args}
    }).encode()
    try:
        req = urllib.request.Request(MCP_URL, data=payload,
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read())
        if "error" in body:
            return None
        content = body.get("result", {}).get("content", [])
        for c in content:
            if c.get("type") == "text":
                return {"text": c["text"]}
            if c.get("type") == "json":
                return c.get("json")
        return None
    except Exception:
        return None

def _fetch_realtime_context(query: str) -> str:
    """쿼리 의도를 감지해 MCP 실시간 데이터를 조회하고 컨텍스트 문자열 반환"""
    parts = []
    q = query.lower()

    # 날씨
    if re.search(r"날씨|기온|온도|비|눈|weather|forecast|예보", q):
        KR_CITY = {"서울":"Seoul","부산":"Busan","대구":"Daegu","인천":"Incheon",
                   "광주":"Gwangju","대전":"Daejeon","수원":"Suwon","화성":"Hwaseong",
                   "성남":"Seongnam","용인":"Yongin","제주":"Jeju"}
        city_match = re.search(r"(서울|부산|대구|인천|광주|대전|수원|화성|성남|용인|제주|Seoul|Busan|Daegu)", query, re.IGNORECASE)
        city_kr = city_match.group(1) if city_match else "서울"
        city = KR_CITY.get(city_kr, city_kr)
        if "예보" in q or "forecast" in q:
            data = _mcp_call("weather.forecast", {"city": city})
        else:
            data = _mcp_call("weather.current", {"city": city})
        if data:
            text = data.get("text") or json.dumps(data, ensure_ascii=False)
            parts.append(f"### 날씨 정보 ({city_kr})\n{text[:600]}")

    # 주식
    if re.search(r"주식|코스피|코스닥|삼성|stock|nasdaq|s&p|etf|nvda|aapl|종목|시세", q):
        symbols = []
        if re.search(r"삼성|005930", q): symbols.append("005930.KS")
        if re.search(r"코스피|kospi|\^ks11", q): symbols.append("^KS11")
        if re.search(r"코스닥|kosdaq|\^ksq", q): symbols.append("^KQ11")
        if re.search(r"nvda|엔비디아", q): symbols.append("NVDA")
        if re.search(r"aapl|애플", q): symbols.append("AAPL")
        if not symbols:
            symbols = ["^KS11", "^KQ11"]
        data = _mcp_call("stocks.watchlist", {"symbols": symbols})
        if data:
            text = data.get("text") or json.dumps(data, ensure_ascii=False)
            parts.append(f"### 주식 시세\n{text[:600]}")

    # 뉴스
    if re.search(r"뉴스|news|최신|트렌드|ai 동향|llm|gpt|claude", q):
        data = _mcp_call("news.ai", {"maxResults": 5, "query": query[:80]})
        if data:
            text = data.get("text") or json.dumps(data, ensure_ascii=False)
            parts.append(f"### 최신 AI 뉴스\n{text[:600]}")

    return "\n\n".join(parts)


# ── 프로파일 ───────────────────────────────────────────

PROFILE_KEYS = [
    "name", "role", "company", "main_projects",
    "expertise", "work_style", "goals", "values", "other",
    "speech_style", "persona", "language_tone",
    "video_still", "video_preprocess", "video_enhancer", "video_size", "video_expression_scale",
    # Preference — 직접 입력(manual) + 자동측정(auto, LLM 추정) + 병합에 쓰는 메타
    "mbti_manual", "personality_manual", "preference_manual",
    "mbti_auto", "mbti_auto_reasoning", "personality_auto", "preference_auto", "preference_auto_at",
    "preference_interval_days",
    # Big Five 성향 점수(0~100) — 레이더 차트 비교용. *_manual=직접입력, *_auto=자동측정
    *[f"trait_{t}_manual" for t in ("openness", "conscientiousness", "extraversion", "agreeableness", "stability")],
    *[f"trait_{t}_auto" for t in ("openness", "conscientiousness", "extraversion", "agreeableness", "stability")],
]

TRAIT_KEYS = ["openness", "conscientiousness", "extraversion", "agreeableness", "stability"]
TRAIT_LABELS = {
    "openness":          "개방성",
    "conscientiousness": "성실성",
    "extraversion":      "외향성",
    "agreeableness":     "친화성",
    "stability":         "정서안정성",
}

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
    "mbti_manual":            "MBTI (직접 입력)",
    "personality_manual":     "성격 (직접 입력)",
    "preference_manual":      "선호도/가치관 (직접 입력)",
    "mbti_auto":              "MBTI (자동 측정)",
    "mbti_auto_reasoning":    "MBTI 축별 판단 근거 (자동 측정)",
    "personality_auto":       "성격 (자동 측정)",
    "preference_auto":        "선호도/가치관 (자동 측정)",
    "preference_auto_at":     "자동 측정 마지막 시각",
    "preference_interval_days": "자동 측정 주기 (일)",
    **{f"trait_{t}_manual": f"{TRAIT_LABELS[t]} (직접 입력)" for t in TRAIT_KEYS},
    **{f"trait_{t}_auto":   f"{TRAIT_LABELS[t]} (자동 측정)" for t in TRAIT_KEYS},
}

PREFERENCE_INTERVAL_DEFAULT_DAYS = 7

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

# view별 마지막 대화 노드 id — 같은 대화 스레드를 "follows" 엣지로 이어붙이기 위함
_last_conv_node: dict[str, str] = {}


def log_conversation(view: str, role: str, content: str) -> None:
    """채팅 turn 저장 (행동/말투 학습의 원재료) + 지식 그래프 노드/엣지/임베딩으로도 연결.
    이렇게 하면 /search, /avatar/context의 시멘틱 검색에서 과거 대화도 결과로 나온다."""
    if not content or not content.strip():
        return
    import uuid
    content = content.strip()
    conv_id = str(uuid.uuid4())
    conn = get_conn()
    conn.execute(
        "INSERT INTO conversations (id, view, role, content) VALUES (?,?,?,?)",
        (conv_id, view, role, content)
    )
    conn.commit()
    conn.close()

    title = f"[{view}] {role}: " + (content[:40] + "…" if len(content) > 40 else content)
    node_id = graph.add_node(
        type="conversation", title=title, content=content,
        source_type="conversation", file_path=f"conversation://{view}/{conv_id}",
    )
    embeddings.add_document(node_id, title, content, {"source_type": "conversation", "view": view, "role": role})

    prev_id = _last_conv_node.get(view)
    if prev_id:
        graph.add_edge(prev_id, node_id, "follows", 1.0)
    _last_conv_node[view] = node_id


def recent_conversations(limit: int = 50, role: str = "", view: str = "", since: str = "") -> list:
    conn = get_conn()
    where, params = [], []
    if role:
        where.append("role=?"); params.append(role)
    if view:
        where.append("view=?"); params.append(view)
    if since:
        where.append("created_at>?"); params.append(since)
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


# ── Preference (MBTI/성격/선호도) 직접입력 + 자동측정 + 병합 ──────

# MBTI 4축 판별 기준 — 웹 검색으로 확보해 저장한 객관적 근거 자료(출처: simplypsychology.org,
# myersbriggs.org, Wikipedia 'Myers–Briggs Type Indicator', 2026-06-27 조사).
# LLM이 자기 추측이 아니라 이 기준에 근거해 판단하도록 프롬프트에 그대로 포함시킨다.
MBTI_AXIS_CRITERIA = {
    "EI": {
        "label": "E(외향) vs I(내향) — 에너지의 방향",
        "desc": (
            "E(외향)는 사람·활동·외부 자극에서 에너지를 얻고 생각을 말로 먼저 풀어내며 사람들과의 교류로 "
            "재충전한다. I(내향)는 내면의 생각·아이디어·성찰에서 에너지를 얻고, 말보다 글이나 혼자 있는 "
            "시간을 통해 재충전한다."
        ),
    },
    "SN": {
        "label": "S(감각) vs N(직관) — 정보 수집 방식",
        "desc": (
            "S(감각)는 오감으로 들어오는 구체적 사실과 현재의 경험을 먼저 모으고 신뢰하며 세부사항에 강하다. "
            "N(직관)은 사실보다 패턴·가능성·미래를 먼저 보고, 큰 그림에서 출발해 세부로 내려가는 추상적 사고를 한다."
        ),
    },
    "TF": {
        "label": "T(사고) vs F(감정) — 의사결정 기준",
        "desc": (
            "T(사고)는 논리, 일관성, 결과의 객관적 분석을 우선해 결정한다. F(감정)는 그 결정이 사람들에게 "
            "미치는 영향과 가치관, 관계의 조화를 우선해 결정한다."
        ),
    },
    "JP": {
        "label": "J(판단) vs P(인식) — 생활 방식",
        "desc": (
            "J(판단)는 계획을 세우고 목록을 만들며 일정을 미리 정해 꾸준히 진행하는 것을 선호한다. P(인식)는 "
            "유연함과 즉흥적 적응을 선호하고, 마감 직전에 몰아서 처리하거나 새로운 기회에 열려 있는 편이다."
        ),
    },
}
MBTI_CRITERIA_TEXT = "\n".join(
    f"- {v['label']}: {v['desc']}" for v in MBTI_AXIS_CRITERIA.values()
)

PREFERENCE_PROMPT = """당신은 사용자의 성격과 선호도를 분석하는 전문가입니다.
아래는 한 사용자에 대해 수집된 여러 자료입니다 — 디지털 아바타/AI와 나눈 대화(사용자가 직접 작성한 메시지),
사용자가 직접 쓴 노트, 그리고 지식 그래프에서 뽑은 관심 토픽/트렌드. 이 모두를 종합해서 판단하세요.
(대화·노트의 실제 어휘와 글쓰기 방식이 성격을 가장 직접적으로 드러냅니다. 토픽/트렌드는 관심사 신호로 참고하세요.)

## 최근 대화 (아바타/AI 채팅에서 사용자가 직접 쓴 메시지)
{messages}

## 사용자가 직접 쓴 노트
{notes}

## 최근 관심 토픽 (중요도 순)
{interests}

## 토픽 변화 추세 (최근 30일)
{trends}

## MBTI 4축 판별 기준 (이 기준에 근거해서만 판단할 것 — 임의로 추측하지 말 것)
{mbti_criteria}

위 판별 기준을 각 축마다 사용자의 대화·노트 내용과 대조해서, 어느 쪽에 더 가까운지와 그 근거(대화/노트에서 실제로
드러난 표현이나 행동 패턴)를 구체적으로 쓰세요. 근거가 부족하면 confidence를 낮게(30 이하) 주세요.
그 다음 성격, 선호도/가치관을 설명하고, Big Five 성향 5가지({trait_labels})를 각각 0~100점
(낮을수록 그 성향이 약함, 50은 중간)으로도 추정하세요.

반드시 아래 JSON 형식으로만 답하세요 (다른 설명 없이):
{{"mbti_axes": {{
  "EI": {{"letter": "<E 또는 I>", "confidence": <0~100>, "evidence": "<판별 기준 대비 대화에서 드러난 근거, 한국어 1~2문장>"}},
  "SN": {{"letter": "<S 또는 N>", "confidence": <0~100>, "evidence": "<근거>"}},
  "TF": {{"letter": "<T 또는 F>", "confidence": <0~100>, "evidence": "<근거>"}},
  "JP": {{"letter": "<J 또는 P>", "confidence": <0~100>, "evidence": "<근거>"}}
}}, "personality": "<한국어 2~3문장 성격 설명>", "preference": "<한국어 2~3문장 선호도/가치관 설명>", "traits": {{"openness": <0~100>, "conscientiousness": <0~100>, "extraversion": <0~100>, "agreeableness": <0~100>, "stability": <0~100>}}, "reason": "<전체적으로 어떤 근거로 이렇게 판단했는지 2~3문장>"}}"""


def analyze_preference(limit: int = 60) -> dict:
    """노트 + 모든 채널 대화 + 지식그래프 토픽을 종합해 MBTI/성격/선호도를 추정 — 자동측정(주기적 실행 대상).
    대화는 view 구분 없이(멘탈아바타·AI 등 전부), 사용자가 직접 쓴 노트 원문까지 함께 분석한다."""
    convos = recent_conversations(limit=limit, role="user")
    notes = graph.list_nodes(source_type="note", limit=30)
    # 노트가 충분하면 대화가 적어도 분석 가능 (대화 5턴 OR 노트 3개 이상)
    if len(convos) < 5 and len(notes) < 3:
        return {"ready": False, "count": len(convos),
                "message": "분석하기엔 자료가 너무 적습니다 (대화 5턴 또는 노트 3개 이상 필요)"}

    messages = "\n".join(f"- {c['content'][:300]}" for c in reversed(convos)) or "(대화 없음)"
    notes_text = "\n".join(
        f"- {(n.get('title') or '').strip()}: {(n.get('content') or '').strip()[:400]}"
        for n in notes if (n.get('content') or '').strip()
    ) or "(노트 없음)"
    interests = pattern.core_interests(8)
    interests_text = "\n".join(
        f"- {i['topic']} (중요도 {i['importance']:.1f}, 문서 {i['doc_count']}개)" for i in interests
    ) or "(데이터 없음)"
    trends = pattern.topic_trends(30)
    trends_text = "\n".join(
        f"- {t['topic']}: {t['growth']}" for t in trends[:8]
    ) or "(데이터 없음)"

    trait_labels = ", ".join(f"{k}({TRAIT_LABELS[k]})" for k in TRAIT_KEYS)
    prompt = PREFERENCE_PROMPT.format(
        messages=messages, notes=notes_text, interests=interests_text, trends=trends_text,
        trait_labels=trait_labels, mbti_criteria=MBTI_CRITERIA_TEXT,
    )

    raw = pattern._llm_call(prompt)

    import re
    suggestion = {}
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if m:
        try:
            suggestion = json.loads(m.group(0))
        except Exception:
            suggestion = {}

    traits = suggestion.get("traits", {}) if isinstance(suggestion.get("traits"), dict) else {}
    trait_updates = {}
    for t in TRAIT_KEYS:
        v = traits.get(t)
        try:
            if v is not None:
                trait_updates[f"trait_{t}_auto"] = max(0, min(100, int(round(float(v)))))
        except (TypeError, ValueError):
            continue

    # 4축(EI/SN/TF/JP) 판별 기준 대비 근거를 종합해 MBTI 문자열 구성 + 근거를 그대로 보존
    axes = suggestion.get("mbti_axes", {}) if isinstance(suggestion.get("mbti_axes"), dict) else {}
    mbti_letters = ""
    axis_reasoning = {}
    for axis_key, (pole_a, pole_b) in zip(("EI", "SN", "TF", "JP"), MBTI_AXIS_PAIRS):
        info = axes.get(axis_key, {}) if isinstance(axes.get(axis_key), dict) else {}
        letter = str(info.get("letter", "")).strip().upper()
        if letter not in (pole_a, pole_b):
            letter = ""
        mbti_letters += letter or "?"
        if letter:
            axis_reasoning[axis_key] = {
                "letter": letter,
                "confidence": info.get("confidence"),
                "evidence": info.get("evidence", ""),
                "criteria": MBTI_AXIS_CRITERIA[axis_key]["desc"],
            }
    mbti_auto = mbti_letters if "?" not in mbti_letters else (suggestion.get("mbti", "") or "")

    return {
        "ready": True,
        "count": len(convos),
        "suggestion": {
            "mbti_auto":           mbti_auto,
            "mbti_auto_reasoning": json.dumps(axis_reasoning, ensure_ascii=False) if axis_reasoning else "",
            "personality_auto":    suggestion.get("personality", ""),
            "preference_auto":     suggestion.get("preference", ""),
            **trait_updates,
        },
        "reason": suggestion.get("reason", raw if not suggestion else ""),
    }


def apply_preference_suggestion(suggestion: dict) -> dict:
    """자동측정된 preference 제안을 프로파일에 반영(직접입력 필드는 건드리지 않음)"""
    allowed = (
        {"mbti_auto", "mbti_auto_reasoning", "personality_auto", "preference_auto"}
        | {f"trait_{t}_auto" for t in TRAIT_KEYS}
    )
    updates = {k: v for k, v in suggestion.items() if k in allowed and v not in (None, "")}
    if updates:
        updates["preference_auto_at"] = _now_local()
    return update_profile(updates)


def analyze_and_apply_preference(limit: int = 60) -> dict:
    """주기적 자동측정용: 분석 후 ready면 바로 적용까지 한 번에 수행"""
    result = analyze_preference(limit)
    if result.get("ready") and any(result["suggestion"].values()):
        apply_preference_suggestion(result["suggestion"])
        result["applied"] = True
    else:
        result["applied"] = False
    return result


def preference_due(interval_days: int | None = None) -> bool:
    """preference_interval_days 설정(또는 기본값) 기준으로 자동측정이 지금 필요한지 판단"""
    profile = get_profile()
    if interval_days is None:
        raw = profile.get("preference_interval_days", {}).get("value", "")
        try:
            interval_days = int(raw) if raw else PREFERENCE_INTERVAL_DEFAULT_DAYS
        except ValueError:
            interval_days = PREFERENCE_INTERVAL_DEFAULT_DAYS
    last = profile.get("preference_auto_at", {}).get("value", "")
    if not last:
        return True
    try:
        from datetime import datetime, timedelta
        last_dt = datetime.strptime(last, "%Y-%m-%d %H:%M:%S")
        return datetime.now() - last_dt >= timedelta(days=interval_days)
    except ValueError:
        return True


def _now_local() -> str:
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def preference_section_text() -> str:
    """직접입력(manual)과 자동측정(auto)을 병합한 preference 텍스트 — 아바타 시스템 프롬프트에 삽입"""
    profile = get_profile()

    def pv(key: str) -> str:
        return profile.get(key, {}).get("value", "") if profile else ""

    lines = []
    mbti_m, mbti_a = pv("mbti_manual"), pv("mbti_auto")
    if mbti_m or mbti_a:
        line = f"- MBTI: {mbti_m or '(미입력)'}"
        if mbti_a and mbti_a != mbti_m:
            line += f" (자동측정 추정: {mbti_a})"
        lines.append(line)

    pers_m, pers_a = pv("personality_manual"), pv("personality_auto")
    if pers_m or pers_a:
        line = f"- 성격: {pers_m or '(미입력)'}"
        if pers_a:
            line += f" (자동측정 참고: {pers_a})"
        lines.append(line)

    pref_m, pref_a = pv("preference_manual"), pv("preference_auto")
    if pref_m or pref_a:
        line = f"- 선호도/가치관: {pref_m or '(미입력)'}"
        if pref_a:
            line += f" (자동측정 참고: {pref_a})"
        lines.append(line)

    trait_lines = []
    for t in TRAIT_KEYS:
        tm, ta = pv(f"trait_{t}_manual"), pv(f"trait_{t}_auto")
        if tm or ta:
            label = TRAIT_LABELS[t]
            val = tm or ta
            suffix = f" (자동측정: {ta}점)" if ta and ta != tm else ""
            trait_lines.append(f"{label} {val}점{suffix}")
    if trait_lines:
        lines.append("- Big Five 성향(0~100점): " + ", ".join(trait_lines))

    if not lines:
        return ""
    return "\n".join(lines)


# Big Five 점수 → 구체적 "말하기 방식" 행동지침. LIWC 등 성격-언어 연구의 표지를 규칙화한 것.
# 점수가 높으면(>=65) high, 낮으면(<=35) low 지침을 주고, 중간대(36~64)는 노이즈 방지로 생략.
BIGFIVE_BEHAVIOR = {
    "openness": {
        "high": "추상적 개념·비유·새로운 아이디어를 적극 제시하고 다양한 관점을 탐색하며 답한다.",
        "low":  "검증된 사실과 구체적·실용적인 답을 선호하고, 군더더기 없이 핵심만 말한다.",
    },
    "conscientiousness": {
        "high": "체계적으로 단계를 나눠 계획적으로 답하고, 정확성과 완결성을 중시한다.",
        "low":  "큰 틀 위주로 유연하게 답하고, 세부 절차에 얽매이지 않는다.",
    },
    "extraversion": {
        "high": "먼저 말을 꺼내고 활기차고 긍정적인 표현을 자주 쓰며 적극적으로 제안한다.",
        "low":  "차분하고 간결하게, 꼭 필요한 말만 신중하게 한다.",
    },
    "agreeableness": {
        "high": "따뜻하고 공감적인 표현을 쓰고, 상대 입장을 배려하며 부드럽게 말한다.",
        "low":  "솔직하고 직설적으로, 사실과 논리 위주로 말한다.",
    },
    "stability": {
        "high": "침착하고 안정적인 어조를 유지하고, 불안·부정적 표현을 피한다.",
        "low":  "감정을 솔직하게 드러내고, 우려나 신중함을 자연스럽게 표현한다.",
    },
}


def bigfive_behavior_guidance() -> str:
    """프로파일의 Big Five 점수(직접입력 우선, 없으면 자동측정)를 말하기 방식 지침으로 변환.
    숫자만으로는 작은 모델이 행동으로 못 옮기므로, 점수→구체 행동지침 문장을 프롬프트에 직접 넣는다."""
    profile = get_profile()

    def pv(key: str) -> str:
        return profile.get(key, {}).get("value", "") if profile else ""

    lines = []
    for t in TRAIT_KEYS:
        raw = pv(f"trait_{t}_manual") or pv(f"trait_{t}_auto")
        if not raw:
            continue
        try:
            score = int(round(float(raw)))
        except (TypeError, ValueError):
            continue
        band = "high" if score >= 65 else "low" if score <= 35 else ""
        if not band:
            continue
        lines.append(f"- {TRAIT_LABELS[t]}({score}점): {BIGFIVE_BEHAVIOR[t][band]}")

    return "\n".join(lines)


# 첫 글자(pole_a)=바깥쪽(100), 둘째 글자(pole_b)=안쪽(0)
# 바깥쪽: E·N·T·J / 안쪽: I·S·F·P
MBTI_AXIS_PAIRS = [("E", "I"), ("N", "S"), ("T", "F"), ("J", "P")]
MBTI_AXIS_LABELS = ["E-I", "N-S", "T-F", "J-P"]


def _mbti_axis_scores(mbti: str) -> list[int | None]:
    """4글자 MBTI를 4축 점수(전자=100, 후자=0)로 변환. 형식이 안 맞으면 전부 None"""
    s = (mbti or "").strip().upper()
    if len(s) != 4:
        return [None, None, None, None]
    scores: list[int | None] = []
    for i, (a, b) in enumerate(MBTI_AXIS_PAIRS):
        ch = s[i]
        if ch == a:
            scores.append(100)
        elif ch == b:
            scores.append(0)
        else:
            scores.append(None)
    return scores


def _mbti_axis_evidence(raw_json: str) -> list[dict | None]:
    """저장된 mbti_auto_reasoning(JSON)을 4축 순서(EI/SN/TF/JP) 리스트로 변환 — 없으면 None"""
    if not raw_json:
        return [None, None, None, None]
    try:
        parsed = json.loads(raw_json)
    except Exception:
        return [None, None, None, None]
    out = []
    for axis_key in ("EI", "SN", "TF", "JP"):
        info = parsed.get(axis_key) if isinstance(parsed, dict) else None
        out.append(info if isinstance(info, dict) else None)
    return out


def preference_radar() -> dict:
    """Big Five 5축 + MBTI 4축, 직접입력 vs 자동측정 점수 + 차이 — 레이더 차트 비교용"""
    profile = get_profile()

    def pv(key: str) -> str:
        return profile.get(key, {}).get("value", "") if profile else ""

    mbti_m_raw, mbti_a_raw = pv("mbti_manual"), pv("mbti_auto")
    mbti_m_scores = _mbti_axis_scores(mbti_m_raw)
    mbti_a_scores = _mbti_axis_scores(mbti_a_raw)
    mbti_block = {
        "axes": MBTI_AXIS_LABELS,
        "manual": [v if v is not None else 50 for v in mbti_m_scores],
        "auto":   [v if v is not None else 50 for v in mbti_a_scores],
        "manual_set": [v is not None for v in mbti_m_scores],
        "auto_set":   [v is not None for v in mbti_a_scores],
        "diff": [
            abs(m - a) if m is not None and a is not None else None
            for m, a in zip(mbti_m_scores, mbti_a_scores)
        ],
        "manual_label": mbti_m_raw,
        "auto_label": mbti_a_raw,
        "evidence": _mbti_axis_evidence(pv("mbti_auto_reasoning")),
        "criteria": [MBTI_AXIS_CRITERIA[k]["desc"] for k in ("EI", "SN", "TF", "JP")],
    }

    axes, manual, auto, manual_set, auto_set, diff = [], [], [], [], [], []
    for t in TRAIT_KEYS:
        axes.append(TRAIT_LABELS[t])
        m_raw, a_raw = pv(f"trait_{t}_manual"), pv(f"trait_{t}_auto")
        try:
            m_val = int(m_raw) if m_raw != "" else None
        except ValueError:
            m_val = None
        try:
            a_val = int(a_raw) if a_raw != "" else None
        except ValueError:
            a_val = None
        manual.append(m_val if m_val is not None else 50)
        auto.append(a_val if a_val is not None else 50)
        manual_set.append(m_val is not None)
        auto_set.append(a_val is not None)
        diff.append(abs((m_val if m_val is not None else 50) - (a_val if a_val is not None else 50))
                    if m_val is not None and a_val is not None else None)

    return {
        "axes": axes,
        "keys": TRAIT_KEYS,
        "manual": manual,
        "auto": auto,
        "manual_set": manual_set,
        "auto_set": auto_set,
        "diff": diff,
        "auto_at": pv("preference_auto_at"),
        "mbti": mbti_block,
    }


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

## MBTI/성격/선호도 (직접입력 우선, 자동측정은 참고용)
{preference_section}

## 내 성격에 따른 말하기 방식 (아래 지침대로 어조·표현을 맞추세요)
{behavior_section}

규칙:
- 항상 1인칭("나는", "내가", "제 생각에는")으로 답하세요
- 모르는 것은 "내 지식 범위 밖이에요" 라고 솔직하게 말하세요
- 내 전문 분야({expertise})에 대해서는 깊이 있게 답하세요
- 짧고 명확하게, 내 스타일({work_style})로 답하세요
- 위에 설정된 말투와 성격을 일관되게 유지하세요
- 답변/추천을 할 때는 위 MBTI/성격/선호도와 "말하기 방식" 지침을 반영해서 그 사람에게 맞는 방식으로 답하세요"""


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
    PREFERENCE_KEYS = {
        "mbti_manual", "personality_manual", "preference_manual",
        "mbti_auto", "mbti_auto_reasoning", "personality_auto", "preference_auto", "preference_auto_at",
        "preference_interval_days",
    } | {f"trait_{t}_manual" for t in TRAIT_KEYS} | {f"trait_{t}_auto" for t in TRAIT_KEYS}
    profile_section = "\n".join([
        f"- {PROFILE_LABELS.get(k, k)}: {profile[k]['value']}"
        for k in PROFILE_KEYS if k in profile and profile[k]['value'] and k not in STYLE_KEYS and k not in PREFERENCE_KEYS
    ]) or "(프로파일 미설정)"

    preference_section = preference_section_text() or "- (직접입력/자동측정 모두 없음)"
    behavior_section = bigfive_behavior_guidance() or "- (Big Five 미설정 — 기본 어조 사용)"

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
        preference_section=preference_section,
        behavior_section=behavior_section,
    )

    # 관련 컨텍스트가 있으면 추가
    if relevant:
        system += "\n\n## 질문과 관련된 내 지식\n" + "\n".join(relevant)

    # 실시간 MCP 데이터 (날씨/주식/뉴스)
    if query:
        realtime = _fetch_realtime_context(query)
        if realtime:
            system += (
                "\n\n## 실시간 정보 [방금 API에서 조회됨 — 반드시 이 데이터로 답변]\n"
                "⚠️ 중요: 아래는 지금 막 외부 API에서 가져온 실제 데이터입니다. "
                "실시간 정보를 '모른다', '범위 밖', '검색해보세요' 같은 말로 거부하지 마세요. "
                "아래 데이터를 직접 해석해서 자연스럽게 답변하세요.\n"
                + realtime
            )

    return {
        "system": system,
        "name": name,
        "profile": profile,
        "interests": interests,
        "trends": trends[:5],
    }
