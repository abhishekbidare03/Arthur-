<#
    Starts Arthur for development: the backend and the Vite dev server, each in
    its own window so their logs stay readable and either can be restarted
    without touching the other.

    Deliberately does NOT start Ollama. A second `ollama serve` grabs the port
    and leaves the tray app silently crash-looping, so this script checks that
    Ollama is already up and stops with instructions if it is not.

    Usage:  .\start.ps1
#>

$ErrorActionPreference = 'Stop'

$root     = $PSScriptRoot
$backend  = Join-Path $root 'backend'
$frontend = Join-Path $root 'frontend'

function Test-Port([int]$Port) {
    $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host 'Arthur' -ForegroundColor Cyan

# --- Ollama ------------------------------------------------------------------
# Checked first: without it the app loads but every message fails, which is a
# far more confusing failure than an up-front message.
if (-not (Test-Port 11434)) {
    Write-Host '  Ollama is not running.' -ForegroundColor Red
    Write-Host '  Start the Ollama tray app (Start menu -> Ollama), then run this again.'
    Write-Host '  Do not run `ollama serve` by hand - it conflicts with the tray app.'
    Write-Host ''
    exit 1
}
Write-Host '  Ollama          ready  (port 11434)' -ForegroundColor Green

# --- Dependencies ------------------------------------------------------------
foreach ($dir in @($backend, $frontend)) {
    if (-not (Test-Path (Join-Path $dir 'node_modules'))) {
        Write-Host "  Installing dependencies in $(Split-Path $dir -Leaf)..." -ForegroundColor Yellow
        Push-Location $dir
        try { npm install } finally { Pop-Location }
    }
}

# --- Servers -----------------------------------------------------------------
# Already-listening ports mean a previous run is still alive; reuse it rather
# than starting a second copy that would fail on Vite's strictPort.
if (Test-Port 5179) {
    Write-Host '  Backend         already running  (port 5179)' -ForegroundColor DarkGray
} else {
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command', "Set-Location '$backend'; npm run dev"
    ) | Out-Null
    Write-Host '  Backend         starting  (port 5179)' -ForegroundColor Green
}

if (Test-Port 5178) {
    Write-Host '  Frontend        already running  (port 5178)' -ForegroundColor DarkGray
} else {
    Start-Process powershell -ArgumentList @(
        '-NoExit', '-Command', "Set-Location '$frontend'; npm run dev"
    ) | Out-Null
    Write-Host '  Frontend        starting  (port 5178)' -ForegroundColor Green
}

# --- Wait for the UI ---------------------------------------------------------
Write-Host ''
Write-Host '  Waiting for the dev server...' -NoNewline
$deadline = (Get-Date).AddSeconds(45)
while (-not (Test-Port 5178) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    Write-Host '.' -NoNewline
}
Write-Host ''

if (Test-Port 5178) {
    Write-Host ''
    Write-Host '  Open  http://localhost:5178' -ForegroundColor Cyan
    Write-Host ''
} else {
    Write-Host ''
    Write-Host '  The dev server did not come up. Check the two windows for errors.' -ForegroundColor Red
    Write-Host ''
    exit 1
}
