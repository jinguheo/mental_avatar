"""Mental Avatar API 서버 — 포트 8766"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
import hashlib
import uuid, subprocess
from pathlib import Path

from db.init_db import init as init_db
from core import graph, extractor, embeddings, pattern, wiki, queue_mgr, avatar as avatar_core
from agent import recommender, searcher
from watcher.parsers import parse_file

app = Flask(__name__)
CORS(app)


def _process_chunks(chunks: list[dict], file_path: str = "") -> list[str]:
    """청크 리스트를 KG에 저장, node_id 리스트 반환"""
    node_ids = []
    doc_node_id = None

    for chunk in chunks:
        title   = chunk.get("title", "")
        content = chunk.get("content", "")
        meta    = chunk.get("meta", {})
        source_type = meta.get("source_type", "unknown")
        chunk_idx   = meta.get("chunk_index", 0)
        fpath       = meta.get("file_path", file_path)
        fhash       = hashlib.md5(content.encode()).hexdigest()[:12]

        # KG 노드 추가
        node_id = graph.add_node(
            type="chunk",
            title=title,
            content=content,
            source_type=source_type,
            file_path=fpath,
            file_hash=fhash,
            chunk_index=chunk_idx
        )
        node_ids.append(node_id)

        # 벡터 저장
        embeddings.add_document(node_id, title, content, {
            "source_type": source_type,
            "file_path": fpath,
            "chunk_index": str(chunk_idx)
        })

        # 첫 청크를 대표 노드로 설정
        if doc_node_id is None:
            doc_node_id = node_id

        # 청크 간 연결
        if doc_node_id and node_id != doc_node_id:
            graph.add_edge(doc_node_id, node_id, "part_of", 1.0)

        # Claude 엔티티 추출 (내용이 있을 때만)
        if content and len(content) > 100:
            extracted = extractor.extract(title, content)

            # 토픽 연결
            for topic in extracted.get("topics", []):
                graph.link_node_topic(node_id, topic)

            # 엔티티 노드 추가 + 문서→엔티티 엣지
            entity_id_map: dict[str, str] = {}
            for ent in extracted.get("entities", []):
                ename = ent.get("name", "").strip()
                if not ename:
                    continue
                eid = graph.upsert_entity(ename, ent.get("type", "concept"), ent.get("description", ""))
                entity_id_map[ename] = eid
                graph.add_edge(node_id, eid, "mentions", 1.0)

            # 엔티티 간 관계 엣지
            for rel in extracted.get("relations", []):
                a, b = rel.get("from", "").strip(), rel.get("to", "").strip()
                relation = rel.get("relation", "relates_to")
                aid = entity_id_map.get(a) or graph._entity_id_by_name(a)
                bid = entity_id_map.get(b) or graph._entity_id_by_name(b)
                if aid and bid:
                    graph.add_edge(aid, bid, relation, 0.8)

            # 중요도 반영
            importance = extracted.get("importance", 0.5)
            graph.update_importance(node_id, importance - 0.5)

        graph.log_activity(node_id, "created", f"ingested from {source_type}")

    return node_ids


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
    """graph.json에서 쿼리와 관련된 커뮤니티 노드를 검색."""
    import json as _json
    graph_path = os.path.join(os.path.dirname(__file__), "..", "graphify-out", "graph.json")
    labels_path = os.path.join(os.path.dirname(__file__), "..", "graphify-out", ".graphify_labels.json")
    if not os.path.exists(graph_path):
        return []
    try:
        gdata  = _json.loads(open(graph_path, encoding="utf-8").read())
        labels = _json.loads(open(labels_path, encoding="utf-8").read()) if os.path.exists(labels_path) else {}
        q_low  = q.lower()
        matched_communities: set[int] = set()
        results = []
        # 1단계: 쿼리와 레이블이 매칭되는 커뮤니티 찾기
        for cid, label in labels.items():
            if q_low in label.lower():
                matched_communities.add(int(cid))
        # 2단계: 노드 레이블에서 직접 매칭
        for node in gdata.get("nodes", []):
            label = node.get("label", "")
            cid   = node.get("community")
            if q_low in label.lower():
                matched_communities.add(cid)
        # 3단계: 매칭된 커뮤니티의 문서 노드 수집
        seen = set()
        for node in gdata.get("nodes", []):
            if node.get("community") in matched_communities and node.get("file_type") == "document":
                nid = node["id"]
                if nid in seen:
                    continue
                seen.add(nid)
                cid = node.get("community")
                results.append({
                    "id": nid,
                    "title": node.get("label", nid),
                    "source_type": "graphify",
                    "community": labels.get(str(cid), f"Community {cid}"),
                    "distance": 0.0,
                    "document": f"[Graphify] 커뮤니티: {labels.get(str(cid), '')}",
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
    if q:
        graph.log_activity(None, "search", q)

    if not q:
        return jsonify({"error": "q 파라미터 필요"}), 400

    if mode == "semantic":
        results = embeddings.search(q, n_results=limit)
        for r in results:
            node = graph.get_node(r["id"])
            if node:
                r["title"] = node["title"]
                r["source_type"] = node["source_type"]
            r["_source"] = "kg"
    else:
        results = graph.search_nodes(q, limit=limit)
        for r in results:
            r["_source"] = "kg"

    # Graphify 커뮤니티 결과 병합 (중복 제거)
    kg_titles = {r.get("title", "").lower() for r in results}
    gf_results = _graphify_community_search(q)
    for gf in gf_results:
        if gf["title"].lower() not in kg_titles:
            results.append(gf)

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


@app.route("/avatar/context", methods=["GET"])
def avatar_context():
    q = request.args.get("q", "")
    return jsonify(avatar_core.build_avatar_context(q))


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
    return jsonify({"success": True})


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


# ── STT (faster-whisper) ──────────────────────────────────
_whisper_model = None

def _get_whisper():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel("small", device="cpu", compute_type="int8")
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
        segments, info = model.transcribe(str(tmp_wav), language="ko", beam_size=5)
        text = " ".join(seg.text.strip() for seg in segments).strip()
        return jsonify({"text": text, "language": info.language})
    except Exception as e:
        return jsonify({"error": f"STT 실패: {e}"}), 500
    finally:
        tmp_wav.unlink(missing_ok=True)


# ── Avatar Studio ────────────────────────────────────────────
SADTALKER_DIR   = Path(r"D:\MyWork\SadTalker")
AVATAR_TMP      = Path(__file__).parent.parent / "tmp" / "avatar"
AVATAR_DATA     = Path(__file__).parent.parent / "data"
VOICE_SAMPLE    = AVATAR_DATA / "voice_sample.wav"
PYTHON_EXE      = r"C:\Users\oem\miniconda3\envs\avatar\python.exe"   # SadTalker (numpy 1.26 패치판)
XTTS_PYTHON_EXE = r"C:\Users\oem\miniconda3\envs\xtts\python.exe"     # Coqui XTTS v2

# 비동기 생성 잡 저장소  {job_id: {stage, error, mp4_path}}
_avatar_jobs: dict = {}


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

@app.route("/avatar/register_face", methods=["POST"])
def avatar_register_face():
    f = request.files.get("face")
    if not f:
        return jsonify({"error": "face file required"}), 400
    AVATAR_DATA.mkdir(parents=True, exist_ok=True)
    dest = AVATAR_DATA / "face.jpg"
    f.save(str(dest))
    return jsonify({"status": "ok"})


@app.route("/avatar/tts_only", methods=["POST"])
def avatar_tts_only():
    """얼굴 없이 XTTS 음성 WAV만 생성 — 3D 아바타 립싱크용"""
    text = request.form.get("text", "").strip()
    if not text:
        return jsonify({"error": "text required"}), 400
    if not VOICE_SAMPLE.exists():
        return jsonify({"error": "voice sample not registered"}), 400

    import uuid as _uuid
    job_dir = AVATAR_TMP / _uuid.uuid4().hex
    job_dir.mkdir(parents=True, exist_ok=True)
    speech_path = job_dir / "speech.wav"

    tts_script = f"""
