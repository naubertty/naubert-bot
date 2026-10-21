/* naubert-bot · audio.js
 *
 * Transcrição do ÁUDIO DA ABA, sem microfone.
 *
 * A Web Speech API só aceita microfone — não existe como entregar a ela o som
 * de uma aba. Este módulo faz o caminho alternativo:
 *
 *   getDisplayMedia({audio})  →  AudioContext  →  MediaRecorder (webm/opus)
 *        →  trechos de N segundos  →  /api/v1/audio/transcriptions (Whisper)
 *        →  texto, que entra no mesmo segmentador da fala
 *
 * O navegador pede a escolha da aba e o usuário precisa marcar
 * "compartilhar áudio da aba". Nada é gravado em disco: o trecho vive na
 * memória até a transcrição voltar e é descartado.
 *
 * Quando o microfone está certo, prefira a Web Speech API: ela é instantânea e
 * gratuita. Este caminho custa por segundo de áudio, mas ouve o vídeo direto.
 */
(function (global) {
  'use strict';
  var NB = (global.NB = global.NB || {});

  var MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

  function pickMime() {
    if (!global.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < MIMES.length; i++) {
      if (MediaRecorder.isTypeSupported(MIMES[i])) return MIMES[i];
    }
    return '';
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new global.FileReader();
      reader.onload = function () {
        var s = String(reader.result || '');
        var comma = s.indexOf(',');
        resolve(comma >= 0 ? s.slice(comma + 1) : s);
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Não foi possível ler o áudio capturado.'));
      };
      reader.readAsDataURL(blob);
    });
  }

  /** Texto da resposta do endpoint de transcrição, em qualquer dos formatos aceitos. */
  function transcriptText(data) {
    if (!data) return '';
    if (typeof data === 'string') return data.trim();
    if (typeof data.text === 'string') return data.text.trim();
    if (typeof data.output_text === 'string') return data.output_text.trim();
    if (typeof data.transcript === 'string') return data.transcript.trim();
    var choice = data.choices && data.choices[0];
    if (choice && choice.message) {
      if (typeof choice.message.content === 'string') return choice.message.content.trim();
      if (Array.isArray(choice.message.content)) {
        return choice.message.content
          .map(function (p) {
            return (p && p.text) || '';
          })
          .join(' ')
          .trim();
      }
    }
    return '';
  }

  function TabAudio(opts) {
    NB.Emitter.call(this);
    this.cfg = opts.cfg;                 // função que devolve o estado atual
    this.chunkSeconds = opts.chunkSeconds || 6;
    this.threshold = opts.threshold != null ? opts.threshold : 0.02; // RMS mínimo para enviar
    this.recording = false;
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.data = null;
    this.dest = null;
    this.recorder = null;
    this.timer = null;
    this.label = '';
    this.chunks = 0;        // trechos enviados
    this.skipped = 0;       // trechos descartados por silêncio
    this.secondsSent = 0;
    this._peaks = [];
  }
  TabAudio.prototype = Object.create(NB.Emitter.prototype);
  TabAudio.prototype.constructor = TabAudio;

  TabAudio.supported = function () {
    return !!(
      global.navigator &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getDisplayMedia &&
      global.MediaRecorder &&
      global.AudioContext
    );
  };

  TabAudio.prototype._open = async function () {
    if (!TabAudio.supported()) {
      throw new Error(
        'Este navegador não permite capturar o áudio da aba. Use Chrome ou Edge atualizados, em http://localhost ou https.'
      );
    }

    var stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,          // o Chrome exige vídeo para abrir o seletor
      audio: {
        // Sinal cru: queremos o som do vídeo, não o da sala.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      selfBrowserSurface: 'include',
      systemAudio: 'exclude'
    });

    var audio = stream.getAudioTracks();
    if (!audio.length) {
      stream.getTracks().forEach(function (t) {
        try {
          t.stop();
        } catch (e) {
          /* ignora */
        }
      });
      throw new Error(
        'A aba foi compartilhada sem áudio. Abra o seletor de novo e marque ' +
          '"Compartilhar áudio da aba" (no Chrome aparece embaixo do botão Compartilhar).'
      );
    }

    // Só o áudio interessa: o vídeo da captura é descartado na hora.
    stream.getVideoTracks().forEach(function (t) {
      try {
        t.stop();
      } catch (e) {
        /* ignora */
      }
    });

    var Ctx = global.AudioContext || global.webkitAudioContext;
    var ctx = new Ctx();
    var source = ctx.createMediaStreamSource(new global.MediaStream(audio));
    var analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    var dest = ctx.createMediaStreamDestination();
    source.connect(analyser);
    source.connect(dest);

    this.stream = stream;
    this.ctx = ctx;
    this.analyser = analyser;
    this.data = new Float32Array(analyser.fftSize);
    this.dest = dest;
    this.label = audio[0].label || 'áudio da aba';
    this.mime = pickMime();

    // Se o usuário parar o compartilhamento pelo banner do Chrome, encerramos.
    var self = this;
    audio[0].addEventListener('ended', function () {
      if (self.recording) {
        self.emit('warn', { message: 'o compartilhamento da aba foi encerrado pelo navegador' });
        self.stop();
      }
    });
  };

  TabAudio.prototype.level = function () {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    var sum = 0;
    for (var i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
    var rms = Math.sqrt(sum / this.data.length);
    return Math.min(1, Math.pow(rms / 0.12, 0.6));
  };

  TabAudio.prototype._rms = function () {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.data);
    var sum = 0;
    for (var i = 0; i < this.data.length; i++) sum += this.data[i] * this.data[i];
    return Math.sqrt(sum / this.data.length);
  };

  TabAudio.prototype.start = async function () {
    if (this.recording) return true;
    await this._open();
    this.recording = true;
    this.chunks = 0;
    this.skipped = 0;
    this.secondsSent = 0;
    this.emit('state', { recording: true, label: 'ouvindo a aba' });
    this._schedule();
    return true;
  };

  TabAudio.prototype._schedule = function () {
    var self = this;
    if (!this.recording) return;
    // MediaRecorder com timeslice gera fragmentos que não abrem sozinhos:
    // para cada trecho, um recorder novo — assim cada webm é um arquivo válido.
    var recorder = new global.MediaRecorder(this.dest.stream, this.mime ? { mimeType: this.mime } : undefined);
    var parts = [];
    var peak = 0;
    var startedAt = Date.now();

    recorder.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) parts.push(ev.data);
    };

    recorder.onstop = function () {
      clearInterval(sampler);
      var seconds = (Date.now() - startedAt) / 1000;
      if (!parts.length) {
        self._schedule();
        return;
      }
      var blob = new global.Blob(parts, { type: self.mime || 'audio/webm' });
      if (peak < self.threshold) {
        self.skipped += 1;
        self.emit('silence', { seconds: seconds });
        self._schedule();
        return;
      }
      self._send(blob, seconds).finally(function () {
        self._schedule();
      });
    };

    var sampler = setInterval(function () {
      peak = Math.max(peak, self._rms());
    }, 100);

    try {
      recorder.start();
    } catch (e) {
      this.recording = false;
      this.emit('error', { message: 'Não foi possível iniciar a gravação do áudio da aba: ' + e.message });
      return;
    }
    this.recorder = recorder;
    this.timer = setTimeout(function () {
      try {
        recorder.stop();
      } catch (e) {
        /* ignora */
      }
    }, this.chunkSeconds * 1000);
  };

  TabAudio.prototype._send = async function (blob, seconds) {
    var self = this;
    this.chunks += 1;
    this.secondsSent += seconds;
    this.emit('chunk', { seconds: seconds, bytes: blob.size });

    try {
      var data = await blobToBase64(blob);
      var cfg = this.cfg();
      var res = await NB.api.transcribe(cfg, {
        model: cfg.sttModel,
        input_audio: { data: data, format: 'webm' },
        language: (cfg.lang || 'pt-BR').slice(0, 2)
      });
      var text = transcriptText(res);
      if (!text) {
        this.emit('warn', { message: 'a transcrição voltou vazia para um trecho de ' + Math.round(seconds) + ' s' });
        return;
      }
      this.emit('text', { text: text, seconds: seconds, usage: res && res.usage });
    } catch (err) {
      // 402/401 não adianta repetir a cada trecho: o problema é a conta.
      if (err.status === 402 || err.status === 401) {
        this.emit('fatal', { message: err.message || String(err), status: err.status });
        this.stop();
        return;
      }
      this.emit('error', { message: 'Transcrição do trecho falhou: ' + (err.message || err) });
    }
  };

  TabAudio.prototype.stop = function () {
    this.recording = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch (e) {
        /* ignora */
      }
    }
    this.recorder = null;
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
    this.dest = null;
    this.data = null;
    this.emit('state', { recording: false, label: 'parado' });
  };

  NB.TabAudio = TabAudio;
  NB.TabAudio.transcriptText = transcriptText;
  NB.TabAudio.blobToBase64 = blobToBase64;
})(window);
