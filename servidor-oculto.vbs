' Inicia o servidor do Gree+ sem abrir janela.
Dim fso, shell, pasta, alvo
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
alvo = pasta & "\servidor.bat"
If Not fso.FileExists(alvo) Then
    MsgBox "servidor.bat nao encontrado na pasta " & pasta, 16, "Gree+"
    WScript.Quit 1
End If
shell.CurrentDirectory = pasta
shell.Run "cmd /c """ & alvo & """", 0, False
