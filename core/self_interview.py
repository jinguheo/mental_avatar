"""자문자답(암묵지) 캡처 — "내 지식 심화형".

아바타가 사용자의 기존 관심사/프로젝트를 바탕으로 "문서엔 안 나오는 판단·기준·예외"를
끌어내는 1인칭 질문을 생성하고, 사용자의 답을 높은 신뢰의 지식(source_type='self_interview')으로
KG에 저장한다. 전적으로 사용자가 원할 때만(질문 받기 버튼) 실행된다 — 자동/주기적 넛지는 없다.

2단계 원칙([[phase_dogfooding_polish]])상 이 지식은 DB 계층(맥락별 검색)이지만,
"내가 실제로 믿는 것"이라 검색 시 문서·대화보다 우선순위를 높여 반영한다(avatar.build_avatar_context).
"""
import random
import uuid

from db.init_db import get_conn
from . import graph, embeddings, pattern, kg_ingest

SOURCE_TYPE = "self_interview"


# ── 질문 생성 ─────────────────────────────────────────
# 다양성 확보: 작은 모델(gemma)은 토픽 여러 개를 주면 한 주제·한 프레임(예: 정확도vs속도)에
# 고착되는 경향이 있다. 그래서 매번 토픽 하나 + 관점(angle) 하나를 무작위로 집어 그 조합으로
# 고정해 질문을 만든다 → 클릭할 때마다 주제·각도가 바뀐다.

QUESTION_ANGLES = [
    "판단 기준 (무엇을 근거로 정하나)",
    "예외 상황 (평소와 다르게 하는 때는 언제인가)",
    "우선순위 트레이드오프 (충돌하면 무엇을 버리나)",
    "실패에서 배운 원칙 (그래서 지금은 어떻게 하나)",
    "남들과 다르게 하는 점 (통념과 어긋나는 나만의 방식)",
    "직관·경험칙 (설명하긴 어렵지만 그냥 아는 것)",
    "처음 하는 사람에게 줄 한마디 조언",
]

QUESTION_PROMPT = """당신은 한 사람("나")의 디지털 아바타를 완성하기 위해, 그 사람의 머릿속에만 있는
암묵지(판단 기준·의견·경험에서 나온 원칙)를 끌어내는 인터뷰어입니다.

주제: {topic}
이번에 물어볼 관점: {angle}

위 '주제'에 대해, 문서나 코드에는 안 드러나는 그 사람의 생각을 '{angle}' 관점에서 끌어내는
질문을 딱 한 개만 만들어 주세요.

규칙:
- 사실 확인("무엇인가?")이 아니라 판단·경험을 묻는 질문일 것.
- 반드시 위 '주제'와 '관점'에 맞출 것 (다른 주제로 새지 말 것).
- 이미 물어본 질문과 겹치지 않게.
- 그 사람에게 직접 말하듯 한국어 한 문장. 설명·번호·따옴표 없이 질문만 출력.
{asked_block}
질문:"""


def _topic_candidates(limit: int = 10) -> list[str]:
    """core_interests + 프로젝트명 + 최근 노트 제목을 후보 토픽으로 모은다."""
    cands: list[str] = []
    seen: set[str] = set()

    def _add(name: str):
        n = (name or "").strip()
        key = n.lower()
        if n and key not in seen:
            seen.add(key)
            cands.append(n)

    try:
        for i in pattern.core_interests(8):
            _add(i.get("topic", ""))
    except Exception:
        pass

    try:
        conn = get_conn()
        for r in conn.execute(
            "SELECT name FROM project_summaries WHERE status='done' ORDER BY updated_at DESC LIMIT 8"
        ).fetchall():
            _add(r["name"])
        for r in conn.execute(
            "SELECT title FROM nodes WHERE source_type='note' ORDER BY created_at DESC LIMIT 8"
        ).fetchall():
            _add(r["title"])
        conn.close()
    except Exception:
        pass

    return cands[:limit]


def _recent_questions(limit: int = 20) -> list[str]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT question FROM self_interview ORDER BY created_at DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [r["question"] for r in rows]


