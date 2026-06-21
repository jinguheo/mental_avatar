"""상주 XTTS v2 워커 — 포트 8767 (xtts 콘다 환경의 python으로 실행)

매 TTS 요청마다 모델을 새로 로드하던 구조(요청당 ~60초)를 대체한다.
모델을 프로세스 시작 시 1회만 GPU(CUDA)에 올려두고, 이후 요청은 텍스트만 받아
2~3초에 합성한다. 메인 서버(8766)의 /avatar/tts_only가 이 워커로 프록시한다.

JSON POST /tts  {text, speaker?, speaker_wav?, language?}  → audio/wav 바이트
GET /health → {"status":"ok","device":"cuda|cpu"}
"""
import os, sys, json, uuid, tempfile, threading
os.environ["COQUI_TOS_AGREED"] = "1"
os.environ["TTS_HOME"] = r"D:\MyWork\mental-avatar\models"
sys.stdout.reconfigure(encoding="utf-8")

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

print("[xtts] 모델 로딩 중... (최초 1회, ~60초)", flush=True)
from TTS.api import TTS
try:
    import torch
    _DEV = "cuda" if torch.cuda.is_available() else "cpu"
except Exception:
    _DEV = "cpu"
TTS_MODEL = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(_DEV)
print(f"[xtts] 준비 완료 — device={_DEV}, 포트 8768 대기", flush=True)

# XTTS 모델은 동시 호출에 안전하지 않다 — 락으로 직렬화
_lock = threading.Lock()
_OUT = tempfile.gettempdir()


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body=b"", ctype="application/octet-stream"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, json.dumps({"status": "ok", "device": _DEV}).encode(), "application/json")
        else:
            self._send(404)

    def do_POST(self):
        if self.path != "/tts":
            self._send(404)
            return
        n = int(self.headers.get("Content-Length", 0) or 0)
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            self._send(400, b'{"error":"bad json"}', "application/json")
            return
        text = (req.get("text") or "").strip()
        if not text:
            self._send(400, b'{"error":"text required"}', "application/json")
            return
        speaker = req.get("speaker")
        speaker_wav = req.get("speaker_wav")
        language = req.get("language") or "ko"
        out = os.path.join(_OUT, f"xtts_{uuid.uuid4().hex}.wav")
        try:
            kw = {"text": text, "language": language, "file_path": out}
            if speaker:
                kw["speaker"] = speaker
            elif speaker_wav:
                kw["speaker_wav"] = speaker_wav
            with _lock:
                TTS_MODEL.tts_to_file(**kw)
            with open(out, "rb") as f:
                data = f.read()
            self._send(200, data, "audio/wav")
        except Exception as e:
            self._send(500, json.dumps({"error": str(e)}).encode(), "application/json")
        finally:
            try:
                os.remove(out)
            except OSError:
                pass

    def log_message(self, *args):
        pass  # 로그 소음 억제


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8768), Handler).serve_forever()
