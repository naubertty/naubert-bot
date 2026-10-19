@echo off
setlocal
cd /d "%~dp0"
title Gree+ no PC - LIBERAR FIREWALL DO WINDOWS
color 0C

net session >nul 2>&1
if errorlevel 1 goto :precisa_admin
goto :executar

:precisa_admin
echo.
echo  Este atalho precisa ser executado como ADMINISTRADOR para abrir
echo  a porta do firewall do Windows.
echo.
echo  Vou pedir a permissao agora. Clique em "Sim" na janela do Windows.
echo.
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
goto :fim

:executar
echo ============================================================
echo    LIBERANDO O FIREWALL DO WINDOWS PARA O GREE+
echo ============================================================
echo.
echo  Regras que serao criadas:
echo    - Entrada UDP porta 7000 (comunicacao com o ar-condicionado)
echo    - Pythons encontrados neste computador (rede privada)
echo.
for %%P in (python.exe py.exe) do (
  netsh advfirewall firewall add rule name="GreePlus - %%P" dir=in action=allow program="%%~$PATH:P" enable=yes profile=private >nul 2>&1
)
netsh advfirewall firewall add rule name="GreePlus UDP 7000" dir=in action=allow protocol=UDP localport=7000 enable=yes profile=private
echo.
echo  Pronto. Feche esta janela e rode o DIAGNOSTICO.bat novamente.
echo.
pause

:fim
endlocal
