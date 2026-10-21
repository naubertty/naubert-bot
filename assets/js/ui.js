/* naubert-bot · ui.js
 * Camada de apresentação: palco, duotone, cartões, painel de custo, log, ajustes.
 * Não conhece a API nem o reconhecimento de voz — só desenha o que o app.js manda.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var UI = {};
  var el = {};
  var store = null;
  var toneTimer = null;
  var holdTimer = null;
  var toastTimer = null;
  var acc = { calls: 0, searches: 0, cost: 0, latencies: [] };
  var filter = 'all';
  var pendingCards = Object.create(null);
  var cardCount = 0;

  /* ------------------------------------------------------------- helpers */

  function $(id) {
    return document.getElementById(id);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Só http(s) vira link: fonte com esquema estranho não deve ser clicável.
  function safeHref(url) {
    return /^https?:\/\//i.test(String(url || '')) ? String(url) : '#';
  }

  function hhmmss(d) {
    d = d || new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(function (n) {
        return String(n).padStart(2, '0');
      })
      .join(':');
  }

  function brl(n) {
    return 'US$ ' + Number(n || 0).toFixed(2).replace('.', ',');
  }

  function secs(ms) {
    if (!ms) return '—';
    var s = ms / 1000;
    return (s < 10 ? s.toFixed(1) : Math.round(s)) + ' s';
  }

  function verdictMeta(v) {
    return NB.config.VERDICTS[v] || NB.config.VERDICTS.NAO_VERIFICADO;
  }

  function toneOf(v) {
    return verdictMeta(v).tone;
  }

  function youtubeId(url) {
    var m = String(url || '').match(
      /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/
    );
    return m ? m[1] : null;
  }

  /* ---------------------------------------------------------------- init */

  UI.init = function (theStore) {
    store = theStore;
    el = {
      apiDot: $('apiDot'),
      apiLabel: $('apiLabel'),
      micDot: $('micDot'),
      micLabel: $('micLabel'),
      clock: $('clock'),
      btnStart: $('btnStart'),
      btnDemo: $('btnDemo'),
      btnSettings: $('btnSettings'),
      btnExport: $('btnExport'),
      videoFrame: $('videoFrame'),
      videoMedia: $('videoMedia'),
      frameSource: $('frameSource'),
      flash: $('flash'),
      timeline: $('timeline'),
      holdIndicator: $('holdIndicator'),
      tMeta: $('tMeta'),
      tFinal: $('tFinal'),
      tInterim: $('tInterim'),
      tCaret: $('tCaret'),
      transcriptBody: $('transcriptBody'),
      btnFlush: $('btnFlush'),
      btnManual: $('btnManual'),
      btnClearTranscript: $('btnClearTranscript'),
      manualForm: $('manualForm'),
      manualInput: $('manualInput'),
      railList: $('railList'),
      railEmpty: $('railEmpty'),
      railCount: $('railCount'),
      filters: $('filters'),
      uCalls: $('uCalls'),
      uSearches: $('uSearches'),
      uCost: $('uCost'),
      uLatency: $('uLatency'),
      console: $('console'),
      consoleToggle: $('consoleToggle'),
      consoleBody: $('consoleBody'),
      consoleHint: $('consoleHint'),
      toast: $('toast'),
      settings: $('settings'),
      settingsForm: $('settingsForm')
    };

    populateDatalist(store.state.provider);
    populateSearchSelects();
    buildPresets();

    setInterval(function () {
      el.clock.textContent = hhmmss();
    }, 1000);
    el.clock.textContent = hhmmss();

    el.uCost.textContent = brl(0);
    UI.renderVideo(store.state);
    bindFilters();
    bindSettingsChrome();
  };

  function populateDatalist(provider) {
    var dl = $('modelOptions');
    if (!dl) return;
    dl.innerHTML = NB.config
      .modelPresets(provider)
      .map(function (m) {
        return '<option value="' + esc(m.id) + '">' + esc(m.label + ' · ' + m.note) + '</option>';
      })
      .join('');
  }

  /** Preenche o datalist com o catálogo real vindo do OpenRouter. */
  UI.setModelList = function (models) {
    var dl = $('modelOptions');
    if (!dl) return;
    dl.innerHTML = (models || [])
      .map(function (m) {
        var price = '';
        if (isFinite(m.prompt) && isFinite(m.completion) && m.prompt >= 0) {
          price =
            ' · US$ ' + (m.prompt * 1e6).toFixed(2) + ' / ' + (m.completion * 1e6).toFixed(2) + ' por milhão';
        }
        return '<option value="' + esc(m.id) + '">' + esc((m.name || m.id) + price) + '</option>';
      })
      .join('');
  };

  function populateSearchSelects() {
    var engine = $('f-searchEngine');
    if (engine) {
      engine.innerHTML = NB.config.SEARCH_ENGINES.map(function (t) {
        return '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>';
      }).join('');
    }
    var tool = $('f-searchTool');
    if (tool) {
      tool.innerHTML = NB.config.SEARCH_TOOLS.map(function (t) {
        return '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>';
      }).join('');
    }
  }

  function buildPresets() {
    var box = $('presets');
    if (!box) return;
    box.innerHTML = Object.keys(NB.outlets.PRESETS)
      .map(function (key) {
        var p = NB.outlets.PRESETS[key];
        return (
          '<button type="button" class="preset" data-preset="' + esc(key) + '" title="' +
          esc(p.domains.join(', ')) + '">+ ' + esc(p.label) + ' (' + p.domains.length + ')</button>'
        );
      })
      .join('');

    box.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-preset]');
      if (!btn) return;
      var preset = NB.outlets.PRESETS[btn.dataset.preset];
      if (!preset) return;
      var ta = $('f-domains');
      var current = NB.outlets.parseList(ta.value);
      preset.domains.forEach(function (d) {
        if (current.indexOf(d) === -1) current.push(d);
      });
      ta.value = NB.outlets.toText(current);
      updateDomainCount();
    });

    var ta = $('f-domains');
    ta.addEventListener('input', updateDomainCount);
  }

  function updateDomainCount() {
    var list = NB.outlets.parseList($('f-domains').value);
    var warn = $('domainWarn');
    $('domainCount').textContent = list.length;
    if (list.length > NB.config.DOMAIN_HARD) {
      warn.hidden = false;
      warn.className = 'help help-warn';
      warn.textContent =
        'Lista muito longa (' + list.length + ' domínios): a API pode recusar a busca com request_too_large. Reduza para menos de ' +
        NB.config.DOMAIN_WARN + '.';
    } else if (list.length > NB.config.DOMAIN_WARN) {
      warn.hidden = false;
      warn.className = 'help help-warn';
      warn.textContent =
        'Lista extensa (' + list.length + ' domínios). Funciona, mas aumenta o risco de request_too_large e de resultados rasos.';
    } else {
      warn.hidden = true;
    }
  }

  /* ------------------------------------------------------------- conexão */

  UI.setApiStatus = function (kind, text) {
    if (!el.apiDot) return;
    el.apiDot.className = 'dot ' + (kind || '');
    el.apiLabel.textContent = text;
  };

  UI.setMicStatus = function (recording, text) {
    if (!el.micDot) return;
    el.micDot.className = 'dot ' + (recording ? 'live' : '');
    el.micLabel.textContent = text || (recording ? 'ouvindo' : 'microfone parado');
    el.btnStart.classList.toggle('is-recording', !!recording);
    el.btnStart.querySelector('span').textContent = recording ? 'Parar escuta' : 'Iniciar escuta';
    el.tCaret.classList.toggle('on', !!recording);
  };

  /* -------------------------------------------------------------- vídeo */

  UI.renderVideo = function (cfg) {
    if (!el.videoMedia) return;
    var url = String(cfg.videoUrl || '').trim();
    var mode = cfg.videoMode || 'embed';
    var id = youtubeId(url);
    var isGlobo = /globoplay\.globo\.com|globo\.com/.test(url);

    if (!url) {
      el.videoMedia.innerHTML = placeholder(
        'aguardando transmissão',
        'Debate ao vivo',
        'Cole o link do YouTube nas configurações. A Globo Play não permite incorporar o player — deixe o debate aberto em outra janela e use esta tela como sobreposição.',
        '<a class="ph-btn" href="https://globoplay.globo.com/" target="_blank" rel="noopener">abrir Globo Play ↗</a>' +
          '<button class="ph-btn" type="button" data-open-settings>colar link do vídeo</button>'
      );
      el.frameSource.textContent = 'fonte do vídeo não definida';
      bindPlaceholderButtons();
      return;
    }

    if (mode === 'off') {
      el.videoMedia.innerHTML = placeholder('modo painel', 'Vídeo desligado', 'O painel de checagens continua funcionando sem a imagem.', '');
      el.frameSource.textContent = 'sem vídeo';
      return;
    }

    if (mode === 'external' || isGlobo || !id) {
      var label = isGlobo ? 'Globo Play' : NB.outlets.outletName(url);
      el.videoMedia.innerHTML = placeholder(
        'fonte externa',
        isGlobo ? 'Globo Play' : 'Transmissão',
        isGlobo
          ? 'O player da Globo Play não pode ser embutido em outra página. Abra a transmissão em outra janela e posicione esta tela ao lado — o duotone continua reagindo aos vereditos.'
          : 'Este link não é de um vídeo incorporável. Abra a transmissão em outra janela e use esta tela como sobreposição.',
        '<a class="ph-btn" href="' + esc(safeHref(url)) + '" target="_blank" rel="noopener">abrir transmissão ↗</a>' +
          '<button class="ph-btn" type="button" data-open-settings>trocar fonte</button>'
      );
      el.frameSource.textContent = label + ' · janela externa';
      bindPlaceholderButtons();
      return;
    }

    el.videoMedia.innerHTML =
      '<iframe src="https://www.youtube-nocookie.com/embed/' +
      esc(id) +
      '?autoplay=1&rel=0&modestbranding=1" title="Transmissão do debate" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>';
    el.frameSource.textContent = 'YouTube · incorporado';
  };

  function placeholder(kicker, title, sub, actions) {
    return (
      '<div class="ph"><div class="ph-inner">' +
      '<div class="eq"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
      '<span class="ph-kicker">' + esc(kicker) + '</span>' +
      '<h1 class="ph-title">' + esc(title) + '</h1>' +
      '<p class="ph-sub">' + esc(sub) + '</p>' +
      (actions ? '<div class="ph-actions">' + actions + '</div>' : '') +
      '</div></div>'
    );
  }

  function bindPlaceholderButtons() {
    var btn = el.videoMedia.querySelector('[data-open-settings]');
    if (btn) btn.addEventListener('click', UI.openSettings);
  }

  /* ------------------------------------------------------------ duotone */

  UI.tone = function (verdict, opts) {
    opts = opts || {};
    var meta = verdictMeta(verdict);
    var frame = el.videoFrame;
    frame.dataset.tone = meta.tone;
    // A cor do duotone vem do catálogo (mais saturada que a do cartão).
    frame.style.setProperty('--tone', meta.duotone || meta.cssVar);
    frame.style.setProperty('--tone-strength', String((opts.strength != null ? opts.strength : 0.85)));

    clearTimeout(toneTimer);
    clearTimeout(holdTimer);

    var hold = opts.hold != null ? opts.hold : 14;
    if (hold > 0) {
      var left = Math.round(hold);
      el.holdIndicator.hidden = false;
      el.holdIndicator.textContent = 'duotone ' + left + 's';
      holdTimer = setInterval(function () {
        left -= 1;
        if (left <= 0) {
          clearInterval(holdTimer);
          el.holdIndicator.hidden = true;
          return;
        }
        el.holdIndicator.textContent = 'duotone ' + left + 's';
      }, 1000);
      toneTimer = setTimeout(function () {
        UI.clearTone();
      }, hold * 1000);
    } else {
      el.holdIndicator.hidden = true;
    }
  };

  UI.clearTone = function () {
    clearTimeout(toneTimer);
    clearInterval(holdTimer);
    if (el.videoFrame) {
      el.videoFrame.dataset.tone = 'idle';
      el.videoFrame.style.removeProperty('--tone');
    }
    if (el.holdIndicator) el.holdIndicator.hidden = true;
  };

  UI.currentTone = function () {
    return el.videoFrame ? el.videoFrame.dataset.tone : 'idle';
  };

  /* -------------------------------------------------------------- flash */

  UI.showFlash = function (result) {
    if (!el.flash) return;
    var meta = verdictMeta(result.veredito);
    var conf = Math.round((result.confianca || 0) * 100);
    var src = (result.fontes || []).filter(function (f) {
      return f.status === 'confirmada';
    })[0];
    var anySrc = src || (result.fontes || [])[0];

    el.flash.style.setProperty('--flash-tone', meta.cssVar);
    el.flash.innerHTML =
      '<div class="flash-top">' +
        '<span class="flash-badge">' + esc(meta.label) + '</span>' +
        '<span class="flash-theme">' + esc(result.tema || '') + (result.simulacao ? ' · simulação' : '') + '</span>' +
        '<span class="flash-conf">confiança ' + conf + '%</span>' +
      '</div>' +
      '<p class="flash-claim">' + esc(result.texto || '') + '</p>' +
      (result.correcao ? '<p class="flash-corr">' + esc(result.correcao) + '</p>' : '') +
      (anySrc
        ? '<a class="flash-source" href="' + esc(safeHref(anySrc.url)) + '" target="_blank" rel="noopener">' +
            '<span class="fs-outlet">' + esc(anySrc.veiculo) + '</span>' +
            '<span class="fs-title">' + esc(anySrc.titulo || anySrc.url) + '</span>' +
          '</a>'
        : '<div class="flash-source"><span class="fs-outlet" style="color:var(--misleading);border-color:rgba(245,158,11,.4)">sem fonte</span><span class="fs-title">nenhuma fonte passou na auditoria</span></div>') +
      '<div class="flash-meta">' +
        (src
          ? '<span class="ok">✓ fonte confirmada na busca</span>'
          : '<span class="warn">⚠ fonte não confirmada</span>') +
        '<span>·</span><span>' + esc(secs(result.latencia)) + ' após a fala</span>' +
        (result.rebaixado ? '<span class="bad">· veredito rebaixado pela auditoria</span>' : '') +
      '</div>';

    el.flash.classList.remove('is-new');
    void el.flash.offsetWidth;
    el.flash.classList.add('is-new');
  };

  UI.flashEmpty = function () {
    if (!el.flash) return;
    el.flash.style.removeProperty('--flash-tone');
    el.flash.innerHTML =
      '<div class="flash-empty"><span class="fe-kicker">em espera</span>' +
      '<p>Inicie a escuta ou rode a simulação.<br>O primeiro veredito aparece aqui.</p></div>';
  };

  /* ----------------------------------------------------------- timeline */

  UI.addTimeline = function (verdict) {
    if (!el.timeline) return;
    var i = document.createElement('i');
    i.style.background = verdictMeta(verdict).cssVar;
    i.title = verdictMeta(verdict).label;
    el.timeline.appendChild(i);
    while (el.timeline.children.length > 28) el.timeline.removeChild(el.timeline.firstChild);
  };

  /* ---------------------------------------------------------- transcrição */

  var lastFinal = '';

  UI.transcriptAppend = function (text) {
    var clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    lastFinal = (lastFinal ? lastFinal + ' ' : '') + clean;
    if (lastFinal.length > 2400) lastFinal = lastFinal.slice(-2400);
    el.tFinal.textContent = lastFinal;
    el.tInterim.textContent = '';
    scrollTranscript();
  };

  UI.transcriptInterim = function (text) {
    el.tInterim.textContent = text ? ' ' + text : '';
    scrollTranscript();
  };

  UI.transcriptMeta = function (text) {
    el.tMeta.textContent = text;
  };

  UI.transcriptClear = function () {
    lastFinal = '';
    el.tFinal.textContent = '';
    el.tInterim.textContent = '';
  };

  function scrollTranscript() {
    el.transcriptBody.scrollTop = el.transcriptBody.scrollHeight;
  }

  UI.toggleManual = function (force) {
    var show = force != null ? force : el.manualForm.hidden;
    el.manualForm.hidden = !show;
    if (show) el.manualInput.focus();
  };

  /* -------------------------------------------------------------- cards */

  UI.addPending = function (claim) {
    if (el.railEmpty) el.railEmpty.hidden = true;
    var id = 'card-' + claim.id;
    var card = document.createElement('article');
    card.className = 'card is-pending';
    card.id = id;
    card.dataset.verdict = 'PENDENTE';
    card.dataset.filter = 'outros';
    card.innerHTML =
      '<div class="card-head">' +
        '<span class="vbadge pending-dots">CHECANDO</span>' +
        '<span class="card-theme">' + esc(claim.tema || 'geral') + '</span>' +
        '<span class="card-time">' + hhmmss() + '</span>' +
      '</div>' +
      '<p class="card-claim">' + esc(claim.texto) + '</p>' +
      '<p class="card-why">' + esc(claim.falante || 'falante não identificado') +
        ' · prioridade ' + esc(claim.prioridade) + '</p>';
    el.railList.insertBefore(card, el.railList.firstChild);
    pendingCards[claim.id] = card;
    cardCount++;
    updateCount();
    applyFilterToCard(card);
  };

  UI.addResult = function (result) {
    var old = pendingCards[result.id];
    if (old) {
      old.remove();
      delete pendingCards[result.id];
      cardCount--;
    }
    if (el.railEmpty) el.railEmpty.hidden = true;

    var meta = verdictMeta(result.veredito);
    var card = document.createElement('article');
    card.className = 'card';
    card.dataset.verdict = result.veredito;
    card.dataset.filter = result.veredito === 'VERDADEIRO' || result.veredito === 'FALSO' ? result.veredito : 'outros';
    if (result.demo) card.dataset.demo = '1';

    var fontes = result.fontes || [];
    var srcHtml = fontes
      .slice(0, 4)
      .map(function (f) {
        var flag = f.status === 'confirmada'
          ? '<span class="src-flag ok">confirmada</span>'
          : f.status === 'fora_da_lista'
            ? '<span class="src-flag bad">fora da lista</span>'
            : '<span class="src-flag warn">não vista</span>';
        return (
          '<a class="src" href="' + esc(safeHref(f.url)) + '" target="_blank" rel="noopener" title="' + esc(f.motivo || '') + '">' +
            '<span class="src-outlet">' + esc(f.veiculo || NB.outlets.outletName(f.url)) + '</span>' +
            '<span class="src-title">' + esc(f.titulo || f.url) + '</span>' +
            flag +
          '</a>'
        );
      })
      .join('');

    var auditLine = fontes.length
      ? fontes.length + ' fonte(s) · ' + fontes.filter(function (f) { return f.status === 'confirmada'; }).length + ' confirmada(s) na busca'
      : 'nenhuma fonte devolvida';

    var detailBits = [];
    if (result.consultas && result.consultas.length) {
      detailBits.push('consultas: ' + result.consultas.map(function (q) { return '<code>' + esc(q) + '</code>'; }).join(' '));
    }
    if (result.termos) detailBits.push('termos do modelo: <code>' + esc(result.termos) + '</code>');
    if (result.buscas) detailBits.push('buscas cobradas: <code>' + esc(result.buscas) + '</code>');
    if (result.vereditoOriginal && result.vereditoOriginal !== result.veredito) {
      detailBits.push('veredito original: <code>' + esc(result.vereditoOriginal) + '</code> — ' + esc(result.motivoRebaxamento || ''));
    }
    if (result.errosBusca && result.errosBusca.length) detailBits.push('erros da busca: <code>' + esc(result.errosBusca.join(', ')) + '</code>');

    card.innerHTML =
      '<div class="card-head">' +
        '<span class="vbadge">' + esc(meta.label) + '</span>' +
        '<span class="card-theme">' + esc(result.tema || 'geral') + (result.simulacao ? ' · simulação' : '') + '</span>' +
        '<span class="card-time">' + hhmmss() + '</span>' +
      '</div>' +
      '<p class="card-claim">' + esc(result.texto) +
        ' <span class="card-speaker">— ' + esc(result.falante || 'não identificado') + '</span></p>' +
      '<p class="card-why"><strong>' + esc(meta.label.toLowerCase()) + ':</strong> ' + esc(result.explicacao || '') + '</p>' +
      (result.correcao && result.correcao !== result.explicacao
        ? '<p class="card-why" style="margin-top:6px;color:var(--text-mute)">' + esc(result.correcao) + '</p>'
        : '') +
      (srcHtml ? '<div class="card-srcs">' + srcHtml + '</div>' : '') +
      '<div class="card-foot">' +
        '<span>' + esc(auditLine) + '</span>' +
        '<span class="lat">· ' + esc(secs(result.latencia)) + '</span>' +
        '<span>· ' + Math.round((result.confianca || 0) * 100) + '%</span>' +
        '<button class="retry" type="button" data-retry="' + esc(result.id) + '">rechecar</button>' +
      '</div>' +
      (detailBits.length
        ? '<details class="card-detail"><summary>como esta checagem foi feita</summary><p>' + detailBits.join('<br>') + '</p></details>'
        : '');

    el.railList.insertBefore(card, el.railList.firstChild);
    cardCount++;
    updateCount();
    applyFilterToCard(card);
    return card;
  };

  UI.getFiltered = function () {
    return filter;
  };

  function updateCount() {
    if (el.railCount) el.railCount.textContent = String(cardCount);
  }

  UI.resetRail = function () {
    el.railList.querySelectorAll('.card').forEach(function (c) {
      c.remove();
    });
    pendingCards = Object.create(null);
    cardCount = 0;
    updateCount();
    if (el.railEmpty) el.railEmpty.hidden = false;
  };

  function bindFilters() {
    el.filters.addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-filter]');
      if (!btn) return;
      filter = btn.dataset.filter;
      el.filters.querySelectorAll('.chip').forEach(function (c) {
        c.classList.toggle('is-on', c === btn);
      });
      el.railList.querySelectorAll('.card').forEach(applyFilterToCard);
    });
  }

  function applyFilterToCard(card) {
    var show = filter === 'all' || card.dataset.filter === filter;
    card.style.display = show ? '' : 'none';
  }

  /* --------------------------------------------------------------- usage */

  UI.resetUsage = function () {
    acc = { calls: 0, searches: 0, cost: 0, latencies: [] };
    renderUsage();
  };

  UI.updateUsage = function (usage) {
    acc.calls = usage.calls || 0;
    acc.searches = usage.searches || 0;
    acc.cost = usage.cost || 0;
    renderUsage();
  };

  UI.pushLatency = function (ms) {
    if (!ms) return;
    acc.latencies.push(ms);
    renderUsage();
  };

  function renderUsage() {
    if (!el.uCalls) return;
    el.uCalls.textContent = String(acc.calls);
    el.uSearches.textContent = String(acc.searches);
    el.uCost.textContent = brl(acc.cost);
    var avg = acc.latencies.length
      ? acc.latencies.reduce(function (a, b) { return a + b; }, 0) / acc.latencies.length
      : 0;
    el.uLatency.textContent = avg ? secs(avg) : '—';
  }

  /* ----------------------------------------------------------------- log */

  UI.log = function (level, msg) {
    if (!el.consoleBody) return;
    var line = document.createElement('div');
    line.className = 'console-line';
    line.innerHTML =
      '<time>' + hhmmss() + '</time>' +
      '<span class="lv ' + esc(level) + '">' + esc(level) + '</span>' +
      '<span class="msg">' + esc(msg) + '</span>';
    el.consoleBody.appendChild(line);
    while (el.consoleBody.children.length > 300) el.consoleBody.removeChild(el.consoleBody.firstChild);
    el.consoleBody.scrollTop = el.consoleBody.scrollHeight;
    if (level === 'error') el.consoleHint.textContent = msg.slice(0, 90);
  };

  UI.bindConsole = function () {
    el.consoleToggle.addEventListener('click', function () {
      var open = el.consoleToggle.getAttribute('aria-expanded') === 'true';
      el.consoleToggle.setAttribute('aria-expanded', String(!open));
      el.consoleBody.hidden = open;
    });
  };

  /* --------------------------------------------------------------- toast */

  UI.toast = function (msg, kind, ms) {
    if (!el.toast) return;
    clearTimeout(toastTimer);
    el.toast.hidden = false;
    el.toast.className = 'toast ' + (kind || '');
    el.toast.textContent = msg;
    toastTimer = setTimeout(function () {
      el.toast.hidden = true;
    }, ms || 4200);
  };

  /* ------------------------------------------------------------ settings */

  UI.fillSettings = function () {
    var s = store.state;
    $('f-provider').value = s.provider;
    $('f-apiMode').value = s.apiMode;
    $('f-proxyBase').value = s.proxyBase || '';
    $('f-proxyToken').value = s.proxyToken || '';
    $('f-apiKey').value = s.apiKey || '';
    $('f-openrouterKey').value = s.openrouterKey || '';
    $('f-model').value = s.model || '';
    $('f-triageModel').value = s.triageModel || '';
    $('f-judgeModel').value = s.judgeModel || '';
    $('f-betaHeader').value = s.betaHeader || '';
    $('f-thinkingVerify').value = s.thinkingVerify || 'none';
    $('f-searchEngine').value = s.searchEngine || 'auto';
    $('f-searchTool').value = s.searchTool;
    $('f-maxResults').value = s.maxResults || 5;
    $('f-maxUses').value = s.maxUses;
    $('f-orReferer').value = s.orReferer || '';
    $('f-domains').value = NB.outlets.toText(store.outlets);
    $('f-locCity').value = s.userLocation.city || '';
    $('f-locRegion').value = s.userLocation.region || '';
    $('f-locCountry').value = s.userLocation.country || '';
    $('f-locTz').value = s.userLocation.timezone || '';
    $('f-chunkChars').value = s.chunkChars;
    $('f-chunkSeconds').value = s.chunkSeconds;
    $('f-concurrency').value = String(s.concurrency);
    $('f-minPriority').value = String(s.minPriority);
    $('f-lang').value = s.lang;
    $('f-videoUrl').value = s.videoUrl || '';
    $('f-videoMode').value = s.videoMode;
    $('f-duotoneStrength').value = Math.round((s.duotoneStrength || 0.85) * 100);
    $('f-duotoneHold').value = s.duotoneHold;
    $('f-autoDuotone').checked = !!s.autoDuotone;
    populateDatalist(s.provider);
    syncSettingsChrome();
    updateDomainCount();
  };

  function syncSettingsChrome() {
    var provider = $('f-provider').value;
    var direct = $('f-apiMode').value === 'direct';
    var isOR = provider === 'openrouter';

    $('rowApiKey').hidden = !(direct && !isOR);
    $('rowOpenrouterKey').hidden = !(direct && isOR);
    $('rowSearchEngine').hidden = !isOR;
    $('rowSearchTool').hidden = isOR;
    $('rowMaxResults').hidden = !isOR;
    $('judgeField').hidden = !isOR;
    $('rowBetaHeader').hidden = isOR;
    $('btnListModels').hidden = !isOR;

    $('searchHelp').innerHTML = isOR
      ? 'No OpenRouter a lista vira <code>allowed_domains</code> da ferramenta de busca. O filtro funciona em ' +
        'Exa, Parallel, Perplexity, Firecrawl e na busca nativa de Anthropic e OpenAI. Com busca nativa do ' +
        'Google o filtro não é aplicado — o sistema percebe e marca as fontes fora da lista.'
      : 'Na Anthropic a lista vira <code>allowed_domains</code> da web_search. Domínio puro, sem ' +
        '<code>https://</code>; subdomínios entram automaticamente.';

    $('chunkCharsVal').textContent = $('f-chunkChars').value;
    $('chunkSecondsVal').textContent = $('f-chunkSeconds').value;
    $('duotoneVal').textContent = $('f-duotoneStrength').value + '%';
    $('duotoneHoldVal').textContent = $('f-duotoneHold').value;
  }

  function bindSettingsChrome() {
    ['f-chunkChars', 'f-chunkSeconds', 'f-duotoneStrength', 'f-duotoneHold'].forEach(function (id) {
      $(id).addEventListener('input', syncSettingsChrome);
    });
    $('f-apiMode').addEventListener('change', syncSettingsChrome);

    $('f-provider').addEventListener('change', function () {
      var provider = this.value;
      populateDatalist(provider);
      var current = $('f-model').value.trim();
      var looksOpenRouter = current.indexOf('/') !== -1;
      if (!current || (provider === 'openrouter') !== looksOpenRouter) {
        $('f-model').value = NB.providers.get({ provider: provider }).defaultModel;
        $('f-triageModel').value = provider === 'openrouter' ? 'anthropic/claude-haiku-5.5' : '';
      }
      syncSettingsChrome();
    });

    $('f-searchEngine').addEventListener('change', function () {
      var chosen = NB.config.SEARCH_ENGINES.filter(function (t) {
        return t.id === this.value;
      }.bind(this))[0];
      if (chosen) UI.log('info', 'motor de busca: ' + chosen.note);
    });
  }

  UI.readSettings = function () {
    var domains = NB.outlets.parseList($('f-domains').value);
    if (domains.length === 0) throw new Error('A lista de veículos está vazia — a busca restrita não funcionaria.');
    if (domains.length > NB.config.DOMAIN_HARD) {
      throw new Error('Lista com ' + domains.length + ' domínios: reduza para menos de ' + NB.config.DOMAIN_HARD + ' para evitar request_too_large.');
    }
    var country = ($('f-locCountry').value || '').trim().toUpperCase();
    if (country && country.length !== 2) throw new Error('O país deve ser o código de duas letras (BR, PT, US).');

    var provider = $('f-provider').value;
    var model = $('f-model').value.trim();
    if (!model) throw new Error('Informe o modelo.');
    if (provider === 'openrouter' && model.indexOf('/') === -1) {
      throw new Error('No OpenRouter o modelo tem o formato "autor/nome", por exemplo anthropic/claude-opus-5.5.');
    }
    if (provider === 'anthropic' && model.indexOf('/') !== -1) {
      throw new Error('Na Anthropic o modelo não leva barra: use claude-opus-5-5, por exemplo.');
    }

    var patch = {
      provider: provider,
      apiMode: $('f-apiMode').value,
      proxyBase: $('f-proxyBase').value.trim(),
      proxyToken: $('f-proxyToken').value.trim(),
      apiKey: $('f-apiKey').value.trim(),
      openrouterKey: $('f-openrouterKey').value.trim(),
      orReferer: $('f-orReferer').value.trim(),
      model: model,
      triageModel: $('f-triageModel').value.trim(),
      judgeModel: $('f-judgeModel').value.trim(),
      betaHeader: $('f-betaHeader').value.trim(),
      thinkingVerify: $('f-thinkingVerify').value,
      searchEngine: $('f-searchEngine').value,
      searchTool: $('f-searchTool').value,
      maxResults: Number($('f-maxResults').value) || 5,
      maxUses: Number($('f-maxUses').value) || 4,
      chunkChars: Number($('f-chunkChars').value),
      chunkSeconds: Number($('f-chunkSeconds').value),
      concurrency: Number($('f-concurrency').value),
      minPriority: Number($('f-minPriority').value),
      lang: $('f-lang').value,
      videoUrl: $('f-videoUrl').value.trim(),
      videoMode: $('f-videoMode').value,
      duotoneStrength: Number($('f-duotoneStrength').value) / 100,
      duotoneHold: Number($('f-duotoneHold').value),
      autoDuotone: $('f-autoDuotone').checked,
      userLocation: {
        city: $('f-locCity').value.trim(),
        region: $('f-locRegion').value.trim(),
        country: country,
        timezone: $('f-locTz').value.trim()
      }
    };
    return { patch: patch, domains: domains };
  };

  UI.openSettings = function () {
    UI.fillSettings();
    var note = $('saveNote');
    if (note) note.textContent = '';
    if (typeof el.settings.showModal === 'function') el.settings.showModal();
    else el.settings.setAttribute('open', '');
  };

  UI.closeSettings = function () {
    if (typeof el.settings.close === 'function') el.settings.close();
    else el.settings.removeAttribute('open');
  };

  /* -------------------------------------------------------------- export */

  UI.exportData = function (results, meta) {
    var rows = results || [];
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    var md = [];
    md.push('# Checagem ao vivo — registro');
    md.push('');
    md.push('- Gerado em: ' + new Date().toLocaleString('pt-BR'));
    md.push('- Provedor: ' + (meta.provider || 'anthropic'));
    md.push('- Modelo: ' + meta.model);
    md.push('- Busca: ' + (meta.search || meta.searchTool));
    md.push('- Veículos permitidos: ' + meta.domains.length);
    md.push('- Aviso: checagem assistida por modelo de linguagem. O atraso entre a fala e o veredito está registrado em cada item. Confira a fonte antes de publicar.');
    if (rows.some(function (r) { return r.simulacao; })) {
      md.push('- Este arquivo contém itens de SIMULAÇÃO (marcados no corpo). Eles não foram checados.');
    }
    md.push('');
    rows.forEach(function (r) {
      md.push('## ' + (NB.config.VERDICTS[r.veredito] || { label: r.veredito }).label + ' — ' + r.texto);
      md.push('');
      md.push('- Falante: ' + (r.falante || 'não identificado'));
      md.push('- Tema: ' + (r.tema || '—'));
      md.push('- Confiança: ' + Math.round((r.confianca || 0) * 100) + '%');
      md.push('- Latência: ' + secs(r.latencia));
      md.push('- Explicação: ' + (r.explicacao || '—'));
      if (r.simulacao) md.push('- ATENÇÃO: item de simulação, conteúdo ilustrativo, não checado');
      if (r.correcao) md.push('- Correção: ' + r.correcao);
      (r.fontes || []).forEach(function (f) {
        md.push('- Fonte [' + f.status + ']: ' + f.veiculo + ' — ' + f.titulo + ' — ' + f.url);
      });
      if (r.consultas && r.consultas.length) md.push('- Consultas: ' + r.consultas.join(' | '));
      md.push('');
    });

    var blobMd = new Blob([md.join('\n')], { type: 'text/markdown;charset=utf-8' });
    var blobJson = new Blob([JSON.stringify({ meta: meta, generatedAt: new Date().toISOString(), results: rows }, null, 2)], {
      type: 'application/json'
    });

    download(blobMd, 'checagem-' + stamp + '.md');
    setTimeout(function () {
      download(blobJson, 'checagem-' + stamp + '.json');
    }, 250);
  };

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 2000);
  }

  UI.markSaved = function (text) {
    var note = $('saveNote');
    if (!note) return;
    note.textContent = text || 'salvo';
    setTimeout(function () {
      if (note.textContent === (text || 'salvo')) note.textContent = '';
    }, 2600);
  };

  NB.UI = UI;
})(window);
