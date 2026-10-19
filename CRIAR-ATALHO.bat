@echo off
cd /d "%~dp0"
powershell -Command "$WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Naubert Bot.lnk'); $Shortcut.TargetPath = '%~dp0INICIAR.bat'; $Shortcut.WorkingDirectory = '%~dp0'; $Shortcut.Save(); Write-Host 'Atalho criado!'"
pause
