@echo off
rem Start the dashboard in the background (if it isn't already running) and open it.
cd /d "%~dp0"
if not defined DASH_PORT set "DASH_PORT=4321"
where node >nul 2>&1 || (echo Node.js is not installed. See README.md. & exit /b 1)
if not exist "%~dp0node_modules\@modelcontextprotocol\sdk" (echo Run "npm install" in this folder first. See README.md. & exit /b 1)
netstat -ano | findstr /r /c:"127.0.0.1:%DASH_PORT% .*LISTENING" >nul || wscript "%~dp0start-hidden.vbs"
rem Wait (up to ~10 s) until it answers, then open it.
for /l %%i in (1,1,20) do (
  netstat -ano | findstr /r /c:"127.0.0.1:%DASH_PORT% .*LISTENING" >nul && goto :open
  ping -n 2 127.0.0.1 >nul
)
echo The dashboard did not start. Check data\server.log in this folder.
exit /b 1
:open
start "" http://localhost:%DASH_PORT%
