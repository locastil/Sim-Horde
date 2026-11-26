@echo off
rem Pick a different graphics card for Sim Horde (for PCs with more than one, like a laptop GPU and an eGPU).
cd /d "%~dp0"
call start_sim_horde.bat --choose-gpu
