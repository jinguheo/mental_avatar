"""추천 엔진 — 연결고리 발견 + 관련 자료 추천"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core import graph, embeddings, pattern


def related_to_recent(limit: int = 8) -> list[dict]:
    """최근 추가된 노드와 의미적으로 가까운 다른 노드 추천"""
    recent = graph.list_nodes(limit=5)
    seen = {n["id"] for n in recent}
    recs = []

    for node in recent:
        similar = embeddings.search(node["title"] + " " + (node["content"] or "")[:200], n_results=4)
        for s in similar:
            if s["id"] in seen:
                continue
            seen.add(s["id"])
            target = graph.get_node(s["id"])
            if target:
                recs.append({
                    "because_of": node["title"],
                    "recommend": target["title"],
                    "node_id": s["id"],
                    "source_type": target["source_type"],
                    "similarity": round(1 - s["distance"], 3)
                })
    recs.sort(key=lambda r: r["similarity"], reverse=True)
    return recs[:limit]


def cross_connections(limit: int = 5) -> list[dict]:
    """서로 다른 소스(예: 엑셀 vs 논문)인데 의미가 가까운 연결고리 발견"""
    nodes = graph.list_nodes(limit=30)
    connections = []
    seen_pairs = set()

    for node in nodes:
        similar = embeddings.search((node["content"] or node["title"])[:300], n_results=3)
        for s in similar:
            if s["id"] == node["id"]:
                continue
            target = graph.get_node(s["id"])
            if not target:
                continue
            # 다른 소스끼리 + 유사도 높을 때만
            if target["source_type"] != node["source_type"] and (1 - s["distance"]) > 0.4:
                pair = tuple(sorted([node["id"], s["id"]]))
                if pair in seen_pairs:
                    continue
                seen_pairs.add(pair)
                connections.append({
                    "node_a": node["title"],
                    "source_a": node["source_type"],
                    "node_b": target["title"],
                    "source_b": target["source_type"],
                    "similarity": round(1 - s["distance"], 3)
                })
    connections.sort(key=lambda c: c["similarity"], reverse=True)
    return connections[:limit]


if __name__ == "__main__":
    import pprint
    print("=== 최근 기반 추천 ===")
    pprint.pprint(related_to_recent())
    print("\n=== 교차 연결고리 ===")
    pprint.pprint(cross_connections())
