/* naubert-bot · anthropic.js
 * Cliente mínimo da Messages API.
 *
 * Dois modos:
 *   'proxy'  -> POST para <proxyBase>/api/messages, a chave fica no servidor (server.js).
 *               Recomendado. É o único modo seguro para uso real.
 *   'direct' -> fetch direto para api.anthropic.com com o header
 *               anthropic-dangerous-direct-browser-access: true.
 *               A chave fica no navegador. Só para teste local.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  function endpoint(cfg) {
    var base = (cfg.proxyBase || '').replace(/\/+$/, '');
    return base ? base + '/api/messages' : '/api/messages';
  }

  function buildHeaders(cfg) {
    var h = { 'content-type': 'application/json' };
    if (cfg.apiMode === 'direct') {
      h['x-api-key'] = cfg.apiKey || '';
      h['anthropic-version'] = NB.config.ANTHROPIC_VERSION;
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    if (cfg.betaHeader) h['anthropic-beta'] = cfg.betaHeader;
    if (cfg.proxyToken) h['x-proxy-token'] = cfg.proxyToken;
    return h;
  }

  function friendlyError(status, body) {
    var msg = (body && (body.error && body.error.message)) || '';
    var type = (body && (body.error && body.error.type)) || '';
    var raw = msg || (typeof body === 'string' ? body : JSON.stringify(body)) || ('HTTP ' + status);

    if (status === 401) return 'Chave de API recusada (401). No modo proxy, confira ANTHROPIC_API_KEY no .env e reinicie o servidor.';
    if (status === 403) {
      if (/cors|browser/i.test(raw)) {
        return 'Bloqueado por CORS. No modo direto é obrigatório o header anthropic-dangerous-direct-browser-access — se falhar, use o modo proxy.';
      }
      return raw;
    }
    if (status === 404) return 'Endpoint não encontrado (404). O servidor proxy está rodando?';
    if (status === 429) return 'Limite de requisições (429). Reduza a concorrência nas configurações.';
    if (status === 529) return 'API sobrecarregada (529). Tente de novo em instantes.';
    if (status === 400) {
      if (/output_config|output_format|json_schema/i.test(raw)) {
        return 'Esta conta/modelo não aceitou structured outputs: ' + raw;
      }
      if (/allowed_domains|blocked_domains/i.test(raw)) {
        return 'allowed_domains e blocked_domains não podem ser usados juntos. ' + raw;
      }
      if (/web_search/i.test(raw)) {
        return 'A ferramenta de busca foi rejeitada: ' + raw + ' — tente a versão "busca básica (20250305)".';
      }
      if (/thinking|budget_tokens/i.test(raw)) {
        return 'Parâmetro de raciocínio rejeitado: ' + raw + ' — desative o raciocínio adaptativo nas configurações.';
      }
      return raw;
    }
    if (type) return type + ': ' + msg;
    return raw;
  }

  /**
   * Chama a Messages API.
   * @param {object} cfg   configuração do usuário (NB.config.state)
   * @param {object} body  corpo da requisição (model, messages, tools, ...)
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>} resposta completa da API (não-streaming)
   */
  async function create(cfg, body, signal) {
    var usingProxy = cfg.apiMode === 'proxy';
    var url = usingProxy ? endpoint(cfg) : 'https://api.anthropic.com/v1/messages';
    var res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(cfg),
      body: JSON.stringify(body),
      signal: signal || null
    });

    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }

    if (!res.ok) {
      var err = new Error(friendlyError(res.status, data || text));
      err.status = res.status;
      err.body = data || text;
      throw err;
    }
    if (!data) throw new Error('Resposta vazia da API.');
    return data;
  }

  /** Verifica se o servidor proxy está de pé e se a chave está configurada. */
  async function health(cfg) {
    try {
      var base = (cfg.proxyBase || '').replace(/\/+$/, '');
      var res = await fetch(base + '/api/health', { cache: 'no-store' });
      if (!res.ok) return { ok: false, detail: 'HTTP ' + res.status };
      return await res.json();
    } catch (e) {
      return { ok: false, detail: 'servidor proxy inacessível' };
    }
  }

  /** Lista os modelos disponíveis na conta (útil para validar a chave). */
  async function listModels(cfg) {
    var base = (cfg.proxyBase || '').replace(/\/+$/, '');
    var res = await fetch(base + '/api/models', {
      method: 'GET',
      headers: cfg.proxyToken ? { 'x-proxy-token': cfg.proxyToken } : {}
    });
    if (!res.ok) throw new Error('Não foi possível listar modelos: HTTP ' + res.status);
    return await res.json();
  }

  NB.api = { create: create, health: health, listModels: listModels, friendlyError: friendlyError };
})(window);
