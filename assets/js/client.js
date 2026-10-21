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

  var GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

  /**
   * No modo direto o modelo vai no caminho (é o formato da API do Google).
   * No proxy ele vai no corpo, porque a rota é fixa — o servidor monta a URL.
   */
  function geminiUrl(cfg, model) {
    var m = encodeURIComponent(String(model || '').trim());
    if (cfg.apiMode === 'proxy') return base(cfg) + '/api/gemini/generate';
    return GEMINI_BASE + '/models/' + m + ':generateContent';
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
      if (provider === 'gemini') {
        h['x-goog-api-key'] = cfg.geminiKey || '';
      } else if (provider === 'openrouter') {
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
    if (provider === 'gemini') return geminiError(status, err);
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
      if (!isOR) return 'Créditos insuficientes na conta da Anthropic (402).';
      var source = (err.metadata && err.metadata.limit_source) || '';
      if (source === 'openrouter_key_limit') {
        return 'O limite de gasto desta chave do OpenRouter acabou (402). Ajuste o limite da chave em openrouter.ai/workspaces/default/keys ou use outra chave.';
      }
      if (source === 'openrouter_in_flight_budget') {
        return 'Limite de gasto simultâneo do OpenRouter atingido (402). Espere alguns segundos e tente de novo.';
      }
      return 'Sem créditos no OpenRouter (402). Adicione saldo em openrouter.ai/credits — sem isso nem a transcrição nem as checagens rodam.';
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

  /**
   * Erros do Google vêm como {error:{code,message,status}}. Os casos que
   * importam têm mensagem própria porque a saída não é óbvia.
   */
  function geminiError(status, err) {
    var raw = String((err && err.message) || '').trim() || 'HTTP ' + status;
    if (status === 401 || status === 403 || /api key not valid|api_key_invalid/i.test(raw)) {
      if (/permission|billing|not available|enable/i.test(raw)) {
        return (
          'O Google recusou a busca (grounding). No Gemini, a busca com Google Search só funciona com ' +
          'faturamento ativado no projeto — não entra no nível gratuito. Detalhe: ' + raw
        );
      }
      return 'Chave do Gemini inválida ou sem permissão (HTTP ' + status + '). Gere outra em aistudio.google.com/apikey. Detalhe: ' + raw;
    }
    if (status === 400) {
      if (/google_search|grounding|tool/i.test(raw)) {
        return (
          'Este modelo/plano não aceita a busca do Google: ' + raw +
          '. A busca por grounding exige faturamento ativo no projeto do AI Studio.'
        );
      }
      if (/response_schema|schema/i.test(raw)) return 'O schema JSON foi recusado: ' + raw;
      return raw;
    }
    if (status === 429) {
      return 'Cota do Gemini esgotada (429). O nível gratuito tem limite por minuto e por dia — espere ou ative o faturamento. Detalhe: ' + raw;
    }
    if (status === 404) return 'Modelo do Gemini não encontrado: ' + raw + ' — confira o nome (ex.: gemini-3.8-flash).';
    if (status >= 500) return 'O Gemini falhou (' + status + '): ' + raw;
    return raw;
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
    if (data.error && data.error.code && !data.candidates) {
      var gerr = new Error(geminiError(data.error.code, data.error));
      gerr.status = data.error.code;
      gerr.body = data;
      throw gerr;
    }

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

  /**
   * O Gemini transcreve pelo mesmo generateContent, com o áudio inline.
   * Vale quando o provedor é o Gemini e o modelo escolhido também é.
   */
  function isGeminiStt(cfg) {
    return cfg.provider === 'gemini';
  }

  /**
   * Modelo de transcrição efetivo no Gemini. Configuração antiga pode trazer
   * `openai/whisper-1` mesmo com o provedor Gemini — nesse caso usa o modelo
   * principal, que aceita áudio, em vez de mandar slug do Whisper para o Google.
   */
  function geminiSttModel(cfg, requested) {
    if (/^gemini/.test(String(requested || ''))) return requested;
    if (/^gemini/.test(String(cfg.sttModel || ''))) return cfg.sttModel;
    return cfg.model;
  }

  async function geminiTranscribe(cfg, body, signal) {
    var audio = body.input_audio || body.audio || {};
    var mime = {
      webm: 'audio/webm',
      ogg: 'audio/ogg',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
    }[String(audio.format || 'webm').replace(/^audio\//, '')] || 'audio/webm';

    var prompt =
      'Transcreva literalmente, em português do Brasil, a fala do áudio a seguir. ' +
      'Responda só com a transcrição, sem comentários. Se não houver fala, responda vazio.';

    var model = geminiSttModel(cfg, body.model);

    var payload = {
      model: model,
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: audio.data } }],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: 4096 },
    };

    if (cfg.apiMode === 'proxy') {
      return send(base(cfg) + '/api/gemini/transcribe', cfg, 'gemini', {
        model: model,
        input_audio: { data: audio.data, format: String(audio.format || 'webm').replace(/^audio\//, '') },
      }, signal);
    }
    return send(geminiUrl(cfg, model), cfg, 'gemini', payload, signal);
  }

  /**
   * Lista modelos do Gemini. GET /v1beta/models não gasta token — serve de
   * teste de chave.
   */
  async function geminiModels(cfg, signal) {
    var url =
      cfg.apiMode === 'proxy'
        ? base(cfg) + '/api/gemini/models'
        : GEMINI_BASE + '/models?pageSize=200';
    var headers = headersFor(cfg, 'gemini');
    var res = await fetch(url, { headers: headers, signal: signal || null, cache: 'no-store' });
    var text = await res.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error('Resposta inesperada do Gemini (HTTP ' + res.status + ').');
    }
    if (!res.ok || (data && data.ok === false)) {
      var err = (data && data.error) || {};
      var e = new Error(geminiError(err.code || res.status, err));
      e.status = res.status;
      throw e;
    }
    if (cfg.apiMode === 'direct') {
      var models = ((data && data.models) || [])
        .filter(function (m) {
          return (m.supportedGenerationMethods || []).indexOf('generateContent') !== -1;
        })
        .map(function (m) {
          return { id: String(m.name || '').replace(/^models\//, ''), name: m.displayName || '', context: m.inputTokenLimit || null };
        })
        .filter(function (m) {
          return /^gemini/.test(m.id);
        });
      return { ok: true, total: models.length, models: models };
    }
    return data;
  }

  NB.api = {
    messages: messages,
    geminiModels: geminiModels,
    chat: chat,
    health: health,
    models: models,

    /**
     * Transcrição de um trecho de áudio (captura de aba).
     *
     * No Gemini o áudio vai inline no generateContent (o modelo precisa aceitar
     * áudio). Nos outros provedores é o /audio/transcriptions do OpenRouter.
     */
    transcribe: async function (cfg, body, signal) {
      if (isGeminiStt(cfg)) return geminiTranscribe(cfg, body, signal);
      return send(transcribeUrl(cfg), cfg, 'openrouter', body, signal);
    },

    /**
     * Gemini generateContent. O `model` vai no caminho da URL; o proxy também
     * aceita no corpo para ficar igual ao resto do app.
     */
    generate: async function (cfg, body, signal) {
      var model = body.model;
      var payload = Object.assign({}, body);
      // No proxy o modelo precisa ir no corpo; no modo direto ele vai na URL.
      if (cfg.apiMode === 'proxy') return send(geminiUrl(cfg, model), cfg, 'gemini', payload, signal);
      delete payload.model;
      return send(geminiUrl(cfg, model), cfg, 'gemini', payload, signal);
    },

    /** Saldo/limite da chave do OpenRouter (não gasta crédito). */
    keyInfo: async function (cfg, signal) {
      var url =
        cfg.apiMode === 'proxy'
          ? base(cfg) + '/api/openrouter/key'
          : OR_BASE + '/key';
      var headers =
        cfg.apiMode === 'proxy'
          ? headersFor(cfg, 'openrouter')
          : { authorization: 'Bearer ' + (cfg.openrouterKey || '') };
      var res = await fetch(url, { headers: headers, signal: signal || null });
      var text = await res.text();
      var data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (e) {
        data = null;
      }
      if (!res.ok) {
        var error = new Error(friendlyError(res.status, data || text, 'openrouter'));
        error.status = res.status;
        throw error;
      }
      return data || {};
    },

    friendlyError: friendlyError,
    // compatibilidade com o nome anterior
    create: messages
  };
})(window);
