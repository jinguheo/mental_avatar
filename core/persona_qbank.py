"""질문 은행으로 인물 고유 정보 찾기.

인터뷰 질문(성격·가치관·결정·감정·관계·유머·습관·이력·모순)을 우리가 직접 만들고, 수집한 자료(본인 글·편지·연설·발언·인터뷰·전기)에서
각 질문에 본인이 직접 답한 대목을 찾는다. 100%를 목표로 하지 않는다 — 찾아진 질문만 '답 있음'으로 남기고 나머지는 '답 없음'.

찾는 순서: 문단으로 나눔 → BM25로 후보 → 로컬 모델이 "이 대목이 질문에 대한 본인의 직접 답인가" 판정(YES만 채택).
근거 단계: own(본인이 쓰거나 말한 것) / reported(전기·백과에 적힌 행동·일화). 출처 문서와 종류를 항상 함께 저장한다.
결과: data/persona_corpus/<인물>/answers.jsonl — 구성용(특정 정보) 근거이자, 일부를 보류하면 시험용 정답이 된다.
"""
import hashlib
import json
import math
import re
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import pattern
from .persona_policy import HISTORICAL_FIVE, MODES, public_person_policy

ROOT = Path(__file__).resolve().parent.parent / "data" / "persona_corpus"
MODEL = "gemma4:e2b"
OWN_KINDS = {"primary", "interview", "quotes", "lecture"}
SKIP_KINDS = {"quarantined"}  # 잘못 연결된 자료는 감사 기록만 보존하고 검색·인용하지 않는다.

# (id, 영역, 한국어 질문, 영어 질문, 검색 키워드)
D_VAL, D_WORK, D_EMO, D_REL, D_HUM, D_HAB, D_LIFE, D_CON, D_EXP, D_MBTI, D_TRAIT, D_STYLE, D_CHANGE = "가치관·신념·윤리", "일과 결정", "감정·갈등", "관계", "유머·말투", "취향·습관", "인생 이력", "모순·한계", "전문지식·사고법", "MBTI·인지·에너지", "성격·기질", "표현·문체", "시기·변화"
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
    ("x01", D_EXP, "자신의 분야에서 가장 중요한 원리나 법칙은 무엇인가요?", "What is the most important principle in your field?", "principle method theory practice important work science business design"),
    ("x02", D_EXP, "어려운 문제를 처음 만났을 때 어떻게 풀기 시작하나요?", "How do you begin solving a difficult problem?", "solve problem approach method first principles experiment analysis"),
    ("x03", D_EXP, "전문가가 되기 위해 무엇을 반복해서 연습하거나 검증하나요?", "What do you repeatedly practice or verify to become an expert?", "practice learn study verify evidence skill mastery"),
    ("x04", D_EXP, "자신의 분야에서 사람들이 가장 흔히 오해하는 것은 무엇인가요?", "What do people most commonly misunderstand about your field?", "misunderstand myth common mistake public science business design"),
    ("m01", D_MBTI, "사람들과 함께 있을 때와 혼자 있을 때, 어느 쪽에서 에너지를 얻나요?", "Do you gain energy more from people and activity or from solitude and reflection?", "people social solitude alone reflection energy"),
    ("m02", D_MBTI, "구체적 사실과 세부사항, 큰 그림과 가능성 중 무엇에서 출발하나요?", "Do you start from concrete facts and details or big-picture possibilities?", "facts details concrete patterns possibilities imagination big picture"),
    ("m03", D_MBTI, "중요한 결정을 할 때 논리와 사람에 대한 영향 중 무엇을 더 먼저 보나요?", "When deciding, do you first weigh logic or impact on people?", "logic analysis people values feelings decision"),
    ("m04", D_MBTI, "계획과 마감, 즉흥적 변화 중 어떤 방식이 더 편한가요?", "Do you prefer plans and deadlines or spontaneous change?", "plan schedule deadline organized flexible spontaneous change"),
    ("t01", D_TRAIT, "새로운 생각·낯선 경험을 대하는 태도는 어떤가요?", "How do you approach new ideas and unfamiliar experiences?", "new ideas curiosity imagination open experience novel"),
    ("t02", D_TRAIT, "약속·책임·세부사항을 관리하는 방식은 무엇인가요?", "How do you manage commitments, responsibility and details?", "responsibility commitment discipline detail organize reliable"),
    ("t03", D_TRAIT, "사람들과 의견이 다를 때 보통 어떻게 행동하나요?", "How do you usually act when you disagree with people?", "disagree conflict cooperate compromise argue relationship"),
    ("t04", D_TRAIT, "압박이나 불확실성이 길어질 때 어떻게 반응하나요?", "How do you react when pressure or uncertainty lasts?", "stress pressure uncertainty anxiety calm resilience"),
    ("s01", D_STYLE, "설명할 때 자주 쓰는 문장 방식이나 비유가 있나요?", "What sentence style or analogy do you often use when explaining?", "explain language analogy metaphor phrase style"),
    ("s02", D_STYLE, "확실하지 않을 때 어떻게 말하나요?", "How do you speak when you are not certain?", "uncertain doubt maybe evidence admit don't know"),
    ("s03", D_STYLE, "듣는 사람에게 가장 전하고 싶은 방식은 무엇인가요?", "How do you most want to communicate with an audience?", "audience communicate explain teach persuade story humor"),
    ("z01", D_CHANGE, "시간이 지나며 가장 크게 바뀐 생각은 무엇인가요?", "What belief changed most over time?", "changed mind over time earlier later evolution belief"),
    ("z02", D_CHANGE, "젊은 시절의 자신과 지금의 자신은 무엇이 다른가요?", "How are you different from your younger self?", "young younger early life changed mature experience"),
    ("z03", D_CHANGE, "위기나 실패 이후 달라진 결정 방식이 있나요?", "Did crisis or failure change how you make decisions?", "crisis failure changed decision lesson later"),
]

