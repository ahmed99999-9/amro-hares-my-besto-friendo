// omp-zen-vpn — بروكسي CONNECT بسيط ل opencode-zen
// يغلف الاتصال، يغيّر IP كل 60 ثانية (أو عند الاحتراق)، لا round-robin، لا برك معقدة.

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

type Upstream = {
  type: "http" | "https" | "socks5" | "socks5h";
  host: string;
  port: number;
  auth?: { username: string; password: string };
  exitIP?: string;
};

const CONFIG = {
  rotateSeconds: 60,
  connectTimeoutMs: 4000,
  healthTimeoutMs: 4000,
  perSourceLimit: 10,
  heartbeatSeconds: 5,
  freeListUrls: [
    "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=ipport&format=text&protocol=http",
    "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=ipport&format=text&protocol=socks5",
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
    "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
  ],
} as const;

const ZEN = {
  modelsUrl: "https://opencode.ai/zen/v1/models",
  chatUrl: "https://opencode.ai/zen/v1/chat/completions",
  ua: "opencode/1.0.0",
  bearer: "public",
};

const IPIFY_HTTP = "http://api.ipify.org";
const ALLOWLIST = [
  "opencode.ai", "openai.com", "chatgpt.com", "anthropic.com", "claude.ai",
  "googleapis.com", "generativelanguage.googleapis.com", "aiplatform.googleapis.com",
  "openrouter.ai", "github.com", "githubusercontent.com", "copilot.microsoft.com",
  "azure.com", "azureedge.net", "grok.com", "x.ai", "mistral.ai", "groq.com",
  "together.ai", "deepseek.com", "moonshot.cn", "kimi.com", "huggingface.co",
  "models.dev", "registry.npmjs.org", "npmjs.com", "registry.yarnpkg.com",
  "unpkg.com", "api.ipify.org",
];

function allowed(host: string | null | undefined): boolean {
  const h = String(host || "").toLowerCase();
  if (!h) return false;
  for (const d of ALLOWLIST) if (h === d || h.endsWith("." + d)) return true;
  return false;
}

interface State {
  active: Upstream | null;
  rotating: boolean;
}

const STATE_KEY = "__ompZenVpnSimpleState";

function getState(): State {
  const g = globalThis as unknown as Record<string, State | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { active: null, rotating: false };
  return g[STATE_KEY]!;
}

function log(msg: string) {
  if (process.env.OMP_ZEN_VPN_DEBUG) console.log(`[omp-zen-vpn] ${msg}`);
}

