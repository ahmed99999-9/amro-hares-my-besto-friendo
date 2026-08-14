#!/usr/bin/env node
/**
 * oc-vpn-proxy — rotating VPN proxy for opencode.
 *
 * A local HTTP proxy (127.0.0.1) that forwards every connection through a
 * rotating upstream proxy pool (SOCKS5 / HTTP proxies from any VPN service).
 * The exit IP is changed every OC_VPN_ROTATE_SECONDS (default 300s = 5 min).
 *
 * Only opencode is supposed to talk to this proxy (it is bound to loopback
 * and opencode is configured with HTTP_PROXY/HTTPS_PROXY pointing here).
 * Optionally, a domain allowlist rejects everything that is not an AI
 * provider endpoint.
 *
 * Endpoints on the local server:
 *   GET  /status   -> JSON with current upstream + exit IP + history
 *   POST /rotate   -> force an immediate rotation
 *
 * Usage:
 *   node proxy.js [--rotate-now] [--config path]
 */

"use strict";

const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const crypto = require("crypto");

const HERE = __dirname;
const CONFIG_PATH = process.env.OC_VPN_CONFIG || path.join(HERE, "proxies.json");
const STATUS_PATH = process.env.OC_VPN_STATUS || path.join(HERE, "status.json");
const LOG_PATH = process.env.OC_VPN_LOG || path.join(HERE, "proxy.log");

const IPIFY_HTTP = "http://api.ipify.org";
const IPIFY_HTTPS = "https://api.ipify.org";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig() {
  const def = {
    listen: { host: "127.0.0.1", port: 8899 },
    rotateSeconds: 300,
    connectTimeoutMs: 6000,
    healthTimeoutMs: 8000,
    healthConcurrency: 25,
    healthCheckLimit: 100,
    minWorking: 8,
    failoverCacheSize: 10,
    failoverTries: 4,
    failoverThreshold: 2,
    heartbeatSeconds: 30,
    outageRetrySeconds: 15,
    outageHoldMs: 120000,
    logMaxBytes: 1024 * 1024,
    freeListEnabled: true,
    logConnections: false,
    freeListUrls: [
      "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=ipport&format=text&protocol=http",
      "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=ipport&format=text&protocol=socks5",
      "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
      "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
      "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
      "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
    ],
    staticProxies: [],
    allowDirectFallback: false,
    allowlist: true,
    token: "",
    ipApi: "http://ip-api.com/json/"
  };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    Object.assign(def, raw);
  } catch (e) {
    log(`[config] could not read ${CONFIG_PATH}: ${e.message} — using defaults`);
  }
  if (process.env.OC_VPN_PORT) def.listen.port = parseInt(process.env.OC_VPN_PORT, 10);
  if (process.env.OC_VPN_ROTATE_SECONDS) def.rotateSeconds = parseInt(process.env.OC_VPN_ROTATE_SECONDS, 10);
  if (process.env.OC_VPN_TOKEN) def.token = process.env.OC_VPN_TOKEN;
  if (process.env.OC_VPN_ALLOWLIST === "false" || process.env.OC_VPN_ALLOWLIST === "0") def.allowlist = false;
  return def;
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
    try {
      if (fs.statSync(LOG_PATH).size > config.logMaxBytes) {
        fs.renameSync(LOG_PATH, LOG_PATH + ".old");
      }
    } catch (e) { /* ignore */ }
  } catch (e) {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  active: null, // { host, port, type, auth, exitIP, latencyMs, since }
  pool: [], // last known candidate list
  history: [], // { at, upstream, exitIP }
  rotCount: 0,
  workingCache: [], // last working proxies (unique exit IPs), used for failover
  activeFailures: 0, // consecutive failed attempts on the whole chain
  rotating: false, // rotation in progress guard
  outage: false, // true while no working upstream could be found (e.g. no internet)
};

