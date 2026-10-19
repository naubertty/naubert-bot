# Remove os atalhos criados por instalar-inicializacao.ps1
$ErrorActionPreference = "Continue"

$startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
$removidos = 0

$alvos = @()
if (-not [string]::IsNullOrWhiteSpace($startup)) { $alvos += (Join-Path $startup "GreePlus.lnk") }
if (-not [string]::IsNullOrWhiteSpace($desktop)) { $alvos += (Join-Path $desktop "Abrir Gree+.lnk") }

foreach ($arquivo in $alvos) {
    if (Test-Path -LiteralPath $arquivo) {
        try {
            Remove-Item -LiteralPath $arquivo -Force
            Write-Host "Removido: $arquivo"
            $removidos = $removidos + 1
        } catch {
            Write-Host "Nao consegui remover: $arquivo"
        }
    }
}

if ($removidos -eq 0) {
    Write-Host "Nenhum atalho encontrado (ja estava desativado)."
}

try {
    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    if (Get-ItemProperty -Path $runKey -Name "GreePlus" -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $runKey -Name "GreePlus" -Force
        Write-Host "Removido: inicializacao no registro do Windows (GreePlus)"
        $removidos = $removidos + 1
    }
} catch {
    # chave nao existia
}

try {
    $conexao = New-Object Net.Sockets.TcpClient
    $conexao.Connect("127.0.0.1", 8080)
    $conexao.Close()
    Write-Host ""
    Write-Host "O servidor esta rodando agora; ele para quando o PC for reiniciado."
    Write-Host "Para parar ja: Gerenciador de Tarefas -> python.exe -> Finalizar tarefa"
} catch {
    # servidor nao esta rodando: nada a fazer
}

exit 0
