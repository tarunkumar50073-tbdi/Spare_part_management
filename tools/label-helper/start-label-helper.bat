@echo off
REM DX Store label print helper - prints QR labels straight to the label
REM printer on this PC (no print window). Keep its window open; minimised is
REM fine. To start it with Windows, put a shortcut to this file in the
REM Startup folder (Win+R, shell:startup).
cd /d "%~dp0"
start "DX Store label helper" /MIN powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dx-label-helper.ps1"
