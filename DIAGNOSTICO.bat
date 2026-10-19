@echo off
echo DIAGNOSTICO
echo Pasta: %CD% Arquivo: %~f0
where node
node --version
npm --version
if exist "package.json" (echo package.json OK) else (echo FALTA - pasta errada!)
pause
node backend/src/server.js
pause
