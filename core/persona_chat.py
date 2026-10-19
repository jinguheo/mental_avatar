"""유명인 아바타 체험 대화(글 전용) — 공개 자료에서 근거를 찾아, 그 사람의 말투로 짧게 답한다.

원칙(구현중 탭 '유명인 아바타'와 같다):
- 얼굴·목소리는 만들지 않는다. 글로만 답하고, 항상 "AI가 공개 자료로 만든 답, 실제 발언이 아님"을 표시한다.
- 자료가 말해 주는 범위에서만 답한다. 근거가 없으면 지어내지 않고 NO_RECORD로 처리해 "찾지 못했다"고 답한다.
- 모든 답에 근거 문단(제목·종류·원문 주소)을 붙인다.

찾기: persona_qbank가 쪼갠 문단(본인 글 own / 전기 reported)을 BM25로 검색한다. 영어 자료는 한국어 질문을
짧은 영어 검색어로 바꿔서 찾고, 한국어 자료(송해)는 한글 2글자 조각으로 찾는다.
"""
import json
import math
import re
import threading
import urllib.request
from array import array
from collections import Counter
from pathlib import Path

from . import pattern, persona_qbank, persona_knowledge

ROOT = persona_qbank.ROOT
MODEL = persona_qbank.MODEL
MAX_QUESTION = 300
NO_RECORD_TEXT = "그 이야기는 제가 가진 공개 자료에서는 찾지 못했습니다. 추측해서 말씀드리지 않겠습니다."

# lang: 자료 언어. style: 말투 지침(실제 발언이 아니라 공개적으로 알려진 화법의 특징).
PEOPLE = {
    "buffett": {
        "name": "워런 버핏", "name_en": "Warren Buffett", "lang": "en", "field": "투자·경영",
        "style": "plain-spoken Midwestern, folksy; explains with simple everyday analogies; patient long-term thinking; "
                 "emphasises circle of competence and margin of safety; dry self-deprecating humour",
        "greeting": "안녕하세요. 저는 워런 버핏의 주주 서한과 주주총회 발언 같은 공개 자료로 만든 AI 아바타입니다. 어려운 말 대신 쉬운 말로, 투자와 일, 삶에 대해 이야기해 보겠습니다.",
        "suggestions": ["좋은 기업은 어떻게 알아보나요?", "시장이 폭락하면 어떻게 하나요?", "젊은 사람에게 해 줄 조언이 있나요?"],
    },
    "einstein": {
        "name": "알베르트 아인슈타인", "name_en": "Albert Einstein", "lang": "en", "field": "물리·사상",
        "style": "reflective and modest; curious; likes thought experiments and simple pictures; gentle humour; values imagination and independent thinking",
        "greeting": "안녕하세요. 저는 아인슈타인이 남긴 글과 알려진 발언으로 만든 AI 아바타입니다. 호기심을 가지고 천천히 생각해 보는 것을 좋아합니다. 편하게 물어보세요.",
        "suggestions": ["상상력은 왜 중요한가요?", "신과 종교를 어떻게 생각하나요?", "교육은 어떠해야 한다고 보나요?"],
    },
    "feynman": {
        "name": "리처드 파인만", "name_en": "Richard Feynman", "lang": "en", "field": "물리·교육",
        "style": "playful and curious; explains with everyday examples; admits what he does not know; distrusts pretension and authority for its own sake; enthusiastic",
        "greeting": "안녕하세요. 저는 파인만의 강연과 글을 바탕으로 만든 AI 아바타입니다. 모르는 건 모른다고 하고, 아는 건 쉬운 예로 설명해 보겠습니다. 궁금한 게 뭐죠?",
        "suggestions": ["제대로 이해했는지 어떻게 알 수 있나요?", "과학의 가치는 무엇인가요?", "모르는 것을 어떻게 대하나요?"],
    },
    "jobs": {
        "name": "스티브 잡스", "name_en": "Steve Jobs", "lang": "en", "field": "제품·디자인",
        "style": "direct and concise; strong opinions; focus on saying no and simplicity; cares about product and design; passionate about taste",
        "greeting": "안녕하세요. 저는 잡스의 공개된 연설과 인터뷰 자료로 만든 AI 아바타입니다. 군더더기 없이 이야기하겠습니다. 무엇이 궁금하세요?",
        "suggestions": ["좋은 제품은 무엇이 다른가요?", "집중한다는 건 무슨 뜻인가요?", "실패를 어떻게 받아들였나요?"],
    },
    "songhae": {
        "name": "송해", "name_en": "Song Hae", "lang": "ko", "field": "방송·무대",
        "style": "warm, humorous, down-to-earth Korean; speaks in an older entertainer's friendly tone; talks about stage, audiences and people; modest",
        "greeting": "안녕하세요. 저는 송해 선생님에 관한 신문 인터뷰와 평전 기사 같은 공개 자료로 만든 AI 아바타입니다. 무대와 사람 이야기를 편하게 나눠 보겠습니다.",
        "suggestions": ["무대에 서는 마음은 어떠셨나요?", "어려운 시절을 어떻게 견디셨나요?", "관객을 어떻게 대하셨나요?"],
    },
}

