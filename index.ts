/**
 * omp-zen-vpn — in-process rotating proxy for opencode-zen.
 *
 * Loaded as an omp extension. The first factory invocation in a process starts
 * a local HTTP CONNECT proxy on a random loopback port and points
 * PI_PROXY_OPENCODE_ZEN at it, so pi-ai tunnels every opencode-zen request
 * through this proxy (pi-ai src/utils/proxy.ts wrapFetchForProxy + Bun fetch
 * `proxy` option).
 *
 * Key design (v3, fixes "stuck burned IP"):
 * - opencode-zen free models rate limit BY EXIT IP (hard-confirmed: team member
 *   in anomalyco/opencode#10420 says "This ratelimiting is done via ip"; free
 *   models need no auth key, so IP is the only lever; burned IPs return 429 with
 *   retry-after of hours). So the pool can only contain IPs verified clean
 *   against opencode-zen itself RIGHT NOW.
 * - Every health check does an ipify reachability probe + a zen probe
 *   (models + a 1-token chat/completions). Any IP returning 429 is excluded.
 * - Every CONNECT round-robins through the clean cache, so each new connection
 *   exits through a different upstream IP. A burned IP can never stick.
 * - The heartbeat re-probes the active IP every 15s and prunes+rotates on burn
 *   (catches IPs that get burned mid-session, and dead TCP upstreams).
 * - Fully silent: no console output (keeps the omp TUI clean). Set
 *   OMP_ZEN_VPN_DEBUG=1 to see logs on stdout.
 *
 * Only node:* builtins are used. Sources match the original oc-vpn-proxy.
 */

import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

type Upstream = {
	type: "http" | "https" | "socks5" | "socks5h";
	host: string;
	port: number;
	auth?: { username: string; password: string };
	source?: string;
	exitIP?: string;
	latencyMs?: number;
	since?: string;
};

const CONFIG = {
	rotateSeconds: 180,
	connectTimeoutMs: 6000,
	healthTimeoutMs: 8000,
	healthConcurrency: 40,
	healthCheckLimit: 250,
	minWorking: 6,
	failoverCacheSize: 10,
	failoverTries: 4,
	failoverThreshold: 2,
	heartbeatSeconds: 10,
	outageRetrySeconds: 3,
	freeListUrls: [
		"https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=ipport&format=text&protocol=http",
		"https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=ipport&format=text&protocol=socks5",
		"https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
		"https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
		"https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
		"https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt",
	],
} as const;

