@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=python"
if exist "venv\Scripts\python.exe" set "PYTHON=venv\Scripts\python.exe"
%PYTHON% -m pip install --quiet --disable-pip-version-check -U "yt-dlp[default]"
if errorlevel 1 goto failed
%PYTHON% tools\download_channel.py --output "D:\kirinuki_source\kanade" --workers 3
if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo [ERROR] Some downloads failed or were stopped. Rerun to resume.
pause
exit /b 1
