"""통합 자기 요약 — 저장·검색(RAG) 위에 얹는 '정리·추상화 층'.

질문마다 비슷한 조각을 검색해 나열하는 대신, 나에 대한 근거를 미리 정리한 요약을 매 답변의 모델 입력에
항상 넣는다. 초안은 근거에서 자동으로 만들지만 **내가 승인한 구역만** 프롬프트에 들어간다(모델이 지어낸
내용이 '나'로 굳지 않게).

구역별 초안을 만드는 방식:
- work(하는 일·구현·주요 지식): 프로젝트 요약·KG 주제·읽은 자료를 근거로 로컬 LLM이 1인칭으로 정리.
- style(내 말투): 내가 직접 타이핑한 문장 표본에서 통계로 뽑는다(LLM 없음). STT 기록은 소음·환각·
  아바타 에코가 많아 쓰지 않는다.
- traits(성격·선호): 직접 입력한 값만 모은다(자동 추정은 작업 문서 기반이라 제외).
- values(가치·판단 기준): 내가 정한 기준과 자문자답 답변만 모은다. 근거가 없으면 비워 둔다.
"""
import collections
import json
import re
import urllib.request
import uuid

from db.init_db import get_conn
from . import pattern, governance

SECTIONS = ("work", "style", "traits", "values")
TITLES = {
    "work": "하는 일·구현·주요 지식",
    "style": "내 말투",
    "traits": "성격·선호 (직접 입력)",
    "values": "가치·판단 기준",
}
PROMPT_LABELS = {
    "work": "내가 하는 일과 주로 쓰는 지식",
    "style": "내 말투 (실제로 내가 쓰는 표현에서 뽑음 — 답변 말투는 이걸 따른다)",
    "traits": "내 성격·선호 (내가 직접 입력한 것)",
    "values": "내 가치·판단 기준",
}
SUMMARY_MODEL = "gemma4:e4b"   # 요약은 품질이 중요해 한 단계 큰 모델을 먼저 쓰고, 없으면 기본 모델로 폴백

TRAIT_NAMES = {"openness": "개방성", "conscientiousness": "성실성", "extraversion": "외향성",
               "agreeableness": "친화성", "stability": "정서안정성"}


