@echo off
cd /d "%~dp0"

echo.
echo  ========================================================
echo   NAUBERT BOT - Painel Diario de Classe
echo   SEMED Lago Verde/MA - EduGestao
echo  ========================================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
  if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"
  if exist "C:\Program Files (x86)\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files (x86)\nodejs"
)
where node >nul 2>&1
if %errorlevel% neq 0 (
  echo  ERRO: Node.js nao encontrado!
  echo  1. Abra Prompt e digite: node --version
  echo  2. Se funcionar, feche e abra INICIAR.bat novamente
  echo  3. Se nao, instale https://nodejs.org/
  echo.
  pause
  exit /b
)

echo  Node encontrado:
call node --version
echo.

if not exist ".env" (
  echo  Criando arquivo .env...
  copy /Y ".env.example" ".env" >nul
  echo  Arquivo .env criado
  echo.
)

if not exist "node_modules" (
  echo  Instalando dependencias (primeira vez demora 1-2 min)...
  call npm install
  call npm install --workspace=backend
  call npx playwright install chromium
  echo  Instalacao concluida!
) else (
  echo  Dependencias ja instaladas
  echo.
)

set PORTA=3000
for /f "tokens=2 delims==" %%a in ('findstr /C:"PORT=" .env 2^>nul') do set PORTA=%%a
if "%PORTA%"=="" set PORTA=3000

echo  Iniciando painel em http://localhost:%PORTA%
echo  Nao feche esta janela
echo  --------------------------------------------------------
timeout /t 3 >nul
start http://localhost:%PORTA%
node backend/src/server.js
pause
