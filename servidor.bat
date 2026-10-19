@echo off
rem Roda a interface em segundo plano (sem janela). Chamado pelo servidor-oculto.vbs.
setlocal
cd /d "%~dp0"
set "PY="
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto :tem
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto :tem
echo Python nao encontrado. Instale de https://www.python.org/downloads/
exit /b 1
:tem

rem Evita subir duas copias: se a porta 8080 ja responde, nao faz nada.
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8080); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 exit /b 0

%PY% gree.py web --host 0.0.0.0 --http-port 8080 >> servidor.log 2>&1
exit /b 0
