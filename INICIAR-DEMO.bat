@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC - MODO DEMONSTRACAO
color 0B

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
echo    GREE+ no PC  -  MODO DEMONSTRACAO
echo    (aparelho SIMULADO, nao precisa de ar-condicionado)
echo ============================================================
echo.
echo  O navegador vai abrir sozinho em: http://localhost:8080
echo  Clique nos botoes para testar (ligar, temperatura, modo...).
echo.
echo  Para encerrar: feche esta janela ou aperte Ctrl+C.
echo.
%PY% gree.py web --demo --open
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
