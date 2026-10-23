"""기억 오염 필터 — 대화가 장기 기억(KG)에 들어가기 전에 소음·환각·에코를 걸러낸다.

문제: 음성 대화(STT)는 무음에서 지어낸 문구("다음 영상에서 만나요!")와 아바타 자신의 말이 마이크로
되돌아온 에코, 같은 말 반복 같은 소음이 섞여 '내 발언'으로 저장돼 KG·말투 학습·"내 과거 대화 사례"를
오염시켰다. 정상 발언은 그대로 자동 저장하고, 의심되는 것만 격리(영구 삭제 아님)한다.

판별은 결정론적 규칙이라 같은 입력은 같은 결과가 나온다. 확실한 것만 격리하고 애매한 건 통과시킨다
(지운 걸 되살리기보다 남긴 걸 지우는 게 쉽고, 격리함에서 하나씩 복원·삭제할 수 있다).
"""
import re

# 음성 인식(STT)을 거치는 화면 — 환각·에코 규칙은 여기에만 적용한다.
VOICE_VIEWS = {"avatar3d", "avatar3d_chat", "realistic_avatar"}
# 실험 잔재(세션20 안정성 실험)로 만든 화면
TEST_VIEWS = {"stability_test"}

# Whisper가 무음·잡음에서 지어내는 전형적 문구(영상 인사말 학습 데이터에서 유래)
HALLUCINATION = re.compile(
    r"구독|좋아요|알림 ?설정|다음 ?영상|시청해 ?주셔서|영상 ?편집|자막 ?제공|제작 ?지원|"
    r"MBC 뉴스|KBS 뉴스|SBS 뉴스|이덕영|감사합니다[.!]*$|잘 ?먹었습니다|마치겠습니다")
# 아바타(서비스 응대) 말투 — 사용자 발언에 섞여 들어오면 에코다
ASSISTANT_STYLE = re.compile(r"사용자님|도와드|드리겠|말씀해 ?주시|확인 ?부탁|분석해 ?드|제안해 ?드|궁금한 점|혹시 ")
AMBIENT_MAX_WORDS = 20   # 내가 타이핑한 문장 최대 19어절(저장된 말투 표본 41개 기준)
TRIVIAL = re.compile(
    r"^(안녕하세요|안녕|hi|hello|테스트( ?중)?|여보세요|음+|어+|응+|네+|넵|예+|아+|흠+|그래(요)?|좋아(요)?|ㅇㅋ|오케이|ok(ay)?|"
    r"해줘|해주세요|진행(해|해줘|해주세요)?|계속(해|해줘)?|맞아(요)?|그렇게 해(줘)?|고마워|감사합니다|땡큐)[?!.,\s~]*$", re.I)


def _shingles(text: str, n: int = 4) -> set[str]:
    t = re.sub(r"\s+", "", text)
    return {t[i:i + n] for i in range(max(0, len(t) - n + 1))}


def echo_overlap(utterance: str, assistant_text: str) -> float:
    """사용자 발언의 4글자 조각 중 직전 아바타 답에 들어 있는 비율 — 높으면 마이크로 되돌아온 에코."""
    a = _shingles(utterance)
    if not a or not assistant_text:
        return 0.0
    return len(a & _shingles(assistant_text)) / len(a)


