@echo off
rem  Arthur - one-time setup.
rem
rem  Installs dependencies, builds the UI, generates the icon and creates the
rem  Desktop and Start-menu shortcuts. Run this once; after it, Arthur is a
rem  double-click.
rem
rem  A thin wrapper on purpose: the real work is in tools\setup.ps1, because
rem  batch has no readable way to create a shortcut, compare versions or report
rem  a failure clearly. This file exists so the instruction stays "run
rem  setup.bat" - the thing people expect to find.

setlocal
cd /d "%~dp0"

where powershell >nul 2>&1
if errorlevel 1 (
    echo.
    echo   PowerShell was not found, which should not happen on Windows 10 or 11.
    echo.
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup.ps1" %*
set EXITCODE=%ERRORLEVEL%

rem  Double-clicked rather than run from a prompt: hold the window open so the
rem  result is readable instead of flashing past.
echo.
pause
exit /b %EXITCODE%
