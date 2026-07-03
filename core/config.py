"""중앙 경로 설정 — 흩어져 있던 하드코딩 절대경로를 한 곳에 모은다.

각 값은 .env 파일이나 환경변수로 override 가능하며, 없으면 현재 머신 기본값을 쓴다.
conda 환경을 옮기거나 다른 머신에 배포할 때 이 파일(또는 .env)만 고치면 된다.
(예전 miniconda를 C:→D:로 옮겼을 때 하드코딩 경로가 곳곳에서 깨진 전례가 있어 집약함.)
"""
from pathlib import Path
from . import env

# 프로젝트 루트 (이 파일 기준 상위)
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# XTTS/모델 캐시 위치
MODELS_DIR = Path(env.get("MENTAL_AVATAR_MODELS", str(PROJECT_ROOT / "models")))

# SadTalker 설치 위치 (inference.py, ffmpeg.exe 포함)
SADTALKER_DIR    = Path(env.get("SADTALKER_DIR", r"D:\MyWork\SadTalker"))
SADTALKER_FFMPEG = Path(env.get("SADTALKER_FFMPEG", str(SADTALKER_DIR / "ffmpeg.exe")))

# conda 환경별 python 실행파일
AVATAR_PYTHON = env.get("AVATAR_PYTHON", r"C:\Users\oem\miniconda3\envs\avatar\python.exe")  # SadTalker (numpy 1.26 패치판)
XTTS_PYTHON   = env.get("XTTS_PYTHON",   r"C:\Users\oem\miniconda3\envs\xtts\python.exe")     # Coqui XTTS v2
