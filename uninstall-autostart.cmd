@echo off
rem Remove the log-in auto-start and stop the server.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$lnk=Join-Path ([Environment]::GetFolderPath('Startup')) 'Academic Dashboard.lnk'; if (Test-Path $lnk) { Remove-Item -LiteralPath $lnk; 'Auto-start removed.' } else { 'Auto-start was not installed.' }"
call "%~dp0stop.cmd"
