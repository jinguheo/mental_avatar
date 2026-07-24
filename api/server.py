"""Mental Avatar API 서버 — 포트 8766"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename
import hashlib
import uuid, subprocess, time, json
import shutil as _shutil
import re as _re
from pathlib import Path

from db.init_db import init as init_db
from core import graph, extractor, embeddings, pattern, wiki, queue_mgr, avatar as avatar_core, project_scan, ppt_present, lipsync, config, kg_ingest, self_interview, notes
from agent import recommender, searcher
from watcher.parsers import parse_file

app = Flask(__name__)
CORS(app)


def _open_in_explorer(folder: str | None = None):
    """백그라운드 프로세스(이 서버)가 띄우는 탐색기 창은 Windows 포커스-스틸 방지 정책 때문에
    ASFW_ANY 만으로는 전면에 안 나타날 수 있다 — 새/기존 탐색기 창(CabinetWClass)을 직접 찾아
    ALT 키 트릭 + SetForegroundWindow로 강제로 앞으로 가져온다.
    folder가 없으면 기본 위치(빠른 실행)로 그냥 탐색기를 띄운다."""
    import ctypes
    import time
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    try:
        user32.AllowSetForegroundWindow(-1)  # ASFW_ANY
    except Exception:
        pass

    if folder:
        os.startfile(folder)
        target = Path(folder).name.lower()
    else:
        subprocess.Popen("explorer")
        target = None

    try:
        found = {"hwnd": 0}

        def _enum(hwnd, _lparam):
            buf = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, buf, 64)
            if buf.value != "CabinetWClass":
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            title_buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, title_buf, length + 1)
            if target is None or target in title_buf.value.lower():
                found["hwnd"] = hwnd
                return False
            return True

        enum_proc = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(_enum)
        for _ in range(20):  # 최대 ~2초 폴링 (창 생성이 비동기라 즉시 안 잡힐 수 있음)
            found["hwnd"] = 0
            user32.EnumWindows(enum_proc, 0)
            if found["hwnd"]:
                hwnd = found["hwnd"]
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE (최소화 상태였으면 복원)
                user32.keybd_event(0x12, 0, 0, 0)  # ALT down — SetForegroundWindow 잠금 우회 트릭
                user32.SetForegroundWindow(hwnd)
                user32.keybd_event(0x12, 0, 2, 0)  # ALT up
                break
            time.sleep(0.1)
    except Exception:
        pass


def _pick_path(kind: str) -> str | None:
    """네이티브 OS 다이얼로그로 폴더(kind='folder') 또는 파일(kind='file')을 선택. 취소 시 None.
    파일 선택은 askopenfilename, 폴더 선택은 askdirectory — Windows엔 둘을 합친 단일 다이얼로그가 없어 분리."""
    import ctypes
    import tkinter as tk
    from tkinter import filedialog

    try:
        ctypes.windll.user32.AllowSetForegroundWindow(-1)
    except Exception:
        pass

    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        if kind == "folder":
            path = filedialog.askdirectory(parent=root, title="폴더 선택")
        else:
            path = filedialog.askopenfilename(parent=root, title="파일 선택")
    finally:
        root.destroy()
    return path or None


def _process_chunks(chunks: list[dict], file_path: str = "") -> list[str]:
    """청크 리스트를 KG에 저장, node_id 리스트 반환.

    실제 로직은 core/kg_ingest로 통일 — 워처(queue_mgr)와 동일 파이프라인 사용.
    """
    return kg_ingest.process_chunks(chunks, file_path)


# ── 엔드포인트 ─────────────────────────────────────────

@app.route("/ingest", methods=["POST"])
def ingest():
    """문서 또는 텍스트를 KG에 추가"""
    data = request.get_json(silent=True) or {}

    # 파일 경로로 ingest
    if "file_path" in data:
        fp = data["file_path"]
        if not os.path.exists(fp):
            return jsonify({"error": f"파일 없음: {fp}"}), 404
        chunks = parse_file(fp)
        if not chunks:
            return jsonify({"error": "지원하지 않는 파일 형식"}), 400
        ids = _process_chunks(chunks, fp)
        return jsonify({"success": True, "node_ids": ids, "count": len(ids)})

    # 텍스트로 ingest (dashboard 연동)
    title       = data.get("title", "")
    content     = data.get("content", "")
    source_type = data.get("source_type", "text")
    if not content:
        return jsonify({"error": "content 필요"}), 400

    chunks = [{"title": title, "content": content, "meta": {"source_type": source_type}}]
    ids = _process_chunks(chunks)
    return jsonify({"success": True, "node_ids": ids, "count": len(ids)})


def _graphify_community_search(q: str) -> list[dict]:
    """graph.json에서 쿼리와 관련된 커뮤니티 노드를 검색.
    커뮤니티 매칭 자체는 core/graphify_runner.matching_communities로 통일(avatar.py와 공유)."""
    import json as _json
    from core import graphify_runner
    graph_path = os.path.join(os.path.dirname(__file__), "..", "graphify-out", "graph.json")
    if not os.path.exists(graph_path):
        return []
    try:
        gdata = _json.loads(open(graph_path, encoding="utf-8").read())
        matched_communities = graphify_runner.matching_communities(q)
        if not matched_communities:
            return []
        results = []
        seen = set()
        for node in gdata.get("nodes", []):
            cid = node.get("community")
            if cid in matched_communities and node.get("file_type") == "document":
                nid = node["id"]
                if nid in seen:
                    continue
                seen.add(nid)
                results.append({
                    "id": nid,
                    "title": node.get("label", nid),
                    "source_type": "graphify",
                    "community": matched_communities.get(cid, f"Community {cid}"),
                    "distance": 0.0,
                    "document": f"[Graphify] 커뮤니티: {matched_communities.get(cid, '')}",
                    "_source": "graphify",
                })
        return results[:5]
    except Exception:
        return []


@app.route("/search", methods=["GET"])
def search():
    q = request.args.get("q", "")
    mode = request.args.get("mode", "semantic")  # semantic | keyword
    limit = int(request.args.get("limit", 10))
    source = request.args.get("source", "").strip()
    include_conversation = request.args.get("include_conversation", "0").lower() in ("1", "true", "yes", "on")
    include_graphify = request.args.get("include_graphify", "0").lower() in ("1", "true", "yes", "on")
    include_entities = request.args.get("include_entities", "0").lower() in ("1", "true", "yes", "on")
    if q:
        graph.log_activity(None, "search", q)

    if not q:
        return jsonify({"error": "q 파라미터 필요"}), 400

    entity_types = {"concept", "technology", "organization", "tool", "entity", "field", "algorithm"}
    default_hidden_types = {"todo"}

    def result_source(item: dict) -> str:
        return item.get("source_type") or item.get("metadata", {}).get("source_type", "")

    def allow_result(item: dict) -> bool:
        st = result_source(item)
        if source:
            return st == source
        if not include_conversation and st == "conversation":
            return False
        if not include_entities and st in entity_types:
            return False
        if st in default_hidden_types:
            return False
        return True

    def keyword_distance(item: dict) -> float:
        title = (item.get("title") or "").strip().lower()
        content = (item.get("content") or item.get("document") or "").strip().lower()
        query = q.strip().lower()
        if title == query:
            return 0.05
        if query and query in title:
            return 0.12
        if query and query in content:
            return 0.2
        return 0.35

    def keyword_rank(item: dict) -> tuple:
        st = result_source(item)
        source_priority = {
            "project": 0,
            "note": 1,
            "pdf": 2,
            "pptx": 3,
            "docx": 3,
            "md": 3,
            "txt": 3,
            "text": 3,
            "file": 3,
            "todo": 5,
        }.get(st, 4)
        return (keyword_distance(item), source_priority, -(item.get("importance") or 0))

    def complete_result(item: dict) -> dict:
        node = graph.get_node(item["id"])
        if node:
            item["title"] = node["title"]
            item["source_type"] = node["source_type"]
            if node.get("file_path"):
                item["file_path"] = node["file_path"]
            elif node.get("file_hash"):
                row = graph.get_conn().execute(
                    "SELECT file_path FROM nodes WHERE file_hash=? AND file_path IS NOT NULL AND file_path != '' LIMIT 1",
                    (node["file_hash"],)
                ).fetchone()
                if row and row["file_path"]:
                    item["file_path"] = row["file_path"]
        else:
            metadata = item.get("metadata") or {}
            item["source_type"] = item.get("source_type") or metadata.get("source_type", "unknown")
            if metadata.get("file_path"):
                item["file_path"] = metadata["file_path"]
        if not item.get("title"):
            item["title"] = (item.get("document") or item.get("content") or "").strip().splitlines()[0][:80]
        item["_source"] = "kg"
        return item

    if mode == "semantic":
        keyword_results = []
        for r in graph.search_nodes(q, limit=limit * 2):
            if allow_result(r):
                r["distance"] = keyword_distance(r)
                keyword_results.append(complete_result(r))
        keyword_results.sort(key=keyword_rank)

        where = None
        if source:
            where = {"source_type": source}
        elif not include_conversation:
            where = {"source_type": {"$ne": "conversation"}}
        semantic_results = []
        max_semantic_distance = 0.5 if keyword_results else 0.62
        for r in embeddings.search(q, n_results=limit, where=where):
            if r.get("distance", 1.0) > max_semantic_distance:
                continue
            if allow_result(r):
                semantic_results.append(complete_result(r))

        results = []
        seen_ids = set()
        for r in [*keyword_results, *semantic_results]:
            if r["id"] in seen_ids:
                continue
            seen_ids.add(r["id"])
            results.append(r)
    else:
        results = graph.search_nodes(q, limit=limit)
        results = [complete_result(r) for r in results if allow_result(r)]

    # Graphify 커뮤니티는 보조 검색이므로 명시 요청 시에만 병합한다.
    if include_graphify:
        kg_titles = {r.get("title", "").lower() for r in results}
        gf_results = _graphify_community_search(q)
        for gf in gf_results:
            if gf["title"].lower() not in kg_titles:
                results.append(gf)

    results = results[:limit]
    return jsonify({"results": results, "count": len(results)})


@app.route("/topics", methods=["GET"])
def topics():
    limit = int(request.args.get("limit", 20))
    return jsonify({"topics": graph.get_topics(limit)})


@app.route("/stats", methods=["GET"])
def stats():
    g = graph.get_stats()
    v = embeddings.get_stats()
    return jsonify({**g, **v})


@app.route("/nodes", methods=["GET"])
def nodes_list():
    """데이터 관리 화면용 노드 목록 — 종류/출처/화면/검색어 필터 + 페이징."""
    try:
        limit = max(1, min(200, int(request.args.get("limit", 50))))
        offset = max(0, int(request.args.get("offset", 0)))
    except ValueError:
        return jsonify({"error": "limit/offset은 숫자여야 합니다"}), 400
    return jsonify(graph.search_nodes_admin(
        type=request.args.get("type", ""),
        source_type=request.args.get("source_type", ""),
        view=request.args.get("view", ""),
        q=request.args.get("q", ""),
        limit=limit, offset=offset,
    ))


@app.route("/nodes/facets", methods=["GET"])
def nodes_facets():
    """필터 드롭다운 채우기용 — 실제 존재하는 종류/출처/화면 값만."""
    conn = _sqlite3.connect(str(Path(__file__).parent.parent / "db" / "knowledge.db"))
    try:
        types = [r[0] for r in conn.execute(
            "SELECT DISTINCT type FROM nodes WHERE type IS NOT NULL ORDER BY 1")]
        sources = [r[0] for r in conn.execute(
            "SELECT DISTINCT source_type FROM nodes WHERE source_type IS NOT NULL ORDER BY 1")]
        views = [r[0] for r in conn.execute("SELECT DISTINCT view FROM conversations ORDER BY 1")]
    finally:
        conn.close()
    return jsonify({"types": types, "source_types": sources, "views": views})


def _backup_db(tag: str) -> str:
    """되돌릴 수 있게 삭제 직전 상태를 복사해 둔다(약 15MB, 순식간).
    워처가 시간별 백업을 돌지만 그 사이에 지운 건 못 살리므로 삭제 시점에 따로 찍는다.

    knowledge.db만으로는 부족하다 — 삭제는 Chroma 벡터도 함께 지우므로, DB만 되돌리면
    노드는 살아나도 임베딩이 없어 검색에 안 걸리는 반쪽 복구가 된다. vectors/도 같이 뜬다.
    (data/의 얼굴·목소리는 노드 삭제와 무관해서 제외 — 워처의 시간별 백업이 담당한다.)

    이 'pre_*' 백업은 워처의 _prune_old_backups가 시간별 백업과 별도 정원으로 관리한다
    (한 묶음으로 이름순 정리하면 pre_*가 시간별 백업을 밀어내 전멸시킨다).
    """
    root = Path(__file__).parent.parent
    dest_dir = root / "backups" / f"{tag}_{time.strftime('%Y%m%d_%H%M%S')}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    _shutil.copy2(root / "db" / "knowledge.db", dest_dir / "knowledge.db")
    vectors = root / "db" / "vectors"
    if vectors.is_dir():
        _shutil.copytree(vectors, dest_dir / "vectors", dirs_exist_ok=True)
    return str(dest_dir)


@app.route("/nodes/delete", methods=["POST"])
def nodes_delete():
    """선택한 노드 삭제. dry_run=true면 실제로 지운 뒤 롤백해 '무엇이 사라지는지'만 돌려준다."""
    body = request.get_json(silent=True) or {}
    ids = body.get("ids") or []
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "ids(배열) 필요"}), 400
    dry_run = bool(body.get("dry_run", False))
    cleanup_orphans = bool(body.get("cleanup_orphans", True))

    backup_dir = None
    if not dry_run:
        try:
            backup_dir = _backup_db("pre_delete")
        except Exception as e:
            return jsonify({"error": f"백업 실패로 삭제를 중단했습니다: {e}"}), 500

    try:
        res = graph.delete_nodes(ids, cleanup_orphans=cleanup_orphans, dry_run=dry_run)
    except Exception as e:
        return jsonify({"error": f"삭제 실패(롤백됨): {e}"}), 500

    if not dry_run:
        # SQLite 커밋 후에 벡터를 지운다 — 벡터 삭제가 실패해도 삭제 자체를 되돌리진 않는다.
        embeddings.delete_documents(res.get("deleted_ids", []))
        embeddings.delete_entities(res.get("deleted_entity_ids", []))

    res["dry_run"] = dry_run
    res["backup_dir"] = backup_dir
    res.pop("deleted_ids", None)
    res.pop("deleted_entity_ids", None)
    return jsonify(res)


@app.route("/graph", methods=["GET"])
def get_graph():
    node_id = request.args.get("id")
    if not node_id:
        return jsonify({"error": "id 필요"}), 400
    node = graph.get_node(node_id)
    if not node:
        return jsonify({"error": "노드 없음"}), 404
    neighbors = graph.get_neighbors(node_id)
    return jsonify({"node": node, "neighbors": neighbors})


@app.route("/graph/all", methods=["GET"])
def get_graph_all():
    """전체 노드+엣지 반환 (시각화용)"""
    limit = int(request.args.get("limit", 100))
    from db.init_db import get_conn as _get_conn
    conn2 = _get_conn()
    doc_rows = conn2.execute(
        "SELECT * FROM nodes WHERE source_type NOT IN ('concept') ORDER BY updated_at DESC LIMIT 300"
    ).fetchall()
    concept_rows = conn2.execute(
        "SELECT * FROM nodes WHERE source_type='concept' ORDER BY importance DESC LIMIT ?", (limit,)
    ).fetchall()
    conn2.close()
    seen = {}
    for r in [*doc_rows, *concept_rows]:
        seen[r["id"]] = dict(r)
    nodes = list(seen.values())
    node_ids = {n["id"] for n in nodes}
    placeholders = ",".join("?" * len(node_ids))
    conn = _get_conn()
    edges = conn.execute(
        f"SELECT from_id, to_id, relation, weight FROM edges "
        f"WHERE from_id IN ({placeholders}) AND to_id IN ({placeholders}) LIMIT 2000",
        list(node_ids) * 2
    ).fetchall()
    conn.close()
    return jsonify({
        "nodes": nodes,
        "edges": [dict(e) for e in edges]
    })


@app.route("/recommend", methods=["GET"])
def recommend():
    """최근 활동 기반 추천 (토픽 빈도 상위)"""
    topics_list = graph.get_topics(limit=5)
    recommendations = []
    for t in topics_list:
        related = embeddings.search(t["name"], n_results=3)
        for r in related:
            node = graph.get_node(r["id"])
            if node:
                recommendations.append({
                    "topic": t["name"],
                    "title": node["title"],
                    "node_id": r["id"],
                    "source_type": node["source_type"]
                })
    return jsonify({"recommendations": recommendations[:10]})


@app.route("/avatar/summary", methods=["GET"])
def avatar_summary():
    """1인칭 자기 요약 + 관심사 + 트렌드 + 갭"""
    return jsonify(pattern.avatar_summary())


@app.route("/pattern/trends", methods=["GET"])
def pattern_trends():
    days = int(request.args.get("days", 30))
    return jsonify({"trends": pattern.topic_trends(days)})


@app.route("/pattern/interests", methods=["GET"])
def pattern_interests():
    return jsonify({"interests": pattern.core_interests(int(request.args.get("limit", 10)))})


@app.route("/pattern/gaps", methods=["GET"])
def pattern_gaps():
    return jsonify({"gaps": pattern.knowledge_gaps()})


@app.route("/connections", methods=["GET"])
def connections():
    """서로 다른 소스 간 발견된 연결고리"""
    return jsonify({"connections": recommender.cross_connections(int(request.args.get("limit", 5)))})


@app.route("/recommend/related", methods=["GET"])
def recommend_related():
    """최근 노드 기반 추천"""
    return jsonify({"recommendations": recommender.related_to_recent(int(request.args.get("limit", 8)))})


@app.route("/graph/link_similar", methods=["POST"])
def link_similar():
    """벡터 유사도 기반 노드 간 엣지 자동 생성"""
    threshold = float((request.get_json(silent=True) or {}).get("threshold", 0.3))
    nodes = graph.list_nodes(limit=200)
    created = 0
    n = min(6, max(1, len(nodes) - 1))
    for node in nodes:
        query = f"{node.get('title') or ''} {(node.get('content') or '')[:200]}".strip()
        if not query:
            continue
        results = embeddings.search(query, n_results=n)
        for r in results:
            if r["id"] == node["id"]:
                continue
            if r["distance"] < threshold:
                graph.add_edge(node["id"], r["id"], "similar_to", round(1 - r["distance"], 3))
                created += 1
    return jsonify({"success": True, "edges_created": created})


@app.route("/enrich", methods=["POST"])
def enrich():
    """자율 검색 보강 (검색어 생성)"""
    auto = (request.get_json(silent=True) or {}).get("auto_add", False)
    return jsonify(searcher.enrich(auto_add=auto))


@app.route("/decay", methods=["POST"])
def decay():
    """망각 모델 적용 — 오래된 노드 중요도 감소"""
    affected = pattern.apply_decay()
    return jsonify({"success": True, "affected": affected})


DOCS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "docs"))
SUPPORTED_EXT = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".txt", ".md"}
UPLOAD_DIR = os.path.join(DOCS_DIR, "uploads")


@app.route("/upload", methods=["POST"])
def upload_file():
    """파일 업로드 → docs/uploads/ 저장 → 큐 자동 등록"""
    if "file" not in request.files:
        return jsonify({"error": "file 필드 없음"}), 400

    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "파일명 없음"}), 400

    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in SUPPORTED_EXT:
        return jsonify({"error": f"지원하지 않는 형식: {ext}"}), 400

    os.makedirs(UPLOAD_DIR, exist_ok=True)

    # 동일 파일명 충돌 방지
    safe_name = f.filename.replace(" ", "_")
    dest = os.path.join(UPLOAD_DIR, safe_name)
    if os.path.exists(dest):
        base, ext2 = os.path.splitext(safe_name)
        dest = os.path.join(UPLOAD_DIR, f"{base}_{uuid.uuid4().hex[:6]}{ext2}")

    f.save(dest)
    result = queue_mgr.enqueue_file(dest)
    return jsonify({"saved": dest, **result})


@app.route("/files/list", methods=["GET"])
def files_list():
    """docs/ 폴더 실제 파일 목록"""
    files = []
    for dirpath, _, filenames in os.walk(DOCS_DIR):
        for fname in filenames:
            if fname.startswith("~$"):
                continue
            ext = os.path.splitext(fname)[1].lower()
            if ext not in SUPPORTED_EXT:
                continue
            fpath = os.path.join(dirpath, fname)
            stat = os.stat(fpath)
            rel = os.path.relpath(fpath, DOCS_DIR).replace("\\", "/")
            files.append({
                "name": fname,
                "path": fpath,
                "rel": rel,
                "ext": ext.lstrip("."),
                "size": stat.st_size,
                "modified": stat.st_mtime,
            })
    files.sort(key=lambda f: f["modified"], reverse=True)
    return jsonify({"files": files})


@app.route("/files/open", methods=["POST"])
def files_open():
    """파일을 OS 기본 앱으로 열기 (Windows) + 행동 로깅"""
    data = request.get_json(silent=True) or {}
    fpath = data.get("path", "")
    if not os.path.abspath(fpath).startswith(DOCS_DIR):
        return jsonify({"error": "허용되지 않는 경로"}), 403
    if not os.path.exists(fpath):
        return jsonify({"error": "파일 없음"}), 404
    try:
        os.startfile(fpath)
        # 행동 로그 기록
        graph.log_activity(None, "file_open", fpath)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/activity/log", methods=["POST"])
def activity_log():
    """행동 로그 기록 (node_id 포함) — 검색결과 클릭, Wiki 열람 등"""
    data = request.get_json(silent=True) or {}
    node_id = data.get("node_id")   # 없으면 None
    action  = data.get("action", "view")
    context = data.get("context", "")
    graph.log_activity(node_id, action, context)
    return jsonify({"ok": True})


@app.route("/wiki/list", methods=["GET"])
def wiki_list():
    return jsonify({"pages": wiki.list_wiki_pages()})


@app.route("/wiki/<page_id>", methods=["GET"])
def wiki_get(page_id):
    page = wiki.get_wiki_page(page_id)
    if not page:
        return jsonify({"error": "페이지 없음"}), 404
    return jsonify(page)


@app.route("/wiki/generate", methods=["POST"])
def wiki_generate():
    """node_id 또는 file_path로 wiki 페이지 생성"""
    data = request.get_json(silent=True) or {}
    node_id = data.get("node_id")
    file_path = data.get("file_path")

    # node_id로 노드 정보 조회
    if node_id:
        node = graph.get_node(node_id)
        if not node:
            return jsonify({"error": "노드 없음"}), 404
    elif file_path:
        nodes = graph.search_nodes(os.path.basename(file_path), limit=1)
        node = nodes[0] if nodes else None
        if not node:
            return jsonify({"error": "노드 없음"}), 404
        node_id = node["id"]
    else:
        return jsonify({"error": "node_id 또는 file_path 필요"}), 400

    try:
        result = wiki.generate_wiki(
            node_id=node_id,
            title=node.get("title", ""),
            content=node.get("content", ""),
            file_path=node.get("file_path", node_id),
        )
        return jsonify({"success": True, **result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/wiki/generate_all", methods=["POST"])
def wiki_generate_all():
    """모든 노드에 대해 wiki 페이지 일괄 생성"""
    nodes = graph.list_nodes(limit=200)
    results = {"success": 0, "failed": 0, "pages": []}
    for node in nodes:
        if not node.get("content") or len(node.get("content", "")) < 50:
            continue
        try:
            r = wiki.generate_wiki(
                node_id=node["id"],
                title=node.get("title", ""),
                content=node.get("content", ""),
                file_path=node.get("file_path") or node["id"],
            )
            results["success"] += 1
            results["pages"].append({"id": r["id"], "title": node["title"], "status": r["status"]})
        except Exception as e:
            results["failed"] += 1
    return jsonify(results)


# ── 자동 요약 + Graphify 자동 실행 (백그라운드) ──────────
import threading as _threading
from core import graphify_runner as _grunner

_auto_job: dict    = {"running": False, "total": 0, "done": 0, "failed": 0, "current": "", "cancel": False}
_graphify_html = os.path.join(os.path.dirname(__file__), "..", "graphify-out", "graph.html")
_graphify_job: dict = {"running": False, "stage": "", "nodes": 0, "edges": 0,
                        "communities": 0, "exported": 0, "error": "",
                        "html_ready": os.path.exists(_graphify_html)}


def _run_summarize_then_graphify(job: dict, limit: int) -> None:
    """요약 완료 후 자동으로 graphify 실행"""
    wiki.auto_summarize_missing(job, limit)
    # 요약이 하나라도 성공했으면 graphify 실행
    if job.get("done", 0) > 0 and not job.get("cancel"):
        _graphify_job.update({"running": True, "stage": "시작", "error": ""})
        _grunner.run_graphify(_graphify_job)


@app.route("/wiki/auto_summarize/status", methods=["GET"])
def wiki_auto_status():
    """자동 요약 + graphify 진행 상태 조회"""
    missing = wiki.count_missing()
    return jsonify({**_auto_job, **missing, "graphify": _graphify_job})


@app.route("/wiki/auto_summarize/start", methods=["POST"])
def wiki_auto_start():
    """미요약 노드를 백그라운드에서 자동 요약 시작 → 완료 후 graphify 자동 실행"""
    global _auto_job
    if _auto_job.get("running"):
        return jsonify({"error": "이미 실행 중입니다"}), 409
    limit = int((request.get_json(silent=True) or {}).get("limit", 200))
    _auto_job = {"running": True, "total": 0, "done": 0, "failed": 0, "current": "", "cancel": False}
    t = _threading.Thread(target=_run_summarize_then_graphify, args=(_auto_job, limit), daemon=True)
    t.start()
    return jsonify({"started": True})


@app.route("/wiki/auto_summarize/cancel", methods=["POST"])
def wiki_auto_cancel():
    """실행 중인 자동 요약 취소"""
    _auto_job["cancel"] = True
    return jsonify({"cancel": True})


@app.route("/graphify/run", methods=["POST"])
def graphify_run():
    """Graphify를 즉시 수동 실행 (백그라운드)"""
    global _graphify_job
    if _graphify_job.get("running"):
        return jsonify({"error": "이미 실행 중입니다"}), 409
    _graphify_job = {"running": True, "stage": "시작", "nodes": 0, "edges": 0,
                     "communities": 0, "exported": 0, "error": ""}
    t = _threading.Thread(target=_grunner.run_graphify, args=(_graphify_job,), daemon=True)
    t.start()
    return jsonify({"started": True})


@app.route("/graphify/status", methods=["GET"])
def graphify_status():
    """Graphify 실행 상태 조회"""
    html_exists = (_grunner.OUT_DIR / "graph.html").exists()
    return jsonify({**_graphify_job, "html_ready": html_exists})


@app.route("/graphify/graph.html", methods=["GET"])
def graphify_html():
    """생성된 graph.html 서빙"""
    html_path = _grunner.OUT_DIR / "graph.html"
    if not html_path.exists():
        return "graph.html 없음 — Graphify를 먼저 실행하세요", 404
    return send_file(str(html_path), mimetype="text/html")


@app.route("/wiki/export", methods=["POST"])
def wiki_export():
    """Wiki 페이지를 마크다운 파일로 내보내기 (graphify 연동용)"""
    data = request.get_json(silent=True) or {}
    export_dir = data.get("dir", os.path.join(os.path.dirname(__file__), "..", "graphify-wiki"))
    export_dir = os.path.abspath(export_dir)
    os.makedirs(export_dir, exist_ok=True)

    pages = wiki.list_wiki_pages()
    written = 0
    for page in pages:
        if not page.get("wiki_content"):
            continue
        safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in (page["title"] or page["id"]))
        safe_name = safe_name.strip()[:80] or page["id"]
        fpath = os.path.join(export_dir, f"{safe_name}.md")
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(f"---\nfile_path: {page['file_path']}\nstatus: {page['status']}\n---\n\n")
            f.write(page["wiki_content"])
        written += 1

    return jsonify({"success": True, "written": written, "dir": export_dir})


@app.route("/profile/me", methods=["GET"])
def profile_get():
    return jsonify({
        "profile": avatar_core.get_profile(),
        "labels": avatar_core.PROFILE_LABELS,
        "options": {
            "speech_style":  avatar_core.SPEECH_STYLE_OPTIONS,
            "persona":       avatar_core.PERSONA_OPTIONS,
            "language_tone": avatar_core.LANGUAGE_TONE_OPTIONS,
            "video":         avatar_core.VIDEO_STYLE_OPTIONS,
        },
        "defaults": {
            **avatar_core.STYLE_DEFAULTS,
            **avatar_core.VIDEO_STYLE_DEFAULTS,
        }
    })


@app.route("/profile/me", methods=["POST"])
def profile_update():
    data = request.get_json(silent=True) or {}
    return jsonify({"profile": avatar_core.update_profile(data)})


@app.route("/sync", methods=["POST"])
def sync_item():
    """my-dashboard 항목을 KG에 동기화"""
    data = request.get_json(silent=True) or {}
    source    = data.get("source", "note")
    source_id = data.get("source_id", "")
    title     = data.get("title", "")
    content   = data.get("content", "")
    if not source_id or not content:
        return jsonify({"error": "source_id, content 필요"}), 400
    is_new = avatar_core.sync_item(source, source_id, title, content)
    return jsonify({"success": True, "new": is_new})


@app.route("/sync/list", methods=["GET"])
def sync_list():
    source = request.args.get("source", "")
    return jsonify({"items": avatar_core.list_synced(source, int(request.args.get("limit", 50)))})


@app.route("/memory", methods=["GET"])
def memory_list():
    """핵심 기억(자유형식 사실) 목록 — 매 아바타 프롬프트에 항상 주입됨"""
    return jsonify({"items": avatar_core.list_memory()})


@app.route("/memory", methods=["POST"])
def memory_add():
    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "content required"}), 400
    mid = avatar_core.add_memory(content)
    return jsonify({"id": mid})


@app.route("/memory/<mid>", methods=["DELETE"])
def memory_delete(mid):
    avatar_core.delete_memory(mid)
    return jsonify({"success": True})


# ── 자문자답(암묵지) 캡처 ──────────────────────────────
# 전적으로 사용자가 원할 때만 호출됨(질문 받기 버튼) — 자동/주기 넛지 없음.

@app.route("/interview/question", methods=["GET"])
def interview_question():
    """다음 자문자답 질문 하나를 생성 (내 지식 심화형).

    topic 지정 시 그 주제로 고정, focus는 '헷갈리는 부분' 같은 초점 힌트. 둘 다 선택.
    """
    topic = request.args.get("topic", "")
    focus = request.args.get("focus", "")
    try:
        return jsonify(self_interview.generate_question(topic, focus))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/interview/answer", methods=["POST"])
def interview_answer():
    """질문+답을 self_interview 지식으로 저장 (KG 노드 + 임베딩 + 엔티티 추출)."""
    data = request.get_json(silent=True) or {}
    question = (data.get("question") or "").strip()
    answer = (data.get("answer") or "").strip()
    topic = (data.get("topic") or "").strip()
    if not question or not answer:
        return jsonify({"error": "question and answer required"}), 400
    try:
        return jsonify(self_interview.save_answer(question, answer, topic))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/interview/list", methods=["GET"])
def interview_list():
    return jsonify({"items": self_interview.list_interviews(), "count": self_interview.count()})


@app.route("/interview/<sid>", methods=["DELETE"])
def interview_delete(sid):
    self_interview.delete_interview(sid)
    return jsonify({"success": True})


# ── 아바타 대화 자동 노트 (my-dashboard 노트와는 별개 저장소) ──────────

@app.route("/notes", methods=["GET"])
def notes_list():
    q = request.args.get("q", "")
    view = request.args.get("view", "")
    limit = int(request.args.get("limit", 50))
    return jsonify({"items": notes.list_notes(query=q, view=view, limit=limit), "count": notes.count()})


@app.route("/notes/<nid>", methods=["DELETE"])
def notes_delete(nid):
    notes.delete_note(nid)
    return jsonify({"success": True})


@app.route("/avatar/context", methods=["GET"])
def avatar_context():
    q = request.args.get("q", "")
    verbosity = request.args.get("verbosity", "concise")
    return jsonify(avatar_core.build_avatar_context(q, verbosity=verbosity))


@app.route("/conversation/log", methods=["POST"])
def conversation_log():
    """채팅 turn 저장 — 말투 학습의 원재료"""
    data = request.get_json(silent=True) or {}
    view    = data.get("view", "unknown")
    role    = data.get("role", "")
    content = data.get("content", "")
    if role not in ("user", "assistant") or not content:
        return jsonify({"error": "view, role(user|assistant), content 필요"}), 400
    avatar_core.log_conversation(view, role, content)

    # 아바타 답변 턴마다 방금 주고받은 사용자 질문+답을 판단해 노트 자동 생성 (LLM 호출이라 백그라운드로)
    if role == "assistant":
        def _maybe_note():
            try:
                prev_user = avatar_core.recent_conversations(limit=1, view=view, role="user")
                user_msg = prev_user[0]["content"] if prev_user else ""
                notes.maybe_create_note(view, user_msg, content)
            except Exception as e:
                print(f"[notes] 자동 노트 생성 실패(무시): {e}")
        _threading.Thread(target=_maybe_note, daemon=True).start()

    return jsonify({"success": True})


@app.route("/conversation/history", methods=["GET"])
def conversation_history():
    """특정 화면(view)의 최근 대화 — 새로고침/재방문 시 이어보기용"""
    view = request.args.get("view", "")
    limit = int(request.args.get("limit", 50))
    since = request.args.get("since", "")
    rows = avatar_core.recent_conversations(limit=limit, view=view, since=since)
    rows.reverse()  # 오래된 것부터
    return jsonify({"messages": [{"role": r["role"], "content": r["content"]} for r in rows]})


@app.route("/conversation/style_analysis", methods=["GET"])
def conversation_style_analysis():
    """최근 대화에서 말투/성격/톤을 추정 (학습 루프 1단계: 제안)"""
    limit = int(request.args.get("limit", 40))
    return jsonify(avatar_core.analyze_speech_style(limit))


@app.route("/conversation/style_apply", methods=["POST"])
def conversation_style_apply():
    """학습된 말투 제안을 프로파일에 반영 (학습 루프 2단계: 적용)"""
    data = request.get_json(silent=True) or {}
    return jsonify({"profile": avatar_core.apply_style_suggestion(data)})


@app.route("/preference/analyze", methods=["GET"])
def preference_analyze():
    """최근 대화+KG 토픽에서 MBTI/성격/선호도 추정 (자동측정 루프 1단계: 제안)"""
    limit = int(request.args.get("limit", 60))
    return jsonify(avatar_core.analyze_preference(limit))


@app.route("/preference/apply", methods=["POST"])
def preference_apply():
    """추정된 preference 제안을 프로파일에 반영 (자동측정 루프 2단계: 적용)"""
    data = request.get_json(silent=True) or {}
    return jsonify({"profile": avatar_core.apply_preference_suggestion(data)})


@app.route("/preference/analyze_and_apply", methods=["POST"])
def preference_analyze_and_apply():
    """주기적 자동측정용 — 분석+적용을 한 번에 (watcher가 주기마다 호출)"""
    limit = int((request.get_json(silent=True) or {}).get("limit", 60))
    return jsonify(avatar_core.analyze_and_apply_preference(limit))


@app.route("/preference/due", methods=["GET"])
def preference_due_check():
    """설정된 측정 주기(preference_interval_days) 기준으로 지금 자동측정이 필요한지"""
    return jsonify({"due": avatar_core.preference_due()})


@app.route("/preference/radar", methods=["GET"])
def preference_radar():
    """Big Five 5축 직접입력 vs 자동측정 점수 + 차이 — 레이더 차트 비교용"""
    return jsonify(avatar_core.preference_radar())


@app.route("/profile/behavior", methods=["GET"])
def profile_behavior():
    """행동 데이터 집계 — 파일 열기, 검색, 노드 접근 이력"""
    from db.init_db import get_conn as _conn
    days = int(request.args.get("days", 30))
    conn = _conn()
    since = f"datetime('now', '-{days} days', 'localtime')"

    # 파일 열기 이력
    opens = conn.execute(f"""
        SELECT context as path, COUNT(*) as cnt,
               MAX(timestamp) as last_open
        FROM activity_log WHERE action='file_open'
        AND timestamp >= {since}
        GROUP BY context ORDER BY cnt DESC LIMIT 20
    """).fetchall()

    # 검색 키워드 이력
    searches = conn.execute(f"""
        SELECT context as query, COUNT(*) as cnt
        FROM activity_log WHERE action='search'
        AND timestamp >= {since}
        GROUP BY context ORDER BY cnt DESC LIMIT 20
    """).fetchall()

    # 시간대별 활동 분포
    hourly = conn.execute(f"""
        SELECT strftime('%H', timestamp) as hour, COUNT(*) as cnt
        FROM activity_log WHERE timestamp >= {since}
        GROUP BY hour ORDER BY hour
    """).fetchall()

    # 토픽 접근 패턴
    topics = conn.execute(f"""
        SELECT t.name, COUNT(al.id) as access_cnt,
               MAX(al.timestamp) as last_access
        FROM activity_log al
        JOIN nodes n ON al.node_id = n.id
        JOIN node_topics nt ON nt.node_id = n.id
        JOIN topics t ON t.id = nt.topic_id
        WHERE al.timestamp >= {since}
        GROUP BY t.id ORDER BY access_cnt DESC LIMIT 15
    """).fetchall()

    # 소스 타입별 관심도
    source_pref = conn.execute(f"""
        SELECT context, COUNT(*) as cnt
        FROM activity_log WHERE action='file_open'
        AND timestamp >= {since}
        GROUP BY substr(context, -4)
    """).fetchall()

    conn.close()
    return jsonify({
        "days": days,
        "file_opens": [dict(r) for r in opens],
        "searches": [dict(r) for r in searches],
        "hourly_activity": [dict(r) for r in hourly],
        "topic_access": [dict(r) for r in topics],
        "source_preference": [dict(r) for r in source_pref],
    })


PREFERENCE_PROMPT = """당신은 한 사람의 행동 데이터를 분석하는 전문가입니다.
아래는 최근 {days}일간의 행동 패턴입니다.

