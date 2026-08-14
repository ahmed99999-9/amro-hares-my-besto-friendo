# Stops the rotating proxy background process.
$ErrorActionPreference = "SilentlyContinue"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'proxy\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host "[oc-vpn] proxy stopped" -ForegroundColor Yellow