@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC
color 0A

rem Se o servidor ja estiver rodando, so abre o navegador.
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8080); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 goto :abrir

echo Iniciando o servidor do Gree+...
start "" wscript.exe "%~dp0servidor-oculto.vbs"
echo Aguardando...
timeout /t 3 /nobreak >nul

:abrir
start "" "http://localhost:8080/"
exit /b 0
