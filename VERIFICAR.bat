@echo off
cd /d "%~dp0"
echo  VERIFICAR Naubert Bot
echo  Pasta: %CD%
where node >nul 2>&1 && call node --version || echo Node NAO encontrado
if exist "package.json" (echo package.json OK) else (echo ERRO: pasta errada!)
if exist ".env" (echo .env OK) else (echo .env falta)
if exist "node_modules" (echo node_modules OK) else (echo node_modules falta - rode INSTALAR.bat)
netstat -ano | findstr :3000 >nul && echo Porta 3000 em uso || echo Porta 3000 livre
pause
