#!/usr/bin/env python3
"""Converte uma imagem quadrada em greeplus.png + greeplus.ico.

Uso (precisa de Pillow, só para gerar o ícone):
    pip install pillow
    python tools/icon_from_image.py caminho/da/arte.png

Passos:
  1. recorta para quadrado, se necessário;
  2. deixa transparente o fundo branco que sobra fora do desenho arredondado
     (flood fill a partir das bordas, sem furar o branco interno do aparelho);
  3. grava greeplus.png (512 px) e greeplus.ico com 10 tamanhos, de 16 a 256 px.

O resultado é commitado no repositório; o programa em si não depende de Pillow.
"""

from __future__ import annotations

import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
PNG_SIZE = 512


def square(image: Image.Image) -> Image.Image:
    width, height = image.size
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def make_outside_transparent(image: Image.Image, white_min: int = 238) -> Image.Image:
    """Remove o branco do lado de fora do desenho, preservando o branco interno."""
    image = image.convert("RGBA")
    width, height = image.size
    pixels = image.load()
    visited = bytearray(width * height)
    queue: deque = deque()

    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        index = y * width + x
        if visited[index]:
            continue
        visited[index] = 1

        red, green, blue, _alpha = pixels[x, y]
        if not (red >= white_min and green >= white_min and blue >= white_min):
            continue  # Achou o desenho (ou uma sombra): para de propagar.

        pixels[x, y] = (red, green, blue, 0)
        queue.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))

    return image


def build(source: Path) -> tuple[Path, Path]:
    image = Image.open(source)
    image = make_outside_transparent(square(image))
    final = image.resize((PNG_SIZE, PNG_SIZE), Image.LANCZOS)

    png_path = ROOT / "greeplus.png"
    ico_path = ROOT / "greeplus.ico"
    final.save(png_path, format="PNG", optimize=True)

    frames = [final.resize((size, size), Image.LANCZOS) for size in SIZES]
    frames[-1].save(
        ico_path,
        format="ICO",
        sizes=[(size, size) for size in SIZES],
        append_images=frames[:-1],
    )

    # Cópia usada pelo servidor web (favicon) e pelo pacote instalado.
    package_dir = ROOT / "greeplus"
    if package_dir.is_dir():
        final.save(package_dir / "greeplus.png", format="PNG", optimize=True)
        (package_dir / "greeplus.ico").write_bytes(ico_path.read_bytes())
    return png_path, ico_path


def main(argv: list) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    source = Path(argv[1]).expanduser()
    if not source.is_file():
        print(f"arquivo não encontrado: {source}")
        return 1
    png_path, ico_path = build(source)
    print(f"gerado: {png_path.name} ({png_path.stat().st_size // 1024} KB)")
    print(f"gerado: {ico_path.name} ({ico_path.stat().st_size // 1024} KB, tamanhos {SIZES})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
