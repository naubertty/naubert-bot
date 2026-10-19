@echo off
cd /d "%~dp0"
echo  ========================================================
echo   INSTALAR Naubert Bot
echo  ========================================================
where node >nul 2>&1
if %errorlevel% neq 0 (
  if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
)
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo  ERRO: Node.js nao encontrado! Baixe https://nodejs.org/
  start https://nodejs.org/
  pause
  exit /b
)
call node --version
call npm --version
if not exist ".env" copy /Y ".env.example" ".env" >nul
call npm install
call npm install --workspace=backend
call npx playwright install chromium
echo  Instalado! Clique em INICIAR.bat
pause
