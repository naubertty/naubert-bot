$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

# spotDL 4.5.2 declares Python >=3.10,<3.15. Prefer the newest supported
# interpreter installed by the Windows Python Launcher instead of plain `python`,
# which may point to an unsupported preview such as Python 3.15.
$VersionCheck = "import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] < (3, 15) else 1)"
$PythonCommand = $null
$Launcher = Get-Command py -ErrorAction SilentlyContinue
if ($Launcher) {
  foreach ($Version in @("3.14", "3.13", "3.12", "3.11", "3.10")) {
    & $Launcher.Source "-$Version" -c $VersionCheck *> $null
    if ($LASTEXITCODE -eq 0) {
      $PythonCommand = @($Launcher.Source, "-$Version")
      break
    }
  }
}

if (-not $PythonCommand) {
  $PythonApp = Get-Command python -ErrorAction SilentlyContinue
  if ($PythonApp) {
    & $PythonApp.Source -c $VersionCheck *> $null
    if ($LASTEXITCODE -eq 0) {
      $PythonCommand = @($PythonApp.Source)
    }
  }
}

if (-not $PythonCommand) {
  throw "Python compatível não encontrado. spotDL 4.5.2 precisa do Python 3.10 a 3.14; Python 3.15 não é suportado. Instale Python 3.14 (recomendado) ou 3.13 e rode este script novamente."
}

$PythonExe = $PythonCommand[0]
$PythonSelector = $null
if ($PythonCommand.Count -gt 1) {
  $PythonSelector = $PythonCommand[1]
}

$VenvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (Test-Path $VenvPython) {
  & $VenvPython -c $VersionCheck *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "A .venv existente usa Python incompatível; recriando-a com a versão suportada..."
    Remove-Item -LiteralPath (Join-Path $PSScriptRoot ".venv") -Recurse -Force
  }
}

if (-not (Test-Path $VenvPython)) {
  if ($PythonSelector) {
    & $PythonExe $PythonSelector -m venv (Join-Path $PSScriptRoot ".venv")
  } else {
    & $PythonExe -m venv (Join-Path $PSScriptRoot ".venv")
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Não foi possível criar o ambiente virtual. Confirme a instalação do Python 3.10–3.14."
  }
}

$VenvPython = (Resolve-Path $VenvPython).Path
& $VenvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
  throw "Falha ao atualizar pip; a configuração foi interrompida."
}
& $VenvPython -m pip install -r (Join-Path $PSScriptRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) {
  throw "Falha ao instalar spotDL. Confirme que o ambiente usa Python 3.10–3.14 e tente novamente."
}
& $VenvPython -m spotdl --version
if ($LASTEXITCODE -ne 0) {
  throw "spotDL não foi instalado corretamente; a configuração foi interrompida."
}

$SpotdlDir = Join-Path $HOME ".spotdl"
New-Item -ItemType Directory -Force -Path $SpotdlDir | Out-Null
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $SpotdlDir "ffmpeg.exe"))) {
  & $VenvPython -m spotdl --download-ffmpeg
  if ($LASTEXITCODE -ne 0) {
    throw "Não foi possível preparar o FFmpeg. Instale FFmpeg manualmente e rode o script novamente."
  }
} else {
  Write-Host "FFmpeg já está disponível; etapa ignorada."
}

if (-not (Get-Command deno -ErrorAction SilentlyContinue) -and -not (Test-Path (Join-Path $SpotdlDir "deno.exe"))) {
  & $VenvPython -m spotdl --download-deno
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Deno não foi instalado. Ele é opcional/recomendado; o painel ainda pode ser iniciado."
  }
} else {
  Write-Host "Deno já está disponível; etapa ignorada."
}

Write-Host "`nConfiguração concluída. Inicie o painel com:"
Write-Host "  .\.venv\Scripts\python.exe server.py"
