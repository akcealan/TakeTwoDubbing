@echo off
title Take Two - Yerel AI

cd /d "%~dp0"

set "PATH=%~dp0.tools\node-v24.20.0-win-x64;%PATH%"

echo.
echo Take Two Yerel AI baslatiliyor...
echo Bu pencereyi Studio'yu kullandigin surece kapatma.
echo.

npm.cmd run ai:dev

echo.
echo AI servisi durdu.
pause