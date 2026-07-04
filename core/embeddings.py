"""임베딩 생성 + Chroma 벡터 저장"""
import os
from typing import Optional
import chromadb
from chromadb.utils import embedding_functions

CHROMA_PATH = os.path.join(os.path.dirname(__file__), "..", "db", "vectors")
_chroma_client = None
_collection = None

# ChromaDB 기본 임베딩(ONNXMiniLM)은 onnxruntime을 쓰는데, 이 환경엔 faceswap용 onnxruntime-gpu가
# 깔려 있어 기본값이면 CUDA/TensorRT 프로바이더를 탐색하다 깨진 cudnn/nvinfer DLL을 만나 프로세스가
# 통째로 죽는다(try/except로 못 잡는 네이티브 크래시). CPU 프로바이더만 쓰도록 강제해 회피한다.
# name()을 'default'로 맞춰 기존 컬렉션(기본 임베딩으로 생성됨)과의 임베딩 함수 충돌도 회피한다.
class _CPUEmbedFn(embedding_functions.ONNXMiniLM_L6_V2):
    def name(self) -> str:
        return "default"

_embed_fn = _CPUEmbedFn(preferred_providers=["CPUExecutionProvider"])
_entity_collection = None

# 엔티티명 의미유사 매칭 임계값(cosine distance). 실측 보정: 대소문자/사소한 표기차이
# (camera vs Camera, computer vision vs Computer Vision)는 distance~0.0, 관련되지만
# 다른 개념(Neural Network vs Deep Learning)은 0.33 → 그 사이인 0.08로 안전하게 설정.
# 이 모델(MiniLM, 영어중심)은 한↔영 동의어/약어(CV vs Computer Vision)는 못 잡는다.
ENTITY_SIMILARITY_THRESHOLD = 0.08


def _get_client():
    global _chroma_client
    if _chroma_client is None:
        _chroma_client = chromadb.PersistentClient(path=os.path.abspath(CHROMA_PATH))
    return _chroma_client


def _get_collection():
    global _collection
    if _collection is None:
        _collection = _get_client().get_or_create_collection(
            name="mental_avatar",
            metadata={"hnsw:space": "cosine"},
            embedding_function=_embed_fn,
        )
    return _collection


def _get_entity_collection():
    """엔티티명 전용 컬렉션 — 문서 청크(mental_avatar)와 분리해 엔티티끼리만 비교."""
    global _entity_collection
    if _entity_collection is None:
        _entity_collection = _get_client().get_or_create_collection(
            name="mental_avatar_entities",
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
    """노드를 벡터 DB에 추가 (sentence-transformers 기반)"""
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


def get_stats() -> dict:
    col = _get_collection()
    return {"vector_count": col.count()}
