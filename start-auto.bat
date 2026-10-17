@echo off
setlocal
title DX_Store Auto-start
cd /d "%~dp0"

REM ==================================================================
REM  DX_Store - automatic start at Windows sign-in (16 Oct 2026).
REM  The store asked that the app start by itself, so the 09:00 mails
REM  and the ERP sync run on time even when nobody opens it by hand
REM  (on 14 Oct the app was not running at 09:00). A shortcut to this
REM  file sits in the Windows Startup folder.
REM
REM  Same servers as start.bat, but: each one is started only if it is
REM  not already running (so a second start never makes a clash), the
REM  two windows open minimised, no browser is opened and nothing waits
REM  for a key. To stop the app, close the two server windows as usual.
REM ==================================================================

where python >nul 2>nul && (set "PYCMD=python") || (set "PYCMD=py")

REM --- Backend (Flask, port 5001) - only if nothing listens on 5001 yet ---
netstat -ano | findstr /R /C:":5001 .*LISTENING" >nul
if errorlevel 1 (
  start "DX_Store Backend (5001)" /MIN /D "%~dp0backend" cmd /k "%PYCMD% run.py"
) else (
  echo Backend already running on port 5001 - not started again.
)

REM --- Frontend (Vite dev server, port 5173) - only if nothing listens on 5173 ---
netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if errorlevel 1 (
  start "DX_Store Frontend (5173)" /MIN /D "%~dp0frontend" cmd /k "npm run dev"
) else (
  echo Frontend already running on port 5173 - not started again.
)

endlocal
exit /b 0
