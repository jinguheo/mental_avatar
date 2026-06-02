"""Wiki → Graphify 자동 파이프라인.

문서 처리(queue/auto_summarize) 완료 후 백그라운드에서 실행:
  1. wiki_pages → graphify-wiki/*.md 내보내기
  2. graphify 감지 → 추출 → 클러스터 → HTML/JSON 생성
"""
import json
import os
from pathlib import Path

WIKI_DIR    = Path(__file__).parent.parent / "graphify-wiki"
OUT_DIR     = Path(__file__).parent.parent / "graphify-out"
COMMUNITY_LABELS: dict[int, str] = {}   # 이전 레이블 재사용


# ── 1. Wiki 내보내기 ──────────────────────────────────

def export_wiki_pages() -> int:
    """wiki_pages DB → graphify-wiki/*.md. 반환값: 작성된 파일 수."""
    from db.init_db import get_conn
    WIKI_DIR.mkdir(parents=True, exist_ok=True)

    conn = get_conn()
    rows = conn.execute(
        "SELECT title, file_path, status, wiki_content FROM wiki_pages "
        "WHERE status IN ('done','ollama_only') AND wiki_content IS NOT NULL"
    ).fetchall()
    conn.close()

    written = 0
    for row in rows:
        title   = row["title"] or row["file_path"] or "untitled"
        content = row["wiki_content"] or ""
        if not content.strip():
            continue
        safe = "".join(c if c.isalnum() or c in "-_ " else "_" for c in title).strip()[:80] or "doc"
        fpath = WIKI_DIR / f"{safe}.md"
        fpath.write_text(
            f"---\nfile_path: {row['file_path']}\nstatus: {row['status']}\n---\n\n{content}",
            encoding="utf-8"
        )
        written += 1

    return written


# ── 2. Graphify 파이프라인 ────────────────────────────

def _load_labels() -> dict[int, str]:
    labels_file = OUT_DIR / ".graphify_labels.json"
    if labels_file.exists():
        try:
            return {int(k): v for k, v in json.loads(labels_file.read_text(encoding="utf-8")).items()}
        except Exception:
            pass
    return {}


def run_graphify(job: dict) -> None:
    """전체 graphify 파이프라인을 백그라운드 스레드에서 실행.
    job dict에 진행 상태를 업데이트한다."""
    try:
        from graphify.detect import detect
        from graphify.cache import check_semantic_cache
        from graphify.build import build_from_json
        from graphify.cluster import cluster, score_all
        from graphify.analyze import god_nodes, surprising_connections, suggest_questions
        from graphify.report import generate
        from graphify.export import to_json, to_html
    except ImportError as e:
        job["error"] = f"graphify 미설치: {e}"
        job["running"] = False
        return

    try:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        cwd = Path(__file__).parent.parent

        # Step 1: Wiki 내보내기
        job["stage"] = "wiki 내보내기"
        n_exported = export_wiki_pages()
        job["exported"] = n_exported
        if n_exported == 0:
            job["error"] = "내보낼 wiki 페이지가 없습니다."
            job["running"] = False
            return

        # Step 2: 파일 감지
        job["stage"] = "파일 감지"
        detection = detect(WIKI_DIR)
        all_files = [f for files in detection.get("files", {}).values() for f in files]

        # Step 3: 캐시 확인 + 시맨틱 추출
        job["stage"] = "엔티티 추출"
        cached_nodes, cached_edges, cached_hyper, uncached = check_semantic_cache(all_files)

        # 변경 파일 없으면 캐시만으로 재빌드
        new_nodes, new_edges, new_hyper = [], [], []
        if uncached:
            extracted = _extract_semantic(uncached)
            new_nodes  = extracted.get("nodes", [])
            new_edges  = extracted.get("edges", [])
            new_hyper  = extracted.get("hyperedges", [])
            # 캐시 저장
            try:
                from graphify.cache import save_semantic_cache
                save_semantic_cache(new_nodes, new_edges, new_hyper)
            except Exception:
                pass

        all_nodes_merged = _dedup(cached_nodes + new_nodes)
        extraction = {
            "nodes": all_nodes_merged,
            "edges": cached_edges + new_edges,
            "hyperedges": cached_hyper + new_hyper,
            "input_tokens": 0,
            "output_tokens": 0,
        }

        # Step 4: 그래프 빌드 + 클러스터
        job["stage"] = "그래프 빌드"
        G = build_from_json(extraction)
        if G.number_of_nodes() == 0:
            job["error"] = "그래프가 비어있습니다."
            job["running"] = False
            return

        communities = cluster(G)
        cohesion    = score_all(G, communities)
        gods        = god_nodes(G)
        surprises   = surprising_connections(G, communities)

        # 레이블: 이전 레이블 재사용 + 신규 커뮤니티는 자동 생성
        labels = _load_labels()
        for cid in communities:
            if cid not in labels:
                sample = communities[cid][:2]
                labels[cid] = " & ".join(
                    G.nodes[n].get("label", str(n)).split()[0] for n in sample if n in G.nodes
                ) or f"Community {cid}"

        questions = suggest_questions(G, communities, labels)

        # Step 5: 리포트 + JSON 저장
        job["stage"] = "보고서 생성"
        report = generate(
            G, communities, cohesion, labels, gods, surprises,
            detection, {"input": 0, "output": 0},
            str(WIKI_DIR), suggested_questions=questions,
        )
        (OUT_DIR / "GRAPH_REPORT.md").write_text(report, encoding="utf-8")
        to_json(G, communities, str(OUT_DIR / "graph.json"))

        # 레이블 저장 (다음 실행에서 재사용)
        (OUT_DIR / ".graphify_labels.json").write_text(
            json.dumps({str(k): v for k, v in labels.items()}), encoding="utf-8"
        )

        # Step 6: HTML
        job["stage"] = "HTML 생성"
        to_html(G, communities, str(OUT_DIR / "graph.html"), community_labels=labels)

        job["nodes"]     = G.number_of_nodes()
        job["edges"]     = G.number_of_edges()
        job["communities"] = len(communities)
        job["stage"]     = "완료"
        job["error"]     = ""

    except Exception as e:
        job["error"] = str(e)
        import traceback
        print(f"[graphify_runner] 오류: {traceback.format_exc()}")
    finally:
        job["running"] = False


