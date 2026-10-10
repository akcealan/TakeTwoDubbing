@echo off
rem Take Two - Windows one-click setup launcher (ASCII-only; messages live in kurulum.ps1)
title Take Two Kurulum
cd /d "%~dp0"
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\kurulum.ps1" %*
echo.
pause
