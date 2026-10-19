"""인물 페르소나 분석의 이용 범위.

분석 대상의 이름이 알려져 있다는 것과 얼굴·목소리·사칭을 허용한다는 것은 별개다.
이 정책은 화면 안내용이면서, 각 기능이 사용할 수 있는 매체를 한 곳에서 결정한다.
"""

TEXT_ONLY_RISK = "text_only_risk"
HISTORICAL = "historical"
FAMOUS_AI = "famous_ai"
PRIVATE_CONSENT = "private_consent"

MODES = {
    TEXT_ONLY_RISK: {
        "label": "초상권 위험 인물 · 텍스트만",
        "short": "공개 발언·저작물의 근거 분석만",
        "analysis": True, "face": False, "voice": False, "synthetic_voice": True, "consent_required": False,
        "notice": "실존 인물의 사진·음성·말투 복제와 실사 아바타 생성은 사용하지 않습니다. 특정 인물을 모방하지 않는 가상 음성은 사용할 수 있습니다.",
    },
    HISTORICAL: {
        "label": "역사적 인물",
        "short": "사료와 저작물에 근거한 역사적 페르소나",
        "analysis": True, "face": False, "voice": False, "synthetic_voice": True, "consent_required": False,
        "notice": "사료 기반 추정임을 표시하며, 실존 음성 재현이나 실제 인물처럼 보이는 영상은 만들지 않습니다. 비식별 가상 음성은 사용할 수 있습니다.",
    },
    FAMOUS_AI: {
        "label": "가상 AI · 유명인 모드",
        "short": "공개 자료를 바탕으로 한 비사칭 텍스트 시뮬레이션",
        "analysis": True, "face": False, "voice": False, "synthetic_voice": True, "consent_required": False,
        "notice": "'가상 AI'임을 항상 표시합니다. 외형·음성은 독자적인 가상 캐릭터만 사용합니다.",
    },
    PRIVATE_CONSENT: {
        "label": "개인 아바타 · 동의 필수",
        "short": "당사자가 허락한 자료로 하는 개인 페르소나",
        "analysis": True, "face": True, "voice": True, "synthetic_voice": True, "consent_required": True,
        "notice": "얼굴·음성·개인 기록을 넣기 전 당사자의 명시적 동의를 확인해야 합니다.",
    },
}

# 현재 공개 코퍼스의 기본 분류. 위험이 불명확한 실제 인물은 보수적으로 text-only로 둔다.
PUBLIC_PERSON_MODES = {
    "buffett": TEXT_ONLY_RISK,
    "einstein": TEXT_ONLY_RISK,
    "feynman": TEXT_ONLY_RISK,
    "jobs": TEXT_ONLY_RISK,
    "songhae": TEXT_ONLY_RISK,
    "brucelee": TEXT_ONLY_RISK,
    "sejong": HISTORICAL,
    "yi_sun_sin": HISTORICAL,
    "leonardo": HISTORICAL,
    "marie_curie": HISTORICAL,
    "marcus_aurelius": HISTORICAL,
}

HISTORICAL_FIVE = ("sejong", "yi_sun_sin", "leonardo", "marie_curie", "marcus_aurelius")


def public_person_policy(person: str) -> dict:
    mode = PUBLIC_PERSON_MODES.get(person, TEXT_ONLY_RISK)
    return {"mode": mode, **MODES[mode]}
