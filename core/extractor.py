"""엔티티·관계·토픽·인사이트 추출 — Ollama 우선, MCP → API 키 → 키워드 fallback"""
import re
import json
import urllib.request
from . import env

OLLAMA_URL   = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "gemma4:e2b"

EXTRACT_PROMPT = """다음 문서에서 지식 그래프 구성 요소를 추출하세요.

문서 제목: {title}
문서 내용:
{content}

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{{
  "entities": [
    {{"name": "엔티티명", "type": "concept|person|tool|paper|organization|technology", "description": "간략 설명"}}
  ],
  "relations": [
    {{"from": "엔티티A", "to": "엔티티B", "relation": "relates_to|part_of|cites|implements|contradicts|applied_to"}}
  ],
  "topics": ["주제1", "주제2"],
  "key_insights": ["핵심 인사이트1"],
  "importance": 0.7
}}"""

_TOPIC_SEEDS = [
    (r'비전|카메라|조명|이미지|영상|촬영', '컴퓨터 비전'),
    (r'STEP|CAD|도면|3D|투영|파싱', 'CAD/도면 처리'),
    (r'정렬|매칭|ICP|특징점|ORB|SIFT', '이미지 정렬'),
    (r'검증|검사|측정|치수|Pass|Fail', '품질 검증'),
    (r'AI|딥러닝|머신러닝|모델|학습|추론', 'AI/ML'),
    (r'비즈니스|수익|고객|시장|경쟁|SaaS', '비즈니스'),
    (r'LLM|GPT|Claude|Anthropic|프롬프트', 'LLM/생성 AI'),
    (r'지식 그래프|KG|노드|엣지|Neo4j', '지식 그래프'),
    (r'Flash Attention|Transformer|어텐션', 'Transformer 아키텍처'),
    (r'임베딩|벡터|Chroma|RAG|검색', '벡터 검색'),
    (r'제조|반도체|자동차|부품|라인', '제조업'),
    (r'Python|Flask|API|서버|코드', '소프트웨어 개발'),
]


def _keyword_fallback(title: str, content: str) -> dict:
    text = f"{title} {content}"
    topics = [topic for pattern, topic in _TOPIC_SEEDS if re.search(pattern, text, re.IGNORECASE)]
    return {
        "entities": [], "relations": [],
        "topics": topics[:5], "key_insights": [], "importance": 0.5,
    }


def _parse_json(text: str) -> dict:
    # ```json ... ``` 블록 제거
    if "```" in text:
        m = re.search(r"```(?:json)?\s*([\s\S]+?)```", text)
        if m:
            text = m.group(1)
    return json.loads(text.strip())


def _via_ollama(title: str, content: str) -> dict:
    """Ollama 로컬 모델로 엔티티/토픽 추출"""
    prompt = EXTRACT_PROMPT.format(title=title, content=content[:3000])
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0.1},
    }).encode()
    req = urllib.request.Request(
        OLLAMA_URL, data=payload,
        headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        body = json.loads(resp.read())
    text = body["message"]["content"].strip()
    return _parse_json(text)


def _via_mcp(title: str, content: str) -> dict:
    from . import claude_mcp
    prompt = EXTRACT_PROMPT.format(title=title, content=content[:3000])
    text = claude_mcp.chat([{"role": "user", "content": prompt}])
    return _parse_json(text)


def _via_api(title: str, content: str) -> dict:
    import anthropic
    client = anthropic.Anthropic(api_key=env.get("ANTHROPIC_API_KEY"))
    msg = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=1024,
        messages=[{"role": "user", "content": EXTRACT_PROMPT.format(
            title=title, content=content[:3000]
        )}]
    )
    return _parse_json(msg.content[0].text)


def extract(title: str, content: str) -> dict:
    """KG 구성 요소 추출.
    순서: Ollama → MCP(dashboard) → Anthropic API 키 → 키워드 fallback"""

    # 1순위: Ollama (로컬, 항상 시도)
    try:
        return _via_ollama(title, content)
    except Exception as e:
        print(f"[extractor] Ollama 실패, MCP 재시도: {e}")

    # 2순위: dashboard MCP
    try:
        from . import claude_mcp
        if claude_mcp.is_available():
            return _via_mcp(title, content)
    except Exception as e:
        print(f"[extractor] MCP 실패, API 키 재시도: {e}")

    # 3순위: ANTHROPIC_API_KEY
    if env.get("ANTHROPIC_API_KEY"):
        try:
            return _via_api(title, content)
        except Exception as e:
            print(f"[extractor] API 키 실패: {e}")

    # 4순위: 키워드 기반 fallback
    return _keyword_fallback(title, content)