import sys, os
os.environ["COQUI_TOS_AGREED"] = "1"
os.environ["TTS_HOME"] = r"D:\\MyWork\\mental-avatar\\models"
sys.stdout.reconfigure(encoding='utf-8')
from TTS.api import TTS
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda")
tts.tts_to_file(
    text={repr(text)},
    speaker_wav={repr(str(VOICE_SAMPLE))},
    language="ko",
    file_path={repr(str(speech_path))}
)
"""
    script_path = job_dir / "run_tts.py"
    script_path.write_text(tts_script, encoding="utf-8")
    try:
        subprocess.run([XTTS_PYTHON_EXE, str(script_path)],
                       check=True, capture_output=True, timeout=180)
    except subprocess.CalledProcessError as e:
        return jsonify({"error": "TTS failed", "detail": e.stderr.decode(errors="replace")}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "TTS timeout"}), 500

    return send_file(str(speech_path), mimetype="audio/wav",
                     as_attachment=False, download_name="speech.wav")


def _run_avatar_job(job_id: str, face_path: Path, text: str, job_dir: Path) -> None:
    """백그라운드 스레드: TTS → SadTalker 순서로 실행."""
    job = _avatar_jobs[job_id]
    speech_path = job_dir / "speech.wav"

    # 1) TTS
    job["stage"] = "tts"
    tts_script = f"""
