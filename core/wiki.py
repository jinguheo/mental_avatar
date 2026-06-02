"""Wiki 생성 파이프라인 — Ollama 1차 요약 → Claude.ai 2차 재구성 → KG 개념 연결"""
import uuid
import re
import os
import json
import urllib.request
from db.init_db import get_conn
from . import graph as kg

OLLAMA_URL = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "gemma4:e2b"

OLLAMA_PROMPT = """다음 문서를 읽고 핵심 내용을 JSON으로 정리해줘.

문서 제목: {title}
문서 내용:
{content}

반드시 아래 JSON 형식으로만 답해줘 (다른 텍스트 없이):
{{
  "subject": "주제 한 줄",
  "concepts": ["핵심개념1", "핵심개념2", "핵심개념3"],
  "key_points": ["주요내용1", "주요내용2", "주요내용3"],
  "related_fields": ["연관분야1", "연관분야2"],
  "summary": "3~4문장 요약"
}}"""

CLAUDE_PROMPT = """아래는 문서를 분석한 내용입니다.

원본 제목: {title}
1차 분석:
{ollama_summary}

이 내용을 바탕으로 위키 페이지 형식으로 재구성해줘.
마크다운 형식으로, 다음 구조를 따라줘:

# {title}

## 개요
(2~3문장으로 이 문서가 다루는 핵심을 설명)

## 핵심 개념
(각 개념을 **굵게** 표시하고 한 줄 설명)

## 주요 내용
(구조화된 bullet 포인트)

## 인사이트
(이 문서에서 얻을 수 있는 핵심 통찰 1~3개)

## 연관 주제
(관련 키워드를 `태그` 형식으로)

한국어로 작성. 간결하고 명확하게."""


