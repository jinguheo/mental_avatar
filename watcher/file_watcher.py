"""docs/ 폴더 감시 — 새 파일 자동 ingest + DB/벡터/얼굴·목소리 주기 백업"""
import sys, os, re, time, shutil, json, requests
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

ROOT_DIR   = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DOCS_DIR   = os.path.join(ROOT_DIR, "docs")
API_BASE   = "http://127.0.0.1:8766"
EXTENSIONS = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".txt", ".md"}

# 서버(8766)가 워처 생존 여부를 파일 mtime만으로 판단할 수 있도록 매 루프마다 갱신
HEARTBEAT_PATH = os.path.join(ROOT_DIR, "tmp", "watcher_heartbeat.json")


# 이 시간 안에 갱신된 하트비트가 있으면 다른 워처가 이미 돌고 있다고 본다(서버의 판정 기준과 동일).
HEARTBEAT_STALE_SEC = 90


def _write_heartbeat():
    try:
        os.makedirs(os.path.dirname(HEARTBEAT_PATH), exist_ok=True)
        with open(HEARTBEAT_PATH, "w", encoding="utf-8") as f:
            json.dump({"ts": time.time(), "pid": os.getpid()}, f)
    except Exception:
        pass


def _already_running() -> bool:
    """다른 워처 인스턴스가 이미 돌고 있는지 하트비트로 확인한다.

    워처는 start_dashboard.bat, 서버(8766)의 자동복구, 수동 실행 등 여러 경로로 뜰 수 있는데
    두 개가 동시에 돌면 같은 파일을 이중 ingest하고 백업도 두 벌씩 쌓인다. 어느 경로로 띄우든
    여기서 막는다.
    """
    try:
        with open(HEARTBEAT_PATH, encoding="utf-8") as f:
            info = json.load(f)
    except Exception:
        return False   # 파일 없음/깨짐 = 돌고 있지 않음
    return (time.time() - info.get("ts", 0)) < HEARTBEAT_STALE_SEC

# ── 백업 설정: db/knowledge.db + db/vectors/ + data/ 를 통째로 복사 ──
BACKUP_DIR      = os.path.join(ROOT_DIR, "backups")
BACKUP_SOURCES  = [
    os.path.join(ROOT_DIR, "db", "knowledge.db"),
    os.path.join(ROOT_DIR, "db", "vectors"),
    os.path.join(ROOT_DIR, "data"),
]
BACKUP_INTERVAL_SEC = 3600   # 1시간마다
BACKUP_KEEP          = 24    # 시간별 백업(YYYYMMDD_HHMMSS)은 최근 24개(=하루치)만 보관
MANUAL_BACKUP_KEEP   = 10    # 작업 전 백업(pre_delete_* 등)은 별도로 최근 10개 보관

# preference(MBTI/성격/선호도) 자동측정 — 실제 주기는 /preference/due가 사용자 설정(preference_interval_days)으로 판단,
# watcher는 그 판단을 부담없는 간격(1시간)으로 확인만 함
PREFERENCE_CHECK_INTERVAL_SEC = 3600


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


def _run_backup():
    """db/knowledge.db + db/vectors/ + data/ 를 backups/<timestamp>/ 로 복사 후 오래된 백업 정리"""
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest_dir = os.path.join(BACKUP_DIR, stamp)
    try:
        os.makedirs(dest_dir, exist_ok=True)
        copied = []
        for src in BACKUP_SOURCES:
            if not os.path.exists(src):
                continue
            name = os.path.basename(src)
            dest = os.path.join(dest_dir, name)
            if os.path.isdir(src):
                shutil.copytree(src, dest)
            else:
                shutil.copy2(src, dest)
            copied.append(name)
        print(f"[watcher] 백업 완료: {dest_dir} ({', '.join(copied) or '대상 없음'})")
        _prune_old_backups()
    except Exception as e:
        print(f"[watcher] 백업 오류: {e}")


def _check_preference_schedule():
    """사용자가 설정한 측정 주기가 지났으면 MBTI/성격/선호도 자동측정을 실행"""
    try:
        due = requests.get(f"{API_BASE}/preference/due", timeout=10).json().get("due")
        if not due:
            return
        resp = requests.post(f"{API_BASE}/preference/analyze_and_apply", timeout=120)
        data = resp.json()
        if data.get("applied"):
            print(f"[watcher] preference 자동측정 완료 (대화 {data.get('count', 0)}건 기반)")
        elif data.get("ready") is False:
            print(f"[watcher] preference 자동측정 보류: {data.get('message')}")
    except Exception as e:
        print(f"[watcher] preference 자동측정 오류: {e}")


def _prune_old_backups():
    """오래된 백업 정리 — 시간별 백업과 작업 전 백업(pre_*)을 각각 따로 센다.

    한 묶음으로 이름순 정렬하면 'pre_...'가 '2026...'보다 뒤라 역순에서 앞자리를 차지해,
    삭제를 몇 번 하면 pre_* 백업이 24칸을 다 먹고 시간별 백업이 전멸한다. 두 종류는
    수명이 다르므로(하나는 시계열, 하나는 되돌리기용) 분리해서 관리한다.
    """
    if not os.path.isdir(BACKUP_DIR):
        return
    dirs = [d for d in os.listdir(BACKUP_DIR) if os.path.isdir(os.path.join(BACKUP_DIR, d))]
    hourly = sorted((d for d in dirs if re.fullmatch(r"\d{8}_\d{6}", d)), reverse=True)
    manual = sorted((d for d in dirs if d.startswith("pre_")), reverse=True)
    for old in hourly[BACKUP_KEEP:] + manual[MANUAL_BACKUP_KEEP:]:
        shutil.rmtree(os.path.join(BACKUP_DIR, old), ignore_errors=True)


def start():
    os.makedirs(DOCS_DIR, exist_ok=True)
    os.makedirs(BACKUP_DIR, exist_ok=True)
    observer = Observer()
    observer.schedule(DocHandler(), DOCS_DIR, recursive=True)
    observer.start()
    print(f"[watcher] 감시 시작: {DOCS_DIR}")
    _write_heartbeat()
    _run_backup()  # 시작 시 1회 즉시 백업(서버 재시작 직후에도 최신 상태 보존)
    tick = 0
    backup_tick = 0
    pref_tick = 0
    try:
        while True:
            time.sleep(2)
            _write_heartbeat()
            tick += 2
            backup_tick += 2
            pref_tick += 2
            if tick >= 30:
                tick = 0
                _process_queue()
            if backup_tick >= BACKUP_INTERVAL_SEC:
                backup_tick = 0
                _run_backup()
            if pref_tick >= PREFERENCE_CHECK_INTERVAL_SEC:
                pref_tick = 0
                _check_preference_schedule()
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    if _already_running():
        # cp949 콘솔에서 죽지 않도록 ASCII 문장부호만 쓴다(em-dash는 cp949로 인코딩 불가).
        print("[watcher] 이미 다른 워처가 실행 중입니다. 중복 기동하지 않고 종료합니다.")
        sys.exit(0)
    start()
