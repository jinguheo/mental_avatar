"""공개 인물 질문은행 파일에서 knowledge.db의 persona_knowledge 읽기 모델을 다시 만든다.

원격 저장소에 있는 manifest.jsonl, answers.jsonl, supplement.jsonl, profile.json만 사용한다.
원문 재수집이나 Ollama 호출은 하지 않는다. 개인 대화·개인 KG·벡터 인덱스는 이 명령의 대상이 아니다.

사용:
    python scripts/rebuild_persona_knowledge.py
    python scripts/rebuild_persona_knowledge.py buffett einstein
    python scripts/rebuild_persona_knowledge.py --dry-run
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import persona_knowledge, persona_qbank  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="공개 인물 질문은행 파일을 knowledge.db의 persona_knowledge 테이블에 동기화합니다."
    )
    parser.add_argument(
        "people",
        nargs="*",
        metavar="PERSON",
        help="동기화할 인물 ID. 생략하면 전체 인물입니다.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="DB를 변경하지 않고, 현재 파일에서 읽을 수 있는 항목 수만 출력합니다.",
    )
    return parser.parse_args()


def selected_people(requested: list[str]) -> list[str]:
    people = requested or list(persona_qbank.NAMES)
    unknown = sorted(set(people) - set(persona_qbank.NAMES))
    if unknown:
        raise ValueError("알 수 없는 인물 ID: " + ", ".join(unknown))
    return people


def main() -> int:
    args = parse_args()
    try:
        people = selected_people(args.people)
    except ValueError as exc:
        print(f"오류: {exc}", file=sys.stderr)
        print("가능한 인물: " + ", ".join(persona_qbank.NAMES), file=sys.stderr)
        return 2

    verb = "점검" if args.dry_run else "동기화"
    print(f"공개 인물 지식 {verb}: {len(people)}명")
    failed = []
    for person in people:
        try:
            if args.dry_run:
                summary = persona_qbank.summary(person)
                result = {
                    "person": person,
                    "materials": len(persona_qbank.materials(person)),
                    "verified": summary["real_answered"],
                    "estimated": summary["answered"] - summary["real_answered"],
                }
            else:
                result = persona_knowledge.sync(person)
            print(
                f"- {result['person']}: 자료 {result['materials']}개, "
                f"근거 답변 {result['verified']}개, 추정 답변 {result['estimated']}개"
            )
        except Exception as exc:  # 다른 인물은 계속 처리하고 실패를 마지막에 알린다.
            failed.append(person)
            print(f"- {person}: 실패 - {exc}", file=sys.stderr)

    if failed:
        print("실패한 인물: " + ", ".join(failed), file=sys.stderr)
        return 1
    if not args.dry_run:
        print("완료: knowledge.db의 persona_knowledge 테이블을 현재 질문은행 파일로 갱신했습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