자주 열어본 파일:
{file_opens}

자주 검색한 키워드:
{searches}

시간대별 활동 (시간: 횟수):
{hourly}

자주 접근한 토픽:
{topics}

이 데이터를 바탕으로 이 사람의 성향을 분석해주세요.

아래 항목들을 한국어로, 구체적이고 통찰력 있게 작성하세요:

## 주요 관심 분야
(가장 깊이 파고드는 도메인과 그 증거)

## 업무 스타일
(기술적 깊이 vs 큰 그림, 혼자 해결 vs 레퍼런스 활용 등)

## 집중 시간대
(언제 가장 활발한지, 그 패턴의 의미)

## 현재 몰두하는 것
(최근 데이터 기반으로 지금 가장 집중하는 문제)

## 지식 갭 & 성장 방향
(자주 검색하지만 아직 깊지 않은 영역)

근거가 없는 추측은 하지 말고, 데이터에서 직접 보이는 것만 기반으로 분석하세요."""


@app.route("/profile/analysis", methods=["GET"])
def profile_analysis():
    """LLM 기반 성향 분석 리포트 생성"""
    import json
    from db.init_db import get_conn as _conn
    days = int(request.args.get("days", 30))
    conn = _conn()
    since = f"datetime('now', '-{days} days', 'localtime')"

    opens = conn.execute(f"SELECT context, COUNT(*) c FROM activity_log WHERE action='file_open' AND timestamp>={since} GROUP BY context ORDER BY c DESC LIMIT 10").fetchall()
    searches = conn.execute(f"SELECT context, COUNT(*) c FROM activity_log WHERE action='search' AND timestamp>={since} GROUP BY context ORDER BY c DESC LIMIT 10").fetchall()
    hourly = conn.execute(f"SELECT strftime('%H',timestamp) h, COUNT(*) c FROM activity_log WHERE timestamp>={since} GROUP BY h ORDER BY h").fetchall()
    topics = conn.execute(f"""
        SELECT t.name, COUNT(al.id) c FROM activity_log al
        JOIN nodes n ON al.node_id=n.id
        JOIN node_topics nt ON nt.node_id=n.id
        JOIN topics t ON t.id=nt.topic_id
        WHERE al.timestamp>={since} GROUP BY t.id ORDER BY c DESC LIMIT 10
    """).fetchall()
    conn.close()

    prompt = PREFERENCE_PROMPT.format(
        days=days,
        file_opens="\n".join(f"- {r['context']} ({r['c']}회)" for r in opens) or "(없음)",
        searches="\n".join(f"- {r['context']} ({r['c']}회)" for r in searches) or "(없음)",
        hourly=", ".join(f"{r['h']}시:{r['c']}" for r in hourly) or "(없음)",
        topics="\n".join(f"- {r['name']} ({r['c']}회)" for r in topics) or "(없음)",
    )

    try:
        from core import claude_mcp
        if claude_mcp.is_available():
            analysis = claude_mcp.chat([{"role": "user", "content": prompt}])
        else:
            raise RuntimeError("MCP 불가")
    except Exception:
        analysis = "(Claude 연결 필요 — MCP 또는 API 키 설정 후 분석 가능)"

    return jsonify({"days": days, "analysis": analysis})


@app.route("/subjects", methods=["GET"])
def subjects_list():
    return jsonify({"subjects": queue_mgr.list_subjects()})


@app.route("/subjects", methods=["POST"])
def subjects_create():
    data = request.get_json(silent=True) or {}
    name = data.get("name", "").strip()
    folder = data.get("folder_path", "").strip()
    if not name:
        return jsonify({"error": "name 필요"}), 400
    if not folder:
        folder = os.path.join(queue_mgr.DOCS_DIR, name)
        os.makedirs(folder, exist_ok=True)
    result = queue_mgr.create_subject(name, folder, data.get("description", ""), int(data.get("priority", 5)))
    if result["created"]:
        queue_mgr.scan_subject(result["id"])
    return jsonify(result)


@app.route("/subjects/<sid>", methods=["DELETE"])
def subjects_delete(sid):
    queue_mgr.delete_subject(sid)
    return jsonify({"success": True})


@app.route("/subjects/<sid>/scan", methods=["POST"])
def subjects_scan(sid):
    return jsonify(queue_mgr.scan_subject(sid))


@app.route("/subjects/discover", methods=["POST"])
def subjects_discover():
    return jsonify(queue_mgr.auto_discover_subjects())


@app.route("/project/scan", methods=["POST"])
def project_scan_route():
    """폴더 경로를 지정해 코드+md 파일 구조/overview/summary/git변경사항을 생성 (수동 트리거)."""
    data = request.get_json(silent=True) or {}
    folder = data.get("folder_path", "").strip()
    name = data.get("name", "").strip()
    if not folder:
        return jsonify({"error": "folder_path 필요"}), 400
    try:
        result = project_scan.generate_project_summary(folder, name)
        return jsonify(result)
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/project/list", methods=["GET"])
def project_list_route():
    return jsonify({"projects": project_scan.list_projects()})


@app.route("/project/<pid>", methods=["GET"])
def project_get_route(pid):
    proj = project_scan.get_project(pid)
    if not proj:
        return jsonify({"error": "not found"}), 404
    return jsonify(proj)


@app.route("/project/<pid>", methods=["DELETE"])
def project_delete_route(pid):
    project_scan.delete_project(pid)
    return jsonify({"success": True})


@app.route("/project/<pid>/graphify_mark", methods=["POST"])
def project_graphify_mark_route(pid):
    """Graphify 처리가 끝난 뒤 프론트가 호출 — 이 프로젝트를 '처리됨'으로 표시"""
    project_scan.mark_graphified(pid)
    return jsonify({"success": True})


@app.route("/project/graphify_mark_all", methods=["POST"])
def project_graphify_mark_all_route():
    """일괄 Graphify 처리가 끝난 뒤 호출 — 전체 프로젝트를 '처리됨'으로 표시"""
    project_scan.mark_graphified()
    return jsonify({"success": True})


@app.route("/project/<pid>/refresh", methods=["POST"])
def project_refresh_route(pid):
    proj = project_scan.get_project(pid)
    if not proj:
        return jsonify({"error": "not found"}), 404
    try:
        result = project_scan.generate_project_summary(proj["folder_path"], proj["name"])
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/project/<pid>/open_folder", methods=["POST"])
def project_open_folder_route(pid):
    """등록된 프로젝트의 folder_path를 OS 탐색기로 열기 (Windows)"""
    proj = project_scan.get_project(pid)
    if not proj:
        return jsonify({"error": "not found"}), 404
    folder = proj["folder_path"]
    if not os.path.isdir(folder):
        return jsonify({"error": "폴더 없음"}), 404
    try:
        _open_in_explorer(folder)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/project/open_folder_path", methods=["POST"])
def project_open_folder_path_route():
    """입력란에 타이핑한 폴더 경로를 탐색기로 열기. 경로가 비어 있으면 기본 탐색기 창을 그냥 띄운다."""
    data = request.get_json(silent=True) or {}
    folder = data.get("folder_path", "").strip()
    if folder and not os.path.isdir(folder):
        return jsonify({"error": "폴더 없음"}), 404
    try:
        _open_in_explorer(folder or None)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/project/pick_folder", methods=["POST"])
def project_pick_folder_route():
    """네이티브 다이얼로그로 폴더 선택 → 경로 반환 (프론트에서 즉시 스캔해 폴더 정보를 보여준다)."""
    try:
        path = _pick_path("folder")
        return jsonify({"path": path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/project/pick_file", methods=["POST"])
def project_pick_file_route():
    """네이티브 다이얼로그로 파일 선택 → 그 파일이 속한 폴더 경로를 반환한다
    (폴더 안 임의의 파일 하나만 골라도 그 폴더 전체 정보를 바로 볼 수 있도록)."""
    try:
        path = _pick_path("file")
        if not path:
            return jsonify({"path": None})
        folder = str(Path(path).parent)
        return jsonify({"path": path, "folder_path": folder})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/queue", methods=["GET"])
def queue_list():
    sid = request.args.get("subject_id", "")
    status = request.args.get("status", "")
    return jsonify({"items": queue_mgr.list_queue(sid, status)})


@app.route("/queue/process", methods=["POST"])
def queue_process():
    data  = request.get_json(silent=True) or {}
    sid   = data.get("subject_id", "")
    limit = int(data.get("limit", 5))
    result = queue_mgr.process_next(sid, limit)

    # 큐 처리로 새 파일이 완료되면 Graphify 자동 트리거
    if result.get("done", 0) > 0 and not _graphify_job.get("running"):
        _graphify_job.update({"running": True, "stage": "시작", "error": ""})
        t = _threading.Thread(target=_grunner.run_graphify, args=(_graphify_job,), daemon=True)
        t.start()
        result["graphify_triggered"] = True

    return jsonify(result)


@app.route("/queue/reset_errors", methods=["POST"])
def queue_reset_errors():
    sid = (request.get_json(silent=True) or {}).get("subject_id", "")
    affected = queue_mgr.reset_errors(sid)
    return jsonify({"success": True, "affected": affected})


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "port": 8766})


# 워처(watcher/file_watcher.py)가 2초마다 갱신하는 하트비트 파일 — 90초(45회분) 이상
# 안 갱신되면 죽은 것으로 판단(1~2회 지연은 큐/백업 처리 중일 수 있어 여유를 둠)
WATCHER_HEARTBEAT = Path(__file__).parent.parent / "tmp" / "watcher_heartbeat.json"
WATCHER_STALE_SEC = 90


WATCHER_SCRIPT      = Path(__file__).parent.parent / "watcher" / "file_watcher.py"
_watcher_process    = None
_watcher_lock       = _threading.Lock()


def _humanize_ago(secs: float) -> str:
    """경과 초를 사람이 읽는 한국어로. 몇 초 전인지 며칠 전인지가 한눈에 구분돼야 한다."""
    if secs < 60:
        return f"{int(secs)}초 전"
    if secs < 3600:
        return f"{int(secs // 60)}분 전"
    if secs < 86400:
        return f"{int(secs // 3600)}시간 전"
    return f"{secs / 86400:.1f}일 전"


def _watcher_state() -> dict:
    """하트비트 파일로 워처 생존을 판단한다. {alive, seconds_ago?, pid?, reason?}"""
    if not WATCHER_HEARTBEAT.exists():
        return {"alive": False, "reason": "하트비트 파일 없음(워처 미실행 또는 구버전)"}
    try:
        info = json.loads(WATCHER_HEARTBEAT.read_text(encoding="utf-8"))
        age = time.time() - info.get("ts", 0)
    except Exception as e:
        return {"alive": False, "reason": f"하트비트 읽기 실패: {e}"}
    return {
        "alive": age < WATCHER_STALE_SEC,
        "seconds_ago": round(age, 1),
        "pid": info.get("pid"),
    }


def _ensure_watcher() -> dict:
    """워처가 죽어 있으면 백그라운드로 다시 띄운다. 살아 있으면 아무 것도 안 함.

    XTTS 워커와 달리 워처에는 그동안 자동복구가 없어서, 한 번 죽으면 아무도 모른 채
    문서 ingest와 시간별 백업이 통째로 멈춰 있었다(실제로 7일간 정지한 적 있음).
    중복 기동은 하트비트로 막는다 — start_dashboard.bat이 이미 띄웠으면 여기서 안 띄운다.
    """
    global _watcher_process
    with _watcher_lock:
        if _watcher_state()["alive"]:
            return {"status": "already_running"}
        if _watcher_process is not None and _watcher_process.poll() is None:
            return {"status": "starting", "pid": _watcher_process.pid}
        try:
            AVATAR_TMP.mkdir(parents=True, exist_ok=True)
            log_path = AVATAR_TMP / "watcher.log"
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            with open(log_path, "ab") as log_f:
                _watcher_process = subprocess.Popen(
                    [PYTHON_EXE, str(WATCHER_SCRIPT)],
                    stdout=log_f, stderr=log_f,
                    creationflags=creationflags,
                    cwd=str(WATCHER_SCRIPT.parent.parent),
                )
            print(f"[watcher] 워처가 꺼져있어 새로 기동합니다 (로그: {log_path})", flush=True)
            return {"status": "starting", "log": str(log_path)}
        except Exception as e:
            print(f"[watcher] 기동 실패: {e}", flush=True)
            return {"status": "error", "detail": str(e)}


def _watcher_watchdog_loop():
    """2분마다 워처 생존을 확인하고, 죽어있으면 자동으로 다시 띄운다(_xtts_watchdog_loop와 동일 패턴).

    첫 확인을 바로 하지 않고 한 주기 쉬고 시작하는 이유: 부팅 시 start_dashboard.bat이
    워처를 띄우는데, 서버가 먼저 떠서 곧바로 확인하면 아직 하트비트가 없어 중복 기동이 된다.
    """
    while True:
        time.sleep(120)
        try:
            if not _watcher_state()["alive"]:
                _ensure_watcher()
        except Exception as e:
            print(f"[watcher-watchdog] 오류: {e}", flush=True)


@app.route("/watcher/health", methods=["GET"])
def watcher_health():
    return jsonify(_watcher_state())


@app.route("/watcher/restart", methods=["POST"])
def watcher_restart():
    """사용자가 배너에서 '다시 시작'을 눌렀을 때 — 꺼진 워처를 백그라운드로 다시 띄운다."""
    return jsonify(_ensure_watcher())


def _active_background_jobs() -> list:
    """얼굴교체·아바타 영상 생성·YouTube 다운로드·발표 자료 처리 중 아직 끝나지 않은 작업을
    전부 모은다. 서버 재시작이 이 중 하나라도 중간에 끊어버리지 않도록 확인하는 용도."""
    active = []
    for job_id, job in _faceswap_jobs.items():
        if job.get("stage") not in ("done", "error", "canceled"):
            active.append(("얼굴교체", job_id))
    for job_id, job in _avatar_jobs.items():
        if job.get("stage") not in ("done", "error"):
            active.append(("아바타 영상 생성", job_id))
    for job_id, job in _ytdl_jobs.items():
        if job.get("stage") not in ("done", "error"):
            active.append(("YouTube 다운로드", job_id))
    for job_id, job in _presenter_jobs.items():
        if job.get("stage") not in ("done", "error"):
            active.append(("발표 자료 처리", job_id))
    return active


@app.route("/server/restart", methods=["POST"])
def server_restart():
    """현재 API 프로세스를 안전하게 종료하고 같은 인터프리터로 재시작한다."""
    active_jobs = _active_background_jobs()
    if active_jobs:
        kinds = ", ".join(sorted({kind for kind, _ in active_jobs}))
        return jsonify({"error": f"다음 작업이 진행 중입니다: {kinds}. 작업 완료 후 서버를 재시작해주세요."}), 409
    server_script = str(Path(__file__).resolve())

    def _restart_later():
        time.sleep(1.0)
        # 부모가 포트를 놓은 뒤 새 서버를 띄우도록 별도 프로세스에서 대기한다.
        launcher = (
            "import os,time; time.sleep(2); "
            f"os.execv({PYTHON_EXE!r}, [{PYTHON_EXE!r}, {server_script!r}])"
        )
        subprocess.Popen(
            [PYTHON_EXE, "-c", launcher],
            cwd=str(Path(__file__).parent.parent),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        os._exit(0)

    _threading.Thread(target=_restart_later, daemon=True).start()
    return jsonify({"status": "restarting"})


# ── 백업 / 복원 ──────────────────────────────────────────────
import sqlite3 as _sqlite3
import base64 as _base64

@app.route("/backup", methods=["GET"])
def backup():
    """KG DB + 프로필 데이터를 JSON으로 내보내기"""
    from db.init_db import DB_PATH
    result: dict = {}

    # SQLite DB를 base64로 인코딩해서 첨부
    try:
        db_path = Path(DB_PATH)
        if db_path.exists():
            result["db_base64"] = _base64.b64encode(db_path.read_bytes()).decode()
            result["db_filename"] = db_path.name
    except Exception as e:
        result["db_error"] = str(e)

    # 프로필/아바타 메타 데이터
    try:
        conn = _sqlite3.connect(DB_PATH)
        conn.row_factory = _sqlite3.Row
        cur = conn.cursor()

        tables: dict = {}
        cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
        for (tname,) in cur.fetchall():
            cur.execute(f"SELECT * FROM {tname}")
            tables[tname] = [dict(r) for r in cur.fetchall()]
        result["tables"] = tables
        conn.close()
    except Exception as e:
        result["tables_error"] = str(e)

    # 첨부 파일 메타 (data/ 폴더의 face.jpg, voice_sample.wav 등)
    data_dir = Path(__file__).parent.parent / "data"
    files_meta = []
    if data_dir.exists():
        for f in data_dir.iterdir():
            if f.is_file() and f.suffix.lower() in ('.jpg', '.jpeg', '.png', '.wav', '.mp3'):
                try:
                    files_meta.append({
                        "name": f.name,
                        "size": f.stat().st_size,
                        "content_base64": _base64.b64encode(f.read_bytes()).decode(),
                    })
                except Exception as e:
                    files_meta.append({"name": f.name, "size": f.stat().st_size, "error": str(e)})
    result["data_files"] = files_meta

    # tmp/avatar(얼굴교체·TTS·발표녹화 결과)는 재생성 가능한 산출물이라 백업 대상에서 제외한다.
    # 대신 _cleanup_tmp()의 history 용량 상한(AVATAR_HISTORY_MAX_BYTES)으로 디스크만 관리한다.

    return jsonify(result)


@app.route("/restore", methods=["POST"])
def restore():
    """백업 JSON에서 KG DB 복원"""
    from db.init_db import DB_PATH
    payload = request.get_json(silent=True) or {}

    restored = []
    backup_dir = None

    # DB 복원 (base64)
    db_b64 = payload.get("db_base64")
    if db_b64:
        try:
            backup_dir = _backup_db("pre_restore")
        except Exception as e:
            return jsonify({"success": False, "error": f"백업 실패로 복원을 중단했습니다: {e}"}), 500
        try:
            db_bytes = _base64.b64decode(db_b64)
            db_path = Path(DB_PATH)
            db_path.parent.mkdir(parents=True, exist_ok=True)
            db_path.write_bytes(db_bytes)
            restored.append("db")
        except Exception as e:
            return jsonify({"success": False, "error": f"DB 복원 실패: {e}"}), 500

    data_files = payload.get("data_files") or []
    data_dir = Path(__file__).parent.parent / "data"
    allowed_ext = {".jpg", ".jpeg", ".png", ".wav", ".mp3"}
    for item in data_files:
        try:
            name = Path(str(item.get("name", ""))).name
            if not name or Path(name).suffix.lower() not in allowed_ext:
                continue
            content = item.get("content_base64")
            if not content:
                continue
            data_dir.mkdir(parents=True, exist_ok=True)
            (data_dir / name).write_bytes(_base64.b64decode(content))
            restored.append(f"data/{name}")
        except Exception as e:
            return jsonify({"success": False, "error": f"미디어 복원 실패: {e}"}), 500

    return jsonify({"success": True, "restored": restored, "backup_dir": backup_dir})


# ── STT (faster-whisper) ──────────────────────────────────
_whisper_model = None
# WhisperModel(CTranslate2)은 동시 transcribe 호출에 안전하지 않다 — Flask threaded=True에서
# VAD가 STT 요청을 연달아 보내면 같은 모델을 동시 호출해 네이티브 크래시가 난다. 락으로 직렬화.
_whisper_lock = _threading.Lock()
# 모델 로드 자체를 직렬화(부팅 워밍업 스레드 + 첫 요청이 동시에 로드 → 메모리 이중 점유 방지)
_whisper_load_lock = _threading.Lock()
# 프론트가 "준비 중/실패"를 사용자에게 안내할 수 있도록 로드 상태를 노출한다.
_whisper_status = {"state": "idle", "detail": ""}  # idle | loading | ready | error

def _get_whisper():
    global _whisper_model
    if _whisper_model is not None:
        return _whisper_model
    with _whisper_load_lock:
        if _whisper_model is not None:
            return _whisper_model
        _whisper_status.update(state="loading", detail="")
        from faster_whisper import WhisperModel
        # GPU(CTranslate2)는 onnxruntime과 무관 — 임베딩을 CPU로 격리한 뒤로 안전. CPU(5.7s) 대비 ~0.5s.
        # CUDA 로드 실패 시 CPU로 폴백.
        try:
            model = WhisperModel("small", device="cuda", compute_type="float16")
        except Exception as e:
            print(f"[whisper] CUDA 로드 실패, CPU 폴백: {e}")
            try:
                model = WhisperModel("small", device="cpu", compute_type="int8")
            except Exception as e2:
                _whisper_status.update(state="error", detail=str(e2)[:200])
                print(f"[whisper] CPU 폴백도 실패: {e2}", flush=True)
                raise
        _whisper_model = model
        _whisper_status.update(state="ready", detail="")
    return _whisper_model

STT_TMP = Path(__file__).parent.parent / "tmp" / "stt"

@app.route("/stt/transcribe", methods=["POST"])
def stt_transcribe():
    """오디오 파일 → 텍스트 변환 (faster-whisper)"""
    audio = request.files.get("audio")
    if not audio:
        return jsonify({"error": "audio 필요"}), 400

    STT_TMP.mkdir(parents=True, exist_ok=True)
    ext = Path(audio.filename or "audio.webm").suffix or ".webm"
    tmp_in  = STT_TMP / f"{uuid.uuid4().hex}{ext}"
    tmp_wav = STT_TMP / f"{uuid.uuid4().hex}.wav"
    audio.save(str(tmp_in))

    # webm/ogg → wav 변환 (ffmpeg)
    ffmpeg = str(SADTALKER_DIR / "ffmpeg.exe")
    try:
        subprocess.run(
            [ffmpeg, "-y", "-i", str(tmp_in), "-ar", "16000", "-ac", "1", str(tmp_wav)],
            check=True, capture_output=True, timeout=30
        )
    except Exception as e:
        tmp_in.unlink(missing_ok=True)
        return jsonify({"error": f"오디오 변환 실패: {e}"}), 500
    finally:
        tmp_in.unlink(missing_ok=True)

    try:
        model = _get_whisper()
        with _whisper_lock:   # 동시 호출 직렬화 (네이티브 크래시 방지)
            segments, info = model.transcribe(str(tmp_wav), language="ko", beam_size=5)
            text = " ".join(seg.text.strip() for seg in segments).strip()
            language = info.language
        return jsonify({"text": text, "language": language})
    except Exception as e:
        return jsonify({"error": f"STT 실패: {e}"}), 500
    finally:
        tmp_wav.unlink(missing_ok=True)


# ── Avatar Studio ────────────────────────────────────────────
SADTALKER_DIR   = config.SADTALKER_DIR
AVATAR_TMP      = Path(__file__).parent.parent / "tmp" / "avatar"
AVATAR_DATA     = Path(__file__).parent.parent / "data"
VOICE_SAMPLE    = AVATAR_DATA / "voice_sample.wav"
PYTHON_EXE      = config.AVATAR_PYTHON   # SadTalker (numpy 1.26 패치판)
XTTS_PYTHON_EXE = config.XTTS_PYTHON     # Coqui XTTS v2
XTTS_SERVER_SCRIPT = Path(__file__).parent / "xtts_server.py"
_xtts_worker_lock = _threading.Lock()
_xtts_worker_process = None
_xtts_paused_for_gpu = False


def _pause_xtts_for_gpu() -> bool:
    """GPU 얼굴교체 동안 XTTS 상주 모델을 내려 VRAM을 확보한다."""
    global _xtts_paused_for_gpu, _xtts_worker_process
    with _xtts_worker_lock:
        _xtts_paused_for_gpu = True
        process = _xtts_worker_process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        _xtts_worker_process = None
    print("[xtts] GPU 얼굴교체를 위해 워커를 일시 중지했습니다.", flush=True)
    return True


def _resume_xtts_after_gpu() -> None:
    """GPU 얼굴교체 후 XTTS 워커를 다시 올린다."""
    global _xtts_paused_for_gpu
    _xtts_paused_for_gpu = False
    _ensure_xtts_worker()
    print("[xtts] GPU 얼굴교체 종료 — 워커 재기동 요청", flush=True)


def _xtts_worker_alive(timeout: float = 1.5) -> bool:
    """상주 XTTS 워커(8768)가 응답하는지 확인."""
    import urllib.request
    try:
        with urllib.request.urlopen("http://127.0.0.1:8768/health", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def _xtts_synthesize(text: str, speaker=None, speaker_wav=None, timeout: float = 180):
    """Synthesize through the resident XTTS worker; never load XTTS per request."""
    import json as _json
    import urllib.request as _urlreq

    if _xtts_paused_for_gpu:
        return None
    _ensure_xtts_worker()
    deadline = time.time() + min(timeout, 180)
    while time.time() < deadline and not _xtts_worker_alive():
        time.sleep(2)
    if not _xtts_worker_alive():
        return None

    payload = _json.dumps({
        "text": text,
        "speaker": speaker,
        "speaker_wav": speaker_wav,
        "language": "ko",
    }).encode()
    req = _urlreq.Request(
        "http://127.0.0.1:8768/tts",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with _urlreq.urlopen(req, timeout=timeout) as response:
        if response.status != 200:
            return None
        return response.read()


def _ensure_xtts_worker() -> dict:
    """XTTS 상주 워커가 꺼져 있으면 백그라운드로 새로 띄운다. 이미 떠 있으면 아무 것도 안 함.
    모델 로딩에 ~1분 걸리므로 호출 직후 바로 쓸 수 있다는 뜻은 아니다 — 몇 초~1분 뒤부터
    tts_only 요청이 다시 빠르게(2~3초) 성공한다."""
    global _xtts_worker_process
    if _xtts_paused_for_gpu:
        return {"status": "paused_for_gpu"}
    with _xtts_worker_lock:
        if _xtts_worker_alive():
            return {"status": "already_running"}
        if _xtts_worker_process is not None and _xtts_worker_process.poll() is None:
            return {"status": "starting", "pid": _xtts_worker_process.pid}
        try:
            AVATAR_TMP.mkdir(parents=True, exist_ok=True)
            log_path = AVATAR_TMP / "xtts_worker.log"
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            # with로 열어 Popen이 핸들을 자식에 상속시킨 뒤 부모 쪽 핸들은 즉시 닫는다.
            # (매 재기동마다 파일 핸들이 새는 것을 방지)
            with open(log_path, "ab") as log_f:
                _xtts_worker_process = subprocess.Popen(
                    [XTTS_PYTHON_EXE, str(XTTS_SERVER_SCRIPT)],
                    stdout=log_f, stderr=log_f,
                    creationflags=creationflags,
                    cwd=str(XTTS_SERVER_SCRIPT.parent),
                )
            print("[xtts] 워커가 꺼져있어 새로 기동합니다 (로그: %s)" % log_path, flush=True)
            return {"status": "starting", "log": str(log_path)}
        except Exception as e:
            print(f"[xtts] 워커 기동 실패: {e}", flush=True)
            return {"status": "error", "detail": str(e)}


def _xtts_watchdog_loop():
    """2분마다 워커 생존을 확인하고, 죽어있으면 자동으로 다시 띄운다."""
    while True:
        time.sleep(120)
        try:
            if not _xtts_paused_for_gpu and not _xtts_worker_alive():
                _ensure_xtts_worker()
        except Exception as e:
            print(f"[xtts-watchdog] 오류: {e}", flush=True)


@app.route("/avatar/xtts/status", methods=["GET"])
def avatar_xtts_status():
    return jsonify({"running": _xtts_worker_alive()})


@app.route("/avatar/xtts/ensure", methods=["POST"])
def avatar_xtts_ensure():
    return jsonify(_ensure_xtts_worker())


FACE_IMAGE_MAX_SIDE = 1024  # 이 이상이면 SadTalker 랜드마크 검출이 실패하는 게 실측 확인됨


def _strip_tts_markup(text: str) -> str:
    """Remove stage directions and markup that should not be spoken by TTS."""
    result = text or ""
    bracket_pairs = [
        ("(", ")"),
        ("（", "）"),
        ("[", "]"),
        ("【", "】"),
        ("{", "}"),
        ("<", ">"),
    ]
    changed = True
    while changed:
        changed = False
        for open_ch, close_ch in bracket_pairs:
            pattern = _re.escape(open_ch) + r"[^" + _re.escape(open_ch + close_ch) + r"]*" + _re.escape(close_ch)
            next_result = _re.sub(pattern, " ", result)
            if next_result != result:
                changed = True
            result = next_result
    result = _re.sub(r"^\s*[\-\*\u00b7\u2022\u2013\u2014]+\s*", " ", result)
    return _re.sub(r"\s+", " ", result).strip()


def _save_face_image(file_storage, dest_path) -> None:
    """업로드된 얼굴 사진을 저장 + EXIF 방향 반영 + 과대 해상도 축소.
    폰카메라 원본(수천만 화소, EXIF Orientation 태그만 있고 실제 픽셀은 안 돌아간 상태)을
    그대로 넘기면 SadTalker에서 실패한다 — 실측(2026-07-04)으로 원인 2가지 모두 확인:
      1) 고해상도(6.5MP 등) 자체만으로 초기 얼굴 랜드마크 검출(croper.py)이 통째로 실패
         (실패 시 SadTalker가 문자열을 raise하는 버그 때문에 TypeError로 위장되어 나옴)
      2) EXIF 회전 미반영 상태로는(리사이즈만 해도) 랜드마크는 찾아도 이후 합성 단계
         (paste_pic.py의 cv2.seamlessClone)에서 크롭 좌표가 어긋나 별도로 크래시
    두 처리를 모두 해야 안전해서 저장 시점에 함께 적용."""
    file_storage.save(str(dest_path))
    try:
        from PIL import Image, ImageOps
        img = Image.open(dest_path)
        fixed = ImageOps.exif_transpose(img)
        w, h = fixed.size
        if max(w, h) > FACE_IMAGE_MAX_SIDE:
            scale = FACE_IMAGE_MAX_SIDE / max(w, h)
            fixed = fixed.resize((round(w * scale), round(h * scale)), Image.LANCZOS)
        fixed.save(dest_path)
    except Exception as e:
        print(f"[avatar] 얼굴 사진 전처리(EXIF/리사이즈) 실패(무시하고 원본 사용): {e}")


def _run_sadtalker(cmd: list, face_path, cwd: str, env: dict, timeout: int = 600):
    """SadTalker 서브프로세스 실행 — 실패 시 얼굴 사진을 회전/축소해가며 재시도한다.

    실측(2026-07-04) 확인된 실패 유형 2가지에 대응:
      1) 얼굴을 못 찾음(회전된 사진 등) — stderr에 "landmark"가 섞여 나옴(SadTalker가
         이 실패를 문자열 raise로 던져 실제로는 TypeError로 위장되어 나온다). 이 경우
         소스 이미지를 90도씩 돌려가며 최대 4방향(0/90/180/270)까지 재시도.
      2) 과대 해상도 — _save_face_image를 거치지 않은 호출 경로 대비, 실행 전 방어적으로
         한 번 더 확인해 크면 축소한다.
    끝까지 실패하면 마지막 시도의 CalledProcessError를 그대로 raise —
    기존 호출부의 `except subprocess.CalledProcessError` 처리와 호환됨."""
    from PIL import Image

    try:
        img = Image.open(face_path)
        w, h = img.size
        if max(w, h) > FACE_IMAGE_MAX_SIDE:
            scale = FACE_IMAGE_MAX_SIDE / max(w, h)
            img.resize((round(w * scale), round(h * scale)), Image.LANCZOS).save(face_path)
    except Exception:
        pass

    last_exc = None
    for attempt in range(4):
        try:
            return subprocess.run(cmd, check=True, cwd=cwd, capture_output=True, timeout=timeout, env=env)
        except subprocess.CalledProcessError as e:
            last_exc = e
            stderr = e.stderr.decode(errors="replace") if e.stderr else ""
            if "landmark" not in stderr.lower() or attempt == 3:
                raise
            print(f"[avatar] SadTalker 얼굴 미검출 — {attempt + 1}/4 시도, 이미지 90도 회전 후 재시도")
            img = Image.open(face_path)
            img.rotate(-90, expand=True).save(face_path)
    raise last_exc

# '내 목소리'가 아닌 템플릿 옵션 — XTTS v2 내장 스피커 중 선별 (speaker_wav 대신 speaker= 사용)
VOICE_TEMPLATES = {
    "pretty": "Daisy Studious",   # 예쁜 목소리 (또랑또랑한 여성)
    "child":  "Gracie Wise",      # 어린이 목소리 (밝고 가벼운 톤)
    "calm":   "Alison Dietlinde", # 차분한 목소리
    "bright": "Sofia Hellen",     # 발랄한 목소리
}

# 비동기 생성 잡 저장소  {job_id: {stage, error, mp4_path}}
_avatar_jobs: dict = {}
# TTS+SadTalker는 같은 GPU를 쓰므로 동시에 두 개 이상 돌면 CUDA 메모리 충돌로 실패함 — 직렬화
_avatar_gpu_lock = _threading.Lock()


def _tts_script(text: str, speech_path, speaker_line: str) -> str:
    """xtts 콘다 환경에서 subprocess로 실행할 XTTS v2 합성 스크립트 문자열.
    speaker_line은 'speaker=...' 또는 'speaker_wav=...' 형태의 완성된 인자 라인."""
    return f"""
