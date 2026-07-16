"""프로젝트(코드 레포) 단위 요약 — 수동 트리거.
지정 폴더의 코드+md 파일 구조를 스캔하고, Ollama로 overview/summary 생성, git 변경사항 포함."""
import json
import os
import re
import subprocess
import urllib.request
import uuid
from pathlib import Path

from db.init_db import get_conn
from . import embeddings

OLLAMA_URL   = "http://localhost:11434/api/chat"
OLLAMA_MODEL = "gemma4:e2b"

# 프로젝트 1개 = 파일 1개 (graphify-wiki/*.md 와 동일한 위치 관례)
PROJ_DIR = Path(__file__).parent.parent / "project-summaries"

CODE_EXTS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".go", ".rs", ".c", ".cpp",
    ".h", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".vue", ".svelte",
    ".sql", ".sh", ".ps1", ".bat",
}
MD_EXTS = {".md", ".mdx"}
EXCLUDE_DIRS = {
    "node_modules", ".git", "dist", "build", "__pycache__", "venv", ".venv",
    "env", "target", ".next", ".nuxt", ".cache", "coverage", ".idea",
    ".vscode", "out", "bin", "obj", ".pytest_cache", "site-packages",
    "graphify-out", "graphify-wiki",
}
# LLM 프롬프트에 전체 내용을 넣을 "주요 파일" 후보 (의존성/엔트리포인트 — 프로젝트 성격을 가장 잘 드러냄)
KEY_FILE_NAMES = {
    "package.json", "pyproject.toml", "requirements.txt", "setup.py",
    "App.tsx", "App.ts", "App.jsx", "main.py", "main.ts", "index.ts",
    "server.py", "app.py",
}

OVERVIEW_PROMPT = """다음은 한 코드 프로젝트의 파일 구조와 주요 파일 내용입니다.

프로젝트명: {name}

파일 구조 (일부):
{tree_text}

주요 파일 내용:
{sample_text}

반드시 아래 JSON 형식으로만 답해줘 (다른 텍스트 없이):
{{
  "overview": "이 프로젝트의 목적, 핵심 기능, 대상 사용자/사용 시나리오를 4~6문장으로 한국어 설명",
  "summary": "다음을 모두 포함해 한국어로 상세히 요약 (10문장 이상, 줄바꿈으로 항목 구분):\\n- 주요 디렉토리/모듈별 역할\\n- 핵심 기술스택과 선택 이유(파악 가능하면)\\n- 핵심 데이터/처리 흐름 또는 아키텍처\\n- 외부 연동(API, DB, 서비스 등)\\n- 특이사항이나 설계상 주의점",
  "diagram": "이 프로젝트의 핵심 데이터/처리 흐름 또는 모듈 구조를 나타내는 Mermaid flowchart 코드 (예: flowchart TD\\n  A[클라이언트] --> B[API 서버]\\n  B --> C[(DB)]). 'flowchart TD'로 시작하고 노드/엣지만 포함, 설명문은 넣지 말 것. 줄바꿈은 \\n 으로."
}}"""


def _should_skip_dir(name: str) -> bool:
    return name in EXCLUDE_DIRS or name.startswith(".")


def scan_folder(folder_path: str, max_files: int = 500) -> dict:
    """폴더를 재귀 스캔해 코드/md 파일 트리 + 통계를 만든다."""
    root = Path(folder_path)
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"폴더를 찾을 수 없습니다: {folder_path}")

    files: list[dict] = []
    tree: dict = {}

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not _should_skip_dir(d)]
        for fname in filenames:
            ext = Path(fname).suffix.lower()
            if ext not in CODE_EXTS and ext not in MD_EXTS:
                continue
            fpath = Path(dirpath) / fname
            try:
                size = fpath.stat().st_size
            except OSError:
                continue
            rel = fpath.relative_to(root).as_posix()
            kind = "md" if ext in MD_EXTS else "code"
            files.append({"rel_path": rel, "ext": ext, "size": size, "kind": kind})

            # 트리에 경로 삽입
            parts = rel.split("/")
            node = tree
            for part in parts[:-1]:
                node = node.setdefault(part, {})
            node[parts[-1]] = size

            if len(files) >= max_files:
                break
        if len(files) >= max_files:
            break

    stats = {
        "total_files": len(files),
        "code_files": sum(1 for f in files if f["kind"] == "code"),
        "md_files": sum(1 for f in files if f["kind"] == "md"),
        "total_size": sum(f["size"] for f in files),
    }
    return {"tree": tree, "files": files, "stats": stats}


