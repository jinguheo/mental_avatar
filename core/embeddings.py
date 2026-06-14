"""임베딩 생성 + Chroma 벡터 저장"""
import os
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


def _get_collection():
    global _chroma_client, _collection
    if _collection is None:
        _chroma_client = chromadb.PersistentClient(path=os.path.abspath(CHROMA_PATH))
        _collection = _chroma_client.get_or_create_collection(
            name="mental_avatar",
            metadata={"hnsw:space": "cosine"},
            embedding_function=_embed_fn,
        )
    return _collection


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


def search(query: str, n_results: int = 10) -> list[dict]:
    """시맨틱 검색"""
    col = _get_collection()
    try:
        results = col.query(query_texts=[query], n_results=n_results)
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


def get_stats() -> dict:
    col = _get_collection()
    return {"vector_count": col.count()}
