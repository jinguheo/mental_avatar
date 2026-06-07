"""얼굴 교체 — insightface inswapper_128 사용
입력: source_face_path (내 얼굴 사진), target_video_path (교체 대상 영상)
출력: output_path (내 얼굴로 교체된 영상)
"""
import os
import sys
import cv2
import numpy as np
from pathlib import Path

MODEL_PATH = Path(__file__).parent.parent / "models" / "faceswap" / "inswapper_128.onnx"

# onnxruntime의 CUDAExecutionProvider는 cudnn64_9.dll / cudart64_12.dll 등을 필요로 하는데,
# 별도 CUDA/cuDNN 설치 없이도 torch 패키지에 이미 번들되어 있다 — 그 디렉터리를 PATH에 추가하면
# CUDA 프로바이더가 정상 로드된다 (없으면 onnxruntime이 조용히 CPU로 폴백되어 영상 처리가 매우 느려짐).
_torch_lib = Path(sys.exec_prefix) / "Lib" / "site-packages" / "torch" / "lib"
if _torch_lib.is_dir() and str(_torch_lib) not in os.environ.get("PATH", ""):
    os.environ["PATH"] = str(_torch_lib) + os.pathsep + os.environ.get("PATH", "")


def get_face(img, app):
    faces = app.get(img)
    if not faces:
        return None
    return sorted(faces, key=lambda f: f.bbox[0])[0]


def swap_faces_in_video(source_face_path: str, target_video_path: str, output_path: str) -> bool:
    """
    target_video의 모든 프레임에서 얼굴을 source_face로 교체.
    """
    import insightface
    from insightface.app import FaceAnalysis

    # 모델 초기화
    app = FaceAnalysis(name="buffalo_l", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))

    swapper = insightface.model_zoo.get_model(
        str(MODEL_PATH),
        download=False,
        providers=["CUDAExecutionProvider", "CPUExecutionProvider"]
    )

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

    tmp_path = str(output_path) + "_tmp.mp4"
    out = cv2.VideoWriter(tmp_path, cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))

    frame_count = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break
        tgt_face = get_face(frame, app)
        if tgt_face:
            frame = swapper.get(frame, tgt_face, src_face, paste_back=True)
        out.write(frame)
        frame_count += 1

    cap.release()
    out.release()

    # 오디오 병합
    import subprocess
    ffmpeg = str(Path("D:/MyWork/SadTalker/ffmpeg.exe"))
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
