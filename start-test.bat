@echo off
setlocal
title DX_Store TEST (dummy)
cd /d "%~dp0"

echo ==================================================
echo    DX_Store  -  TEST / DUMMY instance
echo    (real stock / history par koi asar nahi)
echo ==================================================
echo.

REM --- Pick a Python command ---
where python >nul 2>nul && (set "PYCMD=python") || (set "PYCMD=py")

set "PRODDB=C:\dx_store_data\dx_store.db"
set "TESTDB=C:\dx_store_data\dx_store_TEST.db"

REM --- First run (ya file delete kar di ho): real DB ki fresh WAL-safe copy ---
if not exist "%TESTDB%" (
  echo Test database copy bana raha hoon...
  %PYCMD% -c "import sqlite3; s=sqlite3.connect(r'%PRODDB%'); d=sqlite3.connect(r'%TESTDB%'); s.backup(d); d.close(); s.close()"
  echo   Ban gayi: %TESTDB%
  echo.
)

REM --- TEST environment: test DB, alag ports (5002 / 5174), ERP poller band.
REM     Ye vars neeche ke dono windows ko inherit ho jaate hain. ---
set "DATABASE_URL=sqlite:///C:/dx_store_data/dx_store_TEST.db"
set "PORT=5002"
set "ERP_SYNC_POLL_SECONDS=0"
set "MAIL_ENGINE_FORCE_OFF=1"
set "VITE_PORT=5174"
set "VITE_API_TARGET=http://localhost:5002"
set "VITE_TEST_MODE=1"

REM --- TEST backend (port 5002, test DB) ---
start "DX_Store TEST Backend (5002)" /D "%~dp0backend" cmd /k "%PYCMD% run.py"

REM --- TEST frontend (port 5174 -> 5002) ---
start "DX_Store TEST Frontend (5174)" /D "%~dp0frontend" cmd /k "npm run dev"

echo Servers aa rahe hain...
timeout /t 6 /nobreak >nul
start "" "http://localhost:5174"

echo.
echo   TEST APP   -^>  http://localhost:5174     ( ye DUMMY hai - yahin test karo )
echo   REAL APP   -^>  http://localhost:5173     ( start.bat - asli data )
echo.
echo   Isme jo bhi karo (user add, part issue, count) wo sirf TEST DB me jaata hai.
echo   Real data bilkul safe rehta hai. Upar amber "TEST MODE" patti dikhegi.
echo   Fresh test data chahiye?  dx_store_TEST.db file delete karke dubara chalao.
echo   Band karne ke liye ye do TEST windows band karo.
echo.
pause
endlocal
