@echo off
title Desktop Fan Pet - Building EXE
setlocal

set HTA_PATH=%~dp0index.html
set EXE_PATH=%~dp0desk-fan-pet.hta

if not exist "%HTA_PATH%" (
    echo ERROR: index.html not found!
    pause
    exit /b 1
)

echo Copying HTML to HTA format...
copy /Y "%HTA_PATH%" "%EXE_PATH%" >nul

if exist "%EXE_PATH%" (
    echo.
    echo ========================================
    echo  Build complete!
    echo  File: %EXE_PATH%
    echo  Double-click desk-fan-pet.hta to run
    echo  The window is transparent and draggable
    echo ========================================
    echo.
    start "" "%EXE_PATH%"
) else (
    echo Build failed!
)

endlocal
pause
