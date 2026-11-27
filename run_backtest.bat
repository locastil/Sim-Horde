@echo off
rem Backtest: runs the world from 2015 to 2024 on real conditions and events, and checks it against what
rem really happened. About 5-15 minutes on a graphics card. Results go to the backtest folder.
cd /d "%~dp0"
set PY=horde_env\Scripts\python.exe
if not exist "%PY%" set PY=..\LA-Sim\sim_env\Scripts\python.exe
if not exist "%PY%" set PY=python
"%PY%" backtest.py
pause