def classify(text: str, view: str = "", prev_assistant: str = "") -> str | None:
    """격리해야 하면 사유 코드, 정상이면 None.
    사유: test(실험 잔재) / hallucination(STT 환각) / echo(아바타 에코) / ambient(주변 소리) / garble(반복 소음) / trivial(내용 없음)"""
    t = (text or "").strip()
    if view in TEST_VIEWS:
        return "test"
    if view in VOICE_VIEWS:
        if HALLUCINATION.search(t):
            return "hallucination"
        if prev_assistant and len(t) >= 12 and echo_overlap(t, prev_assistant) >= 0.5:
            return "echo"
        if ASSISTANT_STYLE.search(t) and len(t) >= 25:
            return "echo"
    if len(t) > 2000 or "```" in t:
        return "paste"           # 붙여넣은 긴 글·코드 — 내 판단이 아니라 자료다
    tokens = re.findall(r"\S+", t)
    if view in VOICE_VIEWS:
        # 내가 직접 타이핑한 문장은 최대 19어절(90%는 14어절 이하)이었다 — 음성 기록에서 20어절을 넘는 긴 문장은
        # TV·영상·옆 사람 소리를 마이크가 받아 적은 것이다. 영어가 한글보다 많은 문장도 같은 이유.
        if len(tokens) >= AMBIENT_MAX_WORDS:
            return "ambient"
        if len(tokens) >= 5 and len(re.findall(r"[A-Za-z]", t)) > len(re.findall(r"[가-힣]", t)):
            return "ambient"
    if len(re.findall(r"\d\. ", t)) >= 4:
        return "garble"
    if len(tokens) >= 6 and len(set(tokens)) / len(tokens) < 0.55:
        return "garble"
    if re.search(r"(\S{1,4})(\s*[,.]?\s*\1){3,}", t):
        return "garble"
    if TRIVIAL.match(t) or len(re.sub(r"[\W_]+", "", t)) < 3:
        return "trivial"
    return None


REASON_LABEL = {
    "test": "실험 잔재", "hallucination": "음성 인식 환각", "echo": "아바타 에코",
    "garble": "반복 소음", "trivial": "내용 없음", "ambient": "주변 소리", "paste": "붙여넣은 긴 글", "assistant": "아바타 답변",
}


# ── 저장소 연동 ─────────────────────────────────────────

def ensure_schema(conn) -> None:
    cols = [r[1] for r in conn.execute("PRAGMA table_info(conversations)")]
    if "quarantine_reason" not in cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN quarantine_reason TEXT")
    if "quarantined_at" not in cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN quarantined_at TEXT")
    # 대화 기록 가져오기에서 붙인 종류(기준·결정·목표·사실) — 검색할 때 "내 기준"과 일반 대화를 구분한다
    if "label" not in cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN label TEXT")
    conn.commit()


def classify_for_write(conn, view: str, content: str) -> str | None:
    """저장 직전 판별 — 같은 화면의 직전 아바타 답(에코 검사)과 같은 음성 문장의 반복 횟수까지 본다."""
    row = conn.execute(
        "SELECT content FROM conversations WHERE view=? AND role='assistant' ORDER BY created_at DESC LIMIT 1", (view,)).fetchone()
    reason = classify(content, view, row["content"] if row else "")
    if reason is None and view in VOICE_VIEWS and len(content.strip()) < 40:
        same = conn.execute("SELECT COUNT(*) FROM conversations WHERE view=? AND role='user' AND content=?", (view, content.strip())).fetchone()[0]
        if same >= 2:
            return "hallucination"   # 음성에서 같은 문장이 세 번째 = 지어낸 문구
    return reason


def _node_title(view: str, content: str) -> str:
    return f"[{view}] user: " + (content[:40] + "…" if len(content) > 40 else content)


def _conv_node_ids(conn, rows) -> list[str]:
    ids = []
    for r in rows:
        node = conn.execute("SELECT id FROM nodes WHERE file_path=?", (f"conversation://{r['view']}/{r['id']}",)).fetchone()
        if node:
            ids.append(node["id"])
    return ids


def _drop_nodes(conn, node_ids: list[str]) -> None:
    """KG 노드만 지운다(대화 행은 남김). 엣지는 FK CASCADE, 벡터는 함께 지운다."""
    from . import embeddings
    for i in range(0, len(node_ids), 400):
        chunk = node_ids[i:i + 400]
        conn.execute("DELETE FROM nodes WHERE id IN (%s)" % ",".join("?" * len(chunk)), chunk)
    conn.commit()
    embeddings.delete_documents(node_ids)


