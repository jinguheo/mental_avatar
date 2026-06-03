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


def _ollama_extract(title: str, content: str) -> dict | None:
    """Ollama gemma4:e2b로 엔티티/관계 추출. 실패 시 None."""
    import json
    import urllib.request

    OLLAMA_URL   = "http://localhost:11434/api/chat"
    OLLAMA_MODEL = "gemma4:e2b"

    prompt = f"""다음 문서에서 지식 그래프 구성 요소를 추출하세요.

문서 제목: {title}
문서 내용 (최대 2000자):
{content[:2000]}

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{{
  "entities": [
    {{"name": "엔티티명", "type": "concept|person|tool|paper|organization|technology"}}
  ],
  "relations": [
    {{"from": "엔티티A", "to": "엔티티B", "relation": "relates_to|part_of|implements|applied_to"}}
  ]
}}"""

    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 1024},
    }).encode()

    try:
        req = urllib.request.Request(OLLAMA_URL, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        text = data.get("message", {}).get("content", "")
        # ```json ... ``` 제거
        import re
        if "```" in text:
            m = re.search(r"```(?:json)?\s*([\s\S]+?)```", text)
            if m:
                text = m.group(1)
        return json.loads(text.strip())
    except Exception as ex:
        print(f"[graphify_runner] Ollama 추출 실패: {ex}")
        return None


def _extract_semantic(files: list[str]) -> dict:
    """변경된 파일에서 엔티티/관계 추출.
    Ollama gemma4:e2b 우선, 실패 시 키워드 기반 fallback."""
    import re
    nodes, edges = [], []
    seen_ids: set[str] = set()
    seen_entity_ids: set[str] = set()

    for fpath in files:
        try:
            text = Path(fpath).read_text(encoding="utf-8")
            stem = Path(fpath).stem[:40].replace(" ", "_")
            title = Path(fpath).stem.replace("_", " ")

            # 문서 대표 노드
            doc_id = f"{stem}_doc"
            if doc_id not in seen_ids:
                nodes.append({"id": doc_id, "label": title,
                              "file_type": "document", "source_file": fpath,
                              "source_location": None, "source_url": None,
                              "captured_at": None, "author": None, "contributor": None})
                seen_ids.add(doc_id)

            # Ollama LLM 추출 시도
            extracted = _ollama_extract(title, text)

            if extracted and extracted.get("entities"):
                entity_id_map: dict[str, str] = {}
                for ent in extracted["entities"][:15]:
                    name = ent.get("name", "").strip()
                    if not name or len(name) < 2:
                        continue
                    eid = re.sub(r'[^a-zA-Z0-9가-힣]', '_', name.lower())[:40]
                    # 전역 중복 방지: 같은 엔티티명이면 동일 ID 재사용
                    global_id = f"ent_{eid}"
                    entity_id_map[name] = global_id
                    if global_id not in seen_entity_ids:
                        nodes.append({"id": global_id, "label": name,
                                      "file_type": ent.get("type", "concept"),
                                      "source_file": fpath,
                                      "source_location": None, "source_url": None,
                                      "captured_at": None, "author": None, "contributor": None})
                        seen_entity_ids.add(global_id)
                        seen_ids.add(global_id)
                    # 문서 → 엔티티 엣지
                    edges.append({"source": doc_id, "target": global_id,
                                  "relation": "mentions", "confidence": "EXTRACTED",
                                  "confidence_score": 1.0, "source_file": fpath,
                                  "source_location": None, "weight": 1.0})

                # 엔티티 간 관계 엣지
                for rel in extracted.get("relations", [])[:20]:
                    src_name = rel.get("from", "")
                    tgt_name = rel.get("to", "")
                    relation  = rel.get("relation", "relates_to")
                    src_id = entity_id_map.get(src_name)
                    tgt_id = entity_id_map.get(tgt_name)
                    if src_id and tgt_id:
                        edges.append({"source": src_id, "target": tgt_id,
                                      "relation": relation, "confidence": "EXTRACTED",
                                      "confidence_score": 0.9, "source_file": fpath,
                                      "source_location": None, "weight": 1.2})
            else:
                # fallback: 마크다운 볼드/백틱 키워드
                concepts = re.findall(r'\*\*([^*]{2,40})\*\*', text)
                backtick = re.findall(r'`([^`]{2,30})`', text)
                for concept in list(dict.fromkeys(concepts + backtick))[:8]:
                    cid = f"{stem}_{re.sub(r'[^a-zA-Z0-9가-힣]', '_', concept.lower())[:30]}"
                    if cid not in seen_ids:
                        nodes.append({"id": cid, "label": concept,
                                      "file_type": "concept", "source_file": fpath,
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
