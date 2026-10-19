"""영상에서 정면 / 좌 / 우(3/4) 얼굴 프레임을 자동으로 골라 저장한다 (3D Mix 입력용).

mica 환경(insightface antelopev2 + onnxruntime-gpu)에서 실행한다:
  D:\\condaenvs\\mica\\python.exe scripts/extract_face_views.py <영상> <출력폴더> [옵션]

동작: 프레임 샘플링 → 얼굴 검출 + 3D 랜드마크로 머리 각도(yaw) 추정 → 같은 사람만 남김 →
흐림·작은 얼굴·어두움·입 벌림 감점 → 정면(≈0°), 좌·우(≈25~45°)에서 점수가 가장 높은 한 장씩 선택.
각도가 영상에 없으면 억지로 만들지 않고 report.json에 "없음"으로 기록한다.

방향 기준: 화면(이미지) 기준 left/right — "left"는 얼굴이 화면 왼쪽을 향한 것(코가 두 눈 중심보다 왼쪽).
"""
import argparse
import json
import os
import sys
from pathlib import Path

# torch가 번들한 CUDA/cuDNN DLL 경로 등록 — 시스템 CUDA 없이 onnxruntime-gpu 동작 (core/faceswap.py와 같은 이유)
_torch_lib = Path(sys.executable).parent / "Lib" / "site-packages" / "torch" / "lib"
if _torch_lib.is_dir():
    os.environ.pop("CUDA_PATH", None)
    if hasattr(os, "add_dll_directory"):
        os.add_dll_directory(str(_torch_lib))
    os.environ["PATH"] = str(_torch_lib) + os.pathsep + os.environ.get("PATH", "")

import cv2
import numpy as np
from insightface.app import FaceAnalysis


def sharpness(gray_face: np.ndarray) -> float:
    return float(cv2.Laplacian(cv2.resize(gray_face, (224, 224)), cv2.CV_64F).var())


def analyse(app: FaceAnalysis, frame: np.ndarray, t: float, min_face: int):
    faces = app.get(frame)
    if not faces:
        return None
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    x1, y1, x2, y2 = [int(v) for v in face.bbox]
    w = x2 - x1
    if w < min_face or getattr(face, "pose", None) is None:
        return None
    h_img, w_img = frame.shape[:2]
    crop = frame[max(0, y1):min(h_img, y2), max(0, x1):min(w_img, x2)]
    if crop.size == 0:
        return None
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    kps = face.kps  # 왼눈, 오른눈, 코, 입왼, 입오른 (이미지 기준)
    eye_mid_x = (kps[0][0] + kps[1][0]) / 2
    eye_dist = max(float(np.linalg.norm(kps[0] - kps[1])), 1.0)
    turn = float((kps[2][0] - eye_mid_x) / eye_dist)   # 음수: 코가 화면 왼쪽 → 얼굴이 화면 왼쪽을 향함
    lm = face.landmark_3d_68
    mouth_open = float(abs(lm[66][1] - lm[62][1]) / max(float(np.linalg.norm(lm[36][:2] - lm[45][:2])), 1.0))
    pitch, yaw, roll = [float(v) for v in face.pose]
    return {
        "t": t, "width": w, "yaw": yaw, "pitch": pitch, "roll": roll, "turn": turn,
        "sharp": sharpness(gray), "bright": float(gray.mean()), "mouth_open": mouth_open,
        "emb": face.normed_embedding.astype(np.float32), "bbox": [x1, y1, x2, y2],
    }


def score(c: dict, ref_sharp: float) -> float:
    s = min(c["sharp"] / max(ref_sharp, 1e-6), 1.5)                 # 선명도(상대)
    size = min(c["width"] / 300.0, 1.2)                              # 얼굴 크기
    bright = 1.0 if 70 <= c["bright"] <= 190 else 0.6                # 노출
    mouth = 1.0 - min(c["mouth_open"] / 0.15, 1.0) * 0.5             # 입 벌림 감점
    tilt = 1.0 - min(abs(c["roll"]) / 30.0, 1.0) * 0.3 - min(abs(c["pitch"]) / 40.0, 1.0) * 0.3
    return s * size * bright * mouth * tilt