function saveStatus() {
  const status = {
    updatedAt: ts(),
    listen: `${config.listen.host}:${config.listen.port}`,
    rotateSeconds: config.rotateSeconds,
    active: state.active,
    poolSize: state.pool.length,
    backups: state.workingCache.map((b) => ({ host: b.host, port: b.port, type: b.type, auth: b.auth, exitIP: b.exitIP, latencyMs: b.latencyMs, source: b.source })),
    activeFailures: state.activeFailures,
    rotations: state.rotCount,
    history: state.history.slice(-10),
  };
  try {
    fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));
  } catch (e) {
    /* ignore */
  }
}

// Resume from the last saved state so a restart is seamless (no waiting for
// a fresh health check before traffic can flow again).
function resumeFromDisk() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));
    if (saved.active && saved.active.host && saved.active.exitIP) {
      state.active = { ...saved.active, since: ts() };
      state.rotCount = saved.rotations || 0;
      state.history = (saved.history || []).slice(-10);
      log(`[resume] restored active upstream ${state.active.type}://${state.active.host}:${state.active.port} (exit ${state.active.exitIP}) - traffic works immediately`);
    }
    if (Array.isArray(saved.backups)) {
      state.workingCache = saved.backups.filter((b) => b && b.host && b.port);
      log(`[resume] restored ${state.workingCache.length} failover backups`);
    }
  } catch (e) {
    /* first run or corrupt file - ignore */
  }
}

// ---------------------------------------------------------------------------
// Upstream proxy clients
// ---------------------------------------------------------------------------

/**
 * Open a TCP socket through the upstream proxy to (host, port).
 * Returns a connected net.Socket. Throws on failure.
 */
function upstreamConnect(up, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = net.connect({ host: up.host, port: up.port });
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("upstream connect timeout")), timeoutMs || config.connectTimeoutMs);
    sock.once("error", fail);

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeListener("error", fail);
      resolve(sock);
    };

    if (up.type === "socks5" || up.type === "socks5h") {
      // SOCKS5 handshake
      const auth = up.auth ? up.auth : null;
      let buf = Buffer.alloc(0);
      const write = (b) => { if (!sock.destroyed) sock.write(b); };
      const sendMethods = () => {
        if (auth) {
          write(Buffer.from([0x05, 0x02, 0x00, 0x02])); // no-auth + user/pass
        } else {
          write(Buffer.from([0x05, 0x01, 0x00]));
        }
      };
      let stage = 0;
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          if (stage === 0) {
            if (buf.length < 2) return;
            const ver = buf[0], method = buf[1];
            buf = buf.subarray(2);
            if (ver !== 0x05) throw new Error("socks5: bad version");
            if (method === 0xff) throw new Error("socks5: no acceptable auth method");
            if (method === 0x02) {
              stage = 1;
              if (!auth) throw new Error("socks5: server requires auth");
              const u = Buffer.from(auth.username, "utf8");
              const p = Buffer.from(auth.password, "utf8");
              if (u.length > 255 || p.length > 255) throw new Error("socks5: credentials too long");
              write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
              return;
            }
            stage = 2;
            sendConnect();
          } else if (stage === 1) {
            if (buf.length < 2) return;
            if (buf[0] !== 0x01 || buf[1] !== 0x00) throw new Error("socks5: auth failed");
            buf = buf.subarray(2);
            stage = 2;
            sendConnect();
          } else if (stage === 2) {
            if (buf.length < 4) return;
            const rep = buf[1];
            if (rep !== 0x00) throw new Error(`socks5: connect failed rep=0x${rep.toString(16)}`);
            const atyp = buf[3];
            let len;
            if (atyp === 0x01) len = 4 + 2; // IPv4 + port
            else if (atyp === 0x03) len = 1 + buf[4] + 2; // domain + port
            else if (atyp === 0x04) len = 16 + 2; // IPv6 + port
            else throw new Error("socks5: bad atyp");
            if (buf.length < 4 + len) return;
            sock.removeListener("data", onData);
            done();
          }
        } catch (e) {
          fail(e);
        }
      };
      sock.on("data", onData);
      sock.once("connect", sendMethods);
      function sendConnect() {
        if (host.length > 255) throw new Error("socks5: domain too long");
        const portBuf = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
        const domain = Buffer.from(host, "utf8");
        write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain, portBuf]));
      }
    } else if (up.type === "http" || up.type === "https") {
      // HTTP proxy: use CONNECT to tunnel
      sock.once("connect", () => {
        let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
        if (up.auth) {
          const cred = Buffer.from(`${up.auth.username}:${up.auth.password}`, "utf8").toString("base64");
          req += `Proxy-Authorization: Basic ${cred}\r\n`;
        }
        req += "\r\n";
        write(req);
      });
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString("latin1");
        const statusLine = head.split("\r\n")[0];
        const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
        if (!m) return fail(new Error("http proxy: bad response"));
        const code = parseInt(m[1], 10);
        if (code >= 200 && code < 300) {
          sock.removeListener("data", onData);
          if (buf.length > idx + 4) sock.unshift(buf.subarray(idx + 4));
          done();
        } else {
          fail(new Error(`http proxy: CONNECT rejected ${code}`));
        }
      };
      sock.on("data", onData);
      const write = (b) => { if (!sock.destroyed) sock.write(b); };
    } else {
      fail(new Error(`unknown upstream type: ${up.type}`));
    }
  });
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

