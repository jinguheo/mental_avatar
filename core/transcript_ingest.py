"""Claude Code·Codex 대화 자동 백업 + 판단 사례 수집 + KG 자동 저장.

모든 창(세션)의 대화는 ~/.claude/projects/<프로젝트>/<세션>.jsonl 에 줄 단위로 쌓인다. 이 모듈이 세 가지를 한다.

Codex(OpenAI)도 ~/.codex/sessions/<연>/<월>/<일>/rollout-*.jsonl 에 같은 식으로 쌓이므로 똑같이 처리한다
(승인 심사용 보조 세션·AGENTS.md 지침·앱 상태 알림은 내가 쓴 글이 아니라서 뺀다).

1) 백업: 그 파일들을 backups/claude_transcripts/, backups/codex_sessions/ 로 그대로 복사한다(원본 보존 — 보관 기간이 지나 지워져도 남음).
2) 판단 사례 수집: 내가 타이핑한 메시지마다 "직전에 Claude가 말한 것(맥락) → 내가 한 답" 짝을 저장한다.
   이 짝은 내 입력·결정을 예측하는 모델의 학습·시험 데이터이고, 일치(sync)를 재는 보류 사례가 된다.
3) KG 저장: 내가 쓴 글 중 오래 남길 만한 것(기준·사실·목표·결정)만 KG에 넣는다. 일회성 작업 지시·상태 보고·질문·
   맞장구는 KG에 넣지 않는다(원본과 판단 사례에는 남음). 제외한 것은 화면에서 보고 직접 KG에 넣을 수 있다.

내 글만 쓴다: 도구 출력·시스템 알림·슬래시 명령 표시·붙여넣은 긴 글은 빼고, Claude의 답은 KG에 넣지 않는다.
파일은 추가만 되므로 파일별 읽은 위치(offset)를 기억해 새로 생긴 줄만 처리한다.

종류 판정은 결정론 규칙(명령·붙여넣기·내용 없음)을 먼저 적용하고, 남은 것만 로컬 LLM이 분류한다. 작은 모델은
중요한 선호를 놓치므로(예: "반말은 항상 쓰지 않아"를 질문으로 분류) 선호·원칙 표지가 뚜렷하면 모델과 무관하게 남긴다.
"""
import hashlib
import json
import re
import shutil
import threading
import time
import urllib.request
from datetime import datetime
from pathlib import Path

from db.init_db import get_conn

ROOT = Path.home() / ".claude" / "projects"
BACKUP_ROOT = Path(__file__).parent.parent / "backups" / "claude_transcripts"
CODEX_ROOT = Path.home() / ".codex" / "sessions"
CODEX_BACKUP = Path(__file__).parent.parent / "backups" / "codex_sessions"
CODEX_NOISE = re.compile(r"<(external_codex_apps_open_page|environment_context|user_instructions|turn_aborted|in-app-browser-context|recommended_plugins)\b[^>]*>.*?</\1>", re.S)
CODEX_SKIP_PREFIX = ("# In app browser:", "# AGENTS.md instructions", "The following is the Codex agent history", "<user_action>", "<subagent_notification>")
MAX_KG_CHARS = 1200          # 이보다 긴 메시지는 붙여넣은 글·로그일 가능성이 커 KG에는 넣지 않는다(원본엔 있음)
CONTEXT_CHARS = 1500         # 판단 사례에 저장하는 직전 Claude 발화 길이
LABEL_MODEL = "gemma4:e2b"   # e4b는 GPU 메모리가 부족하면 실행 중 비정상 종료(0xc0000409)해 안정적인 e2b를 쓴다
LABEL_BATCH = 40             # 한 번 돌 때 판정하는 최대 건수(서버 응답성과 GPU 점유를 위해 나눠서)
KEEP_LABELS = {"기준", "사실", "목표", "결정"}

TAGS = re.compile(
    r"<(system-reminder|local-command-caveat|local-command-stdout|command-name|command-message|command-args|"
    r"ci-monitor-event|task-notification)\b[^>]*>.*?</\1>|<pasted_content\b[^>]*>.*?</pasted_content[^>]*>", re.S)
