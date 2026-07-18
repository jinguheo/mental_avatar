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

def search_nodes_admin(type: str = "", source_type: str = "", view: str = "",
                       q: str = "", limit: int = 50, offset: int = 0) -> dict:
    """데이터 관리 화면(KgDataManager)용 노드 조회. {nodes, total}.

    ⚠️ 예전엔 이름이 search_nodes()였는데, 그러면 위쪽(73번째 줄)의 키워드 검색용
    search_nodes(query, limit)를 덮어써서 /search 엔드포인트가 500으로 죽었다
    (반환형이 list→dict로 바뀌어 호출부가 dict를 list처럼 순회/인덱싱하며 크래시).
    이름을 분리해 그 충돌을 없앤다.

    기존 list_nodes()는 link_similar가 쓰고 있어 시그니처를 못 바꾸므로 별도 함수로 둔다.
    view(대화의 화면 구분)는 별도 컬럼이 아니라 file_path에 'conversation://<view>/<id>'
    형태로만 들어 있어 LIKE로 거른다.
    """
    where, params = [], []
    if type:
        where.append("type=?"); params.append(type)
    if source_type:
        where.append("source_type=?"); params.append(source_type)
    if view:
        where.append("file_path LIKE ?"); params.append(f"conversation://{view}/%")
    if q:
        where.append("(title LIKE ? OR content LIKE ?)")
        params += [f"%{q}%", f"%{q}%"]
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    conn = get_conn()
    total = conn.execute(f"SELECT COUNT(*) FROM nodes {clause}", params).fetchone()[0]
    rows = conn.execute(
        f"""SELECT id, type, title, substr(content, 1, 160) AS preview, source_type,
                   file_path, created_at
            FROM nodes {clause} ORDER BY created_at DESC LIMIT ? OFFSET ?""",
        (*params, limit, offset)
    ).fetchall()
    conn.close()
    return {"nodes": [dict(r) for r in rows], "total": total}


def _orphan_entity_ids(cur) -> set[str]:
    """어떤 문서·대화·프로젝트에서도 참조되지 않는 entity. (엔티티끼리만 이어진 것도 고아로 본다)"""
    rows = cur.execute("""
        SELECT n.id FROM nodes n
        WHERE n.type='entity'
          AND NOT EXISTS (
            SELECT 1 FROM edges e JOIN nodes s ON s.id = e.from_id
            WHERE e.to_id = n.id AND s.type != 'entity'
          )
    """).fetchall()
    return {r[0] for r in rows}