import sys, os
os.environ["COQUI_TOS_AGREED"] = "1"
os.environ["TTS_HOME"] = r"D:\\MyWork\\mental-avatar\\models"
sys.stdout.reconfigure(encoding='utf-8')
from TTS.api import TTS
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda")
tts.tts_to_file(
    text={repr(text)},
    speaker_wav={repr(str(VOICE_SAMPLE))},
    language="ko",
    file_path={repr(str(speech_path))}
)
"""
    tts_script_path = job_dir / "run_tts.py"
    tts_script_path.write_text(tts_script, encoding="utf-8")
    try:
        subprocess.run([XTTS_PYTHON_EXE, str(tts_script_path)],
                       check=True, capture_output=True, timeout=180)
    except subprocess.CalledProcessError as e:
        job["stage"] = "error"
        job["error"] = f"TTS 실패: {e.stderr.decode(errors='replace')[:300]}"
        return
    except subprocess.TimeoutExpired:
        job["stage"] = "error"
        job["error"] = "TTS 타임아웃"
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
    try:
        subprocess.run(cmd, check=True, cwd=str(SADTALKER_DIR),
                       capture_output=True, timeout=600, env=sad_env)
    except subprocess.CalledProcessError as e:
        job["stage"] = "error"
        job["error"] = f"SadTalker 실패: {e.stderr.decode(errors='replace')[:300]}"
        return
    except subprocess.TimeoutExpired:
        job["stage"] = "error"
        job["error"] = "SadTalker 타임아웃 (600s)"
        return

    mp4_files = list(result_dir.rglob("*.mp4"))
    if not mp4_files:
        job["stage"] = "error"
        job["error"] = "출력 영상 없음"
        return

    job["stage"] = "done"
    job["mp4_path"] = str(mp4_files[0])


@app.route("/avatar/generate_async", methods=["POST"])
def avatar_generate_async():
    """비동기 영상 생성: job_id 즉시 반환 후 백그라운드에서 TTS+SadTalker 실행."""
    face_file = request.files.get("face")
    ref_video = request.files.get("ref_pose")   # 참조 포즈 영상 (선택)
    text      = request.form.get("text", "").strip()

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
    face_file.save(str(face_path))

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
    """녹화 기반 잡: 오디오를 WAV로 변환 후 SadTalker 직접 실행 (XTTS 생략)."""
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
    try:
        subprocess.run(cmd, check=True, cwd=str(SADTALKER_DIR),
                       capture_output=True, timeout=600, env=sad_env)
    except subprocess.CalledProcessError as e:
        job["stage"] = "error"
        job["error"] = f"SadTalker 실패: {e.stderr.decode(errors='replace')[:300]}"
        return
    except subprocess.TimeoutExpired:
        job["stage"] = "error"; job["error"] = "SadTalker 타임아웃"; return

    mp4_files = list(result_dir.rglob("*.mp4"))
    if not mp4_files:
        job["stage"] = "error"; job["error"] = "출력 영상 없음"; return

    job["stage"] = "done"
    job["mp4_path"] = str(mp4_files[0])


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
    face_file.save(str(face_path))

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
            # result 폴더 바로 아래 최종 mp4 (타임스탬프.mp4 형태)
            mp4_files = sorted(
                [f for f in job_dir.glob("result/*.mp4")],
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
    mp4_files = sorted(job_dir.glob("result/*.mp4"), key=lambda f: f.stat().st_mtime, reverse=True)
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


_faceswap_jobs: dict = {}
_ytdl_jobs: dict = {}

YTDL_HISTORY_FILE = AVATAR_TMP / "ytdl_history.json"

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
    history.insert(0, entry)
    history = history[:50]
    YTDL_HISTORY_FILE.write_text(_json.dumps(history, ensure_ascii=False), encoding="utf-8")


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

            # 구간 자르기 (start/end 지정 또는 max_sec 초과 시 앞부분만)
            ffmpeg = str(SADTALKER_DIR / "ffmpeg.exe")
            ss_args = ["-ss", start] if start else []
            to_args = ["-to", end] if end else (["-t", str(max_sec)] if duration > max_sec else [])

            if ss_args or to_args:
                subprocess.run(
                    [ffmpeg, "-y"] + ss_args + ["-i", raw_path] + to_args +
                    ["-c", "copy", final_path],
                    check=True, capture_output=True, timeout=120
                )
                if not Path(final_path).exists():
                    final_path = raw_path
            else:
                final_path = raw_path

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
    if not job or job["stage"] != "done":
        return jsonify({"error": "not ready"}), 404
    return send_file(job["video_path"], mimetype="video/mp4", as_attachment=False,
                     download_name=f"{job.get('title','video')[:40]}.mp4")


@app.route("/avatar/faceswap", methods=["POST"])
def avatar_faceswap():
    """얼굴 교체: source_face + (target_video 파일 또는 yt_job_id) → 내 얼굴로 교체된 영상"""
    source_face  = request.files.get("source_face")
    target_video = request.files.get("target_video")
    yt_job_id    = request.form.get("yt_job_id", "")

    if not source_face:
        return jsonify({"error": "source_face 필요"}), 400
    if not target_video and not yt_job_id:
        return jsonify({"error": "target_video 또는 yt_job_id 필요"}), 400

    job_id  = str(uuid.uuid4())
    job_dir = AVATAR_TMP / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    face_path   = job_dir / f"source{Path(source_face.filename).suffix or '.jpg'}"
    output_path = str(job_dir / "faceswap_result.mp4")
    source_face.save(str(face_path))

    # 대상 영상: 직접 업로드 또는 YouTube 다운로드 결과 사용
    if yt_job_id and yt_job_id in _ytdl_jobs and _ytdl_jobs[yt_job_id]["stage"] == "done":
        video_path = Path(_ytdl_jobs[yt_job_id]["video_path"])
    else:
        video_path = job_dir / f"target{Path(target_video.filename).suffix or '.mp4'}"
        target_video.save(str(video_path))

    _faceswap_jobs[job_id] = {"stage": "processing", "error": "", "mp4_path": None}

    def _run():
        try:
            from core.faceswap import swap_faces_in_video
            swap_faces_in_video(str(face_path), str(video_path), output_path)
            _faceswap_jobs[job_id]["stage"] = "done"
            _faceswap_jobs[job_id]["mp4_path"] = output_path
        except Exception as e:
            _faceswap_jobs[job_id]["stage"] = "error"
            _faceswap_jobs[job_id]["error"] = str(e)

    _threading.Thread(target=_run, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/avatar/faceswap/<job_id>", methods=["GET"])
def avatar_faceswap_status(job_id: str):
    job = _faceswap_jobs.get(job_id)
    if not job:
        return jsonify({"error": "not found"}), 404
    return jsonify({**job, "video_url": f"/avatar/faceswap/{job_id}/video" if job["stage"] == "done" else None})


@app.route("/avatar/faceswap/<job_id>/video", methods=["GET"])
def avatar_faceswap_video(job_id: str):
    job = _faceswap_jobs.get(job_id)
    if not job or job["stage"] != "done":
        return jsonify({"error": "not ready"}), 404
    return send_file(job["mp4_path"], mimetype="video/mp4", as_attachment=False)


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
    face_file.save(str(face_path))

    speech_path = job_dir / "speech.wav"

    # 1) XTTS v2 TTS (xtts 환경의 python으로 subprocess 실행)
    tts_script = f"""
