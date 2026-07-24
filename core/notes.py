"""아바타 AI 대화 중 자동 노트 생성 — my-dashboard의 노트 기능과는 별개로 동작한다.

사용자-아바타 한 턴(사용자 질문 + 아바타 답)마다 LLM에게 "따로 적어둘 만한 내용이 있는가"를
판단시키고, 있으면 짧은 제목+본문으로 정리해 avatar_notes 테이블과 KG 노드(source_type='note',
file_path=avatar_note://...)로 함께 저장한다. 잡담·인사 등은 LLM이 NONE으로 걸러 노트가 쌓이지 않는다.
"""
import json
import re
import uuid

from db.init_db import get_conn
from . import graph, embeddings, pattern, kg_ingest

SOURCE_TYPE = "note"

# 너무 짧은 잡담(인사 등)은 LLM 호출 없이 바로 건너뛴다.
MIN_EXCHANGE_LEN = 25

NOTE_PROMPT = """다음은 사용자와 그 사람의 디지털 아바타 사이의 대화 한 턴입니다.

사용자: {user_msg}
아바타: {assistant_msg}

이 대화에 나중에 다시 찾아볼 만한 내용(결정한 것, 새로 안 사실, 할 일, 아이디어, 중요한 의견 등)이
있으면 짧은 제목과 한두 문장 요약을 JSON으로 만들어 주세요: {{"title": "...", "note": "..."}}
단순 인사·잡담·감탄사처럼 다시 찾아볼 필요가 없으면 다른 말 없이 정확히 NONE 이라고만 답하세요.

응답:"""


def _parse_note_response(raw: str) -> dict | None:
    raw = (raw or "").strip()
    if not raw or raw.upper().startswith("NONE"):
        return None
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except Exception:
        return None
    title = (data.get("title") or "").strip()
    note = (data.get("note") or "").strip()
    if not note:
        return None
    if not title:
        title = note[:40] + ("…" if len(note) > 40 else "")
    return {"title": title, "note": note}


def maybe_create_note(view: str, user_msg: str, assistant_msg: str) -> dict | None:
    """대화 한 턴을 판단해 노트가 될 만하면 생성한다. 아니면 None."""
    user_msg = (user_msg or "").strip()
    assistant_msg = (assistant_msg or "").strip()
    if len(user_msg) + len(assistant_msg) < MIN_EXCHANGE_LEN:
        return None

    try:
        raw = pattern._llm_call(NOTE_PROMPT.format(user_msg=user_msg[:800], assistant_msg=assistant_msg[:800]))
    except Exception as e:
        print(f"[notes] LLM 호출 실패(무시): {e}")
        return None

    parsed = _parse_note_response(raw)
    if not parsed:
        return None

    nid = uuid.uuid4().hex
    title, content = parsed["title"], parsed["note"]

    node_id = graph.add_node(
        type="note", title=title, content=content,
        source_type=SOURCE_TYPE, file_path=f"avatar_note://{view}/{nid}",
        importance=0.6,
    )
    embeddings.add_document(node_id, title, content, {"source_type": SOURCE_TYPE, "view": view})

    if len(content) > 40:
        try:
            kg_ingest._extract_into_graph(node_id, title, content)
        except Exception as ex:
            print(f"[notes] 추출 경고(무시): {ex}")

    conn = get_conn()
    conn.execute(
        "INSERT INTO avatar_notes (id, view, title, content, node_id) VALUES (?,?,?,?,?)",
        (nid, view, title, content, node_id),
    )
    conn.commit()
    conn.close()
    graph.log_activity(node_id, "created", "아바타 대화 자동 노트")
    return {"id": nid, "view": view, "title": title, "content": content, "node_id": node_id}


def list_notes(query: str = "", view: str = "", limit: int = 50) -> list[dict]:
    conn = get_conn()
    where, params = [], []
    if query:
        where.append("(title LIKE ? OR content LIKE ?)")
        params += [f"%{query}%", f"%{query}%"]
    if view:
        where.append("view = ?")
        params.append(view)
    sql = "SELECT id, view, title, content, node_id, created_at FROM avatar_notes"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_note(nid: str) -> None:
    conn = get_conn()
    row = conn.execute("SELECT node_id FROM avatar_notes WHERE id=?", (nid,)).fetchone()
    node_id = row["node_id"] if row else None
    conn.execute("DELETE FROM avatar_notes WHERE id=?", (nid,))
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
    n = conn.execute("SELECT COUNT(*) c FROM avatar_notes").fetchone()["c"]
    conn.close()
    return n