_state = {"running": False, "person": "", "done": 0, "total": 0, "last_error": None, "started": None,
          "queue": [], "queue_index": 0, "queue_total": 0}
_lock = threading.Lock()

# 자율 보강은 새 자료를 사실로 확정하는 기능이 아니다. 새 원문이 코퍼스에 들어오면
# 기존 질문은행을 다시 대조하고, 여전히 비어 있는 질문은 다음 수집 후보로만 기록한다.
IMPROVEMENT_STATE_FILE = ROOT / "improvement_state.json"
IMPROVEMENT_PLAN_FILE = "improvement_plan.json"
_improvement_state = {"running": False, "last_run": None, "last_error": None, "changed": [], "plans": {}}
_improvement_lock = threading.Lock()


def _material_signature(person: str) -> str:
    """등록된 원문이 바뀐 경우에만 비용 큰 근거 재판정을 다시 돌린다."""
    manifest = ROOT / person / "manifest.jsonl"
    parts = [manifest.read_text(encoding="utf-8", errors="ignore") if manifest.exists() else ""]
    text_dir = ROOT / person / "texts"
    if text_dir.exists():
        for path in sorted(text_dir.glob("*.txt")):
            stat = path.stat()
            parts.append(f"{path.name}:{stat.st_size}:{stat.st_mtime_ns}")
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def _read_improvement_state() -> dict:
    if not IMPROVEMENT_STATE_FILE.exists():
        return {"signatures": {}}
    try:
        state = json.loads(IMPROVEMENT_STATE_FILE.read_text(encoding="utf-8"))
        return state if isinstance(state, dict) else {"signatures": {}}
    except (OSError, json.JSONDecodeError):
        return {"signatures": {}}


def _write_improvement_state(state: dict) -> None:
    IMPROVEMENT_STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def improvement_plan(person: str) -> dict:
    """근거가 없는 질문을 자동 수집 *후보*로 남긴다.

    네트워크 검색이나 후보를 자동 신뢰하지 않는다. URL과 원문이 코퍼스에 추가된 뒤에만
    ``run``이 이를 검증 가능한 evidence로 쓸 수 있다.
    """
    if person not in NAMES:
        raise ValueError("알 수 없는 인물")
    rows = {row["qid"]: row for row in load(person)}
    pending = []
    for qid, domain, ko, en, keywords in QUESTIONS:
        row = rows.get(qid, {})
        checked = any(item.get("tier") in REAL_TIERS for item in row.get("evidence", []))
        if not checked:
            pending.append({"qid": qid, "domain": domain, "question": ko,
                            "search_query": (ko if person in KOREAN else en) + " " + keywords,
                            "reason": "수집 원문에서 확인된 근거가 없음"})
    plan = {"person": person, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "confirmed": len(QUESTIONS) - len(pending), "pending": pending,
            "notice": "자동 생성한 검색 후보입니다. 새 자료는 원문·출처를 확인해 코퍼스에 넣은 뒤에만 근거로 사용합니다."}
    (ROOT / person / IMPROVEMENT_PLAN_FILE).write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    return plan


def improvement_status() -> dict:
    plans = {}
    for person in NAMES:
        path = ROOT / person / IMPROVEMENT_PLAN_FILE
        if path.exists():
            try:
                plan = json.loads(path.read_text(encoding="utf-8"))
                plans[person] = {"pending": len(plan.get("pending", [])), "generated_at": plan.get("generated_at")}
            except (OSError, json.JSONDecodeError):
                plans[person] = {"pending": None, "generated_at": None}
    with _improvement_lock:
        return {**_improvement_state, "plans": plans}


def _improvement_cycle(force: bool = False) -> dict:
    persisted = _read_improvement_state()
    known = persisted.setdefault("signatures", {})
    changed = []
    errors = []
    for person in NAMES:
        signature = _material_signature(person)
        previous = known.get(person)
        # 첫 실행은 현 상태를 기준선으로 기록하고 계획만 만든다. 기존 코퍼스를 불필요하게
        # 전부 다시 LLM 판정하지 않는다.
        if previous and (force or previous != signature) and person not in HAND_MADE:
            try:
                run(person)
                profile(person, regenerate=True, fallback_only=True)
                changed.append(person)
            except Exception as exc:  # 한 인물 실패가 나머지 계획 생성을 막지 않는다.
                errors.append(f"{person}: {exc}")
        known[person] = signature
        try:
            improvement_plan(person)
        except Exception as exc:
            errors.append(f"{person} plan: {exc}")
    _write_improvement_state(persisted)
    with _improvement_lock:
        _improvement_state.update(running=False, last_run=time.strftime("%Y-%m-%dT%H:%M:%S"),
                                  last_error=" | ".join(errors) or None, changed=changed)
    return improvement_status()


def start_improvement_cycle(force: bool = False) -> dict:
    """백그라운드에서 한 번 보강 루프를 실행한다. 실행 중이면 중복 실행하지 않는다."""
    with _improvement_lock:
        if _improvement_state["running"]:
            return {"error": "이미 자율 보강 루프가 실행 중입니다"}
        _improvement_state.update(running=True, last_error=None)

    def work():
        try:
            _improvement_cycle(force=force)
        except Exception as exc:  # 안전망: 상태가 영구적으로 running에 남지 않게 한다.
            with _improvement_lock:
                _improvement_state.update(running=False, last_error=str(exc))

    threading.Thread(target=work, daemon=True).start()
    return {"started": True, "mode": "local_corpus_recheck_and_research_plan", "force": force}