import sys, os
os.environ["COQUI_TOS_AGREED"] = "1"
os.environ["TTS_HOME"] = r"D:\\MyWork\\mental-avatar\\models"
sys.stdout.reconfigure(encoding='utf-8')
from TTS.api import TTS
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cuda")
tts.tts_to_file(
    text={repr(text)},
    speaker_wav={repr(str(VOICE_SAMPLE))},
    language="ko",
    file_path={repr(str(speech_path))}
)
"""
    tts_script_path = job_dir / "run_tts.py"
    tts_script_path.write_text(tts_script, encoding="utf-8")

    try:
        subprocess.run([XTTS_PYTHON_EXE, str(tts_script_path)],
                       check=True, capture_output=True, timeout=180)
    except subprocess.CalledProcessError as e:
        return jsonify({"error": "TTS failed", "detail": e.stderr.decode(errors="replace")}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "TTS timeout"}), 500

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
        subprocess.run(cmd, check=True, cwd=str(SADTALKER_DIR),
                       capture_output=True, timeout=600, env=sad_env)
    except subprocess.CalledProcessError as e:
        return jsonify({"error": "SadTalker failed", "detail": e.stderr.decode(errors="replace")}), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "SadTalker timeout after 600s"}), 500

    mp4_files = list(result_dir.rglob("*.mp4"))
    if not mp4_files:
        return jsonify({"error": "no output video found"}), 500

    return send_file(str(mp4_files[0]), mimetype="video/mp4",
                     as_attachment=False, download_name="avatar.mp4")


if __name__ == "__main__":
    init_db()
    print("=" * 50)
    print("Mental Avatar API 서버")
    print("주소: http://127.0.0.1:8766")
    print("=" * 50)
    app.run(host="127.0.0.1", port=8766, debug=False, threaded=True)
