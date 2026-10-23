"""임베딩 생성 + Chroma 벡터 저장"""
import os
import threading
from typing import Optional
import chromadb
from chromadb.api.types import Documents, EmbeddingFunction, Embeddings

CHROMA_PATH = os.path.join(os.path.dirname(__file__), "..", "db", "vectors")
_chroma_client = None
_collection = None

# 임베딩 모델: KURE-v1(bge-m3를 한국어 검색용으로 미세조정, 1024차원).
# 이전 기본값 MiniLM(all-MiniLM-L6-v2)은 영어 전용이라 한국어 문장을 뜻이 아니라 문장 모양("~해?")으로 묶었다.
# 2026-10-23 실측(내가 밝힌 기준 16개를 다른 말로 물어 대화 1,151개 중 정답 순위): MiniLM MRR 0.011
# → KURE-v1 0.566(16개 중 14개가 5위 안). multilingual-e5-base(0.593)는 1위 적중은 비슷하지만
# 거리가 0.12~0.21에 몰려 엔티티 병합 임계값을 잡을 수 없었다(Raspberry Pi 4 vs 5가 0.054).
# 모델을 바꾸면 벡터 공간이 달라지므로 컬렉션 이름도 바꾸고 scripts/reindex_embeddings.py로 다시 색인한다.
EMBED_MODEL = "nlpai-lab/KURE-v1"
COLLECTION_NAME = "mental_avatar_kure"
ENTITY_COLLECTION_NAME = "mental_avatar_entities_kure"
# 실행은 ONNX(onnxruntime CPU) + tokenizers로만 한다. torch·transformers(sentence-transformers)를 서버
# 프로세스에 올리면 faceswap의 onnxruntime-gpu와 충돌한다 — torch 먼저면 faceswap 모델 파싱이 깨지고
# (protobuf DecodeError), faceswap 먼저면 torch 추론이 네이티브 크래시(exit 139)로 서버째 죽는다(실측).
# onnxruntime도 기본값이면 CUDA/TensorRT 프로바이더를 탐색하다 깨진 cudnn/nvinfer DLL을 만나 죽으므로
# CPU 프로바이더만 쓴다(예전 MiniLM 때와 같은 이유). ONNX 파일은 scripts/export_embed_onnx.py가 만든다.
ONNX_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "models", "embed", "kure-v1"))
# 문서는 2,000자로 잘라 넣는다. 토큰 상한을 두지 않으면 CPU에서 긴 청크 하나에 수 초가 걸린다.
EMBED_MAX_TOKENS = 512

_model = None
_model_lock = threading.Lock()


