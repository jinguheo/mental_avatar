"""임베딩 모델 교체 후 재색인 — 이전 컬렉션의 원문을 새 모델로 다시 임베딩해 새 컬렉션에 넣는다.

이전 컬렉션(mental_avatar, mental_avatar_entities)은 지우지 않는다. 같은 id가 이미 새 컬렉션에 있으면
건너뛰므로 여러 번 돌려도 된다(서버 재시작 직전에 옛 컬렉션에 들어간 것까지 따라잡을 때 다시 실행).
KG(nodes)에 없는 id(지워진 노드의 유령 벡터)는 옮기지 않는다.

    MA_EMBED_DEVICE=cuda python scripts/reindex_embeddings.py   # GPU로 빠르게(서버는 CPU로 같은 벡터를 만든다)
"""
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from core import embeddings  # noqa: E402

OLD = [("mental_avatar", embeddings._get_collection), ("mental_avatar_entities", embeddings._get_entity_collection)]
DB = os.path.join(os.path.dirname(__file__), "..", "db", "knowledge.db")
BATCH = 64


def main():
    client = embeddings._get_client()
    conn = sqlite3.connect(DB)
    live = {r[0] for r in conn.execute("SELECT id FROM nodes")}
    conn.close()
    for old_name, get_new in OLD:
        old = client.get_collection(old_name)
        new = get_new()
        g = old.get(include=["documents", "metadatas"])
        have = set(new.get(include=[])["ids"])
        todo = [(i, d, m) for i, d, m in zip(g["ids"], g["documents"], g["metadatas"])
                if i not in have and i in live and d]
        ghosts = sum(1 for i in g["ids"] if i not in live)
        print(f"[{old_name} → {new.name}] 원본 {len(g['ids'])} · 이미 있음 {len(have)} · 유령 {ghosts} · 색인 {len(todo)}", flush=True)
        t = time.time()
        for s in range(0, len(todo), BATCH):
            chunk = todo[s:s + BATCH]
            new.upsert(ids=[c[0] for c in chunk], documents=[c[1] for c in chunk],
                       metadatas=[c[2] or None for c in chunk])
            print(f"  {min(s + BATCH, len(todo))}/{len(todo)} ({time.time() - t:.0f}s)", flush=True)
        print(f"  완료: {new.name} = {new.count()}개", flush=True)


if __name__ == "__main__":
    main()
