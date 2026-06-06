"""docs/ 폴더 감시 — 새 파일 자동 ingest"""
import sys, os, time, requests
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

DOCS_DIR   = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "docs"))
API_BASE   = "http://127.0.0.1:8766"
EXTENSIONS = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".txt", ".md"}


class DocHandler(FileSystemEventHandler):
    def on_created(self, event):
        if event.is_directory:
            return
        ext = os.path.splitext(event.src_path)[1].lower()
        if ext not in EXTENSIONS:
            return
        print(f"[watcher] 새 파일 감지: {event.src_path}")
        time.sleep(1)  # 파일 쓰기 완료 대기
        self._ingest(event.src_path)

    def on_modified(self, event):
        if event.is_directory:
            return
        ext = os.path.splitext(event.src_path)[1].lower()
        if ext not in EXTENSIONS:
            return
        print(f"[watcher] 파일 변경 감지: {event.src_path}")
        time.sleep(1)
        self._ingest(event.src_path)

    def _ingest(self, file_path: str):
        try:
            resp = requests.post(f"{API_BASE}/ingest", json={"file_path": file_path}, timeout=60)
            data = resp.json()
            if data.get("success"):
                print(f"[watcher] ✓ {os.path.basename(file_path)} → {data['count']}개 노드 추가")
            else:
                print(f"[watcher] ✗ {data.get('error')}")
        except Exception as e:
            print(f"[watcher] 오류: {e}")


def _process_queue():
    try:
        resp = requests.post(f"{API_BASE}/queue/process", json={"limit": 5}, timeout=300)
        data = resp.json()
        done = data.get("done", 0)
        if done > 0:
            print(f"[watcher] 큐 처리 완료: {done}개")
    except Exception as e:
        print(f"[watcher] 큐 처리 오류: {e}")


def start():
    os.makedirs(DOCS_DIR, exist_ok=True)
    observer = Observer()
    observer.schedule(DocHandler(), DOCS_DIR, recursive=True)
    observer.start()
    print(f"[watcher] 감시 시작: {DOCS_DIR}")
    tick = 0
    try:
        while True:
            time.sleep(2)
            tick += 2
            if tick >= 30:
                tick = 0
                _process_queue()
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    start()
