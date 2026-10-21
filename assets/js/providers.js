/* naubert-bot · providers.js
 *
 * Cada provedor sabe montar as requisições e ler as respostas do seu formato.
 * O pipeline só cuida de fila, custo, dedupe e auditoria.
 *
 *   anthropic  -> Messages API, busca nativa com allowed_domains (uma chamada)
 *   openrouter -> chat completions, busca via openrouter:web_search (duas fases)
 *
 * Por que duas fases no OpenRouter: a evidência confiável de "o que a busca
 * devolveu" são as anotações url_citation. Se pedirmos JSON na mesma chamada,
 * o modelo tende a não anotar e perdemos a prova. Então:
 *   fase 1 — busca e escreve um resumo citando as fontes  -> anotações
 *   fase 2 — julga a afirmação com uma LISTA FECHADA de fontes (sem busca)
 * A auditoria então confere se a URL citada no julgamento está nessa lista.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  function PU() {
    return NB.pipelineUtils;
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  /* ------------------------------------------------------------- prompts */

  function triagePrompt(win) {
    return (
      'Trecho transcrito do debate (pode conter erros de reconhecimento):\n\n' +
      '"""\n' + win.text + '\n"""\n\n' +
      'Liste as afirmações. No máximo 4, priorizando as mais checáveis.'
    );
  }

  function claimPrompt(claim, today) {
    return [
      'Afirmação dita no debate ao vivo:',
      '"""' + claim.texto + '"""',
      '',
      'Quem falou: ' + claim.falante + ' · tema: ' + claim.tema,
      claim.contexto ? '\nContexto imediatamente anterior na transcrição:\n"""' + claim.contexto.slice(-900) + '"""' : '',
      '',
      'Hoje é ' + today + '.'
    ].join('\n');
  }

  var SYSTEM_SEARCH = [
    'Você é um pesquisador de redação levantando material para checar uma afirmação feita em um debate ao vivo.',
    '',
    'Use a ferramenta de busca. Comece pelo dado exato: número, período, unidade, população e abrangência.',
    'Faça de uma a três buscas, variando os termos se a primeira não resolver.',
    'Depois escreva de 2 a 5 frases dizendo o que as fontes encontradas mostram, com um link markdown para cada fonte.',
    '',
    'Não invente dados. Se a busca não trouxer nada útil, diga isso expressamente.',
    'Não emita opinião política e não avalie os debatedores.'
  ].join('\n');

  var SYSTEM_JUDGE = [
    'Você é o checador de fatos de um telejornal brasileiro.',
    'Você recebe uma afirmação dita em um debate e uma LISTA FECHADA de fontes, coletadas por uma busca restrita a veículos de imprensa e órgãos oficiais.',
    'Classifique a afirmação usando SOMENTE essas fontes.',
    '',
    'Regras obrigatórias:',
    '- Cite apenas URLs que apareçam na lista, copiadas literalmente. Nunca invente, complete ou encurte uma URL.',
    '- Se as fontes não permitirem concluir, o veredito é NAO_VERIFICADO — mesmo que você "saiba" a resposta.',
    '- Na dúvida entre FALSO e NAO_VERIFICADO, escolha NAO_VERIFICADO.',
    '- Explique em 1 a 3 frases o que a fonte mostra, sem opinião política e sem avaliar debatedores.',
    '- Se a afirmação for previsão ou promessa, verifique apenas a parte factual que as fontes sustentam.',
    '',
    'Significado dos vereditos:',
    '   VERDADEIRO                  -> o dado confere com a fonte, no período e no recorte citados.',
    '   SUBSTANCIALMENTE_VERDADEIRO -> o essencial confere, com imprecisão em detalhe secundário.',
    '   ENGANOSO                    -> o dado existe, mas o número, o recorte, o período ou a conclusão distorcem a fonte.',
    '   FALSO                       -> a fonte contradiz o dado, ou o dado não existe.',
    '   NAO_VERIFICADO              -> as fontes da lista não permitem concluir.',
    '',
    'Escreva em português do Brasil, direto, sem jargão.'
  ].join('\n');

  function judgePrompt(claim, evidence, today) {
    var list = (evidence.results || []).slice(0, 10);
    var lines = [claimPrompt(claim, today), '', 'FONTES COLETADAS PELA BUSCA RESTRITA (lista fechada):'];

    if (!list.length) {
      lines.push('(nenhuma fonte foi retornada — o veredito deve ser NAO_VERIFICADO)');
    } else {
      list.forEach(function (r, i) {
        var snippet = '';
        for (var j = 0; j < (evidence.citations || []).length; j++) {
          if (NB.audit.normUrl(evidence.citations[j].url) === NB.audit.normUrl(r.url)) {
            snippet = String(evidence.citations[j].citedText || '');
            break;
          }
        }
        lines.push(
          '[' + (i + 1) + '] ' + (r.title || '(sem título)') +
          (r.domain && r.domain !== r.title ? ' — ' + r.domain : '') +
          '\n    URL: ' + r.url +
          (snippet ? '\n    TRECHO: ' + snippet.replace(/\s+/g, ' ').slice(0, 600) : '')
        );
      });
    }

    lines.push(
      '',
      'Classifique a afirmação usando apenas essas fontes e devolva o JSON do schema.',
      'Em "fontes", copie a URL exatamente como aparece na lista acima.'
    );
    return lines.join('\n');
  }

  function locationParam(cfg) {
    var loc = cfg.userLocation;
    if (!loc || !loc.country) return null;
    var out = { type: 'approximate' };
    ['city', 'region', 'country', 'timezone'].forEach(function (k) {
      var v = loc[k] && String(loc[k]).trim();
      if (v) out[k] = v;
    });
    return out;
  }

  /* --------------------------------------------------------- OpenRouter IO */

  function chatMessage(res) {
    return (res && res.choices && res.choices[0] && res.choices[0].message) || null;
  }

  function chatText(res) {
    var m = chatMessage(res);
    if (!m) return '';
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map(function (p) {
          return typeof p === 'string' ? p : (p && p.text) || '';
        })
        .join('\n');
    }
    return '';
  }

  function annotationsOf(res) {
    var m = chatMessage(res);
    if (!m) return [];
    var list = m.annotations || (m.provider_metadata && m.provider_metadata.annotations) || [];
    if (!Array.isArray(list)) return [];
    return list
      .map(function (a) {
        if (!a) return null;
        if (a.type === 'url_citation' && a.url_citation) return a.url_citation;
        if (a.url) return a;
        return null;
      })
      .filter(Boolean);
  }

  /**
   * Converte as anotações da busca em evidência auditável.
   * Uma anotação url_citation só existe se a URL veio de um resultado real da
   * busca — é exatamente a prova que o audit.js precisa.
   */
  function evidenceFromAnnotations(res) {
    var ev = { queries: [], results: [], citations: [], errors: [], searchRequests: 0 };
    var seen = Object.create(null);
    annotationsOf(res).forEach(function (a) {
      if (!a.url) return;
      var key = NB.audit.normUrl(a.url);
      if (!seen[key]) {
        seen[key] = true;
        ev.results.push({ url: a.url, title: a.title || '', pageAge: '' });
      }
      ev.citations.push({ url: a.url, title: a.title || '', citedText: String(a.content || '').slice(0, 800) });
    });
    var u = (res && res.usage) || {};
    ev.searchRequests = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
    return ev;
  }

  function orUsage(res) {
    var u = (res && res.usage) || {};
    return {
      input: (u.prompt_tokens || 0) + (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens ? 0 : 0),
      output: u.completion_tokens || 0,
      searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
      cost: typeof u.cost === 'number' ? u.cost : null,
      calls: 1
    };
  }

  function mergeUsage(a, b) {
    return {
      input: (a.input || 0) + (b.input || 0),
      output: (a.output || 0) + (b.output || 0),
      searches: (a.searches || 0) + (b.searches || 0),
      cost: a.cost != null || b.cost != null ? (a.cost || 0) + (b.cost || 0) : null,
      calls: (a.calls || 1) + (b.calls || 1)
    };
  }

  function isToolRejection(err) {
    var msg = String((err && err.message) || '');
    var status = err && err.status;
    if (status !== 400 && status !== 404 && status !== 422) return false;
    return /web_search|server tool|tool|par[aâ]metro|parameter|unsupported/i.test(msg);
  }

  // A engine não aceita a lista de domínios (o caso conhecido é a busca nativa
  // em endpoints do Google, que devolve 400 em vez de ignorar o filtro).
  function isDomainRejection(err) {
    var msg = String((err && err.message) || '');
    var status = err && err.status;
    if (status !== 400 && status !== 422) return false;
    return /allowed_domains|excluded_domains|domain filter|domain_filter|domains? not supported/i.test(msg);
  }

  /* ------------------------------------------------------------- anthropic */

  var anthropic = {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-opus-5-5',

    triage: async function (ctx) {
      var cfg = ctx.cfg;
      var model = cfg.triageModel || cfg.model;
      var body = {
        model: model,
        max_tokens: cfg.maxTokensTriage,
        system: PU().SYSTEM_TRIAGE,
        messages: [{ role: 'user', content: triagePrompt(ctx.window) }],
        output_config: { format: { type: 'json_schema', schema: PU().CLAIM_SCHEMA } }
      };
      if (cfg.thinkingTriage === 'adaptive' && PU().supportsAdaptive(model)) {
        body.thinking = { type: 'adaptive' };
      }

      var res = await ctx.callJson(body, 'triagem');
      var data = PU().parseJsonLoose(PU().textOf(res)) || {
        afirmacoes: [],
        comentario: 'resposta ilegível'
      };
      return { data: data, usage: anthropic.usageOf(res) };
    },

    verify: async function (ctx) {
      var cfg = ctx.cfg;
      var tool = {
        type: cfg.searchTool,
        name: 'web_search',
        max_uses: clamp(cfg.maxUses || 4, 1, 15),
        allowed_domains: ctx.outlets
      };
      if (cfg.searchTool === 'web_search_20260209' || cfg.searchTool === 'web_search_20260318') {
        // Sem execução de código no cliente, a chamada precisa ser direta.
        tool.allowed_callers = ['direct'];
        if (cfg.searchTool === 'web_search_20260318' && cfg.responseInclusion === 'excluded') {
          tool.response_inclusion = 'excluded';
        }
      }
      var loc = locationParam(cfg);
      if (loc) tool.user_location = loc;

      var body = {
        model: cfg.model,
        max_tokens: cfg.maxTokensVerify,
        system: PU().SYSTEM_VERIFY,
        messages: [
          {
            role: 'user',
            content:
              claimPrompt(ctx.claim, ctx.today) +
              '\n\nVerifique com a busca restrita aos veículos permitidos.' +
              '\nDevolva o veredito e cite apenas as matérias que a busca retornou.'
          }
        ],
        tools: [tool],
        output_config: { format: { type: 'json_schema', schema: PU().VERIFY_SCHEMA } }
      };
      if (cfg.thinkingVerify === 'adaptive' && PU().supportsAdaptive(cfg.model)) {
        body.thinking = { type: 'adaptive' };
      }

      var res = await ctx.callJson(body, 'checagem');
      var data = PU().parseJsonLoose(PU().textOf(res));
      if (!data) throw new Error('A resposta da checagem não veio em JSON legível.');

      return {
        data: data,
        evidence: NB.audit.collectEvidence(res.content || []),
        usage: anthropic.usageOf(res)
      };
    },

    usageOf: function (res) {
      var u = (res && res.usage) || {};
      return {
        input:
          (u.input_tokens || 0) +
          (u.cache_read_input_tokens || 0) +
          (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
        searches: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
        cost: null,
        calls: 1
      };
    }
  };

  /* ------------------------------------------------------------ openrouter */

  var openrouter = {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'anthropic/claude-opus-5.5',

    triage: async function (ctx) {
      var cfg = ctx.cfg;
      var body = {
        model: cfg.triageModel || cfg.model,
        messages: [
          { role: 'system', content: PU().SYSTEM_TRIAGE },
          { role: 'user', content: triagePrompt(ctx.window) }
        ],
        max_tokens: cfg.maxTokensTriage,
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'triagem_debate', strict: true, schema: PU().CLAIM_SCHEMA }
        }
      };

      var res = await ctx.callJson(body, 'triagem');
      var data = PU().parseJsonLoose(chatText(res)) || {
        afirmacoes: [],
        comentario: 'resposta ilegível'
      };
      return { data: data, usage: orUsage(res) };
    },

    verify: async function (ctx) {
      var cfg = ctx.cfg;
      var domains = ctx.outlets;

      var params = {
        max_results: clamp(cfg.maxResults || 5, 1, 10),
        max_uses: clamp(cfg.maxUses || 3, 1, 10),
        allowed_domains: domains
      };
      if (cfg.searchEngine && cfg.searchEngine !== 'auto') params.engine = cfg.searchEngine;
      var loc = locationParam(cfg);
      if (loc) params.user_location = loc;

      var searchBody = {
        model: cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_SEARCH },
          {
            role: 'user',
            content:
              claimPrompt(ctx.claim, ctx.today) +
              '\n\nBusque o dado e resuma o que as fontes mostram, citando cada uma.'
          }
        ],
        max_tokens: 1400,
        temperature: 0.1,
        tools: [{ type: 'openrouter:web_search', parameters: params }],
        max_tool_calls: 4
      };

      var pluginBody = {
        model: cfg.model,
        messages: searchBody.messages,
        max_tokens: 1400,
        temperature: 0.1,
        plugins: [
          {
            id: 'web',
            max_results: params.max_results,
            include_domains: domains
          }
        ]
      };

      var searchRes;
      try {
        searchRes = await ctx.callPlain(searchBody, 'busca');
      } catch (err) {
        // Plano B: a engine escolhida não sabe filtrar domínios (a busca nativa
        // do Google devolve 400 quando recebe allowed_domains). Sem `engine`, o
        // "auto" cai para a Exa justamente porque há lista de domínios.
        if (isDomainRejection(err) && params.engine) {
          ctx.emit('warn', 'a engine ' + params.engine + ' recusou o filtro de domínios — repetindo no automático');
          var retryBody = JSON.parse(JSON.stringify(searchBody));
          delete retryBody.tools[0].parameters.engine;
          try {
            searchRes = await ctx.callPlain(retryBody, 'busca');
          } catch (err2) {
            err = err2;
          }
        }
        if (!searchRes && isToolRejection(err)) {
          // Plano C: o plugin web (legado) sempre busca uma vez e também devolve
          // url_citation. Serve para modelos/endpoints sem suporte a server tools.
          ctx.emit('warn', 'server tool recusada — tentando o plugin web (legado)');
          searchRes = await ctx.callPlain(pluginBody, 'busca');
        } else if (!searchRes) {
          throw err;
        }
      }

      var evidence = evidenceFromAnnotations(searchRes);
      if (!evidence.results.length) {
        ctx.emit('warn', 'a busca não devolveu citações verificáveis — o veredito tende a NÃO VERIFICADO');
      }

      var judgeBody = {
        model: cfg.judgeModel || cfg.model,
        messages: [
          { role: 'system', content: SYSTEM_JUDGE },
          { role: 'user', content: judgePrompt(ctx.claim, evidence, ctx.today) }
        ],
        max_tokens: cfg.maxTokensVerify,
        temperature: 0,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'checagem_debate', strict: true, schema: PU().VERIFY_SCHEMA }
        }
      };

      var judgeRes = await ctx.callJson(judgeBody, 'julgamento');
      var data = PU().parseJsonLoose(chatText(judgeRes));
      if (!data) throw new Error('O julgamento não veio em JSON legível.');

      return {
        data: data,
        evidence: evidence,
        usage: mergeUsage(orUsage(searchRes), orUsage(judgeRes))
      };
    },

    usageOf: orUsage
  };


  /* ---------------------------------------------------------------- gemini */

  /**
   * Converte JSON Schema para o subconjunto OpenAPI que o Gemini aceita:
   * sem additionalProperties, tipos em minúsculas, `enum` como lista de strings.
   */
  function toGeminiSchema(node) {
    if (Array.isArray(node)) return node.map(toGeminiSchema);
    if (!node || typeof node !== 'object') return node;
    var out = {};
    Object.keys(node).forEach(function (k) {
      if (k === 'additionalProperties' || k === '$schema' || k === 'title') return;
      var v = node[k];
      if (k === 'properties') {
        out.properties = {};
        Object.keys(v || {}).forEach(function (name) {
          out.properties[name] = toGeminiSchema(v[name]);
        });
        return;
      }
      out[k] = toGeminiSchema(v);
    });
    return out;
  }

  /** Texto de todos os parts de resposta do Gemini. */
  function gemText(res) {
    var cand = (res && res.candidates && res.candidates[0]) || {};
    var content = cand.content || {};
    return (content.parts || [])
      .map(function (p) {
        return (p && p.text) || '';
      })
      .join('')
      .trim();
  }

  /**
   * A evidência do Gemini está em `groundingMetadata`:
   *   groundingChunks  -> [{ web: { uri, title } }]  (uri é redirecionador, title é o domínio)
   *   groundingSupports-> liga trechos do texto aos chunks citados
   *   webSearchQueries -> consultas executadas (é o que a API cobra)
   */
  function geminiEvidence(res) {
    var ev = { queries: [], results: [], citations: [], errors: [], searchRequests: 0 };
    var cand = (res && res.candidates && res.candidates[0]) || {};
    var gm = cand.groundingMetadata || {};
    var chunks = gm.groundingChunks || [];
    var seen = Object.create(null);

    (gm.webSearchQueries || []).forEach(function (q) {
      if (q && ev.queries.indexOf(q) === -1) ev.queries.push(q);
    });
    ev.searchRequests = (gm.webSearchQueries || []).length;

    chunks.forEach(function (c) {
      var web = c && (c.web || c.retrievedContext);
      if (!web || !web.uri) return;
      var key = String(web.uri);
      if (seen[key]) return;
      seen[key] = true;
      ev.results.push({
        // O uri do grounding é um redirecionador do Google que abre a matéria;
        // o título é o domínio do veículo. A auditoria usa `domain` para checar
        // a lista e `url` para o link.
        url: web.uri,
        title: web.title || '',
        domain: web.title || '',
        pageAge: ''
      });
    });

    (gm.groundingSupports || []).forEach(function (sup) {
      var text = (sup && sup.segment && sup.segment.text) || '';
      (sup && sup.groundingChunkIndices ? sup.groundingChunkIndices : []).forEach(function (i) {
        var c = chunks[i];
        var web = c && (c.web || c.retrievedContext);
        if (!web || !web.uri) return;
        ev.citations.push({ url: web.uri, title: web.title || '', citedText: text, domain: web.title || '' });
      });
    });

    return ev;
  }

  function geminiUsage(res) {
    var u = (res && res.usageMetadata) || {};
    var gm = (((res && res.candidates && res.candidates[0]) || {}).groundingMetadata) || {};
    return {
      input: u.promptTokenCount || 0,
      // thoughtsTokenCount é cobrado como saída.
      output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
      searches: (gm.webSearchQueries || []).length,
      cost: null,
      calls: 1
    };
  }

  /** A busca por grounding exige faturamento; o erro precisa ser explícito. */
  function isGroundingUnavailable(err) {
    var msg = String((err && err.message) || '');
    return /grounding|google_search|google search|faturamento|billing|free tier|n[ií]vel gratuito/i.test(msg);
  }

  var SYSTEM_SEARCH_GEMINI = [
    'Você é um pesquisador de redação levantando material para checar uma afirmação feita em um debate ao vivo.',
    '',
    'Use a busca do Google. Comece pelo dado exato: número, período, unidade, população e abrangência.',
    'Faça de uma a três buscas, variando os termos se a primeira não resolver.',
    'Priorize os veículos de imprensa e órgãos oficiais listados abaixo; se um deles aparecer nos resultados, cite-o.',
    '',
    'Depois escreva de 2 a 5 frases dizendo o que as fontes encontradas mostram.',
    'Não invente dados. Se a busca não trouxer nada útil, diga isso expressamente.',
    'Não emita opinião política e não avalie os debatedores.'
  ].join('\n');

  var gemini = {
    id: 'gemini',
    label: 'Gemini',
    defaultModel: 'gemini-3.8-flash',
    supportsDomainFilter: false,

    triage: async function (ctx) {
      var cfg = ctx.cfg;
      var body = {
        model: cfg.triageModel || cfg.model,
        systemInstruction: { parts: [{ text: PU().SYSTEM_TRIAGE }] },
        contents: [{ role: 'user', parts: [{ text: triagePrompt(ctx.window) }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: cfg.maxTokensTriage,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(PU().CLAIM_SCHEMA)
        }
      };

      var res = await ctx.callJson(body, 'triagem');
      var data = PU().parseJsonLoose(gemText(res)) || { afirmacoes: [], comentario: 'resposta ilegível' };
      return { data: data, usage: geminiUsage(res) };
    },

    verify: async function (ctx) {
      var cfg = ctx.cfg;

      // Fase 1 — busca. Sem schema aqui: pedir JSON junto com a busca tende a
      // apagar as citações (groundingSupports), que são a prova do que voltou.
      var searchBody = {
        model: cfg.model,
        systemInstruction: { parts: [{ text: SYSTEM_SEARCH_GEMINI }] },
        contents: [
          {
            role: 'user',
            parts: [
              {
                text:
                  claimPrompt(ctx.claim, ctx.today) +
                  '\n\nVeículos que devem ser priorizados na busca (o veredito só pode se apoiar neles):\n' +
                  ctx.outlets.join(', ') +
                  '\n\nBusque o dado e resuma o que as fontes mostram.'
              }
            ]
          }
        ],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: Math.min(cfg.maxTokensVerify || 3000, 4000) }
      };

      var searchRes;
      try {
        searchRes = await ctx.callPlain(searchBody, 'busca');
      } catch (err) {
        if (isGroundingUnavailable(err)) {
          var e = new Error(
            'A busca do Google no Gemini precisa de faturamento ativado no projeto do AI Studio. ' +
              'O nível gratuito não inclui grounding — a checagem não pode rodar sem busca. ' +
              'Ative o faturamento (ou use OpenRouter/Anthropic). Detalhe: ' +
              (err.message || err)
          );
          e.status = 402;
          e.grounding = true;
          throw e;
        }
        throw err;
      }

      var evidence = geminiEvidence(searchRes);
      if (!evidence.results.length) {
        ctx.emit('warn', 'a busca do Google não devolveu fontes rastreáveis — o veredito tende a NÃO VERIFICADO');
      }

      // Fase 2 — julgamento com lista fechada, sem busca.
      var judgeBody = {
        model: cfg.judgeModel || cfg.model,
        systemInstruction: { parts: [{ text: SYSTEM_JUDGE }] },
        contents: [{ role: 'user', parts: [{ text: judgePrompt(ctx.claim, evidence, ctx.today) }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: cfg.maxTokensVerify,
          responseMimeType: 'application/json',
          responseSchema: toGeminiSchema(PU().VERIFY_SCHEMA)
        }
      };

      var judgeRes = await ctx.callJson(judgeBody, 'julgamento');
      var data = PU().parseJsonLoose(gemText(judgeRes));
      if (!data) throw new Error('O julgamento não veio em JSON legível.');

      return {
        data: data,
        evidence: evidence,
        usage: mergeUsage(geminiUsage(searchRes), geminiUsage(judgeRes))
      };
    },

    usageOf: geminiUsage
  };

  var ALL = { anthropic: anthropic, openrouter: openrouter, gemini: gemini };

  NB.providers = {
    anthropic: anthropic,
    openrouter: openrouter,
    gemini: gemini,
    all: ALL,
    get: function (cfg) {
      return ALL[(cfg && cfg.provider) || 'openrouter'] || openrouter;
    },
    defaultModelFor: function (providerRef) {
      return (ALL[providerRef] || openrouter).defaultModel;
    },
    // expostos para teste
    chatText: chatText,
    annotationsOf: annotationsOf,
    evidenceFromAnnotations: evidenceFromAnnotations,
    judgePrompt: judgePrompt,
    isToolRejection: isToolRejection,
    isDomainRejection: isDomainRejection,
    SYSTEM_SEARCH: SYSTEM_SEARCH,
    SYSTEM_JUDGE: SYSTEM_JUDGE,
    toGeminiSchema: toGeminiSchema,
    geminiEvidence: geminiEvidence,
    gemText: gemText,
    geminiUsage: geminiUsage,
    isGroundingUnavailable: isGroundingUnavailable
  };
})(window);