const ALLOWLIST = [
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

const IPIFY_HTTP = "http://api.ipify.org";

/**
 * opencode-zen free models rate limit BY EXIT IP (confirmed: team member in
 * anomalyco/opencode#10420 "This ratelimiting is done via ip"; free models
 * need no auth key, so IP is the only lever). A burned IP returns 429 with a
 * retry-after of hours. So a proxy pool is only useful if every entry is
 * verified NOT burned against opencode-zen itself right now.
 */
const ZEN = {
	modelsUrl: "https://opencode.ai/zen/v1/models",
	chatUrl: "https://opencode.ai/zen/v1/chat/completions",
	ua: "opencode/1.0.0",
	bearer: "public",
};

const DEBUG = !!(Bun.env.OMP_ZEN_VPN_DEBUG || process.env.OMP_ZEN_VPN_DEBUG);

function log(msg: string): void {
	if (DEBUG) {
		try {
			console.log(`[omp-zen-vpn] ${msg}`);
		} catch {
			/* ignore */
		}
	}
}

function allowed(host: string | null | undefined): boolean {
	const h = String(host || "").toLowerCase();
	if (!h) return false;
	for (const d of ALLOWLIST) {
		if (h === d || h.endsWith("." + d)) return true;
	}
	return false;
}

function ts(): string {
	return new Date().toISOString();
}

interface State {
	active: Upstream | null;
	pool: Upstream[];
	workingCache: Upstream[];
	activeFailures: number;
	rotating: boolean;
	outage: boolean;
	rotCount: number;
	activeConnections: number;
	rotationIndex: number;
	burnedCooldown: Map<string, number>;
}

const STATE_GLOBAL_KEY = "__ompZenVpnState";

interface Singleton {
	state: State;
	started: boolean;
	server: http.Server | null;
	port: number;
}

function getSingleton(): Singleton {
	const g = globalThis as unknown as Record<string, Singleton | undefined>;
	if (!g[STATE_GLOBAL_KEY]) {
		g[STATE_GLOBAL_KEY] = {
			state: {
				active: null,
				pool: [],
				workingCache: [],
				activeFailures: 0,
				rotating: false,
				outage: false,
				rotCount: 0,
				activeConnections: 0,
				rotationIndex: 0,
				burnedCooldown: new Map<string, number>(),
			},
			started: false,
			server: null,
			port: 0,
		};
	}
	return g[STATE_GLOBAL_KEY] as Singleton;
}

// ---------------------------------------------------------------------------
// Upstream proxy clients
// ---------------------------------------------------------------------------

function upstreamConnect(up: Upstream, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const sock = net.connect({ host: up.host, port: up.port });
		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.destroy();
			reject(err);
		};
		const timer = setTimeout(() => fail(new Error("upstream connect timeout")), timeoutMs || CONFIG.connectTimeoutMs);
		sock.once("error", fail);

		const done = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			sock.removeListener("error", fail);
			resolve(sock);
		};

		if (up.type === "socks5" || up.type === "socks5h") {
			const auth = up.auth ? up.auth : null;
			let buf = Buffer.alloc(0);
			const write = (b: Uint8Array) => {
				if (!sock.destroyed) sock.write(b as any);
			};
			const sendMethods = () => {
				if (auth) {
					write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
				} else {
					write(Buffer.from([0x05, 0x01, 0x00]));
				}
			};
			let stage = 0;
			const onData = (chunk: Buffer) => {
				buf = Buffer.concat([buf, chunk]);
				try {
					if (stage === 0) {
						if (buf.length < 2) return;
						const ver = buf[0];
						const method = buf[1];
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
						let len: number;
						if (atyp === 0x01) len = 4 + 2;
						else if (atyp === 0x03) len = 1 + buf[4] + 2;
						else if (atyp === 0x04) len = 16 + 2;
						else throw new Error("socks5: bad atyp");
						if (buf.length < 4 + len) return;
						sock.removeListener("data", onData);
						done();
					}
				} catch (e) {
					fail(e as Error);
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
				const statusLine = head.split("\r\n")[0];
				const m = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
				if (!m) return fail(new Error("http proxy: bad response"));
				const code = parseInt(m[1], 10);
				if (code >= 200 && code < 300) {
					sock.removeListener("data", onData);
					if (buf.length > idx + 4) sock.unshift(buf.subarray(idx + 4));
					done();
				} else if (code === 407) {
					fail(new Error("http proxy: authentication failed (407)"));
				} else {
					fail(new Error(`http proxy: CONNECT rejected ${code}`));
				}
			};
			sock.on("data", onData);
		} else {
			fail(new Error(`unknown upstream type: ${up.type}`));
		}
	});
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function ipifyProbe(up: Upstream, timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		const t0 = Date.now();
		const url = new URL(IPIFY_HTTP);
		const port = url.port || (url.protocol === "https:" ? 443 : 80);
		let sock: net.Socket;
		try {
			sock = upstreamConnect(up, url.hostname, parseInt(port as string, 10), timeoutMs || CONFIG.healthTimeoutMs);
		} catch (e) {
			return resolve(null);
		}
		Promise.resolve(sock)
			.then((s) => {
				const req = `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\nUser-Agent: omp-zen-vpn/1.0\r\n\r\n`;
				s.write(req);
				let data = "";
				let done = false;
				const finish = (exitIP: string | null) => {
					if (done) return;
					done = true;
					setTimeout(() => { try { s.destroy(); } catch { /* */ } }, 0);
					resolve(exitIP);
				};
				s.on("data", (c) => {
					data += c.toString("latin1");
					const m = data.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
					if (m && data.includes("\r\n\r\n")) finish(m[1]);
				});
				s.on("error", () => finish(null));
				s.on("close", () => finish(null));
				setTimeout(() => finish(null), timeoutMs || CONFIG.healthTimeoutMs);
			})
			.catch(() => resolve(null));
	});
}

