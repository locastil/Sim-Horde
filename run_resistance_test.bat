@echo off
rem Resistance test: do simulated people who get used to lasting conditions give a more realistic happiness?
rem Two rounds: unseen countries, then real ups and downs over the years. About 15-25 minutes on a graphics card.
rem Nothing in the live world changes. Results go to the backtest folder.
cd /d "%~dp0"
set PY=horde_env\Scripts\python.exe
if not exist "%PY%" set PY=..\LA-Sim\sim_env\Scripts\python.exe
if not exist "%PY%" set PY=python
"%PY%" resistance_test.py
pause
