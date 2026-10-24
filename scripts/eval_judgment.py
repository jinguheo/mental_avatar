"""판단 사례 일치 시험 — 정보를 어떤 구조로 주면 내 선택을 잘 맞히는가.

문제: 승인된 판단 사례의 '상황'만 주고, 내가 실제로 한 선택(choice)과 선택하지 않은 대안(rejected_options)을
무작위 순서의 A/B로 보여 준다. 글자(A/B) 비교로 채점하므로 판정 모델의 편향이 없고 우연은 50%다.
조건(정보를 주는 구조):
  none       정보 없음(기준점)
  similar    상황이 비슷한 다른 사례 k건 (문제 사례 자신은 제외)
  principles 원칙 목록만
  both       원칙 목록 + 비슷한 사례 k건
⚠️ principles/both는 원칙이 같은 123건에서 뽑힌 것이라 낙관적이다(누수). 진짜 확인은 보류 시험으로 한다.
사용: python scripts/eval_judgment.py --conds none similar --k 3 [--limit 40] [--principles path.txt]
"""
import argparse
import json
import random
import re
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from db.init_db import get_conn  # noqa: E402

HARD = False
URL = "http://localhost:11434/api/chat"
MODEL = "gemma4:e4b"
SYSTEM = ("너는 허진구 본인이다. 아래 상황에서 허진구가 실제로 어떤 선택을 했을지 A와 B 중 하나만 골라 "
          "'A' 또는 'B' 한 글자로만 답해라.")


def grams(text):
    t = re.sub(r"\s+", "", text)
    return {t[i:i + 2] for i in range(len(t) - 1)}


def sim(a, b):
    return len(a & b) / (len(a | b) or 1)


def load_cases():
    conn = get_conn()
    rows = [dict(r) for r in conn.execute(
        "SELECT id, decision_type, situation, choice, rationale, rejected_options, exception_rule "
        "FROM decision_cases WHERE rejected_options<>'' AND source_kind='conversation_extracted' ORDER BY id")]
    conn.close()
    if HARD:
        alts = json.loads((Path(__file__).parent / "hard_alternatives.json").read_text(encoding="utf-8"))
        for r in rows:
            r["rejected_options"] = alts[r["id"][:6]]
    return rows


def case_text(c):
    s = f"- 상황: {c['situation']}\n  선택: {c['choice']}\n  이유: {c['rationale']}"
    if c["exception_rule"]:
        s += f"\n  예외: {c['exception_rule']}"
    return s


def ask(system, user):
    payload = json.dumps({"model": MODEL, "stream": False, "think": False,
                          "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
                          "options": {"temperature": 0, "num_predict": 8}}).encode()
    req = urllib.request.Request(URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read())["message"]["content"].strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--conds", nargs="+", default=["none", "similar"])
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--principles", default="")
    ap.add_argument("--out", default="")
    ap.add_argument("--hard", action="store_true", help="허수아비 대신 그럴듯한 대안(hard_alternatives.json) 사용")
    a = ap.parse_args()
    global HARD
    HARD = a.hard

    cases = load_cases()
    gs = {c["id"]: grams(c["situation"]) for c in cases}
    items = cases[:a.limit] if a.limit else cases
    principles = Path(a.principles).read_text(encoding="utf-8") if a.principles else ""
    rng = random.Random(7)
    order = {c["id"]: rng.random() < 0.5 for c in items}  # True면 정답이 A

    results = {}
    for cond in a.conds:
        ok = bad = 0
        per_type = {}
        for c in items:
            ctx = ""
            if cond in ("principles", "both"):
                ctx += "내가 정한 판단 원칙:\n" + principles + "\n\n"
            if cond in ("similar", "both"):
                others = sorted((o for o in cases if o["id"] != c["id"]),
                                key=lambda o: -sim(gs[c["id"]], gs[o["id"]]))[:a.k]
                ctx += "내가 과거에 실제로 한 비슷한 판단:\n" + "\n".join(case_text(o) for o in others) + "\n\n"
            ca, cb = (c["choice"], c["rejected_options"]) if order[c["id"]] else (c["rejected_options"], c["choice"])
            user = f"{ctx}[상황] {c['situation']}\nA. {ca}\nB. {cb}\n\n허진구는 A와 B 중 무엇을 선택했나? 한 글자로만 답해라."
            try:
                reply = ask(SYSTEM, user)
            except Exception:
                try:
                    reply = ask(SYSTEM, user)
                except Exception:
                    reply = ""
            m = re.search(r"[AB]", reply.upper())
            if not m:
                bad += 1
                continue
            hit = (m.group() == "A") == order[c["id"]]
            ok += hit
            t = per_type.setdefault(c["decision_type"], [0, 0])
            t[0] += hit
            t[1] += 1
        n = len(items) - bad
        results[cond] = {"correct": ok, "n": n, "acc": round(ok / n, 3) if n else None, "invalid": bad,
                         "by_type": {k: f"{v[0]}/{v[1]}" for k, v in per_type.items()}}
        print(cond, results[cond], flush=True)
    if a.out:
        Path(a.out).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
