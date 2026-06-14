# ---------------------------------------------------------------------------
# start-online.ps1  —  Puts Tool Tracker online via a free Cloudflare tunnel.
#
# Double-click start-online.cmd to run this. It will:
#   1. Start the app (if it isn't already running)
#   2. Open a secure https:// tunnel to it
#   3. Print the public web address and point the app's QR codes at it
#
# Leave the window it opens OPEN. Closing it turns off online access.
# (The app itself keeps running locally either way.)
# ---------------------------------------------------------------------------

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

try {
  # 1. Start the app if it isn't responding yet.
  $appUp = $false
  try { Invoke-WebRequest 'http://localhost:3000/' -UseBasicParsing -TimeoutSec 3 | Out-Null; $appUp = $true } catch {}
  if (-not $appUp) {
    Write-Host 'Starting the app...'
    Start-Process node -ArgumentList 'server.js' -WorkingDirectory $dir -WindowStyle Minimized
    Start-Sleep -Seconds 2
  }

  # 2. (Re)start the tunnel.
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
  $out = Join-Path $dir 'tunnel-out.log'
  $err = Join-Path $dir 'tunnel-err.log'
  Start-Process cloudflared `
    -ArgumentList 'tunnel','--url','http://localhost:3000','--no-autoupdate' `
    -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden

  Write-Host 'Opening secure online access...'
  $url = $null
  for ($i = 0; $i -lt 25 -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    $log = (Get-Content $err -Raw -ErrorAction SilentlyContinue) + (Get-Content $out -Raw -ErrorAction SilentlyContinue)
    $url = ([regex]::Match($log, 'https://[a-z0-9-]+\.trycloudflare\.com')).Value
  }

  if ($url) {
    # 3. Point the app's QR codes / links at this address.
    "const { setSetting } = require('./db'); setSetting('base_url','$url');" | node | Out-Null
    Write-Host ''
    Write-Host '  ============================================================'
    Write-Host '   YOUR TOOL TRACKER IS ONLINE AT:' -ForegroundColor Green
    Write-Host "     $url" -ForegroundColor Green
    Write-Host '  ============================================================'
    Write-Host ''
    Write-Host '  Open that address on any phone. Keep this window open.'
    Write-Host '  Closing this window turns OFF online access.'
    Write-Host ''
    while ($true) { Start-Sleep -Seconds 3600 }
  } else {
    Write-Host 'Could not get a public address. Check the internet connection and try again.' -ForegroundColor Red
    Read-Host 'Press Enter to close'
  }
}
finally {
  # When this window closes, shut the tunnel down cleanly.
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
}
