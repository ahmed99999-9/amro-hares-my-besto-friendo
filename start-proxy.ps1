# Starts the rotating proxy as a background process (for use with the
# desktop app via user-scope env vars, or any session).
param(
  [switch]$Foreground
)

$ErrorActionPreference = "Stop"
$vpnDir  = $PSScriptRoot
$proxyJs = Join-Path $vpnDir "proxy.js"
$port    = 8899

$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'proxy\.js' }
if ($running) {
  Write-Host "[oc-vpn] proxy already running (PID $($running.ProcessId))" -ForegroundColor Yellow
} else {
  $node = (Get-Command node -ErrorAction Stop).Source
  if ($Foreground) {
    & $node $proxyJs
  } else {
    Start-Process -FilePath $node -ArgumentList "`"$proxyJs`"" -WindowStyle Hidden
    Write-Host "[oc-vpn] proxy started" -ForegroundColor Green
  }
}
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2
    if ($r.ok) {
      Write-Host "[oc-vpn] proxy ready - current IP: $($r.active.exitIP)" -ForegroundColor Green
      return
    }
  } catch { }
}
Write-Warning "[oc-vpn] proxy not ready after 60s"