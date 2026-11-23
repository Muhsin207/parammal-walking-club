import shutil
from pathlib import Path


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "dist"


def build():
    OUTPUT.mkdir(exist_ok=True)
    shutil.copy2(ROOT / "index.html", OUTPUT / "index.html")
    shutil.copy2(ROOT / "static" / "service-worker.js", OUTPUT / "service-worker.js")
    shutil.copytree(ROOT / "static", OUTPUT / "static", dirs_exist_ok=True)


if __name__ == "__main__":
    build()
