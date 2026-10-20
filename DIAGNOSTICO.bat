@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC - DIAGNOSTICO
color 0E

set "PY="
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto :com_python
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto :com_python
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
echo  Digite o IP do ar-condicionado (aparece na lista do roteador
echo  ou no app GREE+). Se nao souber, aperte Enter para pular.
echo.
set /p "IP=IP do aparelho: "
echo.
echo  Testando... isso leva uns 60 segundos. Nao feche a janela.
echo.

if "%IP%"=="" (
  %PY% gree.py diagnose > diagnostico.txt 2>&1
) else (
  %PY% gree.py diagnose --ip %IP% > diagnostico.txt 2>&1
  echo.>> diagnostico.txt
  echo --- Pacotes crus recebidos do IP %IP% --->> diagnostico.txt
  %PY% gree.py sniff --target %IP% --seconds 8 >> diagnostico.txt 2>&1
)

type diagnostico.txt
echo.
echo ------------------------------------------------------------
echo  Relatorio salvo em: diagnostico.txt
echo  Copie TODO o texto acima e envie para quem esta te ajudando.
echo ------------------------------------------------------------
echo.
pause

:fim
endlocal
