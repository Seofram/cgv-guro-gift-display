@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\start-server.ps1"
exit /b 0
