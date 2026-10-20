# Cria os atalhos do Gree+ usando os caminhos que o proprio Windows informa.
# Nao depende de %APPDATA%, do idioma do Windows nem do OneDrive.
$ErrorActionPreference = "Continue"

$pasta = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($pasta)) {
    $pasta = Split-Path -Parent $MyInvocation.MyCommand.Definition
}
if ($pasta) { $pasta = $pasta.TrimEnd([char]92) }   # remove "\" do final

$vbs      = Join-Path $pasta "servidor-oculto.vbs"
$iniciar  = Join-Path $pasta "GreePlus.vbs"          # atalho do usuario: sem console
$icone    = Join-Path $pasta "greeplus.ico"
$iconePng = Join-Path $pasta "greeplus.png"

Write-Host ""
Write-Host "Pasta do projeto : $pasta"

if (-not (Test-Path -LiteralPath $vbs)) {
    Write-Host "ERRO: servidor-oculto.vbs nao encontrado nesta pasta."
    exit 1
}
if (-not (Test-Path -LiteralPath $iniciar)) {
    Write-Host "ERRO: GreePlus.vbs nao encontrado nesta pasta."
    exit 1
}
if (Test-Path -LiteralPath $icone) {
    Write-Host "Icone            : greeplus.ico (aplicado nos atalhos)"
} else {
    Write-Host "AVISO: greeplus.ico nao encontrado; os atalhos terao o icone padrao."
}

$startup = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)

# Plano B: se o Windows nao informar a pasta, tenta o caminho classico.
if ([string]::IsNullOrWhiteSpace($startup) -and $env:APPDATA) {
    $startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
}
if ([string]::IsNullOrWhiteSpace($desktop) -and $env:USERPROFILE) {
    $desktop = Join-Path $env:USERPROFILE "Desktop"
}

Write-Host "Inicializar      : $startup"
Write-Host "Area de Trabalho : $desktop"
Write-Host ""

if ([string]::IsNullOrWhiteSpace($startup)) {
    Write-Host "ERRO: o Windows nao informou a pasta Inicializar."
    exit 1
}
if (-not (Test-Path -LiteralPath $startup)) {
    Write-Host "ERRO: a pasta Inicializar nao existe: $startup"
    exit 1
}
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) {
    Write-Host "AVISO: Area de Trabalho nao encontrada; criando so o atalho de inicializacao."
    $desktop = ""
}

$wscript = Join-Path $env:WINDIR "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscript)) { $wscript = "wscript.exe" }
$falhas = 0

# --- 1) atalho na inicializacao: servidor escondido, sem janela ---
try {
    $lnkIniciar = Join-Path $startup "GreePlus.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $atalho = $shell.CreateShortcut($lnkIniciar)
    $atalho.TargetPath = $wscript
    $atalho.Arguments = '"' + $vbs + '"'
    $atalho.WorkingDirectory = $pasta
    $atalho.WindowStyle = 7
    $atalho.Description = "Gree+ no PC - inicia o servidor local"
    if (Test-Path -LiteralPath $icone) { $atalho.IconLocation = "$icone,0" }
    $atalho.Save()
    if (Test-Path -LiteralPath $lnkIniciar) {
        Write-Host "OK: atalho de inicializacao criado"
        Write-Host "    $lnkIniciar"
    } else {
        Write-Host "ERRO: o atalho de inicializacao nao foi gravado"
        $falhas = $falhas + 1
    }
} catch {
    Write-Host "ERRO ao criar o atalho de inicializacao: $($_.Exception.Message)"
    $falhas = $falhas + 1
}

# --- 1b) plano B: chave Run do usuario (caso a pasta Inicializar falhe) ---
if ($falhas -gt 0) {
    try {
        $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
        $valor = '"' + $wscript + '" "' + $vbs + '"'
        New-Item -Path $runKey -Force | Out-Null
        New-ItemProperty -Path $runKey -Name "GreePlus" -Value $valor -PropertyType String -Force | Out-Null
        Write-Host "OK: inicializacao registrada no Windows (chave Run do usuario)"
        $falhas = 0
    } catch {
        Write-Host "AVISO: tambem nao consegui registrar a inicializacao no registro do Windows."
    }
}

# --- 2) atalho na Area de Trabalho ---
if ($desktop -ne "") {
    try {
        $lnkAbrir = Join-Path $desktop "Abrir Gree+.lnk"
        $shell2 = New-Object -ComObject WScript.Shell
        # wscript.exe abre o GreePlus.vbs: sem janela preta e com icone proprio.
        $atalho2 = $shell2.CreateShortcut($lnkAbrir)
        $atalho2.TargetPath = $wscript
        $atalho2.Arguments = '"' + $iniciar + '"'
        $atalho2.WorkingDirectory = $pasta
        $atalho2.WindowStyle = 7
        $atalho2.Description = "Abre o controle do ar-condicionado"
        if (Test-Path -LiteralPath $icone) { $atalho2.IconLocation = "$icone,0" }
        $atalho2.Save()
        if (Test-Path -LiteralPath $lnkAbrir) {
            Write-Host "OK: atalho 'Abrir Gree+' criado na Area de Trabalho (com icone)"
        } else {
            Write-Host "AVISO: nao consegui criar o atalho da Area de Trabalho"
        }

        # Atalho opcional na pasta do projeto, para fixar na barra de tarefas.
        $lnkPasta = Join-Path $pasta "Gree+ (abrir).lnk"
        $atalho3 = $shell2.CreateShortcut($lnkPasta)
        $atalho3.TargetPath = $wscript
        $atalho3.Arguments = '"' + $iniciar + '"'
        $atalho3.WorkingDirectory = $pasta
        $atalho3.WindowStyle = 7
        $atalho3.Description = "Abre o controle do ar-condicionado"
        if (Test-Path -LiteralPath $icone) { $atalho3.IconLocation = "$icone,0" }
        $atalho3.Save()
        Write-Host "OK: atalho 'Gree+ (abrir).lnk' criado na pasta do projeto"
        Write-Host "    (arraste para a barra de tarefas ou Menu Iniciar, se quiser)"
    } catch {
        Write-Host "AVISO: nao consegui criar o atalho da Area de Trabalho: $($_.Exception.Message)"
    }
}

# --- 3) aviso quando o projeto esta em Downloads ---
if ($pasta -like "*\Downloads\*") {
    Write-Host ""
    Write-Host "AVISO: o projeto esta dentro de Downloads."
    Write-Host "O Windows pode limpar essa pasta; nesse caso os atalhos param de funcionar."
    Write-Host "Recomendado: mover a pasta para C:\GreePlus (o menu oferece isso)."
}

Write-Host ""
Write-Host "Dica: se preferir um .exe de verdade (com icone no proprio arquivo),"
Write-Host "rode:  powershell -ExecutionPolicy Bypass -File criar-exe.ps1"

Write-Host ""
if ($falhas -eq 0) {
    Write-Host "CONCLUIDO: o Gree+ vai iniciar junto com o Windows."
    exit 0
} else {
    Write-Host "CONCLUIDO COM ERROS: veja as mensagens acima."
    exit 1
}
