@echo off
setlocal
cd /d "%~dp0"

call setup_env.bat
if errorlevel 1 (
  pause
  exit /b 1
)

set PS_LOUNGE_HOST=127.0.0.1
set PS_LOUNGE_PORT=5000
set PS_LOUNGE_DEBUG=0

echo.
echo Open: http://%PS_LOUNGE_HOST%:%PS_LOUNGE_PORT%/
echo Press Ctrl+C to stop.
echo.

call ".venv\Scripts\python.exe" main.py
pause
