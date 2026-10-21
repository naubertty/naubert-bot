/* naubert-bot · client.js
 *
 * Transporte das duas APIs. Nada de regra de negócio aqui — só HTTP, erros e
 * formatos de resposta.
 *
 *   Anthropic   POST /v1/messages              (formato Messages)
 *   OpenRouter  POST /api/v1/chat/completions  (formato OpenAI chat)
 *
 * Em produção a chave fica no servidor (proxy). O modo direto existe para teste
 * local e expõe a chave ao navegador — está sinalizado na interface.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var OR_BASE = 'https://openrouter.ai/api/v1';

  function base(cfg) {
    return (cfg.proxyBase || '').replace(/\/+$/, '');
  }

  function transcribeUrl(cfg) {
    return cfg.apiMode === 'proxy' ? base(cfg) + '/api/openrouter/transcribe' : OR_BASE + '/audio/transcriptions';
  }

  function urlFor(cfg, provider) {
    if (cfg.apiMode === 'proxy') {
      return base(cfg) + (provider === 'openrouter' ? '/api/openrouter/chat' : '/api/messages');
    }
    return provider === 'openrouter' ? OR_BASE + '/chat/completions' : 'https://api.anthropic.com/v1/messages';
  }

  function headersFor(cfg, provider) {
    var h = { 'content-type': 'application/json' };

    if (cfg.apiMode === 'direct') {
      if (provider === 'openrouter') {
        h.authorization = 'Bearer ' + (cfg.openrouterKey || '');
        h['HTTP-Referer'] = cfg.orReferer || (global.location && global.location.origin) || 'http://localhost';
        h['X-Title'] = cfg.orTitle || 'naubert-bot';
      } else {
        h['x-api-key'] = cfg.apiKey || '';
        h['anthropic-version'] = NB.config.ANTHROPIC_VERSION;
        h['anthropic-dangerous-direct-browser-access'] = 'true';
      }
    }

    if (cfg.betaHeader && provider === 'anthropic') h['anthropic-beta'] = cfg.betaHeader;
    if (cfg.proxyToken) h['x-proxy-token'] = cfg.proxyToken;
    return h;
  }

  function friendlyError(status, body, provider) {
    var err = (body && body.error) || {};
    var msg = err.message || (typeof body === 'string' ? body : JSON.stringify(body || {}));
    var type = err.type || (body && body.code) || '';
    var raw = String(msg || '').trim() || 'HTTP ' + status;
    var isOR = provider === 'openrouter';

    if (status === 401) {
      return isOR
        ? 'Chave do OpenRouter recusada (401). Confira OPENROUTER_API_KEY no .env e reinicie o servidor.'
        : 'Chave da Anthropic recusada (401). Confira ANTHROPIC_API_KEY no .env e reinicie o servidor.';
    }
    if (status === 402) {
      return isOR
        ? 'Créditos insuficientes no OpenRouter (402). Recarregue a conta em openrouter.ai/credits.'
        : 'Créditos insuficientes na conta da Anthropic (402).';
    }
    if (status === 403) {
      if (/moderation|guardrail/i.test(raw)) return 'A requisição foi bloqueada pela moderação do provedor: ' + raw;
      if (/cors|browser/i.test(raw)) return 'Bloqueado por CORS. Use o modo proxy ou configure o modo direto.';
      return raw;
    }
    if (status === 404) {
      if (isOR && /no endpoints found|model/i.test(raw)) {
        return 'Modelo não encontrado ou sem endpoint compatível no OpenRouter: ' + raw +
          ' — confira o slug (ex.: anthropic/claude-opus-5.5) no botão "listar modelos".';
      }
      return 'Endpoint não encontrado (404). O servidor proxy está rodando?';
    }
    if (status === 429) {
      return 'Limite de requisições (429). Reduza a concorrência nas configurações ou troque de modelo/provedor.';
    }
    if (status >= 500) {
      return 'A API falhou (' + status + '): ' + raw;
    }
    if (status === 400 || status === 422) {
      if (/response_format|json_schema|structured/i.test(raw)) return 'Este modelo/endpoint recusou structured outputs: ' + raw;
      if (/allowed_domains|excluded_domains|include_domains|exclude_domains/i.test(raw)) {
        return 'Filtro de domínios rejeitado: ' + raw;
      }
      if (/web_search|server tool|tool/i.test(raw)) return 'A ferramenta de busca foi rejeitada: ' + raw;
      if (/thinking|reasoning/i.test(raw)) return 'Parâmetro de raciocínio rejeitado: ' + raw;
      return raw;
    }
    return type ? type + ': ' + raw : raw;
  }

  async function send(url, cfg, provider, body, signal) {
    var res = await fetch(url, {
      method: 'POST',
      headers: headersFor(cfg, provider),
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
      var err = new Error(friendlyError(res.status, data || text, provider));
      err.status = res.status;
      err.body = data || text;
      throw err;
    }
    if (!data) throw new Error('Resposta vazia da API.');

    // OpenRouter às vezes devolve 200 com um objeto de erro dentro.
    if (provider === 'openrouter' && data.error && !data.choices) {
      var e2 = new Error(friendlyError(data.error.code || 502, data, provider));
      e2.status = data.error.code || 502;
      e2.body = data;
      throw e2;
    }
    return data;
  }

  function messages(cfg, body, signal) {
    return send(urlFor(cfg, 'anthropic'), cfg, 'anthropic', body, signal);
  }

  function chat(cfg, body, signal) {
    return send(urlFor(cfg, 'openrouter'), cfg, 'openrouter', body, signal);
  }

  async function health(cfg) {
    try {
      var res = await fetch(base(cfg) + '/api/health', { cache: 'no-store' });
      if (!res.ok) return { ok: false, detail: 'HTTP ' + res.status };
      return await res.json();
    } catch (e) {
      return { ok: false, detail: 'servidor proxy inacessível' };
    }
  }

  /**
   * Lista modelos do OpenRouter pelo proxy. O servidor filtra e devolve um
   * recorte pequeno (id, nome, contexto, preço) — o catálogo completo tem MBs.
   */
  async function models(cfg, query) {
    var url = base(cfg) + '/api/openrouter/models' + (query ? '?q=' + encodeURIComponent(query) : '');
    var res = await fetch(url, {
      cache: 'no-store',
      headers: cfg.proxyToken ? { 'x-proxy-token': cfg.proxyToken } : {}
    });
    if (!res.ok) throw new Error('Não foi possível listar modelos: HTTP ' + res.status);
    return await res.json();
  }

  NB.api = {
    messages: messages,
    chat: chat,
    health: health,
    models: models,

    /**
     * Transcrição de um trecho de áudio (captura de aba).
     * Sempre OpenRouter: é o único provedor configurado com /audio/transcriptions.
     */
    transcribe: async function (cfg, body, signal) {
      return send(transcribeUrl(cfg), cfg, 'openrouter', body, signal);
    },

    friendlyError: friendlyError,
    // compatibilidade com o nome anterior
    create: messages
  };
})(window);
