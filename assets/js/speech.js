/* naubert-bot · speech.js
 * Reconhecimento de voz do Chrome (Web Speech API) + segmentador de janelas.
 *
 * A Web Speech API manda resultados parciais e finais. O segmentador acumula os
 * finais e fecha uma janela de duas formas, o que vier primeiro:
 *   - ao passar de `chunkChars` caracteres;
 *   - ao ficar `chunkSeconds` segundos sem fechar (fim de frase).
 * Cada janela leva um "rabo" com as últimas frases, para a triagem entender contexto.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var SpeechRecognitionCtor = global.SpeechRecognition || global.webkitSpeechRecognition;

  /* ------------------------------------------------------------- segmenter */

  function Segmenter(opts) {
    NB.Emitter.call(this);
    this.chunkChars = opts.chunkChars || 260;
    this.chunkSeconds = opts.chunkSeconds || 30;
    this.contextSentences = opts.contextSentences || 2;
    this.buffer = '';
    this.tail = '';
    this.startedAt = Date.now();
    this._timer = null;
    this._seq = 0;
    this._arm();
  }
  Segmenter.prototype = Object.create(NB.Emitter.prototype);
  Segmenter.prototype.constructor = Segmenter;

  Segmenter.prototype._arm = function () {
    var self = this;
    clearTimeout(this._timer);
    this._timer = setTimeout(function () {
      if (self.buffer.trim()) self.flush('tempo');
      else self._arm();
    }, this.chunkSeconds * 1000);
  };

  Segmenter.prototype.push = function (text) {
    var clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    this.buffer = (this.buffer ? this.buffer + ' ' : '') + clean;
    this.emit('buffer', { buffer: this.buffer, startedAt: this.startedAt });
    if (this.buffer.length >= this.chunkChars) this.flush('tamanho');
    else this._arm();
  };

  Segmenter.prototype.flush = function (reason) {
    var text = this.buffer.trim();
    this.buffer = '';
    clearTimeout(this._timer);
    this._arm();
    if (text.length < 12) return null;

    var win = {
      id: 'w' + ++this._seq,
      text: text,
      tail: this.tail,
      reason: reason || 'manual',
      startedAt: this.startedAt,
      endedAt: Date.now()
    };

    // Atualiza o rabo de contexto com as últimas frases do trecho fechado.
    var sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    var tail = sentences.slice(-this.contextSentences).join(' ');
    this.tail = (tail || text).slice(-600);

    this.emit('segment', win);
    return win;
  };

  Segmenter.prototype.forceFlush = function () {
    return this.flush('manual');
  };

  Segmenter.prototype.destroy = function () {
    clearTimeout(this._timer);
  };

  /* --------------------------------------------------------------- speech */

  function Speech(opts) {
    NB.Emitter.call(this);
    this.lang = opts.lang || 'pt-BR';
    this.recording = false;
    this.interim = '';
    this.errorCount = 0;
    this._manualStop = false;
    this.segmenter = new Segmenter({
      chunkChars: opts.chunkChars,
      chunkSeconds: opts.chunkSeconds,
      contextSentences: opts.contextSentences
    });

    var self = this;
    this.segmenter.on('segment', function (w) {
      self.emit('segment', w);
    });
    this.segmenter.on('buffer', function (b) {
      self.emit('buffer', b);
    });

    if (!SpeechRecognitionCtor) return;
    this.rec = new SpeechRecognitionCtor();
    this.rec.lang = this.lang;
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.maxAlternatives = 1;

    this.rec.onstart = function () {
      self.errorCount = 0;
      self.emit('state', { recording: true, label: 'ouvindo' });
    };

    this.rec.onresult = function (event) {
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var r = event.results[i];
        if (!r) continue;
        var txt = r[0] && r[0].transcript;
        if (!txt) continue;
        if (r.isFinal) self.segmenter.push(txt);
        else interim += txt;
      }
      self.interim = interim;
      self.emit('interim', { text: interim });
    };

    this.rec.onerror = function (event) {
      var err = event.error || 'desconhecido';
      self.errorCount++;
      if (err === 'no-speech' || err === 'aborted') return;
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        self.recording = false;
        self.emit('state', { recording: false, label: 'microfone bloqueado' });
        self.emit('error', {
          code: err,
          message: 'O Chrome bloqueou o microfone. Clique no cadeado na barra de endereço e permita o microfone para esta página.'
        });
        return;
      }
      if (err === 'network') {
        self.emit('error', {
          code: err,
          message: 'O serviço de reconhecimento do Chrome não respondeu. Verifique a conexão — o áudio é transcrito nos servidores do Google, não nesta página.'
        });
        return;
      }
      self.emit('error', { code: err, message: 'Erro no reconhecimento de voz: ' + err });
    };

    this.rec.onend = function () {
      // O Chrome encerra sozinho após silêncio: reinicia se o usuário não mandou parar.
      if (self.recording && !self._manualStop) {
        if (self.interim) {
          self.segmenter.push(self.interim);
          self.interim = '';
        }
        setTimeout(function () {
          if (!self.recording) return;
          try {
            self.rec.start();
          } catch (e) {
            /* já iniciado */
          }
        }, 350);
      } else {
        self.emit('state', { recording: false, label: 'parado' });
      }
    };
  }
  Speech.prototype = Object.create(NB.Emitter.prototype);
  Speech.prototype.constructor = Speech;

  Speech.prototype.supported = function () {
    return !!SpeechRecognitionCtor;
  };

  Speech.prototype.start = function () {
    if (!SpeechRecognitionCtor) {
      this.emit('error', {
        code: 'unsupported',
        message: 'Este navegador não tem a Web Speech API. Use Chrome ou Edge no desktop, ou cole a transcrição manualmente.'
      });
      return false;
    }
    if (this.recording) return true;
    this.recording = true;
    this._manualStop = false;
    try {
      this.rec.start();
      return true;
    } catch (e) {
      // "recognition has already started" ou estado residual: tenta de novo em instantes.
      setTimeout(function () {
        try {
          this.rec.start();
        } catch (e2) {
          /* ignora */
        }
      }.bind(this), 300);
      return false;
    }
  };

  Speech.prototype.stop = function () {
    this.recording = false;
    this._manualStop = true;
    if (this.rec) {
      try {
        this.rec.stop();
      } catch (e) {
        /* ignora */
      }
    }
    this.segmenter.forceFlush();
    this.emit('state', { recording: false, label: 'parado' });
  };

  /** Entrada manual/colada: mesma segmentação, sem microfone. */
  Speech.prototype.feed = function (text) {
    this.segmenter.push(text);
  };

  Speech.prototype.flush = function () {
    return this.segmenter.forceFlush();
  };

  Speech.prototype.setLang = function (lang) {
    this.lang = lang;
    if (this.rec) this.rec.lang = lang;
  };

  Speech.prototype.destroy = function () {
    this._manualStop = true;
    this.recording = false;
    if (this.rec) {
      try {
        this.rec.abort();
      } catch (e) {
        /* ignora */
      }
    }
    this.segmenter.destroy();
  };

  NB.Speech = Speech;
  NB.Segmenter = Segmenter;
})(window);
