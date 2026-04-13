@echo off
cd /d "%~dp0"

REM Check if Python is available
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Python is not installed.
    echo  Please install Python from: https://www.python.org/downloads/
    echo  During install, CHECK "Add Python to PATH"
    echo.
    pause
    exit /b 1
)

echo.
echo  =============================================
echo   Lenovo AI Showcase - Local Dev Server
echo  =============================================
echo.
echo   Open in browser: http://localhost:8080
echo   Press Ctrl+C to stop server
echo.
python -m http.server 8080
