@echo off
chcp 65001 >nul
cd /d "%~dp0"
title HR System - portable test package
echo.
echo  ============================================
echo   HR 系統 可攜式測試包  2026-09-27
echo  ============================================
echo   正在啟動本機伺服器（安全來源模式）...
echo   （若 PowerShell 被政策擋下，請直接雙擊 HR系統.html）
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve_hr.ps1"
if errorlevel 1 (
  echo.
  echo  [!] 無法啟動本機伺服器。
  echo      請直接雙擊 HR系統.html（所有計算仍可用，
  echo      僅「直接覆寫主檔」改成另存新檔）。
  echo.
  pause
)
