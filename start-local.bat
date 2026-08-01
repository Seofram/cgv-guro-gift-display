@echo off
chcp 65001 >nul
cd /d "%~dp0"

if exist ".runtime\node-path.txt" if exist "node_modules\.bin\vinext.cmd" (
  set /p "CGV_NODE_DIR="<".runtime\node-path.txt"
  if exist "%CGV_NODE_DIR%\node.exe" (
    "%CGV_NODE_DIR%\node.exe" --version >nul 2>nul
    if not errorlevel 1 goto launch
  )
)

:prepare
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap-node.ps1
if errorlevel 1 (
  echo.
  echo Failed to prepare the runtime. Check the internet connection and try again.
  pause
  exit /b 1
)

set /p "CGV_NODE_DIR="<".runtime\node-path.txt"
set "PATH=%CGV_NODE_DIR%;%PATH%"

"%CGV_NODE_DIR%\node.exe" --version >nul 2>nul
if errorlevel 1 (
  echo Failed to verify the Node.js runtime.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\vinext.cmd" (
  echo Installing required components...
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    echo Failed to install the required components.
    pause
    exit /b 1
  )
)

:launch
set "PATH=%CGV_NODE_DIR%;%PATH%"
start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\launch-local.ps1"
exit /b 0
