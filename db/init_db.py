"""
SQLite KG 데이터베이스 초기화
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "knowledge.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init():
    conn = get_conn()
    c = conn.cursor()

    c.executescript("""
    CREATE TABLE IF NOT EXISTS nodes (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        title       TEXT,
        content     TEXT,
        source_type TEXT,
        file_path   TEXT,
        file_hash   TEXT,
        chunk_index INTEGER DEFAULT 0,
        importance  REAL    DEFAULT 0.5,
        created_at  DATETIME DEFAULT (datetime('now','localtime')),
        updated_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS edges (
        id          TEXT PRIMARY KEY,
        from_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        to_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        relation    TEXT NOT NULL,
        weight      REAL DEFAULT 1.0,
        created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS topics (
        id          TEXT PRIMARY KEY,
        name        TEXT UNIQUE NOT NULL,
        description TEXT,
        updated_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS node_topics (
        node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        topic_id    TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
        score       REAL DEFAULT 1.0,
        PRIMARY KEY (node_id, topic_id)
    );

    CREATE TABLE IF NOT EXISTS activity_log (
        id          TEXT PRIMARY KEY,
        node_id     TEXT REFERENCES nodes(id) ON DELETE SET NULL,
        action      TEXT NOT NULL,
        context     TEXT,
        timestamp   DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_type       ON nodes(type);
    CREATE INDEX IF NOT EXISTS idx_nodes_source     ON nodes(source_type);
    CREATE INDEX IF NOT EXISTS idx_edges_from       ON edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to         ON edges(to_id);
    CREATE INDEX IF NOT EXISTS idx_activity_node    ON activity_log(node_id);
    CREATE INDEX IF NOT EXISTS idx_activity_time    ON activity_log(timestamp);

    CREATE TABLE IF NOT EXISTS wiki_pages (
        id          TEXT PRIMARY KEY,
        node_id     TEXT REFERENCES nodes(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL UNIQUE,
        title       TEXT NOT NULL,
        ollama_summary TEXT,
        wiki_content   TEXT,
        status      TEXT DEFAULT 'pending',
        created_at  DATETIME DEFAULT (datetime('now','localtime')),
        updated_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_wiki_node ON wiki_pages(node_id);
    CREATE INDEX IF NOT EXISTS idx_wiki_status ON wiki_pages(status);

    CREATE TABLE IF NOT EXISTS subjects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL UNIQUE,
        folder_path TEXT NOT NULL,
        description TEXT DEFAULT '',
        priority    INTEGER DEFAULT 5,
        created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS processing_queue (
        id          TEXT PRIMARY KEY,
        subject_id  TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
        file_path   TEXT NOT NULL,
        file_name   TEXT NOT NULL,
        status      TEXT DEFAULT 'pending',
        stage       TEXT DEFAULT 'ingest',
        error       TEXT,
        queued_at   DATETIME DEFAULT (datetime('now','localtime')),
        processed_at DATETIME
    );

    CREATE INDEX IF NOT EXISTS idx_queue_subject ON processing_queue(subject_id);
    CREATE INDEX IF NOT EXISTS idx_queue_status  ON processing_queue(status);
    """)

    conn.commit()
    conn.close()
    print(f"DB 초기화 완료: {DB_PATH}")


if __name__ == "__main__":
    init()
