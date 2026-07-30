@echo off
chcp 65001 >nul
cd /d "%~dp0"
title CGV 경품 안내 데이터 초기화

powershell -NoProfile -ExecutionPolicy Bypass -File scripts\reset-data.ps1
if errorlevel 1 (
  echo.
  echo 데이터 초기화를 완료하지 못했습니다.
  pause
  exit /b 1
)

echo.
echo 데이터 초기화가 완료되었습니다.
echo 다시 사용하려면 start-local.bat을 실행해 주세요.
pause
exit /b 0
