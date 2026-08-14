# oc-vpn — rotating VPN proxy dedicated to opencode
#
# Starts the local rotating proxy, routes ONLY this opencode session's
# traffic through it (HTTP_PROXY/HTTPS_PROXY set for this process only),
# launches opencode, then restores everything when opencode exits.
#
# All arguments are passed through to opencode untouched.
#
# Usage:
#   .\opencode-vpn.ps1                        (launches the opencode TUI)
#   .\opencode-vpn.ps1 run "your prompt"
#   .\opencode-vpn.ps1 -m anthropic/claude-x  (opencode flags work too)
#
# Options via environment variables:
#   OC_VPN_KEEP_PROXY=1   leave the proxy running after opencode exits
#   OC_VPN_WAIT_SECONDS   how long to wait for the proxy to find an IP
#                         (default 90)

$ErrorActionPreference = "Stop"
$vpnDir   = $PSScriptRoot
$proxyJs  = Join-Path $vpnDir "proxy.js"
$port     = 8899
$proxyUrl = "http://127.0.0.1:$port"
$waitSeconds = if ($env:OC_VPN_WAIT_SECONDS) { [int]$env:OC_VPN_WAIT_SECONDS } else { 90 }

function Test-ProxyRunning {
  $p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'proxy\.js' }
  return $null -ne $p
}

function Start-Proxy {
  if (Test-ProxyRunning) { Write-Host "[oc-vpn] proxy already running" -ForegroundColor Yellow; return }
  $node = (Get-Command node -ErrorAction Stop).Source
  Start-Process -FilePath $node -ArgumentList "`"$proxyJs`"" -WindowStyle Hidden
  Write-Host "[oc-vpn] starting proxy..." -ForegroundColor Cyan
  $ready = $false
  for ($i = 0; $i -lt $waitSeconds; $i++) {
    Start-Sleep -Seconds 1
    try {
      $r = Invoke-RestMethod "$proxyUrl/health" -TimeoutSec 2
      if ($r.ok) { $ready = $true; break }
    } catch { }
  }
  if ($ready) { Write-Host "[oc-vpn] proxy ready" -ForegroundColor Green }
  else { Write-Warning "[oc-vpn] proxy not ready after $waitSeconds s - opencode may fail to reach the network" }
}

function Stop-Proxy {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'proxy\.js' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "[oc-vpn] proxy stopped" -ForegroundColor Yellow
}

Start-Proxy

$saved = @{}
$vars = @("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy")
foreach ($k in $vars) {
  $saved[$k] = [Environment]::GetEnvironmentVariable($k, "Process")
}
$env:HTTP_PROXY  = $proxyUrl
$env:HTTPS_PROXY = $proxyUrl
$env:NO_PROXY    = "localhost,127.0.0.1,::1"
$env:http_proxy  = $proxyUrl
$env:https_proxy = $proxyUrl
$env:no_proxy    = "localhost,127.0.0.1,::1"

Write-Host "[oc-vpn] opencode traffic now routes through the rotating proxy (IP changes every minute)" -ForegroundColor Cyan
$oldEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & opencode @args
  $ocExit = $LASTEXITCODE
}
finally {
  $ErrorActionPreference = $oldEap
  foreach ($k in $vars) {
    if ($null -eq $saved[$k]) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
    else { Set-Item "Env:$k" $saved[$k] }
  }
  if ($env:OC_VPN_KEEP_PROXY -ne "1") { Stop-Proxy }
}
exit $ocExit