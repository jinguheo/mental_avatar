"""자율 검색 에이전트
지식 갭 + 관심사 트렌드 → 검색어 생성 → my-dashboard MCP로 웹 검색 → KG 보강
"""
import sys, os, json, requests
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core import pattern, env
from core import graph, embeddings


def _mcp_call(tool: str, args: dict) -> dict:
    """my-dashboard MCP 서버 호출"""
    endpoint = env.get("DASHBOARD_MCP", "http://127.0.0.1:8765/mcp")
    payload = {
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": args}
    }
    try:
        resp = requests.post(endpoint, json=payload, timeout=60)
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def generate_queries() -> list[str]:
    """관심사 + 갭 기반 검색어 생성 (Claude)"""
    interests = pattern.core_interests(5)
    gaps = pattern.knowledge_gaps()

    if not env.get("ANTHROPIC_API_KEY") or not interests:
        # 폴백: 갭 토픽을 그대로 검색어로
        return [g["topic"] for g in gaps[:3]]

    try:
        import anthropic
        client = anthropic.Anthropic(api_key=env.get("ANTHROPIC_API_KEY"))
        prompt = (
            f"핵심 관심사: {json.dumps(interests, ensure_ascii=False)}\n"
            f"부족한 영역: {json.dumps(gaps[:5], ensure_ascii=False)}\n\n"
            "이 사람이 지식을 보강하기 위해 검색하면 좋을 구체적 검색어 3개를 "
            "JSON 배열로만 응답하세요. 예: [\"검색어1\", \"검색어2\", \"검색어3\"]"
        )
        msg = client.messages.create(
            model="claude-sonnet-4-6", max_tokens=256,
            messages=[{"role": "user", "content": prompt}]
        )
        text = msg.content[0].text.strip()
        if "```" in text:
            text = text.split("```")[1].lstrip("json").strip()
        return json.loads(text)
    except Exception as e:
        print(f"[searcher] 검색어 생성 실패: {e}")
        return [g["topic"] for g in gaps[:3]]


def _mcp_json(resp: dict):
    """MCP tools/call 응답에서 결과 JSON 페이로드 추출"""
    try:
        return resp["result"]["content"][0]["json"]
    except (KeyError, IndexError, TypeError):
        return None


def _ingest_summary(query: str, summary: dict) -> str:
    """웹 요약을 KG 노드로 추가 (graph + 벡터)"""
    title   = summary.get("title") or query
    content = summary.get("summary", "")
    url     = summary.get("url", "")
    node_id = graph.add_node(
        type="chunk", title=title, content=content,
        source_type="web_search", file_path=url
    )
    embeddings.add_document(node_id, title, content, {
        "source_type": "web_search",
        "file_path": url,
        "query": query,
    })
    return node_id


def enrich(auto_add: bool = False) -> dict:
    """검색어로 뉴스 검색 → 페이지 요약 → KG 보강
    auto_add=True면 요약을 바로 KG에 추가, False면 검토용 후보만 반환"""
    queries = generate_queries()
    candidates = []

    for q in queries:
        news = _mcp_json(_mcp_call("news.ai", {"query": q, "maxResults": 3})) or []
        if not news:
            candidates.append({"query": q, "status": "검색 결과 없음"})
            continue

        top = news[0]
        url = top.get("url", "")
        if not url:
            candidates.append({"query": q, "status": "URL 없음", "title": top.get("title", "")})
            continue

        summary = _mcp_json(_mcp_call("web.summarize", {"url": url, "summarySentences": 4})) or {}
        if not summary.get("summary"):
            candidates.append({"query": q, "status": "요약 실패", "url": url, "title": top.get("title", "")})
            continue
        summary.setdefault("url", url)

        candidate = {
            "query": q,
            "url": url,
            "title": summary.get("title") or top.get("title", ""),
            "summary": summary.get("summary"),
            "status": "검토 대기",
        }
        if auto_add:
            candidate["node_id"] = _ingest_summary(q, summary)
            candidate["status"] = "KG에 추가됨"
        candidates.append(candidate)

    return {
        "queries": queries,
        "candidates": candidates,
        "auto_add": auto_add,
    }


if __name__ == "__main__":
    import pprint
    pprint.pprint(enrich())
