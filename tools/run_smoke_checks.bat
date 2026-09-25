@echo off
setlocal

if "%PS_LOUNGE_URL%"=="" set "PS_LOUNGE_URL=http://127.0.0.1:5000"
if "%PS_LOUNGE_PIN%"=="" set "PS_LOUNGE_PIN=4826"

echo [1/9] Python syntax check
call ".\.venv\Scripts\python.exe" -m py_compile main.py tools\backend_smoke_check.py tools\license_smoke_check.py tools\state_smoke_check.py tools\generate_license.py
if errorlevel 1 exit /b 1

echo [2/9] Backend smoke check against %PS_LOUNGE_URL%
call ".\.venv\Scripts\python.exe" tools\backend_smoke_check.py
if errorlevel 1 exit /b 1

echo [3/9] License signing key check
call ".\.venv\Scripts\python.exe" tools\license_key_loading_check.py
if errorlevel 1 exit /b 1

echo [4/9] License smoke check
call ".\.venv\Scripts\python.exe" tools\license_smoke_check.py
if errorlevel 1 exit /b 1

echo [5/9] State smoke check
call ".\.venv\Scripts\python.exe" tools\state_smoke_check.py
if errorlevel 1 exit /b 1

echo [6/9] Achievement action encoding check
call node tools\achievement_break_actions_check.cjs
if errorlevel 1 exit /b 1

echo [7/9] Station order check
call node tools\station_order_check.cjs
if errorlevel 1 exit /b 1

echo [8/9] Station image mapping check
call node tools\station_asset_check.cjs
if errorlevel 1 exit /b 1

echo [9/9] Playwright smoke check
call node tools\playwright_smoke_check.cjs
if errorlevel 1 exit /b 1

echo [ok] All smoke checks passed.
exit /b 0
