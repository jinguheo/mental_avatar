"""공용 환경변수 로더 — .env 파일을 한 번만 로드"""
import os

_loaded = False


def load():
    global _loaded
    if _loaded:
        return
    env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
    if os.path.exists(env_path):
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
    _loaded = True


def get(key: str, default: str = "") -> str:
    load()
    return os.environ.get(key, default)
