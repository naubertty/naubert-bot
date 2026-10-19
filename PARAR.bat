@echo off
echo Parando Naubert Bot...
taskkill /F /IM node.exe >nul 2>&1
if %errorlevel% equ 0 (echo Servidor parado!) else (echo Nenhum servidor rodando)
echo Agora pode excluir pasta antiga. Se nao der, reinicie PC.
pause
