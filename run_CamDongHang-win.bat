@echo off
setlocal
chcp 65001 >nul 2>&1
title CamDongHang - Camera Only
cd /d "%~dp0"
if not exist "%~dp0start_CamDongHang.ps1" (
    echo [ERROR] Thieu start_CamDongHang.ps1. Hay giai nen toan bo goi ZIP.
    pause
    exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_CamDongHang.ps1" %*
set "appExitCode=%errorlevel%"
if not "%appExitCode%"=="0" (
    echo.
    echo [ERROR] Khong khoi dong duoc. Xem thong bao phia tren.
    pause
)
exit /b %appExitCode%