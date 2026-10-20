# Copia o projeto para C:\GreePlus (lugar estavel) e recria os atalhos la.
$ErrorActionPreference = "Continue"

$origem = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($origem)) {
    $origem = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
$destino = "C:\GreePlus"

Write-Host ""
Write-Host "Copiando de : $origem"
Write-Host "Para        : $destino"
Write-Host ""

try {
    New-Item -ItemType Directory -Path $destino -Force | Out-Null
} catch {
    Write-Host "ERRO: nao consegui criar $destino (precisa de permissao de administrador?)."
    exit 1
}

# robocopy devolve 0-7 quando deu certo (1 = copiou arquivos).
$saida = robocopy $origem $destino /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1
$codigo = $LASTEXITCODE
if ($codigo -gt 7) {
    Write-Host "ERRO: a copia falhou (robocopy codigo $codigo)."
    exit 1
}

$instalador = Join-Path $destino "instalar-inicializacao.ps1"
if (-not (Test-Path -LiteralPath $instalador)) {
    Write-Host "ERRO: os arquivos nao chegaram em $destino."
    exit 1
}

Write-Host "Copia concluida. Recriando os atalhos para o novo local..."
Write-Host ""
& powershell -NoProfile -ExecutionPolicy Bypass -File $instalador
$resultado = $LASTEXITCODE

Write-Host ""
Write-Host "Agora voce pode apagar a pasta antiga (a que esta em Downloads)."
Write-Host "Use sempre o atalho 'Abrir Gree+' da Area de Trabalho."
Write-Host ""
Start-Process explorer.exe $destino
exit $resultado
