@echo off
rem earthfetch Studio launcher for Windows 10 and 11.
rem Double-click to start. The first run downloads a private copy of Python
rem and the map libraries into this folder (no admin rights, nothing installed
rem system-wide). Close this window to stop Studio.
setlocal
cd /d "%~dp0"
title earthfetch Studio
set "HERE=%~dp0"
set "PORT=7860"
set "URL=http://localhost:%PORT%"
set "TOOLS=%HERE%.tools"
set "UV=%TOOLS%\uv.exe"
set "UV_PYTHON_INSTALL_DIR=%TOOLS%\python"
set "UV_CACHE_DIR=%TOOLS%\cache"
set "PY=%HERE%.venv\Scripts\python.exe"

echo.
echo   earthfetch Studio
echo   -----------------
echo.

rem Opened straight from inside the zip? Windows runs it from a temp folder
rem that disappears, so setup would be lost.
echo "%HERE%" | findstr /i /c:"\AppData\Local\Temp\" >nul
if not errorlevel 1 goto :in_zip

rem Already running? Just open it.
netstat -ano | findstr /r /c:":%PORT% .*LISTENING" >nul 2>&1
if not errorlevel 1 goto :already_running

if exist "%UV%" goto :have_uv
echo   First-time setup: downloading tools. This takes a few minutes...
set "UV_ZIP=uv-x86_64-pc-windows-msvc.zip"
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "UV_ZIP=uv-aarch64-pc-windows-msvc.zip"
if not exist "%TOOLS%" mkdir "%TOOLS%"
curl.exe -fsSL --retry 3 -o "%TOOLS%\uv.zip" "https://github.com/astral-sh/uv/releases/latest/download/%UV_ZIP%"
if errorlevel 1 goto :setup_failed
tar.exe -xf "%TOOLS%\uv.zip" -C "%TOOLS%"
if errorlevel 1 goto :setup_failed
del "%TOOLS%\uv.zip" >nul 2>&1
if not exist "%UV%" goto :setup_failed
:have_uv

if exist "%HERE%.venv\setup-done.txt" goto :run
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

:run
echo   Starting Studio at %URL%
echo   Your browser will open in a moment. Keep this window open while you work;
echo   close it to stop Studio.
echo.
set "STUDIO_OPEN_BROWSER=%URL%"
"%PY%" -m uvicorn app.main:app --host 127.0.0.1 --port %PORT% --log-level warning
echo.
echo   Studio stopped.
pause
exit /b 0

:already_running
echo   Studio is already running. Opening %URL%
start "" "%URL%"
exit /b 0

:in_zip
echo   Please unzip first: right-click earthfetch-studio.zip, choose
echo   "Extract All...", then open the new folder and double-click
echo   Start Studio.bat there.
echo.
pause
exit /b 1

:setup_failed
echo.
echo   Setup didn't finish. Common causes:
echo     * No internet connection, or a work network that blocks downloads
echo       from github.com, astral.sh, or pypi.org. Try off VPN, or ask IT
echo       to allow them.
echo     * Antivirus quarantined a download. Ask IT to allow this folder.
echo   Then double-click Start Studio.bat again.
echo.
pause
exit /b 1
