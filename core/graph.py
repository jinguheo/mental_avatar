"""KG 관리 — SQLite CRUD + NetworkX 분석"""
import re
import uuid
import sqlite3
from datetime import datetime
from typing import Optional
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from db.init_db import get_conn


def _uid() -> str:
    return str(uuid.uuid4())


def normalize_entity_name(name: str) -> str:
    """엔티티명 표기를 정규화한다.

    `한글(English)` / `한글 (English)` 처럼 괄호 앞뒤 공백·중복 공백 차이만으로
    같은 개념이 별도 노드로 파편화되는 걸 막는다(표기 통일: 괄호 앞 공백 1칸).
    """
    n = (name or "").strip()
    n = re.sub(r"\s*\(\s*", " (", n)   # "X(Y" / "X ( Y" → "X (Y"
    n = re.sub(r"\s*\)", ")", n)        # "Y )" → "Y)"
    n = re.sub(r"\s+", " ", n)          # 중복 공백 → 1칸
    return n.strip()


# ── 노드 ──────────────────────────────────────────────

def add_node(type: str, title: str, content: str,
             source_type: str = "", file_path: str = "",
             file_hash: str = "", chunk_index: int = 0,
             importance: float = 0.5) -> str:
    conn = get_conn()
    # 같은 file_hash + chunk_index면 기존 노드 반환 (중복 방지)
    if file_hash:
        row = conn.execute(
            "SELECT id FROM nodes WHERE file_hash=? AND chunk_index=?",
            (file_hash, chunk_index)
        ).fetchone()
        if row:
            conn.close()
            return row["id"]
    node_id = _uid()
    conn.execute(
        "INSERT INTO nodes (id,type,title,content,source_type,file_path,file_hash,chunk_index,importance) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (node_id, type, title, content, source_type, file_path, file_hash, chunk_index, importance)
    )
    conn.commit()
    conn.close()
    return node_id


def get_node(node_id: str) -> Optional[dict]:
    conn = get_conn()
    row = conn.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def update_importance(node_id: str, delta: float = 0.05):
    conn = get_conn()
    conn.execute(
        "UPDATE nodes SET importance = MIN(1.0, importance + ?), updated_at = datetime('now','localtime') WHERE id=?",
        (delta, node_id)
    )
    conn.commit()
    conn.close()


def search_nodes(query: str, limit: int = 20) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM nodes WHERE title LIKE ? OR content LIKE ? ORDER BY importance DESC, created_at DESC LIMIT ?",
        (f"%{query}%", f"%{query}%", limit)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def list_nodes(source_type: str = "", limit: int = 50) -> list[dict]:
    conn = get_conn()
    if source_type:
        rows = conn.execute(
            "SELECT * FROM nodes WHERE source_type=? ORDER BY created_at DESC LIMIT ?",
            (source_type, limit)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM nodes ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── 엣지 ──────────────────────────────────────────────

def add_edge(from_id: str, to_id: str, relation: str, weight: float = 1.0) -> str:
    edge_id = _uid()
    conn = get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO edges (id,from_id,to_id,relation,weight) VALUES (?,?,?,?,?)",
        (edge_id, from_id, to_id, relation, weight)
    )
    conn.commit()
    conn.close()
    return edge_id


def get_neighbors(node_id: str) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT e.relation, e.weight,
                  n.id, n.title, n.type, n.source_type
           FROM edges e
           JOIN nodes n ON (e.to_id = n.id OR e.from_id = n.id)
           WHERE (e.from_id=? OR e.to_id=?) AND n.id != ?
           ORDER BY e.weight DESC""",
        (node_id, node_id, node_id)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── 토픽 ──────────────────────────────────────────────

def upsert_topic(name: str, description: str = "") -> str:
    conn = get_conn()
    row = conn.execute("SELECT id FROM topics WHERE name=?", (name,)).fetchone()
    if row:
        topic_id = row["id"]
        conn.execute(
            "UPDATE topics SET updated_at=datetime('now','localtime') WHERE id=?", (topic_id,)
        )
    else:
        topic_id = _uid()
        conn.execute(
            "INSERT INTO topics (id,name,description) VALUES (?,?,?)",
            (topic_id, name, description)
        )
    conn.commit()
    conn.close()
    return topic_id


def link_node_topic(node_id: str, topic_name: str, score: float = 1.0):
    topic_id = upsert_topic(topic_name)
    conn = get_conn()
    conn.execute(
        "INSERT OR REPLACE INTO node_topics (node_id,topic_id,score) VALUES (?,?,?)",
        (node_id, topic_id, score)
    )
    conn.commit()
    conn.close()


def get_topics(limit: int = 20) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT t.name, t.description, COUNT(nt.node_id) as doc_count
           FROM topics t LEFT JOIN node_topics nt ON t.id=nt.topic_id
           GROUP BY t.id ORDER BY doc_count DESC LIMIT ?""",
        (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ── 엔티티 ────────────────────────────────────────────

def _find_entity_id(conn, canon: str) -> str:
    """정규화된 이름(canon)으로 기존 entity 노드를 찾는다.

    1차: 정규화 표기 그대로 정확 매칭(신규 노드는 정규화돼 저장됨).
    2차: 기존(정규화 전) 노드까지 커버하려 title을 정규화해 비교(스캔).
    """
    row = conn.execute(
        "SELECT id FROM nodes WHERE type='entity' AND title=?", (canon,)
    ).fetchone()
    if row:
        return row["id"]
    for r in conn.execute("SELECT id, title FROM nodes WHERE type='entity'"):
        if normalize_entity_name(r["title"] or "") == canon:
            return r["id"]
    return ""


def _entity_id_by_name(name: str) -> str:
    conn = get_conn()
    eid = _find_entity_id(conn, normalize_entity_name(name))
    conn.close()
    return eid


def upsert_entity(name: str, entity_type: str = "concept", description: str = "") -> str:
    """이름 기준으로 entity 노드를 upsert. 표기 정규화 후 중복 방지."""
    canon = normalize_entity_name(name)
    conn = get_conn()
    eid = _find_entity_id(conn, canon)
    if eid:
        conn.close()
        return eid
    node_id = _uid()
    conn.execute(
        "INSERT INTO nodes (id,type,title,content,source_type,importance) VALUES (?,?,?,?,?,?)",
        (node_id, "entity", canon, description, entity_type, 0.5)
    )
    conn.commit()
    conn.close()
    return node_id


# ── 활동 로그 ─────────────────────────────────────────

def log_activity(node_id: str, action: str, context: str = ""):
    conn = get_conn()
    conn.execute(
        "INSERT INTO activity_log (id,node_id,action,context) VALUES (?,?,?,?)",
        (_uid(), node_id, action, context)
    )
    conn.commit()
    conn.close()


# ── 통계 ──────────────────────────────────────────────

def get_stats() -> dict:
    conn = get_conn()
    nodes = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    edges = conn.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
    topics = conn.execute("SELECT COUNT(*) FROM topics").fetchone()[0]
    by_source = conn.execute(
        "SELECT source_type, COUNT(*) as cnt FROM nodes GROUP BY source_type"
    ).fetchall()
    conn.close()
    return {
        "nodes": nodes,
        "edges": edges,
        "topics": topics,
        "by_source": {r["source_type"]: r["cnt"] for r in by_source}
    }
