"""가상 역사 인물 3뷰 시트를 3D 입력 이미지와 미리보기 영상으로 분리한다.

생성 시트는 실제 인물의 초상이 아닌 비식별 시대풍 AI 캐릭터다. 좌·우 30도 파일은
정면과 90도 측면 사이의 *영상 전환용 블렌드*이며 3D 복원 입력으로 쓰지 않는다.
"""
from pathlib import Path
import shutil
import subprocess

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "data" / "persona_visuals"
GEN = Path(r"C:\Users\oem\.codex\generated_images\01a13f6d-de95-76e2-9767-3d302e27bb73")
SHEETS = {
    "sejong": GEN / "exec-296da64d-fb87-457a-9cbc-0d19e0005769.png",
    "yi_sun_sin": GEN / "exec-1159dd77-5994-4dae-b0a3-c34810e8275b.png",
    "leonardo": GEN / "exec-ecfc93ed-f072-4850-8d77-800113f91b67.png",
    "marie_curie": GEN / "exec-da6a98a5-2ac6-45f5-968b-8ff052003633.png",
    "marcus_aurelius": GEN / "exec-6911f15c-9d40-49af-8423-eee576f1314d.png",
}


def build(person: str, sheet: Path) -> None:
    target = ROOT / person
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(sheet, target / "source_triptych.png")
    image = Image.open(sheet).convert("RGB")
    w, h = image.size
    # 구분선은 각 패널 안에 거의 없도록 1/3 단위로 자른다.
    panels = [image.crop((round(i * w / 3), 0, round((i + 1) * w / 3), h)) for i in range(3)]
    front, left, right = panels
    # 시트 폭이 3으로 나누어떨어지지 않아 1px 차이가 날 수 있으므로 전환용 블렌드 전에 맞춘다.
    left = left.resize(front.size)
    right = right.resize(front.size)
    # 이름 순서가 영상 재생 순서다. 30도는 실측/생성 얼굴이 아니라 전환 시각화임을 API 메타에 명시한다.
    frames = {
        "01.png": front,
        "02.png": Image.blend(front, left, 0.35),
        "03.png": left,
        "04.png": Image.blend(front, right, 0.35),
        "05.png": right,
    }
    for name, frame in frames.items():
        frame.save(target / name, quality=95)
    # 다섯 각도는 각각 독립 영상으로도 제공해 화면에서 나란히 검토할 수 있게 한다.
    for index in range(1, 6):
        subprocess.run([
            "ffmpeg", "-y", "-loop", "1", "-t", "3", "-i", str(target / f"{index:02d}.png"),
            "-vf", "scale=720:-2", "-r", "25", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(target / f"{index:02d}.mp4"),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run([
        "ffmpeg", "-y", "-framerate", "1", "-i", str(target / "%02d.png"),
        "-vf", "fps=25,scale=720:-2", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(target / "preview.mp4"),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    for pid, sheet_path in SHEETS.items():
        if not sheet_path.exists():
            raise FileNotFoundError(sheet_path)
        build(pid, sheet_path)
        print(pid)
