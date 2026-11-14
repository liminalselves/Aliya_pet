#!/usr/bin/env python3
"""Regenerate committed macOS icons on macOS (Python Pillow + Apple iconutil).

Normal builds use the committed resources; Pillow is only needed for regeneration.
The app artwork comes from ui/assets/icon.png. The tray uses an original A monogram:
turning the artwork's rounded-square alpha into a template would produce a blob.
"""

from pathlib import Path
import argparse
import subprocess
import tempfile

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri" / "icons"
SOURCE = Image.open(ROOT / "ui" / "assets" / "icon.png").convert("RGBA")


def app_icon(size):
    # A square, centered inset leaves space around the source's rounded corners.
    canvas = Image.new("RGBA", (size, size))
    artwork = SOURCE.copy()
    artwork.thumbnail((824, 824), Image.Resampling.LANCZOS)
    side = round(size * 824 / 1024)
    artwork = artwork.resize((side, side), Image.Resampling.LANCZOS)
    canvas.alpha_composite(artwork, ((size - side) // 2, (size - side) // 2))
    return canvas


def tray_icon(size):
    # Supersampling keeps the transparent counter and crossbar readable at 18 pt.
    scale = size * 8 / 18
    alpha = Image.new("L", (size * 8, size * 8))
    draw = ImageDraw.Draw(alpha)
    points = lambda coords: [(round(x * scale), round(y * scale)) for x, y in coords]
    draw.polygon(points([(2, 16), (7, 2), (11, 2), (16, 16), (12.8, 16),
                         (11.6, 12.5), (6.4, 12.5), (5.2, 16)]), fill=255)
    draw.polygon(points([(7.3, 9.8), (9, 4.7), (10.7, 9.8)]), fill=0)
    image = Image.new("RGBA", (size, size))
    image.putalpha(alpha.resize((size, size), Image.Resampling.LANCZOS))
    return image


def preview_templates(output):
    """Show committed masks on light/dark backgrounds, without regenerating them."""
    sheet = Image.new("RGB", (640, 280))
    draw = ImageDraw.Draw(sheet)
    for column, (background, foreground) in enumerate([("#f2f2f2", "black"), ("#222222", "white")]):
        x = column * 320
        draw.rectangle((x, 0, x + 319, 279), fill=background)
        draw.text((x + 12, 10), "1x / 2x masks, actual pixels + 4x zoom", fill=foreground)
        for row, name in enumerate(["tray-template.png", "tray-template@2x.png"]):
            alpha = Image.open(ICONS / name).getchannel("A")
            icon = Image.new("RGBA", alpha.size, foreground)
            icon.putalpha(alpha)
            y = 45 + row * 90
            sheet.paste(icon, (x + 20, y), icon)
            zoom = icon.resize((alpha.width * 4, alpha.height * 4), Image.Resampling.NEAREST)
            sheet.paste(zoom, (x + 100, y), zoom)
    sheet.save(output)
    print(f"Template preview (simulated tint, not a menu-bar screenshot): {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preview", type=Path, help="render existing template masks to a PNG without regenerating icons")
    args = parser.parse_args()
    if not ICONS.is_dir():
        raise SystemExit(f"Missing icon directory: {ICONS}")
    if args.preview:
        preview_templates(args.preview)
        return
    app_icon(256).save(ICONS / "icon.png")
    for size, name in [(18, "tray-template.png"), (36, "tray-template@2x.png")]:
        tray_icon(size).save(ICONS / name)
    with tempfile.TemporaryDirectory(prefix="aliya-macos-icons-") as temporary:
        iconset = Path(temporary) / "icon.iconset"
        iconset.mkdir()
        for size in [16, 32, 128, 256, 512]:
            for scale in [1, 2]:
                suffix = "@2x" if scale == 2 else ""
                app_icon(size * scale).save(iconset / f"icon_{size}x{size}{suffix}.png")
        subprocess.run(["iconutil", "--convert", "icns", "--output",
                        str(ICONS / "icon.icns"), str(iconset)], check=True)
    print(f"Generated app and template icons in {ICONS}")


if __name__ == "__main__":
    main()
