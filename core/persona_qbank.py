"""질문 은행으로 인물 고유 정보 찾기.

인터뷰 질문(성격·가치관·결정·감정·관계·유머·습관·이력·모순)을 우리가 직접 만들고, 수집한 자료(본인 글·편지·연설·발언·인터뷰·전기)에서
각 질문에 본인이 직접 답한 대목을 찾는다. 100%를 목표로 하지 않는다 — 찾아진 질문만 '답 있음'으로 남기고 나머지는 '답 없음'.

찾는 순서: 문단으로 나눔 → BM25로 후보 → 로컬 모델이 "이 대목이 질문에 대한 본인의 직접 답인가" 판정(YES만 채택).
근거 단계: own(본인이 쓰거나 말한 것) / reported(전기·백과에 적힌 행동·일화). 출처 문서와 종류를 항상 함께 저장한다.
결과: data/persona_corpus/<인물>/answers.jsonl — 구성용(특정 정보) 근거이자, 일부를 보류하면 시험용 정답이 된다.
"""
import json
import math
import re
import threading
import time
import urllib.request
from collections import Counter
from pathlib import Path

from . import pattern

ROOT = Path(__file__).resolve().parent.parent / "data" / "persona_corpus"
MODEL = "gemma4:e2b"
OWN_KINDS = {"primary", "interview", "quotes", "lecture"}

