@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" (
  echo [FEHLER] .env fehlt! Bitte .env mit DISCORD_TOKEN anlegen.
  pause
  exit /b 1
)

where bun >nul 2>nul
if errorlevel 1 (
  echo [FEHLER] Bun nicht gefunden. Bitte neues Terminal oeffnen oder PC neustarten.
  pause
  exit /b 1
)

echo Starte Honeypot (bun start) - Fenster offen lassen, STRG+C zum Beenden...
bun start

echo.
echo Bot beendet (Code %ERRORLEVEL%).
pause
