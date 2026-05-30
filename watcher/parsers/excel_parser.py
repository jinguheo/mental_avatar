"""Excel(.xlsx) 파서 — openpyxl + pandas 사용
Excel은 단순 텍스트 추출이 아니라 시트의 '의도'를 파악하는 것이 핵심.
"""
import os
import openpyxl
import pandas as pd


def _infer_sheet_purpose(df: pd.DataFrame, sheet_name: str) -> str:
    """시트 구조로 목적 추론"""
    cols = [str(c).lower() for c in df.columns]
    col_str = " ".join(cols)

    if any(w in col_str for w in ["수익", "수익률", "손익", "price", "profit", "return", "포트폴리오", "portfolio"]):
        return "포트폴리오/수익 추적"
    if any(w in col_str for w in ["일정", "날짜", "date", "schedule", "task", "할일"]):
        return "일정/태스크 관리"
    if any(w in col_str for w in ["비교", "compare", "vs", "분석", "analysis"]):
        return "비교 분석"
    if any(w in col_str for w in ["예산", "budget", "지출", "expense", "수입", "income"]):
        return "예산/재무"
    return "데이터 분석"


def parse_excel(file_path: str) -> list[dict]:
    base_title = os.path.splitext(os.path.basename(file_path))[0]
    chunks = []

    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)

    for sheet_name in wb.sheetnames:
        try:
            df = pd.read_excel(file_path, sheet_name=sheet_name, nrows=100)
            df = df.dropna(how="all").dropna(axis=1, how="all")

            if df.empty:
                continue

            purpose = _infer_sheet_purpose(df, sheet_name)
            headers = list(df.columns)
            sample_rows = df.head(5).to_string(index=False)
            row_count = len(df)

            content = (
                f"시트: {sheet_name}\n"
                f"목적: {purpose}\n"
                f"행 수: {row_count}\n"
                f"컬럼: {', '.join(str(h) for h in headers)}\n\n"
                f"샘플 데이터:\n{sample_rows}"
            )

            chunks.append({
                "title": f"{base_title} — {sheet_name} ({purpose})",
                "content": content,
                "meta": {
                    "source_type": "excel",
                    "file_path": file_path,
                    "sheet_name": sheet_name,
                    "purpose": purpose,
                    "row_count": row_count,
                    "columns": [str(h) for h in headers]
                }
            })
        except Exception as e:
            chunks.append({
                "title": f"{base_title} — {sheet_name}",
                "content": f"파싱 실패: {e}",
                "meta": {"source_type": "excel", "file_path": file_path}
            })

    wb.close()
    return chunks
