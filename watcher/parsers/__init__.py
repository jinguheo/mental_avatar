import os
from .pdf_parser import parse_pdf
from .docx_parser import parse_docx
from .excel_parser import parse_excel
from .pptx_parser import parse_pptx

def _parse_ppt_legacy(file_path: str) -> list[dict]:
    """구형 .ppt — python-pptx로 시도, 실패 시 빈 청크 반환"""
    try:
        return parse_pptx(file_path)
    except Exception:
        base = os.path.splitext(os.path.basename(file_path))[0]
        return [{"title": base, "content": f"[.ppt 파일 — 변환 필요: {os.path.basename(file_path)}]",
                 "meta": {"source_type": "pptx", "file_path": file_path, "chunk_index": 0}}]


EXTENSION_MAP = {
    ".pdf":  parse_pdf,
    ".docx": parse_docx,
    ".doc":  parse_docx,
    ".xlsx": parse_excel,
    ".xls":  parse_excel,
    ".pptx": parse_pptx,
    ".ppt":  _parse_ppt_legacy,
    ".txt":  lambda p: [{"title": os.path.basename(p), "content": open(p, encoding="utf-8", errors="ignore").read(), "meta": {"source_type": "text", "file_path": p}}],
    ".md":   lambda p: [{"title": os.path.basename(p), "content": open(p, encoding="utf-8", errors="ignore").read(), "meta": {"source_type": "note", "file_path": p}}],
}


def parse_file(file_path: str) -> list[dict]:
    """파일 경로를 받아 청크 리스트 반환. 각 청크: {title, content, meta}"""
    import os
    ext = os.path.splitext(file_path)[1].lower()
    parser = EXTENSION_MAP.get(ext)
    if not parser:
        return []
    return parser(file_path)
