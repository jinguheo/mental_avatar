"""대화 기록(decision_pairs)에서 뽑은 판단 사례 후보를 승인 대기(decision_case_candidates)로 넣는다.

후보 파일(JSONL)의 각 줄은 {"pair_key", "decision_type", "situation", "choice", "rationale", ...} 이고
원문(직전 AI 발화·내 답)은 decision_pairs에서 읽어 함께 보관한다. 시험(test) 분할에 속한 짝은 일치 측정용이라
후보로 넣지 않는다. 같은 (pair_key, choice)는 한 번만 들어간다.

사용: python scripts/import_decision_candidates.py candidates.jsonl [--extracted-by "Claude Opus 5.5 (대화 직접 추출)"]
"""
import argparse
import json
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from db.init_db import get_conn, init  # noqa: E402

DECISION_TYPES = {"업무·품질", "일정·우선순위", "비용·위험", "관계·협업", "윤리·안전", "새로운 상황"}


def clip(text: str, limit: int) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= limit else "…" + text[-limit:]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--extracted-by", default="Claude (대화 직접 추출)")
    args = parser.parse_args()

    init()
    conn = get_conn()
    added = skipped_test = skipped_dup = invalid = 0
    for line in Path(args.path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        pair = conn.execute("SELECT * FROM decision_pairs WHERE key=?", (item["pair_key"],)).fetchone()
        split = conn.execute("SELECT split FROM decision_split WHERE key=?", (item["pair_key"],)).fetchone()
        if not pair or item.get("decision_type") not in DECISION_TYPES or not all(item.get(k) for k in ("situation", "choice", "rationale")):
            invalid += 1
            continue
        if split and split["split"] == "test":
            skipped_test += 1
            continue
        cursor = conn.execute(
            """INSERT OR IGNORE INTO decision_case_candidates
               (id, pair_key, decision_type, topic, situation, options_text, choice, rationale, rejected_options,
                exception_rule, evidence_state, extractor_conf, source_context, source_reply, source_project,
                observed_at, extracted_by)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (uuid.uuid4().hex, item["pair_key"], item["decision_type"], item.get("topic", ""), item["situation"],
             item.get("options_text", ""), item["choice"], item["rationale"], item.get("rejected_options", ""),
             item.get("exception_rule", ""), item.get("evidence_state", "direct"), item.get("ext_conf"),
             clip(pair["context"], 600), (pair["reply"] or "").strip(), pair["project"], pair["created_at"],
             args.extracted_by),
        )
        if cursor.rowcount:
            added += 1
        else:
            skipped_dup += 1
    conn.commit()
    conn.close()
    print(f"추가 {added} · 중복 {skipped_dup} · 시험 분할 제외 {skipped_test} · 형식 오류 {invalid}")


if __name__ == "__main__":
    main()