def label_of(c: dict) -> str:
    return "left" if c["turn"] < 0 else "right"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("out")
    ap.add_argument("--rate", type=float, default=3.0, help="초당 샘플 프레임 수")
    ap.add_argument("--max-frames", type=int, default=3000)
    ap.add_argument("--min-face", type=int, default=100, help="얼굴 폭 최소 픽셀")
    ap.add_argument("--front-max", type=float, default=12.0, help="정면으로 보는 |yaw| 상한(도)")
    ap.add_argument("--side-min", type=float, default=22.0, help="좌/우로 보는 |yaw| 하한(도)")
    ap.add_argument("--side-max", type=float, default=50.0, help="좌/우로 보는 |yaw| 상한(도)")
    ap.add_argument("--identity", type=float, default=0.4, help="같은 사람 판정 코사인 유사도 하한")
    ap.add_argument("--window", type=float, default=90.0, help="정면과 같은 장면으로 볼 시간 범위(초)")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    app = FaceAnalysis(name="antelopev2", allowed_modules=["detection", "landmark_3d_68", "recognition"],
                       providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    app.prepare(ctx_id=0, det_size=(640, 640))

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        sys.exit("영상을 열 수 없습니다: " + args.video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    step = max(int(round(fps / args.rate)), 1)
    cands = []
    frames_kept = {}
    idx = 0
    sampled = 0
    while sampled < args.max_frames:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % step == 0:
            sampled += 1
            c = analyse(app, frame, idx / fps, args.min_face)
            if c:
                c["idx"] = idx
                cands.append(c)
                frames_kept[idx] = frame
        idx += 1
    cap.release()
    print(f"샘플 {sampled}장 중 얼굴 {len(cands)}장 (영상 {total}프레임, {fps:.1f}fps)")
    if not cands:
        sys.exit("얼굴을 찾지 못했습니다")

    # 같은 사람만: 다른 후보들과 평균 유사도가 가장 높은 얼굴을 기준으로 삼는다
    embs = np.stack([c["emb"] for c in cands])
    sim = embs @ embs.T
    ref = int(np.argmax(sim.mean(axis=1)))
    cands = [c for i, c in enumerate(cands) if sim[ref][i] >= args.identity]
    print(f"같은 사람으로 판정된 후보 {len(cands)}장")

    ref_sharp = float(np.percentile([c["sharp"] for c in cands], 80))
    for c in cands:
        c["score"] = score(c, ref_sharp)

    def best(pool):
        return max(pool, key=lambda c: c["score"]) if pool else None

    fronts = [c for c in cands if abs(c["yaw"]) <= args.front_max and abs(c["turn"]) < 0.12]
    front = best(fronts)
    sides = {"left": [], "right": []}
    for c in cands:
        if args.side_min <= abs(c["yaw"]) <= args.side_max:
            sides[label_of(c)].append(c)

    chosen, notes = {"front": front}, []
    for name in ("left", "right"):
        near = [c for c in sides[name] if front is None or abs(c["t"] - front["t"]) <= args.window]
        pick = best(near)
        if pick is None and sides[name]:
            pick = best(sides[name])
            notes.append(f"{name}: 정면과 {args.window:.0f}초 안에는 없어 다른 장면에서 골랐습니다(조명·시기가 다를 수 있음)")
        chosen[name] = pick
    for name, c in chosen.items():
        if c is None:
            notes.append(f"{name}: 조건에 맞는 프레임이 영상에 없습니다")

    report = {"video": args.video, "sampled": sampled, "faces": len(cands), "notes": notes, "chosen": {}}
    for name, c in chosen.items():
        if c is None:
            report["chosen"][name] = None
            continue
        path = out / f"{name}.jpg"
        cv2.imwrite(str(path), frames_kept[c["idx"]], [cv2.IMWRITE_JPEG_QUALITY, 95])
        report["chosen"][name] = {"file": str(path), "time_sec": round(c["t"], 2), "yaw": round(c["yaw"], 1),
                                  "turn": round(c["turn"], 3), "sharp": round(c["sharp"], 1), "width": c["width"],
                                  "mouth_open": round(c["mouth_open"], 3), "score": round(c["score"], 3)}

    # 후보 모음: 각 방향 상위 3장 + 선택된 것을 한 장에 모아 눈으로 확인한다
    tiles = []
    groups = {"front": sorted(fronts, key=lambda c: -c["score"])[:3],
              "left": sorted(sides["left"], key=lambda c: -c["score"])[:3],
              "right": sorted(sides["right"], key=lambda c: -c["score"])[:3]}
    for name, group in groups.items():
        for c in group:
            x1, y1, x2, y2 = c["bbox"]
            m = int((x2 - x1) * 0.35)
            fr = frames_kept[c["idx"]]
            crop = fr[max(0, y1 - m):min(fr.shape[0], y2 + m), max(0, x1 - m):min(fr.shape[1], x2 + m)]
            crop = cv2.resize(crop, (240, 240))
            mark = "*" if chosen.get(name) is c else ""
            cv2.putText(crop, f"{name}{mark} {c['t']:.1f}s yaw{c['yaw']:+.0f}", (4, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 1, cv2.LINE_AA)
            tiles.append(crop)
    if tiles:
        while len(tiles) % 3:
            tiles.append(np.zeros((240, 240, 3), np.uint8))
        rows = [np.hstack(tiles[i:i + 3]) for i in range(0, len(tiles), 3)]
        cv2.imwrite(str(out / "candidates.jpg"), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 90])

    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
