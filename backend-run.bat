@echo off
title DX_Store Backend (5001)
cd /d "%~dp0backend"
REM ==================================================================
REM  21 Nov 2026: after a restart the backend opened before the network
REM  (LAN / Tailscale) was up, could not reach the database and stopped,
REM  so the app was down until someone started it by hand. This keeps it
REM  running: if run.py stops, it starts again after 20 s. To stop the
REM  backend, close this window.
REM ==================================================================
where python >nul 2>nul && (set "PYCMD=python") || (set "PYCMD=py")
:again
%PYCMD% run.py
echo.
echo [%date% %time%] Backend stopped - starting again in 20 s (close this window to stop it).
timeout /t 20 /nobreak >nul
goto again
