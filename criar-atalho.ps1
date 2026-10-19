param(
    [Parameter(Mandatory=$true)][string]$Target,
    [Parameter(Mandatory=$true)][string]$Shortcut,
    [string]$Arguments = "",
    [string]$WorkDir = "",
    [string]$Icon = ""
)
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($Shortcut)
$sc.TargetPath = $Target
$sc.Arguments = $Arguments
if ($WorkDir -ne "") { $sc.WorkingDirectory = $WorkDir }
if ($Icon -ne "") { $sc.IconLocation = $Icon }
$sc.WindowStyle = 7
$sc.Description = "Gree+ no PC - controle local do ar-condicionado"
$sc.Save()
