\
    @echo off
    setlocal enabledelayedexpansion
    cd /d "%~dp0"

    if not exist ".venv" (
      echo [1/3] Creating venv...
      py -3 -m venv .venv
      if errorlevel 1 (
        echo Python 3 not found. Install Python 3 and ensure "py" launcher works.
        pause
        exit /b 1
      )
    )

    echo [2/3] Installing requirements...
    call ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
    call ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 (
      echo Failed to install requirements.
      pause
      exit /b 1
    )

    echo [3/3] Starting server...
    set PS_LOUNGE_HOST=127.0.0.1
    set PS_LOUNGE_PORT=5000
    set PS_LOUNGE_DEBUG=0

    echo.
    echo Open: http://%PS_LOUNGE_HOST%:%PS_LOUNGE_PORT%/
    echo Press Ctrl+C to stop.
    echo.

    call ".venv\Scripts\python.exe" main.py
    pause
