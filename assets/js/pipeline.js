/* naubert-bot · pipeline.js
 *
 * Duas etapas, como combinado:
 *
 *   1) TRIAGEM   — recebe a janela de transcrição e separa o que é afirmação checável
 *                  do que é opinião, provocação, previsão ou promessa.
 *   2) VERIFICAÇÃO — para cada afirmação, chama a API com a ferramenta web_search
 *                  restrita por allowed_domains à lista de veículos. O modelo devolve
 *                  veredito + fontes; a auditoria (audit.js) confere se as fontes
 *                  vieram mesmo da busca antes de deixar o veredito passar.
 *
 * Nada aqui é "tempo real": cada janela leva alguns segundos. A UI deve mostrar
 * explicitamente o atraso entre a fala e a checagem.
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
            texto: {
              type: 'string',
              description: 'A afirmação reformulada em uma frase completa, fiel ao que foi dito, em português.'
            },
            falante: {
              type: 'string',
              description: 'Quem disse, se a transcrição permitir identificar. Use "candidato A", "candidato B", "mediador" ou "não identificado". Nunca invente nomes.'
            },
            tipo: {
              type: 'string',
              enum: ['checavel', 'opiniao', 'previsao', 'promessa', 'pergunta', 'ataque_pessoal'],
              description: 'Só "checavel" segue para verificação. Opinião, previsão e promessa não são fatos verificáveis.'
            },
            prioridade: {
              type: 'integer',
              description: '1 = dado central do debate que precisa de checagem imediata; 2 = relevante; 3 = secundário.'
            },
            tema: { type: 'string', description: 'Tema em 1 a 3 palavras: economia, saúde, segurança pública, eleições etc.' },
            porque: { type: 'string', description: 'Por que é (ou não é) checável, em uma frase curta.' },
            termos_busca: {
              type: 'string',
              description: 'Termos-chave para localizar a checagem, sem opinião e sem o nome de quem falou.'
            }
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
        enum: ['VERDADEIRO', 'FALSO', 'ENGANOSO', 'FORA_DE_CONTEXT', 'DESATUALIZADO', 'NAO_VERIFICADO'],
        description: 'Classificação final. Use NAO_VERIFICADO quando a busca restrita não trouxer base suficiente.'
      },
      explicacao: {
        type: 'string',
        description: 'De 1 a 3 frases explicando o que as fontes mostram, em linguagem direta, sem opinião política.'
      },
      correcao: {
        type: 'string',
        description: 'Se houver erro, o dado correto em uma frase. Se a afirmação estiver certa, repita o dado confirmado.'
      },
      confianca: {
        type: 'number',
        description: 'Confiança de 0 a 1 na classificação, considerando a qualidade das fontes.'
      },
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
      termos_usados: {
        type: 'string',
        description: 'As consultas de busca efetivamente usadas, separadas por ponto e vírgula.'
      }
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
    '- Corrija erros evidentes de transcrição só quando o sentido for óbvio (ex.: "trezentos mil" -> "trezentos mil").',
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
    '   VERDADEIRO      -> o dado confere com a fonte, no período e no recorte citados.',
    '   FALSO           -> a fonte contradiz o dado, ou o dado não existe.',
    '   ENGANOSO        -> há um núcleo verdadeiro, mas o número, o recorte ou a conclusão distorcem o que a fonte diz.',
    '   FORA_DE_CONTEXT -> o dado existe, mas se refere a outro período, local, população ou indicador.',
    '   DESATUALIZADO   -> era verdade em outro momento e já foi revisado ou superado.',
    '   NAO_VERIFICADO  -> as fontes permitidas não permitem concluir.',
    '- Não comente o desempenho de candidatos, não atribua intenção e não opine sobre política. Descreva o que a fonte mostra.',
    '- Se a afirmação for uma previsão ou promessa, verifique apenas a parte factual (por exemplo, se o dado de partida existe) e diga isso na explicação.',
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

  var VERDICT_ALIASES = {
    VERDADE: 'VERDADEIRO',
    VERDADEIRA: 'VERDADEIRO',
    TRUE: 'VERDADEIRO',
    FALSA: 'FALSO',
    FALSE: 'FALSO',
    INVERTIDO: 'FALSO',
    ENGANADOR: 'ENGANOSO',
    DISTORCIDO: 'ENGANOSO',
    FORA_DE_CONTEXTO: 'FORA_DE_CONTEXT',
    DESATUALIZADA: 'DESATUALIZADO',
    NAO_CONFIRMADO: 'NAO_VERIFICADO',
    NAO_CHECADO: 'NAO_VERIFICADO',
    UNVERIFIED: 'NAO_VERIFICADO'
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

  // Só a geração 4.6+ aceita thinking adaptativo; Haiku 4.5 ainda usa budget_tokens.
  function supportsAdaptive(model) {
    return !/haiku-4-5/.test(String(model || ''));
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

  Pipeline.prototype._trackUsage = function (response) {
    var u = (response && response.usage) || {};
    var cfg = this.cfg();
    var priceMap = {
      'claude-opus-5-5': [4, 20],
      'claude-opus-5': [5, 25],
      'claude-opus-4-8': [5, 25],
      'claude-opus-4-7': [5, 25],
      'claude-opus-4-6': [5, 25],
      'claude-sonnet-5-5': [2, 10],
      'claude-sonnet-5': [2, 10],
      'claude-sonnet-4-6': [3, 15],
      'claude-haiku-5-5': [0.1, 0.5],
      'claude-haiku-4-5': [1, 5]
    };
    var p = priceMap[cfg.model] || [4, 20];
    var inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    var outTok = u.output_tokens || 0;
    var searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;

    this.usage.input += inTok;
    this.usage.output += outTok;
    this.usage.searches += searches;
    this.usage.calls += 1;
    this.usage.cost += (inTok / 1e6) * p[0] + (outTok / 1e6) * p[1] + searches * 0.01;
    this.emit('usage', this.usage);
  };

  /**
   * Uma chamada com tratamento de pause_turn, refusal, max_tokens e erros transitórios.
   * pause_turn: devolve a resposta pausada como está e continua o mesmo turno.
   */
  Pipeline.prototype._call = async function (body, label) {
    var cfg = this.cfg();
    var tools = body.tools;
    var messages = body.messages.slice();
    var attempts = 0;
    var lastErr = null;
    var pause = 0;

    while (attempts < 3) {
      attempts++;
      try {
        var payload = Object.assign({}, body, { messages: messages, tools: tools });
        var res = await this.api.create(cfg, payload);

        if (res.stop_reason === 'pause_turn' && pause < 4) {
          pause++;
          attempts--; // continuar um turno pausado não é uma nova tentativa
          messages = messages.concat([{ role: 'assistant', content: res.content }]);
          this.emit('log', { level: 'info', msg: label + ': busca longa, continuando turno (' + pause + ')' });
          continue;
        }
        if (res.stop_reason === 'refusal') {
          throw new Error('O modelo recusou esta checagem.');
        }
        if (res.stop_reason === 'max_tokens') {
          throw new Error('Resposta truncada por max_tokens — aumente o limite nas configurações.');
        }
        return res;
      } catch (err) {
        lastErr = err;
        var retriable = err.status === 429 || err.status === 529 || (err.status >= 500 && err.status < 600) ||
          /Failed to fetch|NetworkError|load failed/i.test(err.message || '');
        if (!retriable || attempts >= 3) break;
        var wait = (err.status === 429 ? 4000 : 1200) * attempts;
        this.emit('log', { level: 'warn', msg: label + ': ' + err.message + ' — retentando em ' + Math.round(wait / 1000) + 's' });
        await sleep(wait);
      }
    }
    throw lastErr || new Error('Falha desconhecida');
  };

  /**
   * Chama a API com até três degradações automáticas, todas registradas no log:
   *   1. structured outputs recusado  -> repete sem output_config
   *   2. raciocínio adaptativo recusado -> repete sem thinking
   *   3. versão nova da busca recusada -> repete com web_search_20250305
   * Assim a checagem não para por causa de uma incompatibilidade de modelo/conta.
   */
  Pipeline.prototype._callSchema = async function (body, label) {
    var current = Object.assign({}, body);
    var tries = 0;

    while (true) {
      try {
        return await this._call(current, label);
      } catch (err) {
        tries++;
        var msg = String(err.message || '');
        if (tries > 3 || err.status !== 400) throw err;

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
        throw err;
      }
    }
  };

  /* ------------------------------------------------------------- etapa 1 */

  Pipeline.prototype.triage = async function (win) {
    var cfg = this.cfg();
    var model = cfg.triageModel || cfg.model;
    var body = {
      model: model,
      max_tokens: cfg.maxTokensTriage,
      system: SYSTEM_TRIAGE,
      messages: [
        {
          role: 'user',
          content:
            'Trecho transcrito do debate (pode conter erros de reconhecimento):\n\n' +
            '"""\n' + win.text + '\n"""\n\n' +
            'Liste as afirmações. No máximo 4, priorizando as mais checáveis.'
        }
      ],
      output_config: {
        format: { type: 'json_schema', schema: CLAIM_SCHEMA }
      }
    };
    if (cfg.thinkingTriage === 'adaptive' && supportsAdaptive(model)) body.thinking = { type: 'adaptive' };

    this.emit('log', { level: 'info', msg: 'triagem · ' + win.text.length + ' caracteres' });
    var res = await this._callSchema(body, 'triagem');
    this._trackUsage(res);
    var data = parseJsonLoose(textOf(res)) || { afirmacoes: [], comentario: 'resposta ilegível' };

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
    var cfg = this.cfg();
    var domains = this.store.outlets;

    var tool = {
      type: cfg.searchTool,
      name: 'web_search',
      max_uses: clamp(cfg.maxUses || 4, 1, 15),
      allowed_domains: domains
    };
    if (cfg.searchTool === 'web_search_20260209' || cfg.searchTool === 'web_search_20260318') {
      // Sem código no navegador/servidor, a chamada precisa ser direta.
      tool.allowed_callers = ['direct'];
      if (cfg.searchTool === 'web_search_20260318' && cfg.responseInclusion === 'excluded') {
        tool.response_inclusion = 'excluded';
      }
    }
    if (cfg.userLocation && cfg.userLocation.country) {
      var loc = { type: 'approximate' };
      ['city', 'region', 'country', 'timezone'].forEach(function (k) {
        var v = cfg.userLocation[k] && String(cfg.userLocation[k]).trim();
        if (v) loc[k] = v;
      });
      tool.user_location = loc;
    }

    var userMsg = [
      'Afirmação dita no debate ao vivo:',
      '"""' + claim.texto + '"""',
      '',
      'Quem falou: ' + claim.falante + ' · tema: ' + claim.tema,
      claim.contexto ? '\nContexto imediatamente anterior na transcrição:\n"""' + claim.contexto.slice(-900) + '"""' : '',
      '',
      'Verifique com a busca restrita aos veículos permitidos. Se a data do debate importar, considere que hoje é ' +
        new Date().toLocaleDateString('pt-BR') + '.',
      'Devolva o veredito e cite apenas as matérias que a busca retornou.'
    ].join('\n');

    var body = {
      model: cfg.model,
      max_tokens: cfg.maxTokensVerify,
      system: SYSTEM_VERIFY,
      messages: [{ role: 'user', content: userMsg }],
      tools: [tool],
      output_config: {
        format: { type: 'json_schema', schema: VERIFY_SCHEMA }
      }
    };
    if (cfg.thinkingVerify === 'adaptive' && supportsAdaptive(cfg.model)) body.thinking = { type: 'adaptive' };

    var res = await this._callSchema(body, 'checagem');
    this._trackUsage(res);

    var data = parseJsonLoose(textOf(res));
    if (!data) throw new Error('A resposta da checagem não veio em JSON legível.');

    var audit = NB.audit.auditSources({
      sources: data.fontes || [],
      response: res,
      allowed: domains
    });

    var dec = NB.audit.enforceSourceRule(normalizeVerdict(data.veredito), audit);

    return {
      veredito: dec.verdict,
      vereditoOriginal: normalizeVerdict(data.veredito),
      rebaixado: dec.downgraded,
      motivoRebaxamento: dec.reason,
      explicacao: String(data.explicacao || '').trim(),
      correcao: String(data.correcao || '').trim(),
      confianca: clamp(data.confianca, 0, 1),
      fontes: audit.items,
      termos: data.termos_usados || '',
      consultas: audit.evidence.queries,
      errosBusca: audit.evidence.errors,
      buscas: audit.searchRequests,
      contexto: claim.contexto,
      respostaCrua: res
    };
  };

  /* -------------------------------------------------------------- orquestra */

  /** Enfileira afirmações respeitando prioridade e concorrência. */
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
      this.emit('error', { claim: claim, error: err });
      this.emit('result', failed);
      return failed;
    }
  };

  /** Reexecuta uma checagem específica (botão "tentar de novo"). */
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
