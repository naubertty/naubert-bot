@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC - iniciar junto com o Windows
color 0B

echo ============================================================
echo    DEIXAR O GREE+ PRONTO SEMPRE QUE LIGAR O PC
echo ============================================================
echo.
echo  Isso vai:
echo    1. criar um atalho na pasta "Inicializar" do Windows
echo       (o servidor sobe escondido, sem janela);
echo    2. criar um atalho "Abrir Gree+" na Area de Trabalho.
echo.
echo  Para desfazer depois: REMOVER-DA-INICIACAO.bat
echo.
pause

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-inicializacao.ps1"
set "RESULTADO=%ERRORLEVEL%"
echo.
if not "%RESULTADO%"=="0" goto :manual

echo  Testando agora: o navegador vai abrir em instantes...
start "" wscript.exe "%~dp0servidor-oculto.vbs"
timeout /t 4 /nobreak >nul
start "" "http://localhost:8080/"
echo.
echo  Pronto. Daqui pra frente: ligar o PC e abrir o atalho "Abrir Gree+".
echo.

if exist "%~dp0mover-para-C.ps1" (
  choice /c SN /n /m "Mover o projeto para C:\GreePlus (recomendado)? [S/N] "
  if errorlevel 2 goto :fim
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mover-para-C.ps1"
)

:fim
echo.
pause
exit /b 0

:manual
echo ------------------------------------------------------------
echo  Nao consegui criar os atalhos automaticamente.
echo.
echo  Faca na mao (30 segundos):
echo    1. Aperte Win+R e digite:  shell:startup
echo    2. Botao direito na pasta que abrir -^> Novo -^> Atalho
echo    3. Em "local do item" cole exatamente o texto abaixo:
echo.
echo       wscript.exe "%~dp0servidor-oculto.vbs"
echo.
echo    4. Clique em Avancar, de o nome GreePlus e clique em Concluir.
echo ------------------------------------------------------------
echo.
pause
exit /b 1
