@echo off
chcp 65001 >nul
title WinDirStat 2.9.3 Desktop (REA Clean-Room)
cd /d "%~dp0"

echo ==============================================================
echo   WinDirStat 2.9.3 Desktop - Reconstrucao REA para PC
echo ==============================================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] Node.js detectado! Iniciando servidor desktop com Cushion Treemap 3D...
    node server.mjs --open
    goto :eof
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [OK] Python detectado! Abrindo interface grafica nativa Tkinter...
    python windirstat_desktop.py
    goto :eof
)

echo [!] Abrindo interface interativa diretamente no navegador...
start "" "%~dp0renderer\index.html"
