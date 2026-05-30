# Mental Avatar — 설계 문서

> 작성일: 2026-05-28  
> 개념: 나의 지식, 사고 패턴, 관심사를 담은 정신적 아바타  
> 위치: `D:\MyWork\mental-avatar\`

---

## 1. 개념 정의

단순한 지식 DB가 아닌 **나처럼 생각하는 AI** 를 목표로 한다.

```
일반 KG   →  내가 본 것들의 색인
아바타    →  내가 왜 봤는지, 어떻게 연결했는지,
             무엇을 고민 중인지를 아는 존재
```

### 아바타가 가진 레이어

| 레이어 | 내용 | 예시 |
|--------|------|------|
| 지식 | 뭘 아는가 | 개념, 논문, 문서, 요약 |
| 사고 패턴 | 어떻게 생각하는가 | 자주 묻는 질문 유형, 개념 연결 방식 |
| 무게 | 무엇을 중요하게 여기는가 | 자주 돌아오는 주제, 오래 머문 문서 |
| 시간 | 어떻게 진화하는가 | 관심사 변화, 사고의 전환점 |

---

## 2. 데이터 소스

### 2-1. 로컬 문서 (`docs/` 하위 복사)
| 폴더 | 파일 타입 | 파서 |
|------|-----------|------|
| `docs/pdf/` | `.pdf` | pymupdf (fitz) |
| `docs/word/` | `.docx`, `.doc` | python-docx |
| `docs/excel/` | `.xlsx`, `.xls` | openpyxl + pandas |
| `docs/pptx/` | `.pptx` | python-pptx |
| `docs/other/` | `.txt`, `.md` | 직접 읽기 |

### 2-2. Dashboard 연동 (실시간)
- 노트 저장 이벤트 → API 전달
- URL 요약 결과 → API 전달
- PDF 요약 결과 → API 전달
- AI 채팅 요약 → API 전달 (주기적)

---

## 3. 시스템 아키텍처

```
[입력 계층]
  docs/ 폴더 파일     →  File Watcher (watchdog)
  dashboard 이벤트    →  HTTP POST → API Server

[처리 계층]
  파서 (파일 타입별)
      ↓
  청킹 (의미 단위 분할, ~1000 tokens)
      ↓
  Claude API: 엔티티·관계·인사이트 추출 (structured output)
      ↓
  임베딩 생성 (Claude Embeddings or sentence-transformers)

[저장 계층]
  SQLite (knowledge.db)   ← 그래프 구조, 메타데이터
  Chroma (vectors/)       ← 임베딩 벡터, 시맨틱 검색

[지능 계층]
  패턴 분석기             ← 주제 클러스터링, 관심사 추적
  추천 엔진               ← 지식 갭 탐지, 관련 자료 제안
  자율 검색 에이전트      ← 패턴 기반 웹 검색 → KG 보강

[출력 계층]
  API 서버 (포트 8766)    ← dashboard / 외부 쿼리
  알림                    ← "새 연결고리 발견", "지식 갭 감지"
```

---

## 4. KG 데이터 모델

### 노드 (nodes)
```sql
CREATE TABLE nodes (
    id          TEXT PRIMARY KEY,      -- UUID
    type        TEXT NOT NULL,         -- 'doc'|'chunk'|'concept'|'person'|'tool'|'paper'
    title       TEXT,
    content     TEXT,                  -- 원문 또는 요약
    source_type TEXT,                  -- 'pdf'|'docx'|'xlsx'|'note'|'url'|'chat'
    file_path   TEXT,                  -- 원본 파일 경로
    file_hash   TEXT,                  -- 변경 감지
    chunk_index INTEGER DEFAULT 0,     -- 긴 문서 분할 순서
    importance  REAL DEFAULT 0.5,      -- 중요도 (접근 빈도 기반)
    created_at  DATETIME,
    updated_at  DATETIME
);
```

### 엣지 (edges)
```sql
CREATE TABLE edges (
    id          TEXT PRIMARY KEY,
    from_id     TEXT REFERENCES nodes(id),
    to_id       TEXT REFERENCES nodes(id),
    relation    TEXT,   -- 'relates_to'|'part_of'|'cites'|'implements'|'contradicts'|'applied_to'
    weight      REAL DEFAULT 1.0,
    created_at  DATETIME
);
```

### 토픽 (topics)
```sql
CREATE TABLE topics (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    description TEXT,
    updated_at  DATETIME
);