/**
 * HTTPS GET/POST to opencode-zen THROUGH an upstream proxy. We supply the raw
 * CONNECT tunnel (via upstreamConnect, which handles http & socks5) through the
 * https.Agent `connect` callback, and use `fetch` (the only path Bun tunnels
 * reliably on — fetch({proxy}) only supports http proxies, tls.connect({socket})
 * ignores the pre-built tunnel, and https.request({agent}) fails to tunnel).
 *
 * TLS is validated strictly (rejectUnauthorized). Many free proxies MITM TLS
 * with an untrusted cert — those are rejected so the client's real request
 * through them doesn't fail with "unable to verify the first certificate".
 * Returns the HTTP status code, or null on connection/TLS/cert error.
 */
function rawHttpsProbe(
	up: Upstream,
	host: string,
	path: string,
	method: "GET" | "POST",
	body: string | null,
	timeoutMs: number,
): Promise<number | null> {
	return new Promise((resolve) => {
		const agent = new https.Agent({
			keepAlive: false,
			rejectUnauthorized: true,
			connect: (opts: unknown, cb: (err: Error | null, sock?: net.Socket) => void) => {
				try {
					const t = Math.min(timeoutMs, 5000);
					const sockPromise = upstreamConnect(up, host, 443, t);
					Promise.resolve(sockPromise)
						.then((s) => cb(null, s))
						.catch((e) => cb(e as Error));
				} catch (e) {
					cb(e as Error);
				}
			},
		});
		const url = new URL(`https://${host}${path}`);
		const headers: Record<string, string> = {
			"User-Agent": ZEN.ua,
			Authorization: `Bearer ${ZEN.bearer}`,
		};
		if (body) headers["Content-Type"] = "application/json";
		const init: RequestInit & { agent?: unknown } = {
			method,
			headers,
			agent,
			signal: AbortSignal.timeout(timeoutMs),
		};
		if (body) init.body = body;
		fetch(url, init)
			.then((r) => resolve(r.status))
			.catch(() => resolve(null))
			.finally(() => {
				try {
					agent.destroy();
				} catch {
					/* ignore */
				}
			});
	});
}

/**
 * Probe an upstream exit IP against opencode-zen itself. Free Zen models are
 * rate-limited by exit IP and emit 429 (with retry-after of hours) once burned.
 * An IP that is currently burned must be excluded. We probe the models endpoint
 * (GET) and a 1-token chat (POST) — the real usage path.
 */
