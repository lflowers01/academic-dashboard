@echo off
rem Start the dashboard automatically (hidden) every time you log in to Windows. No admin rights needed.
rem The folder path travels in an environment variable, so spaces, apostrophes or accents in it can't break anything.
set "DASH_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:DASH_DIR; $q=[char]34; $lnk=Join-Path ([Environment]::GetFolderPath('Startup')) 'Academic Dashboard.lnk'; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($lnk); $s.TargetPath=Join-Path $env:WINDIR 'System32\wscript.exe'; $s.Arguments=$q+(Join-Path $d 'start-hidden.vbs')+$q; $s.WorkingDirectory=$d; $s.Description='Academic Dashboard (localhost)'; $s.Save(); if (Test-Path $lnk) { 'Auto-start installed: the dashboard will start when you log in.' } else { exit 1 }"
if errorlevel 1 (echo Could not create the Startup shortcut. & exit /b 1)
call "%~dp0start.cmd"
