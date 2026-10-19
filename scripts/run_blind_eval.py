"""이름을 가린 인물 식별 평가 세트를 만들고 로컬 모델로 사전 점검한다(논문 12절 E1).
서버 안에서 돌리면 응답이 늦어져 감시 프로그램이 서버를 재시작하므로 별도 프로세스로 실행한다.
사용: python scripts/run_blind_eval.py [covered | set_id]
  covered: 질문은행에서 여러 인물이 자료로 답할 수 있는 질문으로 새 세트를 만든다 / set_id: 그 세트의 모델 평가만 이어서 한다"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from core import persona_blind  # noqa: E402

LOG = Path(__file__).resolve().parent.parent / "tmp" / "blind_eval.log"
LOG.parent.mkdir(exist_ok=True)


def log(msg: str) -> None:
    with open(LOG, "a", encoding="utf-8") as fh:
        fh.write(time.strftime("%H:%M:%S ") + msg + "\n")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    set_id = None if arg in (None, "covered") else arg
    if not set_id:
        questions = persona_blind.covered_questions() if arg == "covered" else None   # covered: 자료로 답할 수 있는 질문만
        log("세트 생성 시작: " + ", ".join(persona_blind.eligible_people()) + (" / 질문 %d개(질문은행 기준)" % len(questions) if questions else ""))
        set_id = persona_blind.create_set(questions=questions, progress=lambda d, t: log("  생성 %d/%d" % (d, t)) if d % 5 == 0 else None)
        log("세트 생성 완료 " + set_id)
    persona_blind.auto_rate(set_id, progress=lambda d, t: log("  모델 평가 %d/%d" % (d, t)) if d % 10 == 0 else None)
    log("모델 평가 완료 " + set_id)
