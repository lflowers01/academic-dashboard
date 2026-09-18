@echo off
rem Stop the dashboard server.
if not defined DASH_PORT set "DASH_PORT=4321"
set found=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:%DASH_PORT% .*LISTENING"') do (taskkill /PID %%p /F >nul && set found=1)
if defined found (echo Dashboard stopped.) else (echo Dashboard was not running.)
