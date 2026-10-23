"""이전 기록으로 입력칸 초안 만들기.

사용자가 매번 처음부터 쓰지 않도록, 지금까지 내가 직접 쓴 글(Claude Code·Codex 대화, 이전 인터뷰 답)에서
칸의 주제와 관련 있는 것을 찾아 그 근거만으로 초안을 만든다. 저장은 하지 않는다 — 초안은 내가 읽고 고친 뒤
저장 버튼을 눌러야 반영된다(모델이 지어낸 내용이 '내 기준'으로 굳는 것을 막기 위해).

종류:
- criterion / interview : 근거 글을 바탕으로 1인칭 초안 한 단락(LLM). 근거가 부족하면 만들지 않는다.
- memory : 핵심 기억 후보(내가 한 기준·사실·목표 문장) — LLM 없이 근거 문장 그대로.
- case   : 비교 질문 후보 — 직전에 Claude가 물은 질문과 내가 실제로 한 답 짝(판단 사례).
"""
import json
import re
import time
import urllib.request

from db.init_db import get_conn
from . import pattern, transcript_ingest as ti

KEEP = ("기준", "사실", "목표", "결정", "기준(직접)")
SKIP = ("붙여넣기", "로그", "잡담", "지시", "반응", "질문")
MODEL = "gemma4:e2b"
_cache: dict = {"at": 0.0, "rows": []}

DRAFT_PROMPT = """아래는 내가 과거에 직접 쓴 글이다. 이 글에 있는 내용만 근거로, 아래 칸에 내가 쓸 법한 초안을 써라.

칸: {slot}

내가 쓴 글:
{evidence}

규칙:
- 칸의 주제와 관련 없는 글은 무시해라. 관련 있는 글이 없으면 "없음"만 써라.
- 질문이 특정 경험·실패·선택을 묻는다면 그 경험·실패·선택이 글에 직접 나와야 한다. 일반적인 작업 내용으로 대신 답하지 마라.
- 두 선택지의 우선순위를 묻는 질문은 글에 비교하거나 선택한 표현이 직접 없으면 "없음"만 써라.
- 위 글에 없는 내용은 지어내지 마라. 근거가 부족하면 한 단어 "없음"만 써라.
- 1인칭으로, 내가 쓴 표현과 어투를 살려 2~4문장으로 써라. 칸 이름이나 머리말 없이 초안 본문만 써라.
초안:"""


def _rows() -> list[dict]:
    """대화에서 내가 쓴 글 후보. 분류가 끝난 것은 기준·사실·목표·결정만, 아직 안 된 것은 어투가 뚜렷한 것만 쓴다."""
    if time.time() - _cache["at"] < 60 and _cache["rows"]:
        return _cache["rows"]
    conn = get_conn()
    ti._init(conn)
    out = []
    for r in conn.execute("SELECT key, created_at, text, label, source, project FROM transcript_ingested "
                          "WHERE length(text) BETWEEN 15 AND 400"):
        label = r["label"]
        if label in SKIP:
            continue
        if label is None and not ti.STANCE.search(r["text"]):
            continue
        if ti.COMMAND_END.search(r["text"].strip()):
            continue
        out.append(dict(r))
    for r in conn.execute("SELECT created_at, question, answer FROM self_interview WHERE answer IS NOT NULL AND length(answer) > 15"):
        out.append({"key": "interview", "created_at": r["created_at"], "text": r["answer"][:400], "label": "인터뷰 답", "source": "interview", "project": r["question"][:30]})
    conn.close()
    _cache.update(at=time.time(), rows=out)
    return out


def _grams(text: str) -> set[str]:
    t = re.sub(r"[^\w가-힣]+", "", text.lower())
    return {t[i:i + 2] for i in range(len(t) - 1)}


FAILURE_CUES = re.compile(r"(실패|오류|문제|안\s*되|못\s*하|어려|잘못|틀렸|고장|한계)")
TRADEOFF_QUESTION = re.compile(r"(중\s*하나|포기|우선|선택|대신|트레이드오프|trade.?off)")
EXPLICIT_CHOICE = re.compile(r"(보다|우선|대신|포기|선택|비교|차라리|더\s*중요|trade.?off)")


def evidence(query: str, k: int = 6, same_project: bool = False, require_failure: bool = False) -> list[dict]:
    q = _grams(query)
    if not q:
        return []
    scored = []
    for r in _rows():
        if require_failure and not FAILURE_CUES.search(r["text"]):
            continue
        g = _grams(r["text"])
        if not g:
            continue
        overlap = len(q & g)
        if overlap < 3:
            continue
        score = overlap / (len(q) ** 0.5 * len(g) ** 0.5)
        if score < 0.1:
            continue
        if r["label"] in KEEP or r["label"] == "인터뷰 답":
            score *= 1.6
        scored.append((score, r))
    scored.sort(key=lambda x: -x[0])
    seen, picked = set(), []
    project = None
    for _, r in scored:
        if same_project:
            project = project or r["project"]
            if r["project"] != project:
                continue
        norm = re.sub(r"\s+", " ", r["text"].strip())
        if norm in seen:
            continue
        seen.add(norm)
        picked.append({"text": r["text"], "date": (r["created_at"] or "")[:10], "source": r["source"], "label": r["label"], "project": r["project"]})
        if len(picked) >= k:
            break
    return picked


