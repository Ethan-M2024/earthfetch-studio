@echo off
rem earthfetch Studio launcher for Windows.
rem Double-click to start. The first run downloads a private copy of Python
rem and the map libraries into this folder (no admin rights, nothing installed
rem system-wide). Close this window to stop Studio.
setlocal
cd /d "%~dp0"
title earthfetch Studio
set "HERE=%~dp0"
set "PORT=7860"
set "URL=http://localhost:%PORT%"
set "UV=%HERE%.tools\uv.exe"
set "UV_PYTHON_INSTALL_DIR=%HERE%.tools\python"
set "UV_CACHE_DIR=%HERE%.tools\cache"
set "PY=%HERE%.venv\Scripts\python.exe"

echo.
echo   earthfetch Studio
echo   -----------------
echo.

rem Opened straight from inside the zip? Windows runs it from a temp folder
rem that disappears, so setup would be lost.
echo "%HERE%" | findstr /i /c:"\AppData\Local\Temp\" >nul
if %errorlevel%==0 (
  echo   Please unzip first: right-click earthfetch-studio.zip, choose
  echo   "Extract All...", then open the new folder and double-click
  echo   Start Studio.bat there.
  echo.
  pause
  exit /b 1
)

rem Already running? Just open it.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo   Studio is already running. Opening %URL%
  start "" "%URL%"
  timeout /t 3 >nul
  exit /b 0
)

if not exist "%UV%" (
  echo   First-time setup: downloading tools. This takes a few minutes...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$env:UV_INSTALL_DIR='%HERE%.tools'; $env:UV_NO_MODIFY_PATH='1'; irm https://astral.sh/uv/install.ps1 | iex"
  if not exist "%UV%" goto :setup_failed
)

if not exist "%HERE%.venv\setup-done.txt" (
  echo   Installing Python and the map libraries...
  "%UV%" venv "%HERE%.venv" --python 3.11 --quiet --clear
  if errorlevel 1 goto :setup_failed
  "%UV%" pip install --python "%PY%" -r "%HERE%requirements.txt" --quiet
  if errorlevel 1 goto :setup_failed
  echo   Getting the map engine ready...
  "%PY%" -c "import matplotlib.pyplot, rasterio, earthfetch, app.main" >nul 2>&1
  rmdir /s /q "%UV_CACHE_DIR%" >nul 2>&1
  echo done> "%HERE%.venv\setup-done.txt"
  echo   Setup complete.
  echo.
)

echo   Starting Studio at %URL%
echo   Your browser will open in a moment. Keep this window open while you work;
echo   close it to stop Studio.
echo.

rem Open the browser once the server answers.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command ^
  "for($i=0;$i -lt 90;$i++){try{if((Invoke-WebRequest '%URL%/api/health' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200){Start-Process '%URL%';break}}catch{};Start-Sleep 1}"

"%PY%" -m uvicorn app.main:app --host 127.0.0.1 --port %PORT% --log-level warning
echo.
echo   Studio stopped.
pause
exit /b 0

:setup_failed
echo.
echo   Setup didn't finish. Common causes:
echo     * No internet connection, or a work network that blocks downloads
echo       from astral.sh or pypi.org. Ask IT to allow them, or try off VPN.
echo     * A security tool blocked PowerShell. Ask IT to allow this folder.
echo   Then double-click Start Studio.bat again.
echo.
pause
exit /b 1
