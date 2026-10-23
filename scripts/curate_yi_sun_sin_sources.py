"""이순신 질문은행에 난중일기·이충무공전서의 직접 진술을 보수적으로 연결한다.

이 스크립트는 출처 문서 안에서 실제 앵커를 찾을 수 있는 경우만 own 근거로 쓴다.
전투 기록이 곧바로 성격·MBTI를 입증한다는 식의 연결은 하지 않는다.
"""
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent / "data" / "persona_corpus" / "yi_sun_sin"
TEXT = ROOT / "texts" / "quotes_위키인용_한국어_이순신.txt"
ANSWERS = ROOT / "answers.jsonl"
DOC = "quotes_위키인용_한국어_이순신"
TITLE = "위키인용: 이순신 — 난중일기·이충무공전서 인용(각 인용의 원전 표기 포함)"


CURATIONS = {
    "v08": ("신에게는 아직도 열두 척의 전선이 있사오니", "열두 척의 전선이 남았을 때 수군을 폐하지 말아야 한다고 상신한 진술이다. 책임관·전략가로서의 판단 사례이며, 자유·책임 일반론으로 확대하지 않는다."),
    "v09": ("지금 만약 수군을 모두 폐한다면", "수군을 폐하면 적이 호서를 거쳐 한강에 이를 수 있다고 우려한 상신이다. 전쟁 상황에서의 방어 판단이지 평화 일반에 대한 철학적 입장으로 단정하지 않는다."),
    "w01": ("그래서 즉각 장계를 보내고", "왜선 출현 보고를 받은 뒤 즉각 장계를 올리고 관련 지휘관들에게 공문을 보냈다는 난중일기 기록이다. 긴급 상황에서의 보고·연락 행동 사례다."),
    "w05": ("군관 나대용을 이 날로 바로 정하여 보냈다", "공석이 된 발포 권관 자리에 군관 나대용을 즉시 정해 보냈다는 난중일기 기록이다. 인재를 어떻게 일반적으로 평가했는지는 이 사례만으로 확정하지 않는다."),
    "w10": ("원래 군법이 있으니", "전투를 피하려는 기색에 대해 군법을 언급한 난중일기 기록이다. 전시 지휘에서 규율을 적용한 사례로 제한한다."),
    "e01": ("분하고 원통함을 참을 수가 없다", "부산 지휘 군영 함락 소식을 받고 기록한 감정 표현이다. 특정 위기에서의 반응이며, 일상 정서 전체를 대표하지 않는다."),
    "r01": ("내가 죽고 네가 사는 것이 당연한 이치이거늘", "아들의 전사 소식을 듣고 남긴 난중일기 기록이다. 가족 상실에 대한 직접적인 애도 표현으로 확인된다."),
    "l04": ("전선의 수가 적으나", "전선 수가 적어도 수군을 폐하지 말아야 한다고 한 상신이다. 위기 시기의 군사적 판단 사례다."),
    "t02": ("원래 군법이 있으니", "전시 지휘에서 군법을 언급하며 이탈 가능성에 대응한 난중일기 기록이다. 약속·책임 전반의 심리 특성으로 단정하지 않는다."),
    "x02": ("수군이 그 길을 누르고 있어서입니다", "임진왜란 중 수군이 적의 진로를 막는다는 전략적 이유를 설명한 상신이다. 해상 방어와 보급·진로 차단에 관한 판단 근거다."),
}


def extract(anchor: str) -> str:
    text = TEXT.read_text(encoding="utf-8")
    pos = text.find(anchor)
    if pos < 0:
        raise ValueError(f"앵커를 찾지 못함: {anchor}")
    return " ".join(text[max(0, pos - 300):pos + 800].split())


def main() -> None:
    rows = [json.loads(line) for line in ANSWERS.read_text(encoding="utf-8").splitlines() if line.strip()]
    for row in rows:
        if row["qid"] not in CURATIONS:
            continue
        anchor, note = CURATIONS[row["qid"]]
        item = {"text": note + " 원문 발췌: " + extract(anchor), "doc": DOC, "title": TITLE,
                "kind": "quotes", "tier": "own", "score": 1.0}
        row["evidence"] = [item] + [e for e in row.get("evidence", []) if e.get("doc") != DOC]
        row["answered"] = True
    ANSWERS.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    print(json.dumps({"updated": len(CURATIONS), "source": TEXT.name}, ensure_ascii=False))


if __name__ == "__main__":
    main()
