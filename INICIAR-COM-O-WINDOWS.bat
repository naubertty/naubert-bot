@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC - iniciar junto com o Windows
color 0B

set "PASTA=%~dp0"
set "VBS=%PASTA%servidor-oculto.vbs"
set "INICIAR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "AREA=%USERPROFILE%\Desktop"

echo ============================================================
echo    DEIXAR O GREE+ PRONTO SEMPRE QUE LIGAR O PC
echo ============================================================
echo.
echo  Isso vai:
echo    1. criar um atalho na pasta "Inicializar" do Windows
echo       (o servidor sobe escondido, sem janela);
echo    2. criar um atalho "Abrir Gree+" na Area de Trabalho.
echo.
echo  Voce pode desfazer depois rodando REMOVER-DA-INICIACAO.bat
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%PASTA%criar-atalho.ps1" -Target "wscript.exe" -Arguments "\"%VBS%\"" -WorkDir "%PASTA%" -Shortcut "%INICIAR%\GreePlus.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -File "%PASTA%criar-atalho.ps1" -Target "%~dp0ABRIR-CONTROLE.bat" -WorkDir "%PASTA%" -Shortcut "%AREA%\Abrir Gree+.lnk"

if exist "%INICIAR%\GreePlus.lnk" (
  echo.
  echo  Pronto! O servidor inicia junto com o Windows.
) else (
  echo.
  echo  Nao consegui criar o atalho de inicializacao.
  echo  Tente rodar este arquivo com o botao direito -^> Executar como administrador.
)

if exist "%AREA%\Abrir Gree+.lnk" (
  echo  Atalho "Abrir Gree+" criado na Area de Trabalho.
)

echo.
echo  Testando agora...
start "" wscript.exe "%VBS%"
timeout /t 4 /nobreak >nul
start "" "http://localhost:8080/"
echo.
echo  Se o navegador abriu com o controle, esta funcionando.
echo.
pause
endlocal