const DEFAULT_ALLOWLIST = [
  "opencode.ai",
  "openai.com",
  "chatgpt.com",
  "anthropic.com",
  "claude.ai",
  "googleapis.com",
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "google.com",
  "gstatic.com",
  "openrouter.ai",
  "github.com",
  "githubusercontent.com",
  "copilot.microsoft.com",
  "azure.com",
  "azureedge.net",
  "grok.com",
  "x.ai",
  "mistral.ai",
  "groq.com",
  "together.ai",
  "deepseek.com",
  "moonshot.cn",
  "kimi.com",
  "huggingface.co",
  "models.dev",
  "registry.npmjs.org",
  "npmjs.com",
  "registry.yarnpkg.com",
  "unpkg.com",
  "api.ipify.org",
  "ip-api.com",
  "proxyscrape.com",
];

function allowed(host) {
  if (!config.allowlist) return true;
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  for (const d of DEFAULT_ALLOWLIST) {
    if (h === d || h.endsWith("." + d)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

function checkProxy(up, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const useHttps = config.healthUseHttps || false;
    const target = useHttps ? IPIFY_HTTPS : IPIFY_HTTP;
    const url = new URL(target);
    const port = url.port || (url.protocol === "https:" ? 443 : 80);
    let sock;
    try {
      sock = upstreamConnect(up, url.hostname, parseInt(port, 10), timeoutMs || config.healthTimeoutMs);
    } catch (e) {
      return resolve(null);
    }
    Promise.resolve(sock).then((s) => {
      const req = `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nUser-Agent: oc-vpn-proxy/1.0\r\n\r\n`;
      s.write(req);
      let data = "";
      let done = false;
      const finish = (exitIP) => {
        if (done) return;
        done = true;
        s.destroy();
        const latencyMs = Date.now() - t0;
        resolve(exitIP ? { ...up, exitIP, latencyMs } : null);
      };
      s.on("data", (c) => {
        data += c.toString("latin1");
        const m = data.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
        if (m && data.includes("\r\n\r\n")) finish(m[1]);
      });
      s.on("error", () => finish(null));
      s.on("close", () => finish(null));
      const timer = setTimeout(() => finish(null), timeoutMs || config.healthTimeoutMs);
      s.on("end", () => { clearTimeout(timer); });
    }).catch(() => resolve(null));
  });
}

async function geoOf(ip) {
  try {
    if (!config.ipApi) return null;
    const url = new URL(config.ipApi + encodeURIComponent(ip));
    const proto = url.protocol === "https:" ? https : http;
    const body = await new Promise((resolve, reject) => {
      const req = proto.get(url, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d));
      });
      req.on("error", reject);
      req.setTimeout(4000, () => req.destroy(new Error("geo timeout")));
    });
    const j = JSON.parse(body);
    return j.status === "success" ? `${j.countryCode || "?"} ${j.city || ""}`.trim() : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

