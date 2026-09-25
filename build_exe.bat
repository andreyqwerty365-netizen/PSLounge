@echo off
setlocal
cd /d "%~dp0"

REM Build client-ready onedir package using PyInstaller.
REM Developer-only: prepares a portable local environment without starting the server.

call setup_env.bat
if errorlevel 1 (
  echo [ERROR] Environment setup failed.
  if not defined PS_LOUNGE_NONINTERACTIVE pause
  exit /b 1
)

echo [PS Lounge] Installing/Updating PyInstaller...
call ".venv\Scripts\python.exe" -m pip install --upgrade pyinstaller
if errorlevel 1 (
  echo [ERROR] PyInstaller install failed.
  if not defined PS_LOUNGE_NONINTERACTIVE pause
  exit /b 1
)

echo [PS Lounge] Building EXE (onedir)...
call ".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --name "PS Lounge" --noconsole ^
  --add-data "templates;templates" ^
  --add-data "static;static" ^
  main.py

if errorlevel 1 (
  echo [ERROR] Build failed.
  if not defined PS_LOUNGE_NONINTERACTIVE pause
  exit /b 1
)

echo [PS Lounge] Creating client_release package...
if exist "client_release" rmdir /s /q "client_release"
mkdir "client_release"
xcopy /E /I /Y "dist\PS Lounge" "client_release\PS Lounge" >nul

REM Put client readme next to EXE
if exist "README_CLIENT.txt" copy /Y "README_CLIENT.txt" "client_release\PS Lounge\README_CLIENT.txt" >nul
if exist "activate_license.bat" copy /Y "activate_license.bat" "client_release\PS Lounge\activate_license.bat" >nul

echo.
echo Done.
echo Client folder: client_release\PS Lounge
echo Run: client_release\PS Lounge\PS Lounge.exe
if not defined PS_LOUNGE_NONINTERACTIVE pause