async function zenProbe(up: Upstream, timeoutMs: number): Promise<"clean" | "burned" | "dead"> {
	const t = timeoutMs || CONFIG.healthTimeoutMs;
	const m = await rawHttpsProbe(up, "opencode.ai", "/zen/v1/models", "GET", null, t);
	if (m === null) return "dead";
	if (m === 429) return "burned";
	const c = await rawHttpsProbe(
		up,
		"opencode.ai",
		"/zen/v1/chat/completions",
		"POST",
		JSON.stringify({ model: "deepseek-v4-flash-free", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
		t,
	);
	if (c === null) return "dead";
	if (c === 429) return "burned";
	return "clean";
}

async function checkProxy(up: Upstream, timeoutMs: number, state: State): Promise<Upstream | null> {
	const t0 = Date.now();
	const exitIP = await ipifyProbe(up, timeoutMs);
	if (!exitIP) return null;
	const zen = await zenProbe(up, timeoutMs);
	if (zen !== "clean") {
		// A burned IP (429) stays burned for hours at opencode-zen. Remember it
		// so rotation stops re-probing / re-adding it for a cooldown window.
		if (zen === "burned") {
			state.burnedCooldown.set(`${up.host}:${up.port}`, Date.now() + 60 * 60 * 1000);
		}
		log(`[pool] ${up.type}://${up.host}:${up.port} exit=${exitIP} -> ${zen} (excluded)`);
		return null;
	}
	const latencyMs = Date.now() - t0;
	return { ...up, exitIP, latencyMs };
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

async function fetchFreeList(): Promise<Upstream[]> {
	const out: Upstream[] = [];
	const seen = new Set<string>();
	await Promise.all(
		CONFIG.freeListUrls.map(async (src) => {
			let url = src;
			let type: Upstream["type"] = "http";
			if (/socks5/i.test(src)) type = "socks5";
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
				log(`[pool] source failed: ${url} (${(e as Error).message})`);
			}
		}),
	);
	log(`[pool] merged free pool: ${out.length} unique proxies from ${CONFIG.freeListUrls.length} sources`);
	return out;
}

async function collectCandidates(): Promise<Upstream[]> {
	return fetchFreeList();
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

async function rotate(state: State, force: boolean): Promise<boolean> {
	if (state.rotating) {
		return false;
	}
		state.rotating = true;
		try {
			log("[pool] collecting candidates...");
			const candidates = await collectCandidates();
			state.pool = candidates;
			if (candidates.length === 0) {
				state.outage = true;
				log("[pool] no candidates available (internet down?) - outage mode");
				return false;
			}

			// Drop expired burned-IP cooldowns so they can be retried later.
			const now = Date.now();
			for (const [k, exp] of state.burnedCooldown) {
				if (exp <= now) state.burnedCooldown.delete(k);
			}

			const sample =
				candidates.length > CONFIG.healthCheckLimit
					? [...candidates].sort(() => Math.random() - 0.5).slice(0, CONFIG.healthCheckLimit)
					: candidates;
			const results: Upstream[] = [];
			const alivePool: Upstream[] = [];
			const seenIPs = new Set<string>();
			let idx = 0;
			let done = false;
			async function worker() {
				while (!done && idx < sample.length) {
					const c = sample[idx++];
					const key = `${c.host}:${c.port}`;
					if (state.burnedCooldown.has(key)) continue;
					const ip = await ipifyProbe(c, CONFIG.healthTimeoutMs);
					if (!ip) continue;
					const aliveUp: Upstream = { ...c, exitIP: ip, latencyMs: 0 };
					alivePool.push(aliveUp);
					const r = await checkProxy(c, CONFIG.healthTimeoutMs, state);
					if (r && !done) {
						if (!seenIPs.has(r.exitIP as string)) {
							seenIPs.add(r.exitIP as string);
							results.push(r);
						}
						if (results.length >= CONFIG.failoverCacheSize) done = true;
					}
				}
			}
			const workers: Promise<void>[] = [];
			for (let i = 0; i < Math.min(CONFIG.healthConcurrency, sample.length); i++) workers.push(worker());
			await Promise.all(workers);

			if (results.length > 0) {
				state.workingCache = results
					.sort((a, b) => (a.latencyMs as number) - (b.latencyMs as number))
					.slice(0, CONFIG.failoverCacheSize)
					.map((r) => ({ ...r }));
				state.rotationIndex = Math.floor(Math.random() * state.workingCache.length);
			}

			if (results.length === 0) {
				// GUARANTEE: never leave the cache empty (which earlier caused an
				// infinite "Working..." hold). Fall back to any alive proxy so a
				// request at least attempts instead of hanging forever.
				if (alivePool.length > 0) {
					state.workingCache = alivePool
						.slice(0, CONFIG.failoverCacheSize)
						.sort(() => Math.random() - 0.5)
						.map((r) => ({ ...r }));
					state.rotationIndex = Math.floor(Math.random() * state.workingCache.length);
					state.outage = false;
					state.activeFailures = 0;
					if (!state.active && state.workingCache.length > 0) {
						state.active = { ...state.workingCache[0], since: ts() };
						state.rotCount++;
						log(`[rotate] initial ${state.active.exitIP} via ${state.active.type}://${state.active.host}:${state.active.port} (DEGRADED: no zen-verified pool)`);
					}
					log(`[pool] no zen-clean proxies - using ${state.workingCache.length} alive (unverified) proxies as fallback`);
					return true;
				}
				state.outage = true;
				log("[pool] no working proxies found - outage mode: keeping previous cache");
				return false;
			}

		state.outage = false;
		state.activeFailures = 0;

		if (!state.active && state.workingCache.length > 0) {
			state.active = { ...state.workingCache[0], since: ts() };
			state.rotCount++;
			log(`[rotate] initial ${state.active.exitIP} via ${state.active.type}://${state.active.host}:${state.active.port}`);
		}
		return true;
	} finally {
		state.rotating = false;
	}
}

// ---------------------------------------------------------------------------
// Failover / per-request round-robin
// ---------------------------------------------------------------------------

function triggerFailoverRotate(state: State): void {
	if (state.activeFailures >= CONFIG.failoverThreshold && !state.rotating) {
		log(`[failover] ${state.activeFailures} consecutive failures - forcing rotation`);
		rotate(state, false).catch((e) => log(`[failover] rotation error: ${(e as Error).message}`));
	}
}

/**
 * Build the connection chain for ONE request: round-robin start index into the
 * working cache, so consecutive requests exit through different IPs. A
 * rate-limited exit IP can never stick beyond its own request.
 */
function buildChain(state: State): Upstream[] {
	const cache = state.workingCache;
	if (cache.length === 0) {
		return state.active ? [state.active] : [];
	}
	const start = state.rotationIndex % cache.length;
	state.rotationIndex++;
	const chain: Upstream[] = [];
	for (let i = 0; i < cache.length; i++) {
		const up = cache[(start + i) % cache.length];
		if (up) chain.push(up);
		if (chain.length >= CONFIG.failoverTries) break;
	}
	return chain;
}

function pruneUpstream(state: State, up: Upstream): void {
	const idx = state.workingCache.findIndex((w) => w.host === up.host && w.port === up.port);
	if (idx >= 0) state.workingCache.splice(idx, 1);
	if (state.active && state.active.host === up.host && state.active.port === up.port) state.active = null;
	log(`[failover] dead upstream pruned: ${up.host}:${up.port}`);
}

function connectWithFailover(state: State, host: string, port: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const chain = buildChain(state);
			if (chain.length === 0) {
				// No upstream at all: hold and retry while an outage/startup
				// rotation is in progress (no timeout - the session freezes until
				// a working proxy is found).
				if (state.outage || state.rotating || !state.active) {
					setTimeout(attempt, 1000);
					return;
				}
				reject(new Error("no upstream available yet"));
				return;
			}
			let i = 0;
			const tryNext = () => {
				if (i >= chain.length) {
					state.activeFailures++;
					if (state.outage) {
						log(`[outage] holding request to ${host}:${port} - retrying`);
						setTimeout(attempt, 1000);
						return;
					}
					triggerFailoverRotate(state);
					reject(new Error("all upstreams failed"));
					return;
				}
				const up = chain[i++];
				const t = Math.min(CONFIG.connectTimeoutMs, 3000);
				upstreamConnect(up, host, port, t)
					.then((sock) => {
						state.activeFailures = 0;
						state.active = { ...up, since: ts() };
						resolve(sock);
					})
					.catch(() => {
						pruneUpstream(state, up);
						tryNext();
					});
			};
			tryNext();
		};
		attempt();
	});
}

