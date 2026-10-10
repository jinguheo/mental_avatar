"""Local-only, evidence-bound automatic profile extraction."""
import json
import threading
import urllib.request
from datetime import datetime
from db.init_db import get_conn

FIELDS = {"name", "role", "company", "expertise", "main_projects",
          "goals", "values", "work_style", "relationships", "biography"}
_lock = threading.Lock()
_status = {"running": False, "processed": 0, "saved": 0, "error": "", "last_run": ""}


def _init(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS avatar_profile_auto (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, evidence TEXT NOT NULL,
        conversation_id TEXT NOT NULL, observed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS avatar_profile_recall_seen (
        conversation_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS avatar_profile_candidates (
        key TEXT NOT NULL, value TEXT NOT NULL, evidence TEXT NOT NULL,
        conversation_id TEXT NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(key, value, conversation_id))""")


def facts():
    conn = get_conn()
    _init(conn)
    rows = conn.execute("SELECT * FROM avatar_profile_auto").fetchall()
    conn.close()
    return {row["key"]: dict(row) for row in rows}


def status():
    conn = get_conn()
    _init(conn)
    seen = conn.execute("SELECT count(*) FROM avatar_profile_recall_seen").fetchone()[0]
    count = conn.execute("SELECT count(*) FROM avatar_profile_auto").fetchone()[0]
    candidates = conn.execute("SELECT count(*) FROM avatar_profile_candidates").fetchone()[0]
    conn.close()
    return {**_status, "seen": seen, "facts": count, "candidates": candidates, "model": "gemma4:e2b"}


def _extract(content):
    instruction = (
        "Extract ONLY stable, explicit first-person facts about this speaker. "
        "No inference from questions, requests, quotes, roleplay or assistant text. "
        "Keep conditions and context. Value must be an exact substring of evidence. Return JSON only: "
        '{"facts":[{"key":"allowed key","value":"concise fact","evidence":"exact substring"}]}. '
        "Allowed keys: " + ", ".join(sorted(FIELDS)) + ". "
        "If no facts, return an empty facts list. Evidence MUST appear verbatim."
    )
    data = json.dumps({
        "model": "gemma4:e2b", "stream": False, "format": "json",
        "options": {"temperature": 0},
        "messages": [{"role": "system", "content": instruction},
                     {"role": "user", "content": content[:1500]}],
    }, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:11434/api/chat", data=data,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=70) as response:
        answer = json.loads(response.read())
    parsed = json.loads(answer.get("message", {}).get("content", "{}"))
    found = []
    for item in parsed.get("facts", [])[:5]:
        if not isinstance(item, dict):
            continue
        key, value, evidence = item.get("key"), str(item.get("value", "")).strip(), str(item.get("evidence", "")).strip()
        if key in FIELDS and value and len(value) <= 240 and len(evidence) >= 8 and evidence in content and value in evidence:
            found.append((key, value, evidence))
    return found


def sync(limit=30):
    if not _lock.acquire(blocking=False):
        return status()
    _status.update(running=True, processed=0, saved=0, error="")
    try:
        conn = get_conn()
        _init(conn)
        # Voice transcripts are excluded until input modality is recorded.
        rows = conn.execute("""
            SELECT id, content, created_at FROM conversations
            WHERE role='user' AND view IN ('ai_chat','avatar3d_chat_typed','realistic_avatar_typed')
              AND length(content) BETWEEN 8 AND 1500
              AND id NOT IN (SELECT conversation_id FROM avatar_profile_recall_seen)
            ORDER BY created_at ASC LIMIT ?
        """, (max(1, min(int(limit), 100)),)).fetchall()
        conn.close()
        for row in rows:
            try:
                extracted = _extract(row["content"])
            except Exception as exc:
                _status["error"] = str(exc)[:180]
                break
            conn = get_conn()
            _init(conn)
            for key, value, evidence in extracted:
                conn.execute("""
                    INSERT OR IGNORE INTO avatar_profile_candidates
                      (key,value,evidence,conversation_id,observed_at)
                    VALUES (?,?,?,?,?)
                """, (key, value, evidence, row["id"], row["created_at"]))
                confirmations = conn.execute("""
                    SELECT count(DISTINCT conversation_id) FROM avatar_profile_candidates
                    WHERE key=? AND value=?
                """, (key, value)).fetchone()[0]
                if confirmations >= 2:
                    conn.execute("""
                        INSERT INTO avatar_profile_auto(key,value,evidence,conversation_id,observed_at)
                        VALUES (?,?,?,?,?)
                        ON CONFLICT(key) DO UPDATE SET value=excluded.value,
                          evidence=excluded.evidence, conversation_id=excluded.conversation_id,
                          observed_at=excluded.observed_at,
                          updated_at=datetime('now','localtime')
                        WHERE excluded.observed_at >= avatar_profile_auto.observed_at
                    """, (key, value, evidence, row["id"], row["created_at"]))
                    _status["saved"] += 1
            conn.execute("INSERT OR IGNORE INTO avatar_profile_recall_seen(conversation_id) VALUES (?)", (row["id"],))
            conn.commit()
            conn.close()
            _status["processed"] += 1
    except Exception as exc:
        _status["error"] = str(exc)[:180]
    finally:
        _status["last_run"] = datetime.now().isoformat(timespec="seconds")
        _status["running"] = False
        _lock.release()
    return status()


def schedule(limit=30):
    if not _status["running"]:
        threading.Thread(target=sync, args=(limit,), daemon=True).start()
    return status()
