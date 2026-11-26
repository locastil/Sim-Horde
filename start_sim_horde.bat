@echo off
rem Sim Horde for Windows. Double-click to start.
setlocal
cd /d "%~dp0"
title Sim Horde
if exist horde_env\Scripts\python.exe goto run

rem ---- Find Python 3.10 or newer ----
set "PY="
call :findpy
if defined PY goto havepy

echo.
echo Sim Horde needs Python (free, about 30 MB), and it isn't on this PC yet.
where winget >nul 2>&1
if errorlevel 1 goto manual
choice /c YN /m "Install it for you now"
if errorlevel 2 goto manual
echo Installing Python...
winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
call :findpy
if defined PY goto havepy

:manual
echo.
echo Opening the Python download page. Install it, tick "Add python.exe to PATH",
echo then double-click start_sim_horde.bat again.
start "" https://www.python.org/downloads/
pause
exit /b 1

:havepy
echo Setting up Sim Horde. This happens once and takes a few minutes.
%PY% -m venv horde_env
if not exist horde_env\Scripts\python.exe goto manual
horde_env\Scripts\python -m pip install --upgrade pip -q
echo Downloading PyTorch, about 3 GB...
horde_env\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu128 || horde_env\Scripts\python -m pip install torch

:run
horde_env\Scripts\python -c "import numpy" >nul 2>&1 || horde_env\Scripts\python -m pip install numpy -q
horde_env\Scripts\python worker.py %*
pause
exit /b

:findpy
py -3 -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if not errorlevel 1 (set "PY=py -3" & exit /b)
python -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if not errorlevel 1 (set "PY=python" & exit /b)
for /d %%d in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%d\python.exe" set PY="%%d\python.exe"
exit /b
