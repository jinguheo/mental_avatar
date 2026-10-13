"""유명인 아바타 시험 — 수집 자료 현황, 질문·답 짝 추출, 구성용/시험용 분리.

수집 자료: data/persona_corpus/<인물>/ (scripts/persona_corpus.py가 만든다. 저장소에는 올리지 않는다)
시험 구조: 구성용 자료로만 아바타를 만들고, 시험용(보류) 질문에 대한 아바타의 답을 실제 답과 비교한다.
분리는 연도(또는 문서) 단위로 한다 — 문장 단위로 섞으면 같은 내용이 양쪽에 들어가 정답이 새어 들어간다.
"""
import json
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "data" / "persona_corpus"

PEOPLE = {
    "buffett": "워런 버핏",
    "einstein": "아인슈타인",
    "feynman": "파인만",
    "jobs": "스티브 잡스",
    "songhae": "송해(후보 배우·방송인, 한국어)",
    "sejong": "세종대왕(직접 평가 불가 — 기록·추정 기반, 리뷰 대기)",
}
HOLDOUT_FROM_YEAR = 2018      # 버핏: 이 해 이후 주주총회는 시험용. 같은 해 이후 주주서한도 구성 자료에서 뺀다


def _fix_mojibake(text: str) -> str:
    if "Ã" in text or "â\x80" in text or "Ã¢" in text:
        try:
            return text.encode("cp1252", errors="ignore").decode("utf-8", errors="ignore")
        except Exception:  # noqa: BLE001
            return text
    return text


def corpus_status() -> dict:
    out = []
    for key, name in PEOPLE.items():
        manifest = ROOT / key / "manifest.jsonl"
        rows = [json.loads(l) for l in manifest.read_text(encoding="utf-8").splitlines() if l.strip()] if manifest.exists() else []
        by_kind: dict = defaultdict(lambda: {"docs": 0, "chars": 0})
        for r in rows:
            by_kind[r["kind"]]["docs"] += 1
            by_kind[r["kind"]]["chars"] += r["chars"]
        qa = ROOT / key / "qa_pairs.jsonl"
        pairs = [json.loads(l) for l in qa.read_text(encoding="utf-8").splitlines() if l.strip()] if qa.exists() else []
        out.append({"id": key, "name": name, "docs": len(rows), "chars": sum(r["chars"] for r in rows), "by_kind": by_kind,
                    "qa_total": len(pairs), "qa_build": sum(1 for p in pairs if p["split"] == "build"), "qa_test": sum(1 for p in pairs if p["split"] == "test")})
    return {"people": out, "root": str(ROOT)}


SPEAKER = re.compile(r"^([A-Z][A-Z .'\-0-9]{2,40}):\s*(.*)$")
ASKERS_SKIP = {"VOICE", "VOICES", "INTERPRETER", "FEMALE VOICE"}


def buffett_pairs() -> list[dict]:
    """주주총회 녹취에서 (질문, 버핏의 답) 짝을 뽑는다. 질문 = 버핏·멍거가 아닌 화자의 발언(진행자가 읽어 주는 주주 질문 포함).
    답 = 그 직후 이어지는 버핏의 연속 발언(멍거의 보충은 제외). 너무 짧은 것은 버린다."""
    pairs = []
    for f in sorted((ROOT / "buffett" / "texts").glob("interview_Berkshire_annual_meeting_*")):
        m = re.search(r"meeting_(\d{4})_(morning|afternoon)", f.name)
        if not m:
            continue
        year, part = int(m.group(1)), m.group(2)
        turns = []   # (speaker, text)
        for line in _fix_mojibake(f.read_text(encoding="utf-8")).splitlines():
            line = line.strip()
            if not line or line == "Sync Video to Paragraph":
                continue
            sp = SPEAKER.match(line)
            if sp:
                turns.append([sp.group(1), sp.group(2)])
            elif turns:
                turns[-1][1] += " " + line
        i = 0
        while i < len(turns):
            sp, text = turns[i]
            if sp not in ("WARREN BUFFETT", "CHARLIE MUNGER") and sp not in ASKERS_SKIP and len(text) >= 40 and text.count("?") >= 1:
                j, answer = i + 1, []
                while j < len(turns) and turns[j][0] == "WARREN BUFFETT":
                    answer.append(turns[j][1])
                    j += 1
                ans = " ".join(answer).strip()
                if len(ans) >= 250:
                    pairs.append({"person": "buffett", "year": year, "session": part, "asker": sp, "question": text.strip(), "answer": ans,
                                  "split": "test" if year >= HOLDOUT_FROM_YEAR else "build", "source": f.name})
                i = j
            else:
                i += 1
    return pairs


def build_buffett() -> dict:
    pairs = buffett_pairs()
    (ROOT / "buffett").mkdir(parents=True, exist_ok=True)
    with open(ROOT / "buffett" / "qa_pairs.jsonl", "w", encoding="utf-8") as fh:
        for p in pairs:
            fh.write(json.dumps(p, ensure_ascii=False) + "\n")
    return {"total": len(pairs), "build": sum(1 for p in pairs if p["split"] == "build"), "test": sum(1 for p in pairs if p["split"] == "test")}
