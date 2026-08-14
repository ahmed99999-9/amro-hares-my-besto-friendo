# oc-vpn: rotating VPN proxy for opencode

A local proxy that routes **only opencode's traffic** through a rotating VPN
pool. The exit IP changes **every minute**. Any VPN service that gives you
a SOCKS5 or HTTP proxy endpoint works (paid VPN providers, residential
proxies, free pools, etc.) — Tor is not used anywhere.

## How it works

```
opencode ── HTTP_PROXY ──► 127.0.0.1:8899  (oc-vpn-proxy)
                              │  connects through the CURRENT upstream
                              ▼
                  rotating pool: SOCKS5 / HTTP proxies
                  (free pool + your own static proxies)
                              │  health-checked, best one picked
                              ▼
                     api.ipify.org confirms exit IP
                              │  every 300s a NEW proxy is picked
                              ▼
                        new IP every 5 minutes
```

- The proxy binds to `127.0.0.1` only and **rejects any destination that is
  not an AI-provider domain** (opencode.ai, anthropic.com, openai.com, ...),
  so nothing but opencode can ever ride it.
- Only the opencode process gets the proxy env vars (session-scoped), so the
  rest of your system keeps using its normal connection.
- `NO_PROXY` includes `localhost,127.0.0.1` so the opencode TUI ↔ local server
  connection is never proxied (required by opencode).
- The exit IP changes **every minute** (`rotateSeconds: 60`).

## Files

| File | Purpose |
|---|---|
| `proxy.js` | The proxy server + rotation engine (Node, no dependencies) |
| `proxies.json` | Settings: rotation interval, free pool URL, your static proxies |
| `opencode-vpn.ps1` | **Main entry**: starts proxy → launches opencode through it → cleans up |
| `start-proxy.ps1` / `stop-proxy.ps1` | Background proxy lifecycle |
| `status.ps1` | Show current IP, upstream, rotation history |
| `set-user-proxy.ps1` / `unset-user-proxy.ps1` | For the opencode **desktop app** (user-scope env vars) |
| `status.json` / `proxy.log` | Written at runtime |

## Quick start (CLI)

```powershell
cd <project-folder>   # wherever you put oc-vpn
.\opencode-vpn.ps1          # starts proxy, launches opencode through it
.\opencode-vpn.ps1 run "hello"   # or pass any opencode args
```

That's it. Every minute the proxy health-checks the pool and switches to a
new working upstream — the IP you appear from changes.

`OC_VPN_KEEP_PROXY=1` keeps the proxy running after opencode exits;
`OC_VPN_WAIT_SECONDS` controls how long the wrapper waits for the proxy to
find its first IP (default 90).

## Quick start (desktop app)

```powershell
cd <project-folder>   # wherever you put oc-vpn
.\set-user-proxy.ps1        # starts background proxy + sets user env vars
# fully quit and relaunch the opencode desktop app
.\status.ps1                # check the current IP / rotation history
.\unset-user-proxy.ps1      # when you want to stop
```

## Using YOUR VPN service (recommended for reliability)

The default is the free proxyscrape pool — works but flaky. If you have a
subscription to any VPN service that exposes SOCKS5/HTTP endpoints (e.g.
NordVPN SOCKS5, ExpressVPN manual config, residential proxy sellers, any
"rotating proxy" provider), paste them into `proxies.json`:

```json
{
  "staticProxies": [
    "socks5://user:pass@proxy.example.com:1080",
    "http://user:pass@proxy.example.com:8080"
  ],
  "freeListEnabled": false
}
```

If your provider hands you **one** endpoint that rotates automatically, just
put that single entry in `staticProxies` and set `rotateSeconds` higher — the
provider itself gives you a new IP per connection.

You can also use the generic format supported by many VPN/proxy services:
`protocol://user:pass@host:port`.

## Useful commands

```powershell
.\status.ps1                     # current IP + history
Invoke-RestMethod http://127.0.0.1:8899/rotate -Method Post   # rotate NOW
node proxy.js --rotate-now       # one rotation, then keep running
```

## Tweaks (`proxies.json` or env vars)

