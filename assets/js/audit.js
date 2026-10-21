/* naubert-bot · audit.js
 *
 * A parte que impede fonte inventada.
 *
 * A resposta da API traz, além do texto do modelo:
 *   - blocos server_tool_use          -> as queries que o Claude fez
 *   - blocos web_search_tool_result   -> os resultados que VOLTARAM da busca
 *   - citações web_search_result_location nos blocos text -> o que ele efetivamente citou
 *
 * Com isso dá para responder três perguntas sobre cada fonte que o modelo devolveu:
 *   1. o domínio está na lista de veículos permitida?        (domainOk)
 *   2. essa URL apareceu de fato nos resultados da busca?    (seenInSearch)
 *   3. o modelo a citou formalmente no texto?                (citedByModel)
 *
 * Só "confirmada" quando 1 e 2 valem (3 é o reforço mais forte, mas não obrigatório:
 * o modelo às vezes acerta a URL sem anexar a citação ao trecho).
 * Se nenhuma fonte passa, o veredito é rebaixado para NAO_VERIFICADO.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var TRACKING = /^(utm_|fbclid$|gclid$|ref$|src$|mc_cid$|mc_eid$|amp$)/i;

  /** Normaliza URL para comparação: minúsculas, sem www, sem âncora, sem parâmetros de rastreamento. */
  function normUrl(url) {
    try {
      var u = new URL(String(url));
      var host = u.hostname.replace(/^www\./, '').toLowerCase();
      var path = u.pathname.replace(/\/+$/, '');
      var params = [];
      u.searchParams.forEach(function (v, k) {
        if (!TRACKING.test(k)) params.push(k + '=' + v);
      });
      params.sort();
      return host + path + (params.length ? '?' + params.join('&') : '');
    } catch (e) {
      return String(url || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    }
  }

  function normTitle(t) {
    return String(t || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function pushUnique(arr, v) {
    if (v && arr.indexOf(v) === -1) arr.push(v);
  }

  /**
   * Varre os blocos de conteúdo de uma resposta e coleta tudo o que a busca devolveu.
   * Recursivo porque o filtro dinâmico (web_search_20260209+) aninha os blocos
   * de busca dentro de blocos de code execution.
   */
  function collectEvidence(content) {
    var ev = {
      queries: [],
      results: [],        // {url, title, pageAge}
      citations: [],      // {url, title, citedText}
      errors: [],
      searchRequests: 0
    };
    var seenUrl = Object.create(null);
    var seenCite = Object.create(null);

    function walk(blocks) {
      (blocks || []).forEach(function (b) {
        if (!b || typeof b !== 'object') return;

        // A query que o Claude pediu
        if (b.type === 'server_tool_use' && b.name === 'web_search') {
          if (b.input && b.input.query) pushUnique(ev.queries, b.input.query);
          return;
        }

        // Resultados da busca
        if (b.type === 'web_search_tool_result') {
          var c = b.content;
          if (c && !Array.isArray(c) && c.type === 'web_search_tool_result_error') {
            pushUnique(ev.errors, c.error_code || 'erro_desconhecido');
            return;
          }
          (Array.isArray(c) ? c : []).forEach(function (r) {
            if (!r || r.type !== 'web_search_result' || !r.url) return;
            var key = normUrl(r.url);
            if (seenUrl[key]) return;
            seenUrl[key] = true;
            ev.results.push({ url: r.url, title: r.title || '', pageAge: r.page_age || '' });
          });
          return;
        }

        // Filtro dinâmico: resultados aninhados em execução de código
        if (b.type === 'code_execution_tool_result' && b.content) {
          if (Array.isArray(b.content)) walk(b.content);
          else if (b.content.content && Array.isArray(b.content.content)) walk(b.content.content);
          return;
        }
        if ((b.type === 'code_execution_result' || b.type === 'bash_code_execution_tool_result') && Array.isArray(b.content)) {
          walk(b.content);
          return;
        }

        // Citações anexadas ao texto
        if (b.type === 'text' && Array.isArray(b.citations)) {
          b.citations.forEach(function (cit) {
            if (!cit || !cit.url) return;
            var key = normUrl(cit.url);
            if (seenCite[key]) return;
            seenCite[key] = true;
            ev.citations.push({ url: cit.url, title: cit.title || '', citedText: cit.cited_text || '' });
          });
        }
      });
    }

    walk(content);
    return ev;
  }

  /** Extrai contagem de buscas do campo usage, quando presente. */
  function searchRequests(usage) {
    return (usage && usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  }

  /**
   * Audita as fontes declaradas pelo modelo contra o que a busca realmente devolveu.
   *
   * @param {object} opts
   * @param {Array<{veiculo?:string,titulo?:string,url?:string}>} opts.sources
   * @param {object} [opts.response] resposta crua da Messages API (Anthropic)
   * @param {object} [opts.evidence] evidência já extraída (OpenRouter: anotações)
   * @param {string[]} opts.allowed  lista de domínios permitidos
   * @returns {{items:Array, trusted:number, total:number}}
   */
  function auditSources(opts) {
    var sources = opts.sources || [];
    var allowed = opts.allowed || [];
    var ev = opts.evidence || collectEvidence((opts.response && opts.response.content) || []);

    var seenSet = Object.create(null);
    var titleSet = Object.create(null);
    ev.results.forEach(function (r) {
      seenSet[normUrl(r.url)] = true;
      titleSet[normTitle(r.title)] = true;
    });
    // Citações também contam como "visto na busca": a API só produz citação
    // a partir de um resultado que ela mesma entregou.
    ev.citations.forEach(function (c) {
      seenSet[normUrl(c.url)] = true;
    });
    var citedSet = Object.create(null);
    ev.citations.forEach(function (c) {
      citedSet[normUrl(c.url)] = true;
    });

    var items = sources.map(function (s) {
      var url = String((s && s.url) || '').trim();
      var title = String((s && s.titulo) || (s && s.title) || '').trim();
      var host = url ? NB.outlets.hostOf(url) : '';
      var item = {
        url: url,
        titulo: title,
        veiculo: (s && s.veiculo) || (url ? NB.outlets.outletName(url) : ''),
        data: (s && s.data) || '',
        trecho: (s && s.trecho) || '',
        host: host,
        domainOk: false,
        seenInSearch: false,
        citedByModel: false,
        status: 'invalida',
        motivo: 'URL ausente'
      };

      if (!url || !/^https?:\/\//i.test(url)) {
        item.status = 'invalida';
        item.motivo = 'URL ausente ou malformada';
        return item;
      }

      item.domainOk = NB.outlets.matchesAllowed(url, allowed);
      item.seenInSearch = !!seenSet[normUrl(url)] || (title ? !!titleSet[normTitle(title)] : false);
      item.citedByModel = !!citedSet[normUrl(url)];

      if (!item.domainOk) {
        item.status = 'fora_da_lista';
        item.motivo = item.host + ' não está em allowed_domains';
      } else if (!item.seenInSearch) {
        item.status = 'nao_vista_na_busca';
        item.motivo = 'não apareceu nos resultados desta busca — fonte possivelmente inventada';
      } else {
        item.status = 'confirmada';
        item.motivo = item.citedByModel
          ? 'na lista e citada pelo modelo'
          : 'na lista e presente nos resultados da busca';
      }
      return item;
    });

    var trusted = items.filter(function (i) {
      return i.status === 'confirmada';
    }).length;

    return {
      items: items,
      trusted: trusted,
      total: items.length,
      evidence: ev,
      // evidência pré-extraída (OpenRouter) já traz a contagem de buscas
      searchRequests: ev.searchRequests || searchRequests(opts.response && opts.response.usage)
    };
  }

  /**
   * Rebaixa vereditos que não têm nenhuma fonte confirmada.
   * É o freio de segurança: sem fonte auditada, não se afirma nem verdade nem mentira.
   */
  function enforceSourceRule(verdict, audit) {
    var v = String(verdict || '').toUpperCase();
    var needsSource = v === 'VERDADEIRO' || v === 'FALSO' || v === 'ENGANOSO' ||
      v === 'FORA_DE_CONTEXT' || v === 'DESATUALIZADO';

    if (!needsSource) {
      return { verdict: v, downgraded: false, reason: '' };
    }
    if (audit.trusted > 0) {
      return { verdict: v, downgraded: false, reason: '' };
    }
    var reason = audit.total === 0
      ? 'nenhuma fonte declarada'
      : (audit.items[0] && audit.items[0].status === 'fora_da_lista'
        ? 'fontes fora da lista de veículos'
        : 'fontes não confirmadas na busca restrita');
    return { verdict: 'NAO_VERIFICADO', downgraded: true, reason: reason };
  }

  NB.audit = {
    normUrl: normUrl,
    normTitle: normTitle,
    collectEvidence: collectEvidence,
    auditSources: auditSources,
    enforceSourceRule: enforceSourceRule
  };
})(window);
