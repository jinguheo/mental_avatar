"""동의된 개인 아바타의 30대 스타일 5뷰 시트를 개별 이미지로 분리한다."""
from pathlib import Path

from PIL import Image

SOURCE = Path(r"C:\Users\oem\.codex\generated_images\01a13f6d-de95-76e2-9767-3d302e27bb73\exec-b8846735-4c09-49ce-84ec-ae7e67f5718a.png")
OUT = Path(__file__).resolve().parent.parent / "data" / "private_avatar" / "healthy_30s_5view"
NAMES = ["01_front.png", "02_left_30.png", "03_left_90.png", "04_right_30.png", "05_right_90.png"]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    image = Image.open(SOURCE).convert("RGB")
    width, height = image.size
    for index, name in enumerate(NAMES):
        image.crop((round(index * width / 5), 0, round((index + 1) * width / 5), height)).save(OUT / name, quality=96)
    print(OUT)


if __name__ == "__main__":
    main()
