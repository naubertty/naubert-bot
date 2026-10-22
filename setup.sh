#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN="${PYTHON:-python3}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python 3 não foi encontrado. Instale Python 3.10+ e tente novamente." >&2
  exit 1
fi

"$PYTHON_BIN" -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

if [[ -d "$HOME/.config/spotdl" || "${OSTYPE:-}" == linux* ]]; then
  SPOTDL_DIR="$HOME/.config/spotdl"
else
  SPOTDL_DIR="$HOME/.spotdl"
fi
mkdir -p "$SPOTDL_DIR"

if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -x "$SPOTDL_DIR/ffmpeg" ]; then
  python -m spotdl --download-ffmpeg
else
  echo "FFmpeg já está disponível; etapa ignorada."
fi

if ! command -v deno >/dev/null 2>&1 && [ ! -x "$SPOTDL_DIR/deno" ]; then
  python -m spotdl --download-deno
else
  echo "Deno já está disponível; etapa ignorada."
fi

echo
echo "Configuração concluída. Inicie o painel com:"
echo "  .venv/bin/python server.py"
