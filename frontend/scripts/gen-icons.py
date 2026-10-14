# Regenerates every app icon / splash from build/icon.svg (the master logo):
#   qlmanage -t -s 1254 -o /tmp build/icon.svg && uv run --with pillow scripts/gen-icons.py /tmp/icon.svg.png
from pathlib import Path
import sys
from PIL import Image, ImageDraw

src = Image.open(sys.argv[1]).convert("RGB")
root = Path(__file__).resolve().parent.parent
res = root / "android/app/src/main/res"
BG = src.getpixel((4, 4))  # the master's own backdrop colour


def sized(n, img=None):
    return (img or tight).resize((n, n), Image.LANCZOS)


def save(img, rel):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    img.save(p)


# The glyph alone (bright cyan, no glow), for the monochrome tray icon.
g = src.getchannel("G").point(lambda v: max(0, min(255, (v - 60) * 6)))
glyph = g.crop(g.getbbox())
side = max(glyph.size) * 112 // 100
mask = Image.new("L", (side, side))
mask.paste(glyph, ((side - glyph.width) // 2, (side - glyph.height) // 2))

# Square crop with the mark filling ~74% — the master's wide margin makes it look small as an icon.
# Masked shapes (Android adaptive, PWA maskable) keep the full master so the mark stays in their safe zone.
x0, y0, x1, y1 = g.getbbox()
half = (y1 - y0) * 100 // 74 // 2
cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
tight = src.crop((cx - half, cy - half, cx + half, cy + half))

# Web / PWA / Electron dock + electron-builder (it derives .icns/.ico from build/icon.png)
save(sized(192), "public/icon-192.png")
save(sized(512), "public/icon-512.png")
save(sized(512, src), "public/icon-maskable-512.png")
save(sized(1024), "build/icon.png")
for name, colour in (("trayTemplate", (0, 0, 0)), ("tray-light", (255, 255, 255))):
    for scale, suffix in ((1, ""), (2, "@2x")):
        n = 18 * scale
        t = Image.new("RGBA", (n, n), colour + (0,))
        t.putalpha(mask.resize((n, n), Image.LANCZOS))
        save(t, f"public/{name}{suffix}.png")

# iOS (single 1024 opaque icon)
save(sized(1024), "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")

# Android launcher: legacy square + round, and adaptive foreground (108dp; glyph sits inside the 66dp safe zone)
for d, base in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
    save(sized(base), f"{res}/mipmap-{d}/ic_launcher.png")
    r = sized(base).convert("RGBA")
    m = Image.new("L", (base * 4, base * 4))
    ImageDraw.Draw(m).ellipse((0, 0, base * 4 - 1, base * 4 - 1), fill=255)
    r.putalpha(m.resize((base, base), Image.LANCZOS))
    save(r, f"{res}/mipmap-{d}/ic_launcher_round.png")
    save(sized(base * 9 // 4, src), f"{res}/mipmap-{d}/ic_launcher_foreground.png")


# Splash screens: logo centred on the backdrop colour (the master's background is flat, so no seam).
def splash(w, h):
    out = Image.new("RGB", (w, h), BG)
    n = min(w, h) * 6 // 10
    out.paste(sized(n), ((w - n) // 2, (h - n) // 2))
    return out


for p in list(res.glob("drawable*/splash.png")) + list((root / "ios/App/App/Assets.xcassets/Splash.imageset").glob("*.png")):
    w, h = Image.open(p).size
    splash(w, h).save(p)

(res / "values/ic_launcher_background.xml").write_text(
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
    f'    <color name="ic_launcher_background">#{BG[0]:02X}{BG[1]:02X}{BG[2]:02X}</color>\n</resources>\n'
)
print("ok, backdrop", BG)
