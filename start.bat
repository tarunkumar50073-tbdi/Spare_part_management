@echo off
setlocal
title DX_Store Launcher
cd /d "%~dp0"

echo ==================================================
echo    DX_Store  -  starting the full app
echo ==================================================
echo.

REM This launcher lives INSIDE the DX_Store folder (backend and frontend beside it).

REM --- Pick a Python command (python, else the py launcher) ---
where python >nul 2>nul && (set "PYCMD=python") || (set "PYCMD=py")

REM --- First run: install backend dependencies if Flask is missing ---
%PYCMD% -c "import flask" >nul 2>nul
if errorlevel 1 (
  echo Installing backend dependencies ^(first run only^)...
  pushd "backend"
  %PYCMD% -m pip install -r requirements.txt
  popd
  echo.
)

REM --- First run: install frontend dependencies if node_modules is missing ---
if not exist "frontend\node_modules" (
  echo Installing frontend dependencies ^(first run only, may take a few minutes^)...
  pushd "frontend"
  call npm install
  popd
  echo.
)

REM --- Launch the backend (Flask, port 5001) in its own window ---
start "DX_Store Backend (5001)" /D "%~dp0backend" cmd /k "%PYCMD% run.py"

REM --- Launch the frontend (Vite dev server, port 5173) in its own window ---
start "DX_Store Frontend (5173)" /D "%~dp0frontend" cmd /k "npm run dev"

REM --- Give the servers a few seconds, then open the app in the browser ---
echo Waiting for the servers to come up...
timeout /t 6 /nobreak >nul
start "" "http://localhost:5173"

REM --- Find this laptop's LAN IPv4 so other devices on the same WiFi know where
REM     to connect. (Vite also prints it as the "Network:" URL in its window.) ---
set "LANIP="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object -First 1 -ExpandProperty IPAddress)"`) do set "LANIP=%%i"

echo.
echo   This laptop:
echo     APP  -^>  http://localhost:5173     ( open this one )
echo     API  -^>  http://localhost:5001
if defined LANIP (
  echo.
  echo   Other devices on the SAME WiFi:
  echo     APP  -^>  http://%LANIP%:5173
  echo.
  echo   ^(First time only^) If a device cannot connect, allow the port through
  echo   Windows Firewall - run this ONCE in an ADMIN PowerShell:
  echo   netsh advfirewall firewall add rule name="DX_Store 5173" dir=in action=allow protocol=TCP localport=5173
) else (
  echo.
  echo   ^(Could not auto-detect the LAN IP - see the Vite window's "Network:" line.^)
)
echo.
echo   Two server windows have opened. Keep them open while you work.
echo   To STOP the app: close those two windows.
echo   You can close THIS window now.
echo.
pause
endlocal