CREATE TABLE node_topics (
    node_id     TEXT REFERENCES nodes(id),
    topic_id    TEXT REFERENCES topics(id),
    score       REAL   -- 토픽 관련도
);
```

### 활동 로그 (activity_log) — 아바타의 핵심
```sql
CREATE TABLE activity_log (
    id          TEXT PRIMARY KEY,
    node_id     TEXT REFERENCES nodes(id),
    action      TEXT,   -- 'created'|'viewed'|'searched'|'linked'|'enriched'
    context     TEXT,   -- 어떤 흐름에서 발생했는지
    timestamp   DATETIME
);
```

---

## 5. 엔티티 추출 스키마 (Claude structured output)

```json
{
  "entities": [
    {"name": "Flash Attention", "type": "concept", "description": "..."}
  ],
  "relations": [
    {"from": "Flash Attention", "to": "Transformer", "relation": "implements"}
  ],
  "topics": ["AI 추론 최적화", "어텐션 메커니즘"],
  "key_insights": ["...", "..."],
  "questions_raised": ["이 방식이 멀티모달에도 적용 가능한가?"],
  "importance": 0.8
}
```

---

## 6. 파일 처리 파이프라인

### PDF
1. pymupdf로 텍스트 + 섹션 추출
2. 표·수식 감지 → 별도 청크
3. 참고문헌 파싱 → 인용 엣지 생성

### Word (.docx)
1. 제목 계층 (H1/H2/H3) → 구조 보존
2. 코멘트/메모 → 별도 노드 (내 사고 흔적)
3. 표 → 구조화 텍스트

### Excel (.xlsx)
1. 시트별 분리
2. Claude로 "이 시트의 목적" 파악
3. 헤더 + 샘플 데이터 → 의미 추출
4. 수식 패턴 → 분석 의도 추론

### PPT (.pptx)
1. 슬라이드 순서 보존
2. 제목 → 발표 흐름 추출
3. 핵심 텍스트 + 스피커 노트

---

## 7. 패턴 분석 (아바타 추론)

### 관심사 추적
- 최근 30일 노드별 접근 빈도
- 토픽별 문서 수 + 증가율
- "요즘 자주 보는 것" vs "오래 안 돌아온 것"

### 지식 갭 탐지
- 토픽 A에 관련 문서 많음 → 연결된 토픽 B 문서 부족 → 갭
- 질문 노드(`questions_raised`) 중 답변 없는 것

### 자율 검색 트리거
```
패턴: "LLM 추론 최적화" 관련 문서 12개 + 최근 5일간 3건 추가
갭:   "하드웨어 레벨 최적화" 관련 문서 1개
→ 검색: "LLM inference hardware optimization 2025"
→ my-dashboard web.summarize 호출
→ 결과 KG에 추가 (사용자 확인 후)
```

---

## 8. API 엔드포인트 (포트 8766)

```
POST /ingest          문서 또는 텍스트 KG에 추가
GET  /search?q=       시맨틱 검색
GET  /topics          현재 주제 목록 + 비중
GET  /recommend       패턴 기반 추천
GET  /graph?id=       특정 노드 중심 그래프
GET  /avatar/summary  나의 지식 현황 요약
POST /enrich          자율 검색 보강 실행
GET  /stats           KG 통계 (노드 수, 엣지 수, 토픽 등)
```

---

## 9. Dashboard 연결

`my-dashboard`의 `stock_mcp_server.py`에 프록시 툴 추가:

```python
# 기존 MCP 서버에 추가
kg.add      →  POST http://127.0.0.1:8766/ingest
kg.search   →  GET  http://127.0.0.1:8766/search
kg.topics   →  GET  http://127.0.0.1:8766/topics
kg.recommend → GET  http://127.0.0.1:8766/recommend
```

---

## 10. 기술 스택

| 역할 | 라이브러리 | 비고 |
|------|-----------|------|
| API 서버 | Flask | 포트 8766 |
| 파일 감시 | watchdog | `docs/` 폴더 |
| PDF 파싱 | pymupdf (fitz) | 표·이미지 캡션 포함 |
| Word 파싱 | python-docx | |
| Excel 파싱 | openpyxl, pandas | |
| PPT 파싱 | python-pptx | |
| 엔티티 추출 | Claude API | structured output |
| 임베딩 | Claude Embeddings API | |
| 벡터 저장 | chromadb | 로컬 |
| 그래프 저장 | SQLite | 로컬 |
| 그래프 분석 | networkx | 중심성, 클러스터링 |
| Python 환경 | conda `avatar` (Python 3.11) | |

---

## 11. 구현 단계 (Phases)

### Phase 1 — 기반 구조 (1~2일)
- [ ] conda 환경 `avatar` 생성 + 패키지 설치
- [ ] SQLite 스키마 + Chroma 초기화
- [ ] Flask API 서버 기본 (`/ingest`, `/search`, `/stats`)
- [ ] 파서: PDF, Word, Excel, PPT
- [ ] `docs/` 기존 파일 일괄 import 스크립트

### Phase 2 — 지능 연결 (2~3일)
- [ ] Claude API 엔티티 추출 파이프라인
- [ ] 임베딩 생성 + Chroma 저장
- [ ] 파일 감시자 (watchdog) — 새 파일 자동 처리
- [ ] `/topics`, `/recommend`, `/graph` API

### Phase 3 — 아바타 추론 (2~3일)
- [ ] 패턴 분석기 (관심사 추적, 지식 갭 탐지)
- [ ] 자율 검색 에이전트
- [ ] Dashboard 연결 (MCP 프록시 툴)
- [ ] `/avatar/summary` — 나의 지식 현황 리포트

### Phase 4 — 시각화 (2일)
- [ ] Dashboard KG 패널 (D3.js 그래프)
- [ ] 토픽 트렌드 차트
- [ ] 추천 알림 UI

---

## 12. 설계 원칙

1. **맥락 보존** — 문서 자체보다 왜 저장했는지가 더 중요
2. **망각 모델** — 오래 안 돌아온 주제는 중요도 감소 (인간 기억처럼)
3. **능동성** — 연결고리 발견 시 먼저 알림
4. **1인칭** — "사용자는 X에 관심 있음"이 아니라 "나는 X를 이렇게 이해하고 있음"
5. **완전 로컬** — 모든 데이터 로컬 저장, 클라우드 전송 없음
6. **점진적** — 처음부터 완벽하지 않아도 됨, 쓸수록 똑똑해짐
