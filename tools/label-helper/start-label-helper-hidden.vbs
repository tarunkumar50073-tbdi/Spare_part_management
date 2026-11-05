' DX Store label helper, started hidden: no window, nothing on the taskbar.
' install-autostart.bat puts a shortcut to this file in the Windows Startup
' folder, so the helper runs whenever this PC's user signs in. Its log is
' %LOCALAPPDATA%\DXStore\label-helper.log.
Dim fso, here, sh
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\dx-label-helper.ps1""", 0, False
