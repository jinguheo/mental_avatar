# Registers the 8766 watchdog as a Windows scheduled task (every 5 minutes).
# Run once. Safe to re-run - /f replaces the existing task.
#
# ASCII ONLY - see the note in watchdog_api.ps1 (PowerShell 5.1 reads .ps1 as cp949
# without a BOM, which corrupts non-ASCII text and can break quoting).
#
# Inspect: schtasks /query /tn "MentalAvatar API Watchdog" /v /fo list
# Run now: schtasks /run   /tn "MentalAvatar API Watchdog"
# Remove:  schtasks /delete /tn "MentalAvatar API Watchdog" /f

$ErrorActionPreference = 'Stop'

$TaskName = 'MentalAvatar API Watchdog'
$Script   = Join-Path $PSScriptRoot 'watchdog_api.ps1'

if (-not (Test-Path $Script)) {
    Write-Error "watchdog script not found: $Script"
    exit 1
}

# /it = run only when the user is logged on. This is a desktop app, so there is nothing to
# keep alive on the login screen, and /it avoids needing a stored password.
$action = 'powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $Script
schtasks /create /tn $TaskName /tr $action /sc minute /mo 5 /it /f

if ($LASTEXITCODE -eq 0) {
    Write-Output ''
    Write-Output "Registered: $TaskName (every 5 minutes)"
    Write-Output "Log:        tmp\watchdog_api.log  (only written when something was wrong)"
    Write-Output "Remove:     schtasks /delete /tn `"$TaskName`" /f"
} else {
    Write-Error "Failed to register the task (exit $LASTEXITCODE)"
}
