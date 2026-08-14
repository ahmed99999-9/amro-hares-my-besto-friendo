# Installs the oc-vpn watchdog as an autostart entry (user Startup folder,
# no admin rights needed) so the rotating proxy is always running and is
# restarted within seconds if it ever dies.
#
# Nothing else on the machine is affected: the proxy is loopback-only and
# nothing routes through it unless you run opencode-vpn.ps1 or
# set-user-proxy.ps1.
#
# Usage: .\install-autostart.ps1      (undo with .\remove-autostart.ps1)
$ErrorActionPreference = "Stop"
$vpnDir   = $PSScriptRoot
$watchdog = Join-Path $vpnDir "watchdog.ps1"
$startup  = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup"
$link     = Join-Path $startup "oc-vpn-watchdog.cmd"

$launcher = "@echo off`r`nstart """" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`"`r`n"
Set-Content -Path $link -Value $launcher -Encoding Ascii
Write-Host "[oc-vpn] autostart entry created: $link" -ForegroundColor Green

Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`"" -WindowStyle Hidden
Write-Host "[oc-vpn] watchdog launched" -ForegroundColor Cyan
Start-Sleep -Seconds 3
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'proxy\.js' }
if ($p) {
  Write-Host "[oc-vpn] watchdog running, proxy is up (PID $($p.ProcessId))" -ForegroundColor Green
} else {
  Write-Warning "[oc-vpn] watchdog started but proxy not detected yet"
}
Write-Host "[oc-vpn] to remove: .\remove-autostart.ps1" -ForegroundColor Yellow