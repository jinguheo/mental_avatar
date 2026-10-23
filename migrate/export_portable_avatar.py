"""모델 독립적인 Mental Avatar 이식 패키지를 만든다.

이 패키지는 특정 LLM의 파인튜닝 산출물이 아니라, 프로필·기억·승인 요약·판단 사례·KG를
JSON/JSONL로 보존한다. 다른 LLM에서는 이 파일들을 같은 우선순위(고정 기억 → 승인 요약
→ 관련 사례/원문)로 프롬프트에 넣어 사용할 수 있다.

사용:
    python migrate/export_portable_avatar.py
    python migrate/export_portable_avatar.py --include-data

--include-data는 프로젝트 data/의 원문·페르소나 코퍼스를 패키지에 함께 넣는다. 외부 경로의
원본 파일은 무단으로 복사하지 않고 source_inventory.jsonl에 경로·해시만 남긴다.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "db" / "knowledge.db"
OUT_DIR = ROOT / "migrate"
TABLES = (
    "user_profile", "core_memory", "avatar_self_summary", "avatar_governance",
    "self_interview", "decision_cases", "conversations", "daily_sync", "avatar_notes",
    "avatar_profile_auto", "avatar_profile_candidates", "avatar_conversation_corrections",
    "avatar_evaluations", "nodes", "edges", "topics", "node_topics",
)


def rows(conn: sqlite3.Connection, table: str) -> list[dict]:
    exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
    if not exists:
        return []
    return [dict(row) for row in conn.execute(f"SELECT * FROM {table}")]


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def write_jsonl(path: Path, values: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for value in values:
            handle.write(json.dumps(value, ensure_ascii=False) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Mental Avatar 모델 독립 이식 패키지 생성")
    parser.add_argument("--include-data", action="store_true", help="프로젝트 data/ 원문도 복사")
    args = parser.parse_args()
    if not DB_PATH.exists():
        raise SystemExit(f"knowledge.db를 찾지 못했습니다: {DB_PATH}")

    stamp = time.strftime("%Y%m%d_%H%M%S")
    destination = OUT_DIR / f"portable_avatar_{stamp}"
    zip_base = OUT_DIR / f"portable_avatar_{stamp}"
    with tempfile.TemporaryDirectory(prefix="portable_avatar_") as temp:
        build = Path(temp) / "mental-avatar-portable"
        build.mkdir(parents=True)
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        exports = {table: rows(conn, table) for table in TABLES}
        conn.close()
        nodes_for_inventory = exports["nodes"]

        # LLM 이식 때 우선순위를 잃지 않도록 기억은 별도 파일과 상태 메타데이터로 분리한다.
        write_jsonl(build / "memory" / "core_memory.jsonl", exports.pop("core_memory"))
        write_jsonl(build / "profile" / "user_profile.jsonl", exports.pop("user_profile"))
        for table in ("avatar_self_summary", "avatar_governance", "avatar_profile_auto", "avatar_profile_candidates"):
            write_jsonl(build / "profile" / f"{table}.jsonl", exports.pop(table))
        for table in ("self_interview", "decision_cases", "conversations", "daily_sync", "avatar_notes", "avatar_conversation_corrections", "avatar_evaluations"):
            write_jsonl(build / "records" / f"{table}.jsonl", exports.pop(table))
        for table in ("nodes", "edges", "topics", "node_topics"):
            write_jsonl(build / "kg" / f"{table}.jsonl", exports.pop(table))

        inventory = []
        for node in nodes_for_inventory:
            source = (node.get("file_path") or "").strip()
            if source:
                inventory.append({"node_id": node["id"], "source_path": source,
                                  "file_hash": node.get("file_hash"), "source_type": node.get("source_type")})
        write_jsonl(build / "sources" / "source_inventory.jsonl", inventory)
        if args.include_data and (ROOT / "data").is_dir():
            shutil.copytree(ROOT / "data", build / "sources" / "data", dirs_exist_ok=True)

        manifest = {
            "format": "mental-avatar-portable",
            "version": 1,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "model_independent": True,
            "include_data": args.include_data,
            "priority": [
                "memory/core_memory.jsonl where is_pinned=true",
                "profile/avatar_self_summary.jsonl where approved is non-empty",
                "profile/avatar_governance.jsonl where approved is non-empty",
                "records/self_interview.jsonl and records/decision_cases.jsonl relevant to the request",
                "kg/*.jsonl and records/conversations.jsonl retrieved by relevance",
            ],
            "tables": {path: sum(1 for _ in file.open(encoding="utf-8")) for path, file in {
                "memory/core_memory.jsonl": build / "memory" / "core_memory.jsonl",
                "profile/user_profile.jsonl": build / "profile" / "user_profile.jsonl",
                "records/self_interview.jsonl": build / "records" / "self_interview.jsonl",
                "records/decision_cases.jsonl": build / "records" / "decision_cases.jsonl",
                "kg/nodes.jsonl": build / "kg" / "nodes.jsonl",
                "kg/edges.jsonl": build / "kg" / "edges.jsonl",
            }.items()},
        }
        write_json(build / "manifest.json", manifest)
        (build / "README.md").write_text(
            "# Mental Avatar portable package\n\n"
            "이 패키지는 특정 LLM에 학습시킨 모델 파일이 아니라, LLM에 독립적인 기억·근거·지식그래프 데이터입니다.\n\n"
            "## 다른 LLM에 이식할 때\n\n"
            "1. `memory/core_memory.jsonl`의 `is_pinned=true` 기억을 항상 컨텍스트에 넣습니다.\n"
            "2. 승인된 프로필·거버넌스 요약을 그 다음 우선순위로 넣습니다.\n"
            "3. 질문과 관련된 인터뷰·판단 사례·KG 노드·원문을 검색해 제한된 수만 추가합니다.\n"
            "4. `archive` 상태 기억은 자동 입력하지 않고, 필요하면 사람이 복원합니다. 원문은 삭제하지 않습니다.\n"
            "5. 모든 답변에서 source_kind, approval_status, confidence, observed_at을 보존합니다.\n",
            encoding="utf-8",
        )
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(build, destination)
        archive = shutil.make_archive(str(zip_base), "zip", root_dir=build.parent, base_dir=build.name)
    print(archive)


if __name__ == "__main__":
    main()
