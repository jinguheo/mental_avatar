# Mental Avatar — 세션 로그

---

## 2026-05-28 (세션 1) — 설계

### 논의 내용
- my-dashboard에서 작성한 노트, URL 요약, PDF 요약, AI 채팅을 KG화하고 싶음
- 로컬 PDF, Word, Excel 등 문서도 포함
- 단순 KG가 아닌 "정신적 아바타" 개념으로 확장
  - 내가 뭘 고민하고 어떻게 생각하는지까지 담는 존재
  - 시간이 지날수록 나를 더 잘 아는 시스템

### 설계 결정사항
- **위치**: `D:\MyWork\mental-avatar\` (my-dashboard와 분리된 독립 프로젝트)
  - 이유: 다른 관심사, 크게 성장할 것, Python 중심 백엔드
- **문서 접근**: `docs/` 하위 폴더에 복사하는 방식 (외부 폴더 접근 없음)
- **포트**: 8766 (my-dashboard MCP: 8765와 분리)
- **저장소**: SQLite (그래프) + Chroma (벡터)
- **Python 환경**: conda `avatar` (3.11)
- **엔티티 추출**: Claude API structured output
- **파서**: pymupdf, python-docx, openpyxl, python-pptx

### 생성된 파일/폴더
```
D:\MyWork\mental-avatar\
├── DESIGN.md          ✅ 전체 설계 문서
├── SESSION_LOG.md     ✅ 이 파일
├── docs/
│   ├── pdf/
│   ├── word/
│   ├── excel/
│   ├── pptx/
│   └── other/
├── core/
├── watcher/
│   └── parsers/
├── api/
├── agent/
├── db/
└── tests/
```

### 다음 세션 할 일 (Phase 1) → 완료됨

---

## 2026-05-28 (세션 2) — Phase 1 구현 완료

### 완료된 작업
- [x] conda 환경 `avatar` (Python 3.11) 생성
- [x] 패키지 설치: flask, pymupdf, python-docx, openpyxl, python-pptx, watchdog, chromadb, networkx, anthropic, sentence-transformers
- [x] SQLite 스키마 (`db/init_db.py`) — nodes, edges, topics, node_topics, activity_log
- [x] 파서 4종: `watcher/parsers/` — pdf, docx, excel, pptx
- [x] core 모듈: `graph.py` (CRUD), `extractor.py` (Claude API), `embeddings.py` (Chroma)
- [x] Flask API 서버 `api/server.py` — /ingest, /search, /topics, /stats, /graph, /recommend, /health
- [x] 파일 감시자 `watcher/file_watcher.py` (watchdog)
- [x] 일괄 import `watcher/import_existing.py`
- [x] `config.yaml`, `requirements.txt`

### 서버 상태
- API 서버: http://127.0.0.1:8766 ✅ 실행 중
- DB: `db/knowledge.db` 초기화 완료 (노드 0, 엣지 0)
- 벡터 DB: `db/vectors/` Chroma 준비 완료

### 사용 방법
```bash
# 서버 시작
conda activate avatar
python api/server.py

# 파일 감시자 시작 (별도 터미널)
python watcher/file_watcher.py

# 기존 파일 일괄 import
python watcher/import_existing.py