async function heartbeat(state: State): Promise<void> {
	const up = state.active;
	if (!up || state.rotating || state.outage) return;
	// The free Zen rate limit is BY EXIT IP: an active IP can get burned
	// mid-session. Re-probe it against opencode-zen; prune + rotate on burn.
	const zen = await zenProbe(up, 5000).catch(() => "dead" as const);
	if (zen === "clean") {
		state.active = { ...up, since: ts() };
		return;
	}
	log(`[heartbeat] active ${up.host}:${up.port} (exit ${up.exitIP}) is ${zen} - pruning and rotating`);
	pruneUpstream(state, up);
	rotate(state, false).catch((e) => log(`[heartbeat] rotation error: ${(e as Error).message}`));
}

// ---------------------------------------------------------------------------
// Local proxy server
// ---------------------------------------------------------------------------

function sanitizeHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
	const out: http.OutgoingHttpHeaders = {};
	for (const [k, v] of Object.entries(headers)) {
		const lk = k.toLowerCase();
		if (
			["proxy-connection", "proxy-authorization", "proxy-authenticate", "connection", "keep-alive", "te", "trailer", "upgrade"].includes(lk)
		) {
			continue;
		}
		out[k] = v;
	}
	out.Connection = "keep-alive";
	return out;
}

function serveRequest(state: State, req: http.IncomingMessage, res: http.ServerResponse): void {
	try {
		const up = state.active;
		const host = req.headers.host ? req.headers.host.split(":")[0] : null;
		log(`[conn] ${req.method} ${req.url} (host ${host}) via ${up ? up.type + "://" + up.host + ":" + up.port + " (exit " + up.exitIP + ")" : "failover chain"}`);
		if (!allowed(host)) {
			res.writeHead(403, { "content-type": "text/plain" });
			res.end(`omp-zen-vpn: destination ${host} is not in the allowlist`);
			return;
		}
		const url = req.url && req.url.startsWith("http") ? new URL(req.url) : null;
		const targetHost = url ? url.hostname : host;
		const targetPort = url ? url.port || (url.protocol === "https:" ? 443 : 80) : req.url?.startsWith("https://") ? 443 : 80;

		state.activeConnections++;
		connectWithFailover(state, targetHost as string, parseInt(targetPort as string, 10))
			.then((sock) => {
				const outReq = http.request(
					{
						createConnection: () => sock,
						host: targetHost,
						port: parseInt(targetPort as string, 10),
						path: url ? url.pathname + url.search : req.url,
						method: req.method,
						headers: sanitizeHeaders(req.headers),
					},
					(outRes) => {
						res.writeHead(outRes.statusCode || 502, outRes.headers);
						outRes.pipe(res);
					},
				);
				outReq.on("error", (e) => {
					res.writeHead(502, { "content-type": "text/plain" });
					res.end(`omp-zen-vpn: upstream error: ${(e as Error).message}`);
				});
				req.pipe(outReq);
				res.on("finish", () => state.activeConnections--);
				res.on("close", () => state.activeConnections--);
				req.on("close", () => state.activeConnections--);
			})
			.catch((e) => {
				res.writeHead(502, { "content-type": "text/plain" });
				res.end(`omp-zen-vpn: cannot reach upstream: ${(e as Error).message}`);
				state.activeConnections--;
			});
	} catch (e) {
		res.writeHead(500, { "content-type": "text/plain" });
		res.end(`omp-zen-vpn: internal error: ${(e as Error).message}`);
		state.activeConnections--;
	}
}

