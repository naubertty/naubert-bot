@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC - remover da inicializacao
color 06

set "INICIAR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "AREA=%USERPROFILE%\Desktop"

del /q "%INICIAR%\GreePlus.lnk" >nul 2>&1
del /q "%AREA%\Abrir Gree+.lnk" >nul 2>&1

echo.
echo  Atalhos removidos. O Gree+ nao abre mais sozinho com o Windows.
echo  O projeto continua na pasta; use ABRIR-CONTROLE.bat quando quiser.
echo.
pause
endlocal
