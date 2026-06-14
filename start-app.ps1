# ---------------------------------------------------------------------------
# start-app.ps1  —  Runs Tool Tracker and keeps it running.
#
# Used by the "ToolTracker" scheduled task so the app starts automatically
# when you log in, and restarts itself if it ever crashes. Output goes to
# server.log / server.err.log in this folder.
# ---------------------------------------------------------------------------

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

# If the app is already running (e.g. started another way), don't start a
# second copy — just exit quietly.
try {
  Invoke-WebRequest 'http://localhost:3000/' -UseBasicParsing -TimeoutSec 3 | Out-Null
  exit
} catch {}

while ($true) {
  Start-Process -FilePath "C:\Program Files\nodejs\node.exe" -ArgumentList "server.js" `
    -WorkingDirectory $dir `
    -RedirectStandardOutput (Join-Path $dir 'server.log') `
    -RedirectStandardError (Join-Path $dir 'server.err.log') `
    -NoNewWindow -Wait
  # If node exits (crash), wait a bit and start it again.
  Start-Sleep -Seconds 5
}