import sys, os
os.environ["COQUI_TOS_AGREED"] = "1"
os.environ["TTS_HOME"] = {repr(str(config.MODELS_DIR))}
sys.stdout.reconfigure(encoding='utf-8')
from TTS.api import TTS
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda")
tts.tts_to_file(
    text={repr(text)},
    {speaker_line},
    language="ko",
    file_path={repr(str(speech_path))}
)
"""


@app.route("/avatar/register_voice", methods=["POST"])
def avatar_register_voice():
    sample = request.files.get("sample")
    if not sample:
        return jsonify({"error": "sample file required"}), 400

    AVATAR_DATA.mkdir(parents=True, exist_ok=True)
    raw_path = AVATAR_DATA / "voice_sample_raw.tmp"
    sample.save(str(raw_path))

    # WebM/OGG 등 브라우저 포맷 → PCM WAV 자동 변환
    ffmpeg_path = str(SADTALKER_DIR / "ffmpeg.exe")
    try:
        subprocess.run(
            [ffmpeg_path, "-y", "-i", str(raw_path),
             "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", str(VOICE_SAMPLE)],
            check=True, capture_output=True, timeout=30
        )
    except Exception:
        # ffmpeg 실패 시 원본 그대로 저장
        import shutil
        shutil.copy(str(raw_path), str(VOICE_SAMPLE))
    finally:
        raw_path.unlink(missing_ok=True)

    import wave, contextlib
    duration = 0.0
    try:
        with contextlib.closing(wave.open(str(VOICE_SAMPLE), "r")) as f:
            duration = f.getnframes() / float(f.getframerate())
    except Exception:
        pass

    return jsonify({"status": "ok", "duration": round(duration, 1)})


@app.route("/avatar/voice_status", methods=["GET"])
def avatar_voice_status():
    FACE_FILE = AVATAR_DATA / "face.jpg"
    return jsonify({
        "registered": VOICE_SAMPLE.exists(),
        "face_registered": FACE_FILE.exists(),
    })

@app.route("/avatar/voice_sample", methods=["GET"])
def avatar_voice_sample():
    if not VOICE_SAMPLE.exists():
        return jsonify({"error": "not registered"}), 404
    return send_file(str(VOICE_SAMPLE), mimetype="audio/wav")

@app.route("/avatar/face", methods=["GET"])
def avatar_face():
    FACE_FILE = AVATAR_DATA / "face.jpg"
    if not FACE_FILE.exists():
        return jsonify({"error": "not registered"}), 404
    return send_file(str(FACE_FILE), mimetype="image/jpeg")

@app.route("/avatar/jingu_front.jpg", methods=["GET"])
def avatar_jingu_front():
    source = Path(__file__).resolve().parents[1] / "jingu_front.jpg"
    if not source.exists():
        return jsonify({"error": "jingu_front.jpg not found"}), 404
    return send_file(str(source), mimetype="image/jpeg")

@app.route("/avatar/register_face", methods=["POST"])
def avatar_register_face():
    f = request.files.get("face")
    if not f:
        return jsonify({"error": "face file required"}), 400
    AVATAR_DATA.mkdir(parents=True, exist_ok=True)
    dest = AVATAR_DATA / "face.jpg"
    _save_face_image(f, dest)
    return jsonify({"status": "ok"})


@app.route("/avatar/tts_only", methods=["POST"])
def avatar_tts_only():
    """얼굴 없이 XTTS 음성 WAV만 생성 — 3D 아바타 립싱크용"""
    text = request.form.get("text", "").strip()
    voice = request.form.get("voice", "mine").strip()
    text = _strip_tts_markup(text)
    if not text:
        return jsonify({"error": "text required"}), 400

    template_speaker = VOICE_TEMPLATES.get(voice)
    if template_speaker is None and not VOICE_SAMPLE.exists():
        return jsonify({"error": "voice sample not registered"}), 400

    # 상주 XTTS 워커(8768) 사용 — 꺼져 있으면 기동을 기다렸다가(최대 180초) 재시도
    try:
        wav_bytes = _xtts_synthesize(
            text, speaker=template_speaker,
            speaker_wav=None if template_speaker else str(VOICE_SAMPLE),
            timeout=180,
        )
        if wav_bytes:
            return app.response_class(wav_bytes, mimetype="audio/wav")
    except Exception as _e:
        print(f"[tts_only] TTS 실패: {_e}", flush=True)

    return jsonify({"error": "XTTS worker is not ready", "retryable": True}), 503


def _run_avatar_job(job_id: str, face_path: Path, text: str, job_dir: Path) -> None:
    """백그라운드 스레드: TTS → SadTalker 순서로 실행.
    GPU(XTTS+SadTalker)는 동시 실행 시 CUDA 메모리 충돌로 실패하므로 락으로 직렬화."""
    job = _avatar_jobs[job_id]
    with _avatar_gpu_lock:
        _run_avatar_job_locked(job_id, face_path, text, job_dir)


def _run_avatar_job_locked(job_id: str, face_path: Path, text: str, job_dir: Path) -> None:
    job = _avatar_jobs[job_id]
    speech_path = job_dir / "speech.wav"

    # 1) TTS — use the resident XTTS worker; do not reload the model per job.
    job["stage"] = "tts"
    text = _strip_tts_markup(text)
    try:
        wav_bytes = _xtts_synthesize(text, speaker_wav=str(VOICE_SAMPLE), timeout=180)
        if not wav_bytes:
            job["stage"] = "error"
            job["error"] = "XTTS worker is not ready"
            return
        speech_path.write_bytes(wav_bytes)
    except Exception as e:
        job["stage"] = "error"
        job["error"] = f"TTS 실패: {str(e)[:300]}"
        return

    # 2) SadTalker — 프로파일 영상 설정 반영
    job["stage"] = "sadtalker"
    result_dir = job_dir / "result"
    profile = avatar_core.get_profile()
    def pvideo(key):
        return profile.get(key, {}).get("value") or avatar_core.VIDEO_STYLE_DEFAULTS.get(key, "")
    cmd = [
        PYTHON_EXE, str(SADTALKER_DIR / "inference.py"),
        "--driven_audio", str(speech_path),
        "--source_image", str(face_path),
        "--result_dir",   str(result_dir),
        "--preprocess", pvideo("video_preprocess"),
        "--size", pvideo("video_size"),
        "--expression_scale", pvideo("video_expression_scale"),
    ]
    if pvideo("video_still") == "true":
        cmd.append("--still")
    if pvideo("video_enhancer") != "none":
        cmd += ["--enhancer", pvideo("video_enhancer")]
    if job.get("ref_pose"):
        cmd += ["--ref_pose", job["ref_pose"]]
    sad_env = dict(os.environ)
    sad_env["PATH"] = str(SADTALKER_DIR) + os.pathsep + sad_env.get("PATH", "")
    def _final_mp4():
        # SadTalker가 비정상 종료해도 최종 영상(temp_ 접두사가 없는 mp4)이 이미 만들어져 있을 수 있음
        candidates = [f for f in result_dir.rglob("*.mp4") if not f.name.startswith("temp_")]
        if not candidates:
            return None
        return max(candidates, key=lambda f: f.stat().st_mtime)

    try:
        _run_sadtalker(cmd, face_path, cwd=str(SADTALKER_DIR), env=sad_env, timeout=600)
    except subprocess.CalledProcessError as e:
        mp4 = _final_mp4()
        if mp4:
            job["stage"] = "done"
            job["mp4_path"] = str(mp4)
            return
        job["stage"] = "error"
        job["error"] = f"SadTalker 실패: {e.stderr.decode(errors='replace')[:300]}"
        return
    except subprocess.TimeoutExpired:
        mp4 = _final_mp4()
        if mp4:
            job["stage"] = "done"
            job["mp4_path"] = str(mp4)
            return
        job["stage"] = "error"
        job["error"] = "SadTalker 타임아웃 (600s)"
        return

    mp4 = _final_mp4()
    if not mp4:
        job["stage"] = "error"
        job["error"] = "출력 영상 없음"
        return

    job["stage"] = "done"
    job["mp4_path"] = str(mp4)


@app.route("/avatar/lipsync_cues", methods=["POST"])
def avatar_lipsync_cues():
    """이미 생성된 TTS WAV를 Rhubarb Lip Sync로 분석해 발음 타이밍 기반 입모양 큐를 반환.
    프론트가 tts_only로 받은 오디오를 그대로 재전송 — TTS 재생성 없이 분석만 추가로 돈다."""
    audio_file = request.files.get("audio")
    text = request.form.get("text", "").strip()
    if not audio_file:
        return jsonify({"error": "audio required"}), 400
    job_dir = AVATAR_TMP / uuid.uuid4().hex
    job_dir.mkdir(parents=True, exist_ok=True)
    wav_path = job_dir / "audio.wav"
    audio_file.save(str(wav_path))
    cues = []
    if text:
        try:
            # Whisper timestamps locate the spoken Korean words in the XTTS WAV.
            # The source text then maps each Korean syllable to a specific viseme.
            model = _get_whisper()
            with _whisper_lock:
                segments, _ = model.transcribe(
                    str(wav_path), language="ko", beam_size=5,
                    word_timestamps=True, vad_filter=False,
                )
                cues = lipsync.extract_korean_visemes(text, list(segments))
        except Exception as exc:
            print(f"[korean-lipsync] alignment failed, using Rhubarb: {exc}", flush=True)
    if not cues:
        cues = lipsync.extract_visemes(str(wav_path))
    return jsonify({"cues": cues})


@app.route("/avatar/generate_async", methods=["POST"])
def avatar_generate_async():
    """비동기 영상 생성: job_id 즉시 반환 후 백그라운드에서 TTS+SadTalker 실행."""
    face_file = request.files.get("face")
    ref_video = request.files.get("ref_pose")   # 참조 포즈 영상 (선택)
    text      = request.form.get("text", "").strip()
    text      = _strip_tts_markup(text)

    if not face_file:
        return jsonify({"error": "face file required"}), 400
    if not text:
        return jsonify({"error": "text required"}), 400
    if not VOICE_SAMPLE.exists():
        return jsonify({"error": "voice sample not registered"}), 400

    job_id  = str(uuid.uuid4())
    job_dir = AVATAR_TMP / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    face_ext  = Path(face_file.filename).suffix or ".jpg"
    face_path = job_dir / f"face{face_ext}"
    _save_face_image(face_file, face_path)

    ref_pose_path = None
    if ref_video and ref_video.filename:
        ref_ext = Path(ref_video.filename).suffix or ".mp4"
        ref_pose_path = job_dir / f"ref_pose{ref_ext}"
        ref_video.save(str(ref_pose_path))

    _avatar_jobs[job_id] = {"stage": "queued", "error": "", "mp4_path": None,
                             "ref_pose": str(ref_pose_path) if ref_pose_path else None}
    t = _threading.Thread(target=_run_avatar_job,
                          args=(job_id, face_path, text, job_dir), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


def _run_record_job(job_id: str, face_path: Path, audio_path: Path, job_dir: Path) -> None:
    """녹화 기반 잡: 오디오를 WAV로 변환 후 SadTalker 직접 실행 (XTTS 생략).
    SadTalker는 GPU를 쓰므로 _run_avatar_job과 동시 실행되지 않도록 같은 락으로 직렬화."""
    job = _avatar_jobs[job_id]
    with _avatar_gpu_lock:
        _run_record_job_locked(job_id, face_path, audio_path, job_dir)


def _run_record_job_locked(job_id: str, face_path: Path, audio_path: Path, job_dir: Path) -> None:
    job = _avatar_jobs[job_id]
    speech_path = job_dir / "speech.wav"

    # 오디오 → WAV 변환 (ffmpeg)
    job["stage"] = "audio_convert"
    ffmpeg_path = str(SADTALKER_DIR / "ffmpeg.exe")
    try:
        subprocess.run(
            [ffmpeg_path, "-y", "-i", str(audio_path), "-ar", "16000", "-ac", "1", str(speech_path)],
            check=True, capture_output=True, timeout=60
        )
    except Exception as e:
        job["stage"] = "error"
        job["error"] = f"오디오 변환 실패: {e}"
        return

    # SadTalker 립싱크
    job["stage"] = "sadtalker"
    result_dir = job_dir / "result"
    cmd = [
        PYTHON_EXE, str(SADTALKER_DIR / "inference.py"),
        "--driven_audio", str(speech_path),
        "--source_image", str(face_path),
        "--result_dir",   str(result_dir),
        "--still", "--preprocess", "full",
        "--enhancer", "gfpgan", "--size", "512",
    ]
    sad_env = dict(os.environ)
    sad_env["PATH"] = str(SADTALKER_DIR) + os.pathsep + sad_env.get("PATH", "")

    def _final_mp4():
        # SadTalker가 비정상 종료해도 최종 영상(temp_ 접두사가 없는 mp4)이 이미 만들어져 있을 수 있음
        candidates = [f for f in result_dir.rglob("*.mp4") if not f.name.startswith("temp_")]
        if not candidates:
            return None
        return max(candidates, key=lambda f: f.stat().st_mtime)

    try:
        _run_sadtalker(cmd, face_path, cwd=str(SADTALKER_DIR), env=sad_env, timeout=600)
    except subprocess.CalledProcessError as e:
        mp4 = _final_mp4()
        if mp4:
            job["stage"] = "done"; job["mp4_path"] = str(mp4); return
        job["stage"] = "error"
        job["error"] = f"SadTalker 실패: {e.stderr.decode(errors='replace')[:300]}"
        return
    except subprocess.TimeoutExpired:
        mp4 = _final_mp4()
        if mp4:
            job["stage"] = "done"; job["mp4_path"] = str(mp4); return
        job["stage"] = "error"; job["error"] = "SadTalker 타임아웃"; return

    mp4 = _final_mp4()
    if not mp4:
        job["stage"] = "error"; job["error"] = "출력 영상 없음"; return

    job["stage"] = "done"
    job["mp4_path"] = str(mp4)


@app.route("/avatar/record_generate", methods=["POST"])
def avatar_record_generate():
    """웹캠 녹화 기반 생성: 얼굴 이미지 + 오디오 → SadTalker 직접 실행."""
    face_file  = request.files.get("face")
    audio_file = request.files.get("audio")

    if not face_file:
        return jsonify({"error": "face 필요"}), 400
    if not audio_file:
        return jsonify({"error": "audio 필요"}), 400

    job_id  = str(uuid.uuid4())
    job_dir = AVATAR_TMP / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    face_ext  = Path(face_file.filename or "face.jpg").suffix or ".jpg"
    face_path = job_dir / f"face{face_ext}"
    _save_face_image(face_file, face_path)

    audio_ext  = Path(audio_file.filename or "audio.webm").suffix or ".webm"
    audio_path = job_dir / f"audio{audio_ext}"
    audio_file.save(str(audio_path))

    _avatar_jobs[job_id] = {"stage": "queued", "error": "", "mp4_path": None}
    t = _threading.Thread(target=_run_record_job,
                          args=(job_id, face_path, audio_path, job_dir), daemon=True)
    t.start()
    return jsonify({"job_id": job_id})


@app.route("/avatar/job/<job_id>", methods=["GET"])
def avatar_job_status(job_id: str):
    job = _avatar_jobs.get(job_id)
    if not job:
        return jsonify({"error": "job not found"}), 404
    return jsonify({
        "stage":    job["stage"],
        "error":    job.get("error", ""),
        "done":     job["stage"] == "done",
        "video_url": f"/avatar/job/{job_id}/video" if job["stage"] == "done" else None,
    })


@app.route("/avatar/job/<job_id>/video", methods=["GET"])
def avatar_job_video(job_id: str):
    job = _avatar_jobs.get(job_id)
    if not job or job["stage"] != "done":
        return jsonify({"error": "not ready"}), 404
    return send_file(job["mp4_path"], mimetype="video/mp4",
                     as_attachment=False, download_name="avatar.mp4")


@app.route("/avatar/history", methods=["GET"])
def avatar_history():
    """이전에 생성된 영상 목록 반환 (최신순)"""
    results = []
    if AVATAR_TMP.exists():
        for job_dir in AVATAR_TMP.iterdir():
            if not job_dir.is_dir():
                continue
            job_id = job_dir.name
            # result 폴더 아래 최종 mp4 — 평면(타임스탬프.mp4) 또는 중첩(타임스탬프/face##speech.mp4) 둘 다 지원
            # face##speech_full.mp4 / temp_*.mp4는 중간 산출물이므로 제외
            mp4_files = sorted(
                [f for f in job_dir.glob("result/**/*.mp4")
                 if not f.name.startswith("temp_") and not f.name.endswith("_full.mp4")],
                key=lambda f: f.stat().st_mtime, reverse=True
            )
            if not mp4_files:
                continue
            mp4 = mp4_files[0]
            face_files = list(job_dir.glob("face.*"))
            results.append({
                "job_id": job_id,
                "created_at": mp4.stat().st_mtime,
                "video_url": f"/avatar/history/{job_id}/video",
                "thumb_url": f"/avatar/history/{job_id}/thumb",
                "has_face": len(face_files) > 0,
            })
    results.sort(key=lambda x: x["created_at"], reverse=True)
    for r in results:
        import datetime
        r["created_at"] = datetime.datetime.fromtimestamp(r["created_at"]).strftime("%Y-%m-%d %H:%M")
    return jsonify({"history": results[:20]})


@app.route("/avatar/history/<job_id>/video", methods=["GET"])
def avatar_history_video(job_id: str):
    job_dir = AVATAR_TMP / job_id
    if not job_dir.exists():
        return jsonify({"error": "not found"}), 404
    mp4_files = sorted(
        [f for f in job_dir.glob("result/**/*.mp4")
         if not f.name.startswith("temp_") and not f.name.endswith("_full.mp4")],
        key=lambda f: f.stat().st_mtime, reverse=True
    )
    if not mp4_files:
        return jsonify({"error": "no video"}), 404
    return send_file(str(mp4_files[0]), mimetype="video/mp4", as_attachment=False)


@app.route("/avatar/history/<job_id>/thumb", methods=["GET"])
def avatar_history_thumb(job_id: str):
    """얼굴 사진을 썸네일로 반환"""
    job_dir = AVATAR_TMP / job_id
    for ext in ["jpg", "jpeg", "png"]:
        face = job_dir / f"face.{ext}"
        if face.exists():
            return send_file(str(face), mimetype=f"image/{ext}")
    return jsonify({"error": "no thumb"}), 404


@app.route("/avatar/history/<job_id>", methods=["DELETE"])
def avatar_history_delete(job_id: str):
    """이전 생성 영상 삭제 — job 디렉터리 통째로 제거"""
    job_dir = AVATAR_TMP / job_id
    if not job_dir.exists() or not job_dir.is_dir():
        return jsonify({"error": "not found"}), 404
    import shutil
    try:
        shutil.rmtree(str(job_dir))
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    return jsonify({"status": "ok"})


_faceswap_jobs: dict = {}
_ytdl_jobs: dict = {}

YTDL_HISTORY_FILE = AVATAR_TMP / "ytdl_history.json"
YTDL_DOWNLOAD_DIR = AVATAR_TMP / "youtube_downloads"
YTDL_DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

def _load_ytdl_history() -> list:
    try:
        if YTDL_HISTORY_FILE.exists():
            import json as _json
            return _json.loads(YTDL_HISTORY_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return []

def _save_ytdl_history(entry: dict):
    import json as _json
    history = _load_ytdl_history()
    # 같은 URL을 반복 저장하지 않고 최신 다운로드 하나만 유지한다.
    for old in history:
        if old.get("url") == entry.get("url") and old.get("video_path") != entry.get("video_path"):
            try:
                Path(old.get("video_path", "")).unlink(missing_ok=True)
            except OSError:
                pass
    history = [old for old in history if old.get("url") != entry.get("url")]
    history.insert(0, entry)
    history = history[:50]
    YTDL_HISTORY_FILE.write_text(_json.dumps(history, ensure_ascii=False), encoding="utf-8")


def _migrate_ytdl_downloads():
    """기존 ytdl 결과도 전용 보관 폴더로 이동해 재시작 후 일관되게 로드한다."""
    import shutil as _shutil_local
    history = _load_ytdl_history()
    changed = False
    unique = []
    seen_urls = set()
    for item in history:
        url = item.get("url", "")
        if url and url in seen_urls:
            try:
                Path(item.get("video_path", "")).unlink(missing_ok=True)
            except OSError:
                pass
            changed = True
            continue
        if url:
            seen_urls.add(url)
        unique.append(item)
    history = unique
    for item in history:
        old_path = Path(item.get("video_path", ""))
        if not old_path.exists() or old_path.parent == YTDL_DOWNLOAD_DIR:
            continue
        dest = YTDL_DOWNLOAD_DIR / f"{item.get('job_id', old_path.stem)}{old_path.suffix.lower() or '.mp4'}"
        if not dest.exists():
            _shutil_local.copy2(str(old_path), str(dest))
        item["video_path"] = str(dest)
        changed = True
    if changed:
        import json as _json
        YTDL_HISTORY_FILE.write_text(_json.dumps(history, ensure_ascii=False), encoding="utf-8")


_migrate_ytdl_downloads()


@app.route("/avatar/ytdl/history", methods=["GET"])
def avatar_ytdl_history():
    history = [h for h in _load_ytdl_history()
               if Path(h.get("video_path","")).exists()]
    return jsonify({"history": history})


@app.route("/avatar/ytdl", methods=["POST"])
def avatar_ytdl():
    """YouTube URL → 영상 다운로드 (백그라운드), job_id 반환"""
    data    = request.get_json(silent=True) or {}
    url     = data.get("url", "").strip()
    start   = data.get("start", "")   # 시작 시간 예: "00:01:30"
    end     = data.get("end", "")     # 종료 시간 예: "00:02:00"
    max_sec = int(data.get("max_sec", 120))  # 최대 120초

    if not url:
        return jsonify({"error": "url 필요"}), 400

    job_id  = str(uuid.uuid4())
    job_dir = AVATAR_TMP / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    out_tmpl = str(job_dir / "video.%(ext)s")

    _ytdl_jobs[job_id] = {"stage": "downloading", "error": "", "video_path": None, "title": ""}

    def _run():
        try:
            import yt_dlp
            ydl_opts = {
                "format": "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best",
                "outtmpl": out_tmpl,
                "merge_output_format": "mp4",
                "quiet": True,
                "ffmpeg_location": str(SADTALKER_DIR),
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                title = info.get("title", "video")
                duration = info.get("duration", 0)

            mp4_files = list(job_dir.glob("*.mp4")) + list(job_dir.glob("*.webm"))
            if not mp4_files:
                raise FileNotFoundError("다운로드된 파일 없음")

            raw_path = str(mp4_files[0])
            final_path = str(job_dir / "clip.mp4")

            # 구간 자르기 (start/end 지정 또는 max_sec 초과 시 앞부분만) + faststart 리먹싱
            # (+faststart 없이 만들면 moov atom이 파일 끝에 남아 브라우저 <video>로 재생이 안 됨)
            ffmpeg = str(SADTALKER_DIR / "ffmpeg.exe")
            ss_args = ["-ss", start] if start else []
            to_args = ["-to", end] if end else (["-t", str(max_sec)] if duration > max_sec else [])

            try:
                subprocess.run(
                    [ffmpeg, "-y"] + ss_args + ["-i", raw_path] + to_args +
                    ["-c", "copy", "-movflags", "+faststart", final_path],
                    check=True, capture_output=True, timeout=120
                )
                if not Path(final_path).exists():
                    final_path = raw_path
            except Exception:
                final_path = raw_path

            # 다운로드 결과는 job 임시 폴더와 분리된 영구 폴더에 보관한다.
            saved_path = YTDL_DOWNLOAD_DIR / f"{job_id}{Path(final_path).suffix.lower() or '.mp4'}"
            _shutil.copy2(final_path, saved_path)
            final_path = str(saved_path)

            _ytdl_jobs[job_id].update({"stage": "done", "video_path": final_path, "title": title,
                                        "url": url, "duration": duration})
            _save_ytdl_history({"job_id": job_id, "title": title, "url": url,
                                 "video_path": final_path, "duration": duration,
                                 "video_url": f"/avatar/ytdl/{job_id}/video"})
        except Exception as e:
            _ytdl_jobs[job_id]["stage"] = "error"
            _ytdl_jobs[job_id]["error"] = str(e)

    _threading.Thread(target=_run, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/avatar/ytdl/<job_id>", methods=["GET"])
def avatar_ytdl_status(job_id: str):
    job = _ytdl_jobs.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify({**job, "video_url": f"/avatar/ytdl/{job_id}/video" if job["stage"] == "done" else None})


@app.route("/avatar/ytdl/<job_id>/video", methods=["GET"])
def avatar_ytdl_video(job_id: str):
    job = _ytdl_jobs.get(job_id)
    if not job:
        job = next((item for item in _load_ytdl_history() if item.get("job_id") == job_id), None)
        if job:
            job = {**job, "stage": "done"}
    if not job or job.get("stage") != "done":
        return jsonify({"error": "not ready"}), 404
    source_path = Path(job["video_path"])
    if not source_path.exists():
        return jsonify({"error": "downloaded video file is missing"}), 404

    # 원본(AV1 등)은 그대로 보존하고, 브라우저 재생용 H.264/AAC 미리보기만 별도 생성한다.
    preview_path = source_path.with_name(f"{source_path.stem}.preview.mp4")
    if source_path.suffix.lower() != ".mp4":
        preview_path = source_path.with_suffix(".preview.mp4")
    if not preview_path.exists():
        try:
            subprocess.run([
                str(SADTALKER_DIR / "ffmpeg.exe"), "-y", "-i", str(source_path),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-c:a", "aac", "-movflags", "+faststart", str(preview_path)
            ], check=True, capture_output=True, timeout=300)
        except Exception as e:
            print(f"[ytdl] 브라우저 미리보기 변환 실패, 원본 제공: {e}", flush=True)
            preview_path = source_path

    suffix = preview_path.suffix.lower()
    mimetype = "video/webm" if suffix == ".webm" else "video/mp4"
    return send_file(str(preview_path), mimetype=mimetype, as_attachment=False,
                     download_name=f"{job.get('title','video')[:40]}{suffix or '.mp4'}")


@app.route("/avatar/ytdl/<job_id>", methods=["DELETE"])
def avatar_ytdl_delete(job_id: str):
    history = _load_ytdl_history()
    kept = []
    removed = None
    for item in history:
        if item.get("job_id") == job_id and removed is None:
            removed = item
        else:
            kept.append(item)
    if removed is None:
        return jsonify({"error": "not found"}), 404

    source_to_remove = Path(removed.get("video_path", ""))
    paths = [source_to_remove, source_to_remove.with_name(f"{source_to_remove.stem}.preview.mp4")]
    job_dir = AVATAR_TMP / secure_filename(job_id)
    paths.extend(job_dir.glob("*"))
    avatar_root = AVATAR_TMP.resolve()
    for path in paths:
        try:
            resolved = path.resolve()
            resolved.relative_to(avatar_root)
            if resolved.is_file():
                resolved.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass
    if job_dir.exists():
        _shutil.rmtree(job_dir, ignore_errors=True)
    YTDL_HISTORY_FILE.write_text(_json.dumps(kept, ensure_ascii=False), encoding="utf-8")
    _ytdl_jobs.pop(job_id, None)
    return jsonify({"success": True})


_SADTALKER_REF_DIR   = SADTALKER_DIR / "examples" / "ref_video"
_LOCAL_REF_SAMPLE_DIR = Path(__file__).parent.parent / "data" / "ref_pose_samples"
_REF_POSE_CACHE = AVATAR_TMP / "ref_pose_cache"


@app.route("/avatar/ref_pose/samples", methods=["GET"])
def avatar_ref_pose_samples():
    """번들된 예시 포즈 참조 영상 목록 — SadTalker 기본 예시(examples/ref_video/) +
    data/ref_pose_samples/(직접 추가한 royalty-free 샘플, 남/여 다양화용)"""
    samples = []
    for d in (_SADTALKER_REF_DIR, _LOCAL_REF_SAMPLE_DIR):
        if d.exists():
            for f in sorted(d.glob("*.mp4")):
                samples.append({"name": f.name, "video_url": f"/avatar/ref_pose/sample/{f.name}"})
    return jsonify({"samples": samples})


def _faststart_cached(src: Path) -> Path:
    """브라우저 재생용 캐시본을 반환 (없으면 생성).
    SadTalker 번들 예시 영상은 1) moov atom이 파일 끝에 있고(non-faststart)
    2) 비디오 코덱이 브라우저가 디코딩 못 하는 구형 MPEG-4 Part 2(mp4v)라 <video> 태그로 재생이 안 됨.
    그래서 단순 리먹싱(-c copy)이 아니라 H.264로 다시 인코딩해야 한다."""
    _REF_POSE_CACHE.mkdir(parents=True, exist_ok=True)
    cached = _REF_POSE_CACHE / src.name
    if not cached.exists() or cached.stat().st_mtime < src.stat().st_mtime:
        subprocess.run(
            [str(config.SADTALKER_FFMPEG), "-y", "-i", str(src),
             "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
             "-movflags", "+faststart", str(cached)],
            check=True, capture_output=True, timeout=120
        )
    return cached


@app.route("/avatar/ref_pose/sample/<name>", methods=["GET"])
def avatar_ref_pose_sample(name: str):
    safe_name = secure_filename(name)
    local_path = _LOCAL_REF_SAMPLE_DIR / safe_name
    if local_path.exists():
        # data/ref_pose_samples/ 파일은 이미 h264 + faststart로 정규화해 저장해둔 것이라 바로 서빙
        return send_file(str(local_path), mimetype="video/mp4", as_attachment=False)

    path = _SADTALKER_REF_DIR / safe_name
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    try:
        serve_path = _faststart_cached(path)
    except Exception:
        serve_path = path
    return send_file(str(serve_path), mimetype="video/mp4", as_attachment=False)


@app.route("/avatar/faceswap", methods=["POST"])
def avatar_faceswap():
    """얼굴 교체: source_face + (target_video 파일 또는 yt_job_id) → 내 얼굴로 교체된 영상"""
    source_face  = request.files.get("source_face")
    target_video = request.files.get("target_video")
    yt_job_id    = request.form.get("yt_job_id", "")
    use_gpu      = request.form.get("use_gpu", "true").lower() not in ("false", "0", "")

    if not source_face:
        return jsonify({"error": "source_face 필요"}), 400
    if not target_video and not yt_job_id:
        return jsonify({"error": "target_video 또는 yt_job_id 필요"}), 400

    job_id  = str(uuid.uuid4())
    job_dir = AVATAR_TMP / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    face_path   = job_dir / f"source{Path(source_face.filename).suffix or '.jpg'}"
    output_path = str(job_dir / "faceswap_result.mp4")
    _save_face_image(source_face, face_path)

    # 대상 영상: 직접 업로드 또는 YouTube 다운로드 결과 사용
    persisted_yt_path = None
    if yt_job_id:
        memory_job = _ytdl_jobs.get(yt_job_id)
        if memory_job and memory_job.get("stage") == "done":
            candidate = Path(memory_job.get("video_path", ""))
            if candidate.exists():
                persisted_yt_path = candidate
        if persisted_yt_path is None:
            for item in _load_ytdl_history():
                if item.get("job_id") == yt_job_id:
                    candidate = Path(item.get("video_path", ""))
                    if candidate.exists():
                        persisted_yt_path = candidate
                    break

    if persisted_yt_path is not None:
        video_path = job_dir / f"target{Path(persisted_yt_path).suffix or '.mp4'}"
        _shutil.copy2(str(persisted_yt_path), str(video_path))
    else:
        video_path = job_dir / f"target{Path(target_video.filename).suffix or '.mp4'}"
        target_video.save(str(video_path))

    _faceswap_jobs[job_id] = {
        "stage": "processing", "error": "", "mp4_path": None,
        "progress": 0, "processed_frames": 0, "total_frames": 0,
        "cancel_requested": False,
        "gpu_error": "",
    }

    def _run():
        gpu_error_text = ""
        xtts_paused = False
        try:
            from core.faceswap import swap_faces_in_video
            if use_gpu:
                xtts_paused = _pause_xtts_for_gpu()
            def on_progress(processed: int, total: int):
                job = _faceswap_jobs.get(job_id)
                if job is None:
                    return
                job["processed_frames"] = processed
                job["total_frames"] = total
                job["progress"] = round(processed / total * 100, 1) if total else 0

            def is_cancelled() -> bool:
                job = _faceswap_jobs.get(job_id)
                return bool(job and job.get("cancel_requested"))

            try:
                swap_faces_in_video(
                    str(face_path), str(video_path), output_path,
                    use_gpu=use_gpu, progress_callback=on_progress,
                    cancel_callback=is_cancelled,
                )
            except Exception as gpu_error:
                if not use_gpu:
                    raise
                gpu_error_text = str(gpu_error)
                # CUDA/ONNX 오류가 나면 같은 원본으로 즉시 CPU 모드 재시도
                print(f"[faceswap] GPU 실패, CPU로 전환: {gpu_error}")
                job = _faceswap_jobs.get(job_id)
                if job is not None:
                    job["stage"] = "GPU 실패 - CPU 전환 중"
                    job["error"] = ""
                    job["progress"] = 0
                    job["processed_frames"] = 0
                    job["total_frames"] = 0
                Path(output_path).unlink(missing_ok=True)
                Path(f"{output_path}_tmp.mp4").unlink(missing_ok=True)
                swap_faces_in_video(
                    str(face_path), str(video_path), output_path,
                    use_gpu=False, progress_callback=on_progress,
                    cancel_callback=is_cancelled,
                )
            if is_cancelled():
                _faceswap_jobs[job_id]["stage"] = "canceled"
                return
            _faceswap_jobs[job_id]["stage"] = "done"
            _faceswap_jobs[job_id]["progress"] = 100
            _faceswap_jobs[job_id]["mp4_path"] = output_path
        except Exception as e:
            _faceswap_jobs[job_id]["stage"] = "error"
            detail = str(e)
            if gpu_error_text:
                detail = f"GPU 오류: {gpu_error_text} | CPU 전환 후 오류: {detail}"
            _faceswap_jobs[job_id]["error"] = detail
        finally:
            if xtts_paused:
                _resume_xtts_after_gpu()

    def _run_worker_process():
        state_file = job_dir / "faceswap_worker_state.json"
        cancel_file = job_dir / "faceswap_worker.cancel"
        worker_script = Path(__file__).resolve().parent.parent / "core" / "faceswap_worker.py"
        paused = False
        proc = None

        def run_worker(gpu: bool):
            nonlocal proc
            state_file.unlink(missing_ok=True)
            proc = subprocess.Popen(
                [PYTHON_EXE, str(worker_script), str(face_path), str(video_path), output_path,
                 str(state_file), str(cancel_file), "1" if gpu else "0"],
                cwd=str(worker_script.parent.parent),
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            while proc.poll() is None:
                try:
                    state = _json.loads(state_file.read_text(encoding="utf-8"))
                    job = _faceswap_jobs.get(job_id)
                    if job:
                        for key in ("stage", "progress", "processed_frames", "total_frames"):
                            if key in state:
                                job[key] = state[key]
                        if state.get("error"):
                            job["error"] = state["error"]
                except (OSError, ValueError):
                    pass
                if _faceswap_jobs.get(job_id, {}).get("cancel_requested"):
                    cancel_file.touch(exist_ok=True)
                time.sleep(0.4)
            return proc.returncode or 0

        try:
            if use_gpu:
                paused = _pause_xtts_for_gpu()
            code = run_worker(use_gpu)
            state = _json.loads(state_file.read_text(encoding="utf-8")) if state_file.exists() else {}
            if (code != 0 or state.get("stage") == "error") and use_gpu:
                _faceswap_jobs[job_id].update({"stage": "GPU 실패 - CPU 전환 중", "progress": 0,
                                                "processed_frames": 0, "total_frames": 0, "error": ""})
                Path(output_path).unlink(missing_ok=True)
                cancel_file.unlink(missing_ok=True)
                code = run_worker(False)
                state = _json.loads(state_file.read_text(encoding="utf-8")) if state_file.exists() else {}
            if code != 0 or state.get("stage") == "error":
                raise RuntimeError(state.get("error") or f"face-swap worker exit code {code}")
            if _faceswap_jobs[job_id].get("cancel_requested") or state.get("stage") == "canceled":
                _faceswap_jobs[job_id]["stage"] = "canceled"
            else:
                _faceswap_jobs[job_id].update({"stage": "done", "progress": 100, "mp4_path": output_path})
        except Exception as e:
            _faceswap_jobs[job_id].update({"stage": "error", "error": str(e)})
        finally:
            if proc is not None and proc.poll() is None:
                proc.terminate()
            cancel_file.unlink(missing_ok=True)
            if paused:
                _resume_xtts_after_gpu()

    _threading.Thread(target=_run_worker_process, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/avatar/faceswap/<job_id>/cancel", methods=["POST"])
def avatar_faceswap_cancel(job_id: str):
    job = _faceswap_jobs.get(job_id)
    if not job:
        job_dir = AVATAR_TMP / secure_filename(job_id)
        state_file = job_dir / "faceswap_worker_state.json"
        if state_file.exists():
            try:
                import json as _json_local
                persisted = _json_local.loads(state_file.read_text(encoding="utf-8"))
                if persisted.get("stage") not in ("done", "error", "canceled"):
                    (job_dir / "faceswap_worker.cancel").touch(exist_ok=True)
                    return jsonify({"success": True, "stage": "canceling"})
            except (OSError, ValueError):
                pass
        return jsonify({"error": "not found"}), 404
    if job["stage"] not in ("done", "error", "canceled"):
        job["cancel_requested"] = True
        return jsonify({"success": True, "stage": "canceling"})
    return jsonify({"success": False, "stage": job["stage"]})


@app.route("/avatar/faceswap/<job_id>", methods=["GET"])
def avatar_faceswap_status(job_id: str):
    job = _faceswap_jobs.get(job_id)
    if not job:
        job_dir = AVATAR_TMP / secure_filename(job_id)
        state_file = job_dir / "faceswap_worker_state.json"
        result_file = job_dir / "faceswap_result.mp4"
        if state_file.exists():
            try:
                persisted = _json.loads(state_file.read_text(encoding="utf-8"))
                job = {
                    "stage": persisted.get("stage", "processing"),
                    "error": persisted.get("error", ""),
                    "mp4_path": str(result_file) if result_file.exists() else None,
                    "progress": persisted.get("progress", 0),
                    "processed_frames": persisted.get("processed_frames", 0),
                    "total_frames": persisted.get("total_frames", 0),
                    "cancel_requested": False,
                    "gpu_error": "",
                }
                _faceswap_jobs[job_id] = job
            except (OSError, ValueError):
                pass
        if not job:
            return jsonify({"error": "not found"}), 404
    return jsonify({**job, "video_url": f"/avatar/faceswap/{job_id}/video" if job["stage"] == "done" else None})


@app.route("/avatar/faceswap/active", methods=["GET"])
def avatar_faceswap_active():
    """현재 실행 중인 모든 얼굴교체 워커의 진행률을 반환한다."""
    active = []
    seen = set()
    for job_id, job in list(_faceswap_jobs.items()):
        if job.get("stage") in ("done", "error", "canceled"):
            continue
        active.append({"job_id": job_id, **job})
        seen.add(job_id)
    if AVATAR_TMP.exists():
        for job_dir in AVATAR_TMP.iterdir():
            if not job_dir.is_dir() or job_dir.name in seen:
                continue
            state_file = job_dir / "faceswap_worker_state.json"
            if not state_file.exists():
                continue
            try:
                import json as _json_local
                state = _json_local.loads(state_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if state.get("stage") in ("done", "error", "canceled"):
                continue
            active.append({"job_id": job_dir.name, "mp4_path": None, "cancel_requested": False,
                           "gpu_error": "", "error": state.get("error", ""),
                           "stage": state.get("stage", "processing"),
                           "progress": state.get("progress", 0),
                           "processed_frames": state.get("processed_frames", 0),
                           "total_frames": state.get("total_frames", 0)})
    active.sort(key=lambda item: item.get("job_id", ""))
    return jsonify({"jobs": active, "count": len(active)})


@app.route("/avatar/faceswap/<job_id>/video", methods=["GET"])
def avatar_faceswap_video(job_id: str):
    job = _faceswap_jobs.get(job_id)
    if job and job["stage"] == "done":
        return send_file(job["mp4_path"], mimetype="video/mp4", as_attachment=False)
    # 서버 재시작 등으로 메모리 job 정보가 없어도, 결과 파일이 남아있으면 저장 목록 재생을 위해 서빙
    mp4_path = AVATAR_TMP / secure_filename(job_id) / "faceswap_result.mp4"
    if mp4_path.exists():
        return send_file(str(mp4_path), mimetype="video/mp4", as_attachment=False)
    return jsonify({"error": "not ready"}), 404


@app.route("/avatar/faceswap/history", methods=["GET"])
def avatar_faceswap_history():
    """저장된 얼굴교체 결과 목록 (파일시스템 기준 — 서버 재시작에도 유지됨)"""
    results = []
    if AVATAR_TMP.exists():
        for job_dir in AVATAR_TMP.iterdir():
            if not job_dir.is_dir():
                continue
            mp4 = job_dir / "faceswap_result.mp4"
            if not mp4.exists():
                continue
            job_id = job_dir.name
            results.append({
                "job_id": job_id,
                "created_at": mp4.stat().st_mtime,
                "video_url": f"/avatar/faceswap/{job_id}/video",
                "thumb_url": f"/avatar/faceswap/history/{job_id}/thumb",
            })
    results.sort(key=lambda x: x["created_at"], reverse=True)
    for r in results:
        r["created_at"] = _datetime.datetime.fromtimestamp(r["created_at"]).strftime("%Y-%m-%d %H:%M")
    return jsonify({"history": results[:20]})


@app.route("/avatar/faceswap/history/<job_id>/thumb", methods=["GET"])
def avatar_faceswap_thumb(job_id: str):
    job_dir = AVATAR_TMP / secure_filename(job_id)
    for ext in ("jpg", "jpeg", "png"):
        f = job_dir / f"source.{ext}"
        if f.exists():
            return send_file(str(f), mimetype=f"image/{ext}")
    return jsonify({"error": "no thumb"}), 404


@app.route("/avatar/faceswap/history/<job_id>", methods=["DELETE"])
def avatar_faceswap_delete(job_id: str):
    job_dir = AVATAR_TMP / secure_filename(job_id)
    if job_dir.exists() and job_dir.is_dir():
        _shutil.rmtree(job_dir, ignore_errors=True)
    _faceswap_jobs.pop(job_id, None)
    return jsonify({"success": True})


@app.route("/avatar/tts_generate", methods=["POST"])
def avatar_tts_generate():
    face_file = request.files.get("face")
    text      = request.form.get("text", "").strip()

    if not face_file:
        return jsonify({"error": "face file required"}), 400
    if not text:
        return jsonify({"error": "text required"}), 400
    if not VOICE_SAMPLE.exists():
        return jsonify({"error": "voice sample not registered. POST /avatar/register_voice first"}), 400

    job_id  = str(uuid.uuid4())
    job_dir = AVATAR_TMP / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    face_ext  = Path(face_file.filename).suffix or ".jpg"
    face_path = job_dir / f"face{face_ext}"
    _save_face_image(face_file, face_path)

    speech_path = job_dir / "speech.wav"

    # 1) XTTS v2 TTS through the resident worker; do not reload the model per request.
    try:
        wav_bytes = _xtts_synthesize(text, speaker_wav=str(VOICE_SAMPLE), timeout=180)
        if not wav_bytes:
            return jsonify({"error": "XTTS worker is not ready", "retryable": True}), 503
        speech_path.write_bytes(wav_bytes)
    except Exception as e:
        return jsonify({"error": "TTS failed", "detail": str(e)[:300]}), 500

    # 2) SadTalker 립싱크
    result_dir = job_dir / "result"
    cmd = [
        PYTHON_EXE, str(SADTALKER_DIR / "inference.py"),
        "--driven_audio", str(speech_path),
        "--source_image", str(face_path),
        "--result_dir",   str(result_dir),
        "--still", "--preprocess", "full",
        "--enhancer", "gfpgan", "--size", "512",
    ]
    # SadTalker가 bare `ffmpeg`를 os.system으로 호출 → ffmpeg.exe 위치를 PATH에 주입
    sad_env = dict(os.environ)
    sad_env["PATH"] = str(SADTALKER_DIR) + os.pathsep + sad_env.get("PATH", "")
    try:
        _run_sadtalker(cmd, face_path, cwd=str(SADTALKER_DIR), env=sad_env, timeout=600)
    except subprocess.CalledProcessError as e:
        return jsonify({"error": "SadTalker failed", "detail": e.stderr.decode(errors="replace")}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "SadTalker timeout after 600s"}), 500

    mp4_files = list(result_dir.rglob("*.mp4"))
    if not mp4_files:
        return jsonify({"error": "no output video found"}), 500

    return send_file(str(mp4_files[0]), mimetype="video/mp4",
                     as_attachment=False, download_name="avatar.mp4")


# ── PPT 자동 발표 ────────────────────────────────────────────
import json as _json
import shutil as _shutil
import datetime as _datetime

PRESENTER_TMP = Path(__file__).parent.parent / "tmp" / "presenter"
PRESENTER_META = "slides.json"  # 세션 디렉터리에 슬라이드+대본을 영속 저장하는 파일명
# 비동기 처리 잡 저장소 {job_id: {stage, current, total, error, slides, session_id}}
# 슬라이드가 많으면 슬라이드당 LLM 호출이 순차로 걸려 수십 초~분 단위로 걸릴 수 있어
# 프론트가 진행률(current/total)을 폴링할 수 있게 백그라운드 스레드로 돌린다.
_presenter_jobs: dict = {}


def _save_presenter_meta(session_dir: Path, source_name: str, slides: list) -> None:
    """슬라이드+대본을 세션 디렉터리에 파일로 저장 — 서버 재시작/잡 메모리 소실에도 남도록"""
    meta = {
        "source_name": source_name,
        "created_at": _datetime.datetime.now().isoformat(timespec="seconds"),
        "slides": slides,
    }
    (session_dir / PRESENTER_META).write_text(_json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


def _run_presenter_job(job_id: str, src_path: Path, session_dir: Path) -> None:
    job = _presenter_jobs[job_id]
    job["stage"] = "processing"

    def _progress(current: int, total: int):
        job["current"] = current
        job["total"] = total

    try:
        slides = ppt_present.process_presentation(str(src_path), str(session_dir), progress_cb=_progress)
        job["slides"] = slides
        job["stage"] = "done"
        _save_presenter_meta(session_dir, src_path.name, slides)
    except Exception as e:
        job["stage"] = "error"
        job["error"] = f"발표 자료 처리 실패: {e}"


@app.route("/presenter/upload", methods=["POST"])
def presenter_upload():
    """PPTX/PDF 업로드 → job_id 즉시 반환, 백그라운드에서 슬라이드 이미지 내보내기 + 발표 대본 생성(LLM)"""
    f = request.files.get("file")
    ext = os.path.splitext(f.filename)[1].lower() if f else ""
    if not f or ext not in ppt_present.SUPPORTED_EXTS:
        return jsonify({"error": "pptx 또는 pdf 파일이 필요합니다"}), 400

    session_id = uuid.uuid4().hex
    session_dir = PRESENTER_TMP / session_id
    session_dir.mkdir(parents=True, exist_ok=True)
    src_path = session_dir / f"source{ext}"
    f.save(str(src_path))

    job_id = uuid.uuid4().hex
    _presenter_jobs[job_id] = {
        "stage": "queued", "current": 0, "total": 0, "error": "",
        "slides": None, "session_id": session_id,
    }
    t = _threading.Thread(target=_run_presenter_job, args=(job_id, src_path, session_dir), daemon=True)
    t.start()

    return jsonify({"job_id": job_id, "session_id": session_id})


@app.route("/presenter/job/<job_id>", methods=["GET"])
def presenter_job_status(job_id: str):
    job = _presenter_jobs.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify(job)


@app.route("/presenter/slide_image/<session_id>/<filename>", methods=["GET"])
def presenter_slide_image(session_id: str, filename: str):
    path = PRESENTER_TMP / session_id / filename
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    return send_file(str(path), mimetype="image/png")


@app.route("/presenter/session/<session_id>/slide/<int:slide_index>/video", methods=["GET", "POST"])
def presenter_slide_video(session_id: str, slide_index: int):
    session_dir = PRESENTER_TMP / secure_filename(session_id)
    meta_path = session_dir / PRESENTER_META
    if not meta_path.exists():
        return jsonify({"error": "not found"}), 404
    meta = _json.loads(meta_path.read_text(encoding="utf-8"))
    slides = meta.get("slides", [])
    slide = next((item for item in slides if item.get("index") == slide_index), None)
    if slide is None:
        return jsonify({"error": "slide not found"}), 404
    video_name = slide.get("video_file") or f"slide_{slide_index}.webm"
    video_path = session_dir / video_name
    if request.method == "POST":
        video = request.files.get("video")
        if not video:
            return jsonify({"error": "video required"}), 400
        video.save(str(video_path))
        slide["video_file"] = video_name
        meta_path.write_text(_json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return jsonify({"ok": True, "video_file": video_name})
    if not video_path.exists():
        return jsonify({"error": "not found"}), 404
    return send_file(str(video_path), mimetype="video/webm", as_attachment=False)


@app.route("/presenter/session/<session_id>/video/merge", methods=["POST"])
def presenter_video_merge(session_id: str):
    session_dir = PRESENTER_TMP / secure_filename(session_id)
    meta_path = session_dir / PRESENTER_META
    if not meta_path.exists():
        return jsonify({"error": "not found"}), 404
    meta = _json.loads(meta_path.read_text(encoding="utf-8"))
    slides = meta.get("slides", [])
    videos = [session_dir / slide["video_file"] for slide in slides if slide.get("video_file")]
    if len(videos) != len(slides) or not videos or not all(path.exists() for path in videos):
        return jsonify({"error": "모든 슬라이드 영상이 먼저 완료되어야 합니다.", "completed": sum(path.exists() for path in videos), "total": len(slides)}), 409
    list_path = session_dir / "presentation_concat.txt"
    output_path = session_dir / "presentation_final.webm"
    try:
        list_path.write_text("\n".join(f"file '{path.as_posix().replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'" for path in videos), encoding="utf-8")
        subprocess.run([str(SADTALKER_DIR / "ffmpeg.exe"), "-y", "-f", "concat", "-safe", "0", "-i", str(list_path), "-c", "copy", str(output_path)], check=True, capture_output=True, timeout=600)
        return jsonify({"ok": True, "video_url": f"/presenter/session/{session_id}/video/final"})
    except Exception as exc:
        return jsonify({"error": f"최종 발표 영상 결합 실패: {exc}"}), 500
    finally:
        list_path.unlink(missing_ok=True)


@app.route("/presenter/session/<session_id>/video/final", methods=["GET"])
def presenter_final_video(session_id: str):
    path = PRESENTER_TMP / secure_filename(session_id) / "presentation_final.webm"
    if not path.exists():
        return jsonify({"error": "not found"}), 404
    return send_file(str(path), mimetype="video/webm", as_attachment=False)


@app.route("/presenter/regenerate/<session_id>/<int:slide_index>", methods=["POST"])
def presenter_regenerate(session_id: str, slide_index: int):
    """해당 슬라이드 하나만 대본을 다시 생성 (원본 텍스트/이미지는 그대로, LLM 출력만 새로)"""
    session_dir = PRESENTER_TMP / session_id
    src_candidates = list(session_dir.glob("source.*"))
    if not session_dir.exists() or not src_candidates:
        return jsonify({"error": "세션을 찾을 수 없습니다"}), 404
    prev_script = request.form.get("prev_script", "")
    try:
        raw_slides, images = ppt_present.extract_and_export(str(src_candidates[0]), str(session_dir))
        script = ppt_present.regenerate_slide(slide_index, raw_slides, images, str(session_dir), prev_script)
        # 저장 파일이 있으면(완료된 세션) 재생성한 대본으로 함께 갱신
        meta_path = session_dir / PRESENTER_META
        if meta_path.exists():
            meta = _json.loads(meta_path.read_text(encoding="utf-8"))
            for s in meta["slides"]:
                if s["index"] == slide_index:
                    s["script"] = script
                    break
            meta_path.write_text(_json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        return jsonify({"script": script})
    except Exception as e:
        return jsonify({"error": f"대본 재생성 실패: {e}"}), 500


@app.route("/presenter/sessions", methods=["GET"])
def presenter_sessions():
    """파일로 저장된 발표(슬라이드+대본) 세션 목록 — 최신순"""
    if not PRESENTER_TMP.exists():
        return jsonify({"sessions": []})
    items = []
    for d in PRESENTER_TMP.iterdir():
        meta_path = d / PRESENTER_META
        if not d.is_dir() or not meta_path.exists():
            continue
        try:
            meta = _json.loads(meta_path.read_text(encoding="utf-8"))
            items.append({
                "session_id": d.name,
                "source_name": meta.get("source_name", ""),
                "created_at": meta.get("created_at", ""),
                "slide_count": len(meta.get("slides", [])),
                "video_count": sum(1 for slide in meta.get("slides", []) if slide.get("video_file") and (d / slide["video_file"]).exists()),
                "thumbnail": (meta["slides"][0]["image"] if meta.get("slides") and meta["slides"][0].get("image") else None),
            })
        except Exception:
            continue
    items.sort(key=lambda x: x["created_at"], reverse=True)
    return jsonify({"sessions": items})


@app.route("/presenter/session/<session_id>", methods=["GET"])
def presenter_session_get(session_id: str):
    """저장된 발표 하나를 그대로 불러오기(재처리 없이 슬라이드+대본 즉시 반환)"""
    meta_path = PRESENTER_TMP / session_id / PRESENTER_META
    if not meta_path.exists():
        return jsonify({"error": "not found"}), 404
    meta = _json.loads(meta_path.read_text(encoding="utf-8"))
    for slide in meta.get("slides", []):
        if slide.get("video_file"):
            slide["video_url"] = f"/presenter/session/{session_id}/slide/{slide.get('index', 0)}/video"
    if (PRESENTER_TMP / session_id / "presentation_final.webm").exists():
        meta["final_video_url"] = f"/presenter/session/{session_id}/video/final"
    return jsonify(meta)


@app.route("/presenter/session/<session_id>", methods=["PUT"])
def presenter_session_update(session_id: str):
    """슬라이드 대본을 직접 수정한 내용을 파일에 저장(사용자가 텍스트박스에서 고친 경우)"""
    session_dir = PRESENTER_TMP / session_id
    meta_path = session_dir / PRESENTER_META
    if not meta_path.exists():
        return jsonify({"error": "not found"}), 404
    body = request.get_json(force=True) or {}
    slides = body.get("slides")
    if not isinstance(slides, list):
        return jsonify({"error": "slides가 필요합니다"}), 400
    meta = _json.loads(meta_path.read_text(encoding="utf-8"))
    meta["slides"] = slides
    meta_path.write_text(_json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify({"ok": True})


@app.route("/presenter/session/<session_id>", methods=["DELETE"])
def presenter_session_delete(session_id: str):
    session_dir = PRESENTER_TMP / session_id
    if not session_dir.exists():
        return jsonify({"error": "not found"}), 404
    _shutil.rmtree(session_dir, ignore_errors=True)
    return jsonify({"ok": True})


# ── tmp 자동 정리 ────────────────────────────────────────────
AVATAR_HISTORY_MAX_BYTES = 300 * 1024 * 1024  # 완료된 얼굴교체/아바타 영상 이력 총 용량 상한 — 넘으면 오래된 것부터 삭제

def _cleanup_tmp(avatar_job_max_age_h: float = 6, stt_max_age_h: float = 24,
                  presenter_max_age_h: float = 6) -> dict:
    """누적되는 tmp 산출물 + 죽은 job_id를 참조하는 메모리 잡 딕셔너리를 함께 정리한다.
    - tmp/avatar: 최종 영상(result/**/*.mp4 또는 faceswap_result.mp4)이 없는 잡 폴더(tts_only speech.wav·실패 잡)만
      나이 기준으로 삭제. 영상이 있는 폴더는 /avatar/history, /avatar/faceswap/history의 영구 저장소라 나이로는
      안 지우지만, 총 용량이 AVATAR_HISTORY_MAX_BYTES를 넘으면 오래된 것부터 지운다(무한 증가 방지).
      youtube_downloads/ 는 job 폴더가 아니라 YouTube 다운로드 캐시 전용 디렉터리라 이 스캔에서 제외한다
      (예전엔 여기에 포함돼서, 6시간 넘게 새 다운로드가 없으면 통째로 삭제될 수 있었다).
    - tmp/stt: STT 임시 파일(크래시로 finally를 못 탄 잔여물)을 나이 기준으로 삭제.
    - tmp/presenter: slides.json(저장 완료 표시)이 없는 세션(업로드만 하고 저장 전 이탈/실패)을 나이 기준으로 삭제.
    - _avatar_jobs/_faceswap_jobs/_ytdl_jobs/_presenter_jobs: 위 정리로 폴더가 사라진 job_id는
      메모리에서도 함께 제거(서버 수명 내내 무한 누적되는 것 방지).
    반환: {"avatar_removed", "avatar_freed_mb", "stt_removed", "presenter_removed", "jobs_pruned",
           "history_removed", "history_freed_mb"}"""
    now = time.time()
    removed_dirs = 0
    freed = 0
    history_dirs = []  # 최종 영상이 있어 나이로는 안 지워진 폴더 — (path, mtime, size)
    if AVATAR_TMP.exists():
        for job_dir in AVATAR_TMP.iterdir():
            if not job_dir.is_dir() or job_dir.name == "youtube_downloads":
                continue
            try:
                # 최종 영상이 하나라도 있으면 이력 — 나이와 무관하게 보존 대상 후보로 모아둔다
                # (temp_/​_full.mp4는 중간 산출물이라 제외)
                has_video = (job_dir / "faceswap_result.mp4").exists() or any(
                    not f.name.startswith("temp_") and not f.name.endswith("_full.mp4")
                    for f in job_dir.glob("result/**/*.mp4")
                )
                mtime = job_dir.stat().st_mtime
                if has_video:
                    sz = sum(f.stat().st_size for f in job_dir.rglob("*") if f.is_file())
                    history_dirs.append((job_dir, mtime, sz))
                    continue
                if (now - mtime) / 3600 < avatar_job_max_age_h:
                    continue
                sz = sum(f.stat().st_size for f in job_dir.rglob("*") if f.is_file())
                _shutil.rmtree(job_dir, ignore_errors=True)
                removed_dirs += 1
                freed += sz
            except OSError:
                continue

    history_removed = 0
    history_freed = 0
    total_history_bytes = sum(sz for _, _, sz in history_dirs)
    if total_history_bytes > AVATAR_HISTORY_MAX_BYTES:
        history_dirs.sort(key=lambda item: item[1])  # 오래된 것부터
        for job_dir, _, sz in history_dirs:
            if total_history_bytes <= AVATAR_HISTORY_MAX_BYTES:
                break
            try:
                _shutil.rmtree(job_dir, ignore_errors=True)
                history_removed += 1
                history_freed += sz
                total_history_bytes -= sz
            except OSError:
                continue

    stt_removed = 0
    if STT_TMP.exists():
        for f in STT_TMP.iterdir():
            try:
                if f.is_file() and (now - f.stat().st_mtime) / 3600 >= stt_max_age_h:
                    f.unlink(missing_ok=True)
                    stt_removed += 1
            except OSError:
                continue
    presenter_removed = 0
    if PRESENTER_TMP.exists():
        for session_dir in PRESENTER_TMP.iterdir():
            if not session_dir.is_dir():
                continue
            try:
                if (session_dir / PRESENTER_META).exists():
                    continue  # 저장 완료된 발표는 영구 보존
                if (now - session_dir.stat().st_mtime) / 3600 < presenter_max_age_h:
                    continue
                _shutil.rmtree(session_dir, ignore_errors=True)
                presenter_removed += 1
            except OSError:
                continue
    jobs_pruned = 0
    for jobs in (_avatar_jobs, _faceswap_jobs, _ytdl_jobs):
        for job_id in [k for k in jobs if not (AVATAR_TMP / k).exists()]:
            del jobs[job_id]
            jobs_pruned += 1
    for job_id in [k for k, v in _presenter_jobs.items()
                   if not (PRESENTER_TMP / v.get("session_id", "")).exists()]:
        del _presenter_jobs[job_id]
        jobs_pruned += 1
    return {"avatar_removed": removed_dirs,
            "avatar_freed_mb": round(freed / 1e6, 1),
            "stt_removed": stt_removed,
            "presenter_removed": presenter_removed,
            "jobs_pruned": jobs_pruned,
            "history_removed": history_removed,
            "history_freed_mb": round(history_freed / 1e6, 1)}


def _cleanup_tmp_loop(interval_h: float = 6):
    """백그라운드에서 주기적으로 _cleanup_tmp 실행."""
    while True:
        try:
            time.sleep(interval_h * 3600)
            stats = _cleanup_tmp()
            if stats["avatar_removed"] or stats["stt_removed"] or stats["presenter_removed"] or stats["jobs_pruned"] or stats["history_removed"]:
                print(f"[cleanup] avatar {stats['avatar_removed']}개"
                      f"({stats['avatar_freed_mb']}MB) / stt {stats['stt_removed']}개"
                      f" / presenter {stats['presenter_removed']}개 / jobs {stats['jobs_pruned']}개"
                      f" / history {stats['history_removed']}개({stats['history_freed_mb']}MB) 정리", flush=True)
        except Exception as e:
            print(f"[cleanup] 오류: {e}", flush=True)


@app.route("/tmp/cleanup", methods=["POST"])
def tmp_cleanup():
    """수동 tmp 정리 (영상 이력은 보존)."""
    return jsonify(_cleanup_tmp())


@app.route("/stt/warmup", methods=["POST", "GET"])
def stt_warmup():
    """STT 모델을 미리 로딩한다."""
    try:
        _get_whisper()
        return jsonify({"ok": True, "status": "ready"})
    except Exception as e:
        return jsonify({"error": f"STT warm-up failed: {e}"}), 500


@app.route("/status/services", methods=["GET"])
def status_services():
    """음성 관련 서버(TTS·STT) 준비 상태를 한 번에 알려준다. 프론트가 이걸 폴링해
    "준비 중 / 재시작 필요" 같은 안내와 재시작 버튼을 사용자에게 보여줄 수 있다.
    각 항목 state: ready(사용 가능) | starting(준비 중) | down(꺼짐·조치 필요)."""
    # ── TTS (XTTS 상주 워커 8768) ──
    if _xtts_worker_alive():
        xtts = {"state": "ready", "message": "음성 합성 준비됨"}
    elif _xtts_worker_process is not None and _xtts_worker_process.poll() is None:
        xtts = {"state": "starting", "message": "음성 서버 시동 중… (모델 로딩 최대 1분)"}
    else:
        xtts = {"state": "down", "message": "음성 서버가 꺼져 있습니다 — 재시작이 필요합니다"}

    # ── STT (faster-whisper) ──
    st = _whisper_status.get("state", "idle")
    if st == "ready":
        stt = {"state": "ready", "message": "음성 인식 준비됨"}
    elif st == "error":
        stt = {"state": "down",
               "message": f"음성 인식 로드 실패 — 재시작이 필요합니다 ({_whisper_status.get('detail', '')})"}
    else:  # idle | loading
        stt = {"state": "starting", "message": "음성 인식 준비 중…"}

    # ── 워처 (watcher/file_watcher.py — 문서 ingest + 시간별 백업) ──
    ws = _watcher_state()
    if ws["alive"]:
        watcher = {"state": "ready", "message": "문서 감시 중"}
    elif _watcher_process is not None and _watcher_process.poll() is None:
        watcher = {"state": "starting", "message": "문서 감시 시동 중…"}
    else:
        # 얼마나 오래 멈춰 있었는지가 중요하다 — 그동안 새 문서 ingest와 자동 백업이 모두 정지 상태였다.
        # (7일씩 멈춘 전례가 있어 "몇 초 전"과 "일주일 전"이 한눈에 구분돼야 한다)
        secs = ws.get("seconds_ago")
        since = f" (마지막 동작: {_humanize_ago(secs)})" if isinstance(secs, (int, float)) else ""
        watcher = {"state": "down",
                   "message": f"문서 감시·자동 백업이 멈춰 있습니다{since} — 재시작이 필요합니다"}

    return jsonify({"xtts": xtts, "stt": stt, "watcher": watcher})


@app.route("/status/restart_voice", methods=["POST"])
def status_restart_voice():
    """사용자가 '음성 서버 다시 시작'을 눌렀을 때 — 꺼진 서버를 백그라운드로 다시 띄운다.
    XTTS 워커 재기동 + STT 워밍업(로드 실패 상태였다면 재시도)을 함께 트리거한다."""
    xtts_res = _ensure_xtts_worker()
    # STT가 오류/미로딩 상태면 백그라운드로 다시 로드 시도
    if _whisper_status.get("state") in ("error", "idle"):
        def _reload_whisper():
            try:
                _get_whisper()
            except Exception as e:
                print(f"[whisper] 재로드 실패: {e}", flush=True)
        _threading.Thread(target=_reload_whisper, daemon=True).start()
    return jsonify({"xtts": xtts_res, "stt_reload": _whisper_status.get("state")})


if __name__ == "__main__":
    init_db()
    print("=" * 50)
    print("Mental Avatar API 서버")
    print("주소: http://127.0.0.1:8766")
    print("=" * 50)
    # 시작 시 1회 정리 + 6시간마다 주기 정리 (영상 이력은 보존)
    try:
        _boot_stats = _cleanup_tmp()
        if _boot_stats["avatar_removed"] or _boot_stats["stt_removed"] or _boot_stats["presenter_removed"] or _boot_stats["jobs_pruned"] or _boot_stats["history_removed"]:
            print(f"[cleanup] 시작 정리: avatar {_boot_stats['avatar_removed']}개"
                  f"({_boot_stats['avatar_freed_mb']}MB) / stt {_boot_stats['stt_removed']}개"
                  f" / presenter {_boot_stats['presenter_removed']}개 / jobs {_boot_stats['jobs_pruned']}개"
                  f" / history {_boot_stats['history_removed']}개({_boot_stats['history_freed_mb']}MB)", flush=True)
    except Exception as _e:
        print(f"[cleanup] 시작 정리 오류: {_e}", flush=True)
    _threading.Thread(target=_cleanup_tmp_loop, daemon=True).start()
    # XTTS 워커 자동 기동 + 주기적 생존 확인(꺼져 있으면 자동 재시작)
    _threading.Thread(target=_ensure_xtts_worker, daemon=True).start()
    _threading.Thread(target=_xtts_watchdog_loop, daemon=True).start()
    _threading.Thread(target=_get_whisper, daemon=True).start()
    # 워처도 같은 방식으로 자동복구(즉시 기동은 하지 않음 — 부팅 시 start_dashboard.bat과 중복 기동 방지)
    _threading.Thread(target=_watcher_watchdog_loop, daemon=True).start()
    app.run(host="127.0.0.1", port=8766, debug=False, threaded=True)