def _tree_text(tree: dict, prefix: str = "", depth: int = 0, max_depth: int = 4) -> str:
    """트리 dict를 들여쓰기 텍스트로 변환 (LLM 프롬프트용, 너무 깊으면 절단)."""
    if depth > max_depth:
        return ""
    lines = []
    for name, val in sorted(tree.items()):
        if isinstance(val, dict):
            lines.append(f"{prefix}{name}/")
            lines.append(_tree_text(val, prefix + "  ", depth + 1, max_depth))
        else:
            lines.append(f"{prefix}{name}")
    return "\n".join(l for l in lines if l)


def _sample_content(root: Path, files: list[dict], char_budget: int = 16000) -> str:
    """README 등 md 파일 + 주요 엔트리 파일 내용을 예산 내에서 모아 LLM 프롬프트용 텍스트로."""
    # md 파일(README 우선) → 주요 코드 파일 순으로 우선순위
    md_files = sorted(
        [f for f in files if f["kind"] == "md"],
        key=lambda f: (0 if "readme" in f["rel_path"].lower() else 1, f["rel_path"])
    )
    key_code_files = [f for f in files if Path(f["rel_path"]).name in KEY_FILE_NAMES]

    parts: list[str] = []
    used = 0
    for f in md_files + key_code_files:
        if used >= char_budget:
            break
        fpath = root / f["rel_path"]
        try:
            text = fpath.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        chunk = text[:3500]
        block = f"\n--- {f['rel_path']} ---\n{chunk}\n"
        parts.append(block)
        used += len(block)
    return "".join(parts) or "(읽을 수 있는 README/주요 파일이 없습니다)"


def _ollama_call(prompt: str) -> str:
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        # Ollama가 문법상 유효한 JSON만 뱉도록 강제 — 프롬프트로 "JSON만 답해줘"라고 부탁만
        # 하는 것보다 확실하다(작은 모델일수록 형식을 흘린다).
        "format": "json",
        "options": {"temperature": 0.1},
    }).encode()
    req = urllib.request.Request(
        OLLAMA_URL, data=payload,
        headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=240) as resp:
        body = json.loads(resp.read())
    return body["message"]["content"].strip()


def _parse_overview_json(text: str) -> dict | None:
    try:
        if "```" in text:
            m = re.search(r"```(?:json)?\s*([\s\S]+?)```", text)
            if m:
                text = m.group(1)
        data = json.loads(text)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _ollama_overview(name: str, tree_text: str, sample_text: str) -> dict:
    """프로젝트 요약을 뽑는다. 파싱 실패 시 1회 재시도하고, 그래도 실패하면 원문을 넣되 로그를 남긴다.

    이전에는 파싱 실패를 조용히 삼키고 overview에 원문 300자를 넣어버려서, 요약이 통째로
    쓰레기가 돼도 아무 신호가 없었다. 최소한 왜 나빠졌는지는 보이게 한다.
    """
    prompt = OVERVIEW_PROMPT.format(name=name, tree_text=tree_text[:6000], sample_text=sample_text)
    text = ""
    for attempt in (1, 2):
        text = _ollama_call(prompt)
        data = _parse_overview_json(text)
        if data is not None:
            return data
        print(f"[project_scan] 요약 JSON 파싱 실패 (시도 {attempt}/2): {text[:120]!r}", flush=True)
    print(f"[project_scan] '{name}' 요약을 JSON으로 못 받아 원문으로 폴백합니다 — 요약 품질이 낮을 수 있습니다.", flush=True)
    return {"overview": text[:300], "summary": text[:1000], "diagram": ""}


