@echo off
REM Stop the DX Store label helper from starting with Windows, and stop it now.
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\DX Store label helper.lnk"
if exist "%LNK%" del "%LNK%"
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -like '*dx-label-helper.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
echo The label helper is stopped and will not start with Windows.