def _extract_semantic(files: list[str]) -> dict:
    """변경된 파일에서 엔티티/관계 추출 (LLM 없이 키워드 기반 빠른 추출).
    wiki 마크다운은 이미 구조화된 텍스트라 키워드로도 충분하다."""
    import re
    nodes, edges = [], []
    seen_ids: set[str] = set()

    for fpath in files:
        try:
            text = Path(fpath).read_text(encoding="utf-8")
            stem = Path(fpath).stem[:40].replace(" ", "_")

            # 마크다운 헤더에서 개념 추출 (## 핵심 개념, ## 주요 내용 등)
            concepts = re.findall(r'\*\*([^*]{2,40})\*\*', text)
            backtick = re.findall(r'`([^`]{2,30})`', text)
            all_concepts = list(dict.fromkeys(concepts + backtick))[:8]

            # 문서 대표 노드
            doc_id = f"{stem}_doc"
            if doc_id not in seen_ids:
                nodes.append({"id": doc_id, "label": Path(fpath).stem.replace("_", " "),
                              "file_type": "document", "source_file": fpath,
                              "source_location": None, "source_url": None,
                              "captured_at": None, "author": None, "contributor": None})
                seen_ids.add(doc_id)

            for concept in all_concepts:
                cid = re.sub(r'[^a-zA-Z0-9가-힣]', '_', concept.lower())[:30]
                cid = f"{stem}_{cid}"
                if cid not in seen_ids:
                    nodes.append({"id": cid, "label": concept,
                                  "file_type": "document", "source_file": fpath,
                                  "source_location": None, "source_url": None,
                                  "captured_at": None, "author": None, "contributor": None})
                    seen_ids.add(cid)
                edges.append({"source": doc_id, "target": cid,
                              "relation": "references", "confidence": "EXTRACTED",
                              "confidence_score": 1.0, "source_file": fpath,
                              "source_location": None, "weight": 1.0})
        except Exception as ex:
            print(f"[graphify_runner] 추출 실패 {fpath}: {ex}")

    return {"nodes": nodes, "edges": edges, "hyperedges": [], "input_tokens": 0, "output_tokens": 0}


def _dedup(nodes: list[dict]) -> list[dict]:
    seen, result = set(), []
    for n in nodes:
        if n["id"] not in seen:
            seen.add(n["id"])
            result.append(n)
    return result
