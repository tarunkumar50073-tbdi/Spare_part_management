@echo off
REM Make the DX Store label helper start hidden whenever this PC's user signs
REM in: a shortcut to start-label-helper-hidden.vbs in the Startup folder.
REM Then start it now. To undo: run remove-autostart.bat.
setlocal
set "HERE=%~dp0"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DX Store label helper.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath=\"$env:WINDIR\System32\wscript.exe\"; $s.Arguments='\"%HERE%start-label-helper-hidden.vbs\"'; $s.WorkingDirectory='%HERE%'; $s.Description='DX Store label helper (direct QR label printing)'; $s.Save()"
if exist "%LNK%" (echo Autostart shortcut made: "%LNK%") else (echo Could not make the shortcut.)
wscript "%HERE%start-label-helper-hidden.vbs"
echo The label helper is running hidden. Check: http://127.0.0.1:9123/status
endlocal
