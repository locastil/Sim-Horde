@echo off
rem Variables test: economic shocks, women's freedoms, working hours and family ties. Two rounds: unseen countries,
rem then real ups and downs over the years. About 10-25 minutes on a graphics card. Nothing in the live world changes.
rem Results go to the backtest folder.
cd /d "%~dp0"
set PY=horde_env\Scripts\python.exe
if not exist "%PY%" set PY=..\LA-Sim\sim_env\Scripts\python.exe
if not exist "%PY%" set PY=python
"%PY%" variables_test.py
pause