async function fetchFreeList() {
  const sources = (config.freeListUrls || []);
  if (config.freeListUrl && !sources.length) sources.push(config.freeListUrl); // legacy fallback
  if (!sources.length || !config.freeListEnabled) return [];
  const out = [];
  const seen = new Set();
  await Promise.all(sources.map(async (src) => {
    let url = src, type = "http";
    if (typeof src !== "string") { url = src.url; type = src.type || "http"; }
    else if (/socks5/i.test(src)) type = "socks5";
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      let n = 0;
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
        if (!m) continue;
        const key = m[1] + ":" + m[2];
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type, host: m[1], port: parseInt(m[2], 10), source: "free" });
        n++;
      }
      log(`[pool] source OK (${type}): ${url} - ${n} new proxies`);
    } catch (e) {
      log(`[pool] source failed: ${url} (${e.message})`);
    }
  }));
  log(`[pool] merged free pool: ${out.length} unique proxies from ${sources.length} sources`);
  return out;
}

function parseStatic(proxies) {
  const out = [];
  for (const p of proxies || []) {
    if (typeof p === "string") {
      const m = p.match(/^((socks5|socks4|http|https):\/\/)?(?:([^:@\/]+)(?::([^@\/]*))?@)?([^:\/]+):(\d+)$/i);
      if (!m) {
        log(`[config] ignoring invalid static proxy entry: ${p}`);
        continue;
      }
      const type = (m[2] || "http").toLowerCase();
      out.push({
        type: type === "socks4" ? "socks5" : type,
        host: m[5],
        port: parseInt(m[6], 10),
        auth: m[3] ? { username: decodeURIComponent(m[3]), password: decodeURIComponent(m[4] || "") } : null,
        source: "static",
      });
    } else if (p && p.host) {
      out.push({
        type: p.type || "http",
        host: p.host,
        port: parseInt(p.port, 10),
        auth: p.username ? { username: p.username, password: p.password || "" } : null,
        source: p.source || "static",
      });
    }
  }
  return out.filter((p) => p.host && p.port > 0);
}

async function collectCandidates() {
  const staticProxies = parseStatic(config.staticProxies);
  const free = config.freeListEnabled ? await fetchFreeList() : [];
  const seen = new Set();
  const all = [];
  for (const p of [...staticProxies, ...free]) {
    const key = `${p.type}|${p.host}:${p.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(p);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

async function rotate(force) {
  if (state.rotating) {
    log("[pool] rotation already in progress — skipping");
    return false;
  }
  state.rotating = true;
  try {
    log("[pool] collecting candidates...");
    const candidates = await collectCandidates();
    state.pool = candidates;
    if (candidates.length === 0) {
      state.outage = true;
      log("[pool] no candidates available (internet down?) - outage mode, retrying soon");
      return false;
    }

    log(`[pool] health-checking up to ${config.healthCheckLimit} of ${candidates.length} proxies (${config.healthConcurrency} at a time, need ${config.minWorking} working)...`);
    const sample = candidates.length > config.healthCheckLimit
      ? [...candidates].sort(() => Math.random() - 0.5).slice(0, config.healthCheckLimit)
      : candidates;
    const results = [];
    const seenIPs = new Set();
    let idx = 0;
    let done = false;
    async function worker() {
      while (!done && idx < sample.length) {
        const c = sample[idx++];
        const r = await checkProxy(c);
        if (r && !done) {
          if (!seenIPs.has(r.exitIP)) {
            seenIPs.add(r.exitIP);
            results.push(r);
          }
          if (results.length >= config.minWorking) done = true;
        }
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(config.healthConcurrency, sample.length); i++) workers.push(worker());
    await Promise.all(workers);

    if (results.length > 0) {
      state.workingCache = results
        .sort((a, b) => a.latencyMs - b.latencyMs)
        .slice(0, config.failoverCacheSize)
        .map((r) => ({ ...r }));
    }

    if (results.length === 0) {
      state.outage = true;
      log("[pool] no working proxies found - outage mode: keeping previous cache, retrying soon");
      return false;
    }

    state.outage = false;
    state.activeFailures = 0;

    const currentIP = state.active && state.active.exitIP;
    const shuffled = results.sort(() => Math.random() - 0.5);
    let pick = null;
    if (force || currentIP) {
      pick = shuffled.find((r) => r.exitIP !== currentIP) || shuffled[0];
    } else {
      pick = shuffled.find((r) => r.latencyMs < 10000) || shuffled[0];
    }
    if (!pick) return false;

    if (state.active && pick.exitIP === state.active.exitIP && !force) {
      log(`[rotate] picked ${pick.host}:${pick.port} but exit IP unchanged (${pick.exitIP}) — retrying in ${config.rotateSeconds}s`);
      state.pickPending = pick;
      return true;
    }

    const oldIP = state.active ? state.active.exitIP : null;
    state.active = {
      host: pick.host,
      port: pick.port,
      type: pick.type,
      auth: pick.auth,
      exitIP: pick.exitIP,
      latencyMs: pick.latencyMs,
      source: pick.source,
      since: ts(),
    };
    state.rotCount++;
    state.activeFailures = 0;
    const histEntry = {
      at: ts(),
      upstream: `${pick.type}://${pick.host}:${pick.port}`,
      exitIP: pick.exitIP,
      country: null,
      latencyMs: pick.latencyMs,
      reason: force ? "manual" : "scheduled",
    };
    state.history.push(histEntry);
    log(`[rotate] #${state.rotCount} ${oldIP || "(none)"} -> ${pick.exitIP} (via ${pick.type}://${pick.host}:${pick.port}, ${pick.latencyMs}ms)`);
    saveStatus();
    geoOf(pick.exitIP).then((g) => {
      histEntry.country = g || null;
      if (state.active && state.active.exitIP === pick.exitIP) state.active.country = g || null;
      saveStatus();
    }).catch(() => {});
    return true;
  } finally {
    state.rotating = false;
  }
}

