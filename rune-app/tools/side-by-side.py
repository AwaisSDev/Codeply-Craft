"""Puts each prototype screenshot (left) next to the Rune render of the same view (right).

    python3 tools/side-by-side.py    # reads screenshots/{prototype,rune}, writes screenshots/side-by-side
"""
import pathlib
from PIL import Image, ImageDraw, ImageFont

root = pathlib.Path(__file__).resolve().parent.parent / "screenshots"
out = root / "side-by-side"
out.mkdir(exist_ok=True)
try:
    font = ImageFont.truetype("DejaVuSans.ttf", 22)
except OSError:
    font = ImageFont.load_default()

for proto in sorted((root / "prototype").glob("*.png")):
    rune = root / "rune" / proto.name
    if not rune.exists():
        continue
    a, b = Image.open(proto).convert("RGB"), Image.open(rune).convert("RGB")
    gap, head = 16, 40
    w, h = a.width + gap + b.width, max(a.height, b.height) + head
    sheet = Image.new("RGB", (w, h), (24, 24, 24))
    sheet.paste(a, (0, head))
    sheet.paste(b, (a.width + gap, head))
    d = ImageDraw.Draw(sheet)
    d.text((12, 9), f"Prototype (HTML): {proto.stem}", fill=(200, 200, 200), font=font)
    d.text((a.width + gap + 12, 9), f"Rune: {proto.stem}", fill=(200, 200, 200), font=font)
    # Half size keeps the files small enough for a pull request.
    sheet = sheet.resize((w // 2, h // 2), Image.LANCZOS)
    sheet.save(out / proto.name, optimize=True)
    print(out / proto.name)
