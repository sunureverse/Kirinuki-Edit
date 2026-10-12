@echo off
setlocal
cd /d "%~dp0"
python -c "import sys; assert sys.version_info >= (3, 11)" >nul 2>&1
if errorlevel 1 goto prerequisites
node --version >nul 2>&1
if errorlevel 1 goto prerequisites
call npm --version >nul 2>&1
if errorlevel 1 goto prerequisites
ffmpeg -version >nul 2>&1
if errorlevel 1 goto prerequisites
ffprobe -version >nul 2>&1
if errorlevel 1 goto prerequisites
pushd shortsmith
call npm ci
if errorlevel 1 (
    popd
    goto failed
)
popd
python -m venv venv
if errorlevel 1 goto failed
venv\Scripts\python.exe -m pip install -r requirements-transcription.txt
if errorlevel 1 goto failed
venv\Scripts\python.exe -m pip check
if errorlevel 1 goto failed
venv\Scripts\python.exe tools\download_fonts.py
if errorlevel 1 goto failed
set "SHORTSMITH_FONTS=%CD%\local-fonts"
node shortsmith\bin\shortsmith.mjs doctor --preset basic-shorts
if errorlevel 1 goto failed
echo Installation complete. Run dashboard\dashboard.cmd or the Korean-named launcher.
echo The Whisper model downloads on first transcription (about 3 GB).
pause
exit /b 0
:prerequisites
echo Install Python 3.11+, Node.js LTS, FFmpeg and ffprobe first.
echo See docs\windows-setup.md. Reopen this window after installing them.
pause
exit /b 1
:failed
echo Installation failed. Keep the error above and ask Codex for help.
pause
exit /b 1
