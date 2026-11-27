"""Rebuild the AgentDock app icon. Requires Pillow."""
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"
root.mkdir(parents=True, exist_ok=True)
canvas = Image.new("RGBA", (1024, 1024))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle((72, 72, 952, 952), radius=190, fill="#171b24",
                       outline="#454b59", width=26)
draw.rounded_rectangle((220, 271, 804, 753), radius=74,
                       outline="#f2c56d", width=46)
draw.line((324, 398, 451, 501, 324, 604), fill="#f2c56d", width=53, joint="curve")
for x, y in ((324, 398), (324, 604)):
    draw.ellipse((x - 26, y - 26, x + 26, y + 26), fill="#f2c56d")
draw.rounded_rectangle((523, 574, 698, 628), radius=27, fill="#b0c5e4")
image = canvas.resize((256, 256), Image.Resampling.LANCZOS)
image.save(root / "icon.png")
image.save(root / "icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
