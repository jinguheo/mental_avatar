"""주체별 처리 큐 관리"""
import uuid
import os
from db.init_db import get_conn

SUPPORTED_EXT = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".txt", ".md"}
DOCS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "docs"))


# ── 주체(Subject) ──────────────────────────────────────

def list_subjects() -> list[dict]:
    conn = get_conn()
    rows = conn.execute("""
        SELECT s.id, s.name, s.folder_path, s.description, s.priority, s.created_at,
               COUNT(q.id) AS total,
               SUM(CASE WHEN q.status='pending'    THEN 1 ELSE 0 END) AS pending,
               SUM(CASE WHEN q.status='done'       THEN 1 ELSE 0 END) AS done,
               SUM(CASE WHEN q.status='processing' THEN 1 ELSE 0 END) AS processing,
               SUM(CASE WHEN q.status='error'      THEN 1 ELSE 0 END) AS error
        FROM subjects s
        LEFT JOIN processing_queue q ON q.subject_id = s.id
        GROUP BY s.id ORDER BY s.priority DESC, s.created_at DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_subject(name: str, folder_path: str, description: str = "", priority: int = 5) -> dict:
    conn = get_conn()
    existing = conn.execute("SELECT id FROM subjects WHERE name=?", (name,)).fetchone()
    if existing:
        conn.close()
        return {"id": existing["id"], "created": False}
    sid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO subjects (id, name, folder_path, description, priority) VALUES (?,?,?,?,?)",
        (sid, name, folder_path, description, priority)
    )
    conn.commit()
    conn.close()
    return {"id": sid, "created": True}


def delete_subject(subject_id: str):
    conn = get_conn()
    conn.execute("DELETE FROM subjects WHERE id=?", (subject_id,))
    conn.commit()
    conn.close()


def scan_subject(subject_id: str) -> dict:
    conn = get_conn()
    subject = conn.execute("SELECT * FROM subjects WHERE id=?", (subject_id,)).fetchone()
    if not subject:
        conn.close()
        return {"error": "주체 없음"}

    folder = subject["folder_path"]
    added = 0
    skipped = 0

    for dirpath, _, filenames in os.walk(folder):
        for fname in filenames:
            if fname.startswith("~$"):
                continue
            ext = os.path.splitext(fname)[1].lower()
            if ext not in SUPPORTED_EXT:
                continue
            fpath = os.path.join(dirpath, fname)
            existing = conn.execute(
                "SELECT id FROM processing_queue WHERE file_path=?", (fpath,)
            ).fetchone()
            if existing:
                skipped += 1
                continue
            conn.execute(
                "INSERT INTO processing_queue (id, subject_id, file_path, file_name) VALUES (?,?,?,?)",
                (str(uuid.uuid4()), subject_id, fpath, fname)
            )
            added += 1

    conn.commit()
    conn.close()
    return {"added": added, "skipped": skipped}


def enqueue_file(file_path: str, subject_id: str = "") -> dict:
    """파일 경로를 큐에 직접 등록. subject_id 없으면 'uploads' 기본 주체 사용."""
    file_path = os.path.abspath(file_path)
    ext = os.path.splitext(file_path)[1].lower()
    if ext not in SUPPORTED_EXT:
        return {"error": f"지원하지 않는 형식: {ext}"}

    conn = get_conn()

    # subject_id 없으면 'uploads' 주체 자동 생성/조회
    if not subject_id:
        row = conn.execute("SELECT id FROM subjects WHERE name='uploads'").fetchone()
        if row:
            subject_id = row["id"]
        else:
            subject_id = str(uuid.uuid4())
            upload_folder = os.path.join(DOCS_DIR, "uploads")
            conn.execute(
                "INSERT INTO subjects (id, name, folder_path, description, priority) VALUES (?,?,?,?,?)",
                (subject_id, "uploads", upload_folder, "웹 업로드 파일", 5)
            )

    # 중복 체크
    existing = conn.execute(
        "SELECT id FROM processing_queue WHERE file_path=?", (file_path,)
    ).fetchone()
    if existing:
        conn.close()
        return {"queued": False, "reason": "already_queued", "id": existing["id"]}

    qid = str(uuid.uuid4())
    fname = os.path.basename(file_path)
    conn.execute(
        "INSERT INTO processing_queue (id, subject_id, file_path, file_name) VALUES (?,?,?,?)",
        (qid, subject_id, file_path, fname)
    )
    conn.commit()
    conn.close()
    return {"queued": True, "id": qid, "file_name": fname}


# ── 큐 항목 ────────────────────────────────────────────

def list_queue(subject_id: str = "", status: str = "") -> list[dict]:
    conn = get_conn()
    where, params = [], []
    if subject_id:
        where.append("q.subject_id=?"); params.append(subject_id)
    if status:
        where.append("q.status=?"); params.append(status)
    sql = """
        SELECT q.*, s.name AS subject_name
        FROM processing_queue q
        JOIN subjects s ON q.subject_id = s.id
    """
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY s.priority DESC, q.queued_at ASC"
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def _set_queue_status(qid: str, status: str, error: str = ""):
    """짧은 커넥션으로 큐 상태만 업데이트 — DB lock 최소화"""
    conn = get_conn()
    if status == "done":
        conn.execute(
            "UPDATE processing_queue SET status='done', processed_at=datetime('now','localtime'), error=NULL WHERE id=?",
            (qid,)
        )
    elif status == "error":
        conn.execute(
            "UPDATE processing_queue SET status='error', error=? WHERE id=?",
            (error[:500], qid)
        )
    else:
        conn.execute("UPDATE processing_queue SET status=? WHERE id=?", (status, qid))
    conn.commit()
    conn.close()


def process_next(subject_id: str = "", limit: int = 5) -> dict:
    """pending 항목을 가져와 ingest + 엔티티 추출 + wiki 생성까지 처리.
    각 단계마다 커넥션을 열고 닫아 SQLite lock 방지."""
    from watcher.parsers import parse_file
    from . import graph, embeddings, wiki
    import hashlib

    # ── pending 항목 조회 (짧은 커넥션) ──
    conn = get_conn()
    where = "status='pending'"
    params: list = []
    if subject_id:
        where += " AND subject_id=?"; params.append(subject_id)
    rows = conn.execute(
        f"SELECT * FROM processing_queue WHERE {where} ORDER BY queued_at ASC LIMIT ?",
        params + [limit]
    ).fetchall()
    items = [dict(r) for r in rows]
    conn.close()

    results: dict = {"processed": 0, "failed": 0, "items": []}

    for row in items:
        qid   = row["id"]
        fpath = row["file_path"]
        fname = row["file_name"]

        # processing 표시 (짧은 커넥션)
        _set_queue_status(qid, "processing")

        try:
            # ── 1. 파일 파싱 ──
            chunks = parse_file(fpath)
            if not chunks:
                raise ValueError("파싱 실패 또는 지원하지 않는 형식")

            # ── 2. KG 노드 + 벡터 저장 (커넥션은 graph/embeddings 내부에서 관리) ──
            node_ids = []
            for chunk in chunks:
                title       = chunk.get("title", fname)
                content     = chunk.get("content", "")
                meta        = chunk.get("meta", {})
                source_type = meta.get("source_type", "unknown")
                chunk_idx   = meta.get("chunk_index", 0)
                fhash       = hashlib.md5(content.encode()).hexdigest()[:12]

                nid = graph.add_node(
                    type="chunk", title=title, content=content,
                    source_type=source_type, file_path=fpath,
                    file_hash=fhash, chunk_index=chunk_idx
                )
                embeddings.add_document(nid, title, content, {
                    "source_type": source_type,
                    "file_path": fpath,
                    "chunk_index": str(chunk_idx)
                })
                node_ids.append(nid)

            # ── 3. 엔티티/토픽 추출 (Ollama → MCP → API key → keyword) ──
            if node_ids and chunks[0].get("content", ""):
                try:
                    from . import extractor
                    first_title   = chunks[0].get("title", fname)
                    first_content = chunks[0].get("content", "")
                    extracted = extractor.extract(first_title, first_content)
                    nid0 = node_ids[0]
                    for topic in extracted.get("topics", []):
                        graph.link_node_topic(nid0, topic)
                    for ent in extracted.get("entities", []):
                        ename = ent.get("name", "").strip()
                        if not ename:
                            continue
                        eid = graph.upsert_entity(ename, ent.get("type", "concept"), ent.get("description", ""))
                        graph.add_edge(nid0, eid, "mentions", 1.0)
                    importance = extracted.get("importance", 0.5)
                    graph.update_importance(nid0, importance - 0.5)
                except Exception as ex:
                    print(f"[queue] 엔티티 추출 경고 (무시됨): {ex}")

            # ── 4. Wiki 생성 (Ollama 사용, 실패해도 done 처리) ──
            wiki_status = "skipped"
            if node_ids and chunks[0].get("content", ""):
                try:
                    result = wiki.generate_wiki(
                        node_id=node_ids[0],
                        title=chunks[0].get("title", fname),
                        content=chunks[0].get("content", ""),
                        file_path=fpath,
                    )
                    wiki_status = result.get("status", "done")
                except Exception as ex:
                    print(f"[queue] wiki 생성 경고 (무시됨): {ex}")

            _set_queue_status(qid, "done")
            results["processed"] += 1
            results["items"].append({
                "file": fname, "status": "done",
                "nodes": len(node_ids), "wiki": wiki_status
            })

        except Exception as e:
            _set_queue_status(qid, "error", str(e))
            results["failed"] += 1
            results["items"].append({"file": fname, "status": "error", "error": str(e)})

    return results


def reset_errors(subject_id: str = ""):
    conn = get_conn()
    if subject_id:
        conn.execute(
            "UPDATE processing_queue SET status='pending', error=NULL WHERE status='error' AND subject_id=?",
            (subject_id,)
        )
    else:
        conn.execute("UPDATE processing_queue SET status='pending', error=NULL WHERE status='error'")
    affected = conn.total_changes
    conn.commit()
    conn.close()
    return affected


def auto_discover_subjects() -> dict:
    added = 0
    for entry in os.scandir(DOCS_DIR):
        if not entry.is_dir():
            continue
        name = entry.name
        result = create_subject(name, entry.path, f"docs/{name} 자동 등록")
        if result["created"]:
            scan_subject(result["id"])
            added += 1
    return {"subjects_added": added}