| Setting | Env var | Default | Meaning |
|---|---|---|---|
| `rotateSeconds` | `OC_VPN_ROTATE_SECONDS` | `60` | seconds between IP changes |
| `listen.port` | `OC_VPN_PORT` | `8899` | local proxy port |
| `token` | `OC_VPN_TOKEN` | `""` | require `X-oc-vpn-token` header |
| `allowlist` | `OC_VPN_ALLOWLIST` | `true` | only AI-provider domains pass |
| `freeListEnabled` | — | `true` | use the free pool as a source |

## Proxy pool & refresh

Every rotation re-fetches fresh lists **from the providers** — 6 sources in
parallel (proxyscrape HTTP/SOCKS5 + TheSpeedX lists + proxifly lists on
GitHub), merged and deduplicated (~3000–4000 unique proxies). If one source
fails or rate-limits, the others still deliver; the previous working pool is
kept until the new one is ready. Add your own paid VPN endpoints in
`staticProxies` in `proxies.json`.

## Automatic failover

If the active upstream dies **between** rotations, the proxy does not wait
for the next minute-cycle:

1. Each rotation stores the best working proxies as a **failover cache**
   (default 8–10 unique-IP proxies).
2. When a connection through the active upstream fails, the proxy
   immediately retries through the cached backups (up to `failoverTries`,
   default 4) and **promotes the first working one to active** — logged as
   `[failover]` and shown with `reason: "failover"` in `status.ps1` history.
3. If the whole chain fails repeatedly (`failoverThreshold`, default 2),
   the proxy kicks an **immediate rotation** to fetch a fresh pool.
4. A **heartbeat** (every `heartbeatSeconds`, default 30) actively probes the
   active upstream — even with zero traffic — and replaces a dead proxy
   within seconds, so a broken IP never lingers until a request fails.

Verified in testing: an active proxy died mid-cycle, the proxy switched
`103.132.52.145 → 195.133.53.59` within seconds and all subsequent requests
succeeded with zero downtime.

## Never stops

- A **watchdog** (`watchdog.ps1`) monitors the proxy every 20 seconds and
  restarts it within seconds if it ever dies.
- `install-autostart.ps1` adds the watchdog to your user **Startup folder**
  (no admin rights), so after every login the proxy is running and watched.
  Remove it anytime with `remove-autostart.ps1`.
- On restart the proxy **resumes from `status.json`** — it keeps the last
  working upstream + failover backups, so traffic flows immediately instead
  of waiting for a fresh health check.

## Does not affect the rest of the machine

- The proxy listens **only on `127.0.0.1`** (loopback) — nothing outside
  this machine can even reach it.
- No system/user-wide proxy variables are set. Nothing routes through the
  proxy unless you explicitly launch opencode via `opencode-vpn.ps1`
  (session-only variables) or run `set-user-proxy.ps1` (desktop app).
- The allowlist rejects every destination that is not an AI-provider domain
  with `403`, so even a stray app pointed at the proxy gets blocked, not
  routed.

## Survives internet outages

If the internet cuts off:

- The proxy **never stops** — it detects "outage mode" (no list sources
  reachable, no working proxy) and retries a rotation every
  `outageRetrySeconds` (default 15) indefinitely, until the internet is back.
- Incoming requests are **held open** (up to `outageHoldMs`, default 120s)
  instead of failing immediately, so when the network returns the request
  goes through automatically — opencode is configured with
  `"timeout": false` / `"headerTimeout": false` so it never cancels the
  wait (see `~/.config/opencode/opencode.jsonc`).
- When the internet returns, the next rotation succeeds within seconds and
  traffic resumes through a working proxy — never through the machine's own
  IP (`allowDirectFallback` is always false).

## Security notes

- The proxy is loopback-only and (by default) drops every destination outside
  the AI-provider allowlist with `403`.
- Free proxies can see your traffic (that is the "data-collecting service"
  trade-off you accepted). For sensitive work, use proxies from a provider
  you trust — `staticProxies` makes that a one-line change.
- If `allowDirectFallback` is `false` (default), the proxy **never** falls
  back to your direct connection: no proxy works → opencode simply fails,
  nothing leaks around the VPN.