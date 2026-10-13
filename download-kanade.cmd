@echo off
setlocal
cd /d "%~dp0"
set "PYTHON=python"
if exist "venv\Scripts\python.exe" set "PYTHON=venv\Scripts\python.exe"
%PYTHON% -m pip install -U "yt-dlp[default]"
if errorlevel 1 goto failed
%PYTHON% tools\download_channel.py --output "D:\kirinuki_source\kanade" --workers 3
if errorlevel 1 goto failed
echo Download run completed. Files: D:\kirinuki_source\kanade
pause
exit /b 0
:failed
echo Some downloads failed or were stopped. See D:\kirinuki_source\kanade\download-logs.
echo Rerun this file to retry; completed downloads are skipped.
pause
exit /b 1
