// api/check.js
// Tungston DevKit: Reachability & Uptime Engine
// Multi-layer SSRF validation, DNS rebinding prevention, 60s cache, Groq diagnosis.

const dns = require("dns").promises;

// ---------- Rate Limiter ----------
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 25;
const requestLog = new Map(); // ip -> [timestamps]

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestLog.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  if (requestLog.size > 2000) {
    for (const [k, v] of requestLog.entries()) {
      const active = v.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
      if (active.length) requestLog.set(k, active);
      else requestLog.delete(k);
    }
  }
  return false;
}

// ---------- 60s Response Cache ----------
const CACHE_TTL_MS = 60_000;
const checkCache = new Map(); // urlString -> { data, timestamp }

function getCached(url) {
  const hit = checkCache.get(url);
  if (hit && Date.now() - hit.timestamp < CACHE_TTL_MS) {
    return hit.data;
  }
  return null;
}

function setCached(url, data) {
  checkCache.set(url, { data, timestamp: Date.now() });
  if (checkCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of checkCache.entries()) {
      if (now - v.timestamp >= CACHE_TTL_MS) checkCache.delete(k);
    }
  }
}

// ---------- Strict SSRF Protection ----------
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "[::1]",
  "::1",
]);

function isPrivateIp(ip) {
  // IPv4 private & reserved ranges
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
    return false;
  }
  // IPv6 private & reserved ranges
  const lower = ip.toLowerCase();
  if (lower === "::1") return true; // loopback
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local fc00::/7
  if (lower.startsWith("fe80")) return true; // link-local
  return false;
}

async function assertUrlIsSafe(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL syntax.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http:// and https:// URLs are allowed.");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("Loopback and local addresses are blocked.");
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("DNS resolution failed for hostname.");
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error("Host resolves to a private/internal network IP.");
    }
  }

  return { parsed, primaryIp: addresses[0]?.address || "unknown" };
}

// ---------- Safe Reachability Check ----------
async function checkReachability(initialUrl) {
  let currentUrl = initialUrl;
  let hops = 0;
  const maxHops = 3;
  const start = Date.now();
  let serverHeader = "Unknown";

  while (hops <= maxHops) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);

    try {
      let response = await fetch(currentUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Tungston-DevKit-Uptime/1.0" },
      });

      if (response.status === 405 || response.status === 501) {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "Tungston-DevKit-Uptime/1.0" },
        });
      }

      clearTimeout(timeout);
      serverHeader = response.headers.get("server") || response.headers.get("x-powered-by") || "Protected";

      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (location && hops < maxHops) {
          const nextUrl = new URL(location, currentUrl).toString();
          await assertUrlIsSafe(nextUrl);
          currentUrl = nextUrl;
          hops++;
          continue;
        }
      }

      return {
        reachable: response.ok || (response.status >= 200 && response.status < 400),
        statusCode: response.status,
        latencyMs: Date.now() - start,
        server: serverHeader,
      };
    } catch (err) {
      clearTimeout(timeout);
      return {
        reachable: false,
        statusCode: null,
        latencyMs: Date.now() - start,
        server: serverHeader,
        error: err.name === "AbortError" ? "Connection timed out (7s)" : err.message,
      };
    }
  }

  return {
    reachable: false,
    statusCode: null,
    latencyMs: Date.now() - start,
    server: serverHeader,
    error: "Exceeded redirect limit (3 hops).",
  };
}

// ---------- Groq AI Diagnostic Summary ----------
async function getAiSummary(url, result) {
  if (!process.env.GROQ_API_KEY) return null;

  const prompt = `A website reachability check ran.
URL: ${url}
Reachable: ${result.reachable}
HTTP Status Code: ${result.statusCode ?? "None"}
Latency: ${result.latencyMs}ms
Error: ${result.error ?? "None"}

Provide ONE short, direct sentence (maximum 20 words) explaining what this means in plain developer English. No markdown, no filler.`;

  const models = ["openai/gpt-oss-20b", "qwen/qwen3.8-27b", "openai/gpt-oss-120b"];

  for (const m of models) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: m,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 60,
          temperature: 0.3,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!res.ok) continue;
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (content) return content;
    } catch {
      clearTimeout(timeout);
    }
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=120");

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Use GET or POST." });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Rate limit reached. Please wait a minute." });
  }

  let rawUrl = "";
  if (req.method === "GET") {
    rawUrl = (req.query?.url ? String(req.query.url) : "").trim();
  } else {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    rawUrl = (body && body.url ? String(body.url) : "").trim();
  }

  if (!rawUrl) {
    return res.status(400).json({ error: "Please provide a target URL." });
  }

  const candidate = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

  let safeUrlObj;
  try {
    safeUrlObj = await assertUrlIsSafe(candidate);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const urlKey = safeUrlObj.parsed.toString();
  const cached = getCached(urlKey);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.status(200).json(cached);
  }

  const result = await checkReachability(urlKey);
  const aiSummary = await getAiSummary(urlKey, result);

  const payload = {
    url: urlKey,
    resolvedIp: safeUrlObj.primaryIp,
    ...result,
    aiSummary,
    timestamp: Date.now(),
  };

  setCached(urlKey, payload);
  res.setHeader("X-Cache", "MISS");
  return res.status(200).json(payload);
};
