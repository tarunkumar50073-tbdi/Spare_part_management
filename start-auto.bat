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
REM
REM  22 Oct 2026: a server started a moment earlier (start.bat clicked at
REM  sign-in) takes ~30 s to load before it listens on its port, and this
REM  file - run from the Startup folder 26 s later - found the port free
REM  and started a SECOND backend; Windows let both listen on 5001. So
REM  while that server is still loading, wait for its port (up to 60 s)
REM  before deciding.
REM ==================================================================

where python >nul 2>nul && (set "PYCMD=python") || (set "PYCMD=py")

REM --- Backend (Flask, port 5001) - only if nothing listens on 5001 yet ---
call :await_port 5001 "run\.py"
netstat -ano | findstr /R /C:":5001 .*LISTENING" >nul
if errorlevel 1 (
  start "DX_Store Backend (5001)" /MIN /D "%~dp0backend" cmd /k "%PYCMD% run.py"
) else (
  echo Backend already running on port 5001 - not started again.
)

REM --- Frontend (Vite dev server, port 5173) - only if nothing listens on 5173 ---
call :await_port 5173 "vite\.js"
netstat -ano | findstr /R /C:":5173 .*LISTENING" >nul
if errorlevel 1 (
  start "DX_Store Frontend (5173)" /MIN /D "%~dp0frontend" cmd /k "npm run dev"
) else (
  echo Frontend already running on port 5173 - not started again.
)

endlocal
exit /b 0

REM ------------------------------------------------------------------
REM  :await_port PORT PATTERN - returns at once when PORT is listening
REM  or when no process whose command line matches PATTERN (a regex:
REM  "run\.py" = the backend, "vite\.js" = the frontend) is running.
REM  While such a server is still loading, checks again every 3 s, at
REM  most 20 times (60 s) - a TEST instance (run.py on port 5002) never
REM  opens 5001, so it only delays the start, never stops it.
REM ------------------------------------------------------------------
:await_port
set /a TRIES=0
:await_loop
netstat -ano | findstr /R /C:":%~1 .*LISTENING" >nul
if not errorlevel 1 exit /b 0
powershell -NoProfile -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '%~2' }) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 exit /b 0
set /a TRIES+=1
if %TRIES% GEQ 20 exit /b 0
echo Waiting for the server on port %~1 that is still starting...
ping -n 4 127.0.0.1 >nul
goto await_loop