# docs/ 폴더에 파일 복사하면 자동 처리
```

### 다음 Phase 2 할 일 → 대부분 완료

---

## 2026-05-28 (세션 3) — Phase 2 구현

### 완료된 작업
- [x] `.env` 로더 `core/env.py` + `.env.example` (extractor가 키 자동 인식)
- [x] 패턴 분석기 `core/pattern.py`:
  - `topic_trends()` 관심사 트렌드 (상승/하락/신규/휴면)
  - `core_interests()` 핵심 관심사 (중요도×문서수)
  - `knowledge_gaps()` 지식 갭 (얕은 주제)
  - `apply_decay()` 망각 모델 (오래된 노드 중요도 감소)
  - `avatar_summary()` 1인칭 자기 요약 (LLM)
- [x] `agent/searcher.py` 자율 검색어 생성 (관심사+갭 기반)
- [x] `agent/recommender.py` 추천(related_to_recent) + 교차 연결고리(cross_connections)
- [x] API 확장: `/avatar/summary`, `/pattern/trends`, `/pattern/interests`, `/pattern/gaps`, `/connections`, `/recommend/related`, `/enrich`, `/decay`
- [x] my-dashboard `stock_mcp_server.py`에 `kg.*` 프록시 툴 추가:
  - `kg.add`, `kg.search`, `kg.summary`, `kg.stats` (→ avatar 8766 호출)

### End-to-End 테스트 결과 ✅
- 노트 ingest → SQLite 노드 + Chroma 벡터 저장 정상
- 시맨틱 검색: "GPU 메모리 최적화" → Flash Attention 노트 매칭 성공
- **임베딩/검색은 API 키 없이 로컬(sentence-transformers)로 동작 확인**
- 테스트 후 DB 정리 (노드 0)

### 중요 결정 — LLM 연결 방식
**Claude.ai 구독 재활용** 선택 (별도 API 키 안 씀)
- avatar의 extractor/pattern LLM 작업을 dashboard의 `claude.chat` MCP로 라우팅
- 추가 키·비용 없음
- **다음 세션 첫 작업: extractor.py와 pattern.py가 ANTHROPIC_API_KEY 대신
  dashboard MCP claude.chat을 호출하도록 수정**

### 미완료 (다음 세션)
- [ ] **extractor/pattern → claude.chat MCP 라우팅으로 변경** (핵심)
- [ ] my-dashboard MCP 재시작 후 kg.* 프록시 동작 검증 (세션 중 재시작 미완)
- [ ] avatar 자동 시작 등록 (start_dashboard.bat에 avatar API + watcher 추가)
- [ ] 실제 문서 docs/ 복사 후 일괄 import 테스트
- [ ] 대시보드 KG 패널 UI (Phase 4)

### 현재 서버 상태
- avatar API: http://127.0.0.1:8766 ✅ 실행 중 (Phase 2 엔드포인트 포함)
- dashboard MCP: 8765 — kg.* 툴 코드 추가됨, **재시작 필요** (반영 안 된 상태)

---

## 2026-05-29 (세션 4) — 미완 항목 처리 + 버그 수정

### 완료된 작업

#### 1. extractor/pattern → dashboard MCP 라우팅 (핵심)
- [x] `core/claude_mcp.py` 신규 생성
  - `chat()`: dashboard MCP `/mcp` JSON-RPC로 `claude.chat` 호출
  - `is_available()`: 3초 타임아웃으로 MCP 생존 여부 확인
- [x] `core/extractor.py` 수정 — MCP 우선 → API 키 fallback → 기본값
- [x] `core/pattern.py` 수정 — `_llm_call()` 헬퍼 추출, 동일 우선순위 적용

#### 2. dashboard MCP 재시작 + kg.* 프록시 검증
- [x] MCP 서버 재시작 (PID 10448)
- [x] avatar API 시작 (8766)
- [x] `kg.stats`, `kg.add`, `kg.search` JSON-RPC 직접 호출로 동작 확인

#### 3. start_dashboard.bat 자동 시작 등록
- [x] Avatar API (8766) 자동 시작 추가
- [x] Avatar Watcher 자동 시작 추가 (WINDOWTITLE 기반 중복 체크)

#### 4. 실제 문서 import 테스트
- [x] 샘플 노트 5개 API 직접 ingest 성공
- [x] `watcher/import_existing.py` UTF-8 인코딩 수정 (`-X utf8` 플래그)
- [x] `watcher/parsers/__init__.py` 수정 — `.md` source_type `unknown` → `note`, title 파일명으로 개선
- [x] `core/graph.py` 중복 방지 추가 — `file_hash + chunk_index`로 기존 노드 반환
- [x] docs/ 내 파일 2개(PDF 1, MD 1) import 성공

#### 5. 대시보드 KG 패널 UI
- [ ] **미완 — 다음 세션에서 진행**

### 현재 DB 상태 (정리 필요)
- nodes: 11 (pdf: 2, note: 7, unknown: 2) — 구 데이터 중복 포함
- **다음 세션 첫 작업: DB 초기화 후 재import하면 깔끔해짐**
  - pdf: 1, note: 6(샘플5+md1), unknown: 0 이 정상 목표치

### 다음 세션 할 일
- [ ] **DB 초기화** (`db/knowledge.db` 삭제 후 `python db/init_db.py` 재실행)
- [ ] 재import (`import_existing.py`) — 깔끔한 상태에서 시작
- [ ] **대시보드 KG 패널 UI** (Phase 4)
  - my-dashboard `src/views/` 에 `KnowledgeGraph.tsx` 추가
  - 검색 + 아바타 요약 + 그래프 시각화 탭 구조

### 현재 서버 상태
- avatar API: http://127.0.0.1:8766 ✅ 실행 중
- dashboard MCP: http://127.0.0.1:8765 ✅ 실행 중 (kg.* 프록시 검증 완료)

---
