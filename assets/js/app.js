/* naubert-bot · app.js
 * Amarra reconhecimento de voz -> triagem -> verificação -> tela.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var store = new NB.Store();
  var pipeline = new NB.Pipeline({ store: store });
  var speech = null;
  var demo = null;
  var triageChain = Promise.resolve();
  var healthChecked = false;
  var serverKeyReady = null; // null = ainda não sei
  var wakeLock = null;

  var el = {};

  function $(id) {
    return document.getElementById(id);
  }

  function boot() {
    NB.UI.init(store);
    NB.UI.bindConsole();

    el = {
      btnStart: $('btnStart'),
      btnDemo: $('btnDemo'),
      btnSettings: $('btnSettings'),
      btnExport: $('btnExport'),
      btnFlush: $('btnFlush'),
      btnManual: $('btnManual'),
      btnClearTranscript: $('btnClearTranscript'),
      manualForm: $('manualForm'),
      manualInput: $('manualInput'),
      settingsForm: $('settingsForm'),
      btnResetSettings: $('btnResetSettings'),
      btnTestApi: $('btnTestApi'),
      testApiOut: $('testApiOut'),
      btnDemoEmpty: $('btnDemoEmpty'),
      btnPip: $('btnPip'),
      btnMicTest: $('btnMicTest'),
      micMeter: $('micMeter'),
      micLevel: $('micLevel')
    };

    createSpeech();
    bindSpeech();
    bindPipeline();
    bindChrome();

    NB.UI.fillSettings();
    NB.UI.log('info', 'pronto · ' + (speech.supported() ? 'reconhecimento de voz disponível' : 'sem Web Speech API neste navegador'));

    if (location.protocol === 'file:') {
      NB.UI.log('warn', 'página aberta via file:// — o proxy não funciona neste modo');
      NB.UI.toast('Você abriu o arquivo direto. Rode "npm start" e use http://localhost:8787, ou configure a API no modo direto.', 'warn', 8000);
    }

    checkHealth(true);
  }

  /* -------------------------------------------------------------- speech */

  function createSpeech() {
    speech = new NB.Speech({
      lang: store.state.lang,
      chunkChars: store.state.chunkChars,
      chunkSeconds: store.state.chunkSeconds,
      contextSentences: store.state.contextSentences
    });
  }

  /* ------------------------------------------------------------ microfone */

  var meterTimer = null;

  function paintLevel(v) {
    if (!el.micLevel || !el.micMeter) return;
    el.micMeter.hidden = false;
    el.micLevel.style.width = Math.round(Math.min(1, Math.max(0, v)) * 100) + '%';
  }

  function startMeter() {
    if (meterTimer || !NB.Mic) return;
    NB.Mic.open()
      .then(function (info) {
        NB.UI.transcriptMeta('microfone · ' + info.label);
      })
      .catch(function (err) {
        NB.UI.log('warn', 'não foi possível medir o microfone: ' + (err.message || err));
        return;
      });
    meterTimer = setInterval(function () {
      paintLevel(NB.Mic.level());
    }, 100);
  }

  function stopMeter() {
    clearInterval(meterTimer);
    meterTimer = null;
    if (el.micMeter) el.micMeter.hidden = true;
    if (NB.Mic) NB.Mic.close();
  }

  /**
   * Mede o microfone por 10 s e diz se ele ouviu algo. É o teste que separa
   * "o microfone não está ouvindo o vídeo" de "o serviço do Google não respondeu".
   */
  async function testMic() {
    if (!NB.Mic) {
      NB.UI.toast('Este navegador não expõe o microfone.', 'err', 7000);
      return;
    }
    if (el.btnMicTest) el.btnMicTest.disabled = true;
    var peak = 0;
    try {
      var info = await NB.Mic.open();
      NB.UI.transcriptMeta('medindo o microfone · ' + info.label);
      var started = Date.now();
      await new Promise(function (resolve) {
        var tick = setInterval(function () {
          var v = NB.Mic.level();
          peak = Math.max(peak, v);
          paintLevel(v);
          if (Date.now() - started > 10000) {
            clearInterval(tick);
            resolve();
          }
        }, 100);
      });

      if (peak < 0.06) {
        NB.UI.toast(
          'O microfone não captou som em 10 s. Se o debate está tocando, o áudio não está chegando: ' +
            'confira o dispositivo de entrada no Windows (ícone de som na barra) e se o vídeo está no volume. ' +
            'Com fone de ouvido, o microfone não ouve o vídeo — veja "Mixagem estéreo" no README.',
          'err',
          14000
        );
        NB.UI.log('warn', 'teste de microfone: silêncio (pico ' + Math.round(peak * 100) + '%)');
      } else {
        NB.UI.toast(
          'Microfone ouvindo (pico ' + Math.round(peak * 100) + '% em ' + info.label + '). ' +
            'Se a transcrição continuar vazia com este nível, o problema é o serviço de reconhecimento do Chrome.',
          null,
          10000
        );
        NB.UI.log('ok', 'teste de microfone: sinal ok (pico ' + Math.round(peak * 100) + '%)');
      }
    } catch (err) {
      NB.UI.toast('Não foi possível abrir o microfone: ' + (err.message || err), 'err', 9000);
    } finally {
      if (!speech || !speech.recording) stopMeter();
      if (el.btnMicTest) el.btnMicTest.disabled = false;
    }
  }

  function bindSpeech() {
    speech.on('state', function (s) {
      NB.UI.setMicStatus(!!s.recording, s.label);
      if (s.recording) startMeter();
      else stopMeter();
    });

    speech.on('interim', function (p) {
      NB.UI.transcriptInterim(p.text);
    });

    speech.on('buffer', function (b) {
      if (!b.buffer) return;
      NB.UI.transcriptMeta('janela aberta · ' + b.buffer.length + '/' + store.state.chunkChars + ' caracteres');
    });

    speech.on('segment', function (win) {
      handleSegment(win);
    });

    speech.on('warn', function (e) {
      NB.UI.log('warn', e.message);
      NB.UI.transcriptMeta(e.message);
    });

    speech.on('error', function (e) {
      NB.UI.log('error', e.message);
      NB.UI.toast(e.message, 'err', 9000);
    });
  }

  function handleSegment(win) {
    if (demo && demo.running) {
      NB.UI.log('warn', 'segmento ignorado durante a simulação');
      return;
    }
    NB.UI.transcriptAppend(win.text);
    NB.UI.transcriptMeta('janela ' + win.id + ' · triando…');
    NB.UI.log('info', 'janela ' + win.id + ' fechada por ' + win.reason + ' (' + win.text.length + ' caracteres)');

    if (!isConfigured()) {
      NB.UI.transcriptMeta('janela ' + win.id + ' · sem checagem (API não configurada)');
      return;
    }

    // Triagens em série: mantém a ordem e evita rajadas de chamadas.
    triageChain = triageChain
      .then(function () {
        return pipeline.triage(win);
      })
      .then(function (out) {
        NB.UI.transcriptMeta(
          'janela ' + win.id + ' · ' + out.claims.length + ' afirmação(ões) · ' +
            out.claims.filter(function (c) { return c.tipo === 'checavel'; }).length + ' checável(is)'
        );
        if (out.comentario) NB.UI.log('info', 'triagem: ' + out.comentario);
        pipeline.enqueue(out.claims);
      })
      .catch(function (err) {
        NB.UI.log('error', 'triagem falhou: ' + (err.message || err));
        NB.UI.toast('Triagem falhou: ' + (err.message || err), 'err', 6000);
        NB.UI.transcriptMeta('janela ' + win.id + ' · triagem falhou');
      });
  }

  /* ------------------------------------------------------------ pipeline */

  function bindPipeline() {
    pipeline.on('log', function (l) {
      NB.UI.log(l.level, l.msg);
    });

    pipeline.on('claim', function (claim) {
      NB.UI.addPending(claim);
      NB.UI.log('info', 'na fila · ' + claim.tema + ' · p' + claim.prioridade + ' · ' + claim.texto.slice(0, 70));
    });

    pipeline.on('checking', function (claim) {
      NB.UI.log('info', 'checando · ' + claim.texto.slice(0, 60));
    });

    pipeline.on('skipped', function (s) {
      NB.UI.log('warn', 'descartada (' + s.reason + ') · ' + s.claim.texto.slice(0, 70));
    });

    pipeline.on('result', function (result) {
      consumeResult(result);
    });

    pipeline.on('error', function (p) {
      NB.UI.log('error', 'falha na checagem: ' + (p.error && p.error.message));
    });

    pipeline.on('usage', function (u) {
      NB.UI.updateUsage(u);
    });
  }

  function consumeResult(result) {
    NB.UI.addResult(result);
    NB.UI.pushLatency(result.latencia);
    NB.Pip.update(result);
    syncPipCount();

    if (store.state.autoDuotone) {
      NB.UI.tone(result.veredito, {
        strength: store.state.duotoneStrength,
        hold: store.state.duotoneHold
      });
    }
    NB.UI.showFlash(result);
    NB.UI.addTimeline(result.veredito);
    NB.UI.log(
      result.veredito === 'ERRO' ? 'error' : 'ok',
      (result.veredito || '') + ' · ' + result.texto.slice(0, 60) + ' · ' + Math.round((result.confianca || 0) * 100) + '%'
    );
  }

  /* --------------------------------------------------------------- chrome */

  function bindChrome() {
    el.btnStart.addEventListener('click', toggleListening);

    el.btnDemo.addEventListener('click', function () {
      if (demo && demo.running) {
        stopDemo();
        return;
      }
      startDemo();
    });

    el.btnSettings.addEventListener('click', NB.UI.openSettings);

    el.btnExport.addEventListener('click', function () {
      var results = pipeline.results.slice();
      if (!results.length) {
        NB.UI.toast('Ainda não há checagens para exportar.', 'warn');
        return;
      }
      NB.UI.exportData(results, {
        provider: store.state.provider,
        model: store.state.model,
        search: store.state.provider === 'openrouter'
          ? 'openrouter:web_search · ' + store.state.searchEngine
          : store.state.searchTool,
        domains: store.outlets,
        note: 'checagem assistida por modelo de linguagem'
      });
      NB.UI.toast(results.length + ' checagens exportadas em Markdown e JSON.');
    });

    el.btnFlush.addEventListener('click', function () {
      var win = speech.flush();
      if (!win) NB.UI.toast('Não há texto suficiente na janela atual. Digite ou fale mais.', 'warn');
    });

    el.btnManual.addEventListener('click', function () {
      NB.UI.toggleManual();
    });

    el.manualForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = el.manualInput.value.trim();
      if (!text) return;
      speech.feed(text);
      el.manualInput.value = '';
      NB.UI.transcriptAppend(text);
      NB.UI.transcriptMeta('entrada manual · aguardando fim da janela');
    });

    el.btnClearTranscript.addEventListener('click', function () {
      NB.UI.transcriptClear();
      NB.UI.transcriptMeta('transcrição limpa');
    });

    $('btnDemoEmpty').addEventListener('click', startDemo);

    el.settingsForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      saveSettings();
    });

    var btnClose = $('btnCloseSettings');
    if (btnClose) btnClose.addEventListener('click', NB.UI.closeSettings);

    $('settings').addEventListener('click', function (ev) {
      if (ev.target === this) NB.UI.closeSettings();
    });

    el.btnResetSettings.addEventListener('click', function () {
      store.reset();
      NB.UI.fillSettings();
      NB.UI.renderVideo(store.state);
      applyRuntimeSettings();
      NB.UI.markSaved('padrões restaurados');
    });

    el.btnTestApi.addEventListener('click', testApi);
    if (el.btnMicTest) el.btnMicTest.addEventListener('click', testMic);
    var btnList = $('btnListModels');
    if (btnList) btnList.addEventListener('click', listModels);

    setupPip();
    NB.UI.renderVideo(store.state);
    NB.UI.setMicStatus(false, 'microfone parado');
  }

  /* ------------------------------------------------------------------ pip */

  function setupPip() {
    if (!el.btnPip) return;
    el.btnPip.hidden = !NB.Pip.supported();
    if (!NB.Pip.supported()) return;

    el.btnPip.addEventListener('click', async function () {
      var wasOpen = NB.Pip.isOpen();
      var open = await NB.Pip.toggle();
      syncPipButton();
      if (!open && !wasOpen) {
        NB.UI.toast(
          'Não foi possível abrir a janela flutuante. Ela exige Chrome 116+ e uma aba própria — dentro de um preview embutido o navegador bloqueia. Abra a página em nova aba.',
          'err',
          9000
        );
      }
      if (open) {
        NB.Pip.setCount(document.querySelectorAll('.card').length);
        NB.UI.toast('Janela flutuante aberta. Arraste-a para cima do vídeo do debate — ela fica à frente das outras janelas.', null, 6000);
      }
    });

    setInterval(syncPipButton, 1200);
  }

  /* ------------------------------------------------------------ wake lock */

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        NB.UI.log('info', 'tela mantida acesa durante a escuta');
      }
    } catch (e) {
      /* sem permissão ou sem suporte: segue normalmente */
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      try {
        wakeLock.release();
      } catch (e) {
        /* ignora */
      }
      wakeLock = null;
    }
  }

  function toggleListening() {
    if (demo && demo.running) stopDemo();

    if (speech.recording) {
      speech.stop();
      releaseWakeLock();
      NB.UI.log('info', 'escuta parada');
      return;
    }
    if (!isConfigured()) {
      NB.UI.toast('Configure a API primeiro: sem chave não há checagem.', 'warn', 6000);
      NB.UI.openSettings();
      return;
    }
    if (store.state.apiMode === 'proxy' && serverKeyReady === false) {
      NB.UI.toast(
        'O proxy está sem chave do provedor escolhido. Preencha o .env e reinicie o servidor — ou use o modo direto.',
        'warn',
        7000
      );
      NB.UI.openSettings();
      return;
    }
    var ok = speech.start();
    if (ok) {
      requestWakeLock();
      NB.UI.log('info', 'escuta iniciada · ' + store.state.lang);
      NB.UI.transcriptMeta('ouvindo · janelas de ' + store.state.chunkChars + ' caracteres');
    }
  }

  /* ---------------------------------------------------------------- demo */

  function syncPipCount() {
    NB.Pip.setCount(document.querySelectorAll('.card').length);
  }

  function syncPipButton() {
    var btn = el.btnPip;
    if (!btn || btn.hidden) return;
    var open = NB.Pip.isOpen();
    btn.classList.toggle('is-on', open);
    btn.textContent = open ? 'fechar flutuante' : 'janela flutuante';
  }

  function startDemo() {
    if (speech.recording) speech.stop();
    if (!demo) {
      demo = new NB.demo.Demo({
        transcript: function (line) {
          // A simulação não alimenta o segmentador: nada aqui deve virar chamada real.
          NB.UI.transcriptAppend(line);
          NB.UI.transcriptMeta('simulação · transcrição fictícia');
        },
        pending: function (claim) {
          NB.UI.addPending(claim);
          NB.UI.log('info', 'simulação · na fila · ' + claim.texto.slice(0, 60));
        },
        result: function (result) {
          // Em simulação não há chamada real: não mexe no medidor de custo da API.
          NB.UI.addResult(result);
          NB.UI.pushLatency(result.latencia);
          NB.Pip.update(result);
          syncPipCount();
          if (store.state.autoDuotone) {
            NB.UI.tone(result.veredito, { strength: store.state.duotoneStrength, hold: store.state.duotoneHold });
          }
          NB.UI.showFlash(result);
          NB.UI.addTimeline(result.veredito);
          NB.UI.log('ok', 'simulação · ' + result.veredito + ' · ' + result.texto.slice(0, 50));
        },
        skipped: function (claim, reason) {
          NB.UI.log('warn', 'simulação · descartada (' + reason + ') · ' + claim.texto.slice(0, 50));
        },
        done: function () {
          el.btnDemo.textContent = 'Simulação';
          NB.UI.toast('Simulação encerrada. Nada aqui foi checado de verdade — as fontes são ilustrativas.', 'warn', 7000);
          NB.UI.transcriptMeta('simulação encerrada');
        }
      });
    }
    demo.start();
    el.btnDemo.textContent = 'Parar simulação';
    NB.UI.flashEmpty();
    NB.UI.log('warn', 'modo simulação: conteúdo ilustrativo, sem chamadas à API');
    NB.UI.toast('Simulação: os vereditos são fictícios e servem só para mostrar a tela.', 'warn', 6000);
  }

  function stopDemo() {
    if (demo) demo.stop();
    el.btnDemo.textContent = 'Simulação';
    NB.UI.transcriptMeta('simulação interrompida');
  }

  /* ------------------------------------------------------------ settings */

  function saveSettings() {
    try {
      var read = NB.UI.readSettings();
      store.set(read.patch);
      store.setOutlets(read.domains);
      NB.UI.renderVideo(store.state);
      applyRuntimeSettings();
      healthChecked = false;
      checkHealth();
      NB.UI.closeSettings();
      NB.UI.markSaved('salvo');
      NB.UI.toast('Configurações salvas.', null, 2200);
      NB.UI.log('info', 'configurações salvas · ' + read.domains.length + ' veículos · ' + store.state.searchTool);
    } catch (err) {
      NB.UI.toast(err.message, 'err', 6000);
    }
  }

  function applyRuntimeSettings() {
    var s = store.state;
    speech.setLang(s.lang);
    speech.segmenter.chunkChars = s.chunkChars;
    speech.segmenter.chunkSeconds = s.chunkSeconds;
    speech.segmenter.contextSentences = s.contextSentences;
    NB.UI.transcriptMeta('ouvindo · janelas de ' + s.chunkChars + ' caracteres');
  }

  function isConfigured() {
    var s = store.state;
    if (s.apiMode === 'direct') {
      return s.provider === 'openrouter' ? !!s.openrouterKey : !!s.apiKey;
    }
    return true; // no proxy, a chave está no servidor; a resposta real dirá se falta
  }

  /* -------------------------------------------------------------- health */

  async function checkHealth(quiet) {
    var s = store.state;
    var provider = s.provider;

    if (s.apiMode === 'direct') {
      var hasKey = provider === 'openrouter' ? !!s.openrouterKey : !!s.apiKey;
      serverKeyReady = hasKey;
      NB.UI.setApiStatus(
        hasKey ? 'ok' : 'warn',
        'direto · ' + (hasKey ? 'chave no navegador' : 'sem chave')
      );
      return;
    }

    var h = await NB.api.health(s);
    var info = h && h.providers ? h.providers[provider] : null;
    var configured = info ? !!info.keyConfigured : !!(h && h.keyConfigured);
    serverKeyReady = configured;

    if (h && h.ok && configured) {
      NB.UI.setApiStatus(
        'ok',
        (provider === 'openrouter' ? 'OpenRouter' : 'Anthropic') + ' · chave no servidor'
      );
      NB.UI.log('ok', 'proxy ativo · ' + provider + ' · chave ' + ((info && info.keyMasked) || 'configurada'));
    } else if (h && h.ok && !configured) {
      NB.UI.setApiStatus('warn', 'proxy sem chave (' + provider + ')');
      NB.UI.log(
        'warn',
        'proxy no ar, mas falta ' + (provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY') +
          ' no .env. Preencha e reinicie o servidor.'
      );
      if (!quiet) {
        NB.UI.toast(
          'O proxy está no ar, mas falta a chave do ' + (provider === 'openrouter' ? 'OpenRouter' : 'Anthropic') +
            ' no .env do servidor.',
          'warn',
          6500
        );
      }
    } else {
      NB.UI.setApiStatus('err', 'proxy inacessível');
      if (!healthChecked) {
        NB.UI.log('warn', 'proxy não encontrado (' + ((h && h.detail) || '') + '). Rode "npm start".');
      }
      if (!quiet && !healthChecked) {
        NB.UI.toast('Servidor proxy não encontrado. Rode "npm start" ou use o modo direto nas configurações.', 'warn', 7000);
      }
    }
    healthChecked = true;
  }

  async function testApi() {
    var out = el.testApiOut;
    if (!out) return;
    out.className = 'test-out';
    out.textContent = 'testando…';
    el.btnTestApi.disabled = true;

    try {
      var read = null;
      try {
        read = NB.UI.readSettings();
      } catch (e) {
        read = null;
      }
      var cfg = Object.assign({}, store.state, read ? read.patch : {});
      var isOR = cfg.provider === 'openrouter';

      if (cfg.apiMode === 'proxy') {
        var h = await NB.api.health(cfg);
        if (!h.ok) throw new Error('proxy inacessível: ' + (h.detail || 'sem resposta'));
        var info = h.providers && h.providers[cfg.provider];
        if (info && !info.keyConfigured) {
          throw new Error(
            'proxy no ar, mas falta ' + (isOR ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY') + ' no .env'
          );
        }
      } else {
        if (isOR && !cfg.openrouterKey) throw new Error('informe a chave do OpenRouter para o modo direto');
        if (!isOR && !cfg.apiKey) throw new Error('informe a chave da Anthropic para o modo direto');
      }

      // Chamada mínima de verdade: valida chave, modelo e endpoint.
      if (isOR) {
        var res = await NB.api.chat(cfg, {
          model: cfg.model,
          messages: [{ role: 'user', content: 'Responda apenas: ok' }],
          max_tokens: 16
        });
        var txt = NB.providers.chatText(res);
        out.className = 'test-out ok';
        out.textContent = 'OpenRouter ok · ' + cfg.model + ' · "' + String(txt).slice(0, 20) + '"';
      } else {
        var ares = await NB.api.messages(cfg, {
          model: cfg.model,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Responda apenas: ok' }]
        });
        var block = (ares.content || []).filter(function (b) {
          return b.type === 'text';
        })[0];
        out.className = 'test-out ok';
        out.textContent = 'Anthropic ok · ' + cfg.model + ' · "' + (block ? block.text.slice(0, 20) : '') + '"';
      }
      NB.UI.setApiStatus('ok', cfg.provider + ' · ' + cfg.model);
    } catch (err) {
      out.className = 'test-out err';
      out.textContent = err.message || String(err);
      NB.UI.setApiStatus('err', 'falha na conexão');
      NB.UI.log('error', 'teste de conexão: ' + (err.message || err));
    } finally {
      el.btnTestApi.disabled = false;
    }
  }

  async function listModels() {
    var out = el.testApiOut;
    var btn = $('btnListModels');
    if (!btn) return;
    out.className = 'test-out';
    out.textContent = 'buscando catálogo…';
    btn.disabled = true;
    try {
      var data = await NB.api.models(store.state, '');
      NB.UI.setModelList(data.models || []);
      out.className = 'test-out ok';
      out.textContent = (data.models || []).length + ' modelos carregados no seletor';
      NB.UI.log('info', 'catálogo do OpenRouter: ' + data.total + ' modelos, ' + (data.models || []).length + ' no seletor');
      NB.UI.toast('Modelos carregados. O campo agora sugere os slugs reais — dá para digitar qualquer um.', null, 4500);
    } catch (err) {
      out.className = 'test-out err';
      out.textContent = err.message || String(err);
      NB.UI.log('error', 'não foi possível listar modelos: ' + (err.message || err));
    } finally {
      btn.disabled = false;
    }
  }

  /* --------------------------------------------------------------- start */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.addEventListener('beforeunload', function () {
    if (speech) speech.destroy();
    if (demo) demo.stop();
    NB.Pip.close();
  });

  NB.app = {
    store: store,
    pipeline: pipeline,
    speech: function () {
      return speech;
    },
    checkHealth: checkHealth
  };
})(window);
