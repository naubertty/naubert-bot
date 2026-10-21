#!/usr/bin/env node
/* naubert-bot · server.js
 *
 * Servidor local sem dependências:
 *   - serve a página (index.html, assets/)
 *   - faz proxy das chamadas para o OpenRouter e para a Anthropic, mantendo as
 *     chaves no processo do servidor em vez de expô-las no navegador
 *
 * Node 18+ (usa fetch global).
 *
 * Uso:
 *   cp .env.example .env      # e preencha OPENROUTER_API_KEY
 *   npm start                 # http://localhost:8787
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------- env */

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

// O .env é lido da pasta do server.js — não do diretório em que o terminal está.
const ENV_FILE = path.join(__dirname, '.env');
const ENV_FOUND = loadDotEnv(ENV_FILE);

// Quem extrai o ZIP duas vezes acaba com uma pasta dentro da outra e deixa o
// .env no nível de cima. Em vez de falhar em silêncio, procuramos um .env
// vizinho só para dar a dica certa no terminal.
function envHint() {
  let dir = __dirname;
  for (let i = 0; i < 2; i += 1) {
    dir = path.dirname(dir);
    const candidate = path.join(dir, '.env');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

// O texto de exemplo do .env.example passa por chave preenchida: vale avisar.
function looksPlaceholder(value) {
  const v = String(value || '').trim();
  return !v || /\.\.\.|…|<.*>|^sua[-_ ]?chave$/i.test(v);
}

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_REFERER = process.env.OPENROUTER_REFERER || '';
const OPENROUTER_TITLE = process.env.OPENROUTER_TITLE || 'naubert-bot';
const OPENROUTER_BASE = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const UPSTREAM_TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT || 180000);

const ROOT = __dirname;
const MAX_BODY = 8 * 1024 * 1024;

/* ------------------------------------------------------------------ util */

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function apiError(res, status, type, message) {
  json(res, status, { type: 'error', error: { type, message } });
}

function maskKey(key) {
  if (!key) return '';
  if (key.length < 12) return '••••';
  return key.slice(0, 7) + '…' + key.slice(-4);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Corpo da requisição grande demais.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------- rate limit */

const buckets = new Map();
const RATE_WINDOW = 60_000;
const RATE_MAX = Number(process.env.RATE_MAX || 90);

function rateLimited(ip) {
  const now = Date.now();
  const list = (buckets.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  list.push(now);
  buckets.set(ip, list);
  if (buckets.size > 5000) buckets.clear();
  return list.length > RATE_MAX;
}

/* ------------------------------------------------------------------- cors */

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const ok =
    ALLOWED_ORIGINS.includes(origin) ||
    origin === 'null' ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    /^https:\/\/[a-z0-9-]+\.e2b\.app$/.test(origin);
  if (!ok) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-proxy-token, anthropic-version, anthropic-beta',
    'access-control-max-age': '600',
    vary: 'origin',
  };
}

function checkToken(req) {
  if (!PROXY_TOKEN) return true;
  return req.headers['x-proxy-token'] === PROXY_TOKEN;
}

/* ----------------------------------------------------------------- static */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // bloqueia traversal e arquivos internos
  const target = path.normalize(path.join(ROOT, rel));
  const inside = target === ROOT || target.startsWith(ROOT + path.sep);
  const blocked = /(^|\/)(\.env|\.git|node_modules|test)(\/|$)/.test(rel);
  if (!inside || blocked) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 — não encontrado');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': ext === '.html' ? 'no-store' : 'no-cache',
      'x-content-type-options': 'nosniff',
    };
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

/* --------------------------------------------------------------- upstream */