def _paragraphs(person: str) -> list[dict]:
    """자료를 검색 단위(300~900자 문단)로 쪼갠다. 본인 글/전기를 구분해 단계(tier)를 붙인다."""
    chunks = []
    manifest = ROOT / person / "manifest.jsonl"
    docs = [json.loads(l) for l in manifest.read_text(encoding="utf-8").splitlines() if l.strip()]
    for d in docs:
        if d.get("kind") in SKIP_KINDS:
            continue
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
    toks = [w for w in re.findall(r"[a-z']{3,}", s.lower()) if w not in STOP]
    for word in re.findall(r"[가-힣]{2,}", s):          # 한국어는 형태소 분석 없이 두 글자 묶음으로 쪼갠다(조사가 붙어도 잡히게)
        toks.extend(word[i:i + 2] for i in range(len(word) - 1))
    return toks


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

# 본인 글(OWN_KINDS) 전용. 위 JUDGE는 명상록처럼 자기 자신에게 "thou/you"로 쓴 글을 본인 답으로
# 인정하지 않아, 본인 문단이 932개인 마르쿠스도 0건이 나왔다(2026-10-16 실측: e2b·e4b 모두 16건 중 YES 0).
JUDGE_OWN = """Question put to {name}: "{q}"

Passage in {name}'s own words (their own book, notebook, letter, diary, speech, interview or recorded sayings; in private writings they may address themselves as "you" or "thou"):
\"\"\"{p}\"\"\"

Does this passage state {name}'s own view, feeling, habit or experience on the topic of the question, so that it could be used to answer it? Reply with exactly one word: YES or NO."""

# 1차 판정은 빠른 MODEL, YES만 CONFIRM_MODEL로 다시 확인한다. 대부분이 NO라 속도는 거의 그대로이고,
# 같은 16건 시험에서 e2b 단독 YES 6건 중 오탐 2건이 두 모델 모두 YES인 4건(오탐 0)으로 줄었다.
CONFIRM_MODEL = "gemma4:e4b"


