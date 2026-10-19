"""이름을 가린 인물 식별 평가(논문 12절 E1).

아바타의 답에서 이름·호칭·자기소개를 지우고, 평가자에게 "후보 k명 중 누구의 답 같은가"를 고르게 한다.
이름을 알면 기대가 판단을 끌고 가므로, 이름을 가려야 답 자체가 그 사람을 드러내는지 알 수 있다.
우연 수준은 1/k. 두 조건을 같은 질문으로 비교한다:
  B1 = 수집 자료를 근거로 답하는 페르소나(persona_chat.ask)
  B0 = 이름만 준 일반 LLM(자료 없음) — 유명인은 모델이 이미 알 수 있어, 자료의 기여는 B1-B0 증분으로만 말한다.

키(정답)는 평가자에게 내려가는 items 파일과 분리해 저장한다. 평가자는 사람(화면)이거나, 사전 점검용 로컬 모델이다.
로컬 모델 평가자는 사람 평가가 아니므로 결과에 항상 rater 종류를 함께 표시한다.
"""
import json
import math
import random
import re
import threading
import time
import urllib.request
import uuid
from pathlib import Path

from . import pattern, persona_chat, persona_qbank

EVAL_ROOT = persona_qbank.ROOT.parent / "persona_eval" / "blind"
MIN_REAL_ANSWERS = 20            # 확인된 답이 이보다 적으면 평가 대상에서 뺀다(논문 12절 제안값)
RATER_MODEL = "gemma4:e4b"
_lock = threading.Lock()

# 이름이 드러나지 않는 일반 주제. 전문 분야 질문은 주제만으로 정체가 드러나므로 따로 다룬다.
NEUTRAL_QUESTIONS = [
    "살면서 가장 크게 실패했다고 느낀 일은 무엇이고, 거기서 무엇을 배웠나요?",
    "중요한 결정을 내릴 때 무엇을 가장 먼저 따져 보나요?",
    "일에서 가장 큰 즐거움은 무엇인가요?",
    "사람들이 흔히 오해하는 점이 있다면 무엇인가요?",
    "젊은 사람에게 꼭 해 주고 싶은 조언이 있나요?",
    "화가 나거나 좌절될 때 어떻게 마음을 다스리나요?",
    "함께 일하고 싶은 사람은 어떤 사람인가요?",
    "시간이 지나 생각이 바뀐 믿음이 있나요?",
]

B0_PROMPT = """You are an AI avatar imitating {name_en} using only your general knowledge of this person (no documents are provided).
Speaking style (publicly known manner, not a quotation): {style}
Field of expertise: {expertise}.

Question (Korean): {question}

Rules:
- Reply in Korean, in first person, 2 to 4 short sentences, in the speaking style above.
- Never invent precise facts, numbers, dates or quotations.
- Do not mention your own name or refer to yourself in the third person."""

RATER_PROMPT = """Below is an anonymous answer to the question "{question}".
It was written by an AI avatar imitating ONE of these people: {names}.

Answer:
\"\"\"{answer}\"\"\"

Which person is it most likely imitating? Reply with exactly one name from the list, nothing else."""


def eligible_people() -> list:
    """확인된 답이 충분한 인물만. 자료가 적은 인물은 식별 평가 대상에서 뺀다."""
    out = []
    for person in persona_chat.PEOPLE:
        try:
            real = persona_qbank.summary(person).get("real_answered", 0)
        except Exception:  # noqa: BLE001
            real = 0
        if real >= MIN_REAL_ANSWERS:
            out.append(person)
    return out


def _name_patterns(person: str) -> list:
    info = persona_chat.PEOPLE[person]
    names = {info["name"], info["name_en"]}
    for full in list(names):
        for part in re.split(r"[\s·\-]+", full):
            if len(part) >= 2:
                names.add(part)
    # 긴 이름부터 지워야 짧은 부분이 먼저 지워져 조각이 남지 않는다
    return sorted(names, key=len, reverse=True)


def scrub(text: str, persons: list) -> str:
    """이름·자기소개 문장을 지운다. 주제만으로 드러나는 정체(예: 상대성이론)는 지울 수 없다."""
    out = text
    for person in persons:
        for name in _name_patterns(person):
            pattern_ = r"\b" + re.escape(name) + r"\b" if name.isascii() else re.escape(name)
            out = re.sub(pattern_, "○○", out, flags=re.IGNORECASE)
    out = re.sub(r"(저는|나는)\s*○○(입니다|이다|이에요|예요)[.。]?\s*", "", out)
    return re.sub(r"\s+", " ", out).strip()


