$ErrorActionPreference = "Stop"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python 3.10+ não foi encontrado. Instale Python e tente novamente."
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  python -m venv .venv
}
$Python = (Resolve-Path ".venv\Scripts\python.exe").Path
& $Python -m pip install --upgrade pip
& $Python -m pip install -r requirements.txt

$SpotdlDir = Join-Path $HOME ".spotdl"
New-Item -ItemType Directory -Force -Path $SpotdlDir | Out-Null
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $SpotdlDir "ffmpeg.exe"))) {
  & $Python -m spotdl --download-ffmpeg
} else {
  Write-Host "FFmpeg já está disponível; etapa ignorada."
}
if (-not (Get-Command deno -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $SpotdlDir "deno.exe"))) {
  & $Python -m spotdl --download-deno
} else {
  Write-Host "Deno já está disponível; etapa ignorada."
}

Write-Host "`nConfiguração concluída. Inicie o painel com:"
Write-Host "  .venv\Scripts\python.exe server.py"