# (id, 영역, 한국어 질문, 영어 질문, 검색 키워드)
D_VAL, D_WORK, D_EMO, D_REL, D_HUM, D_HAB, D_LIFE, D_CON = "가치관·신념·윤리", "일과 결정", "감정·갈등", "관계", "유머·말투", "취향·습관", "인생 이력", "모순·한계"
QUESTIONS = [
    ("v01", D_VAL, "무엇이 인생에서 가장 중요하다고 생각하나요?", "What is most important in life?", "meaning purpose important life value worth living"),
    ("v02", D_VAL, "삶의 의미는 무엇이라고 보나요?", "What do you think is the meaning of life?", "meaning of life purpose existence"),
    ("v03", D_VAL, "신이나 종교에 대해 어떻게 생각하나요?", "What do you believe about God and religion?", "god religion faith believe church spirit"),
    ("v04", D_VAL, "죽음을 어떻게 생각하나요?", "How do you think about death?", "death die dying mortality afraid"),
    ("v05", D_VAL, "돈과 부는 어떤 의미인가요?", "What does money and wealth mean to you?", "money wealth rich fortune income"),
    ("v06", D_VAL, "무엇이 옳고 그름을 가른다고 보나요?", "How do you decide what is right and wrong?", "right wrong moral ethics conscience duty"),
    ("v07", D_VAL, "정직과 성실에 대해 어떻게 생각하나요?", "What do you think about honesty and integrity?", "honesty integrity truth lie honest"),
    ("v08", D_VAL, "자유와 책임에 대해 어떻게 생각하나요?", "How do you think about freedom and responsibility?", "freedom liberty responsibility free will"),
    ("v09", D_VAL, "평화와 전쟁에 대한 입장은 무엇인가요?", "What is your position on war and peace?", "war peace military violence weapons"),
    ("v10", D_VAL, "정부와 사회는 어떠해야 한다고 보나요?", "What should government and society look like?", "government society politics state democracy socialism"),
    ("v11", D_VAL, "교육은 어떠해야 한다고 보나요?", "What do you think education should be?", "education school teaching learn students"),
    ("v12", D_VAL, "행복은 무엇이라고 생각하나요?", "What is happiness to you?", "happy happiness joy contentment satisfaction"),
    ("v13", D_VAL, "다른 사람을 대할 때 지키는 원칙이 있나요?", "Do you have principles in how you treat others?", "treat others respect kindness fair principle"),
    ("v14", D_VAL, "명성과 인정에 대해 어떻게 생각하나요?", "How do you feel about fame and recognition?", "fame famous recognition honors celebrity praise"),
    ("v15", D_VAL, "과학(또는 일)의 가치와 한계는 무엇인가요?", "What are the value and limits of science or your craft?", "science scientific value limits knowledge truth"),
    ("w01", D_WORK, "중요한 결정을 어떻게 내리나요?", "How do you make important decisions?", "decision decide choose judgment decide"),
    ("w02", D_WORK, "위험을 어떻게 다루나요?", "How do you deal with risk?", "risk danger uncertainty margin of safety gamble"),
    ("w03", D_WORK, "실패와 실수에서 무엇을 배웠나요?", "What have you learned from failure and mistakes?", "failure mistake error wrong learned lesson"),
    ("w04", D_WORK, "일할 때 가장 중요한 기준은 무엇인가요?", "What is your most important standard in your work?", "work standard quality excellence principle"),
    ("w05", D_WORK, "좋은 팀이나 사람은 어떤 사람인가요?", "What makes a good team or person to work with?", "team people hire talent manager colleagues"),
    ("w06", D_WORK, "창의성은 어디에서 나온다고 보나요?", "Where does creativity come from?", "creative creativity imagination idea invent"),
    ("w07", D_WORK, "무엇을 하지 않기로 했나요? 거절한 일과 이유는?", "What did you decide not to do, and why?", "refuse decline reject turned down not do"),
    ("w08", D_WORK, "장기적 관점과 단기적 성과 중 무엇을 우선하나요?", "Do you favor long-term or short-term?", "long term short term patience future quarter"),
    ("w09", D_WORK, "경쟁과 협력에 대해 어떻게 생각하나요?", "How do you think about competition and cooperation?", "competition competitor cooperation rival"),
    ("w10", D_WORK, "권위와 규칙에 어떻게 대하나요?", "How do you relate to authority and rules?", "authority rules obey bureaucracy official"),
    ("w11", D_WORK, "아는 것과 모르는 것의 경계를 어떻게 다루나요?", "How do you handle the limits of what you know?", "know don't know ignorance doubt uncertain admit"),
    ("w12", D_WORK, "조언을 구하거나 남의 말을 받아들이나요?", "Do you seek or accept advice from others?", "advice listen opinion criticism consult"),
    ("e01", D_EMO, "화가 나는 때는 언제인가요?", "What makes you angry?", "angry anger furious irritated annoyed outrage"),
    ("e02", D_EMO, "두려워하는 것은 무엇인가요?", "What are you afraid of?", "afraid fear worry anxiety dread"),
    ("e03", D_EMO, "비판받을 때 어떻게 반응하나요?", "How do you react to criticism?", "criticism critic attack blame reaction"),
    ("e04", D_EMO, "외로움이나 고독에 대해 어떻게 느끼나요?", "How do you feel about solitude and loneliness?", "lonely solitude alone isolation"),
    ("e05", D_EMO, "가장 큰 기쁨이나 보람은 언제인가요?", "When do you feel the greatest joy or fulfillment?", "joy delight pleasure fulfillment thrill"),
    ("e06", D_EMO, "좌절했을 때 어떻게 다시 일어서나요?", "How do you recover when discouraged?", "discouraged setback persevere recover disappointed"),
    ("e07", D_EMO, "후회하는 것이 있나요?", "Do you have regrets?", "regret wish i had mistake sorry"),
    ("r01", D_REL, "가족에 대해 어떻게 생각하나요?", "How do you think about family?", "family wife husband children father mother parents"),
    ("r02", D_REL, "친구나 동료와의 관계에서 중요한 것은?", "What matters in friendships and relationships with colleagues?", "friend friendship colleague companion trust loyalty"),
    ("r03", D_REL, "멘토나 스승이 있었나요?", "Who were your mentors or teachers?", "mentor teacher taught influence learned from"),
    ("r04", D_REL, "경쟁자나 적대적인 사람을 어떻게 대하나요?", "How do you treat rivals or adversaries?", "enemy adversary opponent hostile rival conflict"),
    ("r05", D_REL, "사랑이나 결혼을 어떻게 생각하나요?", "How do you think about love and marriage?", "love marriage wife romance partner"),
    ("r06", D_REL, "대중이나 미디어와의 관계를 어떻게 보나요?", "How do you view the public and the press?", "public press media reporters publicity"),
    ("h01", D_HUM, "유머를 어떻게 사용하나요? 농담을 해 주세요.", "How do you use humor?", "joke humor funny laugh amusing wit"),
    ("h02", D_HUM, "자신을 어떻게 소개하거나 설명하나요?", "How do you describe yourself?", "i am myself describe character nature"),
    ("h03", D_HUM, "자주 쓰는 비유나 표현이 있나요?", "Do you have favorite metaphors or phrases?", "like a metaphor analogy as if imagine picture"),
    ("a01", D_HAB, "하루를 어떻게 보내나요? 일상 습관은?", "How do you spend a typical day? Habits?", "daily routine habit morning day work hours"),
    ("a02", D_HAB, "좋아하는 것과 즐기는 취미는 무엇인가요?", "What do you like? Hobbies?", "hobby enjoy favorite love playing music game"),
    ("a03", D_HAB, "무엇을 읽거나 배우나요?", "What do you read and learn?", "read book reading study learn library"),
    ("a04", D_HAB, "음식·옷·물건에 대한 취향은?", "What are your tastes in food, clothes, things?", "food eat dress clothes taste simple possessions"),
    ("a05", D_HAB, "건강과 몸을 어떻게 관리하나요?", "How do you look after your health?", "health exercise sleep body diet"),
    ("a06", D_HAB, "여행이나 장소에 대한 애착이 있나요?", "Do you have attachments to places or travel?", "travel place home city country live"),
    ("l01", D_LIFE, "어린 시절은 어땠나요? 무엇이 영향을 주었나요?", "What was your childhood like and what shaped you?", "childhood boy young school parents grew up"),
    ("l02", D_LIFE, "인생의 전환점은 언제였나요?", "What were the turning points of your life?", "turning point changed my life decision moment"),
    ("l03", D_LIFE, "가장 자랑스러운 일은 무엇인가요?", "What are you most proud of?", "proud achievement accomplishment best work"),
    ("l04", D_LIFE, "어려운 시기는 어떻게 지냈나요?", "How did you get through hard times?", "hard times difficult struggle poverty crisis"),
    ("l05", D_LIFE, "어떤 사람으로 기억되고 싶나요?", "How do you want to be remembered?", "remembered legacy epitaph after i die"),
    ("l06", D_LIFE, "젊은이에게 어떤 조언을 하겠나요?", "What advice would you give to young people?", "advice young people students graduates"),
    ("c01", D_CON, "스스로의 단점이나 약점은 무엇인가요?", "What are your own faults and weaknesses?", "my fault weakness shortcoming flaw failing"),
    ("c02", D_CON, "예전에 틀렸다고 인정한 생각이 있나요?", "Is there something you once believed and later admitted was wrong?", "was wrong mistaken changed my mind admit error"),
    ("c03", D_CON, "말과 다르게 행동한 적이 있나요?", "Have you acted contrary to what you preach?", "hypocrisy contradict inconsistent said but did"),
    ("c04", D_CON, "남들이 오해하는 점은 무엇인가요?", "What do people misunderstand about you?", "misunderstand misunderstood misrepresent reputation myth"),
    ("c05", D_CON, "스스로 가장 부끄러운 일은?", "What are you most ashamed of?", "ashamed shame embarrassed guilt"),
]