function safeEnd(sock: net.Socket, data: string): void {
	try {
		if (sock && !sock.destroyed) sock.end(data);
	} catch {
		try {
			sock.destroy();
		} catch {
			/* ignore */
		}
	}
}

function handleConnect(state: State, req: http.IncomingMessage, clientSock: net.Socket, head: Buffer): void {
	try {
		const up = state.active;
		const parts = (req.url || "").split(":");
		const host = parts[0];
		const portStr = parts[1];
		log(`[conn] CONNECT ${host}:${portStr} via ${up ? up.type + "://" + up.host + ":" + up.port + " (exit " + up.exitIP + ")" : "failover chain"}`);
		if (!allowed(host)) {
			safeEnd(clientSock, `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nomp-zen-vpn: destination ${host} is not in the allowlist`);
			return;
		}
		const port = parseInt(portStr || "443", 10);
		state.activeConnections++;
		connectWithFailover(state, host, port)
			.then((sock) => {
				try {
					clientSock.write("HTTP/1.1 200 Connection established\r\n\r\n");
					if (head && head.length) sock.write(head);
					clientSock.pipe(sock);
					sock.pipe(clientSock);
					sock.on("error", () => clientSock.destroy());
					clientSock.on("error", () => sock.destroy());
					clientSock.on("close", () => state.activeConnections--);
					sock.on("close", () => state.activeConnections--);
				} catch (e) {
					sock.destroy();
					safeEnd(clientSock, `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\n${(e as Error).message}`);
					state.activeConnections--;
				}
			})
			.catch((e) => {
				safeEnd(clientSock, `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\n\r\nomp-zen-vpn: upstream error: ${(e as Error).message}`);
				state.activeConnections--;
			});
	} catch (e) {
		safeEnd(clientSock, `HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\n\r\n${(e as Error).message}`);
		state.activeConnections--;
	}
}