def _chat(model: str, prompt: str, num_predict: int, temperature: float = 0.0) -> str:
    payload = json.dumps({"model": model, "stream": False, "think": False,
                          "messages": [{"role": "user", "content": prompt}],
                          "options": {"temperature": temperature, "num_predict": num_predict}}).encode()
    req = urllib.request.Request(pattern.OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=240) as resp:
        return json.loads(resp.read())["message"]["content"].strip()


def _answer_b0(person: str, question: str) -> str:
    info = persona_chat.PEOPLE[person]
    prompt = B0_PROMPT.format(name_en=info["name_en"], style=info["style"],
                              expertise=persona_chat.EXPERTISE[person]["expertise"], question=question)
    return _chat(persona_qbank.MODEL, prompt, 320, 0.3)


def create_set(persons: list | None = None, questions: list | None = None, progress=None) -> str:
    """질문 × 인물 × 조건(B0·B1) 답을 만들어 이름을 가리고 섞어 저장한다. 오래 걸리므로 별도 프로세스에서 호출한다."""
    persons = persons or eligible_people()
    questions = questions or NEUTRAL_QUESTIONS
    set_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
    folder = EVAL_ROOT / set_id
    folder.mkdir(parents=True, exist_ok=True)
    rows, norecord = [], []
    total = len(persons) * len(questions)
    done = 0
    for person in persons:
        for question in questions:
            b1 = persona_chat.ask(person, question)
            if b1.get("grounded"):
                rows.append({"person": person, "question": question, "condition": "B1", "answer": b1["answer"]})
            else:
                norecord.append({"person": person, "question": question, "condition": "B1"})
            try:
                rows.append({"person": person, "question": question, "condition": "B0", "answer": _answer_b0(person, question)})
            except Exception as exc:  # noqa: BLE001 — 한 문항 실패가 전체를 막지 않게 한다
                norecord.append({"person": person, "question": question, "condition": "B0", "error": str(exc)[:120]})
            done += 1
            if progress:
                progress(done, total)
    random.Random(set_id).shuffle(rows)
    items, key = [], {}
    for index, row in enumerate(rows, start=1):
        item_id = "i%03d" % index
        items.append({"id": item_id, "question": row["question"], "answer": scrub(row["answer"], persons)})
        key[item_id] = {"person": row["person"], "condition": row["condition"]}
    meta = {"id": set_id, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "persons": persons, "candidates": [
        persona_chat.PEOPLE[p]["name"] for p in persons], "questions": questions, "items": len(items),
        "no_record": norecord, "chance": round(1 / len(persons), 4) if persons else None,
        "note": "이름·호칭·자기소개 문장은 지웠지만 주제만으로 드러나는 정체는 남는다. 평가자는 사람이거나 로컬 모델이다."}
    (folder / "items.json").write_text(json.dumps({"meta": meta, "items": items}, ensure_ascii=False, indent=2), encoding="utf-8")
    (folder / "key.json").write_text(json.dumps(key, ensure_ascii=False, indent=2), encoding="utf-8")
    return set_id


def _folder(set_id: str) -> Path:
    if not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{4}", set_id or ""):
        raise ValueError("잘못된 평가 세트 번호")
    folder = EVAL_ROOT / set_id
    if not folder.exists():
        raise ValueError("없는 평가 세트")
    return folder


def list_sets() -> list:
    out = []
    if EVAL_ROOT.exists():
        for folder in sorted(EVAL_ROOT.iterdir(), reverse=True):
            f = folder / "items.json"
            if f.exists():
                meta = json.loads(f.read_text(encoding="utf-8"))["meta"]
                ratings = folder / "ratings.jsonl"
                n = len(ratings.read_text(encoding="utf-8").splitlines()) if ratings.exists() else 0
                out.append({"id": meta["id"], "created_at": meta["created_at"], "persons": meta["persons"], "items": meta["items"], "ratings": n})
    return out


def get_set(set_id: str) -> dict:
    """평가자에게 내려가는 데이터. 정답(key)은 포함하지 않는다."""
    return json.loads((_folder(set_id) / "items.json").read_text(encoding="utf-8"))