# 선호·원칙·의도·결정 기준의 표지(키워드)
STANCE = re.compile(
    r"좋겠|싶어|싶다|싶은|원해|원하|바라|선호|중요|필요해|필요하|해야|하면 ?안|하지 ?마|말고|대신|항상|절대|반드시|"
    r"기본값|디폴트|default|왠만하면|가능하면|우선|목표|방향|원칙|기준|내가 ?(하고|원|생각)|하기로|싫어|좋아해|마음에 ?(들|안)|걱정|고민|"
    r"비용|가급적|위주로|~?만 ?(써|사용)|사용하지")
COMMAND_END = re.compile(
    r"(해줘|해주세요|해 ?줘|해봐|해보자|진행해|진행해줘|고쳐줘|수정해|수정해줘|확인해|확인해줘|보여줘|알려줘|추가해|추가해줘|만들어|만들어줘|"
    r"실행해|실행해줘|열어줘|켜줘|꺼줘|지워줘|삭제해|삭제해줘|커밋해|푸시해|써줘|정리해줘|분석해줘|찾아줘|다시 ?해|돌려줘)[.!?\s]*$")
LOGLIKE = re.compile(r"Traceback|Error:|Exception|\bat \w+\.\w+|[A-Z]:\\|https?://|node_modules|^\s*(npm|pip|git|wsl|conda)\b")

LABEL_PROMPT = """너는 한 사람이 AI 코딩 도우미에게 쓴 메시지를 분류한다. 이 사람에 대해 오래 기억할 가치가 있는지 판단한다.

분류(한 단어만 답해라):
기준 = 앞으로도 따를 선호·원칙·가치·제약·결정 기준 (예: "C 드라이브 대신 가급적 D 드라이브를 써줘", "간단하면서 강력하고 학습이 잘 되는 모델이 좋아", "비용이 많이 드는 건 피하고 싶어")
사실 = 이 사람·환경·프로젝트에 대해 오래 유지되는 사실 (예: "서버에서 여러 개의 게이트를 컨트롤하려고 해", "모든 통합 인증 정보는 D:\\MyWork\\FaceRec에 있어")
목표 = 만들려는 것의 방향·목적 (예: "MICA 형태가 최종 형태가 되면 좋겠어")
결정 = 선택지 중 무엇을 고른다는 결정과 이유 (예: "A안으로 가자, 속도가 더 중요해")
지시 = 한 번 시키는 작업 요청 (예: "재시작해줘", "커밋하고 push 해줘", "이 파일 수정해줘")
반응 = 결과에 대한 일회성 반응·상태 보고·오류 신고 (예: "아무것도 안 나와", "지금 동작해", "좀 좋아졌어")
질문 = 정보를 묻는 말 (예: "카메라 부분은 어떻게 해?")
잡담 = 인사·맞장구·내용 없음

메시지: {text}
분류:"""

_lock = threading.Lock()
_status = {"running": False, "phase": "", "last_run": None, "last_error": None, "last_result": None}


