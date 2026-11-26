@echo off
rem Sim Horde worker for Windows. Double-click to start. The first start installs what it needs (a few minutes).
setlocal
cd /d "%~dp0"
title Sim Horde worker
if not exist horde_env\Scripts\python.exe (
  echo Setting up the Sim Horde worker. This happens once and takes a few minutes.
  py -3.12 -m venv horde_env 2>nul || py -3 -m venv horde_env 2>nul || python -m venv horde_env
  if not exist horde_env\Scripts\python.exe (
    echo.
    echo Python isn't installed. Get it from https://www.python.org/downloads/
    echo During install, tick "Add python.exe to PATH". Then double-click start_worker.bat again.
    pause & exit /b 1
  )
  horde_env\Scripts\python -m pip install --upgrade pip -q
  echo Installing PyTorch for NVIDIA GPUs, about 3 GB...
  horde_env\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu128 || horde_env\Scripts\python -m pip install torch
)
horde_env\Scripts\python worker.py %*
pause
