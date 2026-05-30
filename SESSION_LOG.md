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

## 2026-05-30 (세션 5) — Phase 4 UI + Wiki + graphify + 큐 시스템

### 완료된 작업

#### 1. DB 초기화 + 재import
- [x] `db/knowledge.db` + `db/vectors/` 삭제 후 클린 재초기화
- [x] 샘플 노트 5개 파일 생성 (vision_system, step_parsing, image_alignment, business_model, ai_roadmap)
- [x] docs/ 전체 13개 파일 import (note:6, pdf:3, pptx:4) — unknown 0개

#### 2. 대시보드 KG 패널 UI (Phase 4) 완성
- [x] `KnowledgeGraph.tsx` — 탭 4개: 검색·요약 / 그래프 / 파일 / Wiki
- [x] 검색 탭: 시맨틱 검색 + 통계 바 + 아바타 요약 (streamClaudeWeb 직접 호출로 전환)
- [x] 그래프 탭: force-directed SVG + 필터 (문서/개념/전체) + 문서·개념 노드 구분 시각화
- [x] App.tsx에 `settings` props 연결

#### 3. claude_mcp.py 개선
- [x] `my-dashboard/.claude_session_key` 자동 로드 (만료 시 재연결 안내)
- [x] MCP 서버(8765) 자동 감지 + 빈 session_key 처리

#### 4. extractor.py 개선
- [x] 키워드 기반 fallback 토픽 추출 추가 (LLM 없이도 topics 생성)
- [x] 12개 주제 시드 (컴퓨터 비전, CAD/도면 처리, 이미지 정렬, 품질 검증 등)

#### 5. graph.py 개선
- [x] `upsert_entity()` — entity 노드 중복 방지 upsert
- [x] `_entity_id_by_name()` — 이름으로 entity 노드 조회

#### 6. 벡터 유사도 엣지 자동 생성
- [x] `/graph/link_similar` 엔드포인트 추가
- [x] 임계값 기반 similar_to 엣지 자동 생성
- [x] 현재 KG: nodes 41, edges 251

#### 7. Wiki 생성 파이프라인 (Ollama → Claude)
- [x] `core/wiki.py` 신규:
  - Ollama(`gemma4:e2b`) 1차 구조화 요약 (JSON 형식)
  - Claude MCP 2차 wiki 형식 재구성
  - 개념 노드 → KG entity 연결 (`_link_concepts_to_node`)
- [x] `db/init_db.py`에 `wiki_pages` 테이블 추가
- [x] `/wiki/list`, `/wiki/<id>`, `/wiki/generate`, `/wiki/generate_all` 엔드포인트
- [x] Wiki 탭 UI: 페이지 목록 + 마크다운 렌더링(react-markdown)
- [x] 전체 생성 결과: 40개 wiki 페이지 (ollama_only 상태 — Claude rate limit)
- [x] KG entity 437개 자동 추출 (wiki 생성 시 개념 → entity 노드 연결)

#### 8. 파일 탭 → 주체별 처리 큐로 개편
- [x] `core/queue_mgr.py` 신규:
  - `subjects` 테이블: 폴더 단위 주체 관리
  - `processing_queue` 테이블: 파일별 처리 상태 추적
  - `auto_discover_subjects()`: docs/ 하위 폴더 자동 등록
  - `process_next()`: ingest + wiki 생성 배치 처리
- [x] `/subjects`, `/queue`, `/queue/process`, `/queue/reset_errors` 엔드포인트
- [x] 파일 탭 UI 3-View: 주체 목록 / 큐 상태 / 파일 직접 열기
- [x] 주체 5개 자동 등록: other(6), pdf(3), pptx(4), word(0), excel(0)

#### 9. graphify 통합
- [x] `pip install graphifyy` 설치
- [x] docs/ 폴더 대상 graphify 파이프라인 실행:
  - 43 nodes, 48 edges, 9 communities
  - 5개 하이퍼엣지 (Core Verification Pipeline, STEP Processing Stack 등)
- [x] `graphify-out/graph.html` — 브라우저 인터랙티브 그래프
- [x] God Node: `3Dto2DVerify System` (16 edges — 모든 커뮤니티 연결)
- [x] Surprising: DepthAny PDF → 2D Projection, Agentic Flow → Predictive Maintenance

#### 10. GitHub 초기 push
- [x] `git init` + remote 설정 + `.gitignore` 정비
- [x] 초기 커밋 (29파일, 2729줄)
- [x] https://github.com/jinguheo/mental_avatar push 완료

