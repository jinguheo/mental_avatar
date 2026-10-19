"""판단 사례의 학습/시험 분리 — 일치(sync)를 재기 위한 보류 시험 세트.

대상: decision_pairs 중 판단이 담긴 사례(기준·결정·목표 라벨, 직전 Claude 발화가 있고, 내 답이 15~400자).
방법: 시간순으로 앞 80%는 train(판단 정책을 뽑는 데 쓴다), 뒤 20%는 test(정책을 만들 때 절대 보지 않는다).
  - 미래의 내 판단을 과거 기록으로 맞히는 시험이라 무작위가 아니라 시간순으로 나눈다.
  - 같은 선호를 여러 세션에서 반복해 말하므로, test 중 train과 같거나 거의 같은 문장은 'excluded_dup'으로
    빼서 시험 점수가 부풀지 않게 한다(정규화 후 완전 일치 또는 글자 3-gram 자카드 유사도 0.8 이상).
  - 한 번 분리하면 바꾸지 않는다(시험 세트를 보고 나서 다시 나누는 것을 막는다). force=True일 때만 새로 나눈다.

⚠️ 누수 주의: test 사례의 원문은 이미 KG 노드·자기 요약·말투 표본 등에 들어가 있을 수 있다. 일치를 잴 때 아바타가 이
사례를 검색으로 되찾지 못하게 test 키의 출처 노드는 반드시 제외해야 한다(3단계에서 처리).
"""
import re
import time

from db.init_db import get_conn

ELIGIBLE_LABELS = ("기준", "결정", "목표")
MIN_REPLY, MAX_REPLY = 15, 400
TEST_RATIO = 0.2
NEAR_DUP = 0.8


def _init(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS decision_split (
        key TEXT PRIMARY KEY, split TEXT NOT NULL, reason TEXT, assigned_at TEXT);
    CREATE TABLE IF NOT EXISTS decision_split_meta (k TEXT PRIMARY KEY, v TEXT);
    """)
    conn.commit()


def _norm(text: str) -> str:
    return re.sub(r"[^0-9a-z가-힣]", "", (text or "").lower())


def _grams(text: str) -> set:
    return {text[i:i + 3] for i in range(len(text) - 2)} if len(text) >= 3 else {text}


def _jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def _eligible(conn) -> list:
    marks = ",".join("?" * len(ELIGIBLE_LABELS))
    return conn.execute(
        f"SELECT key, created_at, reply, label FROM decision_pairs WHERE label IN ({marks}) "
        "AND length(context) > 0 AND length(reply) BETWEEN ? AND ? ORDER BY created_at, key",
        (*ELIGIBLE_LABELS, MIN_REPLY, MAX_REPLY)).fetchall()


def meta(conn=None) -> dict:
    own = conn is None
    conn = conn or get_conn()
    try:
        _init(conn)
        return {r[0]: r[1] for r in conn.execute("SELECT k, v FROM decision_split_meta")}
    finally:
        if own:
            conn.close()


def create_split(test_ratio: float = TEST_RATIO, force: bool = False) -> dict:
    conn = get_conn()
    try:
        _init(conn)
        if meta(conn) and not force:
            raise ValueError("이미 시험 세트를 분리했습니다. 시험 세트를 본 뒤 다시 나누는 것을 막기 위해 바꾸지 않습니다.")
        rows = _eligible(conn)
        if len(rows) < 20:
            raise ValueError("분리할 판단 사례가 너무 적습니다: %d건" % len(rows))
        cut = int(len(rows) * (1 - test_ratio))
        train, test = rows[:cut], rows[cut:]
        train_norm = {_norm(r["reply"]) for r in train}
        train_grams = [_grams(_norm(r["reply"])) for r in train]
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        conn.execute("DELETE FROM decision_split")
        conn.execute("DELETE FROM decision_split_meta")
        out = []
        for r in train:
            out.append((r["key"], "train", "시간순 앞 %d%%" % round((1 - test_ratio) * 100), now))
        dup_exact = dup_near = 0
        for r in test:
            n = _norm(r["reply"])
            if n in train_norm:
                dup_exact += 1
                out.append((r["key"], "excluded_dup", "train과 같은 문장", now))
                continue
            g = _grams(n)
            if any(_jaccard(g, tg) >= NEAR_DUP for tg in train_grams):
                dup_near += 1
                out.append((r["key"], "excluded_dup", "train과 거의 같은 문장(유사도 %.1f 이상)" % NEAR_DUP, now))
                continue
            out.append((r["key"], "test", "시간순 뒤 %d%%" % round(test_ratio * 100), now))
        conn.executemany("INSERT INTO decision_split(key, split, reason, assigned_at) VALUES (?,?,?,?)", out)
        counts = {"eligible": len(rows), "train": len(train), "test_candidates": len(test),
                  "test": sum(1 for o in out if o[1] == "test"), "excluded_dup": dup_exact + dup_near,
                  "dup_exact": dup_exact, "dup_near": dup_near}
        info = {"created_at": now, "cutoff_at": test[0]["created_at"], "test_ratio": str(test_ratio),
                "labels": ",".join(ELIGIBLE_LABELS), "reply_len": "%d-%d" % (MIN_REPLY, MAX_REPLY),
                "rule": "시간순 분리 + test 중 train과 같거나 거의 같은 문장 제외", **{k: str(v) for k, v in counts.items()}}
        conn.executemany("INSERT INTO decision_split_meta(k, v) VALUES (?,?)", list(info.items()))
        conn.commit()
        return {**info, **counts}
    finally:
        conn.close()


def keys(split: str) -> list:
    conn = get_conn()
    try:
        _init(conn)
        return [r[0] for r in conn.execute("SELECT key FROM decision_split WHERE split=? ORDER BY key", (split,))]
    finally:
        conn.close()


def status() -> dict:
    conn = get_conn()
    try:
        _init(conn)
        info = meta(conn)
        if not info:
            return {"created": False}
        by = {r[0]: r[1] for r in conn.execute("SELECT split, COUNT(*) FROM decision_split GROUP BY split")}
        span = {}
        for s in ("train", "test"):
            row = conn.execute("SELECT MIN(p.created_at), MAX(p.created_at) FROM decision_split d JOIN decision_pairs p ON p.key=d.key "
                               "WHERE d.split=?", (s,)).fetchone()
            span[s] = [row[0], row[1]]
        return {"created": True, "counts": by, "span": span, **info}
    finally:
        conn.close()


if __name__ == "__main__":
    import json
    import sys
    if "--create" in sys.argv:
        print(json.dumps(create_split(force="--force" in sys.argv), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(status(), ensure_ascii=False, indent=2))
