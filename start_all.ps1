# Smart Tatkal Guardian — Start All Services
# Run this script once to launch scorer, orchestrator, simulator and dashboard.
# Each service opens in its own PowerShell window so they stay alive independently.

$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "Starting Smart Tatkal Guardian..." -ForegroundColor Cyan

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\scorer'; py -m uvicorn main:app --port 8002" -WindowStyle Normal
Start-Sleep -Milliseconds 1500

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\orchestrator'; py -m uvicorn main:app --port 8000" -WindowStyle Normal
Start-Sleep -Milliseconds 1500

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\simulator'; py -m uvicorn main:app --port 8001 --reload" -WindowStyle Normal
Start-Sleep -Milliseconds 1500

Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root\dashboard'; npm run dev" -WindowStyle Normal

Write-Host ""
Write-Host "All services starting in separate windows." -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard  -> http://localhost:5173" -ForegroundColor Yellow
Write-Host "  Orchestrator -> http://localhost:8000" -ForegroundColor Yellow
Write-Host "  Scorer     -> http://localhost:8002/docs" -ForegroundColor Yellow
Write-Host "  Simulator  -> http://localhost:8001/docs" -ForegroundColor Yellow
Write-Host ""
Write-Host "Wait ~5 seconds then open http://localhost:5173" -ForegroundColor Cyan