_state = {"running": False, "person": "", "done": 0, "total": 0, "last_error": None, "started": None}
_lock = threading.Lock()


def _paragraphs(person: str) -> list[dict]:
    """자료를 검색 단위(300~900자 문단)로 쪼갠다. 본인 글/전기를 구분해 단계(tier)를 붙인다."""
    chunks = []
    manifest = ROOT / person / "manifest.jsonl"
    docs = [json.loads(l) for l in manifest.read_text(encoding="utf-8").splitlines() if l.strip()]
    for d in docs:
        path = ROOT / person / "texts" / (d["id"] + ".txt")
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        tier = "own" if d["kind"] in OWN_KINDS else "reported"
        buf = ""
        for line in text.splitlines():
            line = line.strip()
            if not line or line == "Sync Video to Paragraph":
                continue
            buf += (" " if buf else "") + line
            if len(buf) >= 500:
                chunks.append({"doc": d["id"], "title": d["title"], "kind": d["kind"], "tier": tier, "text": buf[:1200]})
                buf = ""
        if len(buf) >= 120:
            chunks.append({"doc": d["id"], "title": d["title"], "kind": d["kind"], "tier": tier, "text": buf[:1200]})
    return chunks


def _tok(s: str) -> list[str]:
    return [w for w in re.findall(r"[a-z']{3,}", s.lower()) if w not in STOP]


STOP = set("the and for that with this was were are but not you your his her him they them have has had from which what when who whom would could should there their been its into than then also more most some any all one our out about over after before while because only very much many such these those can will may might must just like".split())


class _Bm25:
    def __init__(self, chunks):
        self.chunks = chunks
        self.docs = [Counter(_tok(c["text"])) for c in chunks]
        self.len = [sum(d.values()) or 1 for d in self.docs]
        self.avg = sum(self.len) / max(len(self.len), 1)
        df = Counter()
        for d in self.docs:
            df.update(d.keys())
        n = len(chunks)
        self.idf = {w: math.log(1 + (n - f + 0.5) / (f + 0.5)) for w, f in df.items()}

    def search(self, query: str, k: int = 8, tier: str | None = None):
        q = _tok(query)
        scored = []
        for i, d in enumerate(self.docs):
            if tier and self.chunks[i]["tier"] != tier:
                continue
            s = 0.0
            for w in q:
                f = d.get(w, 0)
                if f:
                    s += self.idf.get(w, 0) * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * self.len[i] / self.avg))
            if s > 0:
                scored.append((s, i))
        scored.sort(reverse=True)
        return [(s, self.chunks[i]) for s, i in scored[:k]]