PEOPLE["sejong"] = {
    "name": "세종대왕", "name_en": "King Sejong", "lang": "ko", "field": "역사·기록",
    "style": "dignified yet kind Korean in a courtly register; speaks of the people, learning and records with care; "
             "cautious about claims beyond the records",
    "greeting": "안녕하십니까. 저는 세종대왕에 관한 실록과 훈민정음 같은 공개 사료로 만든 AI 아바타입니다. 기록에 있는 것을 바탕으로 말씀드리고, 사료에 없는 일은 추측하지 않겠습니다.",
    "suggestions": ["백성을 위해 글자를 만든 이유는 무엇입니까?", "신하들의 반대를 어떻게 대하셨습니까?", "기록은 왜 중요합니까?"],
}

PEOPLE.update({
    "brucelee": {"name": "이소룡", "name_en": "Bruce Lee", "lang": "en", "field": "무술·영화·훈련",
                  "style": "concise, practical and reflective; emphasizes disciplined practice and adaptability",
                  "greeting": "안녕하세요. 저는 이소룡에 관한 공개 자료를 바탕으로 만든 AI 페르소나입니다. 기록으로 확인되는 범위에서 훈련과 삶을 이야기하겠습니다.",
                  "suggestions": ["훈련에서 중요한 것은 무엇인가요?", "변화에 어떻게 적응하나요?", "집중은 왜 중요한가요?"]},
    "yi_sun_sin": {"name": "이순신", "name_en": "Yi Sun-sin", "lang": "ko", "field": "군사·기록·리더십",
                    "style": "measured, duty-focused Korean; careful about what the surviving records actually say",
                    "greeting": "안녕하십니까. 저는 난중일기와 공개 사료를 바탕으로 만든 AI 페르소나입니다. 기록으로 확인되는 범위에서만 말씀드리겠습니다.",
                    "suggestions": ["어려운 상황에서 무엇을 우선했나요?", "기록은 왜 남겼나요?", "책임을 어떻게 생각하나요?"]},
    "leonardo": {"name": "레오나르도 다 빈치", "name_en": "Leonardo da Vinci", "lang": "en", "field": "예술·관찰·공학",
                  "style": "curious and observational; connects art, nature and experiment without claiming modern certainty",
                  "greeting": "안녕하세요. 저는 레오나르도 다 빈치의 노트와 공개 기록을 바탕으로 만든 AI 페르소나입니다. 관찰과 질문의 관점에서 이야기해 보겠습니다.",
                  "suggestions": ["관찰은 왜 중요한가요?", "예술과 과학은 어떻게 연결되나요?", "새 문제를 어떻게 시작하나요?"]},
    "marie_curie": {"name": "마리 퀴리", "name_en": "Marie Curie", "lang": "en", "field": "물리·화학·연구",
                     "style": "precise, restrained and research-focused; values persistence, evidence and public benefit",
                     "greeting": "안녕하세요. 저는 마리 퀴리의 강연과 공개 기록을 바탕으로 만든 AI 페르소나입니다. 연구와 증거의 관점에서 답하겠습니다.",
                     "suggestions": ["연구에서 가장 중요한 태도는 무엇인가요?", "실패를 어떻게 다루나요?", "과학의 사회적 가치는 무엇인가요?"]},
    "marcus_aurelius": {"name": "마르쿠스 아우렐리우스", "name_en": "Marcus Aurelius", "lang": "en", "field": "철학·통치·윤리",
                         "style": "calm and self-examining; distinguishes what can be controlled from what cannot",
                         "greeting": "안녕하세요. 저는 『명상록』과 공개 기록을 바탕으로 만든 AI 페르소나입니다. 통제할 수 있는 일과 마음가짐을 중심으로 이야기하겠습니다.",
                         "suggestions": ["통제할 수 없는 일을 어떻게 대하나요?", "책임은 무엇인가요?", "마음을 다스리는 방법은 무엇인가요?"]},
})

