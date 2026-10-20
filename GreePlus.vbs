' Abre o controle do Gree+ com icone proprio (sem janela de console).
Dim fso, shell, pasta, alvo
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
alvo = pasta & "\ABRIR-CONTROLE.bat"
If Not fso.FileExists(alvo) Then
    MsgBox "ABRIR-CONTROLE.bat nao encontrado na pasta " & pasta, 16, "Gree+"
    WScript.Quit 1
End If
shell.CurrentDirectory = pasta
shell.Run "cmd /c """ & alvo & """", 0, False
