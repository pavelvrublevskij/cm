@echo off
setlocal enabledelayedexpansion

:: CM — run script
::
:: Usage:
::   run.bat           Start the server
::   run.bat 1         Same, non-interactive

set PORT=3000
set URL=http://127.0.0.1:%PORT%
set MIN_NODE=18

:: Header
echo.
echo ======================================
echo        CM
echo ======================================
echo.

:: Check for direct argument
if not "%~1"=="" (
    set CHOICE=%~1
    goto :run_choice
)

:: Menu
echo   1)  Start       Install deps, start server, open browser
echo   2)  Stop        Stop the running server
echo   3)  Update git  Pull latest from GitHub (requires git)
echo   4)  Update zip  Download latest release zip from GitHub
echo   0)  Exit
echo.
set /p CHOICE="  Select option: "
echo.

:run_choice
if "%CHOICE%"=="1" goto :do_local_start
if "%CHOICE%"=="2" goto :do_stop
if "%CHOICE%"=="3" goto :do_update_git
if "%CHOICE%"=="4" goto :do_update_zip
if "%CHOICE%"=="0" goto :do_exit
echo Invalid option: %CHOICE%
goto :eof

:do_local_start
echo [Start]
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo Node.js not found. Install from https://nodejs.org
    echo.
    goto :eof
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_VER=%%a
if %NODE_VER% lss %MIN_NODE% (
    echo Node.js v%MIN_NODE%+ required. Please update: https://nodejs.org
    goto :eof
)
for /f "tokens=*" %%v in ('node -v') do echo   Node.js %%v found

:: Kill existing instance on the same port
for /f "tokens=5" %%p in ('netstat -aon ^| findstr "127.0.0.1:%PORT% " ^| findstr "LISTENING"') do (
    echo   Port %PORT% in use ^(PID %%p^), stopping previous instance...
    taskkill /PID %%p /F >nul 2>&1
    call :wait_port_free
    if !errorlevel! equ 0 (
        echo   Previous instance stopped.
    ) else (
        echo   Could not stop the process on port %PORT% ^(PID %%p^). Close it manually and re-run.
        goto :eof
    )
)

:: Install dependencies
if exist "node_modules" (
    echo   Dependencies installed
) else (
    echo   Installing dependencies...
    call npm install
)

call :ensure_pty_works

echo.
echo   Starting server...

:: Start server as hidden background process
powershell -command "Start-Process node -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"

:: Wait for server
call :wait_for_server
if %errorlevel% equ 0 start "" %URL%

echo.
echo   CM is running at %URL%
echo   To stop: run run.bat 2
echo.
goto :eof

:do_stop
echo [Stop]
echo.
set FOUND=0
for /f "tokens=5" %%p in ('netstat -aon ^| findstr "127.0.0.1:%PORT% " ^| findstr "LISTENING"') do (
    echo   Stopping server (PID %%p)...
    taskkill /PID %%p /F >nul 2>&1
    set FOUND=1
)
if "%FOUND%"=="0" echo   Server is not running.
echo.
goto :eof

:do_update_git
echo [Update - git]
echo.
where git >nul 2>&1
if %errorlevel% neq 0 (
    echo   git is not installed.
    echo.
    goto :eof
)
cd /d "%~dp0"
echo   Pulling latest changes...
git pull
echo   Updating dependencies...
call npm install
echo.
echo   Update complete. Restart the server to apply changes.
echo.
goto :eof

:do_update_zip
echo [Update - Release Zip]
echo.
echo   Fetching latest release info...
powershell -nologo -noprofile -command "try { (Invoke-RestMethod 'https://api.github.com/repos/pavelvrublevskij/cm/releases/latest').zipball_url } catch { 'https://github.com/pavelvrublevskij/cm/archive/refs/heads/main.zip' }" > "%TEMP%\cm_url.txt" 2>nul
set /p ZIP_URL=<"%TEMP%\cm_url.txt"
del "%TEMP%\cm_url.txt" >nul 2>&1

set TMP_DIR=%TEMP%\cm-update
if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%"
mkdir "%TMP_DIR%"

echo   Downloading...
powershell -nologo -noprofile -command "Invoke-WebRequest -Uri '%ZIP_URL%' -OutFile '%TMP_DIR%\update.zip'"
if %errorlevel% neq 0 (
    echo   Download failed.
    rmdir /s /q "%TMP_DIR%"
    goto :eof
)

echo   Extracting...
powershell -nologo -noprofile -command "Expand-Archive -Path '%TMP_DIR%\update.zip' -DestinationPath '%TMP_DIR%\out' -Force"
if %errorlevel% neq 0 (
    echo   Extraction failed.
    rmdir /s /q "%TMP_DIR%"
    goto :eof
)

echo   Copying files...
powershell -nologo -noprofile -command "$src = (Get-ChildItem '%TMP_DIR%\out' -Directory | Select-Object -First 1).FullName; if ($src) { Get-ChildItem $src | ForEach-Object { Copy-Item $_.FullName '%~dp0' -Recurse -Force } }"

rmdir /s /q "%TMP_DIR%"

echo   Updating dependencies...
cd /d "%~dp0"
call npm install
echo.
echo   Update complete. Restart the server to apply changes.
echo.
goto :eof

:do_exit
echo Bye!
goto :eof

:: ─── Helpers ────────────────────────────────────────────────────────

:verify_pty
node "%~dp0scripts\verify-pty.js" >nul 2>&1
exit /b %errorlevel%

:ensure_pty_works
call :verify_pty
if %errorlevel% equ 0 exit /b 0
echo   In-app terminal support is broken, reinstalling...
rmdir /s /q "node_modules\node-pty" >nul 2>&1
call npm install >nul 2>&1
call :verify_pty
if %errorlevel% equ 0 (
    echo   Terminal support fixed.
    exit /b 0
)
echo   Rebuilding all dependencies ^(this may take a minute^)...
rmdir /s /q "node_modules" >nul 2>&1
del /q "package-lock.json" >nul 2>&1
call npm install
call :verify_pty
if %errorlevel% equ 0 (
    echo   Terminal support fixed.
) else (
    echo   Could not fix the in-app terminal automatically. The rest of the app will still work.
)
exit /b 0

:wait_port_free
set /a ATTEMPTS=0
:wait_port_free_loop
netstat -aon | findstr "127.0.0.1:%PORT% " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 exit /b 0
set /a ATTEMPTS+=1
if %ATTEMPTS% geq 5 exit /b 1
timeout /t 1 /nobreak >nul
goto :wait_port_free_loop

:wait_for_server
set /a ATTEMPTS=0
:wait_loop
set /a ATTEMPTS+=1
if %ATTEMPTS% gtr 30 (
    echo   Server did not start within 30 seconds.
    exit /b 1
)
powershell -command "try { $null = Invoke-WebRequest -Uri '%URL%' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 (
    timeout /t 1 /nobreak >nul
    goto :wait_loop
)
exit /b 0
