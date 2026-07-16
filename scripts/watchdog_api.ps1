# Avatar API (8766) external watchdog - restarts the server if it is not responding.
#
# WHY THIS LIVES OUTSIDE THE APP:
#   The XTTS worker (8768) and the file watcher are revived by watchdog threads that run
#   INSIDE the 8766 server. Nothing revived 8766 itself - start_dashboard.bat only launches
#   it once at boot. So when 8766 died, its watchdog threads died with it, the watcher and
#   XTTS stayed down, and even the UI banner could not warn anyone (the banner asks 8766).
#   On 2026-07-16 this actually happened: 8766 was found dead and the watcher had been
#   stopped for 7 days, silently. This script guards the root of that chain, so it must run
#   outside the app (Task Scheduler).
#
# ASCII ONLY - DO NOT PUT NON-ASCII TEXT IN THIS FILE.
#   Windows PowerShell 5.1 decodes .ps1 files as the ANSI codepage (cp949 here) unless the
#   file has a UTF-8 BOM. Most editors/tools save without a BOM, which corrupts non-ASCII
#   text and can break string quoting - that already produced a script that logged its own
#   comments. A safety net that fails silently is worse than none, so keep this file ASCII.
#
# Register: scripts\register_watchdog_task.ps1   (runs every 5 minutes)
# Remove:   schtasks /delete /tn "MentalAvatar API Watchdog" /f
# Log:      tmp\watchdog_api.log

$ErrorActionPreference = 'Stop'

$Root     = Split-Path -Parent $PSScriptRoot
$Python   = 'C:\Users\oem\miniconda3\envs\avatar\python.exe'
$ServerPy = Join-Path $Root 'api\server.py'
$LogPath  = Join-Path $Root 'tmp\watchdog_api.log'

function Write-Log([string]$Message) {
    $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    $dir = Split-Path -Parent $LogPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    Add-Content -Path $LogPath -Value $line -Encoding UTF8
}

function Test-ApiAlive {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8766/health' -TimeoutSec 5
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

# Healthy: exit quietly and log nothing, so the log only ever shows real incidents.
if (Test-ApiAlive) { exit 0 }

# Port held but /health failing = half-dead process. Clear it first, otherwise the new
# instance can bind alongside it and requests may be routed to the zombie.
$stale = netstat -ano | Select-String ':8766.*LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
foreach ($procId in $stale) {
    try {
        Stop-Process -Id $procId -Force -ErrorAction Stop
        Write-Log "Killed unresponsive process holding 8766 (PID $procId)"
    } catch { }
}
if ($stale) { Start-Sleep -Seconds 3 }

if (-not (Test-Path $Python))   { Write-Log "python not found: $Python"; exit 1 }
if (-not (Test-Path $ServerPy)) { Write-Log "server.py not found: $ServerPy"; exit 1 }

Start-Process -FilePath $Python -ArgumentList $ServerPy -WindowStyle Minimized
Write-Log 'API was not responding - restarted it'

# Confirm it actually came up. "Launched" and "listening" are not the same thing.
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    if (Test-ApiAlive) {
        Write-Log ("Recovery confirmed after about {0}s" -f (($i + 1) * 2))
        exit 0
    }
}
Write-Log 'Restarted but no response within 40s - needs a look'
exit 1
