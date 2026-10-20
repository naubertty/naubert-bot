# Gera GreePlus.exe (um unico arquivo com o icone embutido).
# Precisa de internet na primeira vez (baixa o PyInstaller) e de Python instalado.
$ErrorActionPreference = "Continue"
$pasta = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($pasta)) { $pasta = Split-Path -Parent $MyInvocation.MyCommand.Definition }
if ($pasta) { $pasta = $pasta.TrimEnd([char]92) }
Set-Location $pasta

Write-Host ""
Write-Host "=== Gerar GreePlus.exe ==="
Write-Host "Pasta: $pasta"
Write-Host ""

# 1) Python
$python = ""
foreach ($candidato in @("py -3", "python")) {
    try {
        $cmd = Get-Command ($candidato.Split(" ")[0]) -ErrorAction Stop
        if ($cmd) { $python = $candidato; break }
    } catch { }
}
if ($python -eq "") {
    Write-Host "ERRO: Python nao encontrado. Instale de https://www.python.org/downloads/"
    exit 1
}
Write-Host "Python: $python"

if (-not (Test-Path -LiteralPath (Join-Path $pasta "greeplus.ico"))) {
    Write-Host "ERRO: greeplus.ico nao encontrado nesta pasta."
    exit 1
}

# 2) PyInstaller
Write-Host ""
Write-Host "Instalando o PyInstaller (so na primeira vez)..."
& cmd /c "$python -m pip install --quiet --upgrade pyinstaller"
if ($LASTEXITCODE -ne 0) {
    Write-Host "AVISO: falhou o 'pip install pyinstaller'. Tentando continuar mesmo assim."
}

# 3) Build
Write-Host ""
Write-Host "Gerando o executavel (pode levar 1-3 minutos)..."
$args = @(
    "-m", "PyInstaller",
    "--noconfirm", "--clean",
    "--onefile",
    "--name", "GreePlus",
    "--icon", "greeplus.ico",
    "--add-data", "greeplus/webui.html;greeplus",
    "--collect-submodules", "greeplus",
    "--version-file", "versao-exe.txt",
    "gree.py"
)
& cmd /c "$python $($args -join ' ')"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $pasta "dist\GreePlus.exe"))) {
    Write-Host ""
    Write-Host "ERRO: o PyInstaller nao gerou o exe. Veja as mensagens acima."
    exit 1
}

Write-Host ""
Write-Host "OK: dist\GreePlus.exe criado."
Write-Host ""
Write-Host "Como usar o exe:"
Write-Host "  GreePlus.exe web --demo            -> testa a interface"
Write-Host "  GreePlus.exe web                   -> controle normal"
Write-Host "  GreePlus.exe scan / status / set   -> linha de comando"
Write-Host ""
Write-Host "Para abrir sem janela preta, crie um atalho para o exe e marque"
Write-Host "'Executar: Minimizado' (ou use o atalho Gree+ (abrir).lnk da pasta)."
Write-Host ""
Start-Process explorer.exe (Join-Path $pasta "dist")
exit 0