// ---------------------------------------------------------------------------
// Failover: try active upstream first, then cached backups, and if the whole
// chain is dead, kick an immediate rotation so a broken proxy is replaced
// right away instead of waiting for the next scheduled rotation.
// ---------------------------------------------------------------------------

function promoteBackup(up) {
  const oldIP = state.active ? state.active.exitIP : null;
  state.active = {
    host: up.host,
    port: up.port,
    type: up.type,
    auth: up.auth,
    exitIP: up.exitIP,
    latencyMs: up.latencyMs,
    source: up.source || "backup",
    since: ts(),
  };
  state.rotCount++;
  state.activeFailures = 0;
  state.history.push({
    at: ts(),
    upstream: `${up.type}://${up.host}:${up.port}`,
    exitIP: up.exitIP,
    country: null,
    latencyMs: up.latencyMs,
    reason: "failover",
  });
  geoOf(up.exitIP).then((g) => { if (state.active === up || (state.active && state.active.exitIP === up.exitIP)) { state.active.country = g; saveStatus(); } }).catch(() => {});
  log(`[failover] active upstream died - switched ${oldIP || "(none)"} -> ${up.exitIP} via ${up.type}://${up.host}:${up.port} (${up.latencyMs}ms)`);
  saveStatus();
}

function triggerFailoverRotate() {
  if (state.activeFailures >= config.failoverThreshold && !state.rotating) {
    log(`[failover] ${state.activeFailures} consecutive failures - forcing immediate rotation`);
    rotate(false).catch((e) => log(`[failover] rotation error: ${e.message}`));
  }
}

// ---------------------------------------------------------------------------
// Heartbeat: every heartbeatSeconds, verify the active upstream is still
// alive. If it died, replace it proactively (even with zero traffic) instead
// of waiting for the next rotation or for a request to fail.
// ---------------------------------------------------------------------------

async function heartbeat() {
  const up = state.active;
  if (!up || state.rotating || state.outage) return;
  const probe = await checkProxy({ ...up }, 6000).catch(() => null);
  if (probe) {
    if (probe.exitIP !== up.exitIP) {
      state.active.exitIP = probe.exitIP;
      log(`[heartbeat] active proxy alive, exit IP now ${probe.exitIP}`);
    }
    return;
  }
  log(`[heartbeat] active ${up.host}:${up.port} (exit ${up.exitIP}) is dead - searching backups`);
  let tried = 0;
  for (const b of state.workingCache) {
    if (b.host === up.host && b.port === up.port) continue;
    if (tried >= 4) break;
    tried++;
    const alive = await checkProxy(b, 6000).catch(() => null);
    if (alive) {
      promoteBackup({ ...b, latencyMs: alive.latencyMs, exitIP: alive.exitIP });
      return;
    }
    log(`[heartbeat] backup ${b.host}:${b.port} (exit ${b.exitIP}) dead too`);
  }
  log("[heartbeat] no live backup found - forcing rotation now");
  rotate(false).catch((e) => log(`[heartbeat] rotation error: ${e.message}`));
}

