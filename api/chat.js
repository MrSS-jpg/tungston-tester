const MODELS = [
  { ids: ['nvidia/nemotron-3-ultra-550b-a55b'], name: 'Nemotron 3 Ultra', vendor: 'NVIDIA', type: 'Reasoning', params: '550B MoE / 55B active', context: '1M' },
  { ids: ['moonshotai/kimi-k3'], name: 'Kimi K3', vendor: 'Moonshot AI', type: 'Multimodal MoE', params: '~2.8T MoE', context: '1.0M' },
  { ids: ['z-ai/glm-5.3'], name: 'GLM 5.3', vendor: 'Z.ai', type: 'Reasoning', params: '753B MoE' },
  { ids: ['z-ai/glm-5.3-flash'], name: 'GLM 5.3 Flash', vendor: 'Z.ai', type: 'Multimodal MoE', params: '320B MoE / 18B active' },
  { ids: ['nvidia/deepseek-v4.1-flash', 'deepseek-ai/deepseek-v4.1-flash'], name: 'DeepSeek V4.1 Flash', vendor: 'DeepSeek AI', type: 'Multimodal MoE', params: '552B MoE / 8B active' },
  { ids: ['nvidia/nemotron-3.5-lightning-30b-a3b'], name: 'Nemotron 3.5 Lightning', vendor: 'NVIDIA', type: 'Agentic', params: '30B MoE / 3B active' },
  { ids: ['meta/muse-glimmer-30b'], name: 'Muse Glimmer 30B', vendor: 'Meta', type: 'Multimodal reasoning', params: '30B' },
  { ids: ['poolside/laguna-xs-2.1'], name: 'Laguna XS 2.1', vendor: 'Poolside', type: 'Agentic coding', params: '33B MoE' },
  { ids: ['google/diffusiongemma-26b-a4b-it'], name: 'DiffusionGemma 26B', vendor: 'Google', type: 'Diffusion LLM', params: '26B' },
  { ids: ['nvidia/riva-translate-4b-instruct-v2'], name: 'Riva Translate 4B', vendor: 'NVIDIA', type: 'Translation', params: '4B' }
];

const BASE = 'https://integrate.api.nvidia.com/v1';
const LIMIT = parseInt(process.env.RATE_LIMIT || '4', 10);
const WINDOW = parseInt(process.env.RATE_WINDOW_MIN || '60', 10) * 60000;
const ALLOWED = new Set(MODELS.flatMap((m) => m.ids));
const hits = new Map();
let catalog = { at: 0, ids: null };

function clientIp(req) {
  const f = req.headers['x-forwarded-for'];
  return (f ? String(f).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

function active(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW);
  if (arr.length) hits.set(ip, arr);
  else hits.delete(ip);
  return arr;
}

function sweep() {
  if (hits.size < 5000) return;
  for (const ip of hits.keys()) active(ip);
}

function setUsage(res, ip) {
  res.setHeader('x-rl-used', String(active(ip).length));
  res.setHeader('x-rl-limit', String(LIMIT));
}

function fail(res, ip, status, code, error, extra) {
  setUsage(res, ip);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(Object.assign({ code, error }, extra || {})));
}

async function getCatalog(key) {
  if (catalog.ids && Date.now() - catalog.at < 600000) return catalog.ids;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(BASE + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal });
    if (!r.ok) return catalog.ids;
    const j = await r.json();
    catalog = { at: Date.now(), ids: new Set((j.data || []).map((m) => m.id)) };
    return catalog.ids;
  } catch (e) {
    return catalog.ids;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const ip = clientIp(req);
  const key = process.env.NVIDIA_API_KEY || process.env.NVIDIA_NIM_API_KEY;
  sweep();

  if (!key) return fail(res, ip, 500, 'NO_KEY', 'Server is missing NVIDIA_API_KEY or NVIDIA_NIM_API_KEY.');

  if (req.method === 'GET') {
    const ids = await getCatalog(key);
    const models = [];
    for (const m of MODELS) {
      const id = ids ? m.ids.find((x) => ids.has(x)) : m.ids[0];
      if (!id) continue;
      models.push({ id, name: m.name, vendor: m.vendor, type: m.type, params: m.params, context: m.context || null, verified: !!ids });
    }
    setUsage(res, ip);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ limit: LIMIT, used: active(ip).length, windowMin: WINDOW / 60000, models }));
  }

  if (req.method !== 'POST') return fail(res, ip, 405, 'METHOD', 'Method not allowed.');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const model = body.model;
  const messages = body.messages;
  let temperature = Number(body.temperature);
  if (!Number.isFinite(temperature)) temperature = 0.7;
  temperature = Math.min(1, Math.max(0, temperature));

  if (!ALLOWED.has(model)) return fail(res, ip, 400, 'BAD_MODEL', 'Unknown model.');
  if (!Array.isArray(messages) || !messages.length || messages.length > 20) return fail(res, ip, 400, 'BAD_INPUT', 'Send between 1 and 20 messages.');
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim() || m.content.length > 8000) {
      return fail(res, ip, 400, 'BAD_INPUT', 'Each message needs a role and text up to 8000 characters.');
    }
  }

  const used = active(ip);
  if (used.length >= LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((used[0] + WINDOW - Date.now()) / 1000));
    return fail(res, ip, 429, 'QUOTA', 'Request limit reached.', { retryAfter });
  }
  used.push(Date.now());
  hits.set(ip, used);
  const refund = () => {
    const arr = hits.get(ip);
    if (arr && arr.length) arr.pop();
  };

  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());
  const timer = setTimeout(() => ctrl.abort(), 50000);
  let upstream;
  try {
    upstream = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature,
        max_tokens: 2048,
        stream: true
      }),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    refund();
    return fail(res, ip, 504, 'TIMEOUT', 'Model did not respond in time.');
  }
  clearTimeout(timer);

  if (upstream.status === 202) {
    refund();
    return fail(res, ip, 503, 'MODEL_ERROR', 'Model queued the request. Try again in a moment.');
  }
  if (!upstream.ok) {
    refund();
    if (upstream.status === 401 || upstream.status === 403) return fail(res, ip, 502, 'NO_KEY', 'Server API key was rejected.');
    if (upstream.status === 404) return fail(res, ip, 502, 'MODEL_UNAVAILABLE', 'Model is not available on the free endpoint right now.');
    if (upstream.status === 429) return fail(res, ip, 503, 'UPSTREAM_BUSY', 'NVIDIA is rate limiting the shared key. Try again shortly.');
    return fail(res, ip, 502, 'MODEL_ERROR', 'Model returned an error (' + upstream.status + ').');
  }

  setUsage(res, ip);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } catch (e) {
    res.write('data: ' + JSON.stringify({ error: { message: 'Stream interrupted.' } }) + '\n\n');
  }
  res.end();
};
