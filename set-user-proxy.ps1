# Makes the opencode DESKTOP app use the rotating VPN proxy by setting
# user-scope environment variables (picked up by apps launched from the
# Start menu / desktop). The proxy itself keeps running in the background
# and keeps rotating IPs every minute.
#
# NOTE: user-scope HTTP_PROXY/HTTPS_PROXY are inherited by other CLI tools
# too, but the proxy's allowlist blocks anything that is not an AI-provider
# domain, so non-opencode destinations get rejected (403), not routed.
#
# Usage: .\set-user-proxy.ps1
$ErrorActionPreference = "Stop"
$port = 8899

& (Join-Path $PSScriptRoot "start-proxy.ps1")

[Environment]::SetEnvironmentVariable("HTTP_PROXY",  "http://127.0.0.1:$port", "User")
[Environment]::SetEnvironmentVariable("HTTPS_PROXY", "http://127.0.0.1:$port", "User")
[Environment]::SetEnvironmentVariable("NO_PROXY",    "localhost,127.0.0.1,::1", "User")
[Environment]::SetEnvironmentVariable("http_proxy",  "http://127.0.0.1:$port", "User")
[Environment]::SetEnvironmentVariable("https_proxy", "http://127.0.0.1:$port", "User")
[Environment]::SetEnvironmentVariable("no_proxy",    "localhost,127.0.0.1,::1", "User")

Write-Host ""
Write-Host "[oc-vpn] User-scope proxy variables set." -ForegroundColor Green
Write-Host "[oc-vpn] Fully quit the opencode desktop app, then relaunch it so it picks up the new variables." -ForegroundColor Cyan
Write-Host "[oc-vpn] The proxy is running in the background and rotates IPs every minute." -ForegroundColor Cyan
Write-Host "[oc-vpn] To undo: run .\unset-user-proxy.ps1" -ForegroundColor Yellow