@echo off
chcp 65001 >nul
title KRZ muzic - servidor local
cd /d "%~dp0"

echo.
echo   KRZ muzic
echo   ---------
echo   Arrancando un servidor local en http://localhost:8080
echo   Deja esta ventana abierta mientras uses la app. Para pararlo: cierra la ventana o pulsa Ctrl+C.
echo.

python --version >nul 2>nul
if %errorlevel%==0 (
  start "" cmd /c "timeout /t 2 >nul & start http://localhost:8080"
  python -m http.server 8080
  goto :fin
)

py --version >nul 2>nul
if %errorlevel%==0 (
  start "" cmd /c "timeout /t 2 >nul & start http://localhost:8080"
  py -m http.server 8080
  goto :fin
)

node --version >nul 2>nul
if %errorlevel%==0 (
  start "" cmd /c "timeout /t 5 >nul & start http://localhost:8080"
  npx --yes serve -l 8080 .
  goto :fin
)

echo   No encuentro Python ni Node.js en este ordenador.
echo   Instala uno de los dos (mira el README.md) y vuelve a hacer doble clic aqui.
echo.
pause

:fin
