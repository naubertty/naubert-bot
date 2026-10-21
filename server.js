#!/usr/bin/env node
/* naubert-bot · server.js
 *
 * Servidor local sem dependências:
 *   - serve a página (index.html, assets/)
 *   - faz proxy de POST /api/messages para a API da Anthropic, mantendo a chave
 *     no processo do servidor em vez de expô-la no navegador
 *
 * Node 18+ (usa fetch global).
 *
 * Uso:
 *   cp .env.example .env      # e preencha ANTHROPIC_API_KEY
 *   npm start                 # http://localhost:8787
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------- env */

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
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
}

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
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
        keyConfigured: !!API_KEY,
        keyMasked: maskKey(API_KEY),
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
  console.log('  chave da API: ' + (API_KEY ? maskKey(API_KEY) : 'AUSENTE — preencha .env'));
  if (!API_KEY) {
    console.log('  → cp .env.example .env  e coloque sua ANTHROPIC_API_KEY');
  }
  console.log('  veículos permitidos: definidos na própria página (Configurações)');
  console.log('');
});

process.on('SIGINT', () => {
  console.log('\n  encerrando.');
  server.close(() => process.exit(0));
});
