@echo off
cd /d "%~dp0\.."
taskkill /F /IM node.exe >nul 2>&1
timeout /t 2 >nul
echo Feche janelas do Explorador e tente excluir pasta antiga.
pause
