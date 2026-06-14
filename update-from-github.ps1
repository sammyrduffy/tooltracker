# ---------------------------------------------------------------------------
# update-from-github.ps1  —  Checks GitHub for new commits and applies them.
#
# Run hourly by the "ToolTracker Update" scheduled task. If there's nothing
# new, it does nothing. If there are updates, it pulls them, installs any new
# dependencies, and restarts the app (the "ToolTracker" task's loop brings it
# back up within a few seconds).
# ---------------------------------------------------------------------------

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')

function Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path (Join-Path $dir 'update.log') -Value $line
}

git fetch origin main 2>&1 | Out-Null

$local = git rev-parse HEAD
$remote = git rev-parse origin/main

if ($local -eq $remote) {
  exit
}

Log "Update found: $local -> $remote"

$oldLock = Get-Content (Join-Path $dir 'package-lock.json') -Raw

git merge --ff-only origin/main 2>&1 | ForEach-Object { Log $_ }

$newLock = Get-Content (Join-Path $dir 'package-lock.json') -Raw
if ($oldLock -ne $newLock) {
  Log "package-lock.json changed, running npm install"
  & "C:\Program Files\nodejs\npm.cmd" install 2>&1 | ForEach-Object { Log $_ }
}

Log "Restarting app"
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object OwningProcess | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

Log "Update complete: now at $remote"
