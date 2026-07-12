"""Korean text-aware visemes aligned to Whisper word timestamps."""
from __future__ import annotations

import re
from typing import Any

_HANGUL_BASE = 0xAC00
_HANGUL_END = 0xD7A3
_TARGET_WORD = re.compile(r"[\uAC00-\uD7A3A-Za-z0-9]+")

_ROUNDED_VOWELS = {8, 9, 10, 11, 12, 13, 17, 18}
_SPREAD_VOWELS = {1, 3, 5, 7, 15, 16, 19, 20}
_DIPHTHONG_VOWELS = {9, 10, 11, 12, 13, 14, 15, 16, 19}
_BILABIAL_ONSETS = {6, 7, 17}
_SIBILANT_ONSETS = {9, 10, 12, 14, 15}
_ALVEOLAR_ONSETS = {3, 4, 5, 18}
_VELAR_ONSETS = {0, 1, 15, 16}
_BILABIAL_CODAS = {16, 17, 18}
_ALVEOLAR_CODAS = {4, 5, 6, 7, 19, 20, 21, 22, 23, 25, 27}
_VELAR_CODAS = {1, 2, 3, 24}
_NASAL_CODAS = {4, 16, 21}


def _split_hangul(char: str) -> tuple[int, int, int] | None:
    code = ord(char)
    if not (_HANGUL_BASE <= code <= _HANGUL_END):
        return None
    offset = code - _HANGUL_BASE
    return offset // 588, (offset % 588) // 28, offset % 28


def _vowel_viseme(vowel: int) -> str:
    if vowel in _ROUNDED_VOWELS:
        return "KO_ROUND"
    if vowel in _SPREAD_VOWELS:
        return "KO_SPREAD"
    return "KO_OPEN"


def _onset_viseme(onset: int) -> str | None:
    if onset == 11:
        return None
    if onset in _BILABIAL_ONSETS:
        return "KO_CLOSED"
    if onset in _SIBILANT_ONSETS:
        return "KO_SIBILANT"
    if onset in _VELAR_ONSETS:
        return "KO_BACK"
    if onset in _ALVEOLAR_ONSETS:
        return "KO_ALVEOLAR"
    return "KO_LIGHT"


def _coda_viseme(coda: int) -> str | None:
    if coda == 0:
        return None
    if coda in _BILABIAL_CODAS:
        return "KO_CLOSED"
    if coda in _NASAL_CODAS:
        return "KO_NASAL"
    if coda in _VELAR_CODAS:
        return "KO_BACK"
    if coda in _ALVEOLAR_CODAS:
        return "KO_ALVEOLAR"
    return "KO_LIGHT"


def _viseme_sequence_for_char(char: str) -> list[tuple[str, float]]:
    """Split one Korean syllable into onset, vowel, and final consonant poses."""
    parts = _split_hangul(char)
    if parts is None:
        return [("C", 1.0)]

    onset, vowel, coda = parts
    onset_shape = _onset_viseme(onset)
    vowel_shape = _vowel_viseme(vowel)
    coda_shape = _coda_viseme(coda)

    sequence: list[tuple[str, float]] = []
    if onset_shape:
        sequence.append((onset_shape, 0.22))
    if vowel in _DIPHTHONG_VOWELS:
        sequence.append(("KO_TRANSITION", 0.18))
        sequence.append((vowel_shape, 0.46))
    else:
        sequence.append((vowel_shape, 0.62 if coda_shape else 0.78))
    if coda_shape:
        sequence.append((coda_shape, 0.20))

    total = sum(weight for _, weight in sequence) or 1.0
    return [(shape, weight / total) for shape, weight in sequence]


def _word_times(segments: list[Any]) -> list[tuple[float, float]]:
    times: list[tuple[float, float]] = []
    for segment in segments:
        for word in getattr(segment, "words", None) or []:
            start, end = getattr(word, "start", None), getattr(word, "end", None)
            if start is not None and end is not None and end > start:
                times.append((float(start), float(end)))
    if times:
        return times
    for segment in segments:
        start, end = getattr(segment, "start", None), getattr(segment, "end", None)
        if start is not None and end is not None and end > start:
            times.append((float(start), float(end)))
    return times


def extract_korean_visemes(text: str, segments: list[Any]) -> list[dict[str, float | str]]:
    """Return Hangul-derived mouth cues placed on actual Whisper audio timestamps."""
    words = _TARGET_WORD.findall(text)
    times = _word_times(segments)
    if not words or not times:
        return []

    cues: list[dict[str, float | str]] = []
    for index, word in enumerate(words):
        start, end = times[min(index, len(times) - 1)]
        if index >= len(times):
            start = float(cues[-1]["end"]) if cues else start
        char_duration = max((float(end) - float(start)) / max(len(word), 1), 0.035)
        for char_index, char in enumerate(word):
            char_start = float(start) + char_duration * char_index
            char_end = min(float(end), char_start + char_duration)
            if char_end <= char_start:
                continue

            cursor = char_start
            for shape, ratio in _viseme_sequence_for_char(char):
                cue_end = min(char_end, cursor + (char_end - char_start) * ratio)
                if cue_end <= cursor:
                    continue
                if cues and cues[-1]["value"] == shape and abs(float(cues[-1]["end"]) - cursor) < 0.01:
                    cues[-1]["end"] = cue_end
                else:
                    cues.append({"start": cursor, "end": cue_end, "value": shape})
                cursor = cue_end
    return cues
