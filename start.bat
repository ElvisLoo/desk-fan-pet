@echo off
title Desktop Fan Pet - Start
setlocal

set HTA_PATH=%~dp0index.html

if not exist "%HTA_PATH%" (
    echo ERROR: index.html not found!
    pause
    exit /b 1
)

echo Starting Desktop Fan Pet...
echo - Window is transparent and always-on-top
echo - Drag the window to move it on desktop
echo - Use buttons to control fan speed
echo.

start "" mshta.exe "%HTA_PATH%"

endlocal
pause