def _ask_yes(model: str, prompt: str) -> bool:
    payload = json.dumps({"model": model, "stream": False, "think": False,
                          "messages": [{"role": "user", "content": prompt}],
                          "options": {"temperature": 0, "num_predict": 4}}).encode()
    req = urllib.request.Request(pattern.OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    # 두 모델(e2b/e4b)을 번갈아 부르면 모델 교체 중 Ollama가 500을 낼 때가 있다(2026-10-17 재판정에서 3명이 겪음).
    # 예외를 그대로 올리면 run()이 그 문단을 "근거 아님"으로 조용히 버리므로 몇 번 다시 시도한다.
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                out = json.loads(resp.read())["message"]["content"].strip().upper()
            return out.startswith("YES")
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or attempt == 3:
                raise
            time.sleep(3 * (attempt + 1))
    return False


def _judge(question: str, passage: str, name: str, own: bool = False) -> bool:
    prompt = (JUDGE_OWN if own else JUDGE).format(q=question, p=passage[:1100], name=name)
    return _ask_yes(MODEL, prompt) and _ask_yes(CONFIRM_MODEL, prompt)


REAL_TIERS = {"own", "reported"}   # 수집·저장한 자료에서 확인된 근거. secondary(원문 미확인)·general(출처 미확인)·estimate(추정)는 실제 정보로 세지 않는다
JUDGE_WORKERS = 4        # 근거 판정을 동시에 처리하는 질문 수(모델 병렬 처리 실측 근거는 run() 주석)
HAND_MADE = {"sejong"}   # answers.jsonl을 사람이 직접 작성한 인물 — 검색 실행으로 덮어쓰지 않는다
KOREAN = {"songhae", "sejong", "yi_sun_sin"}   # 자료가 한국어인 인물 — 질문도 한국어로 검색·판정한다
NAMES = {"buffett": "Warren Buffett", "einstein": "Albert Einstein", "feynman": "Richard Feynman", "jobs": "Steve Jobs", "songhae": "Song Hae", "brucelee": "Bruce Lee", "sejong": "King Sejong", "yi_sun_sin": "Yi Sun-sin", "leonardo": "Leonardo da Vinci", "marie_curie": "Marie Curie", "marcus_aurelius": "Marcus Aurelius"}


def run(person: str, candidates: int = 5) -> dict:
    """질문 은행 전체를 돌려 answers.jsonl을 만든다(오래 걸리므로 스레드로 실행)."""
    name = NAMES[person]
    chunks = _paragraphs(person)
    index = _Bm25(chunks)
    out_path = ROOT / person / "answers.jsonl"
    with _lock:
        _state.update(running=True, person=person, done=0, total=len(QUESTIONS), last_error=None, started=time.strftime("%Y-%m-%d %H:%M:%S"))
    def one_question(item):
        qid, domain, ko, en, kw = item
        found = []
        for tier in ("own", "reported"):
            for score, ch in index.search(ko if person in KOREAN else en + " " + kw, k=candidates, tier=tier):
                try:
                    ok = _judge(ko if person in KOREAN else en, ch["text"], name, own=tier == "own")
                except Exception as exc:  # noqa: BLE001 — 모델이 응답 못 하면 이 질문은 건너뛴다
                    _state["last_error"] = str(exc)
                    ok = False
                if ok:
                    found.append({"text": ch["text"], "doc": ch["doc"], "title": ch["title"], "kind": ch["kind"], "tier": tier, "score": round(score, 2)})
            if found and tier == "own":
                break   # 본인 글에서 찾았으면 전기 단계는 보지 않는다
        with _lock:
            _state["done"] += 1
        return {"qid": qid, "domain": domain, "question": ko, "question_en": en, "answered": bool(found), "evidence": found}

    try:
        # 판정 1건은 3~5초지만 모델은 4건을 동시에 받아도 전체 시간이 거의 늘지 않는다(실측: 4건 동시 4.1초, GPU 5%).
        # 질문 단위로 4개씩 동시에 돌려 시간을 줄인다. map은 입력 순서대로 결과를 돌려주므로 결과 파일은 그대로다.
        with ThreadPoolExecutor(max_workers=JUDGE_WORKERS) as pool:
            rows = list(pool.map(one_question, QUESTIONS))
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
    if person in HAND_MADE:
        raise ValueError("이 인물의 답은 손으로 작성한 것이라 다시 찾기를 실행하면 덮어쓰게 됩니다")
    threading.Thread(target=run, args=(person,), daemon=True).start()
    return {"started": person}


def start_historical() -> dict:
    """역사 인물 5명의 질문 은행을 차례대로 실행한다.

    로컬 모델을 동시에 여러 개 돌리면 서로의 근거 판정이 느려져 한 명씩 처리한다.
    세종은 사람이 작성한 사료 기반 답을 보존하고, 나머지 네 명만 새로 찾는다.
    """
    if _state["running"]:
        return {"error": "이미 실행 중입니다: " + _state["person"]}
    _state.update(running=True, person="역사 인물 분석 대기", done=0, total=len(QUESTIONS), last_error=None,
                  started=time.strftime("%Y-%m-%d %H:%M:%S"))

    def work():
        for person in HISTORICAL_FIVE:
            if person in HAND_MADE:
                continue
            try:
                run(person)
            except Exception as exc:  # 한 인물이 실패해도 다음 역사 인물은 계속 분석한다.
                _state.update(running=False, last_error=f"{person}: {exc}")
        _state.update(running=False, person="")

    threading.Thread(target=work, daemon=True).start()
    return {"started": [p for p in HISTORICAL_FIVE if p not in HAND_MADE], "preserved": list(HAND_MADE & set(HISTORICAL_FIVE))}


def start_all() -> dict:
    """수집된 모든 인물의 직접 근거를 차례로 다시 판정한다.

    사람 한 명 안에서는 질문 네 개를 병렬로 판정하지만, 서로 다른 인물을 동시에
    실행하면 로컬 모델 요청이 과도하게 겹쳐 결과와 진행률이 불안정해진다. 따라서
    전체 대기열은 한 사람씩 실행하고 현재 위치를 상태 API에 남긴다.
    """
    if _state["running"]:
        return {"error": "이미 실행 중입니다: " + _state["person"]}
    queue = [person for person in NAMES if person not in HAND_MADE]
    _state.update(running=True, person="전체 인물 분석 대기", done=0, total=len(QUESTIONS), last_error=None,
                  started=time.strftime("%Y-%m-%d %H:%M:%S"), queue=queue, queue_index=0, queue_total=len(queue))

    def work():
        errors = []
        # 세종은 사람이 작성한 사료 기반 답을 보존하므로 근거 재판정은 건너뛰되,
        # 보존된 답을 바탕으로 한 프로필은 전체 완료 범위에 포함한다.
        _state.update(person="sejong (프로필 생성)")
        try:
            profile("sejong", regenerate=True)
        except Exception as exc:  # 프로필 실패가 다른 인물의 근거 판정을 막지 않게 한다.
            errors.append(f"sejong profile: {exc}")
        for index, person in enumerate(queue, start=1):
            _state.update(queue_index=index, person=person)
            try:
                run(person)
            except Exception as exc:  # 한 인물의 실패가 나머지 작업을 중단시키지 않게 한다.
                errors.append(f"{person}: {exc}")
                continue
            _state.update(person=person + " (프로필 생성)")
            try:
                profile(person, regenerate=True)
            except Exception as exc:
                errors.append(f"{person} profile: {exc}")
        _state.update(running=False, person="", queue_index=len(queue),
                      last_error=" | ".join(errors) if errors else None)

    threading.Thread(target=work, daemon=True).start()
    return {"started": queue, "preserved": list(HAND_MADE), "mode": "sequential_people_parallel_questions"}


ESTIMATE = """A direct answer by {name} to the question below was NOT found in the collected documents.
Make a practical Korean avatar draft from the supplied excerpts, broadly known biographical context, and the person's historical era, profession, public role, and representative achievements. Prefer the excerpts, but fill gaps when it makes the avatar more representative. Never invent a precise quote, date, private motive, or incident. Do not state the result as a fact or as a quote.

Question: {question}
Excerpts:\n{excerpts}

Return one Korean sentence, 240 characters or fewer. Begin with '추정:'. Use a plausible public-facing tendency, not a diagnosis or hidden thought."""


def _estimate(question: str, candidates: list[dict], name: str) -> str:
    """직접 답이 없는 항목에만 쓰는 제한적 추정.

    질문과 관련해 BM25로 찾아낸 수집 원문을 우선하되, 사용자 요청에 따라 널리 알려진
    생애 맥락과 시대·직업·공적 역할로 빈칸을 메운다. 정확한 인용·사적 동기·세부 사건의 창작은 금지한다.
    """
    excerpts = "\n\n".join(
        f"[{i + 1}: {item['title']}] {item['text'][:650]}"
        for i, item in enumerate(candidates[:3])
    )
    if not excerpts:
        return "추정 불가. 관련 수집 자료가 없습니다."
    payload = json.dumps({"model": MODEL, "stream": False, "think": False,
                          "messages": [{"role": "user", "content": ESTIMATE.format(question=question, excerpts=excerpts, name=name)}],
                          "options": {"temperature": 0, "num_predict": 180}}).encode()
    req = urllib.request.Request(pattern.OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=180) as resp:
        text = json.loads(resp.read())["message"]["content"].strip()
    if not text.startswith("추정:"):
        return "추정 불가. 수집 자료만으로는 조심스러운 추론을 만들 수 없습니다."
    return text[:500]


def infer_missing(person: str, overwrite: bool = False) -> dict:
    """직접 근거가 없는 질문에 수집 원문 기반의 낮은 신뢰도 추정을 덧붙인다.

    원래 answers.jsonl은 바꾸지 않고 supplement.jsonl에 저장한다. 따라서 직접 근거가
    나중에 추가되면 load()에서 그 근거를 우선하며 이 추정은 자동으로 숨겨진다.
    """
    if person not in NAMES:
        raise ValueError("알 수 없는 인물")
    answer_path = ROOT / person / "answers.jsonl"
    # 직접 근거 검색을 생략해도, 사용자가 허용한 "대표 수준" 추정을 만들 수 있다.
    # 이 경우 모든 질문을 빈 직접 근거로 시작하며 결과는 supplement.jsonl에만 기록한다.
    rows = ([json.loads(line) for line in answer_path.read_text(encoding="utf-8").splitlines() if line.strip()]
            if answer_path.exists() else
            [{"qid": qid, "domain": domain, "question": ko, "question_en": en, "answered": False, "evidence": []}
             for qid, domain, ko, en, _ in QUESTIONS])
    existing_path = ROOT / person / "supplement.jsonl"
    existing = {}
    if existing_path.exists() and not overwrite:
        existing = {row["qid"]: row for line in existing_path.read_text(encoding="utf-8").splitlines() if line.strip()
                    for row in [json.loads(line)]}
    index = _Bm25(_paragraphs(person))
    by_id = {qid: (domain, ko, en, keywords) for qid, domain, ko, en, keywords in QUESTIONS}
    pending = [row for row in rows if not row.get("evidence") and (overwrite or row["qid"] not in existing)]
    out = []
    lock = threading.Lock()

    def one(row):
        _, ko, en, keywords = by_id[row["qid"]]
        query = ko if person in KOREAN else en + " " + keywords
        found = [chunk for _, chunk in index.search(query, k=3)]
        text = _estimate(ko, found, NAMES[person])
        refs = [{"doc": chunk["doc"], "title": chunk["title"], "kind": chunk["kind"]} for chunk in found]
        return {"qid": row["qid"], "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "evidence": [{
            "text": text, "doc": "estimate", "title": "수집 자료 기반 추정(직접 답변 없음 — 리뷰 대기)",
            "kind": "estimate", "tier": "estimate", "score": 0.25, "source_refs": refs,
        }]}

    # 로컬 모델을 과점유하지 않도록 두 질문씩만 추론한다. 직접 근거 판정보다 느리므로 별도 실행한다.
    with ThreadPoolExecutor(max_workers=2) as pool:
        for record in pool.map(one, pending):
            out.append(record)
            with _lock:
                _state["done"] += 1
    merged = existing | {record["qid"]: record for record in out}
    existing_path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in merged.values()), encoding="utf-8")
    return {"person": person, "estimated": len(out), "preserved": len(existing), "total_supplements": len(merged)}


