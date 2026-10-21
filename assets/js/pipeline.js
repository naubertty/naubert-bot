/* naubert-bot · pipeline.js
 *
 * Orquestração, independente de provedor:
 *
 *   1) TRIAGEM    — separa afirmação checável de opinião/previsão/promessa
 *   2) VERIFICAÇÃO — busca restrita + veredito
 *   3) AUDITORIA  — a fonte citada veio mesmo da busca?
 *
 * O formato de cada requisição e a leitura da resposta ficam em providers.js.
 * Aqui ficam fila, prioridade, dedupe, retentativas e custo.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var STOPWORDS = (
    'a o as os um uma uns umas de do da dos das em no na nos nas por para com sem sob sobre ' +
    'e ou que se como mais menos muito pouco ja nao sim ao aos pela pelo foi ser sao esta estao ' +
    'esse essa isso este esta aquilo eu ele ela eles elas nos vos voce voces lhe lhes'
  ).split(' ');

  /* --------------------------------------------------------------- schemas */

  var CLAIM_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['afirmacoes', 'comentario'],
    properties: {
      afirmacoes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['texto', 'falante', 'tipo', 'prioridade', 'tema', 'porque', 'termos_busca'],
          properties: {
            texto: { type: 'string', description: 'A afirmação reformulada em uma frase completa, fiel ao que foi dito, em português.' },
            falante: { type: 'string', description: 'Quem disse, se a transcrição permitir identificar. Use "candidato A", "candidato B", "mediador" ou "não identificado". Nunca invente nomes.' },
            tipo: {
              type: 'string',
              enum: ['checavel', 'opiniao', 'previsao', 'promessa', 'pergunta', 'ataque_pessoal'],
              description: 'Só "checavel" segue para verificação. Opinião, previsão e promessa não são fatos verificáveis.'
            },
            prioridade: { type: 'integer', description: '1 = dado central do debate; 2 = relevante; 3 = secundário.' },
            tema: { type: 'string', description: 'Tema em 1 a 3 palavras: economia, saúde, segurança pública, eleições etc.' },
            porque: { type: 'string', description: 'Por que é (ou não é) checável, em uma frase curta.' },
            termos_busca: { type: 'string', description: 'Termos-chave para localizar a checagem, sem opinião e sem o nome de quem falou.' }
          }
        }
      },
      comentario: { type: 'string', description: 'Uma frase sobre a janela. Pode ser vazio.' }
    }
  };

  var VERIFY_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['veredito', 'explicacao', 'correcao', 'confianca', 'fontes', 'termos_usados'],
    properties: {
      veredito: {
        type: 'string',
        enum: ['VERDADEIRO', 'SUBSTANCIALMENTE_VERDADEIRO', 'ENGANOSO', 'FALSO', 'NAO_VERIFICADO'],
        description: 'Classificação final. Use NAO_VERIFICADO quando a busca restrita não trouxer base suficiente.'
      },
      explicacao: { type: 'string', description: 'De 1 a 3 frases explicando o que as fontes mostram, em linguagem direta, sem opinião política.' },
      correcao: { type: 'string', description: 'Se houver erro, o dado correto em uma frase. Se a afirmação estiver certa, repita o dado confirmado.' },
      confianca: { type: 'number', description: 'Confiança de 0 a 1 na classificação, considerando a qualidade das fontes.' },
      fontes: {
        type: 'array',
        description: 'Somente URLs que apareceram nos resultados da busca. Copie a URL exata, sem encurtar nem inventar.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['veiculo', 'titulo', 'url', 'data', 'trecho'],
          properties: {
            veiculo: { type: 'string', description: 'Nome do veículo.' },
            titulo: { type: 'string', description: 'Título da matéria exatamente como veio no resultado.' },
            url: { type: 'string', description: 'URL exata do resultado da busca.' },
            data: { type: 'string', description: 'Data de publicação no formato AAAA-MM-DD, ou vazio se desconhecida.' },
            trecho: { type: 'string', description: 'Trecho de até 200 caracteres que sustenta o veredito.' }
          }
        }
      },
      termos_usados: { type: 'string', description: 'As consultas de busca efetivamente usadas, separadas por ponto e vírgula.' }
    }
  };

  /* ---------------------------------------------------------------- prompts */

  var SYSTEM_TRIAGE = [
    'Você faz a triagem de um debate político brasileiro transmitido ao vivo.',
    'Recebe um trecho de transcrição automática — com erros de reconhecimento, sem pontuação confiável e sem identificação de falante — e separa o que pode ser checado do que é opinião.',
    '',
    'Regras:',
    '- Afirmação checável é aquela sobre fato, número, data, lei, decisão judicial, política pública ou evento, que pode ser confirmada ou refutada por fonte documental.',
    '- Opinião ("o governo é ruim"), previsão ("vamos crescer 4%") e promessa ("vou zerar o imposto") NÃO são checáveis agora: classifique como opiniao, previsao ou promessa.',
    '- Não invente falas. Se o trecho estiver truncado, reformule o mínimo necessário e mantenha o sentido.',
    '- Corrija erros evidentes de transcrição só quando o sentido for óbvio.',
    '- Marque prioridade 1 para números e acusações factuais centrais; 3 para detalhes acessórios.',
    '- Não emita juízo sobre partidos, candidatos ou ideologia. Só triagem.',
    '- Se o trecho não contiver nenhuma afirmação checável, devolva a lista vazia.'
  ].join('\n');

  var SYSTEM_VERIFY = [
    'Você é um checador de fatos de um telejornal brasileiro, trabalhando durante um debate ao vivo.',
    'Sua base é exclusivamente a busca na web, restrita a uma lista fechada de veículos de imprensa e fontes oficiais.',
    '',
    'Regras obrigatórias:',
    '- Sempre faça pelo menos uma busca antes de concluir. Priorize o dado exato: número, período, unidade, abrangência e população.',
    '- Cite somente URLs que apareceram nos resultados das buscas, copiadas literalmente. Nunca construa, complete ou adivinhe uma URL.',
    '- Se a busca não retornar nada útil sobre a afirmação, o veredito é NAO_VERIFICADO. Não preencha a lacuna com conhecimento próprio.',
    '- Distinga com rigor:',
    '   VERDADEIRO                  -> o dado confere com a fonte, no período e no recorte citados.',
    '   SUBSTANCIALMENTE_VERDADEIRO -> o essencial confere, mas há imprecisão em detalhe secundário (arredondamento, data, unidade).',
    '   ENGANOSO                    -> o dado existe, mas o número, o recorte, o período ou a conclusão distorcem o que a fonte diz.',
    '   FALSO                       -> a fonte contradiz o dado, ou o dado não existe.',
    '   NAO_VERIFICADO              -> as fontes permitidas não permitem concluir.',
    '- Não comente o desempenho de candidatos, não atribua intenção e não opine sobre política.',
    '- Se a afirmação for uma previsão ou promessa, verifique apenas a parte factual.',
    '- Escreva em português do Brasil, direto, sem jargão.'
  ].join('\n');

  /* ---------------------------------------------------------------- helpers */

  function stripAccents(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function tokenSet(s) {
    var set = Object.create(null);
    stripAccents(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .forEach(function (t) {
        if (t.length < 3 || STOPWORDS.indexOf(t) !== -1) return;
        set[t] = true;
      });
    return set;
  }

  function jaccard(a, b) {
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (!ka.length || !kb.length) return 0;
    var inter = 0;
    ka.forEach(function (k) {
      if (b[k]) inter++;
    });
    return inter / (ka.length + kb.length - inter);
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  // Só a geração 4.6+ aceita thinking adaptativo; Haiku 4.5 ainda usa budget_tokens.
  function supportsAdaptive(model) {
    return !/haiku-4-5/.test(String(model || ''));
  }

  var VERDICT_ALIASES = {
    VERDADE: 'VERDADEIRO',
    VERDADEIRA: 'VERDADEIRO',
    TRUE: 'VERDADEIRO',
    FALSA: 'FALSO',
    FALSE: 'FALSO',
    INVERTIDO: 'FALSO',
    ENGANADOR: 'ENGANOSO',
    DISTORCIDO: 'ENGANOSO',
    SUBSTANCIALMENTE_VERDADEIRA: 'SUBSTANCIALMENTE_VERDADEIRO',
    SUBSTANTIALLY_TRUE: 'SUBSTANCIALMENTE_VERDADEIRO',
    MOSTLY_TRUE: 'SUBSTANCIALMENTE_VERDADEIRO',
    QUASE_VERDADEIRO: 'SUBSTANCIALMENTE_VERDADEIRO',
    PARCIALMENTE_VERDADEIRO: 'SUBSTANCIALMENTE_VERDADEIRO',
    VERDADEIRO_COM_RESSALVA: 'SUBSTANCIALMENTE_VERDADEIRO',
    MISLEADING: 'ENGANOSO',
    IMPRECISO: 'ENGANOSO',
    // Vereditos da versão anterior: agora são casos de ENGANOSO.
    FORA_DE_CONTEXT: 'ENGANOSO',
    FORA_DE_CONTEXTO: 'ENGANOSO',
    DESATUALIZADO: 'ENGANOSO',
    DESATUALIZADA: 'ENGANOSO',
    NAO_CONFIRMADO: 'NAO_VERIFICADO',
    NAO_CHECADO: 'NAO_VERIFICADO',
    UNVERIFIED: 'NAO_VERIFICADO',
    UNVERIFIABLE: 'NAO_VERIFICADO'
  };

  function normalizeVerdict(v) {
    var s = stripAccents(String(v || '')).toUpperCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_').trim();
    s = s.replace(/^_|_$/g, '');
    if (VERDICT_ALIASES[s]) s = VERDICT_ALIASES[s];
    return NB.config.VERDICTS[s] ? s : 'NAO_VERIFICADO';
  }

  function parseJsonLoose(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      var start = text.indexOf('{');
      var end = text.lastIndexOf('}');
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(text.slice(start, end + 1));
        } catch (e2) {
          return null;
        }
      }
      return null;
    }
  }

  function textOf(response) {
    return ((response && response.content) || [])
      .filter(function (b) {
        return b && b.type === 'text';
      })
      .map(function (b) {
        return b.text || '';
      })
      .join('\n')
      .trim();
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /* -------------------------------------------------------------- pipeline */

  function Pipeline(opts) {
    NB.Emitter.call(this);
    this.store = opts.store;
    this.api = opts.api || NB.api;
    this.aborted = false;
    this.inflight = 0;
    this.queue = [];
    this.recent = [];        // {key, tokens, at}
    this.results = [];       // resultados finais (para exportar)
    this.usage = { input: 0, output: 0, searches: 0, calls: 0, cost: 0 };
  }
  Pipeline.prototype = Object.create(NB.Emitter.prototype);
  Pipeline.prototype.constructor = Pipeline;

  Pipeline.prototype.cfg = function () {
    return this.store.state;
  };

  Pipeline.prototype.resetCost = function () {
    this.usage = { input: 0, output: 0, searches: 0, calls: 0, cost: 0 };
    this.emit('usage', this.usage);
  };

  /** Acumula uso normalizado por qualquer provedor: {input, output, searches, cost}. */
  Pipeline.prototype._trackUsage = function (u) {
    if (!u) return;
    var cfg = this.cfg();
    this.usage.input += u.input || 0;
    this.usage.output += u.output || 0;
    this.usage.searches += u.searches || 0;
    this.usage.calls += u.calls == null ? 1 : u.calls;

    var cost = u.cost;
    if (cost == null || !isFinite(cost)) {
      var price = NB.config.priceFor(cfg.provider, cfg.model);
      cost =
        ((u.input || 0) / 1e6) * price[0] +
        ((u.output || 0) / 1e6) * price[1] +
        (u.searches || 0) * NB.config.searchPrice(cfg);
    }
    this.usage.cost += cost || 0;
    this.emit('usage', this.usage);
  };

  /* -------------------------------------------------------------- chamadas */

  function isRetriable(err) {
    return (
      err.status === 408 ||
      err.status === 429 ||
      err.status === 529 ||
      (err.status >= 500 && err.status < 600) ||
      /Failed to fetch|NetworkError|load failed|fetch failed/i.test(err.message || '')
    );
  }

  /**
   * Chamada única com retentativas. Trata pause_turn (Anthropic), finish_reason
   * (OpenRouter) e recusa do modelo.
   */
  Pipeline.prototype._request = async function (body, label, providerId) {
    var cfg = this.cfg();
    var attempts = 0;
    var pause = 0;
    var lastErr = null;
    var current = body;

    while (attempts < 3) {
      attempts++;
      try {
        var res =
          providerId === 'anthropic'
            ? await this.api.messages(cfg, current)
            : providerId === 'gemini'
              ? await this.api.generate(cfg, current)
              : await this.api.chat(cfg, current);

        if (providerId === 'anthropic') {
          if (res.stop_reason === 'pause_turn' && pause < 4) {
            pause++;
            attempts--; // continuar um turno pausado não é uma nova tentativa
            current = Object.assign({}, current, {
              messages: (current.messages || []).concat([{ role: 'assistant', content: res.content }])
            });
            this.emit('log', { level: 'info', msg: label + ': busca longa, continuando turno (' + pause + ')' });
            continue;
          }
          if (res.stop_reason === 'refusal') throw new Error('O modelo recusou esta checagem.');
          if (res.stop_reason === 'max_tokens') {
            throw new Error('Resposta truncada por max_tokens — aumente o limite nas configurações.');
          }
        } else if (providerId === 'gemini') {
          var cand = (res.candidates || [])[0] || {};
          var reason = cand.finishReason || '';
          if (reason === 'MAX_TOKENS') {
            throw new Error('Resposta truncada (MAX_TOKENS) — aumente max_tokens nas configurações.');
          }
          if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT' || reason === 'BLOCKLIST') {
            throw new Error('O Gemini bloqueou esta resposta por política de conteúdo (' + reason + ').');
          }
          if (reason === 'RECITATION') {
            throw new Error('O Gemini recusou por citação de material protegido (RECITATION).');
          }
          if (!cand.content) {
            throw new Error('O Gemini devolveu uma resposta vazia (' + (reason || 'sem candidato') + ').');
          }
        } else {
          var choice = (res.choices || [])[0] || {};
          if (choice.finish_reason === 'length') {
            throw new Error('Resposta truncada (finish_reason=length) — aumente max_tokens nas configurações.');
          }
          if (choice.finish_reason === 'content_filter') {
            throw new Error('O provedor filtrou esta resposta por política de conteúdo.');
          }
          if (choice.error) {
            throw new Error('O provedor devolveu erro: ' + (choice.error.message || JSON.stringify(choice.error)));
          }
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (!isRetriable(err) || attempts >= 3) break;
        var wait = (err.status === 429 ? 4000 : 1200) * attempts;
        this.emit('log', {
          level: 'warn',
          msg: label + ': ' + err.message + ' — retentando em ' + Math.round(wait / 1000) + 's'
        });
        await sleep(wait);
      }
    }
    throw lastErr || new Error('Falha desconhecida');
  };

  Pipeline.prototype._callPlain = function (body, label, providerId) {
    return this._request(body, label, providerId);
  };

  /**
   * Chamada que espera JSON, com degradações automáticas registradas no log.
   * Anthropic: sem output_config, sem thinking, versão de busca antiga.
   * OpenRouter: sem response_format (o modelo devolve JSON no texto).
   */
  Pipeline.prototype._callJson = async function (body, label, providerId) {
    var current = Object.assign({}, body);
    var tries = 0;

    while (true) {
      try {
        return await this._request(current, label, providerId);
      } catch (err) {
        tries++;
        var msg = String(err.message || '');
        if (tries > 3 || (err.status !== 400 && err.status !== 404 && err.status !== 422)) throw err;

        if (providerId === 'anthropic') {
          if (current.output_config && /structured outputs|output_config|json_schema/i.test(msg)) {
            current = Object.assign({}, current);
            delete current.output_config;
            this.emit('log', { level: 'warn', msg: label + ': structured outputs recusado — repetindo sem schema' });
            continue;
          }
          if (current.thinking && /thinking|budget_tokens/i.test(msg)) {
            current = Object.assign({}, current);
            delete current.thinking;
            this.emit('log', { level: 'warn', msg: label + ': raciocínio adaptativo recusado — repetindo sem thinking' });
            continue;
          }
          if (current.tools && current.tools[0] && current.tools[0].type !== 'web_search_20250305' && /web_search/i.test(msg)) {
            var tool = Object.assign({}, current.tools[0], { type: 'web_search_20250305' });
            delete tool.allowed_callers;
            delete tool.response_inclusion;
            current = Object.assign({}, current, { tools: [tool] });
            this.emit('log', { level: 'warn', msg: label + ': versão da busca recusada — repetindo com web_search_20250305' });
            continue;
          }
        } else if (providerId === 'gemini') {
          if (current.generationConfig && current.generationConfig.responseSchema && /schema|response_?schema|invalid/i.test(msg)) {
            current = Object.assign({}, current, {
              generationConfig: Object.assign({}, current.generationConfig)
            });
            delete current.generationConfig.responseSchema;
            this.emit('log', { level: 'warn', msg: label + ': schema do Gemini recusado — repetindo sem responseSchema' });
            continue;
          }
          if (current.generationConfig && current.generationConfig.responseMimeType && /response_?mime|json/i.test(msg)) {
            current = Object.assign({}, current, {
              generationConfig: Object.assign({}, current.generationConfig)
            });
            delete current.generationConfig.responseMimeType;
            this.emit('log', { level: 'warn', msg: label + ': JSON mode recusado — repetindo como texto' });
            continue;
          }
        } else {
          if (current.response_format && /response_format|json_schema|structured/i.test(msg)) {
            current = Object.assign({}, current);
            delete current.response_format;
            this.emit('log', { level: 'warn', msg: label + ': structured outputs recusado — repetindo sem response_format' });
            continue;
          }
        }
        throw err;
      }
    }
  };

  /* ------------------------------------------------------------- etapa 1 */

  Pipeline.prototype.triage = async function (win) {
    var self = this;
    var cfg = this.cfg();
    var provider = NB.providers.get(cfg);

    var ctx = {
      cfg: cfg,
      window: win,
      today: new Date().toLocaleDateString('pt-BR'),
      callJson: function (body, label) {
        return self._callJson(body, label, provider.id);
      },
      callPlain: function (body, label) {
        return self._callPlain(body, label, provider.id);
      },
      emit: function (level, msg) {
        self.emit('log', { level: level, msg: msg });
      }
    };

    this.emit('log', {
      level: 'info',
      msg: 'triagem · ' + win.text.length + ' caracteres · ' + provider.label
    });

    var out = await provider.triage(ctx);
    this._trackUsage(out.usage);

    var data = out.data || {};
    var claims = (data.afirmacoes || [])
      .slice(0, 4) // teto de custo: o prompt pede no máximo 4
      .filter(function (c) {
        return c && c.texto && String(c.texto).trim().length >= (cfg.minClaimChars || 20);
      })
      .map(function (c, i) {
        return {
          id: 'c' + Date.now().toString(36) + i,
          texto: String(c.texto).trim(),
          falante: c.falante || 'não identificado',
          tipo: c.tipo || 'checavel',
          prioridade: clamp(c.prioridade || 2, 1, 3),
          tema: c.tema || 'geral',
          porque: c.porque || '',
          termos: c.termos_busca || '',
          janela: win.id,
          iniciadaEm: win.startedAt,
          contexto: win.tail || '',
          status: 'triada'
        };
      });

    return { claims: claims, comentario: data.comentario || '' };
  };

  /* ------------------------------------------------------------- dedupe */

  Pipeline.prototype._isDuplicate = function (claim) {
    var cfg = this.cfg();
    var now = Date.now();
    var tokens = tokenSet(claim.texto);
    var windowMs = (cfg.dedupeWindow || 120) * 1000;

    this.recent = this.recent.filter(function (r) {
      return now - r.at < windowMs;
    });

    for (var i = 0; i < this.recent.length; i++) {
      if (jaccard(tokens, this.recent[i].tokens) >= 0.62) {
        return this.recent[i];
      }
    }
    this.recent.push({ tokens: tokens, at: now, texto: claim.texto });
    return null;
  };

  /* ------------------------------------------------------------- etapa 2 */

  Pipeline.prototype.verify = async function (claim) {
    var self = this;
    var cfg = this.cfg();
    var provider = NB.providers.get(cfg);
    var domains = this.store.outlets;

    var ctx = {
      cfg: cfg,
      claim: claim,
      outlets: domains,
      today: new Date().toLocaleDateString('pt-BR'),
      callJson: function (body, label) {
        return self._callJson(body, label, provider.id);
      },
      callPlain: function (body, label) {
        return self._callPlain(body, label, provider.id);
      },
      emit: function (level, msg) {
        self.emit('log', { level: level, msg: msg });
      }
    };

    var out = await provider.verify(ctx);
    this._trackUsage(out.usage);

    var audit = NB.audit.auditSources({
      sources: (out.data && out.data.fontes) || [],
      evidence: out.evidence,
      allowed: domains
    });

    var original = normalizeVerdict(out.data.veredito);
    var dec = NB.audit.enforceSourceRule(original, audit);

    return {
      veredito: dec.verdict,
      vereditoOriginal: original,
      rebaixado: dec.downgraded,
      motivoRebaxamento: dec.reason,
      explicacao: String(out.data.explicacao || '').trim(),
      correcao: String(out.data.correcao || '').trim(),
      confianca: clamp(out.data.confianca, 0, 1),
      fontes: audit.items,
      termos: out.data.termos_usados || '',
      consultas: (audit.evidence && audit.evidence.queries) || [],
      errosBusca: (audit.evidence && audit.evidence.errors) || [],
      buscas: audit.searchRequests,
      provedor: provider.id,
      modelo: cfg.model,
      contexto: claim.contexto
    };
  };

  /* -------------------------------------------------------------- orquestra */

  Pipeline.prototype.enqueue = function (claims) {
    var cfg = this.cfg();
    var self = this;
    var accepted = [];

    claims.forEach(function (claim) {
      if (claim.tipo !== 'checavel') {
        self.emit('skipped', { claim: claim, reason: 'não é afirmação checável (' + claim.tipo + ')' });
        return;
      }
      if (claim.prioridade > (cfg.minPriority || 2)) {
        self.emit('skipped', { claim: claim, reason: 'prioridade ' + claim.prioridade + ' abaixo do corte' });
        return;
      }
      var dup = self._isDuplicate(claim);
      if (dup) {
        self.emit('skipped', { claim: claim, reason: 'repetição de "' + dup.texto.slice(0, 60) + '…"' });
        return;
      }
      claim.status = 'na_fila';
      claim.queuedAt = Date.now();
      self.queue.push(claim);
      accepted.push(claim);
      self.emit('claim', claim);
    });

    this.queue.sort(function (a, b) {
      return a.prioridade - b.prioridade || a.queuedAt - b.queuedAt;
    });
    this._drain();
    return accepted;
  };

  Pipeline.prototype._drain = function () {
    var self = this;
    var cfg = this.cfg();
    var limit = clamp(cfg.concurrency || 2, 1, 5);

    while (!this.aborted && this.inflight < limit && this.queue.length) {
      var claim = this.queue.shift();
      this.inflight++;
      this._runOne(claim).finally(function () {
        self.inflight--;
        if (!self.aborted) self._drain();
        self.emit('idle', { inflight: self.inflight, queued: self.queue.length });
      });
    }
  };

  Pipeline.prototype._runOne = async function (claim) {
    var started = Date.now();
    claim.status = 'checando';
    this.emit('checking', claim);
    try {
      var out = await this.verify(claim);
      var finished = Object.assign({}, claim, out, {
        status: 'concluida',
        latencia: Date.now() - started,
        concluidaEm: Date.now()
      });
      this.results.unshift(finished);
      this.emit('result', finished);
      return finished;
    } catch (err) {
      var failed = Object.assign({}, claim, {
        status: 'erro',
        veredito: 'ERRO',
        explicacao: err.message || 'falha na checagem',
        fontes: [],
        confianca: 0,
        latencia: Date.now() - started,
        concluidaEm: Date.now()
      });
      // Sem crédito ou chave inválida: parar a fila inteira em vez de gastar
      // uma tentativa por afirmação para receber o mesmo 402.
      if (err.status === 402 || err.status === 401 || err.grounding) {
        this.aborted = true;
        this.queue = [];
        this.emit('blocked', { message: err.message || String(err), status: err.status });
      }
      this.emit('error', { claim: claim, error: err });
      this.emit('result', failed);
      return failed;
    }
  };

  Pipeline.prototype.retry = function (claim) {
    var copy = Object.assign({}, claim, { status: 'na_fila', queuedAt: Date.now() });
    this.queue.push(copy);
    this._drain();
  };

  Pipeline.prototype.abort = function () {
    this.aborted = true;
    this.queue = [];
  };

  Pipeline.prototype.resume = function () {
    this.aborted = false;
    this._drain();
  };

  NB.Pipeline = Pipeline;
  NB.pipelineUtils = {
    tokenSet: tokenSet,
    jaccard: jaccard,
    normalizeVerdict: normalizeVerdict,
    textOf: textOf,
    parseJsonLoose: parseJsonLoose,
    CLAIM_SCHEMA: CLAIM_SCHEMA,
    VERIFY_SCHEMA: VERIFY_SCHEMA,
    SYSTEM_TRIAGE: SYSTEM_TRIAGE,
    SYSTEM_VERIFY: SYSTEM_VERIFY,
    supportsAdaptive: supportsAdaptive
  };
})(window);
