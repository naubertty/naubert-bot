#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "=============================================================="
echo "  WinDirStat 2.9.3 Desktop - Reconstrução REA para PC"
echo "=============================================================="

if command -v node >/dev/null 2>&1; then
  echo "[OK] Node.js detectado! Iniciando aplicativo desktop..."
  exec node server.mjs --open
elif command -v python3 >/dev/null 2>&1; then
  echo "[OK] Python3 detectado! Iniciando interface nativa Tkinter..."
  exec python3 windirstat_desktop.py
else
  echo "[!] Instale Node.js ou Python 3 para escanear o sistema."
  exit 1
fi
