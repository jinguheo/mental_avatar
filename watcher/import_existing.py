"""docs/ 폴더의 기존 파일 일괄 import"""
import sys, os, requests, time
sys.stdout.reconfigure(encoding="utf-8", errors="replace") if hasattr(sys.stdout, "reconfigure") else None
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

DOCS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "docs"))
API_BASE = "http://127.0.0.1:8766"
EXTENSIONS = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".txt", ".md"}


def collect_files(root: str) -> list[str]:
    result = []
    for dirpath, _, filenames in os.walk(root):
        for fname in filenames:
            if fname.startswith("~$"):  # Word 임시 파일 제외
                continue
            ext = os.path.splitext(fname)[1].lower()
            if ext in EXTENSIONS:
                result.append(os.path.join(dirpath, fname))
    return result


def run():
    files = collect_files(DOCS_DIR)
    if not files:
        print(f"[import] docs/ 폴더에 처리할 파일이 없습니다: {DOCS_DIR}")
        return

    print(f"[import] {len(files)}개 파일 발견")
    success, failed = 0, 0

    for i, fp in enumerate(files, 1):
        print(f"[{i}/{len(files)}] {os.path.basename(fp)} ...", end=" ")
        try:
            resp = requests.post(f"{API_BASE}/ingest", json={"file_path": fp}, timeout=120)
            data = resp.json()
            if data.get("success"):
                print(f"✓ ({data['count']}개 노드)")
                success += 1
            else:
                print(f"✗ {data.get('error')}")
                failed += 1
        except Exception as e:
            print(f"✗ {e}")
            failed += 1
        time.sleep(0.3)  # API 부하 조절

    print(f"\n[import] 완료 — 성공: {success}, 실패: {failed}")


if __name__ == "__main__":
    run()
