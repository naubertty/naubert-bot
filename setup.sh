#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

VERSION_CHECK='import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] < (3, 15) else 1)'
PYTHON_BIN=""
if [[ -n "${PYTHON:-}" ]]; then
  CANDIDATES=("$PYTHON")
else
  CANDIDATES=(python3.14 python3.13 python3.12 python3.11 python3.10 python3)
fi

for candidate in "${CANDIDATES[@]}"; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c "$VERSION_CHECK" >/dev/null 2>&1; then
    PYTHON_BIN="$candidate"
    break
  fi
done

if [[ -z "$PYTHON_BIN" ]]; then
  echo "Python compatível não encontrado. spotDL 4.5.2 precisa do Python 3.10 a 3.14; Python 3.15 não é suportado." >&2
  echo "Instale Python 3.14 (recomendado) ou 3.13 e rode este script novamente." >&2
  exit 1
fi

echo "Usando $PYTHON_BIN ($($PYTHON_BIN --version 2>&1))."
VENV_PYTHON=".venv/bin/python"
if [[ -x "$VENV_PYTHON" ]] && ! "$VENV_PYTHON" -c "$VERSION_CHECK" >/dev/null 2>&1; then
  echo "A .venv existente usa Python incompatível; recriando-a..."
  rm -rf -- .venv
fi

if [[ ! -x "$VENV_PYTHON" ]]; then
  "$PYTHON_BIN" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m spotdl --version

if [[ -d "$HOME/.config/spotdl" || "${OSTYPE:-}" == linux* ]]; then
  SPOTDL_DIR="$HOME/.config/spotdl"
else
  SPOTDL_DIR="$HOME/.spotdl"
fi
mkdir -p "$SPOTDL_DIR"

if ! command -v ffmpeg >/dev/null 2>&1 && [[ ! -x "$SPOTDL_DIR/ffmpeg" ]]; then
  python -m spotdl --download-ffmpeg
else
  echo "FFmpeg já está disponível; etapa ignorada."
fi

if ! command -v deno >/dev/null 2>&1 && [[ ! -x "$SPOTDL_DIR/deno" ]]; then
  if ! python -m spotdl --download-deno; then
    echo "Aviso: Deno não pôde ser instalado. Ele é recomendado, mas opcional."
  fi
else
  echo "Deno já está disponível; etapa ignorada."
fi

echo
echo "Configuração concluída. Inicie o painel com:"
echo "  .venv/bin/python server.py"
