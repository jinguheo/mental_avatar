"""자문자답(암묵지) 캡처 — "내 지식 심화형".

아바타가 사용자의 기존 관심사/프로젝트를 바탕으로 "문서엔 안 나오는 판단·기준·예외"를
끌어내는 1인칭 질문을 생성하고, 사용자의 답을 높은 신뢰의 지식(source_type='self_interview')으로
KG에 저장한다. 전적으로 사용자가 원할 때만(질문 받기 버튼) 실행된다 — 자동/주기적 넛지는 없다.

2단계 원칙([[phase_dogfooding_polish]])상 이 지식은 DB 계층(맥락별 검색)이지만,
"내가 실제로 믿는 것"이라 검색 시 문서·대화보다 우선순위를 높여 반영한다(avatar.build_avatar_context).
"""
import uuid

from db.init_db import get_conn
from . import graph, embeddings, pattern, kg_ingest

SOURCE_TYPE = "self_interview"


# ── 질문 생성 ─────────────────────────────────────────

QUESTION_PROMPT = """당신은 한 사람("나")의 디지털 아바타를 완성하기 위해, 그 사람의 머릿속에만 있는
암묵지(판단 기준·의견·경험에서 나온 원칙·"이 상황이면 이렇게 한다")를 끌어내는 인터뷰어입니다.

아래는 이 사람이 실제로 다뤄온 관심사와 프로젝트입니다:
{topics}

{asked_block}

위 관심사/프로젝트 중 하나를 골라, 문서나 코드에는 드러나지 않는 그 사람의 *판단·기준·예외·경험칙*을
끌어내는 질문을 딱 한 개만 만들어 주세요.

규칙:
- 사실 확인(무엇인가?)이 아니라 판단을 묻는 질문 ("왜 그 방식을? 언제는 안 쓰나? 무엇을 우선하나? 어떻게 결정하나?").
- 이미 물어본 질문과 겹치지 않게.
- 그 사람에게 직접 말하듯 한국어 한 문장. 다른 설명·번호·따옴표 없이 질문만 출력.

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
    """다음 자문자답 질문 하나를 생성한다. {question, topics_used} 반환."""
    topics = _topic_candidates()
    if not topics:
        return {
            "question": "요즘 어떤 일을 할 때, 남들과 다르게 판단하거나 결정하는 나만의 기준이 있나요?",
            "fallback": True,
        }

    asked = _recent_questions()
    asked_block = ""
    if asked:
        asked_block = "이미 물어본 질문(겹치지 말 것):\n" + "\n".join(f"- {q}" for q in asked[:12])

    prompt = QUESTION_PROMPT.format(
        topics="\n".join(f"- {t}" for t in topics),
        asked_block=asked_block,
    )
    try:
        raw = pattern._llm_call(prompt).strip()
    except Exception as e:
        return {"question": f"'{topics[0]}'에 대해, 문서엔 안 적어둔 나만의 판단 기준이 있다면 무엇인가요?",
                "error": str(e), "fallback": True}

    # LLM이 앞에 "질문:" 등 군더더기를 붙이면 첫 물음표까지의 한 문장만 취한다.
    q = raw.splitlines()[0].strip() if raw else ""
    q = q.lstrip("-•* ").removeprefix("질문:").strip().strip('"').strip()
    if not q:
        q = f"'{topics[0]}'에 대해, 문서엔 안 적어둔 나만의 판단 기준이 있다면 무엇인가요?"
    return {"question": q, "topics_used": topics}


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