def sweep(dry_run: bool = False) -> dict:
    """기존 대화를 전부 다시 판별해 오염된 것을 KG에서 빼고 격리한다. 아바타 답변 노드도 KG에서 뺀다
    (아바타의 말은 내 지식이 아니다). 대화 행은 지우지 않는다(격리 사유만 기록, 복원 가능)."""
    from db.init_db import get_conn
    conn = get_conn()
    ensure_schema(conn)
    rows = [dict(r) for r in conn.execute(
        "SELECT id, view, role, content, created_at, quarantine_reason FROM conversations ORDER BY created_at")]
    repeats = {}
    for r in rows:
        if r["role"] == "user" and r["view"] in VOICE_VIEWS:
            key = (r["view"], r["content"].strip())
            repeats[key] = repeats.get(key, 0) + 1
    last_assistant, flagged, assistants = {}, [], []
    for r in rows:
        if r["role"] == "assistant":
            last_assistant[r["view"]] = r["content"]
            assistants.append(r)
            continue
        if r["quarantine_reason"]:
            continue
        reason = classify(r["content"], r["view"], last_assistant.get(r["view"], ""))
        if reason is None and r["view"] in VOICE_VIEWS and len(r["content"].strip()) < 40 \
                and repeats.get((r["view"], r["content"].strip()), 0) >= 3:
            reason = "hallucination"
        if reason:
            flagged.append((reason, r))
    by_reason: dict[str, int] = {}
    for reason, _ in flagged:
        by_reason[reason] = by_reason.get(reason, 0) + 1
    user_node_ids = _conv_node_ids(conn, [r for _, r in flagged])
    assistant_node_ids = _conv_node_ids(conn, assistants)
    result = {"quarantined": len(flagged), "by_reason": by_reason, "user_nodes_removed": len(user_node_ids),
              "assistant_nodes_removed": len(assistant_node_ids), "dry_run": dry_run}
    if dry_run:
        conn.close()
        return result
    conn.executemany("UPDATE conversations SET quarantine_reason=?, quarantined_at=datetime('now','localtime') WHERE id=?",
                     [(reason, r["id"]) for reason, r in flagged])
    conn.commit()
    _drop_nodes(conn, user_node_ids + assistant_node_ids)
    conn.close()
    return result


def list_quarantined() -> list[dict]:
    from db.init_db import get_conn
    conn = get_conn()
    ensure_schema(conn)
    rows = [dict(r) for r in conn.execute(
        "SELECT id, view, content, created_at, quarantine_reason AS reason, quarantined_at FROM conversations "
        "WHERE quarantine_reason IS NOT NULL ORDER BY created_at DESC")]
    conn.close()
    for r in rows:
        r["reason_label"] = REASON_LABEL.get(r["reason"], r["reason"])
    return rows


def restore(conv_id: str) -> dict:
    """격리를 풀고 다시 KG에 저장한다(정상 발언으로 확인했을 때)."""
    from db.init_db import get_conn
    from . import graph, embeddings
    conn = get_conn()
    ensure_schema(conn)
    row = conn.execute("SELECT id, view, content FROM conversations WHERE id=? AND quarantine_reason IS NOT NULL", (conv_id,)).fetchone()
    if not row:
        conn.close()
        raise ValueError("격리된 발언을 찾을 수 없습니다")
    conn.execute("UPDATE conversations SET quarantine_reason=NULL, quarantined_at=NULL WHERE id=?", (conv_id,))
    conn.commit()
    conn.close()
    title = _node_title(row["view"], row["content"])
    node_id = graph.add_node(type="conversation", title=title, content=row["content"], source_type="conversation",
                             file_path=f"conversation://{row['view']}/{row['id']}")
    embeddings.add_document(node_id, title, row["content"], {"source_type": "conversation", "view": row["view"], "role": "user"})
    return {"restored": conv_id}


def delete_quarantined(conv_id: str | None = None) -> int:
    """격리함에서 영구 삭제(하나 또는 전부)."""
    from db.init_db import get_conn
    conn = get_conn()
    ensure_schema(conn)
    if conv_id:
        cur = conn.execute("DELETE FROM conversations WHERE id=? AND quarantine_reason IS NOT NULL", (conv_id,))
    else:
        cur = conn.execute("DELETE FROM conversations WHERE quarantine_reason IS NOT NULL")
    n = cur.rowcount
    conn.commit()
    conn.close()
    return n