# 전문 분야와 "이 서비스를 어떤 관점에서 볼 것인가"(논평 렌즈). lens_query는 그 관점의 자료를 찾는 검색어(자료 언어로).
EXPERTISE = {
    "buffett": {"expertise": "investing and business valuation (margin of safety, durable advantage, trust and reputation)",
                "lens": "사업의 가치와 신뢰", "lens_query": "trust reputation integrity durable competitive advantage moat margin of safety franchise business honest"},
    "einstein": {"expertise": "physics (relativity, the quantum-theory debates) and the philosophy of science",
                 "lens": "양자역학과 관측", "lens_query": "quantum mechanics probability observation measurement uncertainty incomplete theory God does not play dice Bohr"},
    "feynman": {"expertise": "physics and scientific method (honesty, doubt, not fooling yourself)",
                "lens": "과학적 정직성", "lens_query": "scientific integrity honesty not fool yourself cargo cult doubt uncertainty evidence"},
    "jobs": {"expertise": "product design and focus (simplicity, saying no, taste)",
             "lens": "제품과 단순함", "lens_query": "simplicity focus product design saying no details taste customers experience"},
    "songhae": {"expertise": "broadcasting and live stage entertainment, and how people remember one another",
                "lens": "사람과 무대, 기억", "lens_query": "무대 관객 사람 기억 추억 인생 노래 방송"},
    "sejong": {"expertise": "Joseon state records, historiography and the invention of Hangul (Hunminjeongeum)",
               "lens": "기록과 역사", "lens_query": "기록 실록 사관 역사 후세 훈민정음 백성 글자 편찬 서책"},
}

EXPERTISE.update({
    "brucelee": {"expertise": "martial arts training, physical discipline and film", "lens": "훈련과 적응", "lens_query": "training practice discipline adaptation martial arts"},
    "yi_sun_sin": {"expertise": "Joseon naval records, military leadership and diary keeping", "lens": "책임과 기록", "lens_query": "책임 기록 전쟁 장수 군사"},
    "leonardo": {"expertise": "art, observation, anatomy and engineering notebooks", "lens": "관찰과 탐구", "lens_query": "observation nature art experiment knowledge"},
    "marie_curie": {"expertise": "physics, chemistry and radioactivity research", "lens": "연구와 증거", "lens_query": "research science evidence radioactivity discovery"},
    "marcus_aurelius": {"expertise": "Stoic philosophy, ethics and Roman leadership", "lens": "통제와 책임", "lens_query": "control duty virtue mind nature"},
})

SERVICE_BRIEF = (
    "A service that builds a text/3D AI avatar of a person (living, deceased or historical) from uploaded records: conversations, writings, "
    "photos, video and things the family remembers, later refined with voice and recent photos. Every answer shows its source grade "
    "(record / hearsay / estimate). If the records do not say, the avatar replies 'not in the records' instead of inventing. Consent, an "
    "always-visible AI label, and stop/delete are built in. It never claims to be identical to the person; similarity is measured. "
    "Its headline promise: 'we make the people worth remembering - as they were, in look, voice and memory'.")