def _ollama_extract(title: str, content: str) -> dict:
    """Ollama로 문서 분석 → 구조화된 dict 반환"""
    prompt = OLLAMA_PROMPT.format(title=title, content=content[:4000])
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False
    }).encode()
    req = urllib.request.Request(
        OLLAMA_URL, data=payload,
        headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        body = json.loads(resp.read())
    text = body["message"]["content"].strip()

    # JSON 파싱 시도
    try:
        if "```" in text:
            text = re.search(r"```(?:json)?\s*([\s\S]+?)```", text).group(1)
        return json.loads(text)
    except Exception:
        # 파싱 실패 시 텍스트에서 개념 추출
        return {
            "subject": title,
            "concepts": [],
            "key_points": [text[:500]],
            "related_fields": [],
            "summary": text[:300]
        }


def _claude_wikify(title: str, ollama_data: dict) -> str:
    from . import claude_mcp
    summary_text = json.dumps(ollama_data, ensure_ascii=False, indent=2)
    prompt = CLAUDE_PROMPT.format(title=title, ollama_summary=summary_text)
    return claude_mcp.chat([{"role": "user", "content": prompt}])


def _link_concepts_to_node(node_id: str, ollama_data: dict):
    """Ollama 추출 개념을 entity 노드로 KG에 추가하고 문서와 연결"""
    concepts = ollama_data.get("concepts", []) + ollama_data.get("related_fields", [])
    for concept in concepts:
        concept = concept.strip()
        if not concept or len(concept) < 2:
            continue
        eid = kg.upsert_entity(concept, "concept", ollama_data.get("subject", ""))
        kg.add_edge(node_id, eid, "mentions", 1.0)

    # 같은 개념을 공유하는 다른 문서와도 연결
    # (upsert_entity가 중복 방지하므로 자동으로 공유 entity 통해 연결됨)


def generate_wiki(node_id: str, title: str, content: str, file_path: str) -> dict:
    """Ollama → Claude 파이프라인으로 wiki 페이지 생성 + KG 개념 연결"""
    conn = get_conn()
    existing = conn.execute(
        "SELECT id FROM wiki_pages WHERE file_path=?", (file_path,)
    ).fetchone()
    page_id = existing["id"] if existing else str(uuid.uuid4())

    try:
        # 0단계: 텍스트가 빈약하면 시각 모델(gemma)로 이미지/슬라이드 직접 이해
        vision_note = ""
        from . import vision
        if vision.is_sparse(content) and os.path.exists(file_path):
            src_ext = os.path.splitext(file_path)[1].lower()
            if src_ext in (".pdf", ".pptx", ".ppt", ".png", ".jpg", ".jpeg", ".webp", ".bmp"):
                vision_note = vision.describe_document(file_path, title=title)
                if vision_note:
                    # 시각 이해 결과를 본문 콘텐츠로 사용 (이후 단계가 이를 구조화)
                    content = vision_note

        # 1단계: Ollama 구조화 추출
        ollama_data = _ollama_extract(title, content)
        if vision_note:
            ollama_data["_vision"] = True
        ollama_summary = json.dumps(ollama_data, ensure_ascii=False, indent=2)

        # 2단계: KG에 개념 노드 연결 (항상 실행)
        _link_concepts_to_node(node_id, ollama_data)

        # 3단계: Claude wiki 재구성 (MCP 있을 때만)
        try:
            wiki_content = _claude_wikify(title, ollama_data)
            status = "done"
        except Exception:
            wiki_content = _build_fallback_wiki(title, ollama_data)
            status = "ollama_only"

        # DB 저장
        if existing:
            conn.execute(
                """UPDATE wiki_pages SET ollama_summary=?, wiki_content=?, status=?,
                   updated_at=datetime('now','localtime') WHERE id=?""",
                (ollama_summary, wiki_content, status, page_id)
            )
        else:
            conn.execute(
                """INSERT INTO wiki_pages (id, node_id, file_path, title, ollama_summary, wiki_content, status)
                   VALUES (?,?,?,?,?,?,?)""",
                (page_id, node_id, file_path, title, ollama_summary, wiki_content, status)
            )
        conn.commit()
        return {"id": page_id, "status": status, "wiki_content": wiki_content,
                "concepts": ollama_data.get("concepts", [])}

    except Exception as e:
        if existing:
            conn.execute("UPDATE wiki_pages SET status='error' WHERE id=?", (page_id,))
        else:
            conn.execute(
                "INSERT OR REPLACE INTO wiki_pages (id, node_id, file_path, title, status) VALUES (?,?,?,?,'error')",
                (page_id, node_id, file_path, title)
            )
        conn.commit()
        raise RuntimeError(f"wiki 생성 실패: {e}")
    finally:
        conn.close()


def _build_fallback_wiki(title: str, data: dict) -> str:
    concepts = "\n".join(f"- **{c}**" for c in data.get("concepts", []))
    points = "\n".join(f"- {p}" for p in data.get("key_points", []))
    fields = ", ".join(f"`{f}`" for f in data.get("related_fields", []))
    return f"""# {title}

## 개요
{data.get('summary', '')}

## 핵심 개념
{concepts or '(없음)'}

## 주요 내용
{points or '(없음)'}

## 연관 주제
{fields or '(없음)'}"""


def list_wiki_pages() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT w.id, w.title, w.file_path, w.status, w.updated_at, w.wiki_content
           FROM wiki_pages w ORDER BY w.updated_at DESC"""
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_wiki_page(page_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM wiki_pages WHERE id=?", (page_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


# 요약 대상 조건: 텍스트가 충분하거나(>50자), 시각 모델로 읽을 수 있는 파일(pdf/pptx/이미지)
_SUMMARIZABLE = """(
    length(content) > 50
    OR lower(file_path) LIKE '%.pdf'
    OR lower(file_path) LIKE '%.pptx'
    OR lower(file_path) LIKE '%.ppt'
    OR lower(file_path) LIKE '%.png'
    OR lower(file_path) LIKE '%.jpg'
    OR lower(file_path) LIKE '%.jpeg'
)"""


def count_missing() -> dict:
    """요약이 필요한 파일(file_path) 수 반환.
    wiki는 file_path 단위로 저장되므로 노드(청크)가 아닌 파일 기준으로 집계.
    텍스트가 없어도 시각 모델로 읽을 수 있는 파일(pdf/pptx/이미지)은 포함한다."""
    conn = get_conn()
    file_total = conn.execute(
        f"SELECT COUNT(DISTINCT COALESCE(file_path, id)) FROM nodes "
        f"WHERE type='chunk' AND {_SUMMARIZABLE}"
    ).fetchone()[0]
    summarized = conn.execute(
        "SELECT COUNT(DISTINCT file_path) FROM wiki_pages "
        "WHERE status IN ('done','ollama_only')"
    ).fetchone()[0]
    return_val = {
        "node_total": file_total,
        "summarized": summarized,
        "missing": max(0, file_total - summarized),
    }
    conn.close()
    return return_val


def auto_summarize_missing(job: dict, limit: int = 200) -> None:
    """wiki 없는 파일을 찾아 순서대로 요약. job dict에 진행 상태를 업데이트 (백그라운드 스레드용).
    wiki는 file_path 단위이므로 파일별 대표 노드(첫 청크) 하나만 요약한다.
    텍스트가 빈약한 pdf/pptx/이미지는 generate_wiki 내부에서 시각 모델로 처리된다."""
    conn = get_conn()
    rows = conn.execute(f"""
        SELECT n.id, n.title, n.content, n.file_path
        FROM nodes n
        WHERE n.type = 'chunk'
          AND {_SUMMARIZABLE}
          AND COALESCE(n.file_path, n.id) NOT IN (
              SELECT file_path FROM wiki_pages
              WHERE status IN ('done', 'ollama_only')
          )
        GROUP BY COALESCE(n.file_path, n.id)
        ORDER BY MIN(n.created_at) ASC
        LIMIT ?
    """, (limit,)).fetchall()
    items = [dict(r) for r in rows]
    conn.close()

    job["total"]  = len(items)
    job["done"]   = 0
    job["failed"] = 0
    job["running"] = True

    for item in items:
        if job.get("cancel"):
            break
        try:
            generate_wiki(
                node_id=item["id"],
                title=item["title"] or "(제목 없음)",
                content=item["content"],
                file_path=item["file_path"] or item["id"],
            )
            job["done"] += 1
        except Exception as e:
            job["failed"] += 1
            print(f"[auto_summarize] 실패 {item['title']}: {e}")
        job["current"] = item["title"] or item["id"]

    job["running"] = False
    job["current"] = ""