function connectWithFailover(host, port) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let attempts = 0;
    const attempt = () => {
      const chain = [];
      if (state.activeFailures < 2 && state.active) chain.push(state.active);
      for (const b of state.workingCache) {
        if (b !== state.active && chain.length - (state.active ? 1 : 0) < config.failoverTries - 1) chain.push(b);
      }
      if (chain.length === 0) {
        // no upstream at all: during an outage keep trying; otherwise fail fast
        if (state.outage && Date.now() - startedAt < config.outageHoldMs) {
          setTimeout(attempt, 2000);
          return;
        }
        reject(new Error("no upstream available yet"));
        return;
      }
      let i = 0;
      const tryNext = () => {
        if (i >= chain.length) {
          state.activeFailures++;
          if (state.outage && Date.now() - startedAt < config.outageHoldMs) {
            // internet is down - hold the request and keep retrying
            attempts++;
            if (attempts % 5 === 1) log(`[outage] holding request to ${host}:${port} - retrying (${Math.round((Date.now() - startedAt) / 1000)}s of ${Math.round(config.outageHoldMs / 1000)}s)`);
            setTimeout(attempt, 2000);
            return;
          }
          triggerFailoverRotate();
          reject(new Error("all upstreams failed"));
          return;
        }
        const up = chain[i++];
        const t = (up === state.active ? config.connectTimeoutMs : Math.min(config.connectTimeoutMs, 4000));
        upstreamConnect(up, host, port, t).then((sock) => {
          if (up !== state.active && state.activeFailures < 2) promoteBackup(up);
          state.activeFailures = 0;
          resolve(sock);
        }).catch(() => tryNext());
      };
      tryNext();
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Local proxy server
// ---------------------------------------------------------------------------

function currentUpstream() {
  return state.active;
}

function serveRequest(req, res) {
  try {
    const up = currentUpstream();
    const host = req.headers.host ? req.headers.host.split(":")[0] : null;
    if (config.logConnections) log(`[conn] ${req.method} ${req.url} (host ${host}) via ${up ? up.type + "://" + up.host + ":" + up.port + " (exit " + up.exitIP + ")" : "failover chain"}`);
    if (!allowed(host)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`oc-vpn-proxy: destination ${host} is not in the allowlist`);
      return;
    }
    const port = req.url.startsWith("https://") ? 443 : 80;
    const url = req.url.startsWith("http") ? new URL(req.url) : null;
    const targetHost = url ? url.hostname : host;
    const targetPort = url ? (url.port || (url.protocol === "https:" ? 443 : 80)) : port;

    connectWithFailover(targetHost, parseInt(targetPort, 10))
      .then((sock) => {
        const outReq = http.request({
          createConnection: () => sock,
          host: targetHost,
          port: parseInt(targetPort, 10),
          path: url ? url.pathname + url.search : req.url,
          method: req.method,
          headers: sanitizeHeaders(req.headers),
        }, (outRes) => {
          res.writeHead(outRes.statusCode || 502, outRes.headers);
          outRes.pipe(res);
        });
        outReq.on("error", (e) => {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`oc-vpn-proxy: upstream error: ${e.message}`);
        });
        req.pipe(outReq);
      })
      .catch((e) => {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`oc-vpn-proxy: cannot reach upstream: ${e.message}`);
      });
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`oc-vpn-proxy: internal error: ${e.message}`);
  }
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = k.toLowerCase();
    if (["proxy-connection", "proxy-authorization", "proxy-authenticate", "connection", "keep-alive", "te", "trailer", "upgrade"].includes(lk)) continue;
    out[k] = v;
  }
  out.Connection = "keep-alive";
  return out;
}