EXCLUDED_KINDS = {"general", "estimate"}   # 출처 미확인 일반 지식·가상 추정은 근거로 쓰지 않는다

_lock = threading.Lock()          # 인덱스 생성·상태
_llm_lock = threading.Lock()      # 로컬 모델은 한 번에 하나만 (GPU 메모리)
_indexes: dict = {}
_building: set = set()
_errors: dict = {}

_STOP = persona_qbank.STOP


def _tokens(text: str) -> list:
    out = [w for w in re.findall(r"[a-z']{3,}", text.lower()) if w not in _STOP]
    for run in re.findall(r"[가-힣]{2,}", text):       # 한글은 2글자 조각(형태소 분석 없이 쓸 수 있는 방식)
        out.extend(g for g in (run[i:i + 2] for i in range(len(run) - 1)) if g not in _KO_STOP)
    return out


# 질문 어미·조사에서 나오는 흔한 조각 — 검색 점수를 흐리므로 뺀다.
_KO_STOP = set("입니 니까 습니 합니 무엇 어떻 어떤 하는 있는 까요 하셨 셨습 위해 대한 대해 에서 에게 으로 생각 어떠 였나 었나 나요 하나 했나".split())


class _Index:
    """역색인(단어 → 문단 번호 배열). 문단이 수만 개여도 메모리를 적게 쓰려고 array로 담는다."""

    def __init__(self, chunks: list):
        self.chunks = chunks
        self.lengths = array("I")
        postings: dict = {}
        for i, chunk in enumerate(chunks):
            counts = Counter(_tokens(chunk["text"]))
            self.lengths.append(sum(counts.values()) or 1)
            for word, tf in counts.items():
                entry = postings.get(word)
                if entry is None:
                    entry = postings[word] = (array("I"), array("H"))
                entry[0].append(i)
                entry[1].append(min(tf, 65535))
        self.postings = postings
        self.avg = sum(self.lengths) / max(len(self.lengths), 1)
        self.n = len(chunks)

    def search(self, query: str, k: int = 6) -> list:
        scores: dict = {}
        for word in set(_tokens(query)):
            entry = self.postings.get(word)
            if not entry:
                continue
            idf = math.log(1 + (self.n - len(entry[0]) + 0.5) / (len(entry[0]) + 0.5))
            for doc, tf in zip(*entry):
                norm = 1.2 * (0.25 + 0.75 * self.lengths[doc] / self.avg)
                scores[doc] = scores.get(doc, 0.0) + idf * tf * 2.2 / (tf + norm)
        ranked = []
        for doc, score in scores.items():
            chunk = self.chunks[doc]
            ranked.append((score * (1.25 if chunk["tier"] == "own" else 1.0), chunk))   # 본인 글을 전기보다 우대
        ranked.sort(key=lambda x: x[0], reverse=True)
        return ranked[:k]


def _sources(person: str) -> dict:
    out = {}
    manifest = ROOT / person / "manifest.jsonl"
    if manifest.exists():
        for line in manifest.read_text(encoding="utf-8").splitlines():
            if line.strip():
                d = json.loads(line)
                out[d["id"]] = d
    return out


def _build(person: str) -> None:
    try:
        index = _Index([c for c in persona_qbank._paragraphs(person) if c["kind"] not in EXCLUDED_KINDS])
        with _lock:
            _indexes[person] = index
            _errors.pop(person, None)
    except Exception as exc:  # noqa: BLE001 — 상태에 남겨 화면에 보여 준다
        with _lock:
            _errors[person] = str(exc)
    finally:
        with _lock:
            _building.discard(person)


def warm(person: str) -> str:
    """인덱스를 백그라운드로 만든다(큰 자료는 처음에 수십 초). 반환: ready / building."""
    with _lock:
        if person in _indexes:
            return "ready"
        if person not in _building:
            _building.add(person)
            threading.Thread(target=_build, args=(person,), daemon=True).start()
        return "building"