JUDGE = """Question put to a person: "{q}"

Passage (from a document by or about {name}):
\"\"\"{p}\"\"\"

Does this passage contain {name}'s OWN explicit answer to that question — their stated belief, feeling, habit, decision or experience on the topic, in their own words or clearly reported as theirs? Reply with exactly one word: YES or NO."""


def _judge(question: str, passage: str, name: str) -> bool:
    payload = json.dumps({"model": MODEL, "stream": False, "think": False,
                          "messages": [{"role": "user", "content": JUDGE.format(q=question, p=passage[:1100], name=name)}],
                          "options": {"temperature": 0, "num_predict": 4}}).encode()
    req = urllib.request.Request(pattern.OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.loads(resp.read())["message"]["content"].strip().upper()
    return out.startswith("YES")


NAMES = {"buffett": "Warren Buffett", "einstein": "Albert Einstein", "feynman": "Richard Feynman", "jobs": "Steve Jobs", "songhae": "Song Hae", "brucelee": "Bruce Lee"}


def run(person: str, candidates: int = 5) -> dict:
    """질문 은행 전체를 돌려 answers.jsonl을 만든다(오래 걸리므로 스레드로 실행)."""
    name = NAMES[person]
    chunks = _paragraphs(person)
    index = _Bm25(chunks)
    out_path = ROOT / person / "answers.jsonl"
    with _lock:
        _state.update(running=True, person=person, done=0, total=len(QUESTIONS), last_error=None, started=time.strftime("%Y-%m-%d %H:%M:%S"))
    rows = []
    try:
        for qid, domain, ko, en, kw in QUESTIONS:
            found = []
            for tier in ("own", "reported"):
                for score, ch in index.search(en + " " + kw, k=candidates, tier=tier):
                    try:
                        ok = _judge(en, ch["text"], name)
                    except Exception as exc:  # noqa: BLE001 — 모델이 응답 못 하면 이 질문은 건너뛴다
                        _state["last_error"] = str(exc)
                        ok = False
                    if ok:
                        found.append({"text": ch["text"], "doc": ch["doc"], "title": ch["title"], "kind": ch["kind"], "tier": tier, "score": round(score, 2)})
                if found and tier == "own":
                    break   # 본인 글에서 찾았으면 전기 단계는 보지 않는다
            rows.append({"qid": qid, "domain": domain, "question": ko, "question_en": en, "answered": bool(found), "evidence": found})
            _state["done"] += 1
        with open(out_path, "w", encoding="utf-8") as fh:
            for r in rows:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    finally:
        _state["running"] = False
    return summary(person)


def start(person: str) -> dict:
    if _state["running"]:
        return {"error": "이미 실행 중입니다: " + _state["person"]}
    if person not in NAMES:
        raise ValueError("알 수 없는 인물")
    threading.Thread(target=run, args=(person,), daemon=True).start()
    return {"started": person}


def load(person: str) -> list[dict]:
    p = ROOT / person / "answers.jsonl"
    rows = [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.exists() else []
    sources = {}
    m = ROOT / person / "manifest.jsonl"
    if m.exists():
        for l in m.read_text(encoding="utf-8").splitlines():
            if l.strip():
                d = json.loads(l)
                sources[d["id"]] = d
    for r in rows:           # 근거마다 원 출처(URL)와 저장 파일을 붙여, 어디서 찾았는지 확인할 수 있게 한다
        for e in r["evidence"]:
            d = sources.get(e["doc"], {})
            e["source_url"] = d.get("source")
            e["file"] = str(ROOT / person / "texts" / (e["doc"] + ".txt"))
    return rows


def summary(person: str) -> dict:
    rows = load(person)
    by_domain: dict = {}
    for r in rows:
        d = by_domain.setdefault(r["domain"], {"total": 0, "answered": 0, "own": 0})
        d["total"] += 1
        d["answered"] += 1 if r["answered"] else 0
        d["own"] += 1 if any(e["tier"] == "own" for e in r["evidence"]) else 0
    return {"person": person, "total": len(rows), "answered": sum(1 for r in rows if r["answered"]),
            "own_answered": sum(1 for r in rows if any(e["tier"] == "own" for e in r["evidence"])), "by_domain": by_domain}


def status() -> dict:
    return {**_state, "questions": len(QUESTIONS), "people": {p: summary(p) for p in NAMES}}