def _llm(prompt: str) -> str:
    payload = json.dumps({"model": MODEL, "stream": False, "think": False,
                          "messages": [{"role": "user", "content": prompt}],
                          "options": {"temperature": 0.2, "num_predict": 260}}).encode()
    req = urllib.request.Request(pattern.OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())["message"]["content"].strip()


def draft_text(slot: str, query: str, topic_only: bool = False) -> dict:
    if topic_only and not query.strip():
        return {"draft": "", "evidence": [], "message": "인터뷰 주제를 먼저 정해야 이전 기록에서 관련 근거를 찾을 수 있습니다."}
    ev = evidence(query if topic_only else query + " " + slot,
                  same_project=topic_only,
                  require_failure=topic_only and bool(FAILURE_CUES.search(slot)))
    if topic_only and TRADEOFF_QUESTION.search(slot) and not any(EXPLICIT_CHOICE.search(e["text"]) for e in ev):
        return {"draft": "", "evidence": ev, "message": "이 선택에 대한 직접적인 이전 답이 없어 초안을 만들지 못했습니다."}
    if len(ev) < 2:
        return {"draft": "", "evidence": ev, "message": "관련된 이전 기록이 부족해서 초안을 만들지 못했습니다."}
    block = "\n".join("- " + e["text"].replace("\n", " ") for e in ev)
    out = _llm(DRAFT_PROMPT.format(slot=slot, evidence=block)).strip().strip('"')
    out = re.sub(r"^(초안\s*[:：]\s*)", "", out)
    out = re.sub(r"^" + re.escape(slot.strip()) + r"\s*\n+", "", out)   # 모델이 칸 이름을 머리말로 붙이면 뗀다
    if not out or out.startswith("없음"):
        return {"draft": "", "evidence": ev, "message": "근거가 부족해서 초안을 만들지 못했습니다."}
    return {"draft": out, "evidence": ev, "message": "이전 기록으로 만든 초안입니다. 읽어 보고 고친 뒤 저장하세요."}


QUESTIONISH = re.compile(r"(\?|？|뭐야|뭔가|어떻게|인가요|할까|있어\s*$|없어\s*$|줘\s*$|해\s*$)")
DIRECTIVE = re.compile(r"(해\s*줘|해주세요|보여\s*줘|알려\s*줘|기록하고\s*$|메모리에\s*기록|추가해|만들어\s*줘|수정해|진행해|찾아\s*줘)")
SELF_REFERENCE = re.compile(r"(?<![가-힣])(나는|내가|나의|내\s*(?:일|회사|프로젝트|기준|원칙|선호|경험|전문|목표)|우리\s*(?:회사|팀))")


# 상시 기억 후보의 "오래 갈 진술" 표지와 "그때만의 작업" 표지. 점수로만 쓰고 최종 판단은 사용자가 한다.
DURABLE = re.compile(r"(항상|늘\s|절대|반드시|원칙|기본적으로|선호|방향이\s*좋|좋겠|싫어|좋아해|하지\s*않아|안\s*써|사용하지|사용해\s*[.!]?$|"
                     r"우선|중요해|가치|신념|철학|습관|성격)")
TRANSIENT = re.compile(r"(이번|오늘|지금|현재|다음에|내일|방금|탭|버튼|화면|커밋|푸시|평가|진행|작업|세션|창에서|파일|폴더|코드|서버)")
PROBLEM = re.compile(r"(갑자기|에러|오류|안\s*돼|안\s*되|안\s*나와|깨져|멈춰|느려|이상해|틀렸)")
QUESTION_END = re.compile(r"[?？]\s*$")
TASK_END = re.compile(r"(줘|주고|주세요|주면\s*되|해\s*둬|해\s*봐|진행해|커밋해|푸시해)[.!\s]*$")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def _dismissed(conn) -> set[str]:
    conn.execute("CREATE TABLE IF NOT EXISTS memory_candidate_dismissed (text TEXT PRIMARY KEY, "
                 "dismissed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))")
    return {r[0] for r in conn.execute("SELECT text FROM memory_candidate_dismissed")}


def dismiss_memory_candidate(text: str) -> dict:
    """후보에서 뺀 진술은 다시 제안하지 않는다(원문 기록과 KG에는 그대로 남는다)."""
    norm = _norm(text)
    if not norm:
        raise ValueError("text required")
    conn = get_conn()
    _dismissed(conn)
    conn.execute("INSERT OR IGNORE INTO memory_candidate_dismissed (text) VALUES (?)", (norm,))
    conn.commit()
    conn.close()
    return {"dismissed": norm}


