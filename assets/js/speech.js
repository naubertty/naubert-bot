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
    this.networkFails = 0;   // falhas seguidas do serviço do Google
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
      self.networkFails = 0;
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
        self.networkFails++;
        // O Chrome perde o contato com o serviço do Google com frequência em
        // rede instável. O `onend` reinicia sozinho; aqui só aumentamos a espera
        // e avisamos. Depois de 5 falhas seguidas, viram erro com instruções.
        if (self.networkFails < 5) {
          self.emit('warn', {
            code: err,
            message: 'reconhecimento sem resposta — tentando de novo (' + self.networkFails + '/5)'
          });
          return;
        }
        self.segmenter.flush('falha de rede');
        self.emit('error', {
          code: err,
          message:
            'O Chrome não conseguiu falar com o serviço de reconhecimento (5 tentativas). ' +
            'Abra google.com nesta mesma aba: se abrir, tente o Edge; se não abrir, o problema é a rede. ' +
            'VPN, DNS filtrando google.com e extensões que bloqueiam requisições são as causas mais comuns. ' +
            'Enquanto isso, use a entrada manual ou cole a fala no campo de texto.'
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
        var wait = 350 + Math.min(self.networkFails, 4) * 1500;
        setTimeout(function () {
          if (!self.recording) return;
          try {
            self.rec.start();
          } catch (e) {
            /* já iniciado */
          }
        }, wait);
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

  /* ------------------------------------------------------------------ mic
   *
   * Medidor de entrada. Serve para responder a pergunta que a Web Speech API
   * não responde: o microfone está ouvindo alguma coisa?
   *
   *   - "o nível não mexe"  -> microfone errado, mudo ou bloqueado;
   *   - "o nível mexe e não transcreve" -> problema é o serviço do Google.
   *
   * Usa getUserMedia + AnalyserNode, só para medir. Nada é gravado.
   */

  var Mic = {
    stream: null,
    ctx: null,
    analyser: null,
    data: null,
    label: '',

    isOpen: function () {
      return !!this.analyser;
    },

    open: async function () {
      if (this.analyser) return { label: this.label, open: true };
      if (!global.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Este navegador não expõe o microfone. Use http://localhost ou https (não abra o arquivo direto).');
      }
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      var Ctx = global.AudioContext || global.webkitAudioContext;
      if (!Ctx) throw new Error('Este navegador não expõe o AudioContext.');
      var ctx = new Ctx();
      var source = ctx.createMediaStreamSource(stream);
      var analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      this.stream = stream;
      this.ctx = ctx;
      this.analyser = analyser;
      this.data = new Float32Array(analyser.fftSize);
      var track = stream.getAudioTracks()[0];
      this.label = (track && track.label) || 'microfone';
      return { label: this.label, open: true };
    },

    /** Nível de entrada de 0 a 1, já com curva perceptual. */
    level: function () {
      if (!this.analyser) return 0;
      this.analyser.getFloatTimeDomainData(this.data);
      var sum = 0;
      for (var i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
      var rms = Math.sqrt(sum / this.data.length);
      return Math.min(1, Math.pow(rms / 0.12, 0.6));
    },

    close: function () {
      if (this.stream) {
        this.stream.getTracks().forEach(function (t) {
          try {
            t.stop();
          } catch (e) {
            /* ignora */
          }
        });
      }
      if (this.ctx && this.ctx.close) {
        try {
          this.ctx.close();
        } catch (e) {
          /* ignora */
        }
      }
      this.stream = null;
      this.ctx = null;
      this.analyser = null;
      this.data = null;
      this.label = '';
    }
  };

  NB.Mic = Mic;
  NB.Speech = Speech;
  NB.Segmenter = Segmenter;
})(window);
