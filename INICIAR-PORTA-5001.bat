@echo off
cd /d "%~dp0"
set PORT=5001
if not exist ".env" copy /Y ".env.example" ".env" >nul
powershell -Command "(Get-Content .env) -replace 'PORT=.*', 'PORT=5001' | Set-Content .env" >nul 2>&1
where node >nul 2>&1 || (if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs")
start http://localhost:5001
node backend/src/server.js
pause
