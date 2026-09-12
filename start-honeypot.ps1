# Honeypot lokal starten (Bun)
# Benutzung: Rechtsklick -> Mit PowerShell ausführen, oder: .\start-honeypot.ps1
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

if (-not (Test-Path -LiteralPath "$PSScriptRoot\.env")) {
  Write-Host ".env fehlt! Bitte .env mit DISCORD_TOKEN anlegen." -ForegroundColor Red
  exit 1
}

Set-Location -LiteralPath $PSScriptRoot
Write-Host "Starte Honeypot (bun start) - STRG+C zum Beenden..." -ForegroundColor Green
bun start
