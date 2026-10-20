#!/usr/bin/env python3
"""Gera o icone do Gree+ por codigo (alternativa ao icon_from_image.py).

O icone oficial do repositorio foi produzido a partir de uma arte (ver
icon_from_image.py). Este script desenha uma versao vetorial em Python, util
para ajustar cores/formas sem depender de imagem externa.

Gera o icone do Gree+ (greeplus.ico + greeplus.png).

Uso (precisa de Pillow, so para gerar o icone):
    pip install pillow
    python tools/make_icon.py

O resultado e commitado no repositorio; o programa em si nao depende de Pillow.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
CANVAS = 1024
SCALE = 4  # supersampling para suavizar as bordas


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    """Fundo com gradiente diagonal (verde-agua -> azul)."""
    image = Image.new("RGB", (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = (x / size * 0.35 + y / size * 0.65)
            t = max(0.0, min(1.0, t))
            pixels[x, y] = (
                int(lerp(top[0], bottom[0], t)),
                int(lerp(top[1], bottom[1], t)),
                int(lerp(top[2], bottom[2], t)),
            )
    return image


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def draw_snowflake(draw: ImageDraw.ImageDraw, cx: float, cy: float, radius: float, width: int, color) -> None:
    for index in range(6):
        angle = math.radians(index * 60)
        dx, dy = math.cos(angle) * radius, math.sin(angle) * radius
        draw.line([(cx, cy), (cx + dx, cy + dy)], fill=color, width=width)
        # pequenos ramos
        for side in (-1, 1):
            branch = math.radians(index * 60 + side * 35)
            bx, by = math.cos(branch) * radius * 0.42, math.sin(branch) * radius * 0.42
            start = 0.62
            draw.line(
                [
                    (cx + dx * start, cy + dy * start),
                    (cx + dx * start + bx, cy + dy * start + by),
                ],
                fill=color,
                width=max(1, width - 2),
            )


def build(canvas: int = CANVAS) -> Image.Image:
    size = canvas * SCALE
    image = gradient(size, (46, 224, 179), (47, 123, 255)).convert("RGBA")

    mask = rounded_mask(size, radius=int(size * 0.23))
    image.putalpha(mask)

    draw = ImageDraw.Draw(image)
    white = (255, 255, 255, 255)

    # Corpo do ar-condicionado (split de parede), levemente inclinado.
    unit = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ud = ImageDraw.Draw(unit)
    w, h = size * 0.62, size * 0.30
    left, top = (size - w) / 2, size * 0.30
    ud.rounded_rectangle([left, top, left + w, top + h], radius=int(size * 0.055), fill=white)

    # Fresta de saida de ar (parte de baixo do aparelho).
    inset = size * 0.045
    slot_top = top + h * 0.54
    ud.rounded_rectangle(
        [left + inset, slot_top, left + w - inset, top + h - inset * 0.85],
        radius=int(size * 0.03),
        fill=(24, 40, 74, 255),
    )

    # Palhetas dentro da fresta.
    slats = 3
    for index in range(slats):
        y = slot_top + (top + h - inset * 0.85 - slot_top) * (index + 0.5) / slats
        ud.line(
            [(left + inset * 2.1, y), (left + w - inset * 2.1, y)],
            fill=(90, 220, 200, 255),
            width=max(2, int(size * 0.008)),
        )

    # Led indicador aceso.
    r = size * 0.012
    cx, cy = left + w - inset * 2.0, top + h * 0.24
    ud.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(34, 211, 165, 255))

    image.alpha_composite(unit)

    # Fluxo de ar saindo do aparelho.
    for index in range(3):
        y = top + h + size * (0.055 + index * 0.062)
        width_line = size * 0.19 - index * size * 0.02
        x0 = size / 2 - width_line / 2
        draw.line(
            [(x0, y), (x0 + width_line, y)],
            fill=(255, 255, 255, 150 - index * 30),
            width=max(2, int(size * 0.014)),
        )

    # Floco de gelo no canto (identidade "ar condicionado").
    draw_snowflake(
        draw,
        cx=size * 0.255,
        cy=size * 0.755,
        radius=size * 0.105,
        width=max(2, int(size * 0.017)),
        color=(255, 255, 255, 235),
    )

    # Brilho suave no topo.
    gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(gloss)
    gd.ellipse(
        [-size * 0.25, -size * 0.75, size * 1.25, size * 0.42],
        fill=(255, 255, 255, 26),
    )
    image.alpha_composite(Image.composite(gloss, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask))

    return image.resize((canvas, canvas), Image.LANCZOS)


def main() -> None:
    big = build(CANVAS)
    png_path = ROOT / "greeplus.png"
    ico_path = ROOT / "greeplus.ico"

    big.save(png_path, format="PNG")
    frames = [big.resize((s, s), Image.LANCZOS) for s in SIZES]
    frames[-1].save(ico_path, format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print(f"gerado: {png_path.name} ({png_path.stat().st_size} bytes)")
    print(f"gerado: {ico_path.name} ({ico_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
