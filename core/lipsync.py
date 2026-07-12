"""Rhubarb Lip Sync 연동 — TTS 음성에서 발음 타이밍 기반 입모양(viseme) 큐 추출.

기존 프론트엔드 입싱크는 오디오의 저/중/고 주파수 대역 크기만 보고 입 벌림 정도를
추측했다(실제 발음이 뭔지 모름). Rhubarb는 오디오를 분석해 A~X(Preston Blair 계열)
입모양을 구간별 타임코드로 뽑아준다 — 훨씬 정확하다.

한국어는 Rhubarb의 PocketSphinx 사전이 없어 --dialogFile(텍스트) 기반 인식은 못 쓰고,
언어 무관하게 오디오 자체 특성만으로 분석하는 phonetic 인식기를 사용한다.
"""
import json
import subprocess
import tempfile
from pathlib import Path

from core.korean_lipsync import extract_korean_visemes

RHUBARB_EXE = Path(__file__).parent.parent / "models" / "rhubarb" / "rhubarb.exe"


def extract_visemes(wav_path: str) -> list[dict]:
    """WAV 파일을 분석해 [{"start": float, "end": float, "value": "A".."X"}] 큐 리스트 반환.
    rhubarb.exe가 없거나 분석 실패 시 빈 리스트(프론트가 기존 주파수 방식으로 폴백)."""
    if not RHUBARB_EXE.exists():
        return []
    with tempfile.TemporaryDirectory() as tmp:
        out_path = Path(tmp) / "cues.json"
        try:
            subprocess.run(
                [str(RHUBARB_EXE), "-r", "phonetic", "-f", "json", "-o", str(out_path), wav_path],
                check=True, capture_output=True, timeout=30,
            )
            data = json.loads(out_path.read_text(encoding="utf-8"))
            return data.get("mouthCues", [])
        except Exception as e:
            print(f"[lipsync] rhubarb 분석 실패: {e}", flush=True)
            return []
