"""Owner-reviewed rules and comparison cases for the digital avatar."""
import uuid

from db.init_db import get_conn

SECTIONS = ("judgment", "memory", "authority", "verification", "identity")


def _init(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS avatar_governance (
        section TEXT PRIMARY KEY,
        draft TEXT NOT NULL DEFAULT '',
        approved TEXT NOT NULL DEFAULT '',
        updated_at TEXT,
        approved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS avatar_conversation_corrections (
        conversation_id TEXT PRIMARY KEY,
        corrected_text TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS avatar_evaluations (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        expected TEXT NOT NULL,
        observed TEXT NOT NULL DEFAULT '',
        result TEXT NOT NULL DEFAULT 'pending',
        notes TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    """)


def state():
    conn = get_conn()
    _init(conn)
    rows = conn.execute("SELECT * FROM avatar_governance").fetchall()
    cases = conn.execute(
        "SELECT * FROM avatar_evaluations ORDER BY updated_at DESC LIMIT 100"
    ).fetchall()
    conn.close()
    by_section = {row["section"]: dict(row) for row in rows}
    return {
        "sections": {
            key: by_section.get(key, {
                "section": key, "draft": "", "approved": "",
                "updated_at": None, "approved_at": None
            })
            for key in SECTIONS
        },
        "evaluations": [dict(row) for row in cases],
    }


def save_draft(section, text):
    if section not in SECTIONS:
        raise ValueError("unknown section")
    if not isinstance(text, str) or len(text) > 10000:
        raise ValueError("text must be at most 10000 characters")
    conn = get_conn()
    _init(conn)
    conn.execute(
        """INSERT INTO avatar_governance(section,draft,approved,updated_at,approved_at)
           VALUES (?, ?, ?, datetime('now','localtime'), datetime('now','localtime'))
           ON CONFLICT(section) DO UPDATE SET
             draft=excluded.draft, approved=excluded.approved,
             updated_at=excluded.updated_at, approved_at=excluded.approved_at""",
        (section, text.strip(), text.strip()),
    )
    conn.commit()
    conn.close()
    return state()["sections"][section]


def save_evaluation(data):
    question = str(data.get("question", "")).strip()
    expected = str(data.get("expected", "")).strip()
    observed = str(data.get("observed", "")).strip()
    notes = str(data.get("notes", "")).strip()
    result = str(data.get("result", "pending"))
    if not question or not expected:
        raise ValueError("question and expected answer are required")
    if result not in ("pending", "pass", "fail"):
        raise ValueError("invalid result")
    if any(len(value) > 5000 for value in (question, expected, observed, notes)):
        raise ValueError("field exceeds 5000 characters")
    case_id = str(data.get("id") or uuid.uuid4().hex)
    conn = get_conn()
    _init(conn)
    conn.execute(
        """INSERT INTO avatar_evaluations(id,question,expected,observed,result,notes)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET question=excluded.question,
             expected=excluded.expected, observed=excluded.observed,
             result=excluded.result, notes=excluded.notes,
             updated_at=datetime('now','localtime')""",
        (case_id, question, expected, observed, result, notes),
    )
    conn.commit()
    conn.close()
    return {"id": case_id}


def delete_evaluation(case_id):
    conn = get_conn()
    _init(conn)
    conn.execute("DELETE FROM avatar_evaluations WHERE id=?", (case_id,))
    conn.commit()
    conn.close()




def conversation_candidates(limit=20):
    conn = get_conn()
    _init(conn)
    rows = conn.execute(
        """SELECT c.id, c.content, c.created_at, c.view,
                  n.id AS node_id, COALESCE(k.corrected_text, '') AS corrected_text
           FROM conversations c
           LEFT JOIN nodes n ON n.file_path='conversation://' || c.view || '/' || c.id
           LEFT JOIN avatar_conversation_corrections k ON k.conversation_id=c.id
           WHERE c.role='user'
           ORDER BY c.created_at DESC LIMIT ?""",
        (max(1, min(int(limit), 50)),),
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def correct_conversation(conversation_id, corrected_text):
    from core import embeddings

    if not isinstance(corrected_text, str) or len(corrected_text) > 5000:
        raise ValueError("correction must be at most 5000 characters")
    conn = get_conn()
    _init(conn)
    row = conn.execute(
        """SELECT c.content, n.id AS node_id, n.title
           FROM conversations c
           JOIN nodes n ON n.file_path='conversation://' || c.view || '/' || c.id
           WHERE c.id=? AND c.role='user'""",
        (conversation_id,),
    ).fetchone()
    if not row:
        conn.close()
        raise ValueError("synced user conversation not found")
    corrected = corrected_text.strip()
    content = corrected or row["content"]
    conn.execute(
        "UPDATE nodes SET content=?, updated_at=datetime('now','localtime') WHERE id=?",
        (content, row["node_id"]),
    )
    if corrected:
        conn.execute(
            """INSERT INTO avatar_conversation_corrections(conversation_id,corrected_text)
               VALUES (?,?)
               ON CONFLICT(conversation_id) DO UPDATE SET
                 corrected_text=excluded.corrected_text,
                 updated_at=datetime('now','localtime')""",
            (conversation_id, corrected),
        )
    else:
        conn.execute(
            "DELETE FROM avatar_conversation_corrections WHERE conversation_id=?",
            (conversation_id,),
        )
    conn.commit()
    conn.close()
    embeddings.add_document(
        row["node_id"], row["title"], content,
        {"source_type": "conversation", "role": "user"},
    )
    return {"success": True, "corrected_text": corrected}


def approved_prompt(overrides=None):
    """overrides={section: text}를 주면 DB는 건드리지 않고 그 구간만 가정값으로 바꿔 프롬프트를 만든다
    (연결 검사용 what-if — 빈 문자열이면 그 구간을 없는 것으로 취급)."""
    conn = get_conn()
    _init(conn)
    rows = conn.execute(
        "SELECT section, approved FROM avatar_governance WHERE approved <> ''"
    ).fetchall()
    conn.close()
    if overrides:
        merged = {row["section"]: row["approved"] for row in rows}
        for section, text in overrides.items():
            if section in SECTIONS:
                merged[section] = (text or "").strip()
        rows = [{"section": s, "approved": t} for s, t in merged.items() if t]
    labels = {
        "judgment": "내가 정한 판단 기준",
        "memory": "내가 정한 기억 갱신 기준",
        "authority": "내가 정한 행동 권한",
        "verification": "내가 정한 검증 기준",
        "identity": "내가 정한 신원·안전 기준",
    }
    return "\n\n".join(
        f"## {labels[row['section']]}\n{row['approved']}"
        for row in rows if row["section"] in labels
    )