def git_changes(folder_path: str) -> str:
    """git 레포면 최신 커밋 한 줄. 레포 아니면 안내 문구."""
    root = Path(folder_path)
    if not (root / ".git").exists():
        return "(git 레포가 아닙니다)"

    try:
        r = subprocess.run(
            ["git", "-C", str(root), "log", "-1", "--pretty=format:%h %ad %s", "--date=short"],
            capture_output=True, text=True, timeout=15, encoding="utf-8", errors="ignore"
        )
        return r.stdout.strip() or "(커밋 없음)"
    except Exception as e:
        return f"(git 실행 실패: {e})"


def _sync_kg_node(pid: str, name: str, folder_path: str, overview: str, summary: str):
    """프로젝트 요약을 KG 노드 + 임베딩에 반영 — 재스캔해도 같은 node_id로 갱신되어
    지식 그래프 검색(/search)에서 graphify 실행 없이도 바로 검색 가능하게 한다."""
    node_id = f"project_{pid}"
    content = f"{overview}\n\n{summary}"
    conn = get_conn()
    existing = conn.execute("SELECT id FROM nodes WHERE id=?", (node_id,)).fetchone()
    if existing:
        conn.execute(
            "UPDATE nodes SET title=?, content=?, file_path=?, updated_at=datetime('now','localtime') WHERE id=?",
            (name, content, folder_path, node_id)
        )
    else:
        conn.execute(
            "INSERT INTO nodes (id,type,title,content,source_type,file_path,importance) VALUES (?,?,?,?,?,?,?)",
            (node_id, "project", name, content, "project", folder_path, 0.6)
        )
    conn.commit()
    conn.close()
    embeddings.add_document(node_id, name, content, {"source_type": "project", "file_path": folder_path})


def _safe_filename(name: str, pid: str) -> str:
    safe = re.sub(r"[^\w가-힣.-]+", "_", name).strip("_") or "project"
    return f"{safe}__{pid[:8]}.md"


def _write_project_file(pid: str, name: str, folder_path: str,
                         overview: str, summary: str, changes: str, diagram: str, stats: dict,
                         old_export_path: str | None) -> str:
    """프로젝트 1개 = 파일 1개. project-summaries/ 에 overview+summary+변경사항(+다이어그램)을 한 md로."""
    PROJ_DIR.mkdir(parents=True, exist_ok=True)
    if old_export_path and Path(old_export_path).exists() and Path(old_export_path).name != _safe_filename(name, pid):
        Path(old_export_path).unlink(missing_ok=True)  # 이름 변경 시 옛 파일 정리

    out_path = PROJ_DIR / _safe_filename(name, pid)
    diagram_block = f"\n## 플로우 다이어그램\n```mermaid\n{diagram}\n```\n" if diagram else ""
    content = f"""# {name}

경로: `{folder_path}`
파일 {stats.get('total_files', 0)}개 (코드 {stats.get('code_files', 0)} / md {stats.get('md_files', 0)})

## 개요
{overview}

## 요약
{summary}
{diagram_block}
## 변경사항
{changes}
"""
    out_path.write_text(content, encoding="utf-8")
    return str(out_path)


