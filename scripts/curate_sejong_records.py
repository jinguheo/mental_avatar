"""세종 질문은행에 원문으로 확인한 관찬 기록을 연결한다.

실록은 세종의 저술이 아니므로 evidence tier를 ``reported``로만 넣는다.
이 스크립트는 제목·문서·앵커가 모두 맞을 때만 갱신해, 해설이나 추정을
관찬 기록처럼 승격하지 않는다.
"""
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent / "data" / "persona_corpus" / "sejong"
TEXTS = ROOT / "texts"
ANSWERS = ROOT / "answers.jsonl"


RECORDS = {
    "gongbeop": {
        "doc": "record_위키문헌_세종실록_12년_1430_공법_논의",
        "title": "세종실록 12년(1430): 공법 가부를 정부·관리·백성에게 묻게 함",
        "anchor": "호조에서 공법에 의거하여 전답 1결마다 조 10두를 거둘 것을 건의하니",
    },
    "trial": {
        "doc": "record_위키문헌_세종실록_26년_1444_언문_반대_상소",
        "title": "세종실록 26년(1444): 공법을 논의하고 일부 고을에서 시험할 것을 논함",
        "anchor": "임금이 한확·김종서·이숙치 등과 복식과 공법문제에 대해 논의하다",
    },
    "scholars": {
        "doc": "record_위키문헌_세종실록_26년_1444_언문_반대_상소",
        "title": "세종실록 26년(1444): 집현전 학자들에게 언문 번역을 명함",
        "anchor": "집현전 교리 최항·부교리 박팽년 등에게 언문으로",
    },
    "opposition": {
        "doc": "record_위키문헌_세종실록_26년_1444_언문_반대_상소",
        "title": "세종실록 26년(1444): 최만리 등의 언문 제작 반대 상소",
        "anchor": "집현전 부제학 최만리 등이 언문 제작의 부당함을 아뢰다",
    },
    "hunmin": {
        "doc": "record_위키문헌_세종실록_28년_1446_훈민정음_반포",
        "title": "세종실록 28년(1446): 훈민정음 완성과 어제 서문",
        "anchor": "《훈민정음》이 이루어지다. 어제와 예조 판서 정인지의 서문",
    },
    "farming": {
        "doc": "record_위키문헌_세종실록_12년_1430_공법_논의",
        "title": "세종실록 12년(1430): 농사직설 반포와 농정을 중시한다는 발언",
        "anchor": "《농사직설》을 여러 도의 감사와 서울의 시직·산직 2품 이상의 관원에게 반포하다",
    },
}


CURATIONS = {
    "v10": ("gongbeop", "정책의 가부를 정부·관리·지방의 백성까지 넓게 물어 보고하게 한 기록이다. 이는 제도 결정에서 폭넓은 의견 수렴을 시도한 사례이지, 현대적 민주주의 신념을 확정하는 근거는 아니다."),
    "w01": ("gongbeop", "공법을 제안받았을 때 여러 관청과 백성에게 가부를 묻도록 한 기록이다. 중요한 제도는 여러 층위의 의견을 확인하는 방식으로 다룬 사례로 제한해 읽는다."),
    "w02": ("trial", "공법을 즉시 전면 시행하지 않고, 흉년과 시행 여건을 논의한 뒤 일부 주현에서 시험하는 방안을 검토한 기록이다."),
    "w05": ("scholars", "집현전 학자들에게 언문으로 운회를 번역하게 하고 왕세자 등이 일을 감독하게 한 기록이다. 특정 업무를 학자 집단에 맡긴 사실의 근거다."),
    "w08": ("trial", "법이 좋더라도 시행 초기의 혼란과 흉년을 고려해 일부 주현에서 시험할지를 논의한 기록이다. 장·단기 성향 일반화가 아니라 정책 시행 순서의 사례다."),
    "w10": ("opposition", "언문 제작에 대한 최만리 등의 반대 상소와 그 뒤의 조치가 기록되어 있다. 반대가 있었다는 사실의 근거이며, 권위관 자체를 심리적으로 단정하지 않는다."),
    "w12": ("gongbeop", "공법을 두고 각 관청·지방 관리·백성의 가부를 물어 보고하게 한 기록이다. 조언을 언제나 수용했다는 뜻이 아니라, 이 사안에서 의견을 수집한 사실이다."),
    "e03": ("opposition", "최만리 등의 반대 상소가 공식 기록에 남아 있다. 이 자료만으로 비판에 대한 감정적 반응이나 성격을 확정할 수는 없다."),
    "r04": ("opposition", "정책 반대 상소가 기록되어 있어, 의견 충돌이 제도권 안에서 문서로 제기된 사례로는 확인된다. 적대자에 대한 일반적 태도는 이 기록만으로 판단하지 않는다."),
    "v15": ("farming", "농사직설 반포 때 농업과 곡식을 왕정의 근본으로 여겨 농사에 마음을 쓴다는 발언이 기록되어 있다. 과학 일반에 대한 견해로 넓히지는 않는다."),
    "a03": ("farming", "농사직설을 여러 도에 반포한 기록은 농업 지식의 정리·보급을 추진한 사례다. 개인 독서 습관을 보여 주는 자료는 아니다."),
    "l02": ("hunmin", "세종실록은 1446년에 훈민정음이 이루어졌다고 기록한다. 이는 그의 삶 전체의 내면적 전환점이 아니라 확인 가능한 역사적 이정표다."),
}


def excerpt(record: dict) -> str:
    path = TEXTS / (record["doc"] + ".txt")
    text = path.read_text(encoding="utf-8")
    start = text.find(record["anchor"])
    if start < 0:
        raise ValueError(f"앵커를 찾지 못함: {record['doc']} / {record['anchor']}")
    return " ".join(text[start:start + 1000].split())


def evidence(key: str, note: str) -> dict:
    record = RECORDS[key]
    return {"text": note + " 원문 발췌: " + excerpt(record), "doc": record["doc"],
            "title": record["title"], "kind": "record", "tier": "reported", "score": 1.0}


def main() -> None:
    rows = [json.loads(line) for line in ANSWERS.read_text(encoding="utf-8").splitlines() if line.strip()]
    changed = 0
    for row in rows:
        spec = CURATIONS.get(row["qid"])
        if not spec:
            continue
        item = evidence(*spec)
        prior = [e for e in row.get("evidence", []) if e.get("doc") != item["doc"]]
        row["evidence"] = [item] + prior
        row["answered"] = True
        changed += 1
    ANSWERS.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    print(json.dumps({"updated": changed, "records": len(RECORDS)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
