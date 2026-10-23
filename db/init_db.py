"""
SQLite KG 데이터베이스 초기화
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "knowledge.db")


def get_conn():
    # timeout: 쓰기 락이 잡혀 있으면 즉시 실패하지 않고 최대 5초 대기 (sqlite3 레벨)
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")        # 동시 읽기 + 단일 쓰기 허용
    conn.execute("PRAGMA busy_timeout=5000")       # 락 경합 시 5초까지 대기 후 재시도 (database is locked 방지)
    conn.execute("PRAGMA synchronous=NORMAL")      # WAL 권장값 — fsync 빈도↓ → 락 점유 시간 단축
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

    CREATE TABLE IF NOT EXISTS user_profile (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS daily_sync (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        source_id   TEXT NOT NULL,
        title       TEXT,
        content     TEXT,
        synced_at   DATETIME DEFAULT (datetime('now','localtime')),
        UNIQUE(source, source_id)
    );

    CREATE TABLE IF NOT EXISTS conversations (
        id          TEXT PRIMARY KEY,
        view        TEXT NOT NULL,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL,
        created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_conv_created ON conversations(created_at);
    CREATE INDEX IF NOT EXISTS idx_conv_role    ON conversations(role);

    CREATE TABLE IF NOT EXISTS core_memory (
        id          TEXT PRIMARY KEY,
        content     TEXT NOT NULL,
        summary     TEXT NOT NULL DEFAULT '',
        is_pinned   INTEGER NOT NULL DEFAULT 1,
        memory_state TEXT NOT NULL DEFAULT 'active',
        use_count   INTEGER NOT NULL DEFAULT 0,
        last_used_at DATETIME,
        last_reviewed_at DATETIME,
        review_after DATETIME,
        source_kind TEXT NOT NULL DEFAULT 'direct_input',
        source_ref  TEXT DEFAULT '사용자 직접 입력',
        observed_at DATETIME DEFAULT (datetime('now','localtime')),
        confidence  REAL DEFAULT 1.0,
        approval_status TEXT NOT NULL DEFAULT 'approved',
        conflict_status TEXT NOT NULL DEFAULT 'unchecked',
        created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    -- 자문자답(암묵지) 캡처: 아바타가 질문 → 사용자가 1인칭으로 답 → 높은 신뢰의 지식으로 저장.
    -- 관리/목록 UI용 원본 테이블. 저장 시 KG 노드(source_type='self_interview')로도 반영된다.
    CREATE TABLE IF NOT EXISTS self_interview (
        id          TEXT PRIMARY KEY,
        question    TEXT NOT NULL,
        answer      TEXT NOT NULL,
        topic       TEXT DEFAULT '',
        node_id     TEXT,
        source_kind TEXT NOT NULL DEFAULT 'self_report',
        source_ref  TEXT DEFAULT '심층 인터뷰 직접 입력',
        observed_at DATETIME DEFAULT (datetime('now','localtime')),
        confidence  REAL DEFAULT 0.9,
        approval_status TEXT NOT NULL DEFAULT 'approved',
        conflict_status TEXT NOT NULL DEFAULT 'unchecked',
        created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_selfint_created ON self_interview(created_at);

    -- 구조화된 판단 사례: 자유 인터뷰와 별도로 실제 선택의 맥락과 트레이드오프를 보존한다.
    -- self_interview_id는 같은 내용을 KG에 저장한 원본 자문자답을 가리킨다.
    CREATE TABLE IF NOT EXISTS decision_cases (
        id                TEXT PRIMARY KEY,
        self_interview_id TEXT NOT NULL REFERENCES self_interview(id) ON DELETE CASCADE,
        topic             TEXT DEFAULT '',
        decision_type     TEXT NOT NULL,
        situation         TEXT NOT NULL,
        options_text      TEXT DEFAULT '',
        choice            TEXT NOT NULL,
        rationale         TEXT NOT NULL,
        rejected_options  TEXT DEFAULT '',
        exception_rule    TEXT DEFAULT '',
        confidence        INTEGER,
        source_kind       TEXT NOT NULL DEFAULT 'self_report',
        source_ref        TEXT DEFAULT '심층 인터뷰 직접 입력',
        observed_at       DATETIME DEFAULT (datetime('now','localtime')),
        approval_status   TEXT NOT NULL DEFAULT 'approved',
        conflict_status   TEXT NOT NULL DEFAULT 'unchecked',
        policy_version    TEXT NOT NULL DEFAULT 'v1',
        evidence_state    TEXT NOT NULL DEFAULT 'direct',
        created_at        DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_decision_cases_created ON decision_cases(created_at);
    CREATE INDEX IF NOT EXISTS idx_decision_cases_type ON decision_cases(decision_type);

    -- 아바타 AI 대화 중 자동 생성되는 노트. my-dashboard의 노트(daily_sync source='note')와는
    -- 별개 저장소 — file_path 접두사(avatar_note://)로 KG nodes 안에서도 출처를 구분한다.
    CREATE TABLE IF NOT EXISTS avatar_notes (
        id          TEXT PRIMARY KEY,
        view        TEXT NOT NULL,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        node_id     TEXT,
        created_at  DATETIME DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_avatar_notes_created ON avatar_notes(created_at);

    CREATE TABLE IF NOT EXISTS project_summaries (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        folder_path TEXT NOT NULL UNIQUE,
        file_tree_json TEXT,
        stats_json  TEXT,
        overview    TEXT,
        summary     TEXT,
        changes     TEXT,
        diagram     TEXT,
        export_path TEXT,
        status      TEXT DEFAULT 'pending',
        error       TEXT,
        created_at  DATETIME DEFAULT (datetime('now','localtime')),
        updated_at  DATETIME DEFAULT (datetime('now','localtime'))
    );
    """)

    try:
        c.execute("ALTER TABLE project_summaries ADD COLUMN export_path TEXT")
    except sqlite3.OperationalError:
        pass  # 이미 컬럼 존재 (기존 DB)

    try:
        c.execute("ALTER TABLE project_summaries ADD COLUMN diagram TEXT")
    except sqlite3.OperationalError:
        pass  # 이미 컬럼 존재 (기존 DB)

    try:
        c.execute("ALTER TABLE project_summaries ADD COLUMN graphified_at DATETIME")
    except sqlite3.OperationalError:
        pass  # 이미 컬럼 존재 (기존 DB) — 개별/일괄 Graphify 처리 완료 표시용

    # 기존 사용자의 DB도 메타데이터를 잃지 않고 점진적으로 확장한다.
    for table, column, definition in (
        ("core_memory", "source_kind", "TEXT NOT NULL DEFAULT 'direct_input'"),
        ("core_memory", "source_ref", "TEXT DEFAULT '사용자 직접 입력'"),
        ("core_memory", "observed_at", "DATETIME"),
        ("core_memory", "confidence", "REAL DEFAULT 1.0"),
        ("core_memory", "approval_status", "TEXT NOT NULL DEFAULT 'approved'"),
        ("core_memory", "conflict_status", "TEXT NOT NULL DEFAULT 'unchecked'"),
        # 기억 수명 주기: 고정 기억은 항상 유지하고, 나머지는 활성→요약→보관으로만
        # 내려간다. 원문(content)은 어떤 상태에서도 삭제하지 않는다.
        ("core_memory", "summary", "TEXT NOT NULL DEFAULT ''"),
        ("core_memory", "is_pinned", "INTEGER NOT NULL DEFAULT 1"),
        ("core_memory", "memory_state", "TEXT NOT NULL DEFAULT 'active'"),
        ("core_memory", "use_count", "INTEGER NOT NULL DEFAULT 0"),
        ("core_memory", "last_used_at", "DATETIME"),
        ("core_memory", "last_reviewed_at", "DATETIME"),
        ("core_memory", "review_after", "DATETIME"),
        ("self_interview", "source_kind", "TEXT NOT NULL DEFAULT 'self_report'"),
        ("self_interview", "source_ref", "TEXT DEFAULT '심층 인터뷰 직접 입력'"),
        ("self_interview", "observed_at", "DATETIME"),
        ("self_interview", "confidence", "REAL DEFAULT 0.9"),
        ("self_interview", "approval_status", "TEXT NOT NULL DEFAULT 'approved'"),
        ("self_interview", "conflict_status", "TEXT NOT NULL DEFAULT 'unchecked'"),
        ("decision_cases", "source_kind", "TEXT NOT NULL DEFAULT 'self_report'"),
        ("decision_cases", "source_ref", "TEXT DEFAULT '심층 인터뷰 직접 입력'"),
        ("decision_cases", "observed_at", "DATETIME"),
        ("decision_cases", "approval_status", "TEXT NOT NULL DEFAULT 'approved'"),
        ("decision_cases", "conflict_status", "TEXT NOT NULL DEFAULT 'unchecked'"),
        ("decision_cases", "policy_version", "TEXT NOT NULL DEFAULT 'v1'"),
        ("decision_cases", "evidence_state", "TEXT NOT NULL DEFAULT 'direct'"),
    ):
        try:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
        except sqlite3.OperationalError:
            pass  # 이미 컬럼 존재

    # 기존 DB에는 위 마이그레이션으로 policy_version을 먼저 만든 뒤 인덱스를 생성한다.
    c.execute("CREATE INDEX IF NOT EXISTS idx_decision_cases_policy ON decision_cases(policy_version)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_core_memory_lifecycle ON core_memory(is_pinned, memory_state, last_used_at)")

    conn.commit()
    conn.close()
    print(f"DB 초기화 완료: {DB_PATH}")


if __name__ == "__main__":
    init()
