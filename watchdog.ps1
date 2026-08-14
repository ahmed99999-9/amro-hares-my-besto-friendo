# oc-vpn watchdog: keeps the rotating proxy alive forever.
# Loops forever; if the proxy process dies, it is restarted immediately
# (it resumes from status.json, so traffic keeps flowing with the same IP).
# Run from a scheduled task at logon (see install-autostart.ps1).
$ErrorActionPreference = "SilentlyContinue"

$vpnDir  = $PSScriptRoot
$proxyJs = Join-Path $vpnDir "proxy.js"
$node    = (Get-Command node).Source
$lock    = Join-Path $vpnDir "watchdog.lock"

if (Test-Path $lock) {
  $old = Get-Content $lock
  $alive = Get-Process -Id $old -ErrorAction SilentlyContinue
  if ($alive -and $alive.ProcessName -eq "powershell") {
    Write-Host "[oc-vpn] watchdog already running (PID $old)"
    exit 0
  }
}
Set-Content -Path $lock -Value $PID

while ($true) {
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'proxy\.js' }
  if (-not $running) {
    if ($node) {
      Start-Process -FilePath $node -ArgumentList "`"$proxyJs`"" -WindowStyle Hidden
      Write-Host "[oc-vpn] $(Get-Date -Format 'HH:mm:ss') proxy was down - restarted"
    }
  }
  Start-Sleep -Seconds 20
}