def generate_question() -> dict:
    """다음 자문자답 질문 하나를 생성한다. {question, topic, angle} 반환.

    다양성 확보: 후보 토픽 하나 + 관점(angle) 하나를 무작위로 골라 그 조합으로 고정한다.
    (모든 토픽을 한꺼번에 주면 작은 모델이 한 주제·한 프레임에 고착되는 문제를 피함.)
    """
    topics = _topic_candidates()
    if not topics:
        return {
            "question": "요즘 어떤 일을 할 때, 남들과 다르게 판단하거나 결정하는 나만의 기준이 있나요?",
            "fallback": True,
        }

    topic = random.choice(topics)
    angle = random.choice(QUESTION_ANGLES)

    asked = _recent_questions()
    asked_block = ""
    if asked:
        asked_block = "\n이미 물어본 질문(겹치지 말 것):\n" + "\n".join(f"- {q}" for q in asked[:12]) + "\n"

    prompt = QUESTION_PROMPT.format(topic=topic, angle=angle, asked_block=asked_block)
    try:
        raw = pattern._llm_call(prompt).strip()
    except Exception as e:
        return {"question": f"'{topic}'에 대해, 문서엔 안 적어둔 나만의 판단 기준이 있다면 무엇인가요?",
                "topic": topic, "angle": angle, "error": str(e), "fallback": True}

    # LLM이 앞에 "질문:" 등 군더더기를 붙이면 첫 줄(한 문장)만 취한다.
    q = raw.splitlines()[0].strip() if raw else ""
    q = q.lstrip("-•* ").removeprefix("질문:").strip().strip('"').strip()
    if not q:
        q = f"'{topic}'에 대해, 문서엔 안 적어둔 나만의 판단 기준이 있다면 무엇인가요?"
    return {"question": q, "topic": topic, "angle": angle}


# ── 답변 저장 ─────────────────────────────────────────

def save_answer(question: str, answer: str, topic: str = "") -> dict:
    """질문+답을 self_interview 테이블 + KG 노드(source_type='self_interview') + 임베딩으로 저장.

    답변 본문에서 엔티티/관계도 추출해 그래프에 연결한다(암묵지가 기존 개념들과 이어지도록).
    KG 노드 content는 '질문 → 답' 형태의 1인칭 지식으로 만든다.
    """
    question = (question or "").strip()
    answer = (answer or "").strip()
    if not question or not answer:
        raise ValueError("question and answer required")

    sid = uuid.uuid4().hex
    title = question if len(question) <= 60 else question[:57] + "…"
    # 1인칭 지식 형태로 저장 — 검색에 걸렸을 때 "내 생각"으로 읽히도록 질문을 맥락으로 포함
    content = f"Q: {question}\nA(나의 답): {answer}"

    node_id = graph.add_node(
        type=SOURCE_TYPE, title=title, content=content,
        source_type=SOURCE_TYPE, file_path=f"self_interview://{sid}",
        importance=0.85,  # 1인칭·높은 신뢰 → 검색/랭킹에서 우대
    )
    embeddings.add_document(node_id, title, content, {"source_type": SOURCE_TYPE})

    # 답변에서 엔티티/관계 추출해 그래프에 연결 (내용이 충분할 때만)
    if len(answer) > 60:
        try:
            kg_ingest._extract_into_graph(node_id, title, answer)
        except Exception as ex:
            print(f"[self_interview] 추출 경고(무시): {ex}")

    conn = get_conn()
    # 추출 단계(update_importance)가 importance를 흔들 수 있어 1인칭·높은 신뢰로 고정.
    conn.execute("UPDATE nodes SET importance=0.85 WHERE id=?", (node_id,))
    conn.execute(
        "INSERT INTO self_interview (id, question, answer, topic, node_id) VALUES (?,?,?,?,?)",
        (sid, question, answer, topic.strip(), node_id),
    )
    conn.commit()
    conn.close()
    graph.log_activity(node_id, "created", "self_interview 답변 저장")
    return {"id": sid, "node_id": node_id}


# ── 목록/삭제 ─────────────────────────────────────────

def list_interviews(limit: int = 100) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, question, answer, topic, created_at FROM self_interview ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_interview(sid: str) -> None:
    conn = get_conn()
    row = conn.execute("SELECT node_id FROM self_interview WHERE id=?", (sid,)).fetchone()
    node_id = row["node_id"] if row else None
    conn.execute("DELETE FROM self_interview WHERE id=?", (sid,))
    if node_id:
        conn.execute("DELETE FROM nodes WHERE id=?", (node_id,))
    conn.commit()
    conn.close()
    if node_id:
        try:
            embeddings.delete_document(node_id)
        except Exception:
            pass


def count() -> int:
    conn = get_conn()
    n = conn.execute("SELECT COUNT(*) c FROM self_interview").fetchone()["c"]
    conn.close()
    return n
