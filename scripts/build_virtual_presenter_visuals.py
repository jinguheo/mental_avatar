"""비식별 가상 진행자의 5뷰 시트를 화면용 프레임·영상으로 분리한다.

이 진행자는 특정 실존 인물과 닮지 않는 독립적인 가상 캐릭터다. 공개 인물
텍스트 페르소나의 화면 표현에만 공유하며, 인물의 실제 모습·목소리를 뜻하지 않는다.
"""
from pathlib import Path
import subprocess

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "data" / "persona_visuals" / "virtual_presenter"
SOURCE = ROOT / "source_5view.png"


def main():
    if not SOURCE.exists():
        raise FileNotFoundError(SOURCE)
    image = Image.open(SOURCE).convert("RGB")
    width, height = image.size
    for index in range(5):
        frame = image.crop((round(index * width / 5), 0, round((index + 1) * width / 5), height))
        frame.save(ROOT / f"{index + 1:02d}.png", quality=95)
    for index in range(1, 6):
        subprocess.run([
            "ffmpeg", "-y", "-loop", "1", "-t", "3", "-i", str(ROOT / f"{index:02d}.png"),
            "-vf", "scale=720:-2", "-r", "25", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(ROOT / f"{index:02d}.mp4"),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        "ffmpeg", "-y", "-framerate", "1", "-i", str(ROOT / "%02d.png"),
        "-vf", "fps=25,scale=720:-2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(ROOT / "preview.mp4"),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    main()