def generate_project_summary(folder_path: str, name: str = "") -> dict:
    """폴더를 스캔 + Ollama 요약 + git 변경사항 → DB 저장 + project-summaries/*.md 파일 1개로 내보내기."""
    root = Path(folder_path).resolve()
    folder_path = str(root)
    name = name or root.name

    conn = get_conn()
    existing = conn.execute(
        "SELECT id, export_path FROM project_summaries WHERE folder_path=?", (folder_path,)
    ).fetchone()
    pid = existing["id"] if existing else str(uuid.uuid4())

    try:
        scan = scan_folder(folder_path)
        tree_text = _tree_text(scan["tree"])
        sample_text = _sample_content(root, scan["files"])
        ollama_data = _ollama_overview(name, tree_text, sample_text)
        changes = git_changes(folder_path)

        overview = ollama_data.get("overview", "")
        summary = ollama_data.get("summary", "")
        diagram = ollama_data.get("diagram", "")
        file_tree_json = json.dumps(scan["tree"], ensure_ascii=False)
        stats_json = json.dumps(scan["stats"], ensure_ascii=False)

        export_path = _write_project_file(
            pid, name, folder_path, overview, summary, changes, diagram, scan["stats"],
            old_export_path=existing["export_path"] if existing else None
        )

        if existing:
            conn.execute(
                """UPDATE project_summaries SET name=?, file_tree_json=?, stats_json=?,
                   overview=?, summary=?, changes=?, diagram=?, export_path=?, status='done', error=NULL,
                   updated_at=datetime('now','localtime') WHERE id=?""",
                (name, file_tree_json, stats_json, overview, summary, changes, diagram, export_path, pid)
            )
        else:
            conn.execute(
                """INSERT INTO project_summaries
                   (id, name, folder_path, file_tree_json, stats_json, overview, summary, changes, diagram, export_path, status)
                   VALUES (?,?,?,?,?,?,?,?,?,?,'done')""",
                (pid, name, folder_path, file_tree_json, stats_json, overview, summary, changes, diagram, export_path)
            )
        conn.commit()
        _sync_kg_node(pid, name, folder_path, overview, summary)
        return {
            "id": pid, "name": name, "folder_path": folder_path, "status": "done",
            "tree": scan["tree"], "stats": scan["stats"],
            "overview": overview, "summary": summary, "changes": changes, "diagram": diagram,
            "export_path": export_path,
        }
    except Exception as e:
        if existing:
            conn.execute(
                "UPDATE project_summaries SET status='error', error=? WHERE id=?", (str(e), pid)
            )
        else:
            conn.execute(
                """INSERT INTO project_summaries (id, name, folder_path, status, error)
                   VALUES (?,?,?,'error',?)""",
                (pid, name, folder_path, str(e))
            )
        conn.commit()
        raise
    finally:
        conn.close()


def list_projects() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        """SELECT id, name, folder_path, status, error, updated_at, graphified_at,
                  stats_json, overview FROM project_summaries
           ORDER BY updated_at DESC"""
    ).fetchall()
    conn.close()
    result = []
    for r in rows:
        d = dict(r)
        try:
            d["stats"] = json.loads(d.pop("stats_json") or "{}")
        except Exception:
            d["stats"] = {}
        result.append(d)
    return result


def get_project(pid: str) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM project_summaries WHERE id=?", (pid,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    try:
        d["tree"] = json.loads(d.pop("file_tree_json") or "{}")
    except Exception:
        d["tree"] = {}
    try:
        d["stats"] = json.loads(d.pop("stats_json") or "{}")
    except Exception:
        d["stats"] = {}
    return d


def mark_graphified(pid: str | None = None):
    """Graphify 처리 완료 표시. pid가 없으면 전체 프로젝트에 표시(일괄 처리용).

    Graphify는 graphify-wiki 전체를 하나의 그래프로 묶어 처리하는 전역 작업이라
    프로젝트별로 별도 실행되지 않음 — 전역 실행이 끝난 뒤 "이 프로젝트의 md도
    이번 처리에 포함됐다"는 의미로 타임스탬프만 남긴다."""
    conn = get_conn()
    if pid:
        conn.execute(
            "UPDATE project_summaries SET graphified_at=datetime('now','localtime') WHERE id=?", (pid,)
        )
    else:
        conn.execute("UPDATE project_summaries SET graphified_at=datetime('now','localtime')")
    conn.commit()
    conn.close()


def delete_project(pid: str):
    conn = get_conn()
    row = conn.execute("SELECT export_path FROM project_summaries WHERE id=?", (pid,)).fetchone()
    if row and row["export_path"]:
        Path(row["export_path"]).unlink(missing_ok=True)
    conn.execute("DELETE FROM project_summaries WHERE id=?", (pid,))
    conn.execute("DELETE FROM nodes WHERE id=?", (f"project_{pid}",))
    conn.commit()
    conn.close()
    embeddings.delete_document(f"project_{pid}")