// ---------- Upstream connection ----------
function upstreamConnect(up: Upstream, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = net.connect({ host: up.host, port: up.port });
    const timer = setTimeout(() => { if (!settled) { settled = true; sock.destroy(); reject(new Error("timeout")); } }, timeoutMs);
    sock.once("error", (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });

    if (up.type === "socks5" || up.type === "socks5h") {
      const auth = up.auth;
      let buf = Buffer.alloc(0);
      const write = (b: Uint8Array) => { if (!sock.destroyed) sock.write(b as any); };
      let stage = 0;
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          if (stage === 0) {
            if (buf.length < 2) return;
            if (buf[0] !== 0x05 || buf[1] === 0xff) throw new Error("socks5 handshake failed");
            stage = auth ? 1 : 2;
            if (auth) { write(Buffer.from([0x05, 0x02, 0x00, 0x02])); return; }
            write(Buffer.from([0x05, 0x01, 0x00]));
          } else if (stage === 1) {
            if (buf.length < 2 || buf[0] !== 0x01 || buf[1] !== 0x00) throw new Error("socks5 auth failed");
            buf = buf.subarray(2);
            stage = 2;
          }
          if (stage === 2) {
            const domain = Buffer.from(host, "utf8");
            if (domain.length > 255) throw new Error("domain too long");
            const portBuf = Buffer.from([(port >> 8) & 0xff, port & 0xff]);
            write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]), domain, portBuf]));
            stage = 3;
          } else if (stage === 3) {
            if (buf.length < 4 || buf[1] !== 0x00) throw new Error("socks5 connect failed");
            sock.removeListener("data", onData);
            if (!settled) { settled = true; clearTimeout(timer); sock.removeListener("error", (e) => {}); resolve(sock); }
          }
        } catch (e) { if (!settled) { settled = true; clearTimeout(timer); reject(e as Error); } }
      };
      sock.on("data", onData);
      sock.once("connect", () => { if (stage === 0) { if (auth) write(Buffer.from([0x05, 0x02, 0x00, 0x02])); else write(Buffer.from([0x05, 0x01, 0x00])); } });
    } else {
      sock.once("connect", () => {
        let req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`;
        if (up.auth) {
          const cred = Buffer.from(`${up.auth.username}:${up.auth.password}`, "utf8").toString("base64");
          req += `Proxy-Authorization: Basic ${cred}\r\n`;
        }
        req += "\r\n";
        if (!sock.destroyed) sock.write(req);
      });
      let buf = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = buf.subarray(0, idx).toString("latin1");
        const m = head.split("\r\n")[0].match(/^HTTP\/\d\.\d\s+(\d+)/);
        if (!m) return;
        const code = parseInt(m[1], 10);
        if (code >= 200 && code < 300) {
          sock.removeListener("data", onData);
          if (buf.length > idx + 4) sock.unshift(buf.subarray(idx + 4));
          if (!settled) { settled = true; clearTimeout(timer); resolve(sock); }
        } else { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`proxy CONNECT ${code}`)); } }
      };
      sock.on("data", onData);
    }
    sock.once("connect", () => {});
  });
}

// ---------- Health checks ----------
async function ipifyProbe(up: Upstream, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const url = new URL(IPIFY_HTTP);
    const port = url.port || 80;
    upstreamConnect(up, url.hostname, port, timeoutMs)
      .then(sock => {
        const req = `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nUser-Agent: omp-zen-vpn/1.0\r\n\r\n`;
        sock.write(req);
        let data = "";
        let done = false;
        const finish = (ip: string | null) => { if (!done) { done = true; setTimeout(() => { try { sock.destroy(); } catch {} }, 0); resolve(ip); } };
        sock.on("data", (c) => { data += c.toString("latin1"); const m = data.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/); if (m && data.includes("\r\n\r\n")) finish(m[1]); });
        sock.on("error", () => finish(null));
        sock.on("close", () => finish(null));
        setTimeout(() => finish(null), timeoutMs);
      })
      .catch(() => resolve(null));
  });
}

function rawHttpsProbe(up: Upstream, host: string, path: string, method: "GET" | "POST", body: string | null, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const agent = new https.Agent({
      keepAlive: false,
      rejectUnauthorized: true,
      connect: (opts: unknown, cb: (err: Error | null, sock?: net.Socket) => void) => {
        upstreamConnect(up, host, 443, Math.min(timeoutMs, 5000))
          .then(s => cb(null, s))
          .catch(e => cb(e as Error));
      },
    });
    const url = new URL(`https://${host}${path}`);
    const headers: Record<string, string> = { "User-Agent": ZEN.ua, Authorization: `Bearer ${ZEN.bearer}` };
    if (body) headers["Content-Type"] = "application/json";
    const init: RequestInit & { agent?: unknown } = { method, headers, agent, signal: AbortSignal.timeout(timeoutMs) };
    if (body) init.body = body;
    fetch(url, init).then(r => resolve(r.status)).catch(() => resolve(null)).finally(() => { try { agent.destroy(); } catch {} });
  }
}

async function zenProbe(up: Upstream, timeoutMs: number): Promise<"clean" | "burned" | "dead"> {
  const t = timeoutMs || CONFIG.healthTimeoutMs;
  const m = await rawHttpsProbe(up, "opencode.ai", "/zen/v1/models", "GET", null, t);
  if (m === null) return "dead";
  if (m === 429) return "burned";
  const c = await rawHttpsProbe(up, "opencode.ai", "/zen/v1/chat/completions", "POST",
    JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }), t);
  if (c === null) return "dead";
  if (c === 429) return "burned";
  return "clean";
}

async function checkProxy(up: Upstream): Promise<Upstream | null> {
  const exitIP = await ipifyProbe(up, CONFIG.healthTimeoutMs);
  if (!exitIP) return null;
  const zen = await zenProbe(up, CONFIG.healthTimeoutMs);
  if (zen !== "clean") return null;
  return { ...up, exitIP };
}

// ---------- Candidate collection ----------
async function fetchCandidates(): Promise<Upstream[]> {
  const out: Upstream[] = [];
  const seen = new Set<string>();
  await Promise.all(
    CONFIG.freeListUrls.map(async (src) => {
      let type: Upstream["type"] = "http";
      if (/socks5/i.test(src)) type = "socks5";
      try {
        const res = await fetch(src, { signal: AbortSignal.timeout(12000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        let n = 0;
        for (const line of text.split(/\r?\n/)) {
          if (n >= CONFIG.perSourceLimit) break;
          const m = line.trim().match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)$/);
          if (!m) continue;
          const key = m[1] + ":" + m[2];
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ type, host: m[1], port: parseInt(m[2], 10) });
          n++;
        }
      } catch (e) {
        log(`source failed: ${src}`);
      }
    }),
  );
  log(`candidates: ${out.length}`);
  return out;
}

// ---------- Rotation ----------
async function rotate(): Promise<Upstream | null> {
  const state = getState();
  if (state.rotating) return state.active;
  state.rotating = true;
  try {
    const candidates = await fetchCandidates();
    if (candidates.length === 0) return null;
    const results: Upstream[] = [];
    for (const c of candidates) {
      const checked = await checkProxy(c);
      if (checked) results.push(checked);
      if (results.length >= 25) break;
    }
    if (results.length === 0) return null;
    state.active = results[0];
    log(`rotated to ${state.active.exitIP} via ${state.active.type}://${state.active.host}:${state.active.port}`);
    return state.active;
  } finally {
    state.rotating = false;
  }
}

