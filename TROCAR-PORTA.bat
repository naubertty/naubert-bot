@echo off
cd /d "%~dp0"
findstr /C:"PORT=" .env 2>nul || echo sem .env padrao 3000
set /p NOVA=Digite nova porta (ex: 5001): 
if "%NOVA%"=="" (echo Nenhuma digitada & pause & exit /b)
if not exist ".env" copy /Y ".env.example" ".env" >nul
powershell -Command "(Get-Content .env) -replace 'PORT=.*', 'PORT=%NOVA%' | Set-Content .env; Write-Host ' .env atualizado'"
echo Pronto! Clique INICIAR.bat - http://localhost:%NOVA%
pause