def _init(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS avatar_self_summary (
        section TEXT PRIMARY KEY,
        draft TEXT NOT NULL DEFAULT '',
        approved TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT,
        approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS avatar_style_samples (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'typed',
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    """)


# ── 근거 모으기 ─────────────────────────────────────────

def _clean_overview(text: str) -> str:
    """일부 프로젝트 요약은 LLM의 JSON 원문이 그대로 저장돼 있다 — overview만 꺼낸다."""
    t = (text or "").strip()
    if t.startswith("{"):
        try:
            t = json.loads(t).get("overview", t)
        except (ValueError, AttributeError):
            match = re.search(r'"overview"\s*:\s*"(.*?)"', t, re.S)
            t = match.group(1) if match else t
    return re.sub(r"\s+", " ", t)[:220]


def gather_work() -> dict:
    conn = get_conn()
    rows = conn.execute("SELECT name, overview, updated_at FROM project_summaries ORDER BY updated_at DESC").fetchall()
    projects, seen = [], set()
    for row in rows:
        if row["name"] in seen:          # 같은 이름이 두 경로에 스캔돼 중복 저장된 경우가 있다
            continue
        seen.add(row["name"])
        projects.append({"name": row["name"], "overview": _clean_overview(row["overview"])})

    def titles(kind, limit):
        found = []
        for (title,) in conn.execute("SELECT title FROM nodes WHERE COALESCE(source_type, type)=? ORDER BY created_at DESC", (kind,)):
            base = re.sub(r"\s*\[\d+\]\s*$", "", title or "").strip()
            if base and base not in found:
                found.append(base)
        return found[:limit]
    docs = {"pptx": titles("pptx", 8), "paper": titles("paper", 8)}
    conn.close()
    topics = [{"name": t.get("name") or t.get("topic"), "doc_count": t.get("doc_count")} for t in pattern.core_interests(8)]
    return {"projects": projects, "topics": topics, "docs": docs}


def _profile_values() -> dict:
    conn = get_conn()
    rows = conn.execute("SELECT key, value FROM user_profile WHERE value <> ''").fetchall()
    conn.close()
    return {row["key"]: row["value"] for row in rows}


def list_samples() -> list[dict]:
    conn = get_conn()
    _init(conn)
    rows = conn.execute("SELECT id, text, source, created_at FROM avatar_style_samples ORDER BY created_at").fetchall()
    conn.close()
    return [dict(row) for row in rows]


def add_sample(text: str, source: str = "typed") -> dict:
    text = (text or "").strip()
    if not text or len(text) > 1000:
        raise ValueError("sample must be 1~1000 characters")
    conn = get_conn()
    _init(conn)
    if conn.execute("SELECT 1 FROM avatar_style_samples WHERE text=?", (text,)).fetchone():
        conn.close()
        return {"duplicate": True}
    sample_id = uuid.uuid4().hex
    conn.execute("INSERT INTO avatar_style_samples(id, text, source) VALUES (?,?,?)", (sample_id, text, source))
    conn.commit()
    conn.close()
    return {"id": sample_id}


def delete_sample(sample_id: str) -> None:
    conn = get_conn()
    _init(conn)
    conn.execute("DELETE FROM avatar_style_samples WHERE id=?", (sample_id,))
    conn.commit()
    conn.close()


# ── 말투 통계 (LLM 없이 표본에서 직접 계산) ───────────────

def _ending(text: str) -> str:
    """문장 끝 형태: 합쇼체 / 해요체 / 반말(해체·평서)."""
    t = re.sub(r"[\s?!.…~,]+$", "", text)
    if re.search(r"(습니다|습니까|ㅂ니다|입니다|합니다|됩니다|십시오)$", t):
        return "formal"
    if t.endswith("요"):
        return "polite"
    return "casual"


# 끝맺음 어미 범주 — 마지막 어절의 글자 조각("~능해")이 아니라 어미 단위로 센다.
TAILS = [("~해줘", r"줘$"), ("~할까?", r"까$"), ("~야", r"야$"), ("~어", r"어$"), ("~해", r"해$"), ("~네", r"네$"),
         ("~데", r"데$"), ("~자", r"자$"), ("~지", r"지$"), ("~께/~게", r"[께게]$"), ("~요", r"요$"), ("~다", r"다$")]


def _tail(text: str) -> str:
    t = re.sub(r"[\s?!.…~,]+$", "", text)
    for name, pattern_ in TAILS:
        if re.search(pattern_, t):
            return name
    return "끊김"   # 명사·연결형으로 끝남 — 문장을 끝맺지 않고 다음 메시지로 이어 보냄


def style_features(samples: list[str]) -> dict:
    lines = [s.strip() for s in samples if s.strip()]
    n = len(lines)
    if not n:
        return {"n": 0}
    endings = collections.Counter(_ending(s) for s in lines)
    words = [len(s.split()) for s in lines]
    english = collections.Counter(w.lower() for s in lines for w in re.findall(r"[A-Za-z][A-Za-z\-]{2,}", s))
    tails = collections.Counter(_tail(s) for s in lines)
    return {
        "n": n,
        "casual": round(endings["casual"] / n * 100),
        "polite": round(endings["polite"] / n * 100),
        "formal": round(endings["formal"] / n * 100),
        "avg_words": round(sum(words) / n, 1),
        "question": round(sum(1 for s in lines if s.rstrip().endswith("?")) / n * 100),
        "period": round(sum(1 for s in lines if s.rstrip().endswith(".")) / n * 100),
        "english_share": round(sum(1 for s in lines if re.search(r"[A-Za-z]{3,}", s)) / n * 100),
        "english_terms": [w for w, _ in english.most_common(8)],
        "tails": [(t, c) for t, c in tails.most_common(9) if t != "끊김"][:7],
        "unfinished": round(tails["끊김"] / n * 100),
    }


def draft_style(samples: list[dict]) -> tuple[str, dict]:
    typed = [s["text"] for s in samples if s["source"] == "typed"]
    f = style_features(typed)
    if not f.get("n"):
        return "", {"features": f, "samples": []}
    tails = ", ".join("%s(%d)" % (t, c) for t, c in f["tails"][:6])
    examples = sorted(typed, key=len)[: min(8, len(typed))]
    lines = [
        "- 높임(내가 직접 밝힌 기준): 채팅 상대이거나 친한 사람이라고 분명할 때만 반말. 처음 보는 사람·방문자·고객·누군지 모르는 상대에게는 반드시 존댓말(~요/~습니다).",
        "- 높임과 무관한 공통 특징: 짧고 직설적이다. 설명보다 결론·요청을 먼저 말한다. 기술 용어는 영어 그대로 섞는다(예: %s)." % (", ".join(f["english_terms"][:5]) or "-"),
        "- 이렇게 말하지 않는다: '혹시', '~드릴게요', '저희가' 같은 상담원 말투, 괄호로 행동·표정을 묘사하는 지문, 과장된 감탄. 직설적이되 무례하지 않게.",
        "- 근거(채팅 표본 %d개): 반말 %d%% · 해요체 %d%% · 합쇼체 %d%%, 평균 %s어절, 자주 쓰는 끝 %s, 질문형 %d%%, 마침표 %d%%, 끝맺지 않고 이어 보내는 문장 %d%%, 영어 섞인 문장 %d%%." % (
            f["n"], f["casual"], f["polite"], f["formal"], f["avg_words"], tails, f["question"], f["period"], f["unfinished"], f["english_share"]),
        "- 채팅에서 친한 상대에게 쓰는 예(다른 사람에게는 존댓말로 바꿔 말한다): " + " / ".join('"%s"' % e for e in examples),
    ]
    return "\n".join(lines), {"features": f, "samples": typed}


# ── 구역별 초안 ─────────────────────────────────────────

def _ask(prompt: str) -> tuple[str, str]:
    last_error = None
    for model in (SUMMARY_MODEL, pattern.OLLAMA_MODEL):
        try:
            payload = json.dumps({"model": model, "stream": False, "think": False,
                                  "messages": [{"role": "user", "content": prompt}],
                                  "options": {"temperature": 0.2, "num_predict": 700}}).encode()
            req = urllib.request.Request(pattern.OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(req, timeout=240) as resp:
                text = json.loads(resp.read())["message"]["content"].strip()
            if text:
                return text, model
        except Exception as exc:  # noqa: BLE001 — 다음 모델로 폴백
            last_error = exc
    raise RuntimeError("요약 모델 호출 실패: %s" % last_error)


WORK_PROMPT = """아래는 '나'가 실제로 만든 프로젝트 목록과, 내 지식 그래프에서 자주 나오는 주제, 내가 읽은 자료다.
이 근거만 사용해서 내가 반복해서 하는 일, 공통 주제, 구현 방식, 주로 쓰는 지식을 1인칭 평서문('나는 ~한다')으로 5~7문장 정리해라.

규칙:
- 근거에 없는 사실·수치·성격·감정을 지어내지 마라.
- 근거로 쓴 프로젝트 이름을 문장 끝 괄호에 적어라. 예: (3Dto2DVerify, box_detect)
- 제목, 머리말, 목록 기호 없이 문단 하나만 출력해라.

[프로젝트]
{projects}

[지식 그래프 주제(문서 수)]
{topics}

[읽은 자료]
{docs}"""


def draft_work() -> tuple[str, dict]:
    evidence = gather_work()
    if not evidence["projects"]:
        return "", evidence
    projects = "\n".join("- %s: %s" % (p["name"], p["overview"]) for p in evidence["projects"])
    topics = ", ".join("%s(%s)" % (t["name"], t["doc_count"]) for t in evidence["topics"] if t["name"])
    docs = "강의 자료: %s\n논문·문서: %s" % (", ".join(evidence["docs"]["pptx"]) or "-", ", ".join(evidence["docs"]["paper"]) or "-")
    text, model = _ask(WORK_PROMPT.format(projects=projects, topics=topics or "-", docs=docs))
    text = re.sub(r"^\s*#+.*\n", "", text).strip()
    # 근거에 없는 숫자가 나오면 경고로 남긴다(작은 모델의 지어내기 점검).
    source = projects + topics + docs
    evidence["unsupported_numbers"] = [num for num in set(re.findall(r"\d+(?:\.\d+)?", text)) if num not in source]
    evidence["model"] = model
    return text, evidence


def draft_traits() -> tuple[str, dict]:
    p = _profile_values()
    lines = []
    if p.get("mbti_manual"):
        lines.append("- MBTI: %s" % p["mbti_manual"])
    if p.get("personality_manual"):
        lines.append("- 성격: %s" % p["personality_manual"])
    if p.get("preference_manual"):
        lines.append("- 선호·가치관: %s" % p["preference_manual"])
    traits = ["%s %s" % (name, p["trait_%s_manual" % key]) for key, name in TRAIT_NAMES.items() if p.get("trait_%s_manual" % key)]
    if traits:
        lines.append("- Big Five(0~100): " + ", ".join(traits))
    used = {k: v for k, v in p.items() if k.endswith("_manual")}
    return "\n".join(lines), {"manual_fields": used, "excluded": "자동 추정(_auto)은 작업 문서 기반이라 제외"}


def draft_values() -> tuple[str, dict]:
    rules = {k: v["approved"] for k, v in governance.state()["sections"].items() if v["approved"].strip()}
    conn = get_conn()
    answers = [dict(r) for r in conn.execute("SELECT question, answer FROM self_interview ORDER BY created_at DESC LIMIT 30")]
    conn.close()
    lines = ["- %s" % text.replace("\n", " ") for text in rules.values()]
    lines += ["- Q. %s → %s" % (a["question"], a["answer"].replace("\n", " ")[:200]) for a in answers]
    return "\n".join(lines), {"rules": rules, "self_interview": len(answers)}


def generate() -> dict:
    """모든 구역의 초안을 새로 만든다. 승인된 내용(approved)은 건드리지 않는다."""
    drafts = {
        "work": draft_work(),
        "style": draft_style(list_samples()),
        "traits": draft_traits(),
        "values": draft_values(),
    }
    conn = get_conn()
    _init(conn)
    for section, (text, evidence) in drafts.items():
        conn.execute(
            """INSERT INTO avatar_self_summary(section, draft, evidence, updated_at)
               VALUES (?, ?, ?, datetime('now','localtime'))
               ON CONFLICT(section) DO UPDATE SET draft=excluded.draft, evidence=excluded.evidence, updated_at=excluded.updated_at""",
            (section, text, json.dumps(evidence, ensure_ascii=False)))
    conn.commit()
    conn.close()
    return state()


# ── 상태·승인·프롬프트 ──────────────────────────────────

def state() -> dict:
    conn = get_conn()
    _init(conn)
    rows = {row["section"]: dict(row) for row in conn.execute("SELECT * FROM avatar_self_summary")}
    conn.close()
    sections = {}
    for key in SECTIONS:
        row = rows.get(key, {"draft": "", "approved": "", "evidence": "{}", "updated_at": None, "approved_at": None})
        sections[key] = {"section": key, "title": TITLES[key], "draft": row["draft"], "approved": row["approved"],
                         "evidence": json.loads(row["evidence"] or "{}"), "updated_at": row["updated_at"], "approved_at": row["approved_at"]}
    return {"sections": sections, "samples": list_samples()}


def approve(section: str, text: str) -> dict:
    if section not in SECTIONS:
        raise ValueError("unknown section")
    if not isinstance(text, str) or len(text) > 8000:
        raise ValueError("text must be at most 8000 characters")
    conn = get_conn()
    _init(conn)
    conn.execute(
        """INSERT INTO avatar_self_summary(section, draft, approved, updated_at, approved_at)
           VALUES (?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
           ON CONFLICT(section) DO UPDATE SET draft=excluded.draft, approved=excluded.approved,
             updated_at=excluded.updated_at, approved_at=excluded.approved_at""",
        (section, text.strip(), text.strip()))
    conn.commit()
    conn.close()
    return state()["sections"][section]


def revoke(section: str) -> dict:
    if section not in SECTIONS:
        raise ValueError("unknown section")
    conn = get_conn()
    _init(conn)
    conn.execute("UPDATE avatar_self_summary SET approved='', approved_at=NULL WHERE section=?", (section,))
    conn.commit()
    conn.close()
    return state()["sections"][section]


def _approved(overrides: dict | None) -> dict:
    approved = {k: v["approved"] for k, v in state()["sections"].items()}
    for section, text in (overrides or {}).items():
        if section in SECTIONS:
            approved[section] = (text or "").strip()
    return approved


def approved_prompt(overrides: dict | None = None) -> str:
    """승인된 구역(말투 제외)을 앞쪽 요약 블록으로 만든다. overrides={section: text}는 DB를 안 바꾸는 가정값(연결 검사용)."""
    approved = _approved(overrides)
    parts = ["### %s\n%s" % (PROMPT_LABELS[k], approved[k]) for k in SECTIONS if k != "style" and approved.get(k)]
    if not parts:
        return ""
    return "## 나에 대한 통합 요약 (내가 검토·승인한 정리본 — 아래 검색 조각보다 우선)\n" + "\n\n".join(parts)


def approved_style_prompt(overrides: dict | None = None) -> str:
    """말투는 답을 쓰기 직전에 읽히도록 프롬프트 맨 끝에 붙인다 — 맨 앞에 두면 작은 모델이 조건부 높임 규칙을
    놓치고 예시(반말)만 따라 했다(방문자에게 '처음 뵙겠어', 실측)."""
    text = _approved(overrides).get("style", "")
    return ("## 답변 말투 (답하기 전에 마지막으로 확인)\n" + text) if text else ""
