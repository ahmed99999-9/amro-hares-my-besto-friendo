# Removes the oc-vpn watchdog autostart entry and stops the watchdog process.
$ErrorActionPreference = "SilentlyContinue"
$vpnDir  = $PSScriptRoot
$startup = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$link    = Join-Path $startup "oc-vpn-watchdog.cmd"

Remove-Item $link -Force
$lock = Join-Path $vpnDir "watchdog.lock"
if (Test-Path $lock) {
  $wid = Get-Content $lock
  Get-Process -Id $wid -ErrorAction SilentlyContinue | Stop-Process -Force
  Remove-Item $lock -Force
}
Unregister-ScheduledTask -TaskName "oc-vpn-watchdog" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "[oc-vpn] autostart removed. The proxy itself keeps running until you stop it with .\stop-proxy.ps1" -ForegroundColor Yellow