def delete_nodes(ids: list[str], cleanup_orphans: bool = True, dry_run: bool = False) -> dict:
    """노드를 삭제하고 딸린 것들을 함께 정리한다.

    edges/node_topics는 FK CASCADE로 자동이지만, 아래 둘은 코드가 직접 해야 한다:
      - conversations 행: nodes와 FK가 없고 file_path 문자열로만 이어져 있다. 안 지우면
        대화 노드만 사라지고 recent_conversations()/말투학습은 계속 그 대화를 먹는다.
      - Chroma 벡터: 호출부가 커밋 후 지운다(여기선 대상 id만 돌려준다).

    고아 엔티티는 '이번 삭제로 새로 고아가 된 것'만 지운다. 기존에 이미 고아이던 것까지
    쓸어버리면 대화 몇 건 지웠는데 무관한 엔티티가 사라지는 사고가 난다.

    dry_run이면 실제로 지운 뒤 롤백한다 — 미리보기 수치가 실제 결과와 어긋날 수 없다.
    """
    empty = {"nodes": 0, "edges": 0, "conversations": 0, "orphan_entities": 0,
             "deleted_ids": [], "deleted_entity_ids": []}
    if not ids:
        return empty

    conn = get_conn()
    conn.isolation_level = None      # BEGIN/COMMIT/ROLLBACK을 직접 관리
    cur = conn.cursor()
    # id 목록이 길어도(대화 971건 등) SQL 변수 한도에 걸리지 않도록 임시 테이블로 넘긴다
    cur.execute("CREATE TEMP TABLE IF NOT EXISTS _del_ids (id TEXT PRIMARY KEY)")
    cur.execute("DELETE FROM _del_ids")
    cur.executemany("INSERT OR IGNORE INTO _del_ids(id) VALUES (?)", [(i,) for i in ids])

    cur.execute("BEGIN")
    try:
        target_ids = [r[0] for r in cur.execute(
            "SELECT n.id FROM nodes n JOIN _del_ids d ON d.id = n.id").fetchall()]
        if not target_ids:
            conn.rollback()
            return empty

        edges_n = cur.execute(
            """SELECT COUNT(*) FROM edges
               WHERE from_id IN (SELECT id FROM _del_ids) OR to_id IN (SELECT id FROM _del_ids)"""
        ).fetchone()[0]

        cur.execute("""
            DELETE FROM conversations
            WHERE ('conversation://' || view || '/' || id) IN (
                SELECT file_path FROM nodes
                WHERE id IN (SELECT id FROM _del_ids) AND type='conversation'
            )
        """)
        conv_n = cur.rowcount

        pre_orphans = _orphan_entity_ids(cur)
        cur.execute("DELETE FROM nodes WHERE id IN (SELECT id FROM _del_ids)")
        nodes_n = cur.rowcount

        new_orphans: set[str] = set()
        if cleanup_orphans:
            new_orphans = _orphan_entity_ids(cur) - pre_orphans
            if new_orphans:
                cur.executemany("DELETE FROM nodes WHERE id=?", [(i,) for i in new_orphans])

        result = {
            "nodes": nodes_n,
            "edges": edges_n,
            "conversations": conv_n,
            "orphan_entities": len(new_orphans),
            "deleted_ids": target_ids + list(new_orphans),
            "deleted_entity_ids": list(new_orphans),
        }

        if dry_run:
            conn.rollback()
        else:
            conn.commit()
        return result
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def add_edge(from_id: str, to_id: str, relation: str, weight: float = 1.0) -> str:
    """(from,to,relation)이 같은 엣지는 새로 만들지 않고 기존 것을 반환한다.

    edges에는 (from_id,to_id,relation) 유니크 제약이 없고 PK는 매번 새로 만드는 uid라
    INSERT OR IGNORE로는 중복이 걸러지지 않는다(같은 엣지가 수천 행까지 쌓였던 원인).
    스키마에 제약을 거는 대신 여기서 확인 후 삽입한다 — 기존 데이터에 남은 중복 때문에
    UNIQUE 인덱스 생성이 실패하므로.
    """
    conn = get_conn()
    row = conn.execute(
        "SELECT id FROM edges WHERE from_id=? AND to_id=? AND relation=?",
        (from_id, to_id, relation)
    ).fetchone()
    if row:
        # 더 강한 신호로만 갱신 (약한 재관측이 기존 가중치를 깎지 않도록)
        conn.execute(
            "UPDATE edges SET weight=? WHERE id=? AND weight<?",
            (weight, row["id"], weight)
        )
        conn.commit()
        conn.close()
        return row["id"]
    edge_id = _uid()
    conn.execute(
        "INSERT INTO edges (id,from_id,to_id,relation,weight) VALUES (?,?,?,?,?)",
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


def _find_similar_entity_id(canon: str) -> str:
    """정규식으로 못 잡는 의미상 동일 엔티티(대소문자·사소한 표기차)를 임베딩 유사도로 찾는다.
    실패해도(임베딩 미가용 등) 조용히 넘어가 신규 생성으로 폴백."""
    try:
        from . import embeddings
        match = embeddings.find_similar_entity(canon)
        return match["id"] if match else ""
    except Exception:
        return ""


def upsert_entity(name: str, entity_type: str = "concept", description: str = "") -> str:
    """이름 기준으로 entity 노드를 upsert.
    1차: 표기 정규화 후 정확 매칭(regex). 2차: 임베딩 유사도 매칭(대소문자 등 정규식이 못 잡는 것)."""
    canon = normalize_entity_name(name)
    conn = get_conn()
    eid = _find_entity_id(conn, canon)
    if not eid:
        eid = _find_similar_entity_id(canon)
        # 임베딩 색인은 노드가 지워져도 남을 수 있다(유령 항목). 그런 id를 그대로 돌려주면
        # 호출부의 add_edge가 FK 위반으로 터지므로, 실제로 존재하는 노드일 때만 채택한다.
        if eid and not conn.execute(
                "SELECT 1 FROM nodes WHERE id=? AND type='entity'", (eid,)).fetchone():
            print(f"[graph] 임베딩이 이미 없는 엔티티({eid})에 매칭 — 무시하고 새로 만듭니다", flush=True)
            eid = ""
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
    try:
        from . import embeddings
        embeddings.index_entity(node_id, canon)
    except Exception:
        pass
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