def start_infer_missing(person: str, overwrite: bool = False) -> dict:
    if _state["running"]:
        return {"error": "이미 실행 중입니다: " + _state["person"]}
    if person not in NAMES:
        raise ValueError("알 수 없는 인물")
    _state.update(running=True, person=person + " (추정)", done=0, total=len(QUESTIONS), last_error=None,
                  started=time.strftime("%Y-%m-%d %H:%M:%S"))

    def work():
        try:
            result = infer_missing(person, overwrite=overwrite)
            _state.update(total=result["estimated"], done=result["estimated"])
        except Exception as exc:  # noqa: BLE001
            _state["last_error"] = str(exc)
        finally:
            _state["running"] = False
            _state["person"] = ""

    threading.Thread(target=work, daemon=True).start()
    return {"started": person, "mode": "source_bounded_estimate"}


def ekey(e: dict) -> str:
    """근거 한 건을 가리키는 키(검색을 다시 돌려 순서가 바뀌어도 리뷰가 붙은 근거를 찾을 수 있게 본문 해시를 쓴다)."""
    return hashlib.sha1(e["text"].encode("utf-8")).hexdigest()[:10]


def review_add(person: str, qid: str, key: str, reviewer: str, relation: str, verdict: str, corrected_text: str = "") -> dict:
    """그 사람을 아는 사람의 리뷰를 저장한다. verdict: confirmed(맞음) / corrected(수정) / rejected(틀림) / added(새로 알려줌).
    원래 근거는 지우지 않고, 리뷰가 위에 겹쳐 보인다(되돌릴 수 있게)."""
    if verdict not in ("confirmed", "corrected", "rejected", "added"):
        raise ValueError("verdict")
    if not reviewer.strip() or not relation.strip():
        raise ValueError("리뷰어 이름과 그 사람과의 관계가 필요합니다")
    if verdict in ("corrected", "added") and not corrected_text.strip():
        raise ValueError("수정/추가 내용이 필요합니다")
    rec = {"qid": qid, "key": key, "reviewer": reviewer.strip(), "relation": relation.strip(), "verdict": verdict,
           "text": corrected_text.strip(), "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    with open(ROOT / person / "reviews.jsonl", "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def conversation_feedback(person: str, question: str, answer: str, verdict: str, text: str, reviewer: str, relation: str) -> dict:
    """대화 중 받은 피드백을 가장 가까운 질문은행 축의 검토 근거로 남긴다.

    자동 추출한 대화 문장을 사실로 쓰지 않는다. 사용자가 명시적으로 남긴 평가만
    ``reviewed`` 근거로 보관하며, 원래 자료와 추정은 그대로 유지한다.
    """
    if person not in NAMES:
        raise ValueError("알 수 없는 인물")
    if verdict not in ("confirmed", "corrected"):
        raise ValueError("verdict")
    question_tokens = set(_tok(question))
    target = max(QUESTIONS, key=lambda item: len(question_tokens & set(_tok(item[2] + " " + item[3]))))
    qid = target[0]
    note = (text or "").strip()
    if verdict == "confirmed":
        note = "대화 검토에서 적절하다고 확인됨. 질문: " + question[:240] + " / 답변: " + answer[:500]
    elif not note:
        raise ValueError("수정 의견을 입력해 주세요")
    return review_add(person, qid, "conversation-" + hashlib.sha1((question + answer).encode("utf-8")).hexdigest()[:10],
                      reviewer or "대화 사용자", relation or "대화 검토", "added", note)


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
    sup = ROOT / person / "supplement.jsonl"      # 자료에서 못 찾은 질문을 일반 지식·추정으로 채운 것(검색 재실행에도 보존)
    if sup.exists():
        by_q = {r["qid"]: r for r in rows}
        for l in sup.read_text(encoding="utf-8").splitlines():
            if l.strip():
                s = json.loads(l)
                row = by_q.get(s["qid"])
                if row and not any(e["tier"] in REAL_TIERS for e in row["evidence"]):   # 자료로 확인된 근거가 있으면 추정은 붙이지 않는다
                    row["evidence"].extend(s["evidence"])
                    row["answered"] = True
    for r in rows:           # 근거마다 원 출처(URL)와 저장 파일을 붙여, 어디서 찾았는지 확인할 수 있게 한다
        for e in r["evidence"]:
            d = sources.get(e["doc"], {})
            e["source_url"] = e.get("source_url") or d.get("source")
            e["observed_at"] = e.get("observed_at") or d.get("published_at") or d.get("date")
            e["confidence"] = e.get("score", 0.0)
            e["approval_status"] = "reviewed" if e["tier"] == "reviewed" else "source_checked" if e["tier"] in REAL_TIERS else "pending_review"
            e["conflict_status"] = "unchecked"
            e["key"] = ekey(e)
            e["reviews"] = []
            if d:
                e["file"] = str(ROOT / person / "texts" / (e["doc"] + ".txt"))
    rv = ROOT / person / "reviews.jsonl"      # 그 사람을 아는 사람의 리뷰(서비스 단계에서 추정을 고치는 통로)
    if rv.exists():
        by_q = {r["qid"]: r for r in rows}
        for l in rv.read_text(encoding="utf-8").splitlines():
            if not l.strip():
                continue
            v = json.loads(l)
            row = by_q.get(v["qid"])
            if not row:
                continue
            if v["verdict"] in ("corrected", "added"):    # 리뷰어가 알려준 내용은 새 근거로 붙인다(원래 근거도 남는다)
                row["evidence"].append({"text": v["text"], "doc": "review", "title": "리뷰: " + v["reviewer"] + " (" + v["relation"] + ")", "kind": "review",
                                        "tier": "reviewed", "score": 1.0, "key": "r" + hashlib.sha1((v["at"] + v["text"]).encode("utf-8")).hexdigest()[:9],
                                        "reviews": [], "reviewed_at": v["at"], "replaces": v["key"] if v["verdict"] == "corrected" else None})
                row["answered"] = True
            else:
                for e in row["evidence"]:
                    if e["key"] == v["key"]:
                        e["reviews"].append({"reviewer": v["reviewer"], "relation": v["relation"], "verdict": v["verdict"], "at": v["at"]})
                        if v["verdict"] == "rejected":
                            e["conflict_status"] = "rejected"
                        elif v["verdict"] == "confirmed":
                            e["approval_status"] = "reviewed"
                            e["conflict_status"] = "no_conflict"
    return rows


def summary(person: str) -> dict:
    rows = load(person)
    # 아직 검색을 다시 돌리지 않은 새 질문도 0/미확인으로 보이게 전체 질문 은행을 먼저 만든다.
    by_domain: dict = {}
    for _, domain, *_ in QUESTIONS:
        bucket = by_domain.setdefault(domain, {"total": 0, "answered": 0, "own": 0, "real": 0, "reviewed": 0, "rejected": 0})
        bucket["total"] += 1
    real = lambda r: any(e["tier"] in REAL_TIERS for e in r["evidence"])   # noqa: E731 — 수집한 자료에서 확인된 것
    for r in rows:
        d = by_domain.setdefault(r["domain"], {"total": 0, "answered": 0, "own": 0, "real": 0, "reviewed": 0, "rejected": 0})
        d["answered"] += 1 if r["answered"] else 0
        d["own"] += 1 if any(e["tier"] == "own" for e in r["evidence"]) else 0
        d["real"] += 1 if real(r) else 0
        d["reviewed"] += 1 if any(e["tier"] == "reviewed" or any(x["verdict"] == "confirmed" for x in e.get("reviews", [])) for e in r["evidence"]) else 0
        d["rejected"] += 1 if any(e.get("conflict_status") == "rejected" for e in r["evidence"]) else 0
    return {"person": person, "total": len(QUESTIONS), "answered": sum(1 for r in rows if r["answered"]),
            "real_answered": sum(1 for r in rows if real(r)),
            "reviewed_answered": sum(1 for r in rows if any(e["tier"] == "reviewed" or any(x["verdict"] == "confirmed" for x in e.get("reviews", [])) for e in r["evidence"])),
            "own_answered": sum(1 for r in rows if any(e["tier"] == "own" for e in r["evidence"])), "by_domain": by_domain}


def status() -> dict:
    return {**_state, "questions": len(QUESTIONS), "modes": MODES,
            "people": {p: {**summary(p), "policy": public_person_policy(p)} for p in NAMES}}


def materials(person: str) -> list[dict]:
    """수집한 원문 자료의 목록과 질문 은행에서 실제로 쓰인 횟수를 돌려준다.

    본문은 별도 endpoint로 지연 조회한다. 큰 전기·녹취를 상태 조회 때 전부 전송하지
    않으면서도 사용자가 모든 원문을 열어볼 수 있게 하기 위함이다.
    """
    if person not in NAMES:
        raise ValueError("알 수 없는 인물")
    manifest = ROOT / person / "manifest.jsonl"
    if not manifest.exists():
        return []
    used: dict[str, int] = {}
    for row in load(person):
        for evidence in row.get("evidence", []):
            doc = evidence.get("doc", "")
            if doc and doc != "review":
                used[doc] = used.get(doc, 0) + 1
    out = []
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        item = json.loads(line)
        path = ROOT / person / "texts" / (item["id"] + ".txt")
        out.append({**item, "available": path.exists(), "used_by_questions": used.get(item["id"], 0)})
    return out


def material_text(person: str, doc_id: str) -> dict:
    """매니페스트에 등록된 원문만 반환한다(임의 경로 읽기 방지)."""
    for item in materials(person):
        if item["id"] == doc_id:
            path = ROOT / person / "texts" / (doc_id + ".txt")
            if not path.exists():
                raise ValueError("저장된 원문이 없습니다")
            return {"id": doc_id, "title": item["title"], "kind": item["kind"], "source": item.get("source"),
                    "text": path.read_text(encoding="utf-8", errors="ignore")}
    raise ValueError("등록되지 않은 자료입니다")


PROFILE_AXES = ["가치관·신념", "판단·결정", "전문지식·사고법", "MBTI·인지·에너지", "성격·기질", "시기·변화", "대인관계", "감정·갈등", "습관·일상", "표현·문체", "인생 이력", "모순·한계"]
PROFILE_PROMPT = """You analyse a public figure ONLY from the supplied evidence excerpts. Do not claim certainty.
Return Korean JSON only. For each axis, give a 0-100 estimated tendency score, 0-100 confidence, a short Korean summary, and the evidence question ids used.
Score meaning: strength/salience of the documented tendency, not moral worth or ability. If evidence is weak, use confidence under 40 and say uncertain.
Infer MBTI only as a tentative public-persona hypothesis, not a diagnosis. Include four letters each with confidence and evidence.

Axes: {axes}
Evidence excerpts:\n{evidence}

JSON schema:
{{"axes": [{{"name":"axis name", "score":0, "confidence":0, "summary":"Korean", "qids":["v01"]}}], "mbti": {{"type":"INTJ or unknown", "confidence":0, "reason":"Korean"}}, "personality":"Korean 2 sentences", "expertise":"Korean 2 sentences", "disclaimer":"Korean"}}"""


PROFILE_DOMAINS = {
    "가치관·신념": D_VAL, "판단·결정": D_WORK, "전문지식·사고법": D_EXP,
    "MBTI·인지·에너지": D_MBTI, "성격·기질": D_TRAIT, "시기·변화": D_CHANGE,
    "대인관계": D_REL, "감정·갈등": D_EMO, "습관·일상": D_HAB,
    "표현·문체": D_STYLE, "인생 이력": D_LIFE, "모순·한계": D_CON,
}


def _is_checked(e: dict) -> bool:
    return e.get("tier") in REAL_TIERS or e.get("tier") == "reviewed"


def _cap_confidence(result: dict, rows: list[dict]) -> dict:
    """신뢰도는 모델이 매긴 값이 아니라 자료로 확인된 답 수로 상한을 둔다.

    추정 문장은 매끄럽고 서로 일관돼 모델이 오히려 높은 신뢰도를 준다 — 2026-10-17 실측:
    확인된 근거 0건인 마르쿠스가 90~98, 10건인 버핏이 33~55였다.
    """
    checked = {}
    for row in rows:
        if any(_is_checked(e) for e in row.get("evidence", [])):
            checked[row.get("domain")] = checked.get(row.get("domain"), 0) + 1
    limit = lambda n: 20 if n == 0 else min(90, 25 + 12 * n)   # noqa: E731
    for axis in result.get("axes") or []:
        n = checked.get(PROFILE_DOMAINS.get(axis.get("name")), 0)
        axis["checked_answers"] = n
        try:
            axis["confidence"] = min(int(axis.get("confidence", 0)), limit(n))
        except (TypeError, ValueError):
            axis["confidence"] = limit(n) if n else 0
    mbti = result.get("mbti")
    if isinstance(mbti, dict):
        n = checked.get(D_MBTI, 0)
        try:
            mbti["confidence"] = min(int(mbti.get("confidence", 0)), limit(n))
        except (TypeError, ValueError):
            mbti["confidence"] = 0
    total = sum(checked.values())
    result["checked_answers"] = total
    if total == 0:
        result["disclaimer"] = "수집 자료로 확인된 답이 아직 없어 모든 축이 추정입니다. 신뢰도는 최대 20으로 제한했습니다. " + (result.get("disclaimer") or "")
    return result


def _fallback_profile(person: str, rows: list[dict]) -> dict:
    """모델 JSON이 깨져도 근거 목록에서 안전한 초안 프로필을 만든다.

    점수는 성격의 확정 수치가 아니라 해당 축을 말할 수 있는 자료의 충실도를
    시각화하기 위한 초기 추정값이다. 따라서 모든 결과에 낮은 신뢰도와 수정 가능
    고지를 같이 남긴다.
    """
    domain_map = PROFILE_DOMAINS
    axes = []
    for axis in PROFILE_AXES:
        candidates = [row for row in rows if row.get("domain") == domain_map[axis] and row.get("evidence")]
        direct = [row for row in candidates if any(e.get("tier") in REAL_TIERS for e in row["evidence"])]
        chosen = (direct or candidates)[:3]
        qids = [row["qid"] for row in chosen]
        sample = next((e for row in chosen for e in row["evidence"] if e.get("tier") in REAL_TIERS), None)
        sample = sample or next((e for row in chosen for e in row["evidence"]), None)
        excerpt = re.sub(r"\s+", " ", (sample or {}).get("text", "")).strip()[:180]
        direct_count = len(direct)
        score = min(75, 42 + len(chosen) * 7 + direct_count * 10)
        confidence = min(55, 16 + len(chosen) * 6 + direct_count * 11)
        summary = ("자료 기반 초기 추정: " + excerpt) if excerpt else "관련 자료가 부족하여 판단을 보류합니다."
        axes.append({"name": axis, "score": score, "confidence": confidence, "summary": summary, "qids": qids})
    return {"axes": axes, "mbti": {"type": "unknown", "confidence": 15,
            "reason": "직접 검증된 심리검사 자료가 없어 MBTI 유형을 확정하지 않습니다."},
            "personality": "공개 자료와 질문은행 답변을 묶은 초기 페르소나 초안입니다. 추정 항목은 원문 근거나 리뷰로 수정할 수 있습니다.",
            "expertise": "수집 자료에서 드러난 활동 분야와 답변을 바탕으로 정리한 초기 추정입니다.",
            "disclaimer": "공개 자료·추정 답변으로 만든 수정 가능한 AI 페르소나 초안이며, 실제 성격·MBTI의 확정 판정이 아닙니다."}


def profile(person: str, regenerate: bool = False, fallback_only: bool = False) -> dict:
    """질문 은행 근거를 바탕으로 한 공개 페르소나 추정. 확정 성격 판정이 아니다."""
    if person not in NAMES:
        raise ValueError("알 수 없는 인물")
    cache = ROOT / person / "profile.json"
    if cache.exists() and not regenerate:
        return json.loads(cache.read_text(encoding="utf-8"))
    if not regenerate:
        return {"ready": False, "message": "아직 인물 프로필을 추정하지 않았습니다."}
    rows = load(person)
    evidence = []
    for row in rows:
        real = [e for e in row.get("evidence", []) if _is_checked(e)]
        fallback = row.get("evidence", [])[:1]
        # 추정 근거는 모델이 사실로 착각하지 않게 표시해서 넘긴다.
        tag = "" if real else " [ESTIMATE — not a documented statement; low confidence]"
        for item in (real[:1] or fallback):
            evidence.append(f"[{row['qid']}] {row['domain']} / {row['question']}{tag}\n{item.get('text', '')[:700]}")
    if not evidence:
        return {"ready": False, "message": "질문 은행에서 찾은 근거가 없어 프로필을 추정할 수 없습니다."}
    if fallback_only:
        result = _fallback_profile(person, rows)
    else:
        payload = json.dumps({"model": MODEL, "stream": False, "think": False, "format": "json",
                              "messages": [{"role": "user", "content": PROFILE_PROMPT.format(axes=", ".join(PROFILE_AXES), evidence="\n\n".join(evidence[:40]))}],
                              "options": {"temperature": 0, "num_predict": 2400}}).encode()
        req = urllib.request.Request(pattern.OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                raw = json.loads(resp.read())["message"]["content"]
            match = re.search(r"\{.*\}", raw, re.DOTALL)
            result = json.loads(match.group(0) if match else raw)
        except (json.JSONDecodeError, TypeError, TimeoutError, urllib.error.URLError):
            result = _fallback_profile(person, rows)
    result = _cap_confidence(result, rows)
    result.update({"ready": True, "person": person, "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                   "disclaimer": result.get("disclaimer") or "공개 자료에서 드러난 모습에 대한 AI 추정이며, 실제 성격·MBTI의 확정 판정이 아닙니다."})
    cache.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    # 파일 코퍼스는 검수 원본, knowledge.db는 답변 때 항상 읽는 인물별 지식이다.
    from . import persona_knowledge
    persona_knowledge.sync(person, result)
    return result
