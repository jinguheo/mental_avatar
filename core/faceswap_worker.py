"""Independent face-swap worker process.

The API launches this process so a native CUDA/ONNX crash cannot take down
the API server. Progress and errors are reported through a small JSON file.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def write_state(path: Path, **values):
    path.write_text(json.dumps(values, ensure_ascii=False), encoding="utf-8")


def main() -> int:
    if len(sys.argv) < 6:
        return 2
    source, target, output, state_file, cancel_file = map(Path, sys.argv[1:6])
    use_gpu = sys.argv[6].lower() not in ("0", "false", "no") if len(sys.argv) > 6 else True
    write_state(state_file, stage="starting", progress=0, processed_frames=0, total_frames=0, error="")
    try:
        from core.faceswap import swap_faces_in_video

        def on_progress(processed: int, total: int):
            write_state(
                state_file, stage="processing", progress=round(processed / total * 100, 1) if total else 0,
                processed_frames=processed, total_frames=total, error="",
            )

        def is_cancelled() -> bool:
            return cancel_file.exists()

        swap_faces_in_video(str(source), str(target), str(output), use_gpu=use_gpu,
                            progress_callback=on_progress, cancel_callback=is_cancelled)
        if is_cancelled():
            write_state(state_file, stage="canceled", progress=0, processed_frames=0, total_frames=0, error="")
            return 3
        write_state(state_file, stage="done", progress=100, error="")
        return 0
    except BaseException as exc:
        write_state(state_file, stage="error", progress=0, error=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