### 현재 시스템 상태
- avatar API: http://127.0.0.1:8766 ✅
- dashboard: http://localhost:5173 ✅
- DB: nodes 478 (concept:437, note:6, pdf:3, pptx:32), edges 905
- Wiki: 40페이지 (ollama_only — Claude 세션 재연결 시 done으로 업그레이드 가능)

### 다음 세션 할 일
- [ ] Claude.ai 세션 재연결 → wiki `done` 상태 업그레이드
- [ ] ANTHROPIC_API_KEY `.env` 추가 (선택) → 더 안정적인 LLM 연결
- [ ] graphify `--update` 로 새 문서 증분 처리
- [ ] 주체별 큐 실제 배치 처리 검증

---

## 2026-05-30 (세션 6) — Avatar Studio (모드 A: 영상)

### 논의 / 결정
- 실제 얼굴 + 합성 아바타 + 목소리 UI 구축 요청
- 파이프라인 확정: **텍스트 → Coqui XTTS v2(내 목소리 클로닝) → SadTalker(립싱크) → mp4**
- 얼굴: 업로드 방식 / 목소리: 본인 wav 샘플 등록(클로닝) / 실시간 불필요(배치 생성)
- 용도: 발표·홍보 자료, 웹 임베드(클라우드 배포는 Phase 3, 클라우드 미정)
- UI: my-dashboard 사이드바 "◉ 아바타" 탭 추가 (별도 앱 아님)
- **모드 B (3D 인터랙티브)는 Phase 2로 분리** — 모드 A 완성 후 착수
  - Inworld AI 조사: 3D 모델 직접 생성 X(avatar-agnostic), Ready Player Me/MetaHuman 연결.
    실시간 대화가 본업, 음성 클로닝 무료. 웹 패키지(RPM + Inworld Web SDK + three.js)로 결정.

### 핵심 변경 (deviation)
- SadTalker(numpy 1.23.4) ↔ Coqui XTTS(numpy≥1.24.3) **의존성 충돌**
  → conda 환경 분리: `avatar`=SadTalker+Flask, `xtts`=Coqui TTS. server.py가 subprocess로 각각 호출.

### 완료
- [x] 설계 스펙 + 구현 플랜 작성 (docs/superpowers/) — brainstorming→writing-plans→executing-plans
- [x] SadTalker 클론 (D:\MyWork\SadTalker) + 모델 8개 다운로드 완료
      (256/512 safetensors, mapping x2, gfpgan weights x4)
- [x] Flask 엔드포인트 3개 추가 (api/server.py):
      `/avatar/register_voice`, `/avatar/voice_status`, `/avatar/tts_generate`
- [x] 프론트: AvatarStudio.tsx 신규 + Sidebar/View타입/App.tsx 라우팅
- [x] **검증(GPU 불필요분 전부 통과):**
      - register_voice(8s wav 저장+duration), voice_status(false→true), tts_generate 입력검증(400)
      - 브라우저 E2E: 아바타 탭 렌더 + "목소리 등록됨 ✓" (프론트↔백 연동 확인)
      - 스크린샷: avatar-studio-verify.png
- [x] git push 완료 (mental_avatar master, my_dashboard main)

### 미완 (내일 이어서)
- [ ] **설치 미완** — torch 2.5.1+cu121 다운로드 중단됨(세션 종료). 재실행 필요:
      `D:\MyWork\mental-avatar\docs\superpowers\plans\2026-05-30-avatar-studio.md` Task 1 참고
      1) avatar: `pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu121`
      2) avatar: `pip install -r D:\MyWork\SadTalker\requirements.txt`
      3) `conda create -n xtts python=3.11 -y` → 같은 torch 설치 → `pip install coqui-tts`
- [ ] **예상 이슈**: basicsr 1.4.2가 torchvision 0.20의 제거된 `functional_tensor` import →
      `degradations.py`의 `torchvision.transforms.functional_tensor` → `functional` 한 줄 패치
- [ ] SadTalker 샘플 실행 검증 → tts_generate 풀 파이프라인 curl → 브라우저 영상 생성 E2E (Task 6)

### 현재 상태
- 코드: 완료·커밋·푸시 ✅  /  설치: 미완(torch 단계)  /  모델: 완료 ✅
- 서버 8766 / 대시보드 5173 — 세션 종료 시 함께 종료됨 (내일 재시작)
- 환경: avatar(SadTalker용, torch 설치중), xtts(미생성)

---
