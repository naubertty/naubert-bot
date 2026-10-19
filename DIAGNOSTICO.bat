@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC - DIAGNOSTICO
color 0E

set "PY="
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto :tem_python
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto :tem_python
goto :sem_python

:tem_python
goto :com_python

:sem_python
echo.
echo  O Python nao esta instalado. Baixe em https://www.python.org/downloads/
echo  e marque "Add python.exe to PATH" na primeira tela do instalador.
echo.
start https://www.python.org/downloads/
pause
goto :fim

:com_python
echo ============================================================
echo    DIAGNOSTICO DO GREE+ NO PC
echo ============================================================
echo.
echo  Isso testa a rede, acha o aparelho e tenta o pareamento.
echo  Pode levar uns 30 segundos. Nao feche a janela.
echo.
%PY% gree.py diagnose > diagnostico.txt 2>&1
type diagnostico.txt
echo.
echo ------------------------------------------------------------
echo  Relatorio salvo em: diagnostico.txt
echo  Copie TODO o texto acima (ou abra o arquivo) e envie para
echo  quem esta te ajudando. A chave do aparelho aparece oculta.
echo ------------------------------------------------------------
echo.
pause

:fim
endlocal