def _get_model():
    """(tokenizer, onnx session). 모델 파일이 없으면 별도 프로세스로 내보내기부터 한다(수 분)."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                import onnxruntime as ort
                from tokenizers import Tokenizer
                if not os.path.exists(os.path.join(ONNX_DIR, "model.onnx")):
                    import subprocess
                    import sys
                    print(f"[embeddings] {ONNX_DIR} 없음 — {EMBED_MODEL} ONNX 내보내기 시작", flush=True)
                    script = os.path.join(os.path.dirname(__file__), "..", "scripts", "export_embed_onnx.py")
                    subprocess.run([sys.executable, script], check=True)
                tok = Tokenizer.from_file(os.path.join(ONNX_DIR, "tokenizer.json"))
                tok.enable_truncation(EMBED_MAX_TOKENS)
                tok.enable_padding(pad_id=tok.token_to_id("<pad>"), pad_token="<pad>")
                opts = ort.SessionOptions()
                opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)
                sess = ort.InferenceSession(os.path.join(ONNX_DIR, "model.onnx"), opts,
                                            providers=["CPUExecutionProvider"])
                _model = (tok, sess)
    return _model


def _encode(texts: list[str], batch_size: int = 16):
    import numpy as np
    tok, sess = _get_model()
    out = []
    for s in range(0, len(texts), batch_size):
        enc = tok.encode_batch(texts[s:s + batch_size])
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        cls = sess.run(None, {"input_ids": ids, "attention_mask": mask})[0][:, 0]   # KURE는 CLS 풀링
        out.append(cls / np.linalg.norm(cls, axis=1, keepdims=True))
    return np.concatenate(out) if out else np.zeros((0, 1024), dtype=np.float32)


def _preload():
    try:
        _encode(["워밍업"])
    except Exception as e:
        print(f"[embeddings] 임베딩 모델 로드 실패: {e}", flush=True)


class _KureEmbedFn(EmbeddingFunction[Documents]):
    def __init__(self) -> None:
        pass

    def __call__(self, input: Documents) -> Embeddings:
        return list(_encode(list(input)))

    @staticmethod
    def name() -> str:
        return "kure_v1"

    def get_config(self) -> dict:
        return {"model": EMBED_MODEL}

    @staticmethod
    def build_from_config(config: dict) -> "_KureEmbedFn":
        return _KureEmbedFn()

    def default_space(self):
        return "cosine"


_embed_fn = _KureEmbedFn()
_entity_collection = None
# 첫 질문이 모델 로드를 기다리지 않도록 import 시 백그라운드에서 미리 띄운다(내보내기 스크립트는 끔).
if not os.environ.get("MA_EMBED_NO_PRELOAD"):
    threading.Thread(target=_preload, daemon=True, name="embed-preload").start()

# 엔티티명 의미유사 매칭 임계값(cosine distance). KURE-v1 실측 보정(2026-10-23):
# 같은 것 — camera~Camera 0.045, 얼굴인식~얼굴 인식 0.070, 얼굴 인식~face recognition 0.072,
#   computer vision~Computer Vision 0.096, ChromaDB~Chroma DB 0.112, 지식 그래프~Knowledge Graph 0.134
# 다른 것 — 2D~3D 0.155, 단기 기억~장기 기억 0.161, Raspberry Pi 4~5 0.192, Neural Network~Deep Learning 0.202
# → 다른 것 중 가장 가까운 0.155 아래로 여유를 두고 0.12. 약어(CV, KG, LLM)는 0.45 이상이라 못 잡는다.
ENTITY_SIMILARITY_THRESHOLD = 0.12


def _get_client():
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(path=os.path.abspath(CHROMA_PATH))
    return _chroma_client


def _get_collection():
    global _collection
    if _collection is None:
        _collection = _get_client().get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
            embedding_function=_embed_fn,
        )
    return _collection


def _get_entity_collection():
    """엔티티명 전용 컬렉션 — 문서 청크(COLLECTION_NAME)와 분리해 엔티티끼리만 비교."""
    global _entity_collection
    if _entity_collection is None:
        _entity_collection = _get_client().get_or_create_collection(
            name=ENTITY_COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
            embedding_function=_embed_fn,
        )
    return _entity_collection


def index_entity(entity_id: str, name: str) -> None:
    """엔티티명을 임베딩 색인에 등록(신규 생성 시 호출). 실패해도 KG 자체엔 영향 없음."""
    col = _get_entity_collection()
    try:
        col.upsert(documents=[name], ids=[entity_id])
    except Exception as e:
        print(f"[embeddings] 엔티티 색인 실패 {entity_id}: {e}")


def find_similar_entity(name: str, threshold: float = ENTITY_SIMILARITY_THRESHOLD) -> Optional[dict]:
    """이름과 의미상 같은(=표기만 다른) 기존 엔티티를 찾는다. 없으면 None."""
    col = _get_entity_collection()
    try:
        if col.count() == 0:
            return None
        results = col.query(query_texts=[name], n_results=1)
        ids = results["ids"][0]
        if not ids:
            return None
        distance = results["distances"][0][0]
        if distance < threshold:
            return {"id": ids[0], "name": results["documents"][0][0], "distance": distance}
        return None
    except Exception as e:
        print(f"[embeddings] 엔티티 유사도 검색 실패: {e}")
        return None


def add_document(node_id: str, title: str, content: str, metadata: dict = None):
    """노드를 벡터 DB에 추가 (KURE-v1 임베딩)"""
    col = _get_collection()
    text = f"{title}\n{content}"[:2000]
    try:
        col.add(
            documents=[text],
            ids=[node_id],
            metadatas=[metadata or {}]
        )
    except Exception as e:
        # 이미 존재하면 업데이트
        try:
            col.update(documents=[text], ids=[node_id], metadatas=[metadata or {}])
        except Exception:
            print(f"[embeddings] 저장 실패 {node_id}: {e}")


def search(query: str, n_results: int = 10, where: dict = None) -> list[dict]:
    """시맨틱 검색. where로 메타데이터(source_type 등) 필터링 가능 — 청크/대화 분리 조회에 사용."""
    col = _get_collection()
    try:
        results = col.query(query_texts=[query], n_results=n_results, where=where)
        items = []
        for i, doc_id in enumerate(results["ids"][0]):
            items.append({
                "id": doc_id,
                "document": results["documents"][0][i],
                "metadata": results["metadatas"][0][i],
                "distance": results["distances"][0][i]
            })
        return items
    except Exception as e:
        print(f"[embeddings] 검색 실패: {e}")
        return []


def delete_document(node_id: str):
    """벡터 DB에서 노드 삭제 (문서/프로젝트 삭제 시 동기화)"""
    col = _get_collection()
    try:
        col.delete(ids=[node_id])
    except Exception:
        pass


def delete_documents(node_ids: list[str]) -> int:
    """여러 노드의 벡터를 한 번에 삭제. 실패해도 예외를 올리지 않고 0을 반환한다
    (SQLite 삭제는 이미 커밋된 뒤라, 벡터 삭제 실패가 삭제 전체를 되돌리면 안 됨)."""
    if not node_ids:
        return 0
    try:
        _get_collection().delete(ids=list(node_ids))
        return len(node_ids)
    except Exception as e:
        print(f"[embeddings] 벡터 일괄 삭제 실패({len(node_ids)}건): {e}", flush=True)
        return 0


def delete_entities(entity_ids: list[str]) -> int:
    """엔티티 전용 컬렉션에서 삭제. index_entity의 짝 — 이게 없으면 엔티티를 지워도
    이름 임베딩이 남아 upsert_entity가 죽은 엔티티에 매칭될 수 있다."""
    if not entity_ids:
        return 0
    try:
        _get_entity_collection().delete(ids=list(entity_ids))
        return len(entity_ids)
    except Exception as e:
        print(f"[embeddings] 엔티티 벡터 일괄 삭제 실패({len(entity_ids)}건): {e}", flush=True)
        return 0


def get_stats() -> dict:
    col = _get_collection()
    return {"vector_count": col.count()}
