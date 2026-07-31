@echo off
chcp 65001 >nul
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap-node.ps1
if errorlevel 1 (
  echo.
  echo 실행 환경을 준비하지 못했습니다.
  echo 인터넷 연결을 확인한 후 다시 실행해 주세요.
  pause
  exit /b 1
)

set /p "CGV_NODE_DIR="<".runtime\node-path.txt"
set "PATH=%CGV_NODE_DIR%;%PATH%"

node --version >nul 2>nul
if errorlevel 1 (
  echo Node.js 실행 경로를 확인하지 못했습니다.
  pause
  exit /b 1
)

if not exist "node_modules\.bin\vinext.cmd" (
  echo 필요한 구성요소를 설치하고 있습니다...
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 (
    echo 구성요소 설치에 실패했습니다.
    echo 인터넷 연결을 확인한 후 다시 실행해 주세요.
    pause
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-controller.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\restart-server.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\open-admin.ps1
exit /b 0
