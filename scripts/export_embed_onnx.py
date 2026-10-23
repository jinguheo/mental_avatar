"""임베딩 모델(KURE-v1)을 ONNX로 내보낸다 — core/embeddings.py가 쓰는 models/embed/kure-v1/.

API 서버에서는 torch·transformers를 불러오면 안 된다. faceswap이 쓰는 onnxruntime-gpu와 한 프로세스에 있으면
torch를 먼저 띄우면 faceswap 모델 파싱이 깨지고(protobuf DecodeError), faceswap을 먼저 띄우면 torch 추론이
네이티브 크래시(exit 139)로 죽는다(2026-10-23 실측). 그래서 내보내기만 이 별도 프로세스에서 torch로 하고,
서버는 onnxruntime(CPU) + tokenizers로만 돌린다. 모델 파일이 없으면 embeddings.py가 이 스크립트를 자동 실행한다.

    python scripts/export_embed_onnx.py
"""
import os
import shutil
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["MA_EMBED_NO_PRELOAD"] = "1"   # 내보내는 중에 embeddings가 모델을 띄우면 순환·파일 잠금이 생긴다
from core.embeddings import EMBED_MODEL, ONNX_DIR  # noqa: E402


def main():
    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoModel

    src = snapshot_download(EMBED_MODEL, allow_patterns=["*.json", "*.safetensors"])
    tmp = ONNX_DIR + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    base = AutoModel.from_pretrained(src).eval()

    class Wrapped(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.m = base

        def forward(self, input_ids, attention_mask):
            return self.m(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state

    dummy = (torch.ones(1, 8, dtype=torch.long), torch.ones(1, 8, dtype=torch.long))
    with torch.no_grad():
        # 2GB가 넘어 가중치는 외부 데이터 파일로 따로 저장된다(protobuf 크기 한도).
        torch.onnx.export(Wrapped().eval(), dummy, os.path.join(tmp, "model.onnx"),
                          input_names=["input_ids", "attention_mask"], output_names=["last_hidden_state"],
                          dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"},
                                        "last_hidden_state": {0: "batch", 1: "seq"}},
                          opset_version=17, dynamo=False)
    # 내보내기는 텐서마다 파일을 따로 만든다 — 파일 하나(model.onnx.data)로 모은다.
    import onnx
    proto = onnx.load(os.path.join(tmp, "model.onnx"))
    os.makedirs(ONNX_DIR + ".new")
    onnx.save_model(proto, os.path.join(ONNX_DIR + ".new", "model.onnx"), save_as_external_data=True,
                    all_tensors_to_one_file=True, location="model.onnx.data")
    shutil.copy(os.path.join(src, "tokenizer.json"), ONNX_DIR + ".new")
    shutil.rmtree(tmp)
    shutil.rmtree(ONNX_DIR, ignore_errors=True)
    os.replace(ONNX_DIR + ".new", ONNX_DIR)
    print(f"[export] {EMBED_MODEL} → {ONNX_DIR}", flush=True)


if __name__ == "__main__":
    main()
