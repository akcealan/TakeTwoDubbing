@echo off
rem Take Two - local dev launcher (ASCII-only; run from the repository root)
title Take Two Baslat
cd /d "%~dp0"

if not exist "%~dp0node_modules" (
  echo.
  echo Bagimliliklar henuz kurulu degil.
  echo Once Kurulum.bat dosyasini calistirin.
  echo.
  pause
  exit /b 1
)

if exist "%~dp0.tools\node-v24.20.0-win-x64\node.exe" (
  set "PATH=%~dp0.tools\node-v24.20.0-win-x64;%PATH%"
)

node --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo Node.js bulunamadi.
  echo Once Kurulum.bat dosyasini calistirin.
  echo.
  pause
  exit /b 1
)

echo.
echo Take Two yerel gelistirme baslatiliyor...
echo Tarayici: http://127.0.0.1:5173
echo Durdurmak icin bu pencerede Ctrl+C basin.
echo.

npm.cmd run dev:all

echo.
echo Gelistirme sunuculari durdu.
pause