async function startProxy(singleton: Singleton): Promise<number> {
	const state = singleton.state;
	const server = http.createServer((req, res) => {
		if (req.method === "GET" && req.url === "/status") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify(
					{
						updatedAt: ts(),
						port: singleton.port,
						rotateSeconds: CONFIG.rotateSeconds,
						active: state.active,
						poolSize: state.pool.length,
						backups: state.workingCache.map((b) => ({
							host: b.host,
							port: b.port,
							exitIP: b.exitIP,
							latencyMs: b.latencyMs,
						})),
						activeFailures: state.activeFailures,
						rotations: state.rotCount,
						outage: state.outage,
					},
					null,
					2,
				),
			);
			return;
		}
		serveRequest(state, req, res);
	});
	server.on("connect", (req, clientSock, head) => handleConnect(state, req, clientSock, head));
	server.on("clientError", (_err, socket) => {
		try {
			socket.destroy();
		} catch {
			/* ignore */
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	singleton.server = server;
	singleton.port = port;
	return port;
}

// ---------------------------------------------------------------------------
// Background loops
// ---------------------------------------------------------------------------

function startBackgroundLoops(singleton: Singleton): void {
	const state = singleton.state;

	(async () => {
		await rotate(state, false).catch((e) => log(`[rotate] error: ${(e as Error).message}`));
		const normal = Math.max(10, CONFIG.rotateSeconds) * 1000;
		const retry = Math.max(2, CONFIG.outageRetrySeconds) * 1000;
		(async function rotationLoop() {
			await rotate(state, false).catch((e) => log(`[rotate] error: ${(e as Error).message}`));
			setTimeout(rotationLoop, state.outage ? retry : normal);
		})();
	})();

	if (CONFIG.heartbeatSeconds > 0) {
		const hb = Math.max(5, CONFIG.heartbeatSeconds) * 1000;
		setInterval(() => {
			heartbeat(state).catch((e) => log(`[heartbeat] error: ${(e as Error).message}`));
		}, hb);
	}
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export function createOmpZenVpnProxy(): Promise<{ port: number }> {
	const singleton = getSingleton();
	if (singleton.started) {
		return Promise.resolve({ port: singleton.port });
	}

	return (async () => {
		const port = await startProxy(singleton);
		process.env.PI_PROXY_OPENCODE_ZEN = `http://127.0.0.1:${port}`;
		(Bun.env as Record<string, string | undefined>).PI_PROXY_OPENCODE_ZEN = `http://127.0.0.1:${port}`;
		singleton.started = true;
		log(`listening on 127.0.0.1:${port} - rotate every ${CONFIG.rotateSeconds}s`);
		startBackgroundLoops(singleton);
		return { port };
	})();
}

export default async function ompZenVpnExtension(_pi: unknown): Promise<void> {
	await createOmpZenVpnProxy();
}