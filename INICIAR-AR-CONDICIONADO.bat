@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC - CONECTAR AO AR-CONDICIONADO
color 0A

set "PY="
py -3 -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=py -3"
if defined PY goto :tem_python
python -c "import sys" >nul 2>&1
if not errorlevel 1 set "PY=python"
if defined PY goto :tem_python
goto :sem_python

:tem_python
%PY% -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>&1
if errorlevel 1 goto :python_antigo
goto :com_python

:com_python
echo ============================================================
echo    GREE+ no PC  -  CONECTAR AO AR-CONDICIONADO DE VERDADE
echo ============================================================
echo.
echo  IMPORTANTE: o PC precisa estar no MESMO Wi-Fi do aparelho
echo  (o mesmo Wi-Fi que o celular usa no app GREE+).
echo.
echo  Procurando aparelhos na rede...
echo.
%PY% gree.py scan --timeout 6
echo.
echo ------------------------------------------------------------
echo  Se apareceu um aparelho na lista acima, digite o IP dele
echo  (exemplo: 192.168.0.35) e aperte Enter.
echo.
echo  Se nao apareceu nada, aperte Enter sem digitar nada:
echo  a interface abre e voce pode tentar por la.
echo ------------------------------------------------------------
echo.
set /p "IP=IP do aparelho: "
if "%IP%"=="" goto :abrir_interface
echo.
echo  Pareando com %IP% ... (isso copia a chave do aparelho)
echo.
%PY% gree.py bind --ip %IP%
echo.
:abrir_interface
echo  Abrindo a interface no navegador...
echo.
%PY% gree.py web --open
if errorlevel 1 goto :erro

:sem_python
echo.
echo ============================================================
echo  O Python nao esta instalado neste computador.
echo ============================================================
echo.
echo  Siga estes passos (leva 2 minutos):
echo.
echo   1. Vou abrir a pagina de download do Python no navegador
echo   2. Clique no botao amarelo "Download Python 3.x"
echo   3. Abra o arquivo baixado
echo   4. NA PRIMEIRA TELA, marque a caixinha "Add python.exe to PATH"
echo      (fica embaixo, e a parte mais importante!)
echo   5. Clique em "Install Now" e espere terminar
echo   6. Volte aqui e abra este mesmo arquivo de novo (dois cliques)
echo.
start https://www.python.org/downloads/
pause
goto :fim

:python_antigo
echo.
echo O Python instalado e muito antigo. Instale a versao atual em:
echo https://www.python.org/downloads/
echo.
start https://www.python.org/downloads/
pause
goto :fim

goto :fim

:erro
echo.
echo ============================================================
echo  Algo deu errado.
echo ============================================================
echo  Copie o texto acima (ou tire uma foto da tela) e peca ajuda.
echo.
pause

:fim
endlocal