def _durability(text: str, label: str) -> tuple[int, list[str]]:
    score, why = 0, []
    if label == "기준(직접)":
        score += 3; why.append("직접 고른 기준")
    elif label == "기준":
        score += 1
    if DURABLE.search(text):
        score += 2; why.append("오래 갈 표현")
    if SELF_REFERENCE.search(text):
        score += 1; why.append("나에 대한 진술")
    if PROBLEM.search(text):
        score -= 3; why.append("문제 보고")
    transient = len(set(TRANSIENT.findall(text)))
    if transient:
        score -= min(transient, 2) * 2; why.append("작업·시점 표현 있음")
    return score, why


def memory_candidates(limit: int = 8) -> dict:
    """상시 기억 후보: 대화 기록에서 기준·사실로 분류된 내 진술 중 오래 갈 것을 고른다.
    이미 저장했거나 후보에서 뺀 진술, 물음표로 끝나는 질문, 작업 요청은 제외한다. 저장은 사용자가 고른 것만 한다."""
    conn = get_conn()
    ti._init(conn)
    have = {_norm(r[0]) for r in conn.execute("SELECT content FROM core_memory")} if _has(conn, "core_memory") else set()
    dismissed = _dismissed(conn)
    conn.commit()
    rows = [dict(r) for r in conn.execute(
        "SELECT key, created_at, text, label, source, project FROM transcript_ingested "
        "WHERE kept=1 AND label IN ('기준(직접)','기준','사실') AND length(text) BETWEEN 12 AND 300 "
        "ORDER BY created_at DESC LIMIT 2000")]
    conn.close()
    scored, seen = [], set()
    for r in rows:
        norm = _norm(r["text"])
        if norm in have or norm in dismissed or norm in seen:
            continue
        if QUESTION_END.search(norm) or TASK_END.search(norm) or DIRECTIVE.search(norm):
            continue
        score, why = _durability(norm, r["label"])
        if score < 2:
            continue
        seen.add(norm)
        scored.append((score, r["created_at"] or "", {"text": norm, "key": r["key"], "date": (r["created_at"] or "")[:10], "source": r["source"],
                                                      "label": r["label"], "project": r["project"], "why": why}))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    items = [x[2] for x in scored[:limit]]
    msg = (f"대화 기록에서 오래 갈 만한 내 진술 {len(scored)}개 중 상위 {len(items)}개입니다. 지금도 맞는지 확인하고 저장하거나 빼세요."
           if items else "상시 기억으로 올릴 만한 후보가 없습니다.")
    return {"candidates": items, "message": msg, "total": len(scored)}


def case_candidates(limit: int = 5) -> dict:
    """비교 질문 후보: Claude가 물은 질문(맥락의 마지막 질문)과 내가 실제로 한 답."""
    conn = get_conn()
    ti._init(conn)
    rows = [dict(r) for r in conn.execute(
        "SELECT created_at, context, reply, label, project FROM decision_pairs WHERE length(context) > 0 AND length(reply) BETWEEN 15 AND 400 "
        "AND (label IN ('기준','사실','목표','결정','기준(직접)') OR label IS NULL) ORDER BY created_at DESC LIMIT 600")]
    conn.close()
    items = []
    for r in rows:
        if QUESTIONISH.search(r["reply"].strip()) or ti.COMMAND_END.search(r["reply"].strip()):
            continue
        if r["label"] is None and not ti.STANCE.search(r["reply"]):
            continue
        questions = [s.strip() for s in re.split(r"(?<=[?？])\s+|\n+", r["context"]) if s.strip().endswith(("?", "？"))]
        if not questions:
            continue
        question = questions[-1][-200:]
        shared = _grams(question) & _grams(r["reply"])
        relevance = len(shared) / (len(_grams(question)) ** 0.5 * len(_grams(r["reply"])) ** 0.5)
        if len(shared) < 4 or relevance < 0.13:
            continue
        if question.count("?") + question.count("？") > 2:
            continue
        if any(i["question"] == question for i in items):
            continue   # 같은 질문에 이어 보낸 여러 메시지는 한 번만
        items.append({"question": question, "expected": r["reply"], "date": (r["created_at"] or "")[:10], "project": r["project"]})
        if len(items) >= limit:
            break
    return {"candidates": items, "message": "질문과 답의 관련성은 자동 추정입니다. 실제로 같은 상황의 답인지 확인하세요." if items else "관련성이 확인된 질문·답 기록이 아직 없습니다."}


def draft(kind: str, query: str = "", slot: str = "") -> dict:
    if kind in ("criterion", "interview"):
        return draft_text(slot or query, query, topic_only=(kind == "interview"))
    if kind == "memory":
        return memory_candidates()
    if kind == "case":
        return case_candidates()
    raise ValueError("kind는 criterion/interview/memory/case 중 하나여야 합니다")


def _has(conn, table: str) -> bool:
    return bool(conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone())