async function forwardToAnthropic(req, res, pathname) {
  if (!API_KEY) {
    apiError(
      res,
      500,
      'configuration_error',
      'ANTHROPIC_API_KEY não configurada no servidor. Copie .env.example para .env, preencha a chave e reinicie.'
    );
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    apiError(res, err.status || 400, 'invalid_request_error', err.message);
    return;
  }
  if (req.method !== 'GET' && !body.trim()) {
    apiError(res, 400, 'invalid_request_error', 'Corpo vazio.');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const upstream = await fetch('https://api.anthropic.com' + pathname, {
      method: 'GET' === req.method ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
      },
      body: req.method === 'GET' ? undefined : body,
      signal: controller.signal,
    });

    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      apiError(res, 504, 'timeout_error', 'A API da Anthropic não respondeu a tempo (' + UPSTREAM_TIMEOUT / 1000 + 's).');
      return;
    }
    apiError(res, 502, 'upstream_error', 'Falha ao falar com a API da Anthropic: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------------- gemini */

async function forwardToGemini(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    apiError(res, err.status || 400, 'invalid_request_error', err.message);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch (err) {
    apiError(res, 400, 'invalid_request_error', 'JSON inválido.');
    return;
  }

  const model = String(payload.model || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(model)) {
    apiError(res, 400, 'invalid_request_error', 'Informe um modelo válido (ex.: gemini-3.8-flash).');
    return;
  }
  delete payload.model;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  const target =
    GEMINI_BASE + '/models/' + encodeURIComponent(model) + ':generateContent';

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      apiError(res, 504, 'timeout_error', 'O Gemini não respondeu a tempo (' + UPSTREAM_TIMEOUT / 1000 + 's).');
      return;
    }
    apiError(res, 502, 'upstream_error', 'Falha ao falar com o Gemini: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

const GEMINI_STT_PROMPT =
  'Transcreva literalmente, em português do Brasil, a fala do áudio a seguir. ' +
  'Responda só com a transcrição, sem comentários, sem pontuação inventada e sem repetir instruções. ' +
  'Se não houver fala inteligível, responda com uma string vazia.';

const AUDIO_MIME = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

async function forwardGeminiTranscribe(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    apiError(res, err.status || 400, 'invalid_request_error', err.message);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch (err) {
    apiError(res, 400, 'invalid_request_error', 'JSON inválido.');
    return;
  }

  const audio = payload.input_audio || payload.audio || {};
  const data = String(audio.data || '').trim();
  const format = String(audio.format || audio.mimeType || audio.mime_type || 'webm')
    .replace(/^audio\//, '')
    .toLowerCase();
  const mime = AUDIO_MIME[format] || 'audio/webm';

  if (!data) {
    apiError(res, 400, 'invalid_request_error', 'Faltou o áudio (input_audio.data em base64).');
    return;
  }

  const model = String(payload.model || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(model)) {
    apiError(res, 400, 'invalid_request_error', 'Informe um modelo válido (ex.: gemini-3.5-transcribe).');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  try {
    const upstream = await fetch(
      GEMINI_BASE + '/models/' + encodeURIComponent(model) + ':generateContent',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: GEMINI_STT_PROMPT }, { inline_data: { mime_type: mime, data: data } }],
            },
          ],
          generationConfig: { temperature: 0, maxOutputTokens: 4096 },
        }),
        signal: controller.signal,
      }
    );

    const raw = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      json(res, upstream.status, { ok: false, error: raw.error || { message: 'HTTP ' + upstream.status } });
      return;
    }

    const cand = (raw.candidates || [])[0] || {};
    const text = ((cand.content && cand.content.parts) || [])
      .map((p) => (p && p.text) || '')
      .join('')
      .trim();
    const u = raw.usageMetadata || {};

    json(res, 200, {
      ok: true,
      text: text,
      model: model,
      usage: { input: u.promptTokenCount || 0, output: u.candidatesTokenCount || 0, cost: null, calls: 1, searches: 0 },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      apiError(res, 504, 'timeout_error', 'O Gemini não respondeu a tempo (' + UPSTREAM_TIMEOUT / 1000 + 's).');
      return;
    }
    apiError(res, 502, 'upstream_error', 'Falha ao transcrever com o Gemini: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------- openrouter */

const modelCache = { at: 0, data: null };

function openRouterHeaders(origin) {
  const headers = {
    authorization: 'Bearer ' + OPENROUTER_API_KEY,
    'content-type': 'application/json',
  };
  const referer = OPENROUTER_REFERER || origin || '';
  if (referer) headers['http-referer'] = referer;
  if (OPENROUTER_TITLE) headers['x-title'] = OPENROUTER_TITLE;
  return headers;
}

async function forwardToOpenRouter(req, res, upstreamPath) {
  const target = upstreamPath || '/chat/completions';
  if (!OPENROUTER_API_KEY) {
    apiError(
      res,
      500,
      'configuration_error',
      'OPENROUTER_API_KEY não configurada no servidor. Copie .env.example para .env, preencha a chave e reinicie.'
    );
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    apiError(res, err.status || 400, 'invalid_request_error', err.message);
    return;
  }
  if (!body.trim()) {
    apiError(res, 400, 'invalid_request_error', 'Corpo vazio.');
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);
  const origin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : '');

  try {
    const upstream = await fetch(OPENROUTER_BASE + target, {
      method: 'POST',
      headers: openRouterHeaders(origin),
      body: body,
      signal: controller.signal,
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    if (err.name === 'AbortError') {
      apiError(res, 504, 'timeout_error', 'O OpenRouter não respondeu a tempo (' + UPSTREAM_TIMEOUT / 1000 + 's).');
      return;
    }
    apiError(res, 502, 'upstream_error', 'Falha ao falar com o OpenRouter: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Catálogo de modelos, resumido. O JSON completo do OpenRouter tem vários MB;
 * aqui devolvemos só o necessário para o seletor e já filtramos por busca.
 */
async function listOpenRouterModels(req, res, url) {
  const q = (url.searchParams.get('q') || '').toLowerCase().trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 40), 100);

  try {
    if (!modelCache.data || Date.now() - modelCache.at > 10 * 60 * 1000) {
      const upstream = await fetch(OPENROUTER_BASE + '/models', {
        headers: OPENROUTER_API_KEY ? { authorization: 'Bearer ' + OPENROUTER_API_KEY } : {},
      });
      if (!upstream.ok) throw new Error('HTTP ' + upstream.status);
      const payload = await upstream.json();
      modelCache.data = payload.data || [];
      modelCache.at = Date.now();
    }

    let list = modelCache.data.slice().sort((a, b) => (b.created || 0) - (a.created || 0));
    if (q) {
      list = list.filter((m) => {
        return (m.id || '').toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q);
      });
    }

    const out = list
      .slice(0, limit)
      .map((m) => ({
        id: m.id,
        name: m.name,
        context: m.context_length || null,
        prompt: m.pricing && Number(m.pricing.prompt),
        completion: m.pricing && Number(m.pricing.completion),
        tools: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'),
        structured: Array.isArray(m.supported_parameters) && m.supported_parameters.includes('structured_outputs'),
      }));

    json(res, 200, { total: list.length, models: out });
  } catch (err) {
    apiError(res, 502, 'upstream_error', 'Não foi possível listar os modelos do OpenRouter: ' + err.message);
  }
}

/* ----------------------------------------------------------------- router */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;
  const cors = corsHeaders(req);
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const ip = req.socket.remoteAddress || 'desconhecido';

  if (pathname !== '/api/health') {
    res.on('finish', () => {
      console.log([req.method, pathname, '→', res.statusCode, Date.now() - started + 'ms'].join(' '));
    });
  }

  try {
    if (pathname === '/api/health') {
      json(res, 200, {
        ok: true,
        service: 'naubert-bot',
        // compatibilidade com a versão anterior (só Anthropic)
        keyConfigured: !!GEMINI_API_KEY || !!OPENROUTER_API_KEY || !!API_KEY,
        keyMasked: maskKey(GEMINI_API_KEY || OPENROUTER_API_KEY || API_KEY),
        providers: {
          gemini: { keyConfigured: !!GEMINI_API_KEY, keyMasked: maskKey(GEMINI_API_KEY) },
          openrouter: { keyConfigured: !!OPENROUTER_API_KEY, keyMasked: maskKey(OPENROUTER_API_KEY) },
          anthropic: { keyConfigured: !!API_KEY, keyMasked: maskKey(API_KEY) },
        },
        tokenRequired: !!PROXY_TOKEN,
        node: process.version,
      });
      return;
    }

    if (pathname === '/api/models') {
      if (!checkToken(req)) {
        apiError(res, 401, 'authentication_error', 'Token do proxy inválido.');
        return;
      }
      await forwardToAnthropic(req, res, '/v1/models');
      return;
    }

    // Gemini: o modelo vai no caminho da URL, então o cliente manda `model` no corpo.
    if (pathname === '/api/gemini/generate') {
      if (req.method !== 'POST') {
        apiError(res, 405, 'invalid_request_error', 'Use POST.');
        return;
      }
      if (!checkToken(req)) {
        apiError(res, 401, 'authentication_error', 'Token do proxy inválido.');
        return;
      }
      if (!GEMINI_API_KEY) {
        apiError(
          res,
          500,
          'configuration_error',
          'GEMINI_API_KEY não configurada no servidor. Copie .env.example para .env, preencha e reinicie.'
        );
        return;
      }
      await forwardToGemini(req, res);
      return;
    }

    // Transcrição pelo Gemini: áudio inline no generateContent (sem Whisper).
    if (pathname === '/api/gemini/transcribe') {
      if (req.method !== 'POST') {
        apiError(res, 405, 'invalid_request_error', 'Use POST.');
        return;
      }
      if (!checkToken(req)) {
        apiError(res, 401, 'authentication_error', 'Token do proxy inválido.');
        return;
      }
      if (!GEMINI_API_KEY) {
        apiError(res, 500, 'configuration_error', 'GEMINI_API_KEY não configurada no servidor.');
        return;
      }
      await forwardGeminiTranscribe(req, res);
      return;
    }

    // Catálogo do Gemini: GET /v1beta/models não gasta tokens e confirma a chave.
    if (pathname === '/api/gemini/models') {
      if (!checkToken(req)) {
        apiError(res, 401, 'authentication_error', 'Token do proxy inválido.');
        return;
      }
      if (!GEMINI_API_KEY) {
        apiError(res, 500, 'configuration_error', 'GEMINI_API_KEY não configurada no servidor.');
        return;
      }
      try {
        const upstream = await fetch(GEMINI_BASE + '/models?pageSize=200', {
          headers: { 'x-goog-api-key': GEMINI_API_KEY },
        });
        const raw = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          json(res, upstream.status, { ok: false, error: raw.error || { message: 'HTTP ' + upstream.status } });
          return;
        }
        const models = (raw.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m) => ({
            id: String(m.name || '').replace(/^models\//, ''),
            name: m.displayName || '',
            context: m.inputTokenLimit || null,
            output: m.outputTokenLimit || null,
          }))
          .filter((m) => /^gemini/.test(m.id));
        json(res, 200, { ok: true, total: models.length, models });
      } catch (err) {
        apiError(res, 502, 'upstream_error', 'Não foi possível listar os modelos do Gemini: ' + err.message);
      }
      return;
    }

    // Saldo e limites da chave: /api/v1/key não custa crédito e responde na hora.
    if (pathname === '/api/openrouter/key') {
      if (!checkToken(req)) {
        apiError(res, 401, 'authentication_error', 'Token do proxy inválido.');
        return;
      }
      if (!OPENROUTER_API_KEY) {
        apiError(res, 500, 'configuration_error', 'OPENROUTER_API_KEY não configurada no servidor.');
        return;
      }
      try {
        const upstream = await fetch(OPENROUTER_BASE + '/key', {
          headers: { authorization: 'Bearer ' + OPENROUTER_API_KEY },
        });
        const raw = await upstream.json().catch(() => ({}));
        const d = raw.data || {};
        json(res, upstream.status, {
          ok: upstream.ok,
          label: d.label || '',
          limit: d.limit == null ? null : d.limit,
          limitRemaining: d.limit_remaining == null ? null : d.limit_remaining,
          usage: d.usage == null ? null : d.usage,
          usageDaily: d.usage_daily == null ? null : d.usage_daily,
          usageMonthly: d.usage_monthly == null ? null : d.usage_monthly,
          freeTier: !!d.is_free_tier,
        });
      } catch (err) {
        apiError(res, 502, 'upstream_error', 'Não foi possível consultar o saldo: ' + err.message);
      }
      return;
    }

    // Transcrição (STT): captura de aba, áudio enviado em base64.
    if (pathname === '/api/openrouter/transcribe') {
      if (req.method !== 'POST') {
        apiError(res, 405, 'invalid_request_error', 'Use POST.');
        return;
      }
      if (!checkToken(req)) {
        apiError(res, 401, 'authentication_error', 'Token do proxy inválido.');
        return;
      }
      await forwardToOpenRouter(req, res, '/audio/transcriptions');
      return;
    }

    if (pathname === '/api/openrouter/models') {
      if (!checkToken(req)) {
        apiError(res, 401, 'authentication_error', 'Token do proxy inválido.');
        return;
      }
      await listOpenRouterModels(req, res, url);
      return;
    }

    if (pathname === '/api/openrouter/chat') {
      if (req.method !== 'POST') {
        apiError(res, 405, 'invalid_request_error', 'Use POST.');
        return;
      }
      if (!checkToken(req)) {
        apiError(res, 401, 'authentication_error', 'Token do proxy inválido. Preencha PROXY_TOKEN nas configurações da página.');
        return;
      }
      if (rateLimited(ip)) {
        apiError(res, 429, 'rate_limit_error', 'Muitas requisições para o proxy local. Reduza a concorrência nas configurações.');
        return;
      }
      await forwardToOpenRouter(req, res);
      return;
    }

    if (pathname === '/api/messages') {
      if (req.method !== 'POST') {
        apiError(res, 405, 'invalid_request_error', 'Use POST.');
        return;
      }
      if (!checkToken(req)) {
        apiError(res, 401, 'authentication_error', 'Token do proxy inválido. Preencha PROXY_TOKEN nas configurações da página.');
        return;
      }
      if (rateLimited(ip)) {
        apiError(res, 429, 'rate_limit_error', 'Muitas requisições para o proxy local. Reduza a concorrência nas configurações.');
        return;
      }
      await forwardToAnthropic(req, res, '/v1/messages');
      return;
    }

    if (pathname.startsWith('/api/')) {
      apiError(res, 404, 'not_found_error', 'Rota inexistente: ' + pathname);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('405');
      return;
    }

    serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[naubert-bot] erro inesperado:', err);
    if (!res.headersSent) apiError(res, 500, 'internal_error', err.message);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  naubert-bot · checagem ao vivo');
  console.log('  http://localhost:' + PORT);
  console.log('');
  console.log('  Gemini:      ' + (GEMINI_API_KEY ? maskKey(GEMINI_API_KEY) : 'AUSENTE'));
  console.log('  OpenRouter:  ' + (OPENROUTER_API_KEY ? maskKey(OPENROUTER_API_KEY) : 'AUSENTE'));
  console.log('  Anthropic:   ' + (API_KEY ? maskKey(API_KEY) : 'ausente (opcional)'));
  console.log('');
  console.log('  .env:        ' + (ENV_FOUND ? ENV_FILE : 'não encontrado em ' + ENV_FILE));
  if (OPENROUTER_API_KEY && looksPlaceholder(OPENROUTER_API_KEY)) {
    console.log('  ! a chave do OpenRouter parece ser o texto de exemplo — troque pelo valor real');
  }
  if (!GEMINI_API_KEY && !OPENROUTER_API_KEY && !API_KEY) {
    if (!ENV_FOUND) {
      const found = envHint();
      console.log('  → crie ' + ENV_FILE + ' com GEMINI_API_KEY=… ou OPENROUTER_API_KEY=sk-or-v1-…');
      if (found) {
        console.log('  ! existe um .env em ' + found);
        console.log('    copie esse arquivo para a pasta acima ou rode o servidor a partir dela');
      }
    } else {
      console.log('  → preencha OPENROUTER_API_KEY dentro de ' + ENV_FILE + ' e reinicie');
    }
  }
  console.log('  transcrição: Web Speech (microfone) ou captura de aba + STT (Gemini ou Whisper)');
  console.log('  veículos permitidos: definidos na própria página (Configurações)');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n  encerrando.');
  server.close(() => process.exit(0));
});
