@echo off
setlocal
cd /d "%~dp0"

REM Each build gets its own output folder; previous client packages stay intact.
call setup_env.bat
if errorlevel 1 goto :failed
call ".venv\Scripts\python.exe" -m pip install -r requirements-build.txt
if errorlevel 1 goto :failed

for /f "delims=" %%V in ('call ".venv\Scripts\python.exe" -c "import json; print(json.load(open('package.json'))['version'])"') do set "BUILD_VERSION=%%V"
for /f "delims=" %%T in ('call ".venv\Scripts\python.exe" -c "from datetime import datetime; print(datetime.now().isoformat(timespec='microseconds').replace(':','').replace('-','').replace('.','').replace('T','-'))"') do set "BUILD_STAMP=%%T"
if not defined BUILD_VERSION goto :failed
if not defined BUILD_STAMP goto :failed
set "BUILD_ROOT=build\packages\%BUILD_VERSION%-%BUILD_STAMP%"
set "CLIENT_ROOT=client_release\%BUILD_VERSION%-%BUILD_STAMP%"

echo [PS Lounge] Building %BUILD_VERSION%...
call ".venv\Scripts\python.exe" -m PyInstaller --name "PS Lounge" --noconsole ^
  --distpath "%BUILD_ROOT%\dist" --workpath "%BUILD_ROOT%\work" --specpath "%BUILD_ROOT%" ^
  --add-data "%CD%\templates;templates" --add-data "%CD%\static;static" "%CD%\main.py"
if errorlevel 1 goto :failed

mkdir "%CLIENT_ROOT%"
xcopy /E /I /Y "%BUILD_ROOT%\dist\PS Lounge" "%CLIENT_ROOT%\PS Lounge" >nul
if errorlevel 1 goto :failed
copy /Y "README.md" "%CLIENT_ROOT%\PS Lounge\README.md" >nul
copy /Y "CHANGELOG.md" "%CLIENT_ROOT%\PS Lounge\CHANGELOG.md" >nul
copy /Y "docs\COMMERCIAL_GUIDE.md" "%CLIENT_ROOT%\PS Lounge\COMMERCIAL_GUIDE.md" >nul
if exist "LICENSE" copy /Y "LICENSE" "%CLIENT_ROOT%\PS Lounge\LICENSE" >nul
if exist "LICENSE.txt" copy /Y "LICENSE.txt" "%CLIENT_ROOT%\PS Lounge\LICENSE.txt" >nul

echo.
echo Portable package: %CLIENT_ROOT%\PS Lounge
echo Installer: powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1 -SourceDir "%CLIENT_ROOT%\PS Lounge" -Version "%BUILD_VERSION%"
if not defined PS_LOUNGE_NONINTERACTIVE pause
exit /b 0

:failed
echo [ERROR] Build failed. Existing client packages have been preserved.
if not defined PS_LOUNGE_NONINTERACTIVE pause
exit /b 1
