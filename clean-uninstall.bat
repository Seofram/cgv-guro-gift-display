@echo off
chcp 65001 >nul
cd /d "%~dp0"
title CGV 경품 안내 클린 제거

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\clean-uninstall.ps1
if errorlevel 1 (
  echo.
  echo 클린 제거를 완료하지 못했거나 취소했습니다.
  pause
  exit /b 1
)

echo.
echo 클린 제거가 완료되었습니다.
echo 이 프로그램이 더 이상 필요하지 않으면 현재 폴더를 직접 삭제해 주세요.
pause
exit /b 0
