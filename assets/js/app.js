/* naubert-bot · app.js
 * Amarra reconhecimento de voz -> triagem -> verificação -> tela.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var store = new NB.Store();
  var pipeline = new NB.Pipeline({ store: store });
  var speech = null;
  var tabAudio = null;
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
      creditBanner: $('creditBanner'),
      creditBannerTitle: $('creditBannerTitle'),
      creditBannerText: $('creditBannerText'),
      btnCheckCredits: $('btnCheckCredits'),
      btnDismissCredit: $('btnDismissCredit'),
      micMeter: $('micMeter'),
      micLevel: $('micLevel')
    };

    createSpeech();
    bindSpeech();
    bindPipeline();
    bindChrome();

    NB.UI.fillSettings();
    NB.UI.log('info', 'pronto · ' + (speech.supported() ? 'reconhecimento de voz disponível' : 'sem Web Speech API neste navegador'));

    if (store.migrated) {
      NB.UI.log('info', 'configuração migrada para o Gemini — confira a chave em Configurações');
      NB.UI.toast('O provedor padrão agora é o Gemini. Se ainda não tem a chave, abra Configurações → Chave do Gemini.', 'warn', 8000);
    }

    if (location.protocol === 'file:') {
      NB.UI.log('warn', 'página aberta via file:// — o proxy não funciona neste modo');
      NB.UI.toast('Você abriu o arquivo direto. Rode "npm start" e use http://localhost:8787, ou configure a API no modo direto.', 'warn', 8000);
    }

    checkHealth(true);
    if (typeof checkCredits === 'function') setTimeout(function () { checkCredits(true); }, 1200);
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

  function levelNow() {
    if (tabAudio && tabAudio.recording) return tabAudio.level();
    return NB.Mic ? NB.Mic.level() : 0;
  }

  function startMeter() {
    if (meterTimer) return;
    if (!(tabAudio && tabAudio.recording) && NB.Mic) {
      NB.Mic.open()
        .then(function (info) {
          NB.UI.transcriptMeta('microfone · ' + info.label);
        })
        .catch(function (err) {
          NB.UI.log('warn', 'não foi possível medir o microfone: ' + (err.message || err));
        });
    }
    meterTimer = setInterval(function () {
      paintLevel(levelNow());
    }, 100);
  }

  function stopMeter() {
    clearInterval(meterTimer);
    meterTimer = null;
    if (el.micMeter) el.micMeter.hidden = true;
    if (!(tabAudio && tabAudio.recording) && NB.Mic) NB.Mic.close();
  }

  var watchTimer = null;
  var watchStartedAt = 0;
  var watchWarned = false;
  var sawAnyText = false;

  function startWatchdog() {
    stopWatchdog();
    watchStartedAt = Date.now();
    watchWarned = false;
    sawAnyText = false;
    watchTimer = setInterval(function () {
      if (!speech.recording) return;
      var secs = Math.round((Date.now() - watchStartedAt) / 1000);
      var st = typeof speech.status === 'function' ? speech.status() : {};

      if (st.sinceResult !== null && st.sinceResult !== undefined && st.sinceResult < 60000) sawAnyText = true;

      if (sawAnyText) {
        if (secs > 20 && !watchWarned && st.sinceResult > 12000) {
          watchWarned = true;
          NB.UI.log('warn', 'silêncio de ' + Math.round(st.sinceResult / 1000) + ' s desde a última fala reconhecida');
        }
        return;
      }

      NB.UI.transcriptMeta('ouvindo há ' + secs + ' s · nenhuma fala reconhecida ainda');

      if (secs >= 25 && !watchWarned) {
        watchWarned = true;
        showMicHelp(true);
        NB.UI.log(
          'warn',
          'o microfone recebe áudio (veja o medidor) mas o Chrome não reconhece voz em ' +
            secs +
            ' s — típico de áudio de alto-falante cancelado pelo controle de eco'
        );
        NB.UI.toast(
          'O medidor mostra áudio, mas o Chrome não reconhece fala há 25 s. Isso é o controle de eco ' +
            'tratando o som do vídeo como eco. Abri as opções abaixo da transcrição — o caminho é o ' +
            'VB-Cable (loopback), que entrega o áudio do debate direto ao Chrome. Enquanto isso, a ' +
            'entrada manual funciona.',
          'err',
          18000
        );
      }
    }, 2000);
  }

  function stopWatchdog() {
    clearInterval(watchTimer);
    watchTimer = null;
    watchWarned = false;
    sawAnyText = false;
  }

  function showMicHelp(show) {
    var panel = $('micHelp');
    if (!panel) return;
    panel.hidden = !show;
    if (show) panel.open = true;
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

      var devices = await NB.Mic.devices();
      if (devices.length) {
        NB.UI.log(
          'info',
          'entradas de áudio do sistema: ' +
            devices
              .map(function (d) {
                return d.label;
              })
              .join(' · ')
        );
      }

      if (peak < 0.06) {
        showMicHelp(true);
        NB.UI.toast(
          'Nenhum som chegou em ' + info.label + ' durante 10 s. O Chrome transcreve o microfone ' +
            'padrão do sistema — não o áudio da aba. Abri as opções abaixo da transcrição: o caminho ' +
            'confiável é o VB-Cable (loopback), porque alto-falante + cancelamento de eco do Chrome ' +
            'apaga justamente o som do vídeo.',
          'err',
          16000
        );
        NB.UI.log('warn', 'teste de microfone: silêncio (pico ' + Math.round(peak * 100) + '%)');
      } else {
        showMicHelp(false);
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

  /* ---------------------------------------------------------- áudio da aba */

  function ensureTabAudio() {
    if (tabAudio) return tabAudio;
    if (!NB.TabAudio) return null;
    tabAudio = new NB.TabAudio({
      cfg: function () {
        return store.state;
      },
      chunkSeconds: store.state.audioChunkSeconds || 6
    });

    tabAudio.on('state', function (s) {
      NB.UI.setMicStatus(!!s.recording, s.label);
      if (s.recording) startMeter();
      else stopMeter();
    });

    tabAudio.on('chunk', function (c) {
      NB.UI.log('info', 'trecho de ' + c.seconds.toFixed(1) + ' s enviado à transcrição (' + Math.round(c.bytes / 1024) + ' KB)');
    });

    tabAudio.on('text', function (t) {
      sawAnyText = true;
      if (watchWarned) showMicHelp(false);
      NB.UI.log('ok', 'transcrito · ' + t.text.length + ' caracteres em ' + t.seconds.toFixed(1) + ' s de áudio');
      // Entra no mesmo segmentador da fala: daqui para frente o pipeline é o mesmo.
      speech.feed(t.text);
      var cost = (t.usage && typeof t.usage.cost === 'number') ? t.usage.cost : t.seconds * NB.config.sttPrice(store.state);
      pipeline._trackUsage({ cost: cost, calls: 1 });
    });

    tabAudio.on('silence', function (s) {
      if (tabAudio.skipped % 5 === 1) {
        NB.UI.log('info', 'trecho de ' + s.seconds.toFixed(0) + ' s em silêncio descartado');
      }
    });

    tabAudio.on('warn', function (w) {
      NB.UI.log('warn', w.message);
    });

    tabAudio.on('fatal', function (e) {
      NB.UI.log('error', e.message);
      stopListening();
      showCreditBanner(
        e.status === 402 ? 'Sem créditos no OpenRouter' : 'Chave do OpenRouter recusada',
        e.message + ' A transcrição e as checagens param até isso ser resolvido.'
      );
      NB.UI.toast(e.message, 'err', 15000);
    });

    tabAudio.on('error', function (e) {
      NB.UI.log('error', e.message);
      if (/402|crédito|cr[eé]dito/i.test(e.message)) {
        showCreditBanner('Sem créditos no OpenRouter', e.message);
      }
      NB.UI.toast(e.message, 'err', 9000);
    });

    return tabAudio;
  }

  async function startTabListening() {
    if (!NB.TabAudio || !NB.TabAudio.supported()) {
      NB.UI.toast(
        'Este navegador não captura o áudio da aba. Use Chrome ou Edge atualizados, com a página em http://localhost.',
        'err',
        8000
      );
      return;
    }
    var tab = ensureTabAudio();
    tab.chunkSeconds = store.state.audioChunkSeconds || 6;
    if (el.btnMicTest) el.btnMicTest.hidden = true;
    try {
      await tab.start();
      requestWakeLock();
      var sttUsed = /^gemini/.test(store.state.sttModel || '') ? store.state.sttModel : store.state.provider === 'gemini' ? store.state.model : store.state.sttModel;
      NB.UI.log('info', 'captura de aba ativa · trechos de ' + tab.chunkSeconds + ' s · ' + sttUsed);
      NB.UI.transcriptMeta('ouvindo o áudio da aba · trechos de ' + tab.chunkSeconds + ' s');
      NB.UI.toast(
        'Capturando o áudio da aba. Deixe o vídeo do debate tocando — de preferência nesta aba, com o som ligado.',
        null,
        8000
      );
    } catch (err) {
      NB.UI.log('error', 'captura de aba recusada: ' + (err.message || err));
      NB.UI.toast(err.message || String(err), 'err', 12000);
    }
  }

  /* --------------------------------------------------------- crédito */

  function showCreditBanner(title, text, kind) {
    if (!el.creditBanner) return;
    el.creditBanner.hidden = false;
    el.creditBanner.classList.toggle('is-ok', kind === 'ok');
    el.creditBannerTitle.textContent = title;
    el.creditBannerText.textContent = text;
  }

  function hideCreditBanner() {
    if (el.creditBanner) el.creditBanner.hidden = true;
  }

  /** Consulta /api/v1/key: uso do dia/mês e, se a chave tem teto, o que resta. */
  async function checkCredits(quiet) {
    // A faixa de crédito é do OpenRouter; com outro provider ela só confunde.
    if (store.state.provider !== 'openrouter') {
      hideCreditBanner();
      return null;
    }
    try {
      var data = await NB.api.keyInfo(store.state);
      var parts = [];
      if (data.limitRemaining != null) parts.push('resta US$ ' + Number(data.limitRemaining).toFixed(2) + ' do limite da chave');
      if (data.usage != null) parts.push('usado US$ ' + Number(data.usage).toFixed(2) + ' no total');
      if (data.usageDaily != null) parts.push('US$ ' + Number(data.usageDaily).toFixed(2) + ' hoje');
      if (!parts.length) parts.push('chave válida; o OpenRouter não informou limite nem uso');

      var exhausted = data.limitRemaining != null && Number(data.limitRemaining) <= 0;
      if (exhausted) {
        showCreditBanner(
          'O limite desta chave acabou',
          'OpenRouter: ' + parts.join(' · ') + '. Ajuste o limite da chave ou adicione crédito em openrouter.ai/credits.'
        );
        NB.UI.log('warn', 'saldo · ' + parts.join(' · '));
        return false;
      }
      NB.UI.log('ok', 'saldo · ' + parts.join(' · '));
      if (!quiet) {
        NB.UI.toast('OpenRouter: ' + parts.join(' · ') + '.', data.is_free_tier ? 'warn' : null, 9000);
      }
      if (el.creditBanner && !el.creditBanner.hidden && el.creditBanner.classList.contains('is-ok') === false) {
        hideCreditBanner();
      }
      return true;
    } catch (err) {
      NB.UI.log('warn', 'não deu para consultar o saldo: ' + (err.message || err));
      if (!quiet) NB.UI.toast('Não deu para consultar o saldo: ' + (err.message || err), 'err', 8000);
      return null;
    }
  }

  function bindSpeech() {
    speech.on('state', function (s) {
      NB.UI.setMicStatus(!!s.recording, s.label);
      if (s.recording) {
        startMeter();
        startWatchdog();
      } else {
        stopMeter();
        stopWatchdog();
      }
    });

    speech.on('interim', function (p) {
      if (p.text) sawAnyText = true;
      NB.UI.transcriptInterim(p.text);
    });

    speech.on('buffer', function (b) {
      if (!b.buffer) return;
      sawAnyText = true;
      NB.UI.transcriptPending(b.buffer);
      NB.UI.transcriptMeta('janela aberta · ' + b.buffer.length + '/' + store.state.chunkChars + ' caracteres');
    });

    speech.on('segment', function (win) {
      sawAnyText = true;
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

    // 402/401 param a fila inteira: avisa uma vez, sem repetir por afirmação.
    pipeline.on('blocked', function (b) {
      showCreditBanner(
        b.status === 402 ? 'Sem créditos no OpenRouter' : 'Chave do OpenRouter recusada',
        b.message + ' A fila foi interrompida para não repetir a mesma falha em cada afirmação.'
      );
      NB.UI.toast(b.message, 'err', 15000);
      if (isListening()) stopListening();
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
          : store.state.provider === 'gemini'
            ? 'gemini:google_search (sem filtro de domínio)'
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
    if (el.btnCheckCredits) el.btnCheckCredits.addEventListener('click', function () { checkCredits(false); });
    if (el.btnDismissCredit) el.btnDismissCredit.addEventListener('click', hideCreditBanner);
    var btnList = $('btnListModels');
    if (btnList) btnList.addEventListener('click', listModels);

    setupPip();
    NB.UI.renderVideo(store.state);
    NB.UI.setMicStatus(false, 'microfone parado');
    if (el.btnMicTest) el.btnMicTest.hidden = store.state.transcribeMode === 'tab';
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

  function isListening() {
    return !!(speech.recording || (tabAudio && tabAudio.recording));
  }

  function stopListening() {
    if (speech.recording) speech.stop();
    if (tabAudio && tabAudio.recording) tabAudio.stop();
    stopWatchdog();
    releaseWakeLock();
  }

  function toggleListening() {
    if (demo && demo.running) stopDemo();

    if (isListening()) {
      stopListening();
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
    if (store.state.transcribeMode === 'tab') {
      startTabListening();
      return;
    }

    if (el.btnMicTest) el.btnMicTest.hidden = false;
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
    if (isListening()) stopListening();
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
      checkCredits(true);
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
    if (tabAudio) tabAudio.chunkSeconds = s.audioChunkSeconds || 6;
    if (el.btnMicTest) el.btnMicTest.hidden = s.transcribeMode === 'tab';
    if (isListening()) {
      NB.UI.transcriptMeta(
        s.transcribeMode === 'tab'
          ? 'ouvindo o áudio da aba · trechos de ' + (s.audioChunkSeconds || 6) + ' s'
          : 'ouvindo · janelas de ' + s.chunkChars + ' caracteres'
      );
    }
  }

  function hasBrowserKey(s) {
    if (s.provider === 'gemini') return !!s.geminiKey;
    return s.provider === 'openrouter' ? !!s.openrouterKey : !!s.apiKey;
  }

  function keyName(provider) {
    return provider === 'gemini' ? 'GEMINI_API_KEY' : provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
  }

  function providerLabel(provider) {
    return provider === 'gemini' ? 'Gemini' : provider === 'openrouter' ? 'OpenRouter' : 'Anthropic';
  }

  function isConfigured() {
    var s = store.state;
    if (s.apiMode === 'direct') return hasBrowserKey(s);
    return true; // no proxy, a chave está no servidor; a resposta real dirá se falta
  }

  /* -------------------------------------------------------------- health */

  async function checkHealth(quiet) {
    var s = store.state;
    var provider = s.provider;

    if (s.apiMode === 'direct') {
      var hasKey = hasBrowserKey(s);
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
      NB.UI.setApiStatus('ok', providerLabel(provider) + ' · chave no servidor');
      NB.UI.log('ok', 'proxy ativo · ' + provider + ' · chave ' + ((info && info.keyMasked) || 'configurada'));
    } else if (h && h.ok && !configured) {
      NB.UI.setApiStatus('warn', 'proxy sem chave (' + provider + ')');
      NB.UI.log(
        'warn',
        'proxy no ar, mas falta ' + keyName(provider) + ' no .env. Preencha e reinicie o servidor.'
      );
      if (!quiet) {
        NB.UI.toast(
          'O proxy está no ar, mas falta a chave do ' + providerLabel(provider) + ' no .env do servidor.',
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
      var isG = cfg.provider === 'gemini';

      if (cfg.apiMode === 'proxy') {
        var h = await NB.api.health(cfg);
        if (!h.ok) throw new Error('proxy inacessível: ' + (h.detail || 'sem resposta'));
        var info = h.providers && h.providers[cfg.provider];
        if (info && !info.keyConfigured) {
          throw new Error('proxy no ar, mas falta ' + keyName(cfg.provider) + ' no .env');
        }
      } else if (!hasBrowserKey(cfg)) {
        throw new Error('informe a chave do ' + providerLabel(cfg.provider) + ' para o modo direto');
      }

      if (isG) {
        // GET /v1beta/models: valida a chave sem gastar token nem acionar busca.
        var cat = await NB.api.geminiModels(cfg);
        var ids = (cat.models || []).map(function (m) {
          return m.id;
        });
        var found = ids.indexOf(cfg.model) !== -1;
        out.className = found ? 'test-out ok' : 'test-out warn';
        out.textContent = found
          ? 'Gemini ok · chave válida · ' + cfg.model + ' disponível (' + ids.length + ' modelos)'
          : 'Chave válida, mas ' + cfg.model + ' não apareceu na lista (' + ids.length + ' modelos). Ex.: ' + ids.slice(0, 3).join(', ');
        NB.UI.setApiStatus(found ? 'ok' : 'warn', cfg.model + (found ? ' · chave ok' : ' · modelo não listado'));
        NB.UI.log(found ? 'ok' : 'warn', out.textContent);
        return;
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
    if (store.state.provider !== 'openrouter') {
      out.className = 'test-out warn';
      out.textContent = 'Só o OpenRouter tem catálogo remoto; nos outros o modelo é digitado.';
      return;
    }
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
    stopWatchdog();
    stopMeter();
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
    tabAudio: function () {
      return tabAudio;
    },
    stopListening: stopListening,
    checkHealth: checkHealth
  };
})(window);