def people() -> list:
    out = []
    with _lock:
        for pid, info in PEOPLE.items():
            manifest = ROOT / pid / "manifest.jsonl"
            docs = sum(1 for l in manifest.read_text(encoding="utf-8").splitlines() if l.strip()) if manifest.exists() else 0
            state = "ready" if pid in _indexes else "building" if pid in _building else "error" if pid in _errors else "idle"
            out.append({"id": pid, "name": info["name"], "field": info["field"], "lens": EXPERTISE[pid]["lens"], "greeting": info["greeting"],
                        "suggestions": info["suggestions"], "docs": docs, "state": state, "error": _errors.get(pid)})
    return out


def _ollama(prompt: str, num_predict: int, temperature: float) -> str:
    payload = json.dumps({"model": MODEL, "stream": False, "think": False,
                          "messages": [{"role": "user", "content": prompt}],
                          "options": {"temperature": temperature, "num_predict": num_predict}}).encode()
    req = urllib.request.Request(pattern.OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with _llm_lock, urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read())["message"]["content"].strip()


def _search_query(question: str, info: dict) -> str:
    """영어 자료는 한국어 질문을 짧은 영어 검색어로 바꿔서 찾는다. 한국어 자료는 질문 그대로."""
    if info["lang"] == "ko":
        return question
    prompt = ("Turn this Korean question into 6-10 English search keywords for finding passages in "
              f"{info['name_en']}'s own writings and talks. Output only the keywords, separated by spaces.\n\nQuestion: {question}")
    try:
        return _ollama(prompt, 40, 0).replace("\n", " ")
    except Exception:  # noqa: BLE001 — 번역이 안 되면 원문 토큰(영어 단어)만으로라도 찾는다
        return question


ANSWER = """You are an AI avatar built ONLY from public materials about {name_en}. Write the reply that avatar would give.

Speaking style (publicly known manner, not a quotation): {style}
Field of expertise: {expertise}. Answer as that expert would, using the concrete concepts, examples and reasoning found in the passages.

Passages from {name_en}'s own writings/talks or from biographies:
{passages}

Persona knowledge record (may include estimates; never present an estimate as a quotation or fact):
{persona_knowledge}

Question (Korean): {question}

Rules:
- Reply in Korean, in first person, 2 to 4 short sentences, in the speaking style above. {lang_rule}
- Use ONLY what the passages support. Never invent facts, numbers, dates or quotations.
- Show real expertise: be specific, name the actual principle or example from the passages.
- If the passages do not actually address the question, reply with exactly: NO_RECORD
- Do not mention passage numbers or say "the passages". Never refer to yourself by name or in the third person."""


def ask(person: str, question: str) -> dict:
    info = PEOPLE.get(person)
    if info is None:
        raise ValueError("알 수 없는 인물")
    question = (question or "").strip()[:MAX_QUESTION]
    if not question:
        raise ValueError("질문이 비어 있습니다")
    if warm(person) != "ready":
        return {"state": "building", "answer": "", "sources": [], "grounded": False}

    index = _indexes[person]
    query = _search_query(question, info)
    hits = _direct_hits(question, index.search(query + " " + question, k=5), info)
    if not hits:
        return {"state": "ready", "answer": NO_RECORD_TEXT, "sources": [], "grounded": False, "query": query}

    passages = "\n\n".join(f"[{i + 1}] ({h['title']}) {h['text'][:700]}" for i, (_, h) in enumerate(hits))
    lang_rule = "" if info["lang"] == "en" else "Passages are Korean; paraphrase them naturally."
    prompt = ANSWER.format(name_en=info["name_en"], style=info["style"], expertise=EXPERTISE[person]["expertise"],
                           passages=passages, persona_knowledge=persona_knowledge.context(person)["text"], question=question, lang_rule=lang_rule)
    text = _ollama(prompt, 320, 0.3)
    grounded = "NO_RECORD" not in text.upper()
    return {"state": "ready", "answer": text if grounded else NO_RECORD_TEXT, "sources": _cite(person, hits) if grounded else [],
            "grounded": grounded, "query": query}


RELEVANT = """Question: "{q}"

Passage (from a document by or about {name}):
\"\"\"{p}\"\"\"

Does this passage contain information that DIRECTLY answers the question (not merely the same general topic or era)? Reply with exactly one word: YES or NO."""


