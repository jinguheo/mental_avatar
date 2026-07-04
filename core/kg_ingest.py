"""문서 청크 → KG 저장 공유 파이프라인.

워처(queue_mgr)와 수동 업로드(api/server) 두 경로가 같은 로직을 쓰도록 통일한다.
기존 워처 경로는 첫 청크만 추출하고 LLM이 뽑은 relations를 버렸으나, 여기서는
  1. 모든 청크에서 엔티티/토픽/관계 추출
  2. LLM relations를 엔티티↔엔티티 엣지로 반영 (관계 어휘는 canonical 15종으로 정규화)
  3. 관계 endpoint가 엔티티로 안 뽑혔으면 자동 upsert해 연결 유실 방지
를 모두 수행한다.
"""
import hashlib
from . import graph, embeddings, extractor


# ── 관계 어휘 정규화 ──────────────────────────────────
# 추출된 relation 문자열이 214종까지 파편화돼(대부분 1회성) 그래프 추론이 무의미해지는
# 문제를 막기 위해, 모든 relation을 아래 canonical 집합으로 결정론적 매핑한다.
CANONICAL_RELATIONS = {
    "is_a", "part_of", "has_part", "uses", "implements", "applied_to",
    "causes", "enables", "requires", "contradicts", "cites", "defines",
    "precedes", "produces", "relates_to",
}


def canonical_relation(rel: str) -> str:
    """제각각인 relation 문자열을 canonical 15종 중 하나로 매핑한다."""
    import re
    r = re.sub(r"[\s\-]+", "_", (rel or "").strip().lower())
    if not r:
        return "relates_to"
    if r in CANONICAL_RELATIONS:
        return r

    def has(*subs: str) -> bool:
        return any(s in r for s in subs)

    # 구체적인 것부터 검사 (순서 중요)
    if has("contradict", "conflict", "inconsistent", "unsuitable", "prevent"):
        return "contradicts"
    if has("implement"):
        return "implements"
    if has("cite", "reference", "citation"):
        return "cites"
    if has("cause", "lead_to", "leads_to", "result_in", "results_in", "trigger"):
        return "causes"
    if has("require", "depend", "rely", "relies", "need", "prerequisite", "constrain", "must_"):
        return "requires"
    if has("enable", "allow", "facilitate", "support", "help", "provide"):
        return "enables"
    if has("produce", "generate", "create", "output", "yield", "compute", "estimate"):
        return "produces"
    if has("appli"):  # applied_to / applies_to
        return "applied_to"
    if has("use", "utiliz", "leverage", "employ", "harness"):
        return "uses"
    if has("precede", "before", "input_for", "feeds", "pipeline", "next", "chained"):
        return "precedes"
    if has("define", "describe", "represent", "characteriz", "specif", "measure"):
        return "defines"
    if has("type_of", "kind_of", "is_a", "instance_of", "example_of",
           "subclass", "special_case", "form_of", "a_method", "a_form"):
        return "is_a"
    if has("has_part", "includes", "comprises", "contains", "consists", "composed"):
        return "has_part"
    if has("part_of", "belongs", "member_of", "component_of", "forms_part"):
        return "part_of"
    # relate / associate / connect / link / similar 등 나머지는 일반 관계로
    return "relates_to"


# ── 청크 → KG 저장 ────────────────────────────────────

def process_chunks(chunks: list[dict], file_path: str = "") -> list[str]:
    """청크 리스트를 KG에 저장하고 node_id 리스트를 반환한다.

    각 청크마다: 노드 생성 → 벡터 저장 → part_of 엣지 → 엔티티/토픽/관계 추출.
    """
    node_ids: list[str] = []
    doc_node_id: str | None = None

    for chunk in chunks:
        title       = chunk.get("title", "")
        content     = chunk.get("content", "")
        meta        = chunk.get("meta", {})
        source_type = meta.get("source_type", "unknown")
        chunk_idx   = meta.get("chunk_index", 0)
        fpath       = meta.get("file_path", file_path)
        fhash       = hashlib.md5(content.encode()).hexdigest()[:12]

        node_id = graph.add_node(
            type="chunk", title=title, content=content,
            source_type=source_type, file_path=fpath,
            file_hash=fhash, chunk_index=chunk_idx,
        )
        node_ids.append(node_id)

        embeddings.add_document(node_id, title, content, {
            "source_type": source_type,
            "file_path": fpath,
            "chunk_index": str(chunk_idx),
        })

        # 첫 청크를 문서 대표 노드로, 나머지는 part_of로 연결
        if doc_node_id is None:
            doc_node_id = node_id
        elif node_id != doc_node_id:
            graph.add_edge(doc_node_id, node_id, "part_of", 1.0)

        # 엔티티/토픽/관계 추출 (내용이 있을 때만)
        if content and len(content) > 100:
            _extract_into_graph(node_id, title, content)

        graph.log_activity(node_id, "created", f"ingested from {source_type}")

    return node_ids


def _extract_into_graph(node_id: str, title: str, content: str) -> None:
    """한 청크에서 엔티티/토픽/관계를 뽑아 그래프에 기록한다."""
    try:
        extracted = extractor.extract(title, content)
    except Exception as ex:
        print(f"[kg_ingest] 추출 경고 (무시됨): {ex}")
        return

    # 토픽
    for topic in extracted.get("topics", []):
        graph.link_node_topic(node_id, topic)

    # 엔티티 노드 + 문서→엔티티(mentions) 엣지
    entity_id_map: dict[str, str] = {}
    for ent in extracted.get("entities", []):
        ename = ent.get("name", "").strip()
        if not ename:
            continue
        eid = graph.upsert_entity(ename, ent.get("type", "concept"), ent.get("description", ""))
        entity_id_map[ename] = eid
        graph.add_edge(node_id, eid, "mentions", 1.0)

    # 엔티티 간 관계 엣지 (관계 어휘 정규화 + endpoint 자동 연결)
    for rel in extracted.get("relations", []):
        a = rel.get("from", "").strip()
        b = rel.get("to", "").strip()
        if not a or not b:
            continue
        relation = canonical_relation(rel.get("relation", "relates_to"))

        aid = entity_id_map.get(a)
        bid = entity_id_map.get(b)
        # relation에만 등장하고 엔티티 목록엔 없던 개념도 노드로 만들어 연결 유실 방지
        if not aid and 2 <= len(a) <= 40:
            aid = graph.upsert_entity(a)
            entity_id_map[a] = aid
            graph.add_edge(node_id, aid, "mentions", 1.0)
        if not bid and 2 <= len(b) <= 40:
            bid = graph.upsert_entity(b)
            entity_id_map[b] = bid
            graph.add_edge(node_id, bid, "mentions", 1.0)

        if aid and bid and aid != bid:
            graph.add_edge(aid, bid, relation, 0.8)

    # 중요도 반영
    importance = extracted.get("importance", 0.5)
    graph.update_importance(node_id, importance - 0.5)
