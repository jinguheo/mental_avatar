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


def enrich(auto_add: bool = False) -> dict:
    """검색어로 웹 검색 → 요약 → KG 후보 생성"""
    queries = generate_queries()
    candidates = []

    for q in queries:
        # news.ai 또는 web 검색 활용 (dashboard MCP에 web.search가 없으면 news.ai)
        result = _mcp_call("news.ai", {"query": q}) if False else {}
        # 실제로는 검색 URL을 web.summarize로 요약하는 흐름
        # 여기서는 후보만 제시 (사용자 확인 후 추가)
        candidates.append({
            "query": q,
            "status": "검색어 생성됨",
            "note": "URL 확보 후 web.summarize로 요약 → /ingest"
        })

    return {
        "queries": queries,
        "candidates": candidates,
        "auto_add": auto_add,
        "message": "검색어 생성 완료. 실제 보강은 web.summarize 연동 후."
    }


if __name__ == "__main__":
    import pprint
    pprint.pprint(enrich())
