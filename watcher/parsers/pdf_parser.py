"""PDF 파서 — pymupdf 사용"""
import fitz  # pymupdf
import os

CHUNK_SIZE = 1500  # 문자 기준


def parse_pdf(file_path: str) -> list[dict]:
    chunks = []
    doc = fitz.open(file_path)
    full_text = ""
    toc = doc.get_toc()  # 목차

    for page in doc:
        full_text += page.get_text()

    doc.close()

    # 제목 추출 (파일명 기반)
    base_title = os.path.splitext(os.path.basename(file_path))[0]

    # 청킹
    paragraphs = [p.strip() for p in full_text.split("\n\n") if p.strip()]
    current_chunk = ""
    chunk_idx = 0

    for para in paragraphs:
        if len(current_chunk) + len(para) > CHUNK_SIZE and current_chunk:
            chunks.append({
                "title": f"{base_title} [{chunk_idx+1}]",
                "content": current_chunk.strip(),
                "meta": {"chunk_index": chunk_idx, "source_type": "pdf", "file_path": file_path}
            })
            chunk_idx += 1
            current_chunk = para
        else:
            current_chunk += "\n\n" + para

    if current_chunk.strip():
        chunks.append({
            "title": f"{base_title} [{chunk_idx+1}]" if chunk_idx > 0 else base_title,
            "content": current_chunk.strip(),
            "meta": {"chunk_index": chunk_idx, "source_type": "pdf", "file_path": file_path, "toc": toc}
        })

    return chunks if chunks else [{"title": base_title, "content": full_text[:3000], "meta": {"source_type": "pdf", "file_path": file_path}}]
