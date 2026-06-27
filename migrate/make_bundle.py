"""make_bundle.py — 최신 db/vectors/data 를 migrate/data_bundle_<시각>.zip 으로 묶음.
사용: conda run -n avatar python migrate/make_bundle.py
"""
import os
import shutil
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATE = os.path.join(ROOT, "migrate")
SOURCES = [
    ("db/knowledge.db", "knowledge.db"),
    ("db/vectors", "vectors"),
    ("data", "data"),
]


def main():
    stamp = time.strftime("%Y%m%d_%H%M%S")
    staging = os.path.join(MIGRATE, f"data_bundle_{stamp}")
    os.makedirs(staging, exist_ok=True)
    for src_rel, dst_name in SOURCES:
        src = os.path.join(ROOT, src_rel)
        if not os.path.exists(src):
            print(f"  (건너뜀, 없음) {src_rel}")
            continue
        dst = os.path.join(staging, dst_name)
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
    zip_path = shutil.make_archive(os.path.join(MIGRATE, f"data_bundle_{stamp}"), "zip", staging)
    shutil.rmtree(staging)
    size = os.path.getsize(zip_path) / 1024 / 1024
    print(f"생성됨: {zip_path} ({size:.1f} MB)")


if __name__ == "__main__":
    main()
