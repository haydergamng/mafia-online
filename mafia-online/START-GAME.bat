@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
    echo Node.js is not installed or not in PATH.
    echo Install Node.js 20 or newer from https://nodejs.org/
    echo Then double-click START-GAME.bat again.
    start "" "https://nodejs.org/"
    pause
    exit /b 1
)
echo Starting Mafia Online game...
echo When ready, open http://localhost:3000
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"
node server.js
echo.
echo The game server has stopped.
pause
