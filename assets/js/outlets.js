/* naubert-bot · outlets.js
 * Listas de veículos usadas no parâmetro allowed_domains da web search.
 * Regras da API: domínio puro, sem esquema (use "g1.globo.com", não "https://g1.globo.com"),
 * subdomínios são incluídos automaticamente e subcaminhos são aceitos ("g1.globo.com/fato-ou-fake").
 * allowed_domains e blocked_domains são mutuamente exclusivos.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var PRESETS = {
    checagem: {
      label: 'Agências de checagem',
      domains: [
        'lupa.uol.com.br',
        'aosfatos.org',
        'projetocomprova.com.br',
        'agenciapublica.org',
        'boatos.org',
        'confere.estadao.com.br',
        'g1.globo.com'
      ]
    },
    imprensa: {
      label: 'Grande imprensa BR',
      domains: [
        'g1.globo.com',
        'oglobo.globo.com',
        'valor.globo.com',
        'folha.uol.com.br',
        'noticias.uol.com.br',
        'estadao.com.br',
        'cnnbrasil.com.br',
        'veja.abril.com.br',
        'exame.com',
        'valor.globo.com',
        'gazetadopovo.com.br',
        'cartacapital.com.br',
        'correiobraziliense.com.br',
        'r7.com'
      ]
    },
    oficial: {
      label: 'Dados oficiais',
      domains: [
        'gov.br',
        'ibge.gov.br',
        'ipea.gov.br',
        'inep.gov.br',
        'tse.jus.br',
        'stf.jus.br',
        'stj.jus.br',
        'bcb.gov.br',
        'portaltransparencia.gov.br',
        'cgu.gov.br',
        'datasus.saude.gov.br'
      ]
    },
    internacional: {
      label: 'Internacional',
      domains: [
        'reuters.com',
        'bbc.com',
        'bbc.co.uk',
        'elpais.com',
        'publico.pt',
        'dw.com',
        'theguardian.com',
        'nytimes.com'
      ]
    },
    economia: {
      label: 'Economia',
      domains: [
        'valor.globo.com',
        'infomoney.com.br',
        'exame.com',
        'estadao.com.br',
        'bcb.gov.br',
        'ibge.gov.br'
      ]
    }
  };

  // Conjunto inicial: checagem + imprensa + oficial, sem duplicatas.
  var DEFAULT_LIST = [
    'lupa.uol.com.br',
    'aosfatos.org',
    'projetocomprova.com.br',
    'agenciapublica.org',
    'g1.globo.com',
    'folha.uol.com.br',
    'noticias.uol.com.br',
    'estadao.com.br',
    'cnnbrasil.com.br',
    'veja.abril.com.br',
    'exame.com',
    'valor.globo.com',
    'gazetadopovo.com.br',
    'cartacapital.com.br',
    'gov.br',
    'ibge.gov.br',
    'ipea.gov.br',
    'tse.jus.br',
    'stf.jus.br',
    'bcb.gov.br',
    'reuters.com',
    'bbc.com'
  ];

  /* -------------------------------------------------------------- parsing */

  // Aceita "https://g1.globo.com/fato-ou-fake/", "www.folha.uol.com.br", "g1.globo.com".
  // Mantém subcaminho, remove esquema, www., barra final, porta, query e fragmento.
  function normalizeDomain(raw) {
    var s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z]+:\/\//, '');        // esquema
    s = s.replace(/^\/+/, '');                 // barras iniciais
    s = s.split(/[?#]/)[0];                    // query/fragmento
    s = s.replace(/\/$/, '');                  // barra final
    s = s.replace(/^www\./, '');               // www canônico
    if (!s) return '';
    // Rejeita entradas que claramente não são um host.
    if (!/^[a-z0-9.-]+(\.[a-z]{2,})(\/|$)/.test(s) && s.indexOf('.') === -1) return '';
    return s;
  }

  function parseList(text) {
    var seen = Object.create(null);
    var out = [];
    String(text || '')
      .split(/[\s,;]+/)
      .forEach(function (piece) {
        if (!piece) return;
        var d = normalizeDomain(piece);
        if (!d || seen[d]) return;
        seen[d] = true;
        out.push(d);
      });
    return out;
  }

  function toText(list) {
    return (list || []).join('\n');
  }

  /** Extrai o host (sem www.) de uma URL qualquer. */
  function hostOf(url) {
    try {
      return String(new URL(url).hostname).replace(/^www\./, '').toLowerCase();
    } catch (e) {
      var m = String(url || '').match(/^(?:[a-z]+:\/\/)?([^/?#]+)/i);
      return m ? m[1].replace(/^www\./, '').toLowerCase() : '';
    }
  }

  /**
   * Um host está coberto por uma entrada da lista?
   * Replica a regra da API: "g1.globo.com" cobre "qualquer-coisa.g1.globo.com",
   * e uma entrada com subcaminho ("g1.globo.com/fato-ou-fake") cobre só aquele caminho.
   */
  function matchesAllowed(url, allowedList) {
    var host = hostOf(url);
    if (!host) return false;
    var pathname = '';
    try {
      pathname = new URL(url).pathname || '';
    } catch (e) {
      pathname = '';
    }
    for (var i = 0; i < allowedList.length; i++) {
      var entry = allowedList[i];
      var slash = entry.indexOf('/');
      var base = slash === -1 ? entry : entry.slice(0, slash);
      var sub = slash === -1 ? '' : entry.slice(slash);
      if (host === base || host.endsWith('.' + base)) {
        if (!sub) return true;
        if (pathname === sub || pathname.indexOf(sub + '/') === 0) return true;
      }
    }
    return false;
  }

  /** Nome legível do veículo a partir do host. */
  function outletName(url) {
    var host = hostOf(url);
    var map = {
      'g1.globo.com': 'g1',
      'globo.com': 'O Globo',
      'folha.uol.com.br': 'Folha de S.Paulo',
      'uol.com.br': 'UOL',
      'lupa.uol.com.br': 'Agência Lupa',
      'estadao.com.br': 'Estadão',
      'confere.estadao.com.br': 'Estadão Verifica',
      'veja.abril.com.br': 'Veja',
      'exame.com': 'Exame',
      'valor.globo.com': 'Valor',
      'gazetadopovo.com.br': 'Gazeta do Povo',
      'cartacapital.com.br': 'CartaCapital',
      'correiobraziliense.com.br': 'Correio Braziliense',
      'cnnbrasil.com.br': 'CNN Brasil',
      'r7.com': 'R7',
      'aosfatos.org': 'Aos Fatos',
      'projetocomprova.com.br': 'Comprova',
      'agenciapublica.org': 'Agência Pública',
      'boatos.org': 'Boatos.org',
      'gov.br': 'gov.br',
      'ibge.gov.br': 'IBGE',
      'ipea.gov.br': 'IPEA',
      'inep.gov.br': 'INEP',
      'tse.jus.br': 'TSE',
      'stf.jus.br': 'STF',
      'stj.jus.br': 'STJ',
      'bcb.gov.br': 'Banco Central',
      'portaltransparencia.gov.br': 'Portal da Transparência',
      'cgu.gov.br': 'CGU',
      'datasus.saude.gov.br': 'DataSUS',
      'reuters.com': 'Reuters',
      'bbc.com': 'BBC',
      'bbc.co.uk': 'BBC',
      'elpais.com': 'El País',
      'publico.pt': 'Público',
      'dw.com': 'DW',
      'theguardian.com': 'The Guardian',
      'nytimes.com': 'The New York Times',
      'infomoney.com.br': 'InfoMoney'
    };
    if (map[host]) return map[host];
    var parts = host.split('.');
    if (parts.length >= 2) {
      var core = parts[parts.length - 2];
      return core.charAt(0).toUpperCase() + core.slice(1);
    }
    return host;
  }

  NB.outlets = {
    PRESETS: PRESETS,
    DEFAULT_LIST: DEFAULT_LIST,
    normalizeDomain: normalizeDomain,
    parseList: parseList,
    toText: toText,
    hostOf: hostOf,
    matchesAllowed: matchesAllowed,
    outletName: outletName
  };
})(window);