def _init(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS transcript_state (path TEXT PRIMARY KEY, offset INTEGER NOT NULL DEFAULT 0,
        last_assistant TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS transcript_ingested (
        key TEXT PRIMARY KEY, view TEXT, project TEXT, created_at TEXT, text TEXT,
        label TEXT, kept INTEGER NOT NULL DEFAULT 0, logged INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS decision_pairs (
        key TEXT PRIMARY KEY, project TEXT, session TEXT, created_at TEXT, context TEXT, reply TEXT, label TEXT);
    CREATE INDEX IF NOT EXISTS idx_ti_pending ON transcript_ingested(label);
    """)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(transcript_ingested)")]
    for name, ddl in (("project", "TEXT"), ("text", "TEXT"), ("label", "TEXT"), ("kept", "INTEGER NOT NULL DEFAULT 0"), ("logged", "INTEGER NOT NULL DEFAULT 0"),
                       ("source", "TEXT"), ("session", "TEXT"), ("source_file", "TEXT")):
        if name not in cols:
            conn.execute("ALTER TABLE transcript_ingested ADD COLUMN %s %s" % (name, ddl))
    # 이전 버전에서 들어간 행의 출처는 키(세션:시각:해시)와 프로젝트 이름으로 복원한다
    conn.execute("UPDATE transcript_ingested SET session=substr(key,1,instr(key,':')-1) WHERE session IS NULL")
    conn.execute("UPDATE transcript_ingested SET source=CASE WHEN project LIKE 'codex--%' THEN 'codex' ELSE 'claude' END WHERE source IS NULL")
    sc = [r[1] for r in conn.execute("PRAGMA table_info(transcript_state)")]
    if "last_assistant" not in sc:
        conn.execute("ALTER TABLE transcript_state ADD COLUMN last_assistant TEXT")
    conn.commit()


def _flat(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
    return ""


def clean(text: str) -> str:
    t = TAGS.sub("", text or "").strip()
    return "" if t.startswith("[SYSTEM NOTIFICATION") else t


def human_text(entry: dict) -> str | None:
    """JSONL 한 줄에서 '내가 타이핑한' 텍스트만 꺼낸다(없으면 None)."""
    kind = entry.get("type")
    if kind == "user":
        if entry.get("isMeta") or entry.get("isSidechain") or entry.get("isCompactSummary"):
            return None
        return clean(_flat(entry.get("message", {}).get("content"))) or None
    if kind == "attachment":
        att = entry.get("attachment", {})
        if att.get("type") == "queued_command" and "human" in str(att.get("origin")):   # 작업 중에 끼워 보낸 메시지
            return clean(_flat(att.get("prompt"))) or None
    return None


def assistant_text(entry: dict) -> str | None:
    if entry.get("type") != "assistant" or entry.get("isSidechain"):
        return None
    return _flat(entry.get("message", {}).get("content")).strip() or None


def _codex_flat(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") in ("input_text", "output_text", "text"))
    return ""


def codex_user_text(entry: dict) -> str | None:
    p = entry.get("payload") or {}
    if entry.get("type") != "response_item" or p.get("type") != "message" or p.get("role") != "user":
        return None
    t = CODEX_NOISE.sub("", _codex_flat(p.get("content"))).strip()
    if t.startswith("# Files mentioned by the user") and "## My request for Codex:" in t:
        t = t.split("## My request for Codex:", 1)[1].strip()   # 첨부 파일 목록 뒤에 실제 내 요청이 온다
    return None if not t or t.startswith(CODEX_SKIP_PREFIX) else t


def codex_assistant_text(entry: dict) -> str | None:
    p = entry.get("payload") or {}
    if entry.get("type") != "response_item" or p.get("type") != "message" or p.get("role") != "assistant":
        return None
    return _codex_flat(p.get("content")).strip() or None


def codex_meta(path: Path) -> dict | None:
    """첫 줄(session_meta). 승인 심사용 보조 세션(subagent)이면 None — 내가 쓴 글이 없다."""
    try:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            first = json.loads(fh.readline())
    except (OSError, ValueError):
        return None
    meta = first.get("payload") or {}
    return None if isinstance(meta.get("source"), dict) else meta


def codex_project(meta: dict) -> str:
    cwd = (meta.get("cwd") or "").replace("\\", "/").rstrip("/")
    name = cwd.rsplit("/", 1)[-1] if cwd else "unknown"
    return "codex--" + re.sub(r"[^\w.-]+", "_", name)


def view_for(project_dir: str) -> str:
    if project_dir.startswith("codex--"):
        return "cx_" + project_dir[len("codex--"):]
    return "cc_" + re.sub(r"^[dD]--MyWork-", "", project_dir).replace("/", "_")


def _local_time(iso: str | None) -> str | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def session_files() -> list[Path]:
    return sorted(ROOT.glob("*/*.jsonl")) if ROOT.is_dir() else []


def codex_files() -> list[Path]:
    return sorted(CODEX_ROOT.rglob("rollout-*.jsonl")) if CODEX_ROOT.is_dir() else []


# ── 1) 원본 백업 ────────────────────────────────────────

def mirror() -> dict:
    copied = skipped = total = 0
    pairs = [(f, BACKUP_ROOT / f.parent.name / f.name) for f in session_files()]
    pairs += [(f, CODEX_BACKUP / f.relative_to(CODEX_ROOT)) for f in codex_files()]
    for src, dest in pairs:
        st = src.stat()
        total += st.st_size
        if dest.exists() and dest.stat().st_size == st.st_size and dest.stat().st_mtime >= st.st_mtime - 1:
            skipped += 1
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        copied += 1
    return {"files": copied + skipped, "copied": copied, "unchanged": skipped, "source_mb": round(total / 1024 / 1024, 1)}


# ── 2) 판단 사례 + 규칙 판정 ─────────────────────────────

def _read_new_lines(path: Path, offset: int) -> tuple[list[str], int]:
    if path.stat().st_size <= offset:
        return [], offset
    with open(path, "rb") as fh:
        fh.seek(offset)
        chunk = fh.read()
    cut = chunk.rfind(b"\n")
    if cut < 0:
        return [], offset            # 아직 한 줄이 덜 써졌다
    return chunk[:cut].decode("utf-8", errors="ignore").split("\n"), offset + cut + 1


def rule_label(text: str) -> str | None:
    """LLM 없이 확실히 가를 수 있는 것: 내용 없음/붙여넣기/로그·경로/짧은 작업 지시. 애매하면 None(모델이 판정)."""
    from . import memory_filter
    t = text.strip()
    reason = memory_filter.classify(t, "cc")
    if reason in ("trivial", "garble"):
        return "잡담"
    if reason == "paste" or len(t) > MAX_KG_CHARS or "```" in t:
        return "붙여넣기"
    stance = bool(STANCE.search(t))
    if LOGLIKE.search(t) and not stance:
        return "로그"
    if COMMAND_END.search(t) and len(t) < 40 and not stance:
        return "지시"
    if len(t) < 8 and not stance:
        return "반응"
    return None


def collect(backfill: bool = True) -> dict:
    """새 메시지를 훑어 판단 사례와 말투 표본을 저장하고, KG에 넣을지는 '대기(label=NULL)'로 표시한다."""
    from . import self_summary
    conn = get_conn()
    _init(conn)
    res = {"messages": 0, "new": 0, "pairs": 0, "duplicates": 0, "files": 0}
    for path in session_files() + codex_files():
        is_codex = CODEX_ROOT in path.parents
        meta = None
        if is_codex:
            meta = codex_meta(path)
            if meta is None:
                continue
        state = conn.execute("SELECT offset, last_assistant FROM transcript_state WHERE path=?", (str(path),)).fetchone()
        if state is None and not backfill:
            conn.execute("INSERT INTO transcript_state(path, offset, updated_at) VALUES (?,?,datetime('now','localtime'))", (str(path), path.stat().st_size))
            conn.commit()
            continue
        offset = state["offset"] if state else 0
        last_assistant = state["last_assistant"] if state else None
        lines, new_offset = _read_new_lines(path, offset)
        if not lines and state:
            continue
        res["files"] += 1
        project = codex_project(meta) if is_codex else path.parent.name
        view = view_for(project)
        samples: list[str] = []
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            said = codex_assistant_text(entry) if is_codex else assistant_text(entry)
            if said:
                last_assistant = said
                continue
            text = codex_user_text(entry) if is_codex else human_text(entry)
            if not text or len(text) < 2:
                continue
            res["messages"] += 1
            ts = _local_time(entry.get("timestamp"))
            key = "%s:%s:%s" % (path.stem, entry.get("timestamp", ""), hashlib.sha1(text.encode("utf-8")).hexdigest()[:12])
            if conn.execute("SELECT 1 FROM transcript_ingested WHERE key=?", (key,)).fetchone():
                res["duplicates"] += 1
                continue
            label = rule_label(text)
            conn.execute(
                "INSERT OR IGNORE INTO transcript_ingested(key, view, project, created_at, text, label, source, session, source_file) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (key, view, project, ts, text[:MAX_KG_CHARS], label, "codex" if is_codex else "claude", path.stem, str(path)))
            conn.execute(
                "INSERT OR IGNORE INTO decision_pairs(key, project, session, created_at, context, reply, label) VALUES (?,?,?,?,?,?,?)",
                (key, project, path.stem, ts, (last_assistant or "")[-CONTEXT_CHARS:], text[:3000], label))
            res["new"] += 1
            res["pairs"] += 1
            if 6 <= len(text) <= 300 and label not in ("붙여넣기", "로그", "잡담"):
                samples.append(text)   # 내가 직접 타이핑한 글은 말투 표본으로도 쌓는다(쓰기 잠금 때문에 커밋 뒤에 넣는다)
        conn.execute(
            "INSERT INTO transcript_state(path, offset, last_assistant, updated_at) VALUES (?,?,?,datetime('now','localtime')) "
            "ON CONFLICT(path) DO UPDATE SET offset=excluded.offset, last_assistant=excluded.last_assistant, updated_at=excluded.updated_at",
            (str(path), new_offset, (last_assistant or "")[-CONTEXT_CHARS:]))
        conn.commit()
        for text in samples:
            try:
                self_summary.add_sample(text, "typed")
            except ValueError:
                pass
    conn.close()
    return res


# ── 3) LLM 종류 판정 → KG 저장 ───────────────────────────

def _llm_label(text: str) -> str | None:
    payload = json.dumps({"model": LABEL_MODEL, "stream": False, "think": False,
                          "messages": [{"role": "user", "content": LABEL_PROMPT.format(text=text[:400])}],
                          "options": {"temperature": 0, "num_predict": 8}}).encode()
    from . import pattern
    req = urllib.request.Request(pattern.OLLAMA_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.loads(resp.read())["message"]["content"]
    out = re.sub(r"[*`\s]|분류:", "", out)
    if "선호" in out:
        return "기준"
    for name in ("기준", "사실", "목표", "결정", "지시", "반응", "질문", "잡담"):
        if name in out:
            return name
    return None


def decide_keep(label: str, text: str) -> tuple[str, bool]:
    """모델 판정 + 키워드 표지로 최종 라벨과 KG 저장 여부. 선호 표지가 뚜렷하면 모델이 놓쳐도 남긴다."""
    strong = bool(STANCE.search(text)) and len(text) >= 14 and not COMMAND_END.search(text)
    if label in KEEP_LABELS:
        return label, True
    if strong and label in ("질문", "반응", "잡담", "지시"):
        return "기준", True
    return label, False


def label_pending(limit: int = LABEL_BATCH) -> dict:
    """대기 중인 메시지를 모델이 분류하고 KG에 넣을 것만 저장한다. 같은 문장은 한 번만 넣는다."""
    from . import avatar
    conn = get_conn()
    _init(conn)
    rows = [dict(r) for r in conn.execute(
        "SELECT key, view, created_at, text FROM transcript_ingested WHERE label IS NULL ORDER BY created_at LIMIT ?", (limit,))]
    res = {"labeled": 0, "kept": 0, "pending_left": 0, "errors": 0}
    for r in rows:
        norm = re.sub(r"\s+", " ", r["text"].strip().lower())
        dup = conn.execute("SELECT 1 FROM transcript_ingested WHERE logged=1 AND lower(replace(text,'  ',' '))=? LIMIT 1", (norm,)).fetchone()
        same = conn.execute("SELECT label FROM transcript_ingested WHERE label IS NOT NULL AND text=? LIMIT 1", (r["text"],)).fetchone()
        try:
            label = same["label"] if same else _llm_label(r["text"])   # 같은 문장("좋아" 등)은 다시 묻지 않는다
        except Exception:  # noqa: BLE001 — 모델이 응답 못 하면 다음 주기에 다시 시도한다
            res["errors"] += 1
            break
        if label is None:
            label = "반응"
        label, keep = decide_keep(label, r["text"])
        logged = 0
        if keep and not dup:
            try:
                reason = avatar.log_conversation(r["view"], "user", r["text"], created_at=r["created_at"])
                logged = 0 if reason else 1
            except Exception:  # noqa: BLE001
                res["errors"] += 1
        conn.execute("UPDATE transcript_ingested SET label=?, kept=?, logged=? WHERE key=?", (label, 1 if keep else 0, logged, r["key"]))
        conn.execute("UPDATE decision_pairs SET label=? WHERE key=?", (label, r["key"]))
        conn.commit()
        res["labeled"] += 1
        res["kept"] += logged
    res["pending_left"] = conn.execute("SELECT COUNT(*) FROM transcript_ingested WHERE label IS NULL").fetchone()[0]
    conn.close()
    return res


def promote(key: str) -> dict:
    """제외된 메시지를 내가 직접 KG에 넣는다."""
    from . import avatar
    conn = get_conn()
    _init(conn)
    row = conn.execute("SELECT key, view, created_at, text, logged FROM transcript_ingested WHERE key=?", (key,)).fetchone()
    if not row:
        conn.close()
        raise ValueError("메시지를 찾을 수 없습니다")
    if not row["logged"]:
        avatar.log_conversation(row["view"], "user", row["text"], created_at=row["created_at"])
    conn.execute("UPDATE transcript_ingested SET kept=1, logged=1, label='기준(직접)' WHERE key=?", (key,))
    conn.commit()
    conn.close()
    return {"promoted": key}


def excluded(limit: int = 80, label: str = "", saved: bool = False) -> list[dict]:
    """saved=False면 KG에서 제외한 것, True면 KG에 저장한 것. 어느 도구·프로젝트·세션·원본 파일에서 왔는지 함께 돌려준다."""
    conn = get_conn()
    _init(conn)
    cond = "logged=1" if saved else "kept=0 AND label IS NOT NULL AND label NOT IN ('붙여넣기','로그')"
    sql = "SELECT key, view, created_at, text, label, source, project, session, source_file FROM transcript_ingested WHERE " + cond
    params: list = []
    if label:
        sql += " AND label=?"
        params.append(label)
    sql += " ORDER BY created_at DESC LIMIT ?" if saved else " ORDER BY length(text) DESC, created_at DESC LIMIT ?"
    params.append(limit)
    rows = [dict(r) for r in conn.execute(sql, params)]
    for r in rows:
        f = r.get("source_file")
        root, back = (CODEX_ROOT, CODEX_BACKUP) if r.get("source") == "codex" else (ROOT, BACKUP_ROOT)
        try:
            r["backup_file"] = str(back / Path(f).relative_to(root)) if f else None
        except ValueError:
            r["backup_file"] = None
    conn.close()
    return rows


def browse(source: str = "claude", group: str = "date", q: str = "", label: str = "", groups: int = 40, per_group: int = 30) -> dict:
    """도구(claude/codex)별로 내가 쓴 메시지를 날짜·프로젝트·종류별로 묶어 보여준다. 'saved'는 KG에 들어간 것."""
    key_sql = {"date": "substr(created_at,1,10)", "project": "project", "label": "COALESCE(label,'대기')"}.get(group)
    if key_sql is None or source not in ("claude", "codex"):
        raise ValueError("source는 claude/codex, group은 date/project/label 이어야 합니다")
    where = ["COALESCE(source,'claude')=?", "1=1"]
    params: list = [source]
    if q:
        where.append("text LIKE ?")
        params.append("%" + q + "%")
    if label:
        where.append("COALESCE(label,'대기')=?")
        params.append(label)
    cond = " AND ".join(where)
    conn = get_conn()
    _init(conn)
    heads = [dict(r) for r in conn.execute(
        "SELECT %s AS k, COUNT(*) AS n, COALESCE(SUM(logged),0) AS saved, MAX(created_at) AS last FROM transcript_ingested WHERE %s "
        "GROUP BY k ORDER BY %s LIMIT ?" % (key_sql, cond, "k DESC" if group == "date" else "n DESC"), params + [groups])]
    total = conn.execute("SELECT COUNT(*), COALESCE(SUM(logged),0) FROM transcript_ingested WHERE " + cond, params).fetchone()
    for h in heads:
        h["items"] = [dict(r) for r in conn.execute(
            "SELECT key, created_at, text, COALESCE(label,'대기') AS label, logged AS saved, project, session FROM transcript_ingested "
            "WHERE %s AND %s=? ORDER BY created_at DESC LIMIT ?" % (cond, key_sql), params + [h["k"], per_group])]
        h["k"] = h["k"] if h["k"] is not None else "(날짜 없음)"
        if group == "project":
            h["k"] = re.sub(r"^(codex--|[dD]--MyWork-?)", "", h["k"]) or "(루트)"
    conn.close()
    return {"source": source, "group": group, "total": total[0], "saved": total[1], "groups": heads}


def run_once(backfill: bool = True, label_limit: int = LABEL_BATCH) -> dict:
    if not _lock.acquire(blocking=False):
        return {"error": "이미 실행 중입니다"}
    try:
        _status.update(running=True, phase="백업")
        backup = mirror()
        _status["phase"] = "수집"
        coll = collect(backfill)
        _status["phase"] = "분류·저장"
        lab = label_pending(label_limit)
        result = {"backup": backup, "collect": coll, "label": lab}
        _status.update(last_run=time.strftime("%Y-%m-%d %H:%M:%S"), last_error=None, last_result=result)
        return result
    except Exception as exc:  # noqa: BLE001
        _status["last_error"] = str(exc)
        raise
    finally:
        _status.update(running=False, phase="")
        _lock.release()


def loop(interval: int = 90, first_delay: int = 20) -> None:
    """서버가 켜져 있는 동안 주기적으로 백업·수집·분류한다. 처음엔 모든 세션의 지난 기록을 가져오고, 분류가 밀려
    있으면 쉬지 않고 이어서 처리한다."""
    time.sleep(first_delay)
    while True:
        pending = 0
        try:
            result = run_once(backfill=True)
            pending = result.get("label", {}).get("pending_left", 0) if isinstance(result, dict) else 0
        except Exception as exc:  # noqa: BLE001
            _status["last_error"] = str(exc)
        time.sleep(5 if pending else interval)


def status() -> dict:
    conn = get_conn()
    _init(conn)
    by_label = {r["label"] or "대기": r["n"] for r in conn.execute("SELECT label, COUNT(*) AS n FROM transcript_ingested GROUP BY label")}
    by_source = {r["source"] or "claude": r["n"] for r in conn.execute("SELECT source, COUNT(*) AS n FROM transcript_ingested GROUP BY source")}
    per = [dict(r) for r in conn.execute(
        "SELECT project, COUNT(*) AS n, SUM(logged) AS saved FROM transcript_ingested GROUP BY project ORDER BY n DESC")]
    pairs = conn.execute("SELECT COUNT(*) FROM decision_pairs").fetchone()[0]
    pairs_ctx = conn.execute("SELECT COUNT(*) FROM decision_pairs WHERE length(context) > 0").fetchone()[0]
    total = conn.execute("SELECT COUNT(*) FROM transcript_ingested").fetchone()[0]
    saved = conn.execute("SELECT COALESCE(SUM(logged),0) FROM transcript_ingested").fetchone()[0]
    conn.close()
    backed = sum(f.stat().st_size for d in (BACKUP_ROOT, CODEX_BACKUP) if d.is_dir() for f in d.rglob("*.jsonl"))
    return {**_status, "root": str(ROOT), "backup_dir": str(BACKUP_ROOT), "sessions": len(session_files()), "codex_sessions": len(codex_files()),
            "backup_mb": round(backed / 1024 / 1024, 1), "messages_total": total, "kg_saved": saved,
            "pending": by_label.get("대기", 0), "by_label": by_label, "by_source": by_source, "by_project": per,
            "decision_pairs": pairs, "decision_pairs_with_context": pairs_ctx}
