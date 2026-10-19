@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC - remover da inicializacao
color 06

echo ============================================================
echo    DESFAZER A INICIALIZACAO AUTOMATICA
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0remover-inicializacao.ps1"
echo.
echo  O projeto continua nesta pasta. Use ABRIR-CONTROLE.bat quando quiser.
echo.
pause
exit /b 0
