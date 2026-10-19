"""동의된 개인 아바타의 5뷰 시트를 3D 입력용 개별 이미지로 분리한다."""
from pathlib import Path

from PIL import Image

SOURCE = Path(r"C:\Users\oem\.codex\generated_images\01a13f6d-de95-76e2-9767-3d302e27bb73\exec-70c43a34-e523-45fb-b7b4-02ce54f49a79.png")
OUT = Path(__file__).resolve().parent.parent / "data" / "private_avatar" / "healthy_5view"
NAMES = ["01_front.png", "02_left_30.png", "03_left_90.png", "04_right_30.png", "05_right_90.png"]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    image = Image.open(SOURCE).convert("RGB")
    width, height = image.size
    for index, name in enumerate(NAMES):
        left, right = round(index * width / 5), round((index + 1) * width / 5)
        image.crop((left, 0, right, height)).save(OUT / name, quality=96)
    print(OUT)


if __name__ == "__main__":
    main()
