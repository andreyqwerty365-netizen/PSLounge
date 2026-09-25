@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PYTHON_EXE="
set "PYTHON_ARGS="

where py >nul 2>&1
if not errorlevel 1 (
  set "PYTHON_EXE=py"
  set "PYTHON_ARGS=-3"
)

if not defined PYTHON_EXE (
  where python >nul 2>&1
  if not errorlevel 1 set "PYTHON_EXE=python"
)

if not defined PYTHON_EXE (
  for /d %%D in ("%LocalAppData%\Programs\Python\Python3*") do (
    if exist "%%~fD\python.exe" set "PYTHON_EXE=%%~fD\python.exe"
  )
)

if not defined PYTHON_EXE (
  echo [ERROR] Python 3 not found. Install Python 3 and try again.
  exit /b 1
)

if exist ".venv\Scripts\python.exe" (
  call ".venv\Scripts\python.exe" -c "import sys" >nul 2>&1
  if errorlevel 1 (
    set "BROKEN_VENV=.venv_broken_!RANDOM!"
    echo [PS Lounge] Existing virtual environment is not portable. Moving it to !BROKEN_VENV!...
    move ".venv" "!BROKEN_VENV!" >nul
    if errorlevel 1 exit /b 1
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo [PS Lounge] Creating virtual environment...
  call "%PYTHON_EXE%" %PYTHON_ARGS% -m venv .venv
  if errorlevel 1 exit /b 1
)

echo [PS Lounge] Installing requirements...
call ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
if errorlevel 1 exit /b 1
call ".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 exit /b 1

exit /b 0
