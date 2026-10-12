@echo off
setlocal
cd /d "%~dp0.."
if not exist "venv\Scripts\python.exe" (
    echo Run install-windows.cmd in the repository folder first.
    pause
    exit /b 1
)
set "SHORTSMITH_FONTS=%CD%\local-fonts"
"venv\Scripts\python.exe" dashboard\server.py --open %*
if errorlevel 1 pause
