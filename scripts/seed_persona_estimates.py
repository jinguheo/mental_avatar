"""근거가 비어 있는 인물 질문 은행을 역할·직업·시대 맥락의 초안으로 채운다.

정확한 전기나 발언의 대체물이 아니다. 모든 레코드는 estimate로 저장하며,
나중에 직접 원문 근거나 리뷰가 생기면 persona_qbank.load()가 그것을 우선한다.
"""
import json
import time
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core import persona_qbank as bank


CONTEXT = {
    "buffett": ("투자자·경영자", "현대 기업·장기 투자", "장기 가치, 신뢰, 절제된 위험 관리"),
    "einstein": ("이론물리학자·사상가", "20세기 과학", "호기심, 독립적 사고, 단순한 설명"),
    "feynman": ("물리학자·교육자", "20세기 과학 교육", "검증, 호기심, 모르는 것을 인정하는 태도"),
    "jobs": ("제품 창업가·디자인 리더", "현대 기술 산업", "집중, 단순함, 사용자 경험"),
    "songhae": ("방송인·무대 진행자", "한국 대중문화", "사람, 관객, 꾸준한 현장성"),
    "brucelee": ("무술가·배우·사상가", "20세기 대중문화", "훈련, 자기표현, 고정관념을 넘는 태도"),
    "sejong": ("군주·정책 결정자", "15세기 조선", "백성, 학습, 기록과 제도"),
    "yi_sun_sin": ("군 지휘관·공직자", "임진왜란기 조선", "책임, 준비, 절제, 공동체의 안전"),
    "leonardo": ("예술가·발명가·관찰자", "르네상스 이탈리아", "관찰, 호기심, 분야를 넘는 탐구"),
    "marie_curie": ("과학자·연구자", "근대 과학", "연구의 엄밀함, 끈기, 공공 기여"),
    "marcus_aurelius": ("로마 황제·스토아 철학자", "고대 로마", "의무, 절제, 이성적 자기성찰"),
}

DOMAIN_LENS = {
    "가치관·신념·윤리": "공적 책임과 자신이 중요하게 둔 기준",
    "일과 결정": "역할에 맞는 준비·판단·책임",
    "감정·갈등": "공적 압박 속 절제와 회복",
    "관계": "동료·공동체·대중을 대하는 태도",
    "유머·말투": "알려진 직업적 소통 방식",
    "취향·습관": "일과 학습에 연결된 생활 방식",
    "인생 이력": "대표 업적과 전환점",
    "모순·한계": "시대와 역할에서 생긴 제약과 한계",
    "전문지식·사고법": "분야의 방법론과 문제 해결 방식",
    "MBTI·인지·에너지": "공적 활동에서 관찰되는 사고·에너지 경향",
    "성격·기질": "공개 기록에서 보이는 평균적 기질",
    "표현·문체": "저작·강연·업무에서 드러난 설명 방식",
    "시기·변화": "경험과 시대 변화에 따른 관점의 변화",
}


def rows_for(person: str):
    return [{"qid": qid, "domain": domain, "question": ko, "question_en": en, "answered": False, "evidence": []}
            for qid, domain, ko, en, _ in bank.QUESTIONS]


def seed(person: str, overwrite: bool = False) -> int:
    role, era, themes = CONTEXT[person]
    root = bank.ROOT / person
    root.mkdir(parents=True, exist_ok=True)
    answers = root / "answers.jsonl"
    if not answers.exists():
        answers.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows_for(person)), encoding="utf-8")
    else:
        current = [json.loads(line) for line in answers.read_text(encoding="utf-8").splitlines() if line.strip()]
        present = {row["qid"] for row in current}
        missing = [row for row in rows_for(person) if row["qid"] not in present]
        if missing:
            with answers.open("a", encoding="utf-8") as handle:
                handle.write("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in missing))
    existing_path = root / "supplement.jsonl"
    existing = {}
    if existing_path.exists() and not overwrite:
        existing = {record["qid"]: record for line in existing_path.read_text(encoding="utf-8").splitlines() if line.strip()
                    for record in [json.loads(line)]}
    for qid, domain, question, _, _ in bank.QUESTIONS:
        if qid in existing and not overwrite:
            continue
        lens = DOMAIN_LENS[domain]
        text = (f"추정: {bank.NAMES[person]}의 {role}라는 역할과 {era}의 맥락을 보면, "
                f"‘{question}’에는 {themes} 및 {lens}을 중시하는 쪽으로 답했을 가능성이 있습니다. "
                "직접 확인된 발언이 아닌 역할 기반 평균 추정입니다.")
        existing[qid] = {"qid": qid, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "evidence": [{
            "text": text, "doc": "estimate", "title": "역할·직업·시대 맥락 기반 평균 추정(리뷰 대기)",
            "kind": "estimate", "tier": "estimate", "score": 0.10,
            "source_refs": [{"doc": "role_context", "title": f"{role} · {era}", "kind": "estimate"}],
        }]}
    existing_path.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n" for record in existing.values()), encoding="utf-8")
    return len(existing)


if __name__ == "__main__":
    for person in CONTEXT:
        print(person, seed(person))