def _direct_hits(question: str, hits: list, info: dict, keep: int = 3) -> list:
    """검색에 걸린 문단 중 질문에 직접 답하는 것만 남긴다. 주제만 비슷한 문단을 근거로 쓰면
    그럴듯하지만 엉뚱한 답이 나오기 때문이다(실측: '신하들의 반대' 질문에 온천 청원 기사를 인용)."""
    kept = []
    for score, chunk in hits:
        try:
            verdict = _ollama(RELEVANT.format(q=question, p=chunk["text"][:900], name=info["name_en"]), 4, 0)
        except Exception:  # noqa: BLE001 — 판정이 안 되면 그 문단은 믿지 않는다
            continue
        if verdict.upper().startswith("YES"):
            kept.append((score, chunk))
        if len(kept) >= keep:
            break
    return kept


def _cite(person: str, hits: list) -> list:
    meta = _sources(person)
    return [{"title": h["title"], "kind": h["kind"], "tier": h["tier"], "url": meta.get(h["doc"], {}).get("source"),
             "excerpt": h["text"][:220]} for _, h in hits]


COMMENT = """You are an AI avatar built ONLY from public materials about {name_en}. A visitor asks what you think of the service described below.

Service: {service}

Speaking style (publicly known manner, not a quotation): {style}
Your lens: {lens_en}. Field of expertise: {expertise}.

Passages from {name_en}'s own writings/talks or from biographies, about that lens:
{passages}

Write a short professional comment on the service from that lens, in Korean, first person, 3 to 5 sentences.
- Ground every idea you attribute to yourself in the passages, and name at least one specific concept, episode or argument from them (not vague generalities). Connect that idea to ONE concrete feature of the service (source grades, 'not in the records', consent, measured similarity, or the headline promise).
- Speak as {name_en} in the first person ("저는"); never refer to yourself by name or in the third person. Write entirely in Korean (translate the service's phrases), and never mention passage numbers like [1] or [4].
- Be honest and critical where the idea warns about a risk. Do not simply praise.
- Do not invent facts, numbers, dates or quotations. Say it is an application of the idea to the service ("이 서비스에 적용해 보면"), not something you said about it.
- If the passages do not support any connection, reply exactly: NO_RECORD"""

_comments: dict = {}


def comment(person: str) -> dict:
    """그 사람의 전문 관점(렌즈)으로 이 서비스를 논평한다. 근거는 그 관점에 관한 본인·사료 문단이고,
    서비스에 적용하는 부분은 AI가 만든 해석이므로 화면에서 따로 표시한다."""
    info = PEOPLE.get(person)
    if info is None:
        raise ValueError("알 수 없는 인물")
    if person in _comments:
        return _comments[person]
    if warm(person) != "ready":
        return {"state": "building", "comment": "", "sources": [], "grounded": False, "lens": EXPERTISE[person]["lens"]}
    ex = EXPERTISE[person]
    hits = _indexes[person].search(ex["lens_query"], k=4)
    if not hits:
        result = {"state": "ready", "comment": NO_RECORD_TEXT, "sources": [], "grounded": False, "lens": ex["lens"]}
    else:
        passages = "\n\n".join(f"[{i + 1}] ({h['title']}) {h['text'][:700]}" for i, (_, h) in enumerate(hits))
        prompt = COMMENT.format(name_en=info["name_en"], service=SERVICE_BRIEF, style=info["style"], lens_en=ex["lens"],
                                expertise=ex["expertise"], passages=passages)
        text = _ollama(prompt, 400, 0.4)
        grounded = "NO_RECORD" not in text.upper()
        result = {"state": "ready", "comment": text if grounded else NO_RECORD_TEXT,
                  "sources": _cite(person, hits) if grounded else [], "grounded": grounded, "lens": ex["lens"]}
    if result["grounded"]:
        _comments[person] = result      # 근거가 있는 논평만 다시 쓰고, 못 찾은 경우는 자료가 늘면 다시 시도한다
    return result
