@echo off
setlocal
call "%~dp0dashboard\dashboard.cmd" %*
exit /b %errorlevel%
