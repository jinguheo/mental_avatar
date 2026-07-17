"""얼굴 교체 — insightface inswapper_128 사용
입력: source_face_path (내 얼굴 사진), target_video_path (교체 대상 영상)
출력: output_path (내 얼굴로 교체된 영상)
"""
import os
import sys
import cv2
import numpy as np
from pathlib import Path

from . import config

MODEL_PATH = Path(__file__).parent.parent / "models" / "faceswap" / "inswapper_128.onnx"

# onnxruntime의 CUDAExecutionProvider는 cudnn64_9.dll / cudart64_12.dll 등을 필요로 하는데,
# 별도 CUDA/cuDNN 설치 없이도 torch 패키지에 이미 번들되어 있다 — 그 디렉터리를 PATH에 추가하면
# CUDA 프로바이더가 정상 로드된다 (없으면 onnxruntime이 조용히 CPU로 폴백되어 영상 처리가 매우 느려짐).
_torch_lib = Path(sys.exec_prefix) / "Lib" / "site-packages" / "torch" / "lib"
if _torch_lib.is_dir():
    # Windows/Python 3.11 DLL 검색은 PATH만으로 부족할 수 있다.
    # 시스템 CUDA_PATH(12.6)가 PyTorch 번들 CUDA 12.1/cuDNN 9.1과 섞이지 않도록 제거하고
    # PyTorch가 검증한 CUDA/cuDNN DLL 디렉터리를 명시적으로 등록한다.
    os.environ.pop("CUDA_PATH", None)
    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(str(_torch_lib))
    if str(_torch_lib) not in os.environ.get("PATH", ""):
        os.environ["PATH"] = str(_torch_lib) + os.pathsep + os.environ.get("PATH", "")


def get_face(img, app):
    faces = app.get(img)
    if not faces:
        return None
    return sorted(faces, key=lambda f: f.bbox[0])[0]


# use_gpu별로 하나씩 캐싱 — insightface 모델 초기화(디스크 로드+GPU 세션 생성)가 수 초~십수 초
# 걸려 매 요청마다 새로 만들면 느리고 GPU 메모리 할당/해제가 반복돼 불안정 요인이 됨.
# XTTS(8768 상주 워커)와 같은 이유로, 프로세스 생존 동안 재사용한다.
_model_cache: dict = {}


def _get_models(use_gpu: bool):
    if use_gpu not in _model_cache:
        import insightface
        from insightface.app import FaceAnalysis

        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if use_gpu else ["CPUExecutionProvider"]
        ctx_id = 0 if use_gpu else -1

        app = FaceAnalysis(name="buffalo_l", providers=providers)
        app.prepare(ctx_id=ctx_id, det_size=(640, 640))

        swapper = insightface.model_zoo.get_model(
            str(MODEL_PATH),
            download=False,
            providers=providers
        )
        _model_cache[use_gpu] = (app, swapper)
    return _model_cache[use_gpu]


def swap_faces_in_video(source_face_path: str, target_video_path: str, output_path: str, use_gpu: bool = True, progress_callback=None, cancel_callback=None) -> bool:
    """
    target_video의 모든 프레임에서 얼굴을 source_face로 교체.
    use_gpu=True면 CUDAExecutionProvider 우선 시도(실측 10초/720p 기준 CPU 671초 → GPU 51초, 약 13배).
    onnxruntime-gpu 설치 후에도 embeddings.py의 ChromaDB 임베딩은 별도로 CPU 강제돼 있어 서로 영향 없음.
    """
    app, swapper = _get_models(use_gpu)

    # 소스 얼굴 추출
    src_img = cv2.imread(source_face_path)
    if src_img is None:
        raise ValueError(f"소스 이미지 로드 실패: {source_face_path}")
    src_face = get_face(src_img, app)
    if src_face is None:
        raise ValueError("소스 이미지에서 얼굴을 찾을 수 없습니다")

    # 영상 처리
    cap = cv2.VideoCapture(target_video_path)
    if not cap.isOpened():
        raise ValueError(f"영상 열기 실패: {target_video_path}")

    fps    = cap.get(cv2.CAP_PROP_FPS) or 25
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    tmp_path = str(output_path) + "_tmp.mp4"
    out = cv2.VideoWriter(tmp_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))

    frame_count = 0
    while True:
        if cancel_callback and cancel_callback():
            cap.release()
            out.release()
            Path(tmp_path).unlink(missing_ok=True)
            return False
        ret, frame = cap.read()
        if not ret:
            break
        tgt_face = get_face(frame, app)
        if tgt_face:
            frame = swapper.get(frame, tgt_face, src_face, paste_back=True)
        out.write(frame)
        frame_count += 1
        if progress_callback and (frame_count == 1 or frame_count % 10 == 0 or (total_frames and frame_count >= total_frames)):
            progress_callback(frame_count, total_frames)

    cap.release()
    out.release()
    if progress_callback:
        progress_callback(frame_count, total_frames)

    # 오디오 병합
    import subprocess
    ffmpeg = str(config.SADTALKER_FFMPEG)
    try:
        subprocess.run([
            ffmpeg, "-y", "-i", tmp_path, "-i", target_video_path,
            "-map", "0:v", "-map", "1:a?",
            "-c:v", "libx264", "-c:a", "aac", "-shortest", output_path
        ], check=True, capture_output=True, timeout=120)
        Path(tmp_path).unlink(missing_ok=True)
    except Exception:
        # 오디오 없으면 그냥 영상만
        import shutil
        shutil.move(tmp_path, output_path)

    return True