def add_rating(set_id: str, item_id: str, guess: str, rater: str, rater_kind: str = "human") -> dict:
    folder = _folder(set_id)
    data = get_set(set_id)
    if item_id not in {i["id"] for i in data["items"]}:
        raise ValueError("없는 문항")
    if guess not in data["meta"]["candidates"]:
        raise ValueError("후보에 없는 이름")
    row = {"item": item_id, "guess": guess, "rater": (rater or "익명")[:40], "kind": rater_kind if rater_kind in ("human", "model") else "human",
           "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    with _lock, open(folder / "ratings.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def auto_rate(set_id: str, progress=None) -> dict:
    """로컬 모델이 사전 점검용 평가자로 모든 문항을 푼다. 사람 평가가 아니다."""
    data = get_set(set_id)
    names = data["meta"]["candidates"]
    done_items = set()
    f = _folder(set_id) / "ratings.jsonl"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            r = json.loads(line)
            if r.get("rater") == RATER_MODEL:
                done_items.add(r["item"])
    for index, item in enumerate(data["items"], start=1):
        if item["id"] in done_items:
            continue
        order = random.Random(item["id"]).sample(names, len(names))   # 후보 순서 편향을 문항마다 섞는다
        reply = _chat(RATER_MODEL, RATER_PROMPT.format(question=item["question"], names=", ".join(order), answer=item["answer"]), 16)
        guess = next((n for n in sorted(names, key=len, reverse=True) if n in reply), None)
        if guess:
            add_rating(set_id, item["id"], guess, RATER_MODEL, "model")
        else:
            _record_unreadable(set_id, item["id"])
        if progress:
            progress(index, len(data["items"]))
    return results(set_id)


def _record_unreadable(set_id: str, item_id: str) -> None:
    row = {"item": item_id, "guess": None, "rater": RATER_MODEL, "kind": "model", "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    with _lock, open(_folder(set_id) / "ratings.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def wilson(k: int, n: int, z: float = 1.96) -> list:
    if n == 0:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0, c - h), 3), round(min(1, c + h), 3)]


def binom_p_greater(k: int, n: int, p0: float) -> float | None:
    """H0: 정확도 = 우연(p0) 아래에서 k 이상 맞힐 확률(단측, 정확검정)."""
    if n == 0:
        return None
    return round(sum(math.comb(n, i) * p0 ** i * (1 - p0) ** (n - i) for i in range(k, n + 1)), 6)


def results(set_id: str) -> dict:
    folder = _folder(set_id)
    data = get_set(set_id)
    key = json.loads((folder / "key.json").read_text(encoding="utf-8"))
    name_of = {p: persona_chat.PEOPLE[p]["name"] for p in data["meta"]["persons"]}
    chance = 1 / len(data["meta"]["persons"])
    ratings = []
    f = folder / "ratings.jsonl"
    if f.exists():
        ratings = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
    out = {"set": set_id, "chance": round(chance, 4), "raters": {}, "note": "로컬 모델 평가자는 사전 점검용이며 사람 평가가 아니다. 인물 간 평균은 내지 않는다."}
    groups = {}
    for r in ratings:
        groups.setdefault((r["rater"], r["kind"]), []).append(r)
    for (rater, kind), rows in groups.items():
        by_cond, confusion, unreadable = {}, {}, 0
        for r in rows:
            truth = key[r["item"]]
            if r["guess"] is None:
                unreadable += 1
                continue
            cond = by_cond.setdefault(truth["condition"], {"n": 0, "k": 0, "by_person": {}})
            hit = r["guess"] == name_of[truth["person"]]
            cond["n"] += 1
            cond["k"] += 1 if hit else 0
            bp = cond["by_person"].setdefault(name_of[truth["person"]], {"n": 0, "k": 0})
            bp["n"] += 1
            bp["k"] += 1 if hit else 0
            confusion.setdefault(truth["condition"], {}).setdefault(name_of[truth["person"]], {}).setdefault(r["guess"], 0)
            confusion[truth["condition"]][name_of[truth["person"]]][r["guess"]] += 1
        summary = {}
        for cond, v in by_cond.items():
            summary[cond] = {"n": v["n"], "correct": v["k"], "accuracy": round(v["k"] / v["n"], 3) if v["n"] else None,
                             "ci95": wilson(v["k"], v["n"]), "p_vs_chance": binom_p_greater(v["k"], v["n"], chance),
                             "by_person": {n: {"n": b["n"], "correct": b["k"]} for n, b in v["by_person"].items()}}
        out["raters"][f"{rater} ({kind})"] = {"ratings": len(rows), "unreadable": unreadable, "conditions": summary, "confusion": confusion}
    return out