// ---------- Heartbeat ----------
async function heartbeat() {
  const state = getState();
  const up = state.active;
  if (!up || getState().rotating) return;
  const zen = await zenProbe(up, 5000).catch(() => "dead" as const);
  if (zen === "clean") {
    state.active = { ...up, since: new Date().toISOString() };
    return;
  }
  log(`heartbeat: active ${up.host}:${up.port} (${up.exitIP}) is ${zen} -> rotating`);
  state.active = null;
  await rotate();
}

// ---------- Local proxy server ----------
function sanitizeHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (["proxy-connection", "proxy-authorization", "proxy-authenticate", "connection", "keep-alive", "te", "trailer", "upgrade"].includes(lk)) continue;
    out[k] = v;
  }
  out.Connection = "keep-alive";
  return out;
}

function serveRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const host = req.headers.host ? req.headers.host.split(":")[0] : null;
  if (!allowed(host)) { res.writeHead(403); res.end("not allowed"); return; }
  const url = req.url && req.url.startsWith("http") ? new URL(req.url) : null;
  const targetHost = url ? url.hostname : host;
  const targetPort = url ? url.port || (url.protocol === "https:" ? 443 : 80) : req.url?.startsWith("https://") ? 443 : 80;
  const state = getState();
  if (!state.active) { res.writeHead(503); res.end("no active proxy"); return; }
  const up = state.active;
  upstreamConnect(up, targetHost!, targetPort, CONFIG.connectTimeoutMs)
    .then(sock => {
      const outReq = http.request({ createConnection: () => sock, host: targetHost, port: targetPort, path: url ? url.pathname + url.search : req.url, method: req.method, headers: sanitizeHeaders(req.headers) }, outRes => {
        res.writeHead(outRes.statusCode || 502, outRes.headers);
        outRes.pipe(res);
      });
      outReq.on("error", e => { res.writeHead(502); res.end(e.message); });
      req.pipe(outReq);
    })
    .catch(e => { res.writeHead(502); res.end(e.message); });
}

function handleConnect(req: http.IncomingMessage, clientSock: net.Socket, head: Buffer) {
  const parts = (req.url || "").split(":");
  const host = parts[0];
  const port = parseInt(parts[1] || "443", 10);
  if (!allowed(host)) { clientSock.end(`HTTP/1.1 403 Forbidden\r\n\r\nnot allowed`); return; }
  const state = getState();
  if (!state.active) { clientSock.end(`HTTP/1.1 503 Service Unavailable\r\n\r\nno active proxy`); return; }
  upstreamConnect(state.active, host, port, CONFIG.connectTimeoutMs)
    .then(sock => {
      try {
        clientSock.write("HTTP/1.1 200 Connection established\r\n\r\n");
        if (head && head.length) sock.write(head);
        clientSock.pipe(sock);
        sock.pipe(clientSock);
        sock.on("error", () => clientSock.destroy());
        clientSock.on("error", () => sock.destroy());
      } catch (e) { sock.destroy(); clientSock.end(`HTTP/1.1 500\r\n\r\n${e}`); }
    })
    .catch(e => { clientSock.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${e.message}`); });
}

// ---------- Startup ----------
async function startProxy(port?: number): Promise<number> {
  const state = getState();
  const server = http.createServer(serveRequest);
  server.on("connect", (req, sock, head) => handleConnect(req, sock, head));
  server.on("clientError", (_e, sock) => { try { sock.destroy(); } catch {} });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port || 0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  const portNum = typeof addr === "object" && addr ? addr.port : 0;
  log(`listening on 127.0.0.1:${portNum} - rotate every ${CONFIG.rotateSeconds}s`);
  process.env.PI_PROXY_OPENCODE_ZEN = `http://127.0.0.1:${portNum}`;
  (Bun.env as Record<string, string | undefined>).PI_PROXY_OPENCODE_ZEN = `http://127.0.0.1:${portNum}`;

  await rotate().catch(e => log(`initial rotate error: ${e}`));

  setInterval(() => {
    rotate().catch(e => log(`rotate error: ${e}`));
  }, CONFIG.rotateSeconds * 1000);

  setInterval(() => {
    heartbeat().catch(e => log(`heartbeat error: ${e}`));
  }, CONFIG.heartbeatSeconds * 1000);

  return portNum;
}

export async function createOmpZenVpnProxy(): Promise<{ port: number }> {
  const port = await startProxy();
  return { port };
}

export default async function ompZenVpnExtension(_pi: unknown): Promise<void> {
  await createOmpZenVpnProxy();
}