function safeEnd(sock, data) {
  try {
    if (sock && !sock.destroyed) sock.end(data);
  } catch (e) {
    try { sock.destroy(); } catch (e2) { /* ignore */ }
  }
}

function handleConnect(req, clientSock, head) {
  try {
    const [host, portStr] = (req.url || "").split(":");
    if (config.logConnections) log(`[conn] CONNECT ${host}:${portStr} via ${up ? up.type + "://" + up.host + ":" + up.port + " (exit " + up.exitIP + ")" : "failover chain"}`);
    if (!allowed(host)) {
      safeEnd(clientSock, `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\noc-vpn-proxy: destination ${host} is not in the allowlist`);
      return;
    }
    const port = parseInt(portStr || "443", 10);
    connectWithFailover(host, port)
      .then((sock) => {
        try {
          clientSock.write("HTTP/1.1 200 Connection established\r\n\r\n");
          if (head && head.length) sock.write(head);
          clientSock.pipe(sock);
          sock.pipe(clientSock);
          sock.on("error", () => clientSock.destroy());
          clientSock.on("error", () => sock.destroy());
        } catch (e) {
          sock.destroy();
          safeEnd(clientSock, `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\n${e.message}`);
        }
      })
      .catch((e) => {
        safeEnd(clientSock, `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\noc-vpn-proxy: upstream error: ${e.message}`);
      });
  } catch (e) {
    safeEnd(clientSock, `HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\n${e.message}`);
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        updatedAt: ts(),
        listen: `${config.listen.host}:${config.listen.port}`,
        rotateSeconds: config.rotateSeconds,
        active: state.active,
        poolSize: state.pool.length,
        backups: state.workingCache.map((b) => ({ host: b.host, port: b.port, exitIP: b.exitIP, latencyMs: b.latencyMs })),
        activeFailures: state.activeFailures,
        rotations: state.rotCount,
        history: state.history.slice(-10),
      }, null, 2));
      return;
    }
    if (req.method === "POST" && req.url === "/rotate") {
      res.writeHead(200, { "content-type": "application/json" });
      rotate(true).then((ok) => res.end(JSON.stringify({ ok, active: state.active })));
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !!state.active }));
      return;
    }
    if (req.headers["x-oc-vpn-token"] !== config.token && config.token) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    serveRequest(req, res);
  });
  server.on("connect", handleConnect);
  server.on("error", (e) => {
    log(`[server] fatal: ${e.message}`);
    process.exit(1);
  });
  server.listen(config.listen.port, config.listen.host, () => {
    log(`oc-vpn-proxy listening on ${config.listen.host}:${config.listen.port} - rotate every ${config.rotateSeconds}s (allowlist=${config.allowlist})`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  resumeFromDisk();
  startServer();

  await rotate(args.includes("--rotate-now"));

  // Self-scheduling loop: next rotation starts `rotateSeconds` after the
  // previous one FINISHES, so scans never overlap and the cadence stays
  // steady even when a health check takes a while. During an outage the
  // interval shrinks to outageRetrySeconds so traffic resumes within
  // seconds of the internet coming back.
  const normal = Math.max(10, config.rotateSeconds) * 1000;
  const retry = Math.max(5, config.outageRetrySeconds) * 1000;
  (async function rotationLoop() {
    await rotate(false).catch((e) => log(`[rotate] error: ${e.message}`));
    setTimeout(rotationLoop, state.outage ? retry : normal);
  })();

  if (config.heartbeatSeconds > 0) {
    const hb = Math.max(5, config.heartbeatSeconds) * 1000;
    setInterval(() => {
      heartbeat().catch((e) => log(`[heartbeat] error: ${e.message}`));
    }, hb);
  }

  const onSignal = () => {
    log("shutting down");
    process.exit(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("uncaughtException", (e) => log(`[main] uncaught: ${e.stack || e.message}`));
  process.on("unhandledRejection", (e) => log(`[main] unhandled rejection: ${e && e.stack || e}`));
}

main().catch((e) => {
  log(`[main] fatal: ${e.stack || e.message}`);
  process.exit(1);
});