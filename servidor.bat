@echo off
rem Mantem o servidor rodando com ou sem janela. Chamado pelos .vbs.
rem   servidor.bat        -> com janela (mostra o log ao vivo)
rem   servidor.bat oculto -> sem janela (segundo plano)

setlocal
cd /d "%~dp0"
title Gree+ no PC - servidor

set "PY="
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto :tem_python
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto :tem_python
echo Python nao encontrado. Instale de https://www.python.org/downloads/
pause
exit /b 1

:tem_python
rem Se ja existe um servidor na porta 8080, nao sobe outro.
powershell -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8080); $c.Close(); exit 0 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 (
  echo O Gree+ ja esta rodando em http://localhost:8080/
  if /i not "%~1"=="oculto" (
     start "" "http://localhost:8080/"
     echo Esta janela fecha em 3 segundos.
     timeout /t 3 /nobreak >nul
  )
  exit /b 0
)

if /i "%~1"=="oculto" (
  %PY% gree.py web --host 0.0.0.0 --http-port 8080 >> servidor.log 2>&1
) else (
  %PY% gree.py web --host 0.0.0.0 --http-port 8080
  echo.
  echo O servidor parou. Veja as mensagens acima.
  pause
)
exit /b 0
