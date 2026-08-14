# Removes the user-scope proxy variables set by set-user-proxy.ps1.
$ErrorActionPreference = "SilentlyContinue"
foreach ($k in @("HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy")) {
  [Environment]::SetEnvironmentVariable($k, $null, "User")
}
Write-Host "[oc-vpn] User-scope proxy variables removed. Relaunch the desktop app to go back to direct connections." -ForegroundColor Green