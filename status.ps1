# Shows the current proxy status: active upstream, exit IP, rotation count,
# and recent IP-change history.
param(
  [int]$Port = 8899
)
try {
  $s = Invoke-RestMethod "http://127.0.0.1:$Port/status" -TimeoutSec 5
} catch {
  Write-Host "[oc-vpn] proxy is not running (no server on 127.0.0.1:$Port). Start it with .\start-proxy.ps1" -ForegroundColor Red
  exit 1
}
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host " oc-vpn proxy status" -ForegroundColor Cyan
Write-Host "===============================================" -ForegroundColor Cyan
Write-Host ("listening   : {0}" -f $s.listen)
Write-Host ("rotate every: {0}s" -f $s.rotateSeconds)
Write-Host ("rotations   : {0}" -f $s.rotations)
Write-Host ("pool size   : {0}" -f $s.poolSize)
Write-Host ("backups     : {0}" -f @($s.backups).Count)
Write-Host ("failures    : {0}" -f $s.activeFailures)
if ($s.active) {
  Write-Host ""
  Write-Host ("active IP   : {0}  [{1}]" -f $s.active.exitIP, $s.active.country)
  Write-Host ("upstream    : {0}://{1}:{2}  ({3}ms)" -f $s.active.type, $s.active.host, $s.active.port, $s.active.latencyMs)
  Write-Host ("since       : {0}" -f $s.active.since)
}
if (@($s.backups).Count -gt 0) {
  Write-Host ""
  Write-Host "failover backups (used automatically if the active one dies):" -ForegroundColor Cyan
  foreach ($b in $s.backups) {
    Write-Host ("  {0}:{1}  exit {2}  ({3}ms)" -f $b.host, $b.port, $b.exitIP, $b.latencyMs)
  }
}
Write-Host ""
Write-Host "history (last 10 rotations):" -ForegroundColor Cyan
foreach ($h in $s.history) {
  Write-Host ("  {0}  {1,-16} [{2}]  via {3}" -f $h.at, $h.exitIP, $h.country, $h.upstream)
}