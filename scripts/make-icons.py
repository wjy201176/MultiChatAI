#!/usr/bin/env python3
"""Generate the MultiChatAI icons (16/32/48/128 + a 256px preview).

Design: violet→blue gradient rounded square with three white bars of differing
height — "several models, one view". Everything is drawn at 8x and downsampled
with Lanczos so the 16px toolbar icon stays crisp.

Usage:  python scripts/make-icons.py
"""

from __future__ import annotations

import pathlib

import numpy as np
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "assets" / "icons"
PREVIEW = ROOT / "docs" / "icon-preview.png"

FROM = (91, 140, 255)   # #5B8CFF
TO = (125, 92, 255)     # #7D5CFF
SIZES = (16, 32, 48, 128)


def gradient(size: int) -> Image.Image:
    xs = np.linspace(0.0, 1.0, size)
    gx, gy = np.meshgrid(xs, xs)
    t = np.clip(gx * 0.45 + gy * 0.55, 0.0, 1.0)
    arr = np.zeros((size, size, 3), dtype=np.float64)
    for channel in range(3):
        arr[:, :, channel] = FROM[channel] + (TO[channel] - FROM[channel]) * t
    return Image.fromarray(arr.astype(np.uint8), "RGB").convert("RGBA")


def render(size: int, scale: int) -> Image.Image:
    big = size * scale
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=int(big * 0.235), fill=255
    )
    canvas = Image.composite(gradient(big), canvas, mask)

    draw = ImageDraw.Draw(canvas)
    bar_w = big * 0.135
    gap = big * 0.062
    heights = (0.50, 0.66, 0.38)
    alphas = (240, 205, 165)
    total = len(heights) * bar_w + (len(heights) - 1) * gap
    left = (big - total) / 2

    for index, (height, alpha) in enumerate(zip(heights, alphas)):
        x0 = left + index * (bar_w + gap)
        bar_h = big * height
        y0 = (big - bar_h) / 2
        draw.rounded_rectangle(
            [x0, y0, x0 + bar_w, y0 + bar_h],
            radius=bar_w / 2,
            fill=(255, 255, 255, alpha),
        )

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        scale = 8 if size <= 48 else 4
        icon = render(size, scale)
        target = OUT / f"icon{size}.png"
        icon.save(target, "PNG", optimize=True)
        print(f"wrote {target.relative_to(ROOT)}  ({size}x{size})")

    palette = Image.new("RGBA", (256 * 2, 256), (14, 17, 22, 255))
    palette.paste(render(256, 4), (0, 0), render(256, 4))
    checker = Image.new("RGBA", (256, 256), (247, 248, 251, 255))
    checker.paste(render(256, 4), (0, 0), render(256, 4))
    palette.paste(checker, (256, 0))
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    palette.save(PREVIEW, "PNG", optimize=True)
    print(f"wrote {PREVIEW.relative_to(ROOT)}  (preview)")


if __name__ == "__main__":
